// 泳道 PR（README.md「泳道 PR」）：执行者从泳道 head 开工，交付推到 lane-pr/<运行 ID>、开进泳道的 PR，主 Agent 审查后合进泳道。
// 每步的工作区都会回收；执行会话、PR 与反馈留在本次运行的产物里。
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { autoLandReasons, isTest, parseRaw } from './minor.mjs';
import { agentArgs, checksText, command, gh, git, instructions, mergedCommit, mergePr, openPr, output, repoOf, reviewsText, SLOTS } from './shared.mjs';
import { fixText, historyText, previousFor, readResponses, triage } from './triage.mjs';

const env = process.env, action = process.argv[2];
const statePath = join(env.CODA_ARTIFACTS, 'lane-pr.json');

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

// execute 是运行的第一步：状态文件已在就是同一运行的重跑（恢复、重试或从头重走），以上一次的完整状态为底，只重写这一步自己的输入
// （泳道、分支、标题、任务、是否跟上目标分支）；其余原样保留，包括 opening、executor、agent、failures、returns、pr、feedback。首次开工才新建。
const inputs = { lane: `lane/${env.LANE}`, branch: `lane-pr/${env.GITHUB_RUN_ID}`, title: env.TITLE, task: env.TASK, sync: env.SYNC === 'true' };
const state = action === 'execute'
  ? { ...(existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { pr: '', feedback: '', returns: 0 }), ...inputs }
  : JSON.parse(readFileSync(statePath, 'utf8'));
