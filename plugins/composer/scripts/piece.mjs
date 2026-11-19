// 块（README.md「块」）：执行者从需求分支 head 开工，交付推到临时分支 piece/<运行 ID> 供检查和评审取用，不开 PR；
// 项目检查、一位评审者评过后由主 Agent 审查，squash 成一个提交快进进需求分支（跟上目标分支的块以合并提交快进），再删掉临时分支。
// 每步的工作区都会回收；执行会话、反馈与评审账本留在本次运行的产物里。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentArgs, changes, checksText, git, instructions, output, resumeText } from './shared.mjs';

const env = process.env, action = process.argv[2];
const statePath = join(env.CODA_ARTIFACTS, 'piece.json');

// 执行者交块的格式，接在固定说明后面：审查卡上的「执行者回答」从最后一行「交付说明」起取，只放最后一条回复（coda-agent 的 answer 是这一次说过的全部话）。
const handIn = `回答的最后一条消息以单独一行「交付说明」开头，其下固定给两段：
1. 任务书的完成标准逐条：做到了，还是没做到及原因。
2. 怎么把改动跑起来验的：命令或操作与结果；没跑就写「没跑」和原因。`;
const lastReply = answer => {
  const at = [...answer.matchAll(/^[#* \t]*交付说明[*：: \t]*$/gm)].at(-1);
  return at ? answer.slice(at.index) : `（执行者没有以「交付说明」开头给最后一条回复，下面是这一次的全部回答）\n${answer}`;
};

// 跟上目标分支的块以合并提交快进进需求分支，执行者要知道为什么只能合并、不能变基。
const syncTask = base => `这一块用来跟上目标分支 ${base}：先 git fetch origin ${base}，把 origin/${base} 合并（merge）进当前分支，不要变基、不要压成一个提交；它以合并提交快进进需求分支，保住需求分支与目标分支的祖先关系。
解决冲突；数据库迁移等版本号和目标分支撞号时，顺延需求分支这边的。`;

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

// 评审账本（README.md「评审」）：state.findings 只记必须修，编号 #1、#2……，之后几轮沿用；status 为 open、resolved、withdrawn、superseded（完整评审作废）、
// declined（主 Agent 在退回意见里定了不改，流程自己关掉，不再交评审者）。state.reviewed 是上次评成的 head，换人或合并需求分支时清掉（到下一次评成为止都是完整评审），state.outcome 是这次交付的评审结果，state.notes 是历次退回意见。
const FLAG = { contract: '对外契约', scope: '任务范围' };
const flat = text => String(text ?? '').replace(/\s*[\r\n]+\s*/g, ' ');
const open = () => (state.findings ?? []).filter(f => f.status === 'open');
const findingLine = f => `- ${f.id} ${flat(f.title)}${f.location ? `（${flat(f.location)}）` : ''}`;
// 复评坚持的条目后面跟评审者给的理由（现在的代码还缺什么）。
const mustLine = f => `${findingLine(f)}${FLAG[f.kind] ? `〔评审者认为涉及${FLAG[f.kind]}〕` : ''}${f.reason ? `\n  现在的代码还缺：${flat(f.reason)}` : ''}`;
// 交给评审者的任务书：原文后附主 Agent 历次的退回意见，只作参考；评审者只看到意见里的编号，所以定了不改、已经关闭的条目另列标题和位置。
const reviewTask = () => {
  const declined = (state.findings ?? []).filter(f => f.status === 'declined');
  return !state.notes?.length ? state.task : `${state.task}

下面是主 Agent 历次「退回修改」的意见（原文，按先后），其中写明不改的已经关闭，不要再提：
${state.notes.map((note, i) => `第 ${i + 1} 次：\n${note}`).join('\n\n')}${declined.length ? `

主 Agent 定了不改、已经关闭的条目（编号对应上面意见里的编号）：
${declined.map(findingLine).join('\n')}` : ''}`;
};
// 主 Agent 的「退回修改」：同一执行会话按备注修，之后复评。备注里单独一行写的「#编号 不改」就此关掉那条：
// 行首只允许空白或列表符号 -、*，「不改」后面是行尾，或「：」「:」「，」「,」接理由；句子中间提到的不算。
const sendBack = note => {
  state.feedback = note;
  state.returns++;
  (state.notes ??= []).push(note);
  state.rereview = true;
  for (const [, id] of note.matchAll(/^[^\S\n]*(?:[-*][^\S\n]*)?(#\d+)[^\S\n]*不改[^\S\n]*(?:$|[：:，,])/gm)) {
    const f = state.findings?.find(f => f.id === id);
    if (f?.status === 'open') f.status = 'declined';
  }
};
// 审查卡的「评审结论」：必须修逐条（一句加位置），小问题、原有问题只给条数。
const reviewText = reviewer => {
  const o = state.outcome;
  // 复评没评成：上一轮还开着的必须修照旧列出，注明这一轮没有重新核实。
  const unverified = () => { const must = open(); return state.full || !must.length ? '' : `\n上一轮还开着的必须修（这一轮没有重新核实）：\n${must.map(mustLine).join('\n')}`; };
  if (!reviewer) return '没填评审者，这一块不评审。';
  if (state.checks?.head !== state.executor.head) return '项目检查没通过，这次交付没有评审。';
  if (o.lost) return `没评成：调用 review-commit 没有成功，原因见本运行 coda://workflow-runs/${env.GITHUB_RUN_ID} 的「评审这次交付」（workflow_status）。${unverified()}`;
  if (!o.report) return `没评成：${o.line}${unverified()}`;
  const must = open();
  return [o.line, `必须修 ${must.length} 条${must.length ? '：' : '。'}`, ...must.map(mustLine), `小问题 ${o.nit} 条，原有问题 ${o.existing} 条。`,
    ...o.flagged.length ? [`其中评审者认为涉及对外契约或任务范围的：${o.flagged.map(t => `「${flat(t)}」`).join('、')}`] : [],
    `评审原文：${o.report}`].join('\n');
};

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
      writeFileSync(prompt, `${instructions}\n${handIn}\n\n${text}\n`);
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
  // 检查通过：记下检查，定这次评审的范围。主 Agent 退回修改之后是复评：base 是上次评过的 head，previous 带还没关的必须修；
  // 其余（第一次、换人、合并需求分支之后）评需求分支 head 到这次交付的全部改动。
  case 'gate-passed': {
    state.checks = { head: state.executor.head, runs: JSON.parse(env.RUNS) };
    state.failures = [];
    state.feedback = '';
    const again = Boolean(state.rereview && state.reviewed);
    state.full = !again;
    output('base', again ? state.reviewed : state.tip);
    output('head', state.executor.head);
    output('task', reviewTask());
    output('checks', checksText(state.checks, state.executor.head));
    output('previous', again ? JSON.stringify(open().map(({ id, level, kind, title, location, detail }) => ({ id, level, kind, title, location, detail }))) : '');
    save();
    break;
  }
  // 评审结果入账（review-commit 的输出）：完整评审作废之前没关的；复评对旧条目的结论改它们的状态，坚持的（upheld）仍开着；新的必须修接着编号。
  // 没评成（INCOMPLETE）不入账，下一次复评仍从上次评过的 head 算起。
  case 'reviewed': {
    const head = state.executor.head;
    if (env.DECISION === 'INCOMPLETE') state.outcome = { head, line: env.LINE };
    else {
      const ledger = state.findings ??= [], findings = JSON.parse(env.FINDINGS);
      if (state.full) for (const f of ledger) if (f.status === 'open') f.status = 'superseded';
      for (const { id, status, reason } of JSON.parse(env.RESOLUTIONS)) {
        const f = ledger.find(f => f.id === id);
        if (status === 'upheld') f.reason = reason; else f.status = status;
      }
      for (const { level, kind, title, location, detail } of findings.filter(f => f.level === 'must')) ledger.push({ id: `#${ledger.length + 1}`, level, kind, title, location, detail, status: 'open' });
      state.round = (state.round ?? 0) + 1;
      const report = join(env.CODA_ARTIFACTS, `review-${state.round}.md`);
      writeFileSync(report, env.REPORT);
      state.reviewed = head;
      const count = level => findings.filter(f => f.level === level).length;
      state.outcome = { head, line: env.LINE, report, nit: count('nit'), existing: count('existing'), flagged: findings.filter(f => f.level !== 'must' && FLAG[f.kind]).map(f => f.title) };
    }
    save();
    break;
  }
  // 调用 review-commit 本身没成（出错边界）：记为没评成，照常出审查卡。
  case 'review-lost':
    state.outcome = { head: state.executor.head, lost: true };
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
  // 主 Agent 审查卡的一页结论：执行者最后一条回复、项目检查、评审结论、改动范围（需求分支 head 到这次交付的三点 diff，与评审看的是同一份）。
  case 'review':
    git('fetch', 'origin', state.branch, state.temp);
    for (const [name, value] of Object.entries({ session: state.executor.session, head: state.executor.head, branch: state.branch, temp: state.temp, tip: state.tip,
      feedback: state.feedback, returns: state.returns, answer: lastReply(state.executor.answer ?? ''), checks: checksText(state.checks, state.executor.head),
      review: reviewText(env.REVIEWER === 'true'), changes: changes(state.tip, state.executor.head) })) output(name, value);
    break;
  case 'decide': {
    const { choice, note = '' } = JSON.parse(env.REVIEW);
    // 引擎不能按条件隐藏答复：没填备用执行者时「换备用执行者重做」照样能选，选了回到审查卡说明。
    const blocked = !note.trim() ? { revise: '退回修改必须在备注中写具体意见。', swap: '换备用执行者重做必须在备注中写为什么换、接手的人要注意什么。' }[choice]
      : choice === 'swap' && env.BACKUP !== 'true' ? '没有填备用执行者，不能换人重做；请改选别的答复。' : '';
    // 退回次数只数主 Agent 的「退回修改」；检查失败的自动退回、换人和合并需求分支都不算。满三次后再退回不退，交用户决定（stuck）。
    const stuck = !blocked && choice === 'revise' && state.returns >= 3;
    if (blocked) state.feedback = blocked;
    else if (stuck) {
      state.pending = note;
      output('stuck', `主 Agent 这次的退回意见：\n${note}\n\n还开着的必须修：\n${open().map(mustLine).join('\n') || '没有'}`);
    } else if (choice === 'revise') sendBack(note);
    else {
      state.feedback = choice === 'sync' ? `${syncText(state.branch)}${note.trim() ? `\n\n主 Agent 的备注：\n${note}` : ''}` : note;
      // 换人从需求分支 head 重做、合并需求分支会带进别的块：之后的评审都是完整评审，直到有一次评成。
      if (choice === 'sync' || choice === 'swap') delete state.reviewed;
    }
    save();
    output('route', blocked ? 'review' : stuck ? 'stuck' : choice === 'sync' ? 'revise' : choice);
    break;
  }
  // 用户在「这一块三轮没过」的答复：继续修就把退回次数清零，按主 Agent 这次的意见退回（算新一轮的第一次）；放弃同主 Agent 选放弃。
  case 'stuck': {
    const { choice } = JSON.parse(env.STUCK);
    if (choice === 'continue') {
      state.returns = 0;
      sendBack(state.pending);
    }
    delete state.pending;
    save();
    output('route', choice === 'continue' ? 'revise' : 'abandon');
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
        delete state.reviewed;
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
      delete state.reviewed;
      save();
      output('route', 'sync');
      break;
    }
    removeTemp();
    output('route', 'landed');
    output('commit', commit);
    // 这一块最后一次交付有没有评成的评审：需求运行只在唯一的一块评成过时跳过整体评审。
    output('reviewed', String(Boolean(state.outcome?.report && state.outcome.head === head)));
    break;
  }
  // 主 Agent 放弃：删掉临时分支，需求分支不动；之后流程走到出错结束，调用方的出错边界接得到。临时分支已不在（重跑）就跳过。
  case 'abandon':
    removeTemp();
    break;
  default: throw new Error(`未知的块步骤：${action}`);
}
