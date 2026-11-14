// 泳道 PR（README.md「泳道 PR」）：执行者从泳道 head 开工，交付推到 lane-pr/<运行 ID>、开进泳道的 PR，主 Agent 审查后合进泳道。
// 每步的工作区都会回收；执行会话、PR 与反馈留在本次运行的产物里。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checksText, gh, git, mergedCommit, mergePr, openPr, output, repoOf, reviewsText } from './shared.mjs';

const env = process.env, action = process.argv[2];
const statePath = join(env.CODA_ARTIFACTS, 'lane-pr.json');
const instructions = `你是这次开发流程的执行者，自己完成这一项任务，不继承主 Agent 的协调职责，不再委派。
只做这一项，在当前分支提交，不推送、不开 PR、不合并、不部署。
遵守仓库的 AGENTS.md。只改必需的地方，不写防御性、冗余的代码，不顺手重构。
只跑与改动直接相关的快检查；流程会在审查前自己跑项目检查，构建、全套和界面检查不在这里重复，不必再用 run-held 跑整套编译。
回报改了什么、为什么、实际跑了哪些验证及未验证部分。`;

// 跟上目标分支的泳道 PR 快进进泳道，执行者要知道为什么只能合并、不能变基。
const syncTask = `这个泳道 PR 用来跟上目标分支：把目标分支合并（merge）进当前分支，不要变基、不要压成一个提交；它会快进进泳道，保住泳道与目标分支的祖先关系。
解决冲突；数据库迁移等版本号和目标分支撞号时，顺延泳道这边的。`;

// 执行步骤失败后重跑，接回已开的执行会话时的开头：现场可能已经做了一部分，先看清再接着做。
const resumeText = `这一项之前已经交给你，上一次没有正常结束（流程恢复或重试）。先核对现场：工作区状态（git status）、git log 里已有的提交、上次做到哪；再接着完成原任务，不要从头重做，已经做好的不要丢。`;

// 让执行者把泳道合进自己的分支：试合并发现冲突和主 Agent 选「让执行者合并泳道」用同一段说明。
const syncText = (lane, files = []) => `泳道是 ${lane}，别的泳道 PR 可能已经合进去了。${files.length ? `\n试合并发现这次提交与它冲突的文件：\n${files.map(file => `- ${file}`).join('\n')}` : ''}
先 git fetch origin ${lane}，再把 origin/${lane} 合并（merge）进当前分支，不要变基：变基会改写已经审查过的提交。
解决冲突；数据库迁移等版本号和泳道撞号时，顺延自己这边的。
跑和冲突相关的测试后提交，只做这件事。回报冲突了哪些文件、各自怎么解决的、跑了什么。
泳道没有新提交时，直接回报不需要合并。`;

// 执行（execute）重跑时，上一次尝试开了却没做完的执行会话（opening）要留下来接着用。
const state = action === 'execute'
  ? { lane: `lane/${env.LANE}`, branch: `lane-pr/${env.GITHUB_RUN_ID}`, title: env.TITLE, task: env.TASK, sync: env.SYNC === 'true', pr: '', feedback: '', returns: 0,
    opening: existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')).opening : undefined }
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
  // 这一步失败后恢复或重试再跑时，这一次开的会话（opening）接着用，不另开：它的上下文和提交都在。
  case 'execute':
  case 'swap':
  case 'revise': {
    const prompt = join(env.RUNNER_TEMP, 'task.md');
    const task = state.sync ? `${state.task}\n\n${syncTask}` : state.task;
    let text = action === 'revise' ? state.feedback : action === 'execute' ? task
      : `${task}\n\n主 Agent 把这一项换给你重做：\n${state.feedback}\n\n上一位执行者的分支 ${state.executor.branch}、提交 ${state.executor.head} 在本机仓库可读，可以参考，也可以不用。`;
    const resumed = action !== 'revise' && state.opening?.action === action ? state.opening.session : undefined;
    if (resumed) text = `${resumeText}\n\n原任务：\n${text}`;
    writeFileSync(prompt, `${instructions}\n\n${text}\n`);
    const args = action === 'revise' ? ['--continue', state.executor.session] : resumed ? ['--continue', resumed] : ['--commit', laneHead(), '--title', state.title];
    // 执行者是一组 Agent 选择（流程参数的 agent 类型）：没选的模型、强度、模式用 Agent 的默认值。
    if (action !== 'revise' && !resumed) {
      const { options = {}, ...chosen } = JSON.parse(env.EXECUTOR);
      for (const key of ['agent', 'model', 'effort', 'mode']) if (chosen[key]) args.push(`--${key}`, chosen[key]);
      for (const [id, value] of Object.entries(options)) args.push('--option', `${id}=${value}`);
    }
    // 会话失败时 coda-agent 仍在标准输出给出会话 ID；记下它，这一步再跑才接得回。
    const result = spawnSync('coda-agent', [...args, '--json', '--prompt-file', prompt], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
    if (result.error) throw result.error;
    let reply;
    try { reply = JSON.parse(result.stdout); } catch { /* 失败时可以没有会话信息 */ }
    if (result.status !== 0) {
      if (action !== 'revise' && reply?.session) { state.opening = { action, session: reply.session }; save(); }
      process.exit(result.status ?? 1);
    }
    // 退出 0 必须给出完整回复：否则 gate 读执行者时才崩，恢复也一直重复同一个错。
    if (!reply?.session || !reply.branch || !reply.head) {
      if (action !== 'revise' && reply?.session) { state.opening = { action, session: reply.session }; save(); }
      console.error(`coda-agent 退出 0，但输出不是含 session、branch、head 的 JSON：${result.stdout.slice(0, 300)}`);
      process.exit(1);
    }
    state.executor = reply;
    delete state.opening;
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
  default: throw new Error(`未知泳道 PR 步骤：${action}`);
}
