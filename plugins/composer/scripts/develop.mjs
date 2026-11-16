// 需求运行（README.md「监督开发」）：一个需求一条需求分支 req/<运行 ID>，主 Agent 在「需求进行中」派块（piece，本运行调用的子运行）往里提改动，提交验收后需求分支开 PR 进目标分支。
// 每步的工作区都会回收；反馈与汇报暂存在本次运行的产物里。进度以 GitHub 为准：需求分支、已合并的块和需求分支进目标分支的 PR，从头重跑也接得上。
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { waitForGitHubChecks } from './github-checks.mjs';
import { agentArgs, checksText, command, gh, git, instructions, mergedCommit, mergePr, openPr, output, outputFilled, outputPicked, reviewsText } from './shared.mjs';
import { findingLine, fixText, historyText, previousFor, readResponses, triageOverall } from './triage.mjs';

const env = process.env, action = process.argv[2];
const statePath = join(env.CODA_ARTIFACTS, 'develop.json');

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

// 从目标分支最新提交建需求分支；远端已有同名需求分支时沿用（运行从头重跑）。
if (action === 'branch') {
  const base = env.BASE || gh('repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name');
  const branch = `req/${env.GITHUB_RUN_ID}`;
  if (git('ls-remote', '--heads', 'origin', branch)) console.error(`远端已有需求分支 ${branch}，沿用`);
  else {
    git('fetch', 'origin', base);
    git('push', 'origin', `FETCH_HEAD:refs/heads/${branch}`);
  }
  writeFileSync(statePath, JSON.stringify({ title: env.TITLE, goal: env.GOAL, base, branch, feedback: '', report: '' }));
  for (const [name, value] of Object.entries({ title: env.TITLE, goal: env.GOAL, base, branch })) output(name, value);
  process.exit(0);
}

const state = JSON.parse(readFileSync(statePath, 'utf8'));
const save = () => writeFileSync(statePath, JSON.stringify(state));
// 回到「需求进行中」的原因，主 Agent 答复后清掉。
const back = reason => { state.feedback = reason; save(); };

// 与 PR 的 Files changed 一致：目标分支最新提交到需求分支 head 的三点 diff，按 .coda/areas.json 的最长前缀归区域。
const changes = base => {
  const declared = git('ls-tree', '--name-only', state.head, '.coda/areas.json') ? JSON.parse(git('show', `${state.head}:.coda/areas.json`)) : {};
  const prefixes = Object.entries(declared).flatMap(([area, list]) => list.map(prefix => [prefix, area])).sort((a, b) => b[0].length - a[0].length);
  const fields = git('diff', '--numstat', '-z', '-M', `${base}...${state.head}`).split('\0');
  const areas = {}, total = { files: 0, added: 0, deleted: 0 };
  for (let i = 0; i < fields.length - 1; i++) {
    const [added, deleted, name] = fields[i].split('\t');
    // 改名时 -z 输出旧路径和新路径两个字段，按新路径归类。
    const file = name || fields[i += 2];
    const area = prefixes.find(([prefix]) => file.startsWith(prefix))?.[1] ?? (file.includes('/') ? file.split('/')[0] : '根目录');
    for (const group of [areas[area] ??= { files: 0, added: 0, deleted: 0 }, total]) {
      group.files++;
      group.added += added === '-' ? 0 : Number(added);
      group.deleted += deleted === '-' ? 0 : Number(deleted);
    }
  }
  const line = ({ files, added, deleted }) => `${files} 个文件 +${added} -${deleted}`;
  return [`改动：${line(total)}`, ...Object.entries(areas).sort(([, a], [, b]) => b.added + b.deleted - a.added - a.deleted).map(([area, group]) => `- ${area}：${line(group)}`)].join('\n');
};

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

const ancestor = (older, newer) => spawnSync('git', ['merge-base', '--is-ancestor', older, newer]).status === 0;
const fetched = ref => { git('fetch', 'origin', ref); return git('rev-parse', 'FETCH_HEAD'); };
// 流程自己往需求分支推（跟上目标分支、整体评审的修复）：普通推送，不 force。被拒且需求分支已不是 from（别人推进了需求分支）时返回 false，
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

