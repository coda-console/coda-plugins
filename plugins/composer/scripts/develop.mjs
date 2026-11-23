// 需求运行（README.md「监督开发」）：一个需求一条需求分支 req/<运行 ID>，主 Agent 在「需求进行中」派块（piece，本运行调用的子运行）往里提改动，提交验收后需求分支开 PR 进目标分支。
// 每步的工作区都会回收；反馈与汇报暂存在本次运行的产物里。进度以 GitHub 为准：需求分支、已合并的块和需求分支进目标分支的 PR，从头重跑也接得上。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { waitForGitHubChecks } from './github-checks.mjs';
import { agentArgs, areasAt, autoApproval, changes, checksText, fail, gh, git, mergedCommit, mergePr, openPr, output, outputFilled, outputPicked, readContract, resumeText, scopeViolations, talk } from './shared.mjs';

const env = process.env, action = process.argv[2];
const statePath = join(env.CODA_ARTIFACTS, 'develop.json');
// 契约模式（契约开发流程 develop-contract，README.md「契约开发」）：流程图传了环境变量 CONTRACT（不看它的值，空串也算，会在开工校验里报契约不合规范）；监督开发（develop）不传，各步与没有契约时一样。契约的解析与校验只在 shared.mjs 的 readContract，各步从这里取。
const contracted = 'CONTRACT' in env;
const contractOf = () => {
  const { contract, error } = readContract(env.CONTRACT);
  if (error) { console.error(`契约不合规范：${error}`); process.exit(1); }
  return contract;
};

// 用户开启时由主 Agent 写的需求：备注第一行是需求名，其后是目标与完成标准。
if (action === 'brief') {
  const [first = '', ...rest] = (JSON.parse(env.BRIEF).note ?? '').trim().split(/\r?\n/);
  const title = first.trim(), goal = rest.join('\n').trim();
  output('feedback', title && goal ? '' : '备注第一行写需求名，空一行后写目标与完成标准，两样都要有。');
  output('route', title && goal ? 'req' : 'brief');
  output('title', title);
  output('goal', goal);
  process.exit(0);
}

// 从目标分支最新提交建需求分支；远端已有同名需求分支时沿用（运行从头重跑）。重跑时状态文件里流程直推的记录（pushed）保留，其余重置。
if (action === 'branch') {
  if (contracted) {
    contractOf();
    if (env.REVIEWER !== 'true') { console.error('契约模式必须填整体评审者'); process.exit(1); }
  }
  const base = env.BASE || gh('repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name');
  const branch = `req/${env.GITHUB_RUN_ID}`;
  if (git('ls-remote', '--heads', 'origin', branch)) console.error(`远端已有需求分支 ${branch}，沿用`);
  else {
    git('fetch', 'origin', base);
    git('push', 'origin', `FETCH_HEAD:refs/heads/${branch}`);
  }
  const { pushed } = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
  writeFileSync(statePath, JSON.stringify({ title: env.TITLE, goal: env.GOAL, base, branch, feedback: '', report: '', ...pushed && { pushed } }));
  for (const [name, value] of Object.entries({ title: env.TITLE, goal: env.GOAL, base, branch })) output(name, value);
  process.exit(0);
}

const state = JSON.parse(readFileSync(statePath, 'utf8'));
const save = () => writeFileSync(statePath, JSON.stringify(state));
// 回到「需求进行中」的原因，主 Agent 答复后清掉。
const back = reason => { state.feedback = reason; save(); };

