// 泳道 PR（README.md「泳道 PR」）：执行者从泳道 head 开工，交付推到 lane-pr/<运行 ID>、开进泳道的 PR，主 Agent 审查后合进泳道。
// 每步的工作区都会回收；执行会话、PR 与反馈留在本次运行的产物里。
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checksText, command, gh, git, mergedCommit, mergePr, openPr, output, repoOf, reviewsText } from './shared.mjs';
import { findingLine, historyText, readResponses, triage } from './triage.mjs';

const env = process.env, action = process.argv[2];
const statePath = join(env.CODA_ARTIFACTS, 'lane-pr.json');
const instructions = `你是这次开发流程的执行者，自己完成这一项任务，不继承主 Agent 的协调职责，不再委派。
只做这一项，在当前分支提交，不推送、不开 PR、不合并、不部署。
遵守仓库的 AGENTS.md。只改必需的地方，不写防御性、冗余的代码，不顺手重构。
只跑与改动直接相关的快检查；流程会在审查前自己跑项目检查，构建、全套和界面检查不在这里重复，不必再用 run-held 跑整套编译。
只跑改动直接涉及的测试文件；不跑无文件参数的 \`check.sh backend\`、\`--all\`、完整 workflows 套件、客户端编译，任务明确要求的除外。
验证命令必须把原始检查的退出码传出去：默认直接执行检查命令；要看日志尾部就用 \`rc=0; <检查> > "$log" 2>&1 || rc=$?; tail -n 80 "$log"; exit "$rc"\`；不能只 echo 退出码，不能让最后一条 tail / grep / cmp 决定成败。
改坏验证（故意改错看测试红）只跑命中的那个用例，沿用默认时限；挂住了先定位原因，不要调大时限重跑。
run-held 和流程运行的结果会自己送回，不要另起 Monitor 或后台任务去盯日志。
回报改了什么、为什么、实际跑了哪些验证及未验证部分。`;

// 跟上目标分支的泳道 PR 快进进泳道，执行者要知道为什么只能合并、不能变基。
const syncTask = `这个泳道 PR 用来跟上目标分支：把目标分支合并（merge）进当前分支，不要变基、不要压成一个提交；它会快进进泳道，保住泳道与目标分支的祖先关系。
解决冲突；数据库迁移等版本号和目标分支撞号时，顺延泳道这边的。`;

// 让执行者把泳道合进自己的分支：试合并发现冲突和主 Agent 选「让执行者合并泳道」用同一段说明。
const syncText = (lane, files = []) => `泳道是 ${lane}，别的泳道 PR 可能已经合进去了。${files.length ? `\n试合并发现这次提交与它冲突的文件：\n${files.map(file => `- ${file}`).join('\n')}` : ''}
先 git fetch origin ${lane}，再把 origin/${lane} 合并（merge）进当前分支，不要变基：变基会改写已经审查过的提交。
解决冲突；数据库迁移等版本号和泳道撞号时，顺延自己这边的。
跑和冲突相关的测试后提交，只做这件事。回报冲突了哪些文件、各自怎么解决的、跑了什么。
泳道没有新提交时，直接回报不需要合并。`;

// 评审回路（README.md「评审回路」）交给执行者的发现：编号固定，逐条修复（fixed）或反驳（disputed），结构化交回。
const fixText = (head, findings) => `评审者对这次交付（提交 ${head}）提了下面这些发现，编号固定，之后几轮沿用。逐条处理：
- 成立的：修好并提交，回 fixed，附修复它的提交号；
- 不成立的：不要改，回 disputed，写明理由和证据（代码位置、命令与输出、文档出处）。原评审者会复评核实，你说不成立不等于关闭。
标了「阻塞」的必须处理，其余能修的一并修。只处理这些发现，不做清单之外的事；流程会在新提交上重跑项目检查。

${findings.map(f => findingLine(f, true)).join('\n')}

回复的最后，单独给出一个代码块：开头一行是三个反引号加 responses，结尾一行是三个反引号，中间是一个 JSON 对象，只有 responses 一个字段，是数组，每个编号一条：id（编号）、disposition（fixed 或 disputed）、commit（fixed 时修复它的提交号）、reason（怎么修的，或为什么不成立）、evidence（证据：跑了什么、结果，或代码与文档出处）。`;

