// 每一步的工作区都会回收；泳道进度和已通过的改动留在本次运行的产物里。
import { spawnSync } from 'node:child_process';
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

if (action === 'lane') {
  const base = env.BASE || gh('repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name');
  git('fetch', 'origin', base);
  const head = git('rev-parse', 'FETCH_HEAD');
  const lane = `lane/${env.GITHUB_RUN_ID}`;
  git('branch', lane, head);
  git('push', 'origin', `${lane}:refs/heads/${lane}`);
  writeFileSync(statePath, JSON.stringify({ title: env.TITLE, base, lane, head, task: env.TASK, approved: [], phase: 'preview', feedback: '', pr: '' }));
  process.exit(0);
}

const state = JSON.parse(readFileSync(statePath, 'utf8'));
const save = () => writeFileSync(statePath, JSON.stringify(state));
const body = () => state.approved.map((item, index) => `## 第 ${index + 1} 项\n\n<details><summary>任务</summary>\n\n${item.task}\n\n</details>\n\n${item.answer}\n\n提交：${item.head}`).join('\n\n');

switch (action) {
  case 'execute':
  case 'revise': {
    const prompt = join(env.RUNNER_TEMP, 'task.md');
    writeFileSync(prompt, `${instructions}\n\n${action === 'revise' ? state.feedback : state.task}\n`);
    const args = action === 'revise' ? ['--continue', state.executor.session] : ['--commit', state.head, '--title', state.title];
    if (action === 'execute') for (const key of ['agent', 'model', 'effort', 'mode']) {
      const value = env[key.toUpperCase()];
      if (value) args.push(`--${key}`, value);
    }
    state.executor = JSON.parse(command('coda-agent', [...args, '--json', '--prompt-file', prompt]));
    state.feedback = '';
    if (action === 'execute') state.failures = [];
    save();
    break;
  }
  case 'gate':
    output('head', state.executor.head);
    break;
  case 'gate-passed':
    state.checks = { head: state.executor.head, runs: JSON.parse(env.RUNS) };
    state.failures = [];
    state.feedback = '';
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
    for (const [name, value] of Object.entries({ ...state.executor, lane: state.lane, feedback: state.feedback })) output(name, value);
    break;
  case 'decide': {
    const { choice, note = '' } = JSON.parse(env.REVIEW);
    const missing = ['revise', 'next'].includes(choice) && !note.trim();
    if (missing) state.feedback = choice === 'revise' ? '退回修改必须在备注中写具体意见。' : '通过，再派一项必须在备注中写下一项任务。';
    else {
      state.choice = choice;
      state.feedback = note;
    }
    save();
    output('route', missing ? 'review' : choice === 'revise' ? 'revise' : 'accept');
    break;
  }
  case 'accept': {
    git('fetch', 'origin', state.lane);
    git('switch', '-C', state.lane, 'FETCH_HEAD');
    // 顺序任务只能快进；Git 的错误会说明分叉，流程停在这里交回主 Agent。
    git('merge', '--ff-only', state.executor.head);
    git('push', 'origin', `HEAD:refs/heads/${state.lane}`);
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
    const { choice, note = '' } = JSON.parse(env.DEVICE);
    const missing = choice === 'no' && !note.trim();
    state.feedback = missing ? '选择「不行」必须在备注中写验收意见。' : choice === 'no' ? `设备验收不通过：\n${note}` : '';
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
    writeFileSync(path, body());
    if (state.pr) gh('pr', 'edit', state.pr, '--body-file', path);
    else state.pr = gh('pr', 'create', '--base', state.base, '--head', state.lane, '--title', state.title, '--body-file', path);
    state.phase = 'check';
    save();
    output('checked', String(state.checks?.head === state.head));
    output('url', state.pr);
    output('head', state.head);
    output('summary', body());
    break;
  }
  case 'github-checks': {
    if (gh('pr', 'view', state.pr, '--json', 'statusCheckRollup', '--jq', '.statusCheckRollup | length') === '0') break;
    const result = spawnSync('gh', ['pr', 'checks', state.pr, '--watch'], { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
    break;
  }
  case 'delivery': {
    const { choice, note = '' } = JSON.parse(env.DELIVERY_RESULT);
    const missing = choice === 'revise' && !note.trim();
    state.feedback = missing ? '退回修改必须在备注中写具体意见。' : choice === 'revise' ? `所属需求退回修改：\n${note}` : '';
    save();
    output('feedback', state.feedback);
    output('route', missing ? 'delivery' : choice === 'revise' ? 'review' : 'premerge');
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
      output('commit', pr.mergeCommit.oid);
      break;
    }
    if (pr.state === 'CLOSED') throw new Error(`PR 已关闭但未合并：${state.pr}`);
    // 显式 --repo 让 gh 只删除远端分支，避免在分离 HEAD 中操作本地分支。
    const url = new URL(state.pr);
    const repo = `${url.host}/${url.pathname.split('/').slice(1, 3).join('/')}`;
    gh('pr', 'merge', state.pr, '--repo', repo, '--squash', '--match-head-commit', state.head, '--delete-branch');
    const commit = gh('pr', 'view', state.pr, '--json', 'mergeCommit', '--jq', '.mergeCommit.oid');
    output('commit', commit);
    break;
  }
  default: throw new Error(`未知开发步骤：${action}`);
}