// 合进需求分支的块，从需求分支的历史读（目标分支最新提交到需求分支 head，按先后）：说明带 Coda-Piece: <运行 ID> 的块合入提交，
// 不论在哪条父链上（跟上目标分支的块把需求分支合进自己时，别的块在合并提交的第二父链上），附上那次运行；
// 再加上 first-parent 上没带它的提交（跟上目标分支的块的合并提交等）。流程直接推的另列，不算块。
const pieces = (base, head) => {
  const direct = new Set((state.pushed ?? []).map(p => p.commit)), range = `${base}..${head}`;
  const first = new Set(git('log', '--first-parent', '--format=%H', range).split('\n'));
  const lines = git('log', '--topo-order', '--reverse', '--format=%H%x09%s%x09%(trailers:key=Coda-Piece,valueonly,separator=%x2C)', range).split('\n').filter(Boolean);
  return lines.map(line => line.split('\t')).filter(([commit, , run]) => (run || first.has(commit)) && !direct.has(commit))
    .map(([commit, subject, run]) => `- ${commit.slice(0, 12)} ${subject}${run ? `（coda://workflow-runs/${run}）` : ''}`).join('\n') || '（还没有合进需求分支的块）';
};

// 这次提交验收的项目检查是否带契约：契约模式，且这次没勾「交用户批准」。
const withContract = () => contracted && state.escalate !== true;
// 范围门禁的违例清单，回到进行中的原因与交用户批准的说明共用；无法按 UTF-8 解码的路径注明原因。
const violationText = ({ outside, missing }) => [
  outside.length && `越界的改动（不在契约的 allowed 内）：\n${outside.map(file => `- ${file}${file.includes('\uFFFD') ? '（路径无法按 UTF-8 解码）' : ''}`).join('\n')}`,
  missing.length && `没改到的必改项（契约的 required）：\n${missing.map(entry => `- ${entry}`).join('\n')}`,
].filter(Boolean).join('\n');

const ancestor = (older, newer) => spawnSync('git', ['merge-base', '--is-ancestor', older, newer]).status === 0;
const fetched = ref => { git('fetch', 'origin', ref); return git('rev-parse', 'FETCH_HEAD'); };
// 流程自己往需求分支推（提交验收时跟上目标分支）：普通推送，不 force。被拒且需求分支已不是 from（别人推进了需求分支）时返回 false，
// 不重试、不覆盖，由调用方带着原因回到进行中；其余失败保留原退出码。
const pushBranch = (commit, from) => {
  const result = spawnSync('git', ['push', '--no-follow-tags', 'origin', `${commit}:refs/heads/${state.branch}`], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status === 0) return true;
  if (fetched(state.branch) === from) process.exit(result.status ?? 1);
  back(`推送 ${commit} 到需求分支 ${state.branch} 被拒：需求分支已不是 ${from}，有别的提交推进了它，流程没有覆盖。\n运行：coda://workflow-runs/${env.GITHUB_RUN_ID}\n请看需求分支最新的提交，处理好后重新提交验收。`);
  return false;
};
// 不经块、由流程直接推到需求分支的提交，PR 汇总里单独列出（块列表里去掉它们）：只数 first-parent，合并进来的目标分支提交不算。
const pushed = (from, to, why) => {
  const lines = git('log', '--first-parent', '--reverse', '--format=%H%x09%s', `${from}..${to}`).split('\n').filter(Boolean);
  state.pushed = [...state.pushed ?? [], ...lines.map(line => { const [commit, subject] = line.split('\t'); return { commit, subject, why }; })];
};
// 跟上目标分支有冲突时交开工执行者：只合并不变基（同 piece.mjs 的 syncText）。
const mergeText = ({ base, files }) => `把目标分支 ${state.base} 合并进需求分支 ${state.branch}，让需求分支跟上它，只做这件事。当前分支是需求分支 head，目标分支固定在提交 ${base}。
试合并发现冲突的文件：
${files.map(file => `- ${file}`).join('\n')}
先 git fetch origin ${state.base}，再 git merge ${base} 合并（merge）进当前分支，不要变基、不要压成一个提交：变基会改写已经审查过的需求分支提交，合并才保住需求分支与目标分支的祖先关系。
解决冲突；数据库迁移等版本号和目标分支撞号时，顺延需求分支这边的。
跑和冲突相关的测试后提交合并提交。回报冲突了哪些文件、各自怎么解决的、跑了什么。`;

// 整体评审（README.md「整体评审」）：state.overall 是这次运行最近一次评完的结果（有它就是评过了），state.outcome 是这次提交验收的评审结果（没评就没有），
// 非契约模式用 state.overallMust 记这次运行的整体评审出没出过必须修；state.landed 是合进的块，state.reviewedPieces 是最后一次交付评成了的块（这两样和 overall 在非契约模式定评不评、能不能自动合并）。
// 契约模式只看 state.overall 的 head 与当前 head：定评不评、能不能自动合并都不看这几样。
// 合进需求分支的块（至少一块）最后一次交付都评成过。
const piecesReviewed = () => state.landed.length > 0 && state.landed.every(run => state.reviewedPieces?.includes(run));
const flat = text => String(text ?? '').replace(/\s*[\r\n]+\s*/g, ' ');
const findingLine = f => `- ${flat(f.title)}${f.location ? `（${flat(f.location)}）` : ''}`;
// 「整体评审结论」卡上的一页结论：必须修每条一句加位置，小问题、原有问题只给条数，评审原文的路径；没评成的写原因。
const overallText = o => o.lost ? `没评成：调用 review-commit 没有成功，原因见本运行 coda://workflow-runs/${env.GITHUB_RUN_ID} 的「评审整条需求分支」（workflow_status）。`
  : !o.report ? `没评成：${o.line}`
  : [o.line, `必须修 ${o.must.length} 条${o.must.length ? '：' : '。'}`, ...o.must.map(findingLine), `小问题 ${o.nit.length} 条，原有问题 ${o.existing.length} 条。`, `评审原文：${o.report}`].join('\n');

// 「需求进行中」派块时备注最前面换人的行（README.md「派块」）：一行一个角色，冒号后先写 Agent ID，再按需写「模型 …」「强度 …」「模式 …」，逗号隔开；
// 可带 Markdown 列表的「- 」。备用执行者和评审者写「无」表示这一块不用。没写的角色用开工值（流程里用 FEEL 拼成 agent 对象）。
const ROLES = { 执行者: 'executor', 备用执行者: 'executor2', 评审者: 'reviewer' };
const SETTINGS = { 模型: 'model', 强度: 'effort', 模式: 'mode' };
const ROLE_LINE = /^(?:[-*]\s+)?(执行者|备用执行者|评审者)\s*[:：]\s*(.*)$/;
// 解析出 { roles, rest }（rest 是换人行之后的文字），看不懂时 { error }。
const readRoles = note => {
  const lines = note.trim().split(/\r?\n/), roles = {};
  for (let m; lines.length && (m = ROLE_LINE.exec(lines[0].trim())); lines.shift()) {
    const [, label, value] = m, role = ROLES[label], [who, ...parts] = value.trim().split(/\s*[，,]\s*/);
    if (role in roles) return { error: `「${label}」写了两次。` };
    if (who === '无' && role !== 'executor' && !parts.length) { roles[role] = null; continue; }
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(who)) return { error: `「${label}」那一行冒号后要先写 Agent ID（如 codex${role === 'executor' ? '' : '，不用就写「无」'}），写的是「${value.trim()}」。` };
    const chosen = { agent: who };
    for (const part of parts) {
      const [, name, setting] = /^(模型|强度|模式)\s+(\S+)$/.exec(part) ?? [];
      if (!name || SETTINGS[name] in chosen) return { error: `「${label}」那一行的「${part}」看不懂：Agent ID 之后只认「模型 …」「强度 …」「模式 …」，各写一次，逗号隔开。` };
      chosen[SETTINGS[name]] = setting;
    }
    roles[role] = chosen;
  }
  return { roles, rest: lines.join('\n').trim() };
};
// 派块的答复：「派一块」第一行是标题、其后是任务书；「跟上目标分支」是固定任务，备注附在后面。都先读最前面的换人行。
const pieceOf = (choice, note) => {
  const { roles, rest, error } = readRoles(note);
  if (error) return { error };
  if (!(roles.executor ?? env.FIXER === 'true')) return { error: '开工没填执行者：在备注最前面写「执行者：<Agent ID>」，这一块才派得出去。' };
  if (choice === 'sync') {
    const task = `把目标分支 ${state.base} 最新的提交合并进需求分支 ${state.branch}，让需求分支跟上它：解冲突，数据库迁移等版本号和目标分支撞号时顺延需求分支这边的，跑和冲突相关的测试。`;
    return { roles, title: `跟上 ${state.base}`, task: rest ? `${task}\n\n${rest}` : task, sync: true };
  }
  const [first = '', ...body] = rest.split(/\r?\n/), title = first.trim(), task = body.join('\n').trim();
  if (!title || !task) return { error: '派一块的备注（换人的行之后）第一行写这一块的标题，其后写任务书（背景、范围、验收要求），两样都要有。' };
  return { roles, title, task, sync: false };
};

