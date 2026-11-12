// 每一步的工作区都会回收；泳道进度和已通过的改动留在本次运行的产物里。
import { spawnSync } from 'node:child_process';
import { waitForGitHubChecks } from './github-checks.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { command, gh, git, output } from './shared.mjs';

const env = process.env, action = process.argv[2];
const statePath = join(env.CODA_ARTIFACTS, 'develop.json');
const instructions = `你是这次开发流程的执行者，自己完成这一项任务，不继承主 Agent 的协调职责，不再委派。
只做这一项，在当前分支提交，不推送、不开 PR、不合并、不部署。
遵守仓库的 AGENTS.md。只改必需的地方，不写防御性、冗余的代码，不顺手重构。
只跑与改动直接相关的快检查；流程会在审查前自己跑项目检查，构建、全套和界面检查不在这里重复，不必再用 run-held 跑整套编译。
用户勾选发布后，未自行填写发布说明时，由主 Agent 在「写发布说明」任务中准备。
回报改了什么、为什么、实际跑了哪些验证及未验证部分。`;

// 用户开启时由主 Agent 写的第一项任务：备注第一行是功能名，其后是任务。
if (action === 'brief') {
  const [first = '', ...rest] = (JSON.parse(env.BRIEF).note ?? '').trim().split(/\r?\n/);
  const title = first.trim(), task = rest.join('\n').trim();
  output('feedback', title && task ? '' : '备注第一行写功能名，空一行后写第一项任务，两样都要有。');
  output('route', title && task ? 'lane' : 'brief');
  output('title', title);
  output('task', task);
  process.exit(0);
}

if (action === 'lane') {
  const base = env.BASE || gh('repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name');
  git('fetch', 'origin', base);
  const head = git('rev-parse', 'FETCH_HEAD');
  const lane = `lane/${env.GITHUB_RUN_ID}`;
  git('branch', lane, head);
  git('push', 'origin', `${lane}:refs/heads/${lane}`);
  writeFileSync(statePath, JSON.stringify({ title: env.TITLE, base, lane, head, task: env.TASK, approved: [], phase: 'preview', feedback: '', pr: '' }));
  output('title', env.TITLE);
  process.exit(0);
}

const state = JSON.parse(readFileSync(statePath, 'utf8'));
const save = () => writeFileSync(statePath, JSON.stringify(state));
const cleanup = () => {
  if (!state.checkRef) return;
  if (git('ls-remote', 'origin', state.checkRef)) git('push', 'origin', '--delete', state.checkRef);
  delete state.checkRef;
  save();
};
const body = () => state.approved.map((item, index) => `## 第 ${index + 1} 项\n\n<details><summary>任务</summary>\n\n${item.task}\n\n</details>\n\n${item.answer}\n\n提交：${item.head}`).join('\n\n');