// 「需求进行中」派块时备注最前面换人的行（README.md「派块」）：一行一个角色，冒号后先写 Agent ID，再按需写「模型 …」「强度 …」「模式 …」，逗号隔开；
// 可带 Markdown 列表的「- 」。备用执行者和评审者写「无」表示这一块不用。没写的角色用开工值（流程里用 FEEL 拼成 agent 对象）。
const ROLES = { 执行者: 'executor', 备用执行者: 'executor2', 评审者: 'reviewer', 第二评审者: 'reviewer2' };
const SETTINGS = { 模型: 'model', 强度: 'effort', 模式: 'mode' };
const ROLE_LINE = /^(?:[-*]\s+)?(执行者|备用执行者|评审者|第二评审者)\s*[:：]\s*(.*)$/;
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
    const { choice, note = '' } = JSON.parse(env.PROGRESS);
    const piece = choice === 'piece' || choice === 'sync' ? pieceOf(choice, note) : {};
    const missing = piece.error ? `${piece.error}这一块没有派出去。`
      : !note.trim() && { submit: '提交验收必须在备注中写给用户的改动汇报。', pause: '暂停必须在备注中写为什么暂停、等什么。' }[choice];
    if (!missing) {
      if (choice === 'submit') state.report = note;
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
  // 块合进了需求分支：下一次「需求进行中」写上合入的提交和块的运行。
  case 'piece-landed':
    back(`块「${env.TITLE}」已合进需求分支 ${state.branch}：提交 ${env.COMMIT}，运行 coda://workflow-runs/${env.PIECE_RUN}。`);
    break;
  // 块没合进来（失败、被取消，或主 Agent 在块里选了放弃）：引擎只把调用失败交给出错边界，不带被调运行的原因，所以指向本运行里调用的块。
  case 'piece-failed':
    back(`块「${env.TITLE}」没有合进需求分支 ${state.branch}：块运行失败、被取消，或你在块里选了放弃，需求分支没动。\n请用 workflow_status 查看本运行 coda://workflow-runs/${env.GITHUB_RUN_ID} 的步骤「块」调用的块运行，读它的结局、错误和日志；处理好再派一块。`);
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
    const direct = state.pushed?.length ? `\n\n流程直接推到需求分支的提交：\n${state.pushed.map(p => `- ${p.commit.slice(0, 12)} ${p.subject}（${p.why}）`).join('\n')}` : '';
    const summary = `${state.report}\n\n块：\n${pieces(base, state.head)}${direct}\n\n${changes(base)}`;
    const path = join(env.RUNNER_TEMP, 'pr.md');
    writeFileSync(path, summary);
    state.pr = gh('pr', 'list', '--head', state.branch, '--base', state.base, '--state', 'open', '--limit', '1', '--json', 'url', '--jq', '.[].url');
    if (state.pr) gh('pr', 'edit', state.pr, '--body-file', path);
    else state.pr = openPr('--base', state.base, '--head', state.branch, '--title', state.title, '--body-file', path);
    save();
    output('checked', String(state.checks?.head === state.head));
    output('url', state.pr);
    output('head', state.head);
    output('base', base);
    output('branch', state.branch);
    output('summary', summary);
    output('task', `需求：${state.title}\n\n目标与完成标准：\n${state.goal}\n\n主 Agent 的汇报：\n${state.report}`);
    break;
  }
  case 'checks-passed':
    state.checks = { head: state.head, runs: JSON.parse(env.RUNS) };
    save();
    break;
  case 'github-checks': {
    const status = await waitForGitHubChecks(state.pr, state.head);
    if (status !== 0) process.exit(status);
    output('evidence', `项目检查：\n${checksText(state.checks, state.head)}\n合并前检查与 GitHub 检查已通过。`);
    break;
  }
  case 'check-failed':
    back(`${env.STEP}未通过，需求分支 head ${state.head}。\n运行：coda://workflow-runs/${env.GITHUB_RUN_ID}\n请用 workflow_status 查看本运行「${env.STEP}」及其调用的失败流程，读取错误和日志；派一块修好后再提交验收。`);
    break;
  case 'reviewed':
    output('reviews', reviewsText(env.REVIEWS, state.head, '评审整条需求分支'));
    break;
  case 'review': {
    const { choice, note = '' } = JSON.parse(env.REVIEW);
    if (choice === 'progress') back(`整体评审后主 Agent 选了回到进行中。${note.trim() ? `\n${note}` : ''}\n评审的发现与原文：${join(env.CODA_ARTIFACTS, 'reviews.md')}`);
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
  case 'approval': {
    const answer = JSON.parse(env.APPROVAL);
    if (answer.choice === 'stop') back(`用户选了暂不合并：\n${answer.note ?? ''}`);
    output('route', answer.choice === 'stop' ? 'stop' : 'merge');
    outputPicked(answer, env.JOINERS);
    break;
  }
  case 'inputs':
    outputFilled();
    break;
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
  // 每次提交验收都从这里进来，整体评审的收敛从头开始。
  case 'sync-base': {
    state.converge = { findings: [], rounds: 0, history: [], waiting: false };
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
  case 'sync-resolve': {
    const { base, head } = state.sync, prompt = join(env.RUNNER_TEMP, 'task.md');
    writeFileSync(prompt, `${instructions}\n\n${mergeText(state.sync)}\n`);
    const executor = JSON.parse(command('coda-agent', ['--commit', head, '--title', `${state.title}：跟上 ${state.base}`, ...agentArgs(JSON.parse(env.EXECUTOR)), '--json', '--prompt-file', prompt]));
    let route = 'pr';
    if (!ancestor(base, executor.head) || !ancestor(head, executor.head)) {
      back(`跟上目标分支：执行者没有把 ${state.base} ${base} 合并进需求分支 ${head}（执行会话 ${executor.session}，head ${executor.head}）。执行者的回答：\n${executor.answer}\n请选「跟上目标分支」派一块处理冲突，合进需求分支后再提交验收。`);
      route = 'progress';
    } else if (pushBranch(executor.head, head)) pushed(head, executor.head, `跟上 ${state.base}，执行者解冲突`);
    else route = 'progress';
    save();
    output('route', route);
    break;
  }
  // 整体评审的收敛（README.md「整体评审」），状态在 state.converge，记法同块的评审回路，另有 session：修复用的执行会话。
  // 定这一次怎么评：交执行者修过、等复评时增量复评（base 是上次评过的 head，带各位置上次的发现与回应）；否则对整条需求分支完整评审（base 是目标分支最新提交）。
  case 'overall-round': {
    const c = state.converge;
    c.full = !c.waiting;
    output('base', c.full ? env.BASE : c.reviewedHead);
    for (const [name, slot] of [['previous', 'reviewer'], ['previous2', 'reviewer2'], ['previous3', 'reviewer3']]) output(name, c.full ? '' : previousFor(c.findings, slot));
    save();
    break;
  }
  // 分流（triage.mjs 的 triageOverall）：accept 直接进验收，没修的 P3 写进汇报（更新 PR 描述，批准卡用输出的 summary）；fix 交执行者；escalate 交主 Agent 的「整体评审结论」。
  case 'overall-triage': {
    const c = state.converge, head = state.head;
    if (c.full) c.rounds = 0;
    const result = triageOverall(JSON.parse(env.REVIEWS), { head, findings: c.findings, rounds: c.rounds, full: c.full, fixer: env.FIXER === 'true' });
    Object.assign(c, { findings: result.findings, reviewedHead: head, waiting: false });
    c.history.push({ kind: 'review', full: c.full, head, resolutions: result.resolutions, added: result.findings.filter(f => result.added.includes(f.id)), route: result.route, reasons: result.reasons });
    const minor = result.route === 'accept' ? result.findings.filter(f => f.status === 'open') : [];
    const summary = minor.length ? `${env.SUMMARY}\n\n整体评审的小问题（P3，没有修）：\n${minor.map(f => findingLine(f, true)).join('\n')}` : env.SUMMARY;
    if (minor.length) {
      const path = join(env.RUNNER_TEMP, 'pr.md');
      writeFileSync(path, summary);
      gh('pr', 'edit', state.pr, '--body-file', path);
    }
    save();
    output('route', result.route);
    output('summary', summary);
    break;
  }
  // 没关的 P2 交开工执行者在需求分支上逐条修复或反驳：第一轮从需求分支 head 开会话，之后续同一会话；它只提交，这里普通推送到需求分支。
  // 有新提交回到开 PR（汇总列出这些提交）、重跑全部检查后增量复评（pr）；只反驳、没有新提交就不重跑检查，直接复评（again）；
  // 都没有交主 Agent（review）；推送被拒带着原因回到进行中（progress）。
  case 'overall-fix': {
    const c = state.converge, from = state.head, open = c.findings.filter(f => f.status === 'open' && f.severity === 'P2');
    const prompt = join(env.RUNNER_TEMP, 'task.md');
    writeFileSync(prompt, `${instructions}\n\n${fixText(from, open)}\n`);
    const args = c.session ? ['--continue', c.session] : ['--commit', from, '--title', `${state.title}：整体评审修复`, ...agentArgs(JSON.parse(env.EXECUTOR))];
    const executor = JSON.parse(command('coda-agent', [...args, '--json', '--prompt-file', prompt]));
    c.session = executor.session;
    const responses = readResponses(executor.answer, open.map(f => f.id));
    for (const f of open) f.response = responses[f.id];
    const moved = executor.head !== from, disputed = Object.values(responses).some(r => r.disposition === 'disputed');
    let route = moved ? 'pr' : disputed ? 'again' : 'review';
    if (moved && pushBranch(executor.head, from)) pushed(from, executor.head, '整体评审修复');
    else if (moved) route = 'progress';
    c.rounds++;
    c.waiting = route === 'pr' || route === 'again';
    c.history.push({ kind: 'fix', round: c.rounds, from, head: executor.head, ids: open.map(f => f.id), responses,
      note: route === 'review' ? '执行者没有新提交，也没有反驳，升级给主 Agent' : route === 'progress' ? '推送被拒，回到进行中' : '' });
    save();
    output('route', route);
    break;
  }
  // 出「整体评审结论」之前：收敛经过放上卡（全文在产物里），不再等复评。
  case 'overall-rounds': {
    const history = state.converge.history, path = join(env.CODA_ARTIFACTS, 'converge.md'), text = historyText(history);
    state.converge.waiting = false;
    save();
    writeFileSync(path, text);
    output('text', text.length <= 4000 ? `${text}\n全文：${path}` : `前面的轮次见 ${path}。\n\n${historyText(history.slice(-1))}`);
    break;
  }
  default: throw new Error(`未知开发步骤：${action}`);
}