switch (action) {
  case 'resume':
    output('reason', state.feedback);
    break;
  case 'progress': {
    const { choice, note = '', options = {} } = JSON.parse(env.PROGRESS);
    const piece = choice === 'piece' || choice === 'sync' ? pieceOf(choice, note) : {};
    const missing = piece.error ? `${piece.error}这一块没有派出去。`
      : !note.trim() && { submit: '提交验收必须在备注中写给用户的改动汇报。', pause: '暂停必须在备注中写为什么暂停、等什么。' }[choice];
    if (!missing) {
      if (choice === 'submit') Object.assign(state, { report: note, again: options.again === true }, contracted && { escalate: options.escalate === true });
      state.feedback = '';
      save();
    }
    output('feedback', missing || '');
    output('route', missing ? 'progress' : piece.title ? 'piece' : choice);
    // 派块的参数都是标量：角色写空是用开工值，「无」是不用，否则是 Agent ID 与没写就空的模型、强度、模式。
    output('title', piece.title ?? '');
    output('task', piece.task ?? '');
    output('sync', String(piece.sync ?? false));
    for (const role of Object.values(ROLES)) {
      const chosen = piece.roles?.[role];
      output(role, chosen === null ? '无' : chosen?.agent ?? '');
      for (const [setting, name] of [['model', 'Model'], ['effort', 'Effort'], ['mode', 'Mode']]) output(`${role}${name}`, chosen?.[setting] ?? '');
    }
    break;
  }
  // 块合进了需求分支：下一次「需求进行中」写上合入的提交和块的运行。最后一次交付评成了的块记进 reviewedPieces，整体评审与自动合并看它。
  case 'piece-landed':
    if (env.REVIEWED === 'true') (state.reviewedPieces ??= []).push(env.PIECE_RUN);
    back(`块「${env.TITLE}」已合进需求分支 ${state.branch}：提交 ${env.COMMIT}，运行 coda://workflow-runs/${env.PIECE_RUN}。${env.BY === 'user' ? '\n这是用户定的：你对这一块的退回已满三次，这次又要退回，用户改成了不退，合进需求分支。' : ''}`);
    break;
  // 块没正常结束（失败、被取消，或主 Agent 在块里选了放弃）：引擎只把调用失败交给出错边界，不带被调运行的原因，所以指向本运行里调用的块。
  // 合入状态不能断言：piece.mjs 的 land 先推需求分支再删临时分支，删除失败时块失败但提交已经合进去了。
  case 'piece-failed':
    back(`块「${env.TITLE}」没有正常结束：块运行失败、被取消，或你在块里选了放弃。它可能已经合进需求分支 ${state.branch}（比如合入后删临时分支失败），合入状态待核实。\n先核实再决定：看需求分支 ${state.branch} 最新的提交里有没有这一块（普通的块说明带 Coda-Piece: <块运行 ID>，跟上目标分支的块是执行者的合并提交），再用 workflow_status 查看本运行 coda://workflow-runs/${env.GITHUB_RUN_ID} 的步骤「块」调用的块运行，读它的结局、错误和日志；确认没合进才重新派这一块。`);
    break;
  case 'paused': {
    const { choice, note = '' } = JSON.parse(env.PAUSED);
    if (choice === 'continue') back(`用户在「需求已暂停」选了继续。${note.trim() ? `\n用户的话：\n${note}` : ''}`);
    output('route', choice);
    break;
  }
  // 开或更新需求分支进目标分支的 PR：汇报、合进需求分支的块、改动区域。已开着的 PR 从 GitHub 找，不靠运行暂存。
  case 'pr': {
    git('fetch', 'origin', state.base);
    const base = git('rev-parse', 'FETCH_HEAD');
    git('fetch', 'origin', state.branch);
    state.head = git('rev-parse', 'FETCH_HEAD');
    // 合进过哪几块（块的运行 ID）：说明带 Coda-Piece 的提交，跟上目标分支的块（执行者的合并提交）和流程直接推的不算。整体评审按它定评不评。
    state.landed = git('log', '--format=%(trailers:key=Coda-Piece,valueonly)', `${base}..${state.head}`).split('\n').filter(Boolean);
    const direct = state.pushed?.length ? `\n\n流程直接推到需求分支的提交：\n${state.pushed.map(p => `- ${p.commit.slice(0, 12)} ${p.subject}（${p.why}）`).join('\n')}` : '';
    const summary = `${state.report}\n\n块：\n${pieces(base, state.head)}${direct}\n\n${changes(base, state.head)}`;
    const path = join(env.RUNNER_TEMP, 'pr.md');
    writeFileSync(path, summary);
    state.pr = gh('pr', 'list', '--head', state.branch, '--base', state.base, '--state', 'open', '--limit', '1', '--json', 'url', '--jq', '.[].url');
    if (state.pr) gh('pr', 'edit', state.pr, '--body-file', path);
    else state.pr = openPr('--base', state.base, '--head', state.branch, '--title', state.title, '--body-file', path);
    save();
    // 项目检查的结果带不带契约要和这次一致：同一个 head，不带契约通过的不能当作带契约通过，反过来也不行。
    output('checked', String(state.checks?.head === state.head && (!contracted || Boolean(state.checks.contract) === withContract())));
    if (contracted) output('withContract', String(withContract()));
    output('url', state.pr);
    output('head', state.head);
    output('base', base);
    output('branch', state.branch);
    output('summary', summary);
    output('task', `需求：${state.title}\n\n目标与完成标准：\n${state.goal}\n\n主 Agent 的汇报：\n${state.report}`);
    break;
  }
  // 范围门禁（README.md「范围门禁」）：契约模式下，pr 固定的两端提交（三点 diff，改名拆成删加，只动子模块指针的提交也算，不理会 .gitmodules 里的 ignore）对照契约的 allowed、required，区域定义读 base 上的。
  // 通过或这次勾了「交用户批准」都往下走，结果记在 state.gate；没勾且有违例带着清单回到进行中，PR 不动。
  case 'gate': {
    const { allowed, required } = contractOf(), base = env.BASE_COMMIT, head = env.HEAD_COMMIT;
    git('fetch', 'origin', base, head);
    const files = [...new Set(git('diff', '--name-status', '--no-renames', '--ignore-submodules=none', '-z', `${base}...${head}`).split('\0').filter((_, i) => i % 2 === 1))];
    const { outside, missing } = scopeViolations({ required, allowed }, areasAt(base), files);
    state.gate = { head, outside, missing };
    const violated = outside.length > 0 || missing.length > 0;
    if (violated && state.escalate !== true) back(`范围门禁没过，需求分支 head ${head}。\n${violationText(state.gate)}\n处理：派块把越界的改动拿掉、把必改项补上，再提交验收；确实需要越界，提交验收时勾「交用户批准」，由用户在批准卡上决定。`);
    else save();
    output('route', violated && state.escalate !== true ? 'progress' : 'pass');
    break;
  }
  case 'checks-passed':
    state.checks = { head: state.head, runs: JSON.parse(env.RUNS), ...contracted && { contract: withContract() } };
    save();
    break;
  case 'github-checks': {
    const status = await waitForGitHubChecks(state.pr, state.head);
    if (status !== 0) process.exit(status);
    break;
  }
  case 'check-failed':
    back(`${env.STEP}未通过，需求分支 head ${state.head}。\n运行：coda://workflow-runs/${env.GITHUB_RUN_ID}\n请用 workflow_status 查看本运行「${env.STEP}」及其调用的失败流程，读取错误和日志；派一块修好后再提交验收。`);
    break;
  // 项目检查有了结论，定这次评不评：填了整体评审者，且这次勾了「重新整体评审」，或——契约模式——需求分支 head 与最近一次评完的整体评审的 head 不同，
  // ——非契约模式——既不是只合进了一块且它评成过、这次运行也还没评过。evidence 是交给评审者的已有验证。
  case 'overall-plan':
    delete state.outcome;
    save();
    output('review', String(env.REVIEWER === 'true' && (state.again || (contracted ? state.overall?.head !== state.head : !(state.landed.length === 1 && piecesReviewed()) && !state.overall))));
    output('evidence', `项目检查：\n${checksText(state.checks, state.head)}`);
    break;
  // 调用 review-commit 本身没成（出错边界）：记为没评成。
  case 'overall-lost':
    state.outcome = { head: state.head, lost: true };
    save();
    break;
  // 评审结果入账：没评完（INCOMPLETE）只记没评成，不算评过；评完了按级别分开记，原文写进产物。
  case 'overall-reviewed': {
    if (env.DECISION === 'INCOMPLETE') state.outcome = { head: state.head, line: env.LINE };
    else {
      const findings = JSON.parse(env.FINDINGS), of = level => findings.filter(f => f.level === level);
      state.reviews = (state.reviews ?? 0) + 1;
      const report = join(env.CODA_ARTIFACTS, `overall-review-${state.reviews}.md`);
      writeFileSync(report, env.REPORT);
      state.overall = state.outcome = { head: state.head, line: env.LINE, report, must: of('must'), nit: of('nit'), existing: of('existing') };
      if (state.overall.must.length) state.overallMust = true;
    }
    save();
    break;
  }
  // 评不评都经过这里：这次评了、有必须修或没评成交主 Agent（review），否则往下走（accept）。最近一次评完的小问题、原有问题写进汇总，
  // 有就更新 PR 描述；auto 是自动合并的唯一判定：开了 autoMerge，且——非契约模式——这次运行评成过（整体评审，或合进的每一块都评成过）、整体评审没出过必须修；
  // ——契约模式——没勾「交用户批准」，范围门禁是在当前 head 上算的且没有违例，最近一次评完的整体评审就是当前 head 且没有必须修（旧提交上出过的必须修不再粘住），且这次提交没有发起了却没评成的评审（o 存在且没评成）。
  case 'overall': {
    const o = state.outcome, done = state.overall;
    const at = done && done.head !== state.head ? `，评审时需求分支 head ${done.head.slice(0, 12)}` : '';
    const minor = done ? [[done.nit, `整体评审的小问题（没有修${at}）：`], [done.existing, `整体评审提到的原有问题（不是这个需求引入的${at}）：`]]
      .filter(([list]) => list.length).map(([list, heading]) => [heading, ...list.map(f => `${findingLine(f)}${f.detail ? `\n  ${f.detail.replace(/\n/g, '\n  ')}` : ''}`)].join('\n')) : [];
    const body = [env.SUMMARY, ...minor].join('\n\n');
    if (minor.length) {
      const path = join(env.RUNNER_TEMP, 'pr.md');
      writeFileSync(path, body);
      gh('pr', 'edit', state.pr, '--body-file', path);
    }
    // 交用户批准的这次提交：批准卡和待交付卡先显示的汇总最前面写明，不进 PR 描述。
    const escalated = contracted && state.escalate === true;
    const summary = escalated ? `【交用户批准】这次提交是主 Agent 交给用户批准的，项目检查没有按契约校验，不自动合并。\n范围门禁的违例：${state.gate.outside.length || state.gate.missing.length ? `\n${violationText(state.gate)}` : '没有。'}\n\n${body}` : body;
    output('route', o && (o.lost || !o.report || o.must.length) ? 'review' : 'accept');
    output('summary', summary);
    const gate = state.gate, scoped = gate?.head === state.head && !gate.outside.length && !gate.missing.length;
    output('auto', String(!escalated && env.AUTO === 'true' && (contracted ? scoped && done?.head === state.head && !done.must.length && !(o && (o.lost || !o.report)) : Boolean(done || piecesReviewed()) && !state.overallMust)));
    output('review', o ? overallText(o) : '');
    output('note', !done ? '' : done.head === state.head ? '，整条需求分支已整体评审' : `，整条需求分支在 ${done.head.slice(0, 12)} 时整体评审过`);
    break;
  }
  case 'review': {
    const { choice, note = '' } = JSON.parse(env.REVIEW);
    if (choice === 'progress') back(`整体评审后主 Agent 选了回到进行中。${note.trim() ? `\n${note}` : ''}\n整体评审的结论：\n${overallText(state.outcome)}`);
    output('route', choice);
    break;
  }
  case 'preview': {
    const { choice, note = '' } = JSON.parse(env.PREVIEW);
    const missing = choice === 'progress' && !note.trim();
    if (choice === 'progress' && !missing) back(`安装预览版需处理：\n${note}`);
    output('feedback', missing ? '回到进行中必须在备注中写具体意见。' : '');
    output('route', missing ? 'preview' : choice === 'progress' ? 'progress' : 'device');
    break;
  }
  case 'device': {
    // 「不行」必须附言（写意见或附截图）；截图的路径随意见交回主 Agent，它能直接看。
    const { choice, note = '', attachments = [] } = JSON.parse(env.DEVICE);
    const missing = choice === 'no' && !note.trim() && !attachments.length;
    const files = attachments.length ? `附件：\n${attachments.map(path => `- ${path}`).join('\n')}` : '';
    if (choice === 'no' && !missing) back(`设备验收不通过：\n${[note.trim() && note, files].filter(Boolean).join('\n')}`);
    output('feedback', missing ? '选择「不行」必须写验收意见或附上截图。' : '');
    output('route', missing ? 'device' : choice === 'no' ? 'progress' : 'passed');
    break;
  }
  case 'delivery': {
    const { choice, note = '' } = JSON.parse(env.DELIVERY_RESULT);
    const missing = choice === 'revise' && !note.trim();
    if (choice === 'revise' && !missing) back(`所属需求退回修改：\n${note}`);
    output('feedback', missing ? '退回修改必须在备注中写具体意见。' : '');
    output('route', missing ? 'delivery' : choice === 'revise' ? 'progress' : 'merge');
    break;
  }
  // 批准卡：「暂不合并」带着原因回到进行中；「合并」记下勾了哪些合并后的流程（shared.mjs outputPicked）。
  // 契约模式的自动合并（env.AUTO 即 overall.auto，只按它判，不读批准卡的答复：早先的批准卡可能留着旧答复）不出卡，由 shared.mjs autoApproval 合成答复：
  // 只勾白名单（契约的 hooks）里的加入者；非契约模式一律读批准卡的答复；白名单里有不是当前 head 上挂点 merged 加入者的名字就不合并，带着原因回到进行中。
  case 'approval': {
    const auto = contracted && env.AUTO === 'true' && autoApproval(contractOf().hooks, env.JOINERS);
    const answer = !auto ? JSON.parse(env.APPROVAL) : auto.unknown.length ? { choice: 'stop' } : auto.answer;
    if (auto && answer.choice === 'stop') back(`自动合并没有合并：契约的 hooks 里有名字不是需求分支 head 上挂点 merged 的加入者：${auto.unknown.join('、')}。\n当前 head 上挂点 merged 的加入者：${auto.known.join('、') || '没有'}。\n处理：让需求分支上有这些加入者（项目的流程加入挂点 merged）后再提交验收；契约开工时已锁定，写错了的名字只能由用户重新开工，或提交验收时勾「交用户批准」，由用户在批准卡上决定。`);
    else if (answer.choice === 'stop') back(`用户选了暂不合并：\n${answer.note ?? ''}`);
    output('route', answer.choice === 'stop' ? 'stop' : 'merge');
    outputPicked(answer, env.JOINERS);
    break;
  }
  case 'inputs':
    outputFilled();
    break;
  // 合并后的流程都成功（run-workflows 有一项没成功就让运行失败）：结束时交给发起会话的一句话，各项用批准卡上勾选项的名字，拿不到用流程名。
  // 没跑任何合并后的流程的结束直接写在流程定义里，措辞同 review 插件的简易开发。
  case 'ran': {
    const names = new Map(JSON.parse(env.JOINERS).map(joiner => [joiner.id, joiner.name]));
    output('line', `合并后的流程已全部结束，不用再等：${JSON.parse(env.RUNS).map(run => `${names.get(run.workflow) ?? run.workflow}：成功`).join('；')}`);
    break;
  }
  // 用合并提交进目标分支：目标分支的 first-parent 历史里一个需求一个提交，需求分支里每个块一个提交。
  case 'merge': {
    const commit = mergedCommit(state.pr, state.head) ?? mergePr(state.pr, state.head, 'merge');
    if (!commit) {
      back(`PR ${state.pr} 与目标分支 ${state.base} 存在合并冲突，需求分支 head ${state.head}。\n请选「跟上目标分支」派一块，让执行者把最新目标分支合进来、解冲突、顺延撞号的迁移版本；合进需求分支后再提交验收，重新跑检查、批准合并及合并后的流程。`);
      output('route', 'conflict');
      break;
    }
    output('route', 'merged');
    output('commit', commit);
    break;
  }
  // 提交验收先跟上目标分支（README.md「跟上目标分支」），两端 SHA 在这里固定：需求分支已包含目标分支不动；需求分支是它的祖先就快进；
  // 分叉但能干净合并，就在步骤工作区做保留双亲的合并提交（需求分支在前）；有冲突交开工执行者（sync-resolve），没填就带着冲突文件回到进行中。
  case 'sync-base': {
    const base = fetched(state.base), head = fetched(state.branch);
    let route = 'pr';
    if (ancestor(base, head)) console.error(`需求分支 ${head} 已包含 ${state.base} ${base}`);
    else if (ancestor(head, base)) { if (!pushBranch(base, head)) route = 'progress'; }
    else {
      const merge = spawnSync('git', ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', head, base], { encoding: 'utf8' });
      if (merge.error) throw merge.error;
      if (merge.status !== 0 && merge.status !== 1) { process.stderr.write(merge.stderr); process.exit(merge.status ?? 1); }
      const [tree, ...files] = merge.stdout.split('\0');
      if (merge.status === 0) {
        const commit = git('commit-tree', tree, '-p', head, '-p', base, '-m', `合并 ${state.base} 到 ${state.branch}`);
        if (pushBranch(commit, head)) pushed(head, commit, `跟上 ${state.base}`);
        else route = 'progress';
      } else {
        state.sync = { base, head, files: [...new Set(files.filter(Boolean))] };
        route = env.FIXER === 'true' ? 'resolve' : 'progress';
        if (route === 'progress') back(`需求分支 ${head} 与目标分支 ${state.base} ${base} 有冲突，冲突的文件：\n${state.sync.files.map(file => `- ${file}`).join('\n')}\n没填开工执行者，流程不能自己合并。请选「跟上目标分支」派一块（备注最前面写执行者），让执行者把最新目标分支合进来、解冲突、顺延撞号的迁移版本；合进需求分支后再提交验收。`);
      }
    }
    save();
    output('route', route);
    break;
  }
  // 冲突交开工执行者：从同步时固定的需求分支 head 开会话合并、解冲突、提交；它的 head 同时包含两端才普通推送到需求分支。
  // 上次失败留下了会话就接回它、先核对现场；接不回（回复里没有会话 ID）才从需求分支 head 新开一次。
  case 'sync-resolve': {
    const { base, head } = state.sync, task = mergeText(state.sync);
    const fresh = () => talk(['--commit', head, '--title', `${state.title}：跟上 ${state.base}`, ...agentArgs(JSON.parse(env.EXECUTOR))], task);
    let attempt = state.sync.session ? talk(['--continue', state.sync.session], `${resumeText}\n\n原任务：\n${task}`) : fresh();
    if (!attempt.reply?.session && state.sync.session) {
      console.error(`接回会话 ${state.sync.session} 失败（没有会话 ID），改为从需求分支 ${head} 新开会话。`);
      delete state.sync.session;
      save();
      attempt = fresh();
    }
    if (attempt.failed) {
      if (attempt.reply?.session) { state.sync.session = attempt.reply.session; save(); }
      fail(attempt);
    }
    const executor = attempt.reply;
    // 先落盘会话：随后推送需求分支因网络失败退出时，再跑接回这个会话，不另开；推送成功后清掉。
    state.sync.session = executor.session;
    save();
    let route = 'pr';
    if (!ancestor(base, executor.head) || !ancestor(head, executor.head)) {
      back(`跟上目标分支：执行者没有把 ${state.base} ${base} 合并进需求分支 ${head}（执行会话 ${executor.session}，head ${executor.head}）。执行者的回答：\n${executor.answer}\n请选「跟上目标分支」派一块处理冲突，合进需求分支后再提交验收。`);
      route = 'progress';
    } else if (pushBranch(executor.head, head)) {
      pushed(head, executor.head, `跟上 ${state.base}，执行者解冲突`);
      delete state.sync.session;
    } else route = 'progress';
    save();
    output('route', route);
    break;
  }
  default: throw new Error(`未知开发步骤：${action}`);
}