const state = action === 'execute'
  ? { lane: `lane/${env.LANE}`, branch: `lane-pr/${env.GITHUB_RUN_ID}`, title: env.TITLE, task: env.TASK, sync: env.SYNC === 'true', pr: '', feedback: '', returns: 0 }
  : JSON.parse(readFileSync(statePath, 'utf8'));
const save = () => writeFileSync(statePath, JSON.stringify(state));
const laneHead = () => { git('fetch', 'origin', state.lane); return git('rev-parse', 'FETCH_HEAD'); };

// 只试不合：merge-tree 不产生提交，不动任何引用、索引和工作区。干净返回 undefined，有冲突返回冲突的文件。
const conflicts = lane => {
  const result = spawnSync('git', ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', lane, state.executor.head], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status === 0) return;
  if (result.status !== 1) { process.stderr.write(result.stderr); process.exit(result.status ?? 1); }
  return [...new Set(result.stdout.split('\0').slice(1).filter(Boolean))];
};

switch (action) {
  // 执行一项（execute）与换备用执行者（swap）都新开会话、从泳道当前 head 开工；swap 接手的是同一项：上一位没被接受的提交不带过来，只告诉它在哪。
  case 'execute':
  case 'swap':
  case 'revise': {
    const prompt = join(env.RUNNER_TEMP, 'task.md');
    const task = state.sync ? `${state.task}\n\n${syncTask}` : state.task;
    const text = action === 'revise' ? state.feedback : action === 'execute' ? task
      : `${task}\n\n主 Agent 把这一项换给你重做：\n${state.feedback}\n\n上一位执行者的分支 ${state.executor.branch}、提交 ${state.executor.head} 在本机仓库可读，可以参考，也可以不用。`;
    writeFileSync(prompt, `${instructions}\n\n${text}\n`);
    const args = action === 'revise' ? ['--continue', state.executor.session] : ['--commit', laneHead(), '--title', state.title];
    // 执行者是一组 Agent 选择（流程参数的 agent 类型）：没选的模型、强度、模式用 Agent 的默认值。
    if (action !== 'revise') {
      const { options = {}, ...chosen } = JSON.parse(env.EXECUTOR);
      for (const key of ['agent', 'model', 'effort', 'mode']) if (chosen[key]) args.push(`--${key}`, chosen[key]);
      for (const [id, value] of Object.entries(options)) args.push('--option', `${id}=${value}`);
    }
    state.executor = JSON.parse(command('coda-agent', [...args, '--json', '--prompt-file', prompt]));
    state.feedback = '';
    // 新会话的连续检查失败重新计数。
    if (action !== 'revise') state.failures = [];
    save();
    break;
  }
  // 推到本运行的分支，第一次交付时开进泳道的 PR，之后推同一个分支就是更新同一个 PR。评审对照泳道当前 head。
  case 'gate': {
    console.error(`推送执行者提交 ${state.executor.head} 到 ${state.branch}`);
    git('push', '--no-follow-tags', '--force', 'origin', `${state.executor.head}:refs/heads/${state.branch}`);
    state.base = laneHead();
    // 从头重跑时 PR 可能已经开着：先从 GitHub 找，找不到才开。
    if (!state.pr) state.pr = gh('pr', 'list', '--head', state.branch, '--base', state.lane, '--state', 'open', '--limit', '1', '--json', 'url', '--jq', '.[].url');
    if (!state.pr) {
      const body = join(env.RUNNER_TEMP, 'pr.md');
      writeFileSync(body, `泳道 PR，由流程 lane-pr 开、合进泳道 ${state.lane}；运行 coda://workflow-runs/${env.GITHUB_RUN_ID}。\n\n## 任务\n\n${state.task}\n`);
      state.pr = openPr('--base', state.lane, '--head', state.branch, '--title', state.title, '--body-file', body);
    }
    save();
    output('head', state.executor.head);
    break;
  }
  case 'gate-passed':
    state.checks = { head: state.executor.head, runs: JSON.parse(env.RUNS) };
    state.failures = [];
    state.feedback = '';
    output('base', state.base);
    output('task', state.task);
    output('checks', checksText(state.checks, state.executor.head));
    save();
    break;
  case 'gate-failed': {
    const failure = `项目检查未通过，提交 ${state.executor.head}。运行：coda://workflow-runs/${env.GITHUB_RUN_ID}。请用 workflow_status 查看项目检查调用的失败流程、步骤和日志尾，修复后提交。`;
    delete state.checks;
    state.failures.push(failure);
    state.feedback = state.failures.join('\n\n');
    save();
    output('route', state.failures.length >= 3 ? 'review' : 'revise');
    break;
  }
  case 'review':
    output('checks', checksText(state.checks, state.executor.head));
    for (const [name, value] of Object.entries({ ...state.executor, lane: state.lane, pr: state.pr, feedback: state.feedback, returns: state.returns })) output(name, value);
    output('reviews', reviewsText(env.REVIEWS, state.executor.head, '评审这次交付'));
    break;
  case 'decide': {
    const { choice, note = '' } = JSON.parse(env.REVIEW);
    // 引擎不能按条件隐藏答复：没填备用执行者时「换备用执行者重做」照样能选，选了回到审查卡说明。
    const blocked = !note.trim() ? { revise: '退回修改必须在备注中写具体意见。', swap: '换备用执行者重做必须在备注中写为什么换、接手的人要注意什么。' }[choice]
      : choice === 'swap' && env.BACKUP !== 'true' ? '没有填备用执行者，不能换人重做；请改选别的答复。' : '';
    if (blocked) state.feedback = blocked;
    else {
      state.feedback = choice === 'sync' ? `${syncText(state.lane)}${note.trim() ? `\n\n主 Agent 的备注：\n${note}` : ''}` : note;
      // 退回次数只数主 Agent 的「退回修改」；检查失败的自动退回、换人和合并泳道都不算。
      if (choice === 'revise') state.returns++;
    }
    save();
    output('route', blocked ? 'review' : choice === 'sync' ? 'revise' : choice);
    break;
  }
  // 先认 PR 终态：已合并（从失败处继续）直接交出原合入提交，已关闭未合并报错。跟上目标分支的快进后 GitHub 可能还没标为已合并，
  // 这次交付已是泳道的祖先就算合进去了。还开着才试合并泳道当前 head（并行的泳道 PR 可能刚合进去），有冲突交回同一执行会话；
  // 普通的 squash 合进泳道；跟上目标分支的只能快进，泳道 head 不是它的祖先时同样交回执行者先合并泳道。
  case 'land': {
    const head = state.executor.head;
    const ancestor = (older, newer) => spawnSync('git', ['merge-base', '--is-ancestor', older, newer]).status === 0;
    let commit = mergedCommit(state.pr, head), files;
    if (!commit) {
      const lane = laneHead();
      if (state.sync && ancestor(head, lane)) commit = head;
      else if (state.sync && ancestor(lane, head)) { git('push', 'origin', `${head}:refs/heads/${state.lane}`); commit = head; }
      else if (state.sync) files = conflicts(lane) ?? [];
      else if (!(files = conflicts(lane))) commit = mergePr(state.pr, head, 'squash');
    }
    if (!commit) {
      state.feedback = syncText(state.lane, files);
      save();
      output('route', 'sync');
      break;
    }
    output('route', 'landed');
    output('pr', state.pr);
    output('commit', commit);
    break;
  }
  case 'abandon':
    gh('pr', 'close', state.pr, '--repo', repoOf(state.pr), '--delete-branch');
    output('pr', state.pr);
    break;
  // 评审回路（README.md「评审回路」），状态在 state.converge：findings 是各轮带固定编号的发现，rounds 是交执行者修了几轮，
  // reviewedHead 是上次评过的 head，waiting 表示交执行者修过、等复评，history 是收敛经过。
  // 检查通过后（以及执行者只反驳、没有新提交时）定这一次怎么评：等复评就对原来每个评审位置增量复评，base 是上次评过的 head，带上次的发现与回应；否则完整评审。
  case 'review-round': {
    const c = state.converge ??= { findings: [], rounds: 0, history: [], waiting: false };
    c.full = !c.waiting;
    const previous = slot => c.full ? '' : JSON.stringify(c.findings.filter(f => f.slot === slot && f.status === 'open')
      .map(({ id, severity, kind, title, location, detail, response }) => ({ id, severity, kind, title, location, detail, response })));
    output('base', c.full ? state.base : c.reviewedHead);
    output('head', state.executor.head);
    output('task', state.task);
    output('checks', checksText(state.checks, state.executor.head));
    output('previous', previous('reviewer'));
    output('previous2', previous('reviewer2'));
    save();
    break;
  }
  // 评审之后分流（triage.mjs）：交执行者（fix），或交主 Agent 审查（review：没有阻塞级发现，或要升级）。
  case 'triage': {
    const c = state.converge, head = state.executor.head;
    if (c.full) c.rounds = 0;
    const result = triage(JSON.parse(env.REVIEWS), { head, findings: c.findings, rounds: c.rounds, full: c.full });
    Object.assign(c, { findings: result.findings, reviewedHead: head, waiting: false });
    c.history.push({ kind: 'review', full: c.full, head, resolutions: result.resolutions, added: result.findings.filter(f => result.added.includes(f.id)), route: result.route, reasons: result.reasons });
    save();
    output('route', result.route === 'fix' ? 'fix' : 'review');
    break;
  }
  // 没关的发现交同一个执行会话逐条处理。有新提交就推送、检查后复评（gate）；只反驳、没有新提交就不重跑检查，直接交原评审者确认（again）；
  // 既没有新提交也没有反驳，复评不会有变化，交主 Agent（review）。
  case 'address': {
    const c = state.converge, from = state.executor.head, open = c.findings.filter(f => f.status === 'open');
    const prompt = join(env.RUNNER_TEMP, 'task.md');
    writeFileSync(prompt, `${instructions}\n\n${fixText(from, open)}\n`);
    state.executor = JSON.parse(command('coda-agent', ['--continue', state.executor.session, '--json', '--prompt-file', prompt]));
    const responses = readResponses(state.executor.answer, open.map(f => f.id));
    for (const f of open) f.response = responses[f.id];
    const moved = state.executor.head !== from, disputed = Object.values(responses).some(r => r.disposition === 'disputed');
    c.rounds++;
    c.waiting = moved || disputed;
    c.history.push({ kind: 'fix', round: c.rounds, from, head: state.executor.head, ids: open.map(f => f.id), responses,
      note: c.waiting ? '' : '执行者没有新提交，也没有反驳，升级给主 Agent' });
    save();
    output('route', moved ? 'gate' : disputed ? 'again' : 'review');
    break;
  }
  // 出主 Agent 审查卡之前：收敛经过放上卡（全文在产物里），不再等复评。
  case 'rounds': {
    const history = state.converge?.history ?? [], path = join(env.CODA_ARTIFACTS, 'converge.md'), text = historyText(history);
    if (state.converge) { state.converge.waiting = false; save(); }
    if (text) writeFileSync(path, text);
    output('text', !text ? '' : text.length <= 4000 ? `${text}\n全文：${path}` : `前面的轮次见 ${path}。\n\n${historyText(history.slice(-1))}`);
    break;
  }
  default: throw new Error(`未知泳道 PR 步骤：${action}`);
}
