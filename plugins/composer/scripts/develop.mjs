// 需求运行（README.md「监督开发」）：一个需求一条泳道 lane/<运行 ID>，主 Agent 用泳道 PR（lane-pr）往里提改动，提交验收后泳道开 PR 进目标分支。
// 每步的工作区都会回收；反馈与汇报暂存在本次运行的产物里。进度以 GitHub 为准：泳道分支、已合并的泳道 PR 和泳道进目标分支的 PR，从头重跑也接得上。
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
  output('route', title && goal ? 'lane' : 'brief');
  output('title', title);
  output('goal', goal);
  process.exit(0);
}

// 从目标分支最新提交建泳道；远端已有同名泳道时沿用（运行从头重跑）。
if (action === 'lane') {
  const base = env.BASE || gh('repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name');
  const lane = `lane/${env.GITHUB_RUN_ID}`;
  if (git('ls-remote', '--heads', 'origin', lane)) console.error(`远端已有泳道 ${lane}，沿用`);
  else {
    git('fetch', 'origin', base);
    git('push', 'origin', `FETCH_HEAD:refs/heads/${lane}`);
  }
  writeFileSync(statePath, JSON.stringify({ title: env.TITLE, goal: env.GOAL, base, lane, feedback: '', report: '' }));
  for (const [name, value] of Object.entries({ title: env.TITLE, goal: env.GOAL, base, lane })) output(name, value);
  process.exit(0);
}

const state = JSON.parse(readFileSync(statePath, 'utf8'));
const save = () => writeFileSync(statePath, JSON.stringify(state));
// 回到「需求进行中」的原因，主 Agent 答复后清掉。
const back = reason => { state.feedback = reason; save(); };

// 与 PR 的 Files changed 一致：目标分支最新提交到泳道 head 的三点 diff，按 .coda/areas.json 的最长前缀归区域。
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

// 合进泳道的泳道 PR，从 GitHub 读，按编号先后。
const lanePrs = () => {
  const merged = JSON.parse(gh('pr', 'list', '--base', state.lane, '--state', 'merged', '--limit', '200', '--json', 'number,title,url'));
  return merged.sort((a, b) => a.number - b.number).map(pr => `- ${pr.title}（${pr.url}）`).join('\n') || '（还没有合进泳道的泳道 PR）';
};

const ancestor = (older, newer) => spawnSync('git', ['merge-base', '--is-ancestor', older, newer]).status === 0;
const fetched = ref => { git('fetch', 'origin', ref); return git('rev-parse', 'FETCH_HEAD'); };
// 流程自己往泳道推（跟上目标分支、整体评审的修复）：普通推送，不 force。被拒且泳道已不是 from（别人推进了泳道）时返回 false，
// 不重试、不覆盖，由调用方带着原因回到进行中；其余失败保留原退出码。
const pushLane = (commit, from) => {
  const result = spawnSync('git', ['push', '--no-follow-tags', 'origin', `${commit}:refs/heads/${state.lane}`], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status === 0) return true;
  if (fetched(state.lane) === from) process.exit(result.status ?? 1);
  back(`推送 ${commit} 到泳道 ${state.lane} 被拒：泳道已不是 ${from}，有别的提交推进了它，流程没有覆盖。\n运行：coda://workflow-runs/${env.GITHUB_RUN_ID}\n请看泳道最新的提交，处理好后重新提交验收。`);
  return false;
};
// 不经泳道 PR、由流程直接推到泳道的提交，PR 汇总里单独列出（已合并的泳道 PR 列表里没有它们）：只数 first-parent，合并进来的目标分支提交不算。
const pushed = (from, to, why) => {
  const lines = git('log', '--first-parent', '--reverse', '--format=%H%x09%s', `${from}..${to}`).split('\n').filter(Boolean);
  state.pushed = [...state.pushed ?? [], ...lines.map(line => { const [commit, subject] = line.split('\t'); return { commit, subject, why }; })];
};
// 跟上目标分支有冲突时交开工执行者：只合并不变基（同 lane-pr.mjs 的 syncText）。
const mergeText = ({ base, files }) => `把目标分支 ${state.base} 合并进泳道 ${state.lane}，让泳道跟上它，只做这件事。当前分支是泳道 head，目标分支固定在提交 ${base}。
试合并发现冲突的文件：
${files.map(file => `- ${file}`).join('\n')}
先 git fetch origin ${state.base}，再 git merge ${base} 合并（merge）进当前分支，不要变基、不要压成一个提交：变基会改写已经审查过的泳道提交，合并才保住泳道与目标分支的祖先关系。
解决冲突；数据库迁移等版本号和目标分支撞号时，顺延泳道这边的。
跑和冲突相关的测试后提交合并提交。回报冲突了哪些文件、各自怎么解决的、跑了什么。`;