// 与 PR 的 Files changed 一致：目标分支最新提交到 head 的三点 diff，按 .coda/areas.json 的最长前缀归区域。
const changes = () => {
  git('fetch', 'origin', state.lane);
  git('fetch', 'origin', state.base);
  const declared = git('ls-tree', '--name-only', state.head, '.coda/areas.json') ? JSON.parse(git('show', `${state.head}:.coda/areas.json`)) : {};
  const prefixes = Object.entries(declared).flatMap(([area, list]) => list.map(prefix => [prefix, area])).sort((a, b) => b[0].length - a[0].length);
  const fields = git('diff', '--numstat', '-z', '-M', `FETCH_HEAD...${state.head}`).split('\0');
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

// 「评审」各份的结果，只取评这次交付的。卡片正文的上限（4000 字）是协议对 BPMN 里字面的检查，展开后的不限；
// 评审这一段也按这个数收着：放不下时每条只留严重程度、标题和位置，说明和评审原文写在产物里。
// 评审没完成（INCOMPLETE）的写「没评成」与 review-commit 给的原因；调用本身没成（lost）的指向本运行那一步。
// 标题、位置各占一行里的一段，其中的换行压成空格，说明原样。
const SLOTS = { reviewer: '评审者', reviewer2: '第二评审者', reviewerOnce: '首次评审者' };
const reviews = () => {
  const results = (env.REVIEWS ? JSON.parse(env.REVIEWS) : []).filter(r => r.head === state.executor.head);
  if (!results.length) return '';
  const path = join(env.CODA_ARTIFACTS, 'reviews.md');
  const render = detailed => results.map(r => {
    const agent = JSON.parse(r.who);
    const who = `${SLOTS[r.slot]}（${[agent.agent, agent.model, agent.effort].filter(Boolean).join(' · ')}）`;
    if (r.state === 'lost') return `${who}：没评成。调用 review-commit 没有成功，原因见本运行 coda://workflow-runs/${env.GITHUB_RUN_ID} 的「评审这次交付」（workflow_status）。`;
    if (r.decision === 'INCOMPLETE') return `${who}：没评成：${r.line}`;
    const flat = text => text.replace(/\s*[\r\n]+\s*/g, ' ');
    const findings = JSON.parse(r.findings).map(f => `- [${f.severity}] ${flat(f.title)}${f.location ? `（${flat(f.location)}）` : ''}${detailed && f.detail ? `\n  ${f.detail.replace(/\n/g, '\n  ')}` : ''}`);
    return [`${who}：${r.line}`, ...findings].join('\n');
  }).join('\n\n');
  const full = render(true);
  writeFileSync(path, [full, ...results.filter(r => r.state === 'done').map(r => `## ${SLOTS[r.slot]}的评审原文\n\n${r.report}`)].join('\n\n'));
  return full.length <= 4000 ? `${full}\n评审原文：${path}` : `${render(false)}\n发现较多，这里只列严重程度、标题和位置；每条的说明与评审原文见 ${path}`;
};

switch (action) {
  // 换备用执行者（swap）与执行一项任务一样新开会话、从泳道当前提交开工，接手的是同一项任务：上一位没被接受的提交不带过来，只告诉它在哪。
  case 'execute':
  case 'swap':
  case 'revise': {
    const prompt = join(env.RUNNER_TEMP, 'task.md');
    const text = action === 'revise' ? state.feedback : action === 'execute' ? state.task
      : `${state.task}\n\n主 Agent 把这一项换给你重做：\n${state.feedback}\n\n上一位执行者的分支 ${state.executor.branch}、提交 ${state.executor.head} 在本机仓库可读，可以参考，也可以不用。`;
    writeFileSync(prompt, `${instructions}\n\n${text}\n`);
    const fresh = action !== 'revise';
    const args = fresh ? ['--commit', state.head, '--title', state.title] : ['--continue', state.executor.session];
    // 执行者是一组 Agent 选择（流程参数的 agent 类型）：没选的模型、强度、模式用 Agent 的默认值。
    if (fresh) {
      const { options = {}, ...chosen } = JSON.parse(env.EXECUTOR);
      for (const key of ['agent', 'model', 'effort', 'mode']) if (chosen[key]) args.push(`--${key}`, chosen[key]);
      for (const [id, value] of Object.entries(options)) args.push('--option', `${id}=${value}`);
    }
    state.executor = JSON.parse(command('coda-agent', [...args, '--json', '--prompt-file', prompt]));
    state.feedback = '';
    // 新会话的第一次交付算这项任务的第一次；退回次数只在新的一项任务开始时归零。
    if (fresh) { state.failures = []; state.reviewed = false; }
    if (action === 'execute') state.returns = 0;
    save();
    break;
  }
  case 'gate':
    state.checkRef = `refs/heads/composer-check/${env.GITHUB_RUN_ID}`;
    // 记录本轮检查分支，accept 推入泳道后删除。
    save();
    console.error(`推送执行者提交 ${state.executor.head} 到 ${state.checkRef}`);
    git('push', '--no-follow-tags', '--force', 'origin', `${state.executor.head}:${state.checkRef}`);
    output('head', state.executor.head);
    break;
  case 'gate-passed':
    state.checks = { head: state.executor.head, runs: JSON.parse(env.RUNS) };
    state.failures = [];
    state.feedback = '';
    // 评审对照泳道当前的提交；首次评审者只评这项任务第一次通过检查的交付。
    output('base', state.head);
    output('task', state.task);
    output('first', String(!state.reviewed));
    state.reviewed = true;
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
    output('checks', state.checks?.head === state.executor.head ? state.checks.runs.map(r => `${r.workflow}: ${r.state} coda://workflow-runs/${r.runId}`).join('\n') || '此提交未声明项目检查流程。' : '此提交项目检查未通过。');
    for (const [name, value] of Object.entries({ ...state.executor, lane: state.lane, feedback: state.feedback, returns: state.returns })) output(name, value);
    output('reviews', reviews());
    break;
  case 'decide': {
    const { choice, note = '' } = JSON.parse(env.REVIEW);
    // 引擎不能按条件隐藏答复：没填备用执行者时「换备用执行者重做」照样能选，选了回到审查卡说明。
    const blocked = !note.trim() ? { revise: '退回修改必须在备注中写具体意见。', next: '通过，再派一项必须在备注中写下一项任务。', accept: '通过，可以验收必须在备注中写给用户的改动汇报。', swap: '换备用执行者重做必须在备注中写为什么换、接手的人要注意什么。' }[choice]
      : choice === 'swap' && env.BACKUP !== 'true' ? '没有填备用执行者，不能换人重做；请改选别的答复。' : '';
    if (blocked) state.feedback = blocked;
    else {
      state.choice = choice;
      state.feedback = note;
      if (choice === 'accept') state.report = note;
      // 退回次数只数主 Agent 的「退回修改」；检查失败的自动退回和换人都不算。
      if (choice === 'revise') state.returns++;
    }
    save();
    output('route', blocked ? 'review' : ['revise', 'swap'].includes(choice) ? choice : 'accept');
    break;
  }
  case 'accept': {
    git('fetch', 'origin', state.lane);
    git('switch', '-C', state.lane, 'FETCH_HEAD');
    // 顺序任务只能快进；Git 的错误会说明分叉，流程停在这里交回主 Agent。
    git('merge', '--ff-only', state.executor.head);
    git('push', 'origin', `HEAD:refs/heads/${state.lane}`);
    cleanup();
    state.head = state.executor.head;
    if (state.approved.at(-1)?.head !== state.head) state.approved.push({ task: state.task, head: state.head, answer: state.executor.answer });
    const next = state.choice === 'next';
    if (next) { state.task = state.feedback; state.phase = 'preview'; }
    state.feedback = '';
    save();
    output('head', state.head);
    output('lane', state.lane);
    output('route', next ? 'execute' : !env.DELIVERY && env.DEVICES === 'true' && state.phase !== 'check' ? 'preview' : 'pr');
    break;
  }
  case 'preview': {
    const { choice, note = '' } = JSON.parse(env.PREVIEW);
    const missing = choice === 'review' && !note.trim();
    state.feedback = missing ? '回到审查必须在备注中写具体意见。' : choice === 'review' ? `安装预览版需处理：\n${note}` : '';
    save();
    output('feedback', state.feedback);
    output('route', missing ? 'preview' : choice === 'review' ? 'review' : 'device');
    break;
  }
  case 'device': {
    // 「不行」必须附言（写意见或附截图）；截图的路径随意见交回主 Agent，它能直接看。
    const { choice, note = '', attachments = [] } = JSON.parse(env.DEVICE);
    const missing = choice === 'no' && !note.trim() && !attachments.length;
    const files = attachments.length ? `附件：\n${attachments.map(path => `- ${path}`).join('\n')}` : '';
    state.feedback = missing ? '选择「不行」必须写验收意见或附上截图。' : choice === 'no' ? `设备验收不通过：\n${[note.trim() && note, files].filter(Boolean).join('\n')}` : '';
    state.phase = 'preview';
    save();
    output('feedback', state.feedback);
    output('route', missing ? 'device' : choice === 'no' ? 'review' : 'pr');
    break;
  }
  case 'approval': {
    const { choice, note = '', options = {} } = JSON.parse(env.APPROVAL);
    const missing = choice === 'merge' && (options.preview || options.release) && !note.trim();
    output('route', missing ? 'notes' : choice === 'stop' ? 'stop' : 'merge');
    break;
  }
  case 'notes': {
    const { note = '' } = JSON.parse(env.NOTES);
    const missing = !note.trim();
    output('route', missing ? 'notes' : 'ready');
    output('feedback', missing ? '请在备注填写面向用户的发布说明。' : '');
    output('notes', note);
    break;
  }
  case 'pr': {
    const path = join(env.RUNNER_TEMP, 'pr.md');
    const summary = `${state.report}\n\n${changes()}`;
    writeFileSync(path, `${summary}\n\n<details><summary>执行记录</summary>\n\n${body()}\n\n</details>`);
    if (state.pr) gh('pr', 'edit', state.pr, '--body-file', path);
    else state.pr = gh('pr', 'create', '--base', state.base, '--head', state.lane, '--title', state.title, '--body-file', path);
    state.phase = 'check';
    save();
    output('checked', String(state.checks?.head === state.head));
    output('url', state.pr);
    output('head', state.head);
    output('summary', summary);
    break;
  }
  case 'github-checks': {
    const status = await waitForGitHubChecks(state.pr, state.head);
    if (status !== 0) process.exit(status);
    break;
  }
  case 'delivery': {
    const { choice, note = '' } = JSON.parse(env.DELIVERY_RESULT);
    const missing = choice === 'revise' && !note.trim();
    state.feedback = missing ? '退回修改必须在备注中写具体意见。' : choice === 'revise' ? `所属需求退回修改：\n${note}` : '';
    save();
    output('feedback', state.feedback);
    output('route', missing ? 'delivery' : choice === 'revise' ? 'review' : 'merge');
    break;
  }
  case 'check-failed':
    state.feedback = `${env.STEP}未通过，提交 ${state.head}。\n运行：coda://workflow-runs/${env.GITHUB_RUN_ID}\n请用 workflow_status 查看本运行「${env.STEP}」及其调用的失败流程，读取错误和日志，把具体修复意见写入「退回修改」的备注，继续最近的执行会话。通过后重跑检查。`;
    state.phase = 'check';
    save();
    break;
  case 'merge': {
    const pr = JSON.parse(gh('pr', 'view', state.pr, '--json', 'state,headRefOid,mergeCommit'));
    if (pr.state === 'MERGED') {
      if (pr.headRefOid !== state.head) throw new Error(`PR 已合并，但 head 不一致：预期 ${state.head}，实际 ${pr.headRefOid}`);
      output('route', 'merged');
      output('commit', pr.mergeCommit.oid);
      break;
    }
    if (pr.state === 'CLOSED') throw new Error(`PR 已关闭但未合并：${state.pr}`);
    // 显式 --repo 让 gh 只删除远端分支，避免在分离 HEAD 中操作本地分支。
    const url = new URL(state.pr);
    const repo = `${url.host}/${url.pathname.split('/').slice(1, 3).join('/')}`;
    const result = spawnSync('gh', ['pr', 'merge', state.pr, '--repo', repo, '--squash', '--match-head-commit', state.head, '--delete-branch'], { encoding: 'utf8' });
    if (result.error) throw result.error;
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    if (result.status !== 0) {
      const failed = JSON.parse(gh('pr', 'view', state.pr, '--json', 'state,mergeable'));
      if (failed.state === 'OPEN' && failed.mergeable === 'CONFLICTING') {
        state.feedback = `PR ${state.pr} 与目标分支 ${state.base} 存在合并冲突，提交 ${state.head}。\n请主 Agent 审查后用「退回修改」交给执行者：运行 git fetch origin ${state.base}，将最新目标分支合入当前执行分支并解冲突；迁移版本号等撞号要顺延，跑相关测试并提交。之后重新经过项目检查、审查、更新 PR、合并前检查和 GitHub 检查，再重新批准合并及部署、发布选项。`;
        state.phase = 'check';
        save();
        output('route', 'conflict');
        break;
      }
      process.exit(result.status ?? 1);
    }
    const commit = gh('pr', 'view', state.pr, '--json', 'mergeCommit', '--jq', '.mergeCommit.oid');
    output('route', 'merged');
    output('commit', commit);
    break;
  }
  default: throw new Error(`未知开发步骤：${action}`);
}
