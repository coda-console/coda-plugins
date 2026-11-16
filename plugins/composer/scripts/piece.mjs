// 块（README.md「块」）：执行者从需求分支 head 开工，交付推到临时分支 piece/<运行 ID> 供检查和评审取用，不开 PR；
// 主 Agent 审查后 squash 成一个提交快进进需求分支（跟上目标分支的块以合并提交快进），再删掉临时分支。
// 每步的工作区都会回收；执行会话与反馈留在本次运行的产物里。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentArgs, checksText, command, git, instructions, output, reviewsText } from './shared.mjs';
import { fixText, historyText, previousFor, readResponses, triage } from './triage.mjs';

const env = process.env, action = process.argv[2];
const statePath = join(env.CODA_ARTIFACTS, 'piece.json');

// 跟上目标分支的块以合并提交快进进需求分支，执行者要知道为什么只能合并、不能变基。
const syncTask = base => `这一块用来跟上目标分支 ${base}：先 git fetch origin ${base}，把 origin/${base} 合并（merge）进当前分支，不要变基、不要压成一个提交；它以合并提交快进进需求分支，保住需求分支与目标分支的祖先关系。
解决冲突；数据库迁移等版本号和目标分支撞号时，顺延需求分支这边的。`;

// 执行步骤失败后重跑，接回已开的执行会话时的开头：现场可能已经做了一部分，先看清再接着做。
const resumeText = `这一项之前已经交给你，上一次没有正常结束（流程恢复或重试）。先核对现场：工作区状态（git status）、git log 里已有的提交、上次做到哪；再接着完成原任务，不要从头重做，已经做好的不要丢。`;

// 让执行者把需求分支合进自己的分支：试合并发现冲突和主 Agent 选「让执行者合并需求分支」用同一段说明。
const syncText = (branch, files = []) => `需求分支是 ${branch}，别的块可能已经合进去了。${files.length ? `\n试合并发现这次提交与它冲突的文件：\n${files.map(file => `- ${file}`).join('\n')}` : ''}
先 git fetch origin ${branch}，再把 origin/${branch} 合并（merge）进当前分支，不要变基：变基会改写已经审查过的提交。
解决冲突；数据库迁移等版本号和需求分支撞号时，顺延自己这边的。
跑和冲突相关的测试后提交，只做这件事。回报冲突了哪些文件、各自怎么解决的、跑了什么。
需求分支没有新提交时，直接回报不需要合并。`;

// execute 是运行的第一步：状态文件已在就是同一运行的重跑（恢复、重试或从头重走），以上一次的完整状态为底，只重写这一步自己的输入
// （需求分支、目标分支、临时分支、标题、任务、是否跟上目标分支）；其余原样保留，包括 opening、executor、agent、failures、returns、feedback。首次开工才新建。
const inputs = { branch: env.BRANCH, base: env.BASE, temp: `piece/${env.GITHUB_RUN_ID}`, title: env.TITLE, task: env.TASK, sync: env.SYNC === 'true' };
const state = action === 'execute'
  ? { ...(existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { feedback: '', returns: 0 }), ...inputs }
  : JSON.parse(readFileSync(statePath, 'utf8'));
const save = () => writeFileSync(statePath, JSON.stringify(state));
const branchHead = () => { git('fetch', 'origin', state.branch); return git('rev-parse', 'FETCH_HEAD'); };
// 合进需求分支的提交在说明里带这一行：重跑合入前按它找，同一块不会合入两次。
const trailer = `Coda-Piece: ${env.GITHUB_RUN_ID}`;