const save = () => writeFileSync(statePath, JSON.stringify(state));
const laneHead = () => { git('fetch', 'origin', state.lane); return git('rev-parse', 'FETCH_HEAD'); };
const ancestor = (older, newer) => spawnSync('git', ['merge-base', '--is-ancestor', older, newer]).status === 0;
// 叠在前置泳道 PR 上、还没重接到泳道（README.md「叠放」）：从前置的 head 开工，PR 开进前置分支，评审只评自己的增量。
const stacked = () => state.stack && !state.stack.restacked;
// 流程替执行者重接了分支之后，下一次交给同一执行会话的任务前面先说一句，免得它在重接前的旧提交上接着改；那一次成功后才清。
const restackNote = () => state.stack?.note ? `${state.stack.note}\n\n` : '';

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
    // 叠放（README.md「叠放」）：只在首次开工时认前置泳道 PR；从头重跑沿用已记下的 stack。前置已合进泳道就不叠放，照常从泳道开工。
    if (action === 'execute' && env.DEPENDS_ON && !state.stack) {
      const fail = text => { console.error(`前置泳道 PR ${env.DEPENDS_ON}：${text}`); process.exit(2); };
      if (state.sync) fail('跟上目标分支的泳道 PR（sync）不能叠放');
      const parent = JSON.parse(gh('pr', 'view', env.DEPENDS_ON, '--repo', repoOf(env.DEPENDS_ON), '--json', 'url,state,headRefName,headRefOid,baseRefName'));
      if (parent.headRefName === state.branch) fail('不能叠在自己上');
      if (parent.state === 'CLOSED') fail('已关闭、没有合并，不能叠在它上面');
      if (parent.baseRefName !== state.lane) fail(parent.baseRefName.startsWith('lane-pr/')
        ? `它叠在 ${parent.baseRefName} 上；只支持单前置线性叠放，不支持多级` : `它合进的是 ${parent.baseRefName}，不是泳道 ${state.lane}`);
      if (parent.state === 'OPEN') {
        git('fetch', 'origin', parent.headRefName);
        if (git('rev-parse', 'FETCH_HEAD') !== parent.headRefOid) fail(`origin 上的 ${parent.headRefName} 不是 ${parent.headRefOid}：不在同一仓库，或刚有新推送`);
        state.stack = { pr: parent.url, branch: parent.headRefName, head: parent.headRefOid, restacked: false };
        save();
      }
    }
    const prompt = join(env.RUNNER_TEMP, 'task.md');
    // opening 完整描述待完成的动作：{ action, text（任务文字）, agent（执行者配置）, session?（已有的会话）}。动作开始前写入，只有动作成功才清；
    // 中途怎么失败都留着，从头重跑从 execute 开始也做它记的那个动作，不靠哪个字段有值来推断先后。
    // 没有 opening 才新建：execute 接回已成功的执行会话，退回修改接回执行会话，换备用执行者新开。
    let opening = state.opening && (action === 'execute' || state.opening.action === action) ? state.opening : undefined;
    const created = !opening;
    if (created) {
      const task = state.sync ? `${state.task}\n\n${syncTask}` : state.task;
      opening = state.opening = { action,
        text: action === 'revise' ? `${restackNote()}${state.feedback}` : action === 'execute' ? task
          : `${task}\n\n主 Agent 把这一项换给你重做：\n${state.feedback}\n\n上一位执行者的分支 ${state.executor.branch}、提交 ${state.executor.head} 在本机仓库可读，可以参考，也可以不用。`,
        // 从头重跑沿用当前执行者（换过备用执行者后 state.agent 是备用的）；只有首次执行还没有 executor，才读流程参数。
        agent: action === 'revise' || (action === 'execute' && state.executor) ? state.agent : JSON.parse(env.EXECUTOR), session: action === 'swap' ? undefined : state.executor?.session };
      save();
    }
    const kind = opening.action, resumed = opening.session;
    const talk = (session, text) => {
      writeFileSync(prompt, `${instructions}\n\n${text}\n`);
      // 叠放升级（recover）之后前置 head 已不能作为起点，新开的会话从泳道开工。
      const args = session ? ['--continue', session] : ['--commit', stacked() && !state.stack.recover ? state.stack.head : laneHead(), '--title', state.title];
      // 执行者是一组 Agent 选择（流程参数的 agent 类型）：没选的模型、强度、模式用 Agent 的默认值。
      if (!session) args.push(...agentArgs(opening.agent));
      // 会话失败时 coda-agent 仍在标准输出给出会话 ID；记下它，这一步再跑才接得回。
      const result = spawnSync('coda-agent', [...args, '--json', '--prompt-file', prompt], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
      if (result.error) throw result.error;
      let reply;
      try { reply = JSON.parse(result.stdout); } catch { /* 失败时可以没有会话信息 */ }
      // 退出 0 必须给出完整回复：否则 gate 读执行者时才崩，恢复也一直重复同一个错。
      return { result, reply, failed: result.status !== 0 || !reply?.session || !reply.branch || !reply.head };
    };
    // 退回修改本来就接回执行会话；它失败后再跑（opening 记着）才是续跑，要先核对现场。
    let attempt = talk(resumed, resumed && !(created && action === 'revise') ? `${resumeText}\n\n${kind === 'revise' ? '这次要你做的' : '原任务'}：\n${opening.text}` : opening.text);
    // Coda 侧的流程 Agent 步骤已在同一会话里续跑可恢复的失败，coda-agent 失败就是终局：回复里没有会话 ID 才算会话接不回，
    // 从 opening 去掉它，同一次里用 opening 记的执行者新开一次（只一次），动作和任务文字不变。
    // 回复里有会话但失败（非零退出、缺 branch 或 head）的不新开：会话和它做出的提交还在，下面记下后按失败退出，下次恢复继续接回。
    // 退回修改必须在原会话里改（新开的会话没有已交付的提交和审查意见），接不回就按失败处理。
    if (!attempt.reply?.session && resumed && kind !== 'revise') {
      console.error(`接回会话 ${resumed} 失败（${attempt.result.status !== 0 ? `coda-agent 退出码 ${attempt.result.status}` : '输出不是完整回复'}，没有会话 ID），改为从泳道当前 head 新开会话。`);
      delete opening.session;
      save();
      attempt = talk(undefined, opening.text);
    }
    const { result, reply } = attempt;
    if (attempt.failed) {
      if (kind === 'revise') console.error(`退回修改接不回会话 ${resumed}：必须在原会话里改，不新开会话，这一步按失败处理。`);
      if (reply?.session) { opening.session = reply.session; save(); }
      if (result.status === 0) console.error(`coda-agent 退出 0，但输出不是含 session、branch、head 的 JSON：${result.stdout.slice(0, 300)}`);
      process.exit(result.status || 1);
    }
    // 连续检查失败只在这次成功的会话是新开的时重新计数；接回已审查过的执行会话（退回修改、从头重跑）的计数照旧。
    if (!opening.session || opening.session !== state.executor?.session) state.failures = [];
    state.executor = reply;
    state.agent = opening.agent;
    delete state.opening;
    delete state.stack?.note;
    state.feedback = '';
    save();
    break;
  }
  // 推到本运行的分支，第一次交付时开进泳道的 PR，之后推同一个分支就是更新同一个 PR。评审对照泳道当前 head。
  case 'gate': {
    console.error(`推送执行者提交 ${state.executor.head} 到 ${state.branch}`);
    git('push', '--no-follow-tags', '--force', 'origin', `${state.executor.head}:refs/heads/${state.branch}`);
    // 叠放升级给主 Agent 之后（recover：前置关了没合并，或流程分不清自己的提交），执行者按退回意见直接变基到泳道上、不再含前置旧提交，
    // 就在这里解绑叠放：PR 还开着就切回泳道、转正；前置分支被删、GitHub 已把它关掉的，下面重新开进泳道。没做到就保持叠放，后面照旧拦住。
    if (stacked() && state.stack.recover) {
      const lane = laneHead(), head = state.executor.head;
      if (ancestor(lane, head) && !ancestor(state.stack.head, head)) {
        if (state.pr) {
          const repo = repoOf(state.pr);
          if (JSON.parse(gh('pr', 'view', state.pr, '--repo', repo, '--json', 'state')).state === 'OPEN') {
            gh('pr', 'edit', state.pr, '--repo', repo, '--base', state.lane);
            gh('pr', 'ready', state.pr, '--repo', repo);
          } else state.pr = '';
        }
        state.stack.restacked = true;
        delete state.stack.recover;
        delete state.stack.pending;
      }
    }
    // 叠放还没重接时检查与评审只对前置的 head，评的是这个 PR 自己的增量。
    state.base = stacked() ? state.stack.head : laneHead();
    // 从头重跑时 PR 可能已经开着：先从 GitHub 找，找不到才开。叠放的 PR 可能开在前置分支上，只按分支找。
    if (!state.pr) state.pr = gh('pr', 'list', '--head', state.branch, ...(state.stack ? [] : ['--base', state.lane]), '--state', 'open', '--limit', '1', '--json', 'url', '--jq', '.[].url');
    if (!state.pr) {
      const body = join(env.RUNNER_TEMP, 'pr.md');
      writeFileSync(body, `泳道 PR，由流程 lane-pr 开、合进泳道 ${state.lane}；运行 coda://workflow-runs/${env.GITHUB_RUN_ID}。${stacked()
        ? `\n\n叠在前置泳道 PR ${state.stack.pr} 上：先以草稿开进它的分支，前置合进泳道后由流程重接到泳道、转为正式 PR。` : ''}\n\n## 任务\n\n${state.task}\n`);
      state.pr = stacked() ? openPr('--base', state.stack.branch, '--head', state.branch, '--draft', '--title', state.title, '--body-file', body)
        : openPr('--base', state.lane, '--head', state.branch, '--title', state.title, '--body-file', body);
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
    // 叠放还没重接时 PR 开在前置分支上，这时合并会合进前置分支：不合，回去等前置合进泳道、重接后重新检查与评审，再回到审查卡。
    else if (choice === 'land' && stacked()) {
      state.feedback = `这个泳道 PR 叠在前置泳道 PR ${state.stack.pr} 上，前置还没合进泳道、没有重接，现在不能合进泳道。流程等前置合进泳道后自动重接、重新检查与评审，再回到审查卡。`;
      save();
      output('route', 'stack');
      break;
    }
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
    // 免主控审查合入的（state.auto 由 minor 写下）：审计摘要写进步骤摘要，也作为结束事件的输出。
    if (state.auto) {
      const summary = ['## 小改动免主控审查，已自动合进泳道', '',
        '原因：开了小改动免主控审查（autoLandMinor）；当前 head 项目检查通过；评审者全部 APPROVE、没有发现、账本没有没关的发现；改动只涉及测试与说明文档，没有删测试、没有新增 skip 或 todo、没有只删断言。',
        `PR：${state.pr}`, `合入提交：${commit}`, `泳道：${state.lane}`, `head：${head}`,
        '', '改动文件：', ...state.auto.files.map(file => `- ${file}`),
        '', '项目检查：', checksText(state.checks, head), '', '评审：', ...state.auto.reviews.map(line => `- ${line}`)].join('\n');
      appendFileSync(env.GITHUB_STEP_SUMMARY, `${summary}\n`);
      output('auto', 'true');
      output('summary', summary);
    }
    break;
  }
  case 'abandon': {
    // 这一步在没有检出的空目录里跑（没有 .git、没有 origin），只用 gh。
    // 关 PR 与删分支分开：gh 在 PR 已关闭时不再删分支，第一次删分支失败后重跑要能补上；分支已不在就跳过。
    const repo = repoOf(state.pr), [host, owner, name] = repo.split('/'), ref = `heads/${state.branch}`;
    gh('pr', 'close', state.pr, '--repo', repo);
    const exists = gh('api', '--hostname', host, `repos/${owner}/${name}/git/matching-refs/${ref}`, '--jq', `.[] | select(.ref == "refs/${ref}") | .ref`);
    if (exists) gh('api', '--hostname', host, '--method', 'DELETE', `repos/${owner}/${name}/git/refs/${ref}`);
    output('pr', state.pr);
    break;
  }
  // 评审回路（README.md「评审回路」），状态在 state.converge：findings 是各轮带固定编号的发现，rounds 是交执行者修了几轮，
  // reviewedHead 是上次评过的 head，waiting 表示交执行者修过、等复评，history 是收敛经过。
  // 检查通过后（以及执行者只反驳、没有新提交时）定这一次怎么评：等复评就对原来每个评审位置增量复评，base 是上次评过的 head，带上次的发现与回应；否则完整评审。
  case 'review-round': {
    const c = state.converge ??= { findings: [], rounds: 0, history: [], waiting: false };
    c.full = !c.waiting;
    const previous = slot => c.full ? '' : previousFor(c.findings, slot);
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
    // fix 交执行者，escalate 直接交主 Agent，pass 先看叠放与免审。
    output('route', result.route);
    break;
  }
  // 没关的发现交同一个执行会话逐条处理。有新提交就推送、检查后复评（gate）；只反驳、没有新提交就不重跑检查，直接交原评审者确认（again）；
  // 既没有新提交也没有反驳，复评不会有变化，交主 Agent（review）。
  case 'address': {
    const c = state.converge, from = state.executor.head, open = c.findings.filter(f => f.status === 'open');
    const prompt = join(env.RUNNER_TEMP, 'task.md');
    writeFileSync(prompt, `${instructions}\n\n${restackNote()}${fixText(from, open)}\n`);
    state.executor = JSON.parse(command('coda-agent', ['--continue', state.executor.session, '--json', '--prompt-file', prompt]));
    delete state.stack?.note;
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
    if (state.converge) state.converge.waiting = false;
    delete state.auto;
    save();
    if (text) writeFileSync(path, text);
    output('text', !text ? '' : text.length <= 4000 ? `${text}\n全文：${path}` : `前面的轮次见 ${path}。\n\n${historyText(history.slice(-1))}`);
    break;
  }
  // 叠放（README.md「叠放」）：评审收敛、不升级之后看前置泳道 PR。没叠放或已重接（ready）往下走；前置还开着（wait）等一分钟再看；
  // 已合并（restack）去重接；关了没合并（review）交主 Agent。这一步在没有检出的空目录里跑，只用 gh。
  case 'stack-status': {
    if (!stacked()) { output('route', 'ready'); break; }
    const parent = JSON.parse(gh('pr', 'view', state.stack.pr, '--repo', repoOf(state.stack.pr), '--json', 'state'));
    if (parent.state === 'CLOSED') {
      state.feedback = `前置泳道 PR ${state.stack.pr} 已关闭、没有合并。这个泳道 PR 叠在它上面（从 ${state.stack.head} 开工），不能合进泳道：请选择放弃，或退回修改让执行者把自己的提交改为直接基于泳道 ${state.lane}。`;
      state.stack.recover = true;
      save();
    }
    output('route', { OPEN: 'wait', MERGED: 'restack' }[parent.state] ?? 'review');
    break;
  }
  // 前置已 squash 合进泳道：只把这个 PR 自己的提交（stack.head..executor.head）用 rebase --onto 重放到泳道最新 head 上，不 merge，
  // 免得把前置 squash 前的散提交带进来；--force-with-lease 更新分支，PR 改开进泳道、转为正式 PR，之后回到推送、检查并以泳道为 base 完整评审（gate）。
  // 重接冲突交同一执行会话（revise）自己变基重接，回来再到这一步收尾；祖先关系不对、或执行者没变基到泳道上，交主 Agent（review）。
  case 'restack': {
    const s = state.stack, lane = laneHead();
    git('fetch', 'origin', state.branch);
    // 升级后等主 Agent 退回、执行者直接变基到泳道上，由 gate 解绑叠放（recover）。
    const escalate = text => { state.feedback = text; s.recover = true; delete s.pending; save(); output('route', 'review'); };
    if (!s.pending) {
      const from = state.executor.head;
      if (!ancestor(s.head, from)) {
        escalate(`前置泳道 PR ${s.pr} 已合进泳道，但这个 PR 的 head ${from} 不再以前置的 head ${s.head} 为祖先，流程分不清哪些是它自己的提交，没有自动重接。请退回修改，让执行者把自己的改动重接到泳道 ${state.lane} 最新 head 上；或放弃。`);
        break;
      }
      git('switch', '-q', '--detach', from);
      const rebase = spawnSync('git', ['rebase', '--onto', lane, s.head], { encoding: 'utf8' });
      if (rebase.error) throw rebase.error;
      s.pending = { lane, from };
      if (rebase.status !== 0) {
        const files = git('diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean);
        if (!files.length) { process.stderr.write(rebase.stdout + rebase.stderr); process.exit(rebase.status ?? 1); }
        git('rebase', '--abort');
        state.feedback = `前置泳道 PR ${s.pr} 已 squash 合进泳道 ${state.lane}（现在是 ${lane}）。流程要把这个 PR 自己的提交 ${s.head}..${from} 重接到 ${lane} 上，有冲突：
${files.map(file => `- ${file}`).join('\n')}
先 git fetch origin ${state.lane}，再在当前分支上 git rebase --onto ${lane} ${s.head}，解决冲突；只重放自己的提交，不要 merge，也不要把前置 squash 前的旧提交混进来。跑和冲突相关的测试后回报冲突了哪些文件、各自怎么解决的、跑了什么。`;
        save();
        output('route', 'revise');
        break;
      }
      // 先记下重接结果再推送：推送或改 PR 失败后重跑这一步，从下面接着收尾，不再变基一次。
      state.executor.head = git('rev-parse', 'HEAD');
      s.note = `前置泳道 PR 已 squash 合进泳道，流程把你的提交用 rebase --onto 重接到了泳道 ${lane} 上，远端分支 ${state.branch} 现在是 ${state.executor.head}。先 git fetch origin ${state.branch}，把当前分支重置到它（git reset --hard FETCH_HEAD），再接着做；不要把重接前的旧提交带回来。`;
      save();
    }
    const head = state.executor.head;
    if (!ancestor(s.pending.lane, head) || ancestor(s.head, head)) {
      escalate(`前置泳道 PR ${s.pr} 已 squash 合进泳道，交给执行者重接到 ${s.pending.lane} 之后，它交回的 ${head} 没有变基到泳道上（泳道 ${s.pending.lane} 不是它的祖先，或前置的旧提交 ${s.head} 还在它的历史里）。请退回修改，让执行者把自己的提交用 rebase --onto 重接到泳道最新 head；或放弃。`);
      break;
    }
    git('push', '--no-follow-tags', `--force-with-lease=refs/heads/${state.branch}:${s.pending.from}`, 'origin', `${head}:refs/heads/${state.branch}`);
    const repo = repoOf(state.pr);
    gh('pr', 'edit', state.pr, '--repo', repo, '--base', state.lane);
    gh('pr', 'ready', state.pr, '--repo', repo);
    state.base = lane;
    s.restacked = true;
    delete s.pending;
    save();
    output('route', 'gate');
    break;
  }
  // 小改动免主控审查（README.md「小改动免主控审查」）：评审通过、叠放已重接之后判定，条件全满足（land）才不出审查卡、直接合进泳道。
  case 'minor': {
    const head = state.executor.head, range = `${state.base}...${head}`;
    git('fetch', 'origin', state.lane, state.branch);
    const changes = parseRaw(git('diff', '--raw', '-z', '-M', '--no-abbrev', range));
    // 重命名、复制的测试文件带上旧路径和 -M，删掉的断言才算在里面。
    const patches = Object.fromEntries(changes.filter(c => c.status !== 'D' && c.paths.some(isTest)).map(c => {
      const lines = git('diff', '-U0', '-M', '--no-color', range, '--', ...c.paths).split('\n');
      return [c.paths.at(-1), { added: lines.filter(l => l.startsWith('+') && !l.startsWith('+++')), removed: lines.filter(l => l.startsWith('-') && !l.startsWith('---')) }];
    }));
    const reviews = JSON.parse(env.REVIEWS);
    const reasons = autoLandReasons({ auto: env.AUTO === 'true', sync: state.sync, stack: state.stack, head, checks: state.checks, reviews,
      findings: state.converge?.findings, changes, patches });
    if (reasons.length) {
      delete state.auto;
      appendFileSync(env.GITHUB_STEP_SUMMARY, `不免主控审查，交主 Agent：\n${reasons.map(r => `- ${r}`).join('\n')}\n`);
    } else state.auto = {
      files: changes.map(c => `${c.status} ${c.paths.join(' → ')}`),
      reviews: reviews.filter(r => r.state === 'done').map(r => {
        const { agent, model, effort } = JSON.parse(r.who);
        return `${SLOTS[r.slot]}（${[agent, model, effort].filter(Boolean).join(' · ')}）：${r.decision} ${r.line}`;
      }),
    };
    save();
    output('route', reasons.length ? 'review' : 'land');
    break;
  }
  default: throw new Error(`未知泳道 PR 步骤：${action}`);
}
