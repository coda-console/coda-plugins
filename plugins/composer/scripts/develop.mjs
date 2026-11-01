// 每一步的工作区都会回收；泳道进度和已通过的改动留在本次运行的产物里。
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const env = process.env, action = process.argv[2];
const statePath = join(env.CODA_ARTIFACTS, 'develop.json');
const output = (name, value) => {
  const end = randomUUID();
  appendFileSync(env.GITHUB_OUTPUT, `${name}<<${end}\n${value}\n${end}\n`);
};
const command = (bin, args) => {
  const result = spawnSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result.stdout.trim();
};
const git = (...args) => command('git', args);
const gh = (...args) => command('gh', args);
const instructions = `你是这次开发流程的执行者，自己完成这一项任务，不继承主 Agent 的协调职责，不再委派。
只做这一项，在当前分支提交，不推送、不开 PR、不合并、不部署。
遵守仓库的 AGENTS.md。只改必需的地方，不写防御性、冗余的代码，不顺手重构。
回报改了什么、为什么、实际跑了哪些验证及未验证部分。`;

if (action === 'lane') {
  const base = env.BASE || gh('repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name');
  git('fetch', 'origin', base);
  const head = git('rev-parse', 'FETCH_HEAD');
  const slug = env.TITLE.normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 50) || 'feature';
  const lane = `lane/${slug}-${env.GITHUB_RUN_ID}`;
  git('branch', lane, head);
  git('push', 'origin', `${lane}:refs/heads/${lane}`);
  writeFileSync(statePath, JSON.stringify({ title: env.TITLE, base, lane, head, task: env.TASK, approved: [], phase: 'preview', feedback: '', pr: '' }));
  process.exit(0);
}

const state = JSON.parse(readFileSync(statePath, 'utf8'));
const save = () => writeFileSync(statePath, JSON.stringify(state));
const body = () => state.approved.map(item => `## ${item.task}\n\n${item.answer}\n\n提交：${item.head}`).join('\n\n');

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
    save();
    break;
  }
  case 'review':
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
    if (git('rev-parse', 'HEAD') !== state.executor.head) throw new Error('执行者 head 已落后于泳道，不能快进到该提交。');
    git('push', 'origin', `HEAD:refs/heads/${state.lane}`);
    state.head = state.executor.head;
    if (state.approved.at(-1)?.head !== state.head) state.approved.push({ task: state.task, head: state.head, answer: state.executor.answer });
    const next = state.choice === 'next';
    if (next) { state.task = state.feedback; state.phase = 'preview'; }
    state.feedback = '';
    save();
    output('head', state.head);
    output('lane', state.lane);
    output('route', next ? 'execute' : state.phase === 'check' ? 'pr' : 'preview');
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
  case 'pr': {
    const path = join(env.RUNNER_TEMP, 'pr.md');
    writeFileSync(path, body());
    if (state.pr) gh('pr', 'edit', state.pr, '--body-file', path);
    else state.pr = gh('pr', 'create', '--base', state.base, '--head', state.lane, '--title', state.title, '--body-file', path);
    state.phase = 'check';
    save();
    output('url', state.pr);
    output('head', state.head);
    output('summary', body());
    break;
  }
  case 'check-failed':
    state.feedback = `${env.STEP}未通过，提交 ${state.head}。\n运行：coda://workflow-runs/${env.GITHUB_RUN_ID}\n请用 workflow_status 查看本运行「${env.STEP}」及其调用的失败流程，读取错误和日志，把具体修复意见写入「退回修改」的备注，继续最近的执行会话。通过后重跑检查。`;
    state.phase = 'check';
    save();
    break;
  case 'merge': {
    gh('pr', 'merge', state.pr, '--squash', '--match-head-commit', state.head);
    const merged = JSON.parse(gh('pr', 'view', state.pr, '--json', 'state,headRefOid,mergeCommit'));
    if (merged.state !== 'MERGED' || merged.headRefOid !== state.head) throw new Error('GitHub 尚未确认批准的 head 已合并；不能部署。');
    output('commit', merged.mergeCommit.oid);
    break;
  }
  default: throw new Error(`未知开发步骤：${action}`);
}