// 只试不合：merge-tree 不产生提交，不动任何引用、索引和工作区。干净时给出合并后的树，有冲突给出冲突的文件。
const tryMerge = tip => {
  const result = spawnSync('git', ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', tip, state.executor.head], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== 1) { process.stderr.write(result.stderr); process.exit(result.status ?? 1); }
  const [tree, ...files] = result.stdout.split('\0');
  return result.status === 0 ? { tree } : { files: [...new Set(files.filter(Boolean))] };
};
const removeTemp = () => { if (git('ls-remote', '--heads', 'origin', `refs/heads/${state.temp}`)) git('push', 'origin', '--delete', `refs/heads/${state.temp}`); };

switch (action) {
  // 执行一项（execute）与换备用执行者（swap）都新开会话、从需求分支当前 head 开工；swap 接手的是同一项：上一位没被接受的提交不带过来，只告诉它在哪。
  // 这一步失败后恢复或重试再跑时，这一次开的会话（opening）接着用，不另开：它的上下文和提交都在。
  case 'execute':
  case 'swap':
  case 'revise': {
    const prompt = join(env.RUNNER_TEMP, 'task.md');
    // opening 完整描述待完成的动作：{ action, text（任务文字）, agent（执行者配置）, session?（已有的会话）}。动作开始前写入，只有动作成功才清；
    // 中途怎么失败都留着，从头重跑从 execute 开始也做它记的那个动作，不靠哪个字段有值来推断先后。
    // 没有 opening 才新建：execute 接回已成功的执行会话，退回修改接回执行会话，换备用执行者新开。
    let opening = state.opening && (action === 'execute' || state.opening.action === action) ? state.opening : undefined;
    const created = !opening;
    if (created) {
      const task = state.sync ? `${state.task}\n\n${syncTask(state.base)}` : state.task;
      opening = state.opening = { action,
        text: action === 'revise' ? state.feedback : action === 'execute' ? task
          : `${task}\n\n主 Agent 把这一项换给你重做：\n${state.feedback}\n\n上一位执行者的分支 ${state.executor.branch}、提交 ${state.executor.head} 在本机仓库可读，可以参考，也可以不用。`,
        // 从头重跑沿用当前执行者（换过备用执行者后 state.agent 是备用的）；只有首次执行还没有 executor，才读流程参数。
        agent: action === 'revise' || (action === 'execute' && state.executor) ? state.agent : JSON.parse(env.EXECUTOR), session: action === 'swap' ? undefined : state.executor?.session };
      save();
    }
    const kind = opening.action, resumed = opening.session;
    const talk = (session, text) => {
      writeFileSync(prompt, `${instructions}\n\n${text}\n`);
      const args = session ? ['--continue', session] : ['--commit', branchHead(), '--title', state.title];
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
      console.error(`接回会话 ${resumed} 失败（${attempt.result.status !== 0 ? `coda-agent 退出码 ${attempt.result.status}` : '输出不是完整回复'}，没有会话 ID），改为从需求分支当前 head 新开会话。`);
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
    state.feedback = '';
    save();
    break;
  }
  // 推到本运行的临时分支，检查和评审从远端取得到这次交付；不开 PR。评审对照需求分支当前 head。
  case 'gate': {
    console.error(`推送执行者提交 ${state.executor.head} 到临时分支 ${state.temp}`);
    git('push', '--no-follow-tags', '--force', 'origin', `${state.executor.head}:refs/heads/${state.temp}`);
    state.tip = branchHead();
    save();
    output('head', state.executor.head);
    // 普通的块相对需求分支没有新提交：不进检查和评审，当作检查没过自动退回（跟上目标分支的块没有新提交是正常的，不拦）。
    output('empty', String(!state.sync && spawnSync('git', ['merge-base', '--is-ancestor', state.executor.head, state.tip]).status === 0));
    break;
  }
  case 'gate-passed':
    state.checks = { head: state.executor.head, runs: JSON.parse(env.RUNS) };
    state.failures = [];
    state.feedback = '';
    output('base', state.tip);
    output('task', state.task);
    output('checks', checksText(state.checks, state.executor.head));
    save();
    break;
  case 'gate-failed': {
    const failure = env.EMPTY === 'true' ? `这次交付相对需求分支 ${state.branch} 没有新提交：先 git status 看工作区，把这一项的改动提交到当前分支再回报。`
      : `项目检查未通过，提交 ${state.executor.head}。运行：coda://workflow-runs/${env.GITHUB_RUN_ID}。请用 workflow_status 查看项目检查调用的失败流程、步骤和日志尾，修复后提交。`;
    delete state.checks;
    state.failures.push(failure);
    state.feedback = state.failures.join('\n\n');
    save();
    output('route', state.failures.length >= 3 ? 'review' : 'revise');
    break;
  }
  case 'review':
    output('checks', checksText(state.checks, state.executor.head));
    for (const [name, value] of Object.entries({ session: state.executor.session, head: state.executor.head, answer: state.executor.answer,
      branch: state.branch, temp: state.temp, feedback: state.feedback, returns: state.returns })) output(name, value);
    output('reviews', reviewsText(env.REVIEWS, state.executor.head, '评审这次交付'));
    break;
  case 'decide': {
    const { choice, note = '' } = JSON.parse(env.REVIEW);
    // 引擎不能按条件隐藏答复：没填备用执行者时「换备用执行者重做」照样能选，选了回到审查卡说明。
    const blocked = !note.trim() ? { revise: '退回修改必须在备注中写具体意见。', swap: '换备用执行者重做必须在备注中写为什么换、接手的人要注意什么。' }[choice]
      : choice === 'swap' && env.BACKUP !== 'true' ? '没有填备用执行者，不能换人重做；请改选别的答复。' : '';
    if (blocked) state.feedback = blocked;
    else {
      state.feedback = choice === 'sync' ? `${syncText(state.branch)}${note.trim() ? `\n\n主 Agent 的备注：\n${note}` : ''}` : note;
      // 退回次数只数主 Agent 的「退回修改」；检查失败的自动退回、换人和合并需求分支都不算。
      if (choice === 'revise') state.returns++;
    }
    save();
    output('route', blocked ? 'review' : choice === 'sync' ? 'revise' : choice);
    break;
  }
  // 先认是否已合入（重跑不合入第二次）：需求分支里有带本运行 trailer 的提交；跟上目标分支的块看推送前记下的 landing（从头重跑 execute 会换掉
  // executor.head，记录还在）或这次交付是不是已是它的祖先。
  // 否则试合并需求分支当前 head（别的块可能刚合进去），有冲突交回同一执行会话；普通的块把合并结果 squash 成一个提交、以需求分支 head 为父，
  // 普通推送（只快进）；跟上目标分支的块只能以执行者的合并提交快进，需求分支 head 不是它的祖先时同样交回执行者先合并需求分支。合入后删掉临时分支。
  case 'land': {
    const head = state.executor.head, tip = branchHead();
    const ancestor = (older, newer) => spawnSync('git', ['merge-base', '--is-ancestor', older, newer]).status === 0;
    let files, commit = state.sync ? [state.landing, head].find(c => c && ancestor(c, tip)) : git('log', '-n1', '--format=%H', `--grep=^${trailer}$`, tip);
    if (!commit && state.sync) {
      if (ancestor(tip, head)) {
        state.landing = head;
        save();
        git('push', 'origin', `${head}:refs/heads/${state.branch}`);
        commit = head;
      }
      else files = tryMerge(tip).files ?? [];
    } else if (!commit) {
      const merged = tryMerge(tip);
      files = merged.files;
      // 合并后的树和需求分支 head 的树相同：交付没有可合入的内容，不生成空提交，交回执行者。
      if (merged.tree && merged.tree === git('rev-parse', `${tip}^{tree}`)) {
        state.feedback = `这次交付相对需求分支 ${state.branch} 没有改动，没有可以合入的内容：先对照需求分支确认这一项的改动都已提交到当前分支，补上后再回报。`;
        save();
        output('route', 'sync');
        break;
      }
      if (merged.tree) {
        commit = git('commit-tree', merged.tree, '-p', tip, '-m', `${state.title}\n\n${trailer}`);
        git('push', 'origin', `${commit}:refs/heads/${state.branch}`);
      }
    }
    if (!commit) {
      state.feedback = syncText(state.branch, files);
      save();
      output('route', 'sync');
      break;
    }
    removeTemp();
    output('route', 'landed');
    output('commit', commit);
    break;
  }
  // 主 Agent 放弃：删掉临时分支，需求分支不动；之后流程走到出错结束，调用方的出错边界接得到。临时分支已不在（重跑）就跳过。
  case 'abandon':
    removeTemp();
    break;
  // 评审回路（README.md「评审回路」），状态在 state.converge：findings 是各轮带固定编号的发现，rounds 是交执行者修了几轮，
  // reviewedHead 是上次评过的 head，waiting 表示交执行者修过、等复评，history 是收敛经过。
  // 检查通过后（以及执行者只反驳、没有新提交时）定这一次怎么评：等复评就对原来每个评审位置增量复评，base 是上次评过的 head，带上次的发现与回应；否则完整评审。
  case 'review-round': {
    const c = state.converge ??= { findings: [], rounds: 0, history: [], waiting: false };
    c.full = !c.waiting;
    const previous = slot => c.full ? '' : previousFor(c.findings, slot);
    output('base', c.full ? state.tip : c.reviewedHead);
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
  default: throw new Error(`未知的块步骤：${action}`);
}