switch (action) {
  case 'resume':
    output('reason', state.feedback);
    break;
  case 'progress': {
    const { choice, note = '' } = JSON.parse(env.PROGRESS);
    const missing = !note.trim() && { submit: '提交验收必须在备注中写给用户的改动汇报。', pause: '暂停必须在备注中写为什么暂停、等什么。' }[choice];
    if (!missing) {
      if (choice === 'submit') state.report = note;
      state.feedback = '';
      save();
    }
    output('feedback', missing || '');
    output('route', missing ? 'progress' : choice);
    break;
  }
  case 'paused': {
    const { choice, note = '' } = JSON.parse(env.PAUSED);
    if (choice === 'continue') back(`用户在「需求已暂停」选了继续。${note.trim() ? `\n用户的话：\n${note}` : ''}`);
    output('route', choice);
    break;
  }
  // 开或更新泳道进目标分支的 PR：汇报、合进泳道的泳道 PR、改动区域。已开着的 PR 从 GitHub 找，不靠运行暂存。
  case 'pr': {
    git('fetch', 'origin', state.base);
    const base = git('rev-parse', 'FETCH_HEAD');
    git('fetch', 'origin', state.lane);
    state.head = git('rev-parse', 'FETCH_HEAD');
    const direct = state.pushed?.length ? `\n\n流程直接推到泳道的提交：\n${state.pushed.map(p => `- ${p.commit.slice(0, 12)} ${p.subject}（${p.why}）`).join('\n')}` : '';
    const summary = `${state.report}\n\n泳道 PR：\n${lanePrs()}${direct}\n\n${changes(base)}`;
    const path = join(env.RUNNER_TEMP, 'pr.md');
    writeFileSync(path, summary);
    state.pr = gh('pr', 'list', '--head', state.lane, '--base', state.base, '--state', 'open', '--limit', '1', '--json', 'url', '--jq', '.[].url');
    if (state.pr) gh('pr', 'edit', state.pr, '--body-file', path);
    else state.pr = openPr('--base', state.base, '--head', state.lane, '--title', state.title, '--body-file', path);
    save();
    output('checked', String(state.checks?.head === state.head));
    output('url', state.pr);
    output('head', state.head);
    output('base', base);
    output('lane', state.lane);
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
    back(`${env.STEP}未通过，泳道 head ${state.head}。\n运行：coda://workflow-runs/${env.GITHUB_RUN_ID}\n请用 workflow_status 查看本运行「${env.STEP}」及其调用的失败流程，读取错误和日志；提泳道 PR 修好后再提交验收。`);
    break;
  case 'reviewed':
    output('reviews', reviewsText(env.REVIEWS, state.head, '评审整条泳道'));
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
  // 用合并提交进目标分支：目标分支的 first-parent 历史里一个需求一个提交，泳道里每个泳道 PR 一个提交。
  case 'merge': {
    const commit = mergedCommit(state.pr, state.head) ?? mergePr(state.pr, state.head, 'merge');
    if (!commit) {
      back(`PR ${state.pr} 与目标分支 ${state.base} 存在合并冲突，泳道 head ${state.head}。\n请发起 sync=true 的泳道 PR，让执行者把最新目标分支合进来、解冲突、顺延撞号的迁移版本；合进泳道后再提交验收，重新跑检查、批准合并及合并后的流程。`);
      output('route', 'conflict');
      break;
    }
    output('route', 'merged');
    output('commit', commit);
    break;
  }
  // 提交验收先跟上目标分支（README.md「跟上目标分支」），两端 SHA 在这里固定：泳道已包含目标分支不动；泳道是它的祖先就快进；
  // 分叉但能干净合并，就在步骤工作区做保留双亲的合并提交（泳道在前）；有冲突交开工执行者（sync-resolve），没填就带着冲突文件回到进行中。
  // 每次提交验收都从这里进来，整体评审的收敛从头开始。
  case 'sync-base': {
    state.converge = { findings: [], rounds: 0, history: [], waiting: false };
    const base = fetched(state.base), lane = fetched(state.lane);
    let route = 'pr';
    if (ancestor(base, lane)) console.error(`泳道 ${lane} 已包含 ${state.base} ${base}`);
    else if (ancestor(lane, base)) { if (!pushLane(base, lane)) route = 'progress'; }
    else {
      const merge = spawnSync('git', ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', lane, base], { encoding: 'utf8' });
      if (merge.error) throw merge.error;
      if (merge.status !== 0 && merge.status !== 1) { process.stderr.write(merge.stderr); process.exit(merge.status ?? 1); }
      const [tree, ...files] = merge.stdout.split('\0');
      if (merge.status === 0) {
        const commit = git('commit-tree', tree, '-p', lane, '-p', base, '-m', `合并 ${state.base} 到 ${state.lane}`);
        if (pushLane(commit, lane)) pushed(lane, commit, `跟上 ${state.base}`);
        else route = 'progress';
      } else {
        state.sync = { base, lane, files: [...new Set(files.filter(Boolean))] };
        route = env.FIXER === 'true' ? 'resolve' : 'progress';
        if (route === 'progress') back(`泳道 ${lane} 与目标分支 ${state.base} ${base} 有冲突，冲突的文件：\n${state.sync.files.map(file => `- ${file}`).join('\n')}\n没填开工执行者，流程不能自己合并。请发起 sync=true 的泳道 PR，让执行者把最新目标分支合进来、解冲突、顺延撞号的迁移版本；合进泳道后再提交验收。`);
      }
    }
    save();
    output('route', route);
    break;
  }
  // 冲突交开工执行者：从同步时固定的泳道 head 开会话合并、解冲突、提交；它的 head 同时包含两端才普通推送到泳道。
  case 'sync-resolve': {
    const { base, lane } = state.sync, prompt = join(env.RUNNER_TEMP, 'task.md');
    writeFileSync(prompt, `${instructions}\n\n${mergeText(state.sync)}\n`);
    const executor = JSON.parse(command('coda-agent', ['--commit', lane, '--title', `${state.title}：跟上 ${state.base}`, ...agentArgs(JSON.parse(env.EXECUTOR)), '--json', '--prompt-file', prompt]));
    let route = 'pr';
    if (!ancestor(base, executor.head) || !ancestor(lane, executor.head)) {
      back(`跟上目标分支：执行者没有把 ${state.base} ${base} 合并进泳道 ${lane}（执行会话 ${executor.session}，head ${executor.head}）。执行者的回答：\n${executor.answer}\n请发起 sync=true 的泳道 PR 处理冲突，合进泳道后再提交验收。`);
      route = 'progress';
    } else if (pushLane(executor.head, lane)) pushed(lane, executor.head, `跟上 ${state.base}，执行者解冲突`);
    else route = 'progress';
    save();
    output('route', route);
    break;
  }
  // 整体评审的收敛（README.md「整体评审」），状态在 state.converge，记法同泳道 PR 的评审回路，另有 session：修复用的执行会话。
  // 定这一次怎么评：交执行者修过、等复评时增量复评（base 是上次评过的 head，带各位置上次的发现与回应）；否则对整条泳道完整评审（base 是目标分支最新提交）。
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
  // 没关的 P2 交开工执行者在泳道上逐条修复或反驳：第一轮从泳道 head 开会话，之后续同一会话；它只提交，这里普通推送到泳道。
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
    if (moved && pushLane(executor.head, from)) pushed(from, executor.head, '整体评审修复');
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
