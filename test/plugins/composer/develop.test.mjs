import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { readWorkflow } from '@coda-console/protocol/workflow';
import { evaluate } from 'feelin';

const script = fileURLToPath(new URL('../../../plugins/composer/scripts/develop.mjs', import.meta.url));
const workflow = readFileSync(new URL('../../../plugins/composer/.coda/workflows/develop.bpmn', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../../../plugins/composer/package.json', import.meta.url), 'utf8'));

function fixture(t, devices = true, delivery = '') {
  const root = mkdtempSync(join(tmpdir(), 'composer-develop-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const work = join(root, 'work'), origin = join(root, 'origin.git'), bin = join(root, 'bin'), artifacts = join(root, 'artifacts');
  for (const path of [work, bin, artifacts]) mkdirSync(path);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CODA_ARTIFACTS: artifacts, RUNNER_TEMP: root,
    GITHUB_RUN_ID: 'run-1', GITHUB_OUTPUT: join(root, 'outputs'), TITLE: '修好输入框', TASK: '第一项：修好输入框', BASE: '', DEVICES: String(devices), DELIVERY: delivery,
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'false', GIT_CONFIG_KEY_1: 'core.hooksPath', GIT_CONFIG_VALUE_1: '/dev/null',
    FIXTURE: root, EXECUTOR: JSON.stringify({ agent: 'codex' }) };
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: work, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  writeFileSync(join(work, 'base'), 'base');
  git('add', 'base'); git('commit', '-qm', 'base');
  git('init', '--bare', '-q', origin); git('remote', 'add', 'origin', origin); git('push', '-q', 'origin', 'main');
  const install = (name, body) => {
    const path = join(bin, name);
    writeFileSync(path, `#!${process.execPath}\n${body}`); chmodSync(path, 0o755);
  };
  install('coda-agent', String.raw`
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');
const args = process.argv.slice(2), root = process.env.FIXTURE;
const value = key => args[args.indexOf(key) + 1];
const task = JSON.parse(readFileSync(join(root, 'agent-task'), 'utf8'));
const calls = JSON.parse(readFileSync(join(root, 'agent-calls'), 'utf8'));
const prompt = readFileSync(value('--prompt-file'), 'utf8');
calls.push({ args, prompt }); writeFileSync(join(root, 'agent-calls'), JSON.stringify(calls));
if (task.exit) process.exit(task.exit);
const continued = args.includes('--continue');
const session = continued ? value('--continue') : 'worker-' + calls.length;
const branch = 'agent/' + session, cwd = join(root, session);
const git = (...params) => execFileSync('git', params, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
if (!continued) execFileSync('git', ['worktree', 'add', '-b', branch, cwd, value('--commit')], { stdio: 'pipe' });
if (task.mergeBase) {
  git('fetch', 'origin', task.mergeBase);
  const merged = require('node:child_process').spawnSync('git', ['merge', '--no-commit', 'FETCH_HEAD'], { cwd, encoding: 'utf8' });
  if (merged.status !== 1 || !merged.stdout.includes('CONFLICT')) throw new Error('expected conflict');
}
writeFileSync(join(cwd, task.file), task.answer);
git('add', task.file); git('commit', '-qm', task.answer);
console.log(JSON.stringify({ session, branch, head: git('rev-parse', 'HEAD'), answer: task.answer }));
`);
  install('gh', String.raw`
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2), root = process.env.FIXTURE;
const calls = JSON.parse(readFileSync(join(root, 'gh-calls'), 'utf8'));
const body = args.includes('--body-file') ? readFileSync(args[args.indexOf('--body-file') + 1], 'utf8') : null;
calls.push({ args, body }); writeFileSync(join(root, 'gh-calls'), JSON.stringify(calls));
if (args[0] === 'repo') console.log('main');
else if (args[1] === 'create') console.log('https://github.com/example/fixture/pull/1');
else if (args[1] === 'merge') {
  const { execFileSync } = require('node:child_process');
  if (!args.includes('--repo')) execFileSync('git', ['symbolic-ref', '--short', 'HEAD']);
  if (process.env.MERGE_EXIT) { process.stderr.write(process.env.MERGE_STDERR || ''); process.exit(Number(process.env.MERGE_EXIT)); }
  if (process.env.DELETE_REMOTE === 'true') {
    const state = JSON.parse(readFileSync(join(process.env.CODA_ARTIFACTS, 'develop.json'), 'utf8'));
    execFileSync('git', ['push', 'origin', '--delete', state.lane], { stdio: 'pipe' });
  }
}
else if (args[1] === 'view') {
  if (args.includes('headRefOid,statusCheckRollup')) {
    const state = JSON.parse(readFileSync(join(process.env.CODA_ARTIFACTS, 'develop.json'), 'utf8'));
    console.log(JSON.stringify({ headRefOid: process.env.PR_HEAD || state.head, statusCheckRollup: [{}] }));
    process.exit(Number(process.env.CHECKS_QUERY_EXIT || 0));
  }
  if (args.includes('state,headRefOid,mergeCommit') || args.includes('state,mergeable')) {
    const state = JSON.parse(readFileSync(join(process.env.CODA_ARTIFACTS, 'develop.json'), 'utf8'));
    console.log(JSON.stringify({ state: process.env.PR_STATE || 'OPEN', mergeable: process.env.PR_MERGEABLE || 'MERGEABLE', headRefOid: process.env.PR_HEAD || state.head, mergeCommit: { oid: 'f'.repeat(40) } }));
  } else console.log('f'.repeat(40));
}
else if (args[1] === 'checks') {
  process.stdout.write(process.env.CHECKS_STDOUT || 'checks passed\n');
  process.stderr.write(process.env.CHECKS_STDERR || '');
  process.exit(Number(process.env.CHECKS_EXIT || 0));
}
`);
  writeFileSync(join(root, 'agent-calls'), '[]'); writeFileSync(join(root, 'gh-calls'), '[]');
  const state = () => JSON.parse(readFileSync(join(artifacts, 'develop.json'), 'utf8'));
  const calls = name => JSON.parse(readFileSync(join(root, `${name}-calls`), 'utf8'));
  const task = (file, answer, exit, mergeBase) => writeFileSync(join(root, 'agent-task'), JSON.stringify({ file, answer, exit, mergeBase }));
  const run = (action, extra = {}, expected = 0) => {
    writeFileSync(env.GITHUB_OUTPUT, '');
    const result = spawnSync(process.execPath, [script, action], { cwd: work, env: { ...env, ...extra }, encoding: 'utf8' });
    assert.equal(result.status, expected, result.stderr);
    const outputs = Object.fromEntries([...readFileSync(env.GITHUB_OUTPUT, 'utf8').matchAll(/(\w+)<<([^\n]+)\n([\s\S]*?)\n\2\n/g)].map(([, key, , value]) => [key, value]));
    return { ...result, outputs };
  };
  const review = (choice, note = '') => run('decide', { REVIEW: JSON.stringify({ choice, note }) }).outputs.route;
  const device = (choice, note = '') => run('device', { DEVICE: JSON.stringify({ choice, note }) }).outputs.route;
  return { root, work, env, git, run, state, calls, task, review, device };
}

test('develop 从最新 base 开泳道，退回续作，逐项快进，验收后汇总同一个 PR', t => {
  const f = fixture(t);
  const oldHead = f.git('rev-parse', 'HEAD');
  writeFileSync(join(f.work, 'latest'), 'latest'); f.git('add', 'latest'); f.git('commit', '-qm', 'latest'); f.git('push', '-q', 'origin', 'main');
  const latest = f.git('rev-parse', 'HEAD'); f.git('switch', '--detach', oldHead);
  const task = '## 背景\n\n第一项：修好输入框\n\n## 验证\n\n- 检查输入';
  f.run('lane', { TASK: task });
  const lane = f.state().lane;
  assert.equal(lane, 'lane/run-1');
  assert.equal(f.state().head, latest);
  assert.equal(f.git('ls-remote', 'origin', lane).split('\t')[0], latest);
  f.task('one', 'first answer\nEOF_answer\n继续'); f.run('execute', { EXECUTOR: JSON.stringify({ agent: 'codex', model: 'cheap', effort: 'low', mode: 'auto', options: { 'fast-mode': true } }) });
  const first = f.state().executor;
  assert.equal(f.git('ls-remote', 'origin', lane).split('\t')[0], latest, '执行者不推送');
  const report = f.run('review').outputs;
  assert.equal(report.answer, first.answer); assert.equal(report.branch, first.branch); assert.equal(report.head, first.head);
  const call = f.calls('agent')[0];
  assert.deepEqual(call.args.slice(0, -2), ['--commit', latest, '--title', '修好输入框', '--agent', 'codex', '--model', 'cheap', '--effort', 'low', '--mode', 'auto',
    '--option', 'fast-mode=true', '--json']);
  for (const text of ['执行者', '不再委派', 'AGENTS.md', '不推送', '不写防御性、冗余', '不顺手重构', '只跑与改动直接相关的快检查', '实际跑了哪些验证', '第一项']) assert.ok(call.prompt.includes(text), text);
  assert.equal(f.run('decide', { REVIEW: JSON.stringify({ choice: 'revise' }) }).outputs.route, 'review');
  assert.equal(f.review('revise', '  '), 'review');
  assert.match(f.run('review').outputs.feedback, /必须/);
  assert.equal(f.review('revise', '删除多余封装'), 'revise');
  f.task('one', 'removed wrapper'); f.run('revise');
  assert.equal(f.state().executor.session, first.session);
  assert.deepEqual(f.calls('agent')[1].args.slice(0, -2), ['--continue', first.session, '--json']);
  assert.match(f.calls('agent')[1].prompt, /删除多余封装/);
  assert.equal(f.review('next', ''), 'review');
  assert.equal(f.review('next', '第二项：补齐状态'), 'accept');
  const accepted = f.run('accept').outputs;
  assert.equal(accepted.route, 'execute');
  assert.equal(f.git('ls-remote', 'origin', lane).split('\t')[0], accepted.head);
  f.task('two', 'second answer'); f.run('execute');
  assert.notEqual(f.state().executor.session, first.session);
  assert.equal(f.calls('agent')[2].args[1], accepted.head);
  assert.ok(!f.calls('agent')[2].args.includes('--model'), '空设置使用 Agent 默认值');
  assert.match(f.calls('agent')[2].prompt, /第二项：补齐状态/);
  for (const note of [undefined, '', '  ']) assert.equal(f.run('decide', { REVIEW: JSON.stringify({ choice: 'accept', note }) }).outputs.route, 'review');
  assert.equal(f.run('review').outputs.feedback, '通过，可以验收必须在备注中写给用户的改动汇报。');
  f.review('accept', '旧汇报'); assert.equal(f.run('accept').outputs.route, 'preview');
  const session = f.state().executor.session;
  for (const note of [undefined, '', '  ']) {
    const result = f.run('preview', { PREVIEW: JSON.stringify({ choice: 'review', note }) }).outputs;
    assert.equal(result.route, 'preview');
    assert.match(result.feedback, /回到审查必须在备注中写具体意见/);
  }
  const feedback = '先合入 origin/main 再安装';
  assert.equal(f.run('preview', { PREVIEW: JSON.stringify({ choice: 'review', note: feedback }) }).outputs.route, 'review');
  assert.equal(f.run('review').outputs.feedback, `安装预览版需处理：\n${feedback}`);
  assert.equal(f.review('revise', feedback), 'revise');
  f.task('two', 'base integrated'); f.run('revise');
  assert.equal(f.state().executor.session, session);
  assert.ok(f.calls('agent').at(-1).prompt.includes(feedback));
  f.review('accept', '汇报'); assert.equal(f.run('accept').outputs.route, 'preview');
  assert.deepEqual(f.run('preview', { PREVIEW: JSON.stringify({ choice: 'installed' }) }).outputs, { feedback: '', route: 'device' });
  assert.equal(f.state().feedback, '');
  assert.equal(f.run('device', { DEVICE: JSON.stringify({ choice: 'no' }) }).outputs.route, 'device');
  assert.equal(f.device('no'), 'device');
  // 只附截图也算附言，路径随意见交回主 Agent。
  assert.equal(f.run('device', { DEVICE: JSON.stringify({ choice: 'no', note: '', attachments: ['/uploads/a/shot.png'] }) }).outputs.route, 'review');
  assert.equal(f.run('review').outputs.feedback, '设备验收不通过：\n附件：\n- /uploads/a/shot.png');
  assert.equal(f.device('no', '按钮没有响应'), 'review');
  assert.equal(f.run('review').outputs.feedback, '设备验收不通过：\n按钮没有响应');
  f.review('revise', '修复按钮回调'); f.task('two', 'button fixed'); f.run('revise');
  const userReport = '做了什么\n- 输入框可以正常输入\n需要你知道：无';
  f.review('accept', userReport); assert.equal(f.run('accept').outputs.route, 'preview');
  assert.equal(f.device('yes'), 'pr');
  const summary = f.run('pr').outputs.summary;
  const created = f.calls('gh').find(c => c.args[1] === 'create');
  assert.deepEqual(created.args.slice(0, 6), ['pr', 'create', '--base', 'main', '--head', lane]);
  assert.equal(created.args[created.args.indexOf('--title') + 1], '修好输入框');
  const approved = f.state().approved;
  assert.equal(summary, `${userReport}\n\n改动：2 个文件 +2 -0\n- 根目录：2 个文件 +2 -0`, '汇报只用最新一份，改动按目标分支最新提交统计');
  assert.equal(created.body, `${summary}\n\n<details><summary>执行记录</summary>\n\n${[
    `## 第 1 项\n\n<details><summary>任务</summary>\n\n${task}\n\n</details>\n\nremoved wrapper\n\n提交：${approved[0].head}`,
    `## 第 2 项\n\n<details><summary>任务</summary>\n\n第二项：补齐状态\n\n</details>\n\nsecond answer\n\n提交：${approved[1].head}`,
    `## 第 3 项\n\n<details><summary>任务</summary>\n\n第二项：补齐状态\n\n</details>\n\nbase integrated\n\n提交：${approved[2].head}`,
    `## 第 4 项\n\n<details><summary>任务</summary>\n\n第二项：补齐状态\n\n</details>\n\nbutton fixed\n\n提交：${approved[3].head}`,
  ].join('\n\n')}\n\n</details>`, 'PR 描述以汇总开头，执行记录折叠在后');
  assert.ok(!created.body.includes('first answer'), '未通过的改动不放进执行记录');
  assert.ok(!summary.includes('removed wrapper'), '卡片汇总不含执行者回答');
  assert.equal(f.run('pr').outputs.summary, summary);
  assert.equal(f.calls('gh').filter(c => c.args[1] === 'create').length, 1);
  assert.equal(f.calls('gh').filter(c => c.args[1] === 'edit').length, 1);
  assert.equal(f.calls('gh').find(c => c.args[1] === 'edit').body, created.body);
});

test('用户开启时主 Agent 写的第一项任务：第一行是功能名，其后是任务，缺一样回到同一张卡', t => {
  const f = fixture(t);
  const brief = note => f.run('brief', { BRIEF: JSON.stringify({ choice: 'start', note }) }).outputs;
  assert.deepEqual(brief('修好输入框\n\n## 背景\n输入框没反应\n\n## 验收\n- 能输入'),
    { feedback: '', route: 'lane', title: '修好输入框', task: '## 背景\n输入框没反应\n\n## 验收\n- 能输入' });
  for (const note of ['只有功能名', '', '  \n  ']) {
    const written = brief(note);
    assert.equal(written.route, 'brief', note);
    assert.match(written.feedback, /第一行写功能名，空一行后写第一项任务/);
  }
  f.run('lane', { TITLE: '修好输入框', TASK: '第一项' });
  assert.equal(f.state().task, '第一项');
});

test('检查失败回最近执行会话，修好更新 PR 重跑；交由 gh 删除泳道，分支已删除仍交出合并提交', t => {
  const f = fixture(t); f.run('lane'); f.task('code', 'implementation'); f.run('execute');
  f.review('accept', '汇报'); f.run('accept'); f.device('yes'); f.run('pr');
  const session = f.state().executor.session;
  for (const step of ['项目检查', 'GitHub 检查', '合并前检查']) {
    f.run('check-failed', { STEP: step });
    const feedback = f.run('review').outputs.feedback;
    assert.ok(feedback.includes(step)); assert.ok(feedback.includes(f.state().head));
    assert.match(feedback, /workflow_status.*读取错误和日志/);
    f.review('revise', `${step}：修复断言`); f.task('code', step); f.run('revise');
    assert.equal(f.state().executor.session, session);
    f.review('accept', '汇报'); assert.equal(f.run('accept').outputs.route, 'pr');
    f.run('pr');
  }
  assert.equal(f.run('merge', { MERGE_EXIT: '1' }, 1).outputs.commit, undefined);
  assert.equal(f.git('ls-remote', 'origin', f.state().lane).split('\t')[0], f.state().head, '合并失败不删除泳道');
  f.git('push', 'origin', '--delete', f.state().lane);
  f.git('switch', '--detach');

  const merged = f.run('merge').outputs.commit;
  assert.equal(merged, 'f'.repeat(40)); assert.notEqual(merged, f.state().head);
  assert.deepEqual(f.calls('gh').find(c => c.args[1] === 'merge').args,
    ['pr', 'merge', f.state().pr, '--repo', 'github.com/example/fixture', '--squash', '--match-head-commit', f.state().head, '--delete-branch']);
  assert.deepEqual(f.calls('gh').find(c => c.args.includes('mergeCommit')).args,
    ['pr', 'view', f.state().pr, '--json', 'mergeCommit', '--jq', '.mergeCommit.oid']);
  assert.equal(f.git('ls-remote', 'origin', f.state().lane), '', '远端泳道已由 GitHub 自动删除');
});

for (const scenario of [
  { name: '分离 HEAD 正常合并并删除远端分支', state: 'OPEN', merge: true },
  { name: '远端已自动删除仍可合并', state: 'OPEN', merge: true, deleted: true },
  { name: '已合并且 head 一致可重复读取提交', state: 'MERGED', deleted: true },
  { name: '已合并但 head 不一致失败', state: 'MERGED', head: 'a'.repeat(40), error: /已合并，但 head 不一致/ },
  { name: '已关闭未合并失败', state: 'CLOSED', error: /已关闭但未合并/ },
  { name: '真实合并失败直接退出', state: 'OPEN', merge: true, exit: '7' },
]) test(scenario.name, t => {
  const f = fixture(t);
  f.run('lane'); f.run('pr');
  f.git('switch', '--detach');
  assert.equal(f.git('branch', '--show-current'), '');
  const branches = f.git('show-ref', '--heads');
  if (scenario.deleted) f.git('push', 'origin', '--delete', f.state().lane);
  const extra = { PR_MERGEABLE: scenario.error ? 'CONFLICTING' : 'MERGEABLE', PR_STATE: scenario.state, PR_HEAD: scenario.head || '', MERGE_EXIT: scenario.exit || '',
    DELETE_REMOTE: String(!scenario.deleted) };
  const result = f.run('merge', extra, scenario.error ? 1 : Number(scenario.exit || 0));
  assert.equal(result.outputs.commit, scenario.error || scenario.exit ? undefined : 'f'.repeat(40));
  if (scenario.error) assert.match(result.stderr, scenario.error);
  assert.equal(f.git('show-ref', '--heads'), branches, '不改动本地分支');
  assert.equal(f.git('branch', '--show-current'), '', '保持分离 HEAD');
  const merges = f.calls('gh').filter(c => c.args[1] === 'merge');
  assert.equal(merges.length, scenario.merge ? 1 : 0);
  if (scenario.merge) assert.deepEqual(merges[0].args,
    ['pr', 'merge', f.state().pr, '--repo', 'github.com/example/fixture', '--squash', '--match-head-commit', f.state().head, '--delete-branch']);
  if (!scenario.error && !scenario.exit) {
    assert.equal(f.git('ls-remote', 'origin', f.state().lane), '');
    assert.equal(f.run('merge', { PR_STATE: 'MERGED' }).outputs.commit, result.outputs.commit);
    assert.equal(f.calls('gh').filter(c => c.args[1] === 'merge').length, merges.length, '重跑不再合并');
  }
});

for (const scenario of [
  { name: '合并失败后确认冲突', mergeable: 'CONFLICTING', stderr: 'X Pull request is not mergeable', conflict: true },
  { name: 'not mergeable 但 UNKNOWN 仍失败', mergeable: 'UNKNOWN', stderr: 'X Pull request is not mergeable' },
  { name: 'not mergeable 但 MERGEABLE 仍失败', mergeable: 'MERGEABLE', stderr: 'X Pull request is not mergeable' },
  { name: '错误文案变化仍按冲突退回', mergeable: 'CONFLICTING', conflict: true, stderr: '合并冲突' },
  { name: '权限失败且无冲突仍失败', mergeable: 'MERGEABLE', stderr: 'HTTP 403: Forbidden' },
  { name: '网络失败且无冲突仍失败', mergeable: 'UNKNOWN', stderr: 'network unavailable' },
]) test(scenario.name, t => {
  const f = fixture(t); f.run('lane'); f.run('pr');
  const result = f.run('merge', { MERGE_EXIT: '7', MERGE_STDERR: scenario.stderr, PR_MERGEABLE: scenario.mergeable }, scenario.conflict ? 0 : 7);
  assert.equal(result.stderr, scenario.stderr);
  assert.deepEqual(result.outputs, scenario.conflict ? { route: 'conflict' } : {});
  assert.equal(Boolean(f.state().feedback), Boolean(scenario.conflict));
  const queries = f.calls('gh').filter(c => c.args.includes('state,mergeable'));
  assert.equal(queries.length, 1, '合并失败后只查一次冲突状态');
  const mergeIndex = f.calls('gh').findIndex(c => c.args[1] === 'merge');
  assert.equal(f.calls('gh')[mergeIndex + 1].args.at(-1), 'state,mergeable');
});

test('合并冲突带反馈回审查，原执行者合入 base 后重走检查、更新同一 PR 并重新批准', async t => {
  const f = fixture(t); f.run('lane'); f.task('base', 'worker change'); f.run('execute');
  f.run('gate'); f.run('gate-passed', { RUNS: '[]' });
  f.review('accept', '汇报'); f.run('accept'); f.run('pr');
  const before = f.state();
  f.run('approval', { APPROVAL: JSON.stringify({ choice: 'merge', options: { deploy: true, release: true }, note: '旧说明' }) });
  f.git('switch', 'main');
  writeFileSync(join(f.work, 'base'), 'target change'); f.git('add', 'base'); f.git('commit', '-qm', 'base advanced');
  f.git('push', 'origin', 'main');
  const baseHead = f.git('rev-parse', 'HEAD');
  assert.deepEqual(f.run('merge', { MERGE_EXIT: '1', PR_MERGEABLE: 'CONFLICTING' }).outputs, { route: 'conflict' });
  assert.equal(f.calls('gh').filter(c => c.args[1] === 'merge').length, 1);
  assert.equal(f.state().head, before.head);
  assert.equal(f.state().phase, 'check');
  const feedback = f.run('review').outputs.feedback;
  for (const text of ['合并冲突', '目标分支 main', '让执行者合并目标分支', '不计退回', '重新批准']) assert.ok(feedback.includes(text), text);
  assert.ok(!feedback.includes('用「退回修改」'), '不再让主 Agent 退回修改');
  assert.equal(f.review('sync'), 'revise');
  assert.equal(f.run('review').outputs.returns, '0');
  f.task('base', 'resolved change', undefined, 'main'); f.run('revise');
  assert.equal(f.state().executor.session, before.executor.session);
  for (const text of ['目标分支是 main', 'git fetch origin main', '合并（merge）', '不要变基', '数据库迁移等版本号', '顺延']) assert.ok(f.calls('agent').at(-1).prompt.includes(text), text);
  f.git('merge-base', '--is-ancestor', baseHead, f.state().executor.head);
  const head = f.run('gate').outputs.head;
  assert.notEqual(head, before.head);
  f.run('gate-passed', { RUNS: '[]' });
  f.review('accept', '修复后的汇报'); assert.equal(f.run('accept').outputs.route, 'pr');
  assert.equal(f.run('pr').outputs.checked, 'true');
  assert.equal(f.state().pr, before.pr);
  assert.equal(f.calls('gh').filter(c => c.args[1] === 'create').length, 1);
  assert.equal(f.calls('gh').filter(c => c.args[1] === 'edit').length, 1);
  f.run('github-checks');
  assert.equal(f.run('approval', { APPROVAL: JSON.stringify({ choice: 'merge', options: {} }) }).outputs.route, 'merge', '新批准不沿用旧发布选项或要求发布说明');
  assert.equal(f.run('merge').outputs.commit, 'f'.repeat(40));
  const merged = f.calls('gh').filter(c => c.args[1] === 'merge').at(-1);
  assert.equal(merged.args[merged.args.indexOf('--match-head-commit') + 1], head);
  const { root, problem } = await readWorkflow(workflow, 'develop'); assert.ok(!problem, problem);
  const nodes = Object.fromEntries(root.rootElements.find(e => e.$type === 'bpmn:Process').flowElements.map(e => [e.id, e]));
  for (const [id, option] of [['merged-deploy', 'deploy'], ['to-publish-preview', 'preview'], ['to-publish-release', 'release']]) {
    const expression = nodes[id].conditionExpression.body.slice(1);
    const context = { approve: { options: { [option]: true } } };
    assert.equal(evaluate(expression, context).value, true);
    context.approve = { options: { [option]: false } };
    assert.equal(evaluate(expression, context).value, false, '新批准卡取消选项后不部署或发布');
  }
});

test('泳道不接受分叉，Agent 非零退出不进入审查', t => {
  const f = fixture(t); f.run('lane');
  for (const code of [1, 2, 130]) { f.task('code', '', code); f.run('execute', {}, code); assert.equal(f.state().executor, undefined); }
  f.task('code', 'worker change'); f.run('execute'); f.review('accept', '汇报');
  f.git('switch', f.state().lane);
  writeFileSync(join(f.work, 'other'), 'other'); f.git('add', 'other'); f.git('commit', '-qm', 'other change');
  f.git('push', '-q', 'origin', f.state().lane);
  const remote = f.git('rev-parse', 'HEAD');
  assert.match(f.run('accept', {}, 128).stderr, /fast-forward/);
  assert.equal(f.git('ls-remote', 'origin', f.state().lane).split('\t')[0], remote);
  assert.equal(f.state().approved.length, 0);
});

test('显式 base 与并行功能运行各自建泳道，无设备验收仍可派下一项并直接开 PR', t => {
  const f = fixture(t, false); f.git('branch', 'release'); f.git('push', '-q', 'origin', 'release');
  f.run('lane', { BASE: 'release' }); const one = f.state();
  f.run('lane', { BASE: 'release', GITHUB_RUN_ID: 'run-2' }); const two = f.state();
  assert.equal(one.base, 'release'); assert.equal(two.base, 'release'); assert.notEqual(one.lane, two.lane);
  assert.equal(f.calls('gh').length, 0, '有 base 不查默认分支');
  f.task('one', 'first change'); f.run('execute');
  f.review('next', '第二项'); assert.equal(f.run('accept').outputs.route, 'execute');
  f.task('two', 'second change'); f.run('execute');
  f.review('accept', '汇报'); assert.equal(f.run('accept').outputs.route, 'pr');
  assert.equal(f.run('pr').outputs.url, 'https://github.com/example/fixture/pull/1');
  assert.equal(f.state().phase, 'check');
});

test('归属需求跳过设备验收，待交付退回续作，更新同一 PR 后放行合并', t => {
  const f = fixture(t, true, 'requirement-1');
  f.run('lane'); f.task('one', 'first change'); f.run('execute');
  f.review('next', '第二项'); assert.equal(f.run('accept').outputs.route, 'execute');
  f.task('two', 'second change'); f.run('execute');
  f.review('accept', '汇报'); assert.equal(f.run('accept').outputs.route, 'pr');
  const pr = f.run('pr').outputs;
  assert.match(pr.summary, /^汇报\n\n改动：2 个文件/);
  const created = f.calls('gh').find(c => c.args[1] === 'create').body;
  assert.match(created, /<details><summary>执行记录<\/summary>[\s\S]*first change[\s\S]*second change/);
  f.run('github-checks');
  const session = f.state().executor.session;
  const delivery = (choice, note) => f.run('delivery', { DELIVERY_RESULT: JSON.stringify({ choice, note }) }).outputs;
  for (const note of [undefined, '', '  ']) {
    assert.deepEqual(delivery('revise', note), { feedback: '退回修改必须在备注中写具体意见。', route: 'delivery' });
  }
  assert.equal(delivery('revise', '需求验收：按钮没有响应').route, 'review');
  const feedback = f.run('review').outputs.feedback;
  assert.equal(feedback, '所属需求退回修改：\n需求验收：按钮没有响应');
  f.review('revise', feedback); f.task('two', 'button fixed'); f.run('revise');
  assert.equal(f.state().executor.session, session);
  assert.ok(f.calls('agent').at(-1).prompt.includes(feedback));
  f.review('accept', '汇报'); assert.equal(f.run('accept').outputs.route, 'pr');
  const updated = f.run('pr').outputs;
  assert.equal(updated.url, pr.url); assert.notEqual(updated.head, pr.head);
  assert.match(f.calls('gh').find(c => c.args[1] === 'edit').body, /button fixed/);
  assert.equal(f.calls('gh').filter(c => c.args[1] === 'create').length, 1);
  assert.equal(f.calls('gh').filter(c => c.args[1] === 'edit').length, 1);
  f.run('github-checks');
  assert.deepEqual(delivery('merge'), { feedback: '', route: 'merge' });
  assert.equal(f.run('merge').outputs.commit, 'f'.repeat(40));
});

test('PR 汇总按 .coda/areas.json 最长前缀归区域，未声明走顶层目录，改名按新路径，二进制只计文件', t => {
  const f = fixture(t, false);
  const write = (path, text) => { mkdirSync(join(f.work, path, '..'), { recursive: true }); writeFileSync(join(f.work, path), text); };
  const lines = n => 'line\n'.repeat(n);
  write('old/Big.swift', 'big\nbody\n'); f.git('add', '-A'); f.git('commit', '-qm', 'big'); f.git('push', '-q', 'origin', 'main');
  f.run('lane');
  f.git('switch', '-q', f.state().lane);
  write('.coda/areas.json', '{ "iPhone 客户端": ["iOS/"], "共享": ["iOS/Shared/", "AGENTS.md"] }\n');
  write('iOS/App.swift', lines(5)); write('iOS/Shared/Model.swift', lines(6)); write('AGENTS.md', lines(1));
  write('Sources/Core.swift', lines(8)); write('notes.txt', lines(2)); write('img.png', Buffer.from([0, 1, 2, 0]));
  f.git('mv', 'old/Big.swift', 'iOS/Big.swift'); f.git('rm', '-q', 'base');
  const summary = () => {
    f.git('add', '-A'); f.git('commit', '-qm', 'change'); f.git('push', '-q', 'origin', f.state().lane);
    writeFileSync(join(f.root, 'artifacts', 'develop.json'), JSON.stringify({ ...f.state(), head: f.git('rev-parse', 'HEAD'), report: '汇报' }));
    return f.run('pr').outputs.summary;
  };
  assert.equal(summary(), ['汇报', '', '改动：9 个文件 +23 -1',
    '- Sources：1 个文件 +8 -0', '- 共享：2 个文件 +7 -0', '- iPhone 客户端：2 个文件 +5 -0', '- 根目录：3 个文件 +2 -1', '- .coda：1 个文件 +1 -0'].join('\n'));
  f.git('rm', '-q', '.coda/areas.json');
  assert.equal(summary(), ['汇报', '', '改动：8 个文件 +22 -1',
    '- iOS：3 个文件 +11 -0', '- Sources：1 个文件 +8 -0', '- 根目录：4 个文件 +3 -1'].join('\n'));
  write('.coda/areas.json', '{ "iOS": ');
  f.git('add', '-A'); f.git('commit', '-qm', 'broken'); f.git('push', '-q', 'origin', f.state().lane);
  writeFileSync(join(f.root, 'artifacts', 'develop.json'), JSON.stringify({ ...f.state(), head: f.git('rev-parse', 'HEAD') }));
  assert.match(f.run('pr', {}, 1).stderr, /JSON/);
});

test('GitHub 检查等待全部完成，无检查通过，检查失败和查询错误保持失败并留下日志', t => {
  const f = fixture(t, false);
  f.run('lane'); f.task('code', 'implementation'); f.run('execute');
  f.review('accept', '汇报'); f.run('accept'); f.run('pr');
  assert.match(f.run('github-checks').stdout, /checks passed/);
  const query = ['pr', 'view', f.state().pr, '--json', 'headRefOid,statusCheckRollup'];
  assert.deepEqual(f.calls('gh').at(-3).args, query);
  assert.deepEqual(f.calls('gh').at(-2).args, ['pr', 'checks', f.state().pr, '--watch']);
  assert.deepEqual(f.calls('gh').at(-1).args, query);
  f.run('github-checks', { CHECKS_QUERY_EXIT: '1' }, 1);
  assert.deepEqual(f.calls('gh').at(-1).args, query);
  assert.match(f.run('github-checks', { PR_HEAD: 'stale' }, 1).stderr, /PR head 不一致/);
  for (const [code, stdout, stderr] of [
    [1, 'build\tfail\n', ''],
    [1, '', 'HTTP 403: Forbidden\n'],
    [8, 'build\tpending\n', ''],
  ]) {
    const result = f.run('github-checks', { CHECKS_EXIT: String(code), CHECKS_STDOUT: stdout, CHECKS_STDERR: stderr }, code);
    assert.ok(result.stdout.includes(stdout)); assert.equal(result.stderr, stderr);
  }
});

test('开发流程定义、回路、检查提交与部署发布选择符合运行契约', async () => {
  const { root, problem } = await readWorkflow(workflow, 'develop'); assert.ok(!problem, problem);
  const process = root.rootElements.find(e => e.$type === 'bpmn:Process');
  const acceptance = process.flowElements.find(e => e.id === 'acceptance');
  // 卡片上只在走进验收后才有这一段，没开设备验收的运行照常按步骤画进度。
  assert.equal(acceptance.optional, true);
  const elements = [...process.flowElements, ...acceptance.flowElements];
  const nodes = Object.fromEntries(elements.map(e => [e.id, e]));
  const values = node => node.extensionElements?.values ?? [];
  const params = id => Object.fromEntries(values(nodes[id]).map(v => [v.name, v.value]));
  const route = (id, context) => {
    const node = nodes[id];
    const flows = elements.filter(e => e.sourceRef === node);
    return (flows.find(e => e.conditionExpression && evaluate(e.conditionExpression.body.trim().slice(1), context).value) ?? node.default).targetRef.id;
  };
  assert.equal(process.name, '监督开发'); assert.equal(process.kind, 'develop'); assert.equal(process.concurrency, undefined);
  // 用户在会话里开启时什么都不必填：功能名与第一项任务由主 Agent 写，执行者取发起会话的。
  assert.deepEqual(values(process).filter(v => v.required).map(v => v.name), []);
  for (const name of ['title', 'task']) assert.equal(values(process).find(v => v.name === name).default, '');
  const executor = values(process).find(v => v.name === 'executor');
  assert.deepEqual([executor.type, executor.defaultFrom, executor.label], ['agent', 'session.agent', '执行者']);
  assert.ok(!values(process).some(v => ['agent', 'model', 'effort', 'mode'].includes(v.name)), '执行者是一个 Agent 选择');
  const devices = values(process).find(v => v.name === 'devices');
  assert.equal(devices.type, 'boolean'); assert.equal(devices.default, 'false');
  assert.equal(devices.label, '设备验收');
  assert.equal(devices.description, '改了客户端、要在 Mac 或 iPhone 上验收时打开');
  assert.equal(params('accept').DEVICES, '=inputs.devices');
  const delivery = values(process).find(v => v.name === 'delivery');
  assert.equal(delivery.type, 'string'); assert.equal(delivery.default, '');
  assert.equal(delivery.label, '所属需求');
  assert.equal(delivery.description, '需求运行的 ID；留空为独立交付');
  assert.equal(params('accept').DELIVERY, '=inputs.delivery');
  assert.equal(nodes.start.eventDefinitions, undefined, '不订阅旧 PR 生命周期');
  assert.ok(manifest.files.includes('.coda/workflows')); assert.ok(manifest.files.includes('scripts'));
  assert.doesNotMatch(workflow, /review\/scripts|vars\.review/);
  assert.match(nodes.review.documentation[0].text, /git diff \{\{report.lane\}\}\.\.\.\{\{report.head\}\}/);
  assert.equal(nodes.review.assignee, undefined, '默认交给发起会话 Agent');
  assert.equal(nodes.device.assignee, 'user'); assert.equal(nodes.approve.assignee, 'user');
  for (const [value, target] of [['review', 'report'], ['revise', 'revise'], ['swap', 'swap'], ['accept', 'accept']]) assert.equal(route('how', { decide: { route: value } }), target);
  for (const [value, target] of [['execute', 'execute'], ['pr', 'pr'], ['preview', 'acceptance'], ['sync', 'revise']]) assert.equal(route('after-accept', { accept: { route: value } }), target);
  assert.equal(route('how', { decide: { route: 'revise' } }), 'revise', '「让执行者合并目标分支」与退回修改走同一个会话续作');
  assert.deepEqual(values(nodes.preview).map(v => [v.id, v.name]), [['installed', '已装好'], ['review', '回到审查']]);
  assert.match(nodes.preview.documentation[0].text, /preview-result.feedback/);
  assert.equal(nodes['preview-result-flow'].targetRef.id, 'preview-result');
  assert.equal(params('preview-result').PREVIEW, '=preview');
  assert.match(nodes['preview-result'].script, /develop\.mjs" preview/);
  for (const [value, target] of [['preview', 'preview'], ['review', 'acceptance-return'], ['device', 'device']]) assert.equal(route('after-preview', { 'preview-result': { route: value } }), target);
  assert.equal(nodes['pr-check'].targetRef.id, 'reuse-checks');
  assert.doesNotMatch(workflow, /无客户端改动，跳过|没有客户端改动时确认/);
  for (const [value, target] of [['device', 'device'], ['review', 'acceptance-return'], ['pr', 'acceptance-passed']]) assert.equal(route('after-device', { 'device-result': { route: value } }), target);
  assert.match(nodes.review.documentation[0].text, /\{\{report.feedback\}\}/, '验收失败的备注随审查任务交回');
  assert.deepEqual(process.flowElements.filter(e => e.action === 'tell-session').map(e => e.id), ['tell-device']);
  assert.equal(params('tell-device').session, undefined, '通知运行所属会话');
  assert.equal(nodes['told-device-pr'].sourceRef.id, 'tell-device');
  assert.equal(nodes['told-device-pr'].targetRef.id, 'pr');
  assert.equal(nodes['merge-route'].targetRef.id, 'after-merge');
  assert.equal(route('after-merge', { merge: { route: 'conflict' } }), 'report');
  assert.equal(route('after-merge', { merge: { route: 'merged', commit: 'merged' } }), 'deploy-choice');
  assert.equal(nodes['merge-feedback'], undefined);
  assert.equal(nodes['kinds-approve'].targetRef.id, 'approve', '新一轮必须重新进入用户批准任务');
  assert.equal(nodes['approve-route'].sourceRef.id, 'approve');
  assert.equal(nodes['approve-route'].targetRef.id, 'approval-result');
  const context = { lane: { title: '修好输入框' }, run: { id: 'run-1' }, accept: { head: 'head-1' }, pr: { head: 'head-1' } };
  const message = (id, field, extra = {}) => evaluate(params(id)[field].slice(1), { ...context, ...extra }).value;
  assert.equal(message('tell-device', 'text'), '功能「修好输入框」：用户设备验收通过，接下来开 PR、跑检查。');
  assert.equal(message('tell-device', 'key'), 'run-1:device:head-1');
  for (const stop of [false, true]) assert.equal(route('after-approval', { approve: { chose: { stop } } }), stop ? 'stopped' : 'merge');
  assert.equal(nodes.stopped.notify, undefined);
  for (const context of [
    { inputs: { delivery: '' }, approve: { options: { notify: true } } },
    { inputs: { delivery: '' }, approve: { options: { notify: false } } },
    { inputs: { delivery: 'requirement-1' } },
  ]) {
    const result = evaluate(nodes.done.notify.slice(1), context);
    assert.equal(result.warnings.length, 0, JSON.stringify(result.warnings));
    assert.equal(result.value, context.inputs.delivery ? true : context.approve.options.notify);
  }
  for (const [failed, target] of [['checks-failed', 'checks'], ['github-checks-failed', 'github-checks'], ['premerge-failed', 'premerge']]) {
    assert.equal(nodes[failed].attachedToRef.id, target);
    assert.equal(nodes[failed].eventDefinitions[0].$type, 'bpmn:ErrorEventDefinition');
  }
  assert.deepEqual(params('checks'), { kind: 'check', commit: '=gate.head' });
  assert.equal(nodes['checks-github'].targetRef.id, 'gate-passed');
  // 推出的提交在审查的同时预编：只在随后会进设备验收时，不挡审查，失败也不算数。
  assert.deepEqual(elements.filter(e => e.sourceRef === nodes['gate-fork']).map(e => e.targetRef.id), ['checks', 'prebuild-choice']);
  for (const [devices, delivery, target] of [[true, '', 'prebuild'], [false, '', 'prebuilt'], [true, 'requirement-1', 'prebuilt']]) {
    assert.equal(route('prebuild-choice', { inputs: { devices, delivery } }), target);
  }
  assert.deepEqual({ ...params('prebuild'), inputs: undefined }, { kind: 'prebuild', commit: '=gate.head', inputs: undefined });
  for (const device of ['', 'duo-testbed']) {
    assert.deepEqual(evaluate(params('prebuild').inputs.slice(1), { inputs: { device } }).value, device ? { device } : {});
  }
  assert.equal(nodes['prebuild-failed'].attachedToRef.id, 'prebuild');
  assert.equal(nodes['prebuild-failed'].eventDefinitions[0].$type, 'bpmn:ErrorEventDefinition');
  for (const id of ['prebuild-done', 'prebuild-failed-done', 'prebuild-skip']) assert.equal(nodes[id].targetRef.id, 'prebuilt');
  assert.match(nodes['github-checks'].script, /develop\.mjs" github-checks/);
  assert.equal(nodes['github-checks'].timeout, 60);
  assert.equal(nodes['github-checks-feedback'].targetRef.id, 'github-feedback');
  assert.deepEqual(params('github-feedback'), { STEP: 'GitHub 检查' });
  assert.equal(nodes['github-review'].targetRef.id, 'report');
  assert.equal(nodes['github-delivery-choice'].targetRef.id, 'delivery-choice');
  assert.equal(route('delivery-choice', { inputs: { delivery: '' } }), 'kinds');
  assert.equal(route('delivery-choice', { inputs: { delivery: 'requirement-1' } }), 'delivery');
  assert.equal(nodes.delivery.name, '待交付');
  assert.equal(nodes.delivery.assignee, undefined, '待交付交给发起会话 Agent');
  assert.deepEqual(values(nodes.delivery).map(v => [v.id, v.name]), [['revise', '退回修改'], ['merge', '放行合并']]);
  for (const field of ['inputs.delivery', 'pr.url', 'pr.head', 'accept.lane', 'pr.summary']) assert.ok(nodes.delivery.documentation[0].text.includes(`{{${field}}}`));
  assert.match(nodes.delivery.documentation[0].text, /delivery-result.feedback/);
  assert.equal(nodes['delivery-result-flow'].targetRef.id, 'delivery-result');
  assert.equal(params('delivery-result').DELIVERY_RESULT, '=delivery');
  for (const [value, target] of [['delivery', 'delivery'], ['review', 'report'], ['merge', 'merge']]) assert.equal(route('after-delivery', { 'delivery-result': { route: value } }), target);
  assert.deepEqual(params('premerge'), { kind: 'premerge', commit: '=pr.head' });
  assert.deepEqual(params('deploy'), { kind: 'deploy', commit: '=merge.commit' });
  assert.equal(nodes['approval-merge'].targetRef.id, 'merge');
  // 合并前检查在 PR head 上跑完才进 GitHub 检查与批准卡，批准后直接合并。
  assert.equal(route('reuse-checks', { pr: { checked: true } }), 'premerge');
  assert.equal(nodes['premerge-github'].targetRef.id, 'github-checks');
  assert.equal(nodes['premerge-review'].targetRef.id, 'report');
  assert.equal(route('after-approval', { approve: { chose: { stop: true } } }), 'stopped');
  assert.equal(route('deploy-choice', { inputs: { delivery: 'requirement-1' } }), 'done');
  for (const delivery of ['', 'requirement-1']) for (const deploy of [false, true]) for (const preview of [false, true]) for (const release of [false, true]) {
    const options = { deploy, preview, release }, called = [];
    const context = { inputs: { delivery }, approve: { options } };
    let step = 'deploy-choice';
    while (step !== 'done') {
      const node = nodes[step];
      if (node.action === 'run-workflows') called.push(params(step).kind);
      step = node.$type === 'bpmn:ExclusiveGateway' ? route(step, context) : process.flowElements.find(e => e.sourceRef === node).targetRef.id;
    }
    assert.deepEqual(called, delivery ? [] : ['deploy', 'preview', 'release'].filter(kind => options[kind]));
  }
  assert.deepEqual(params('publish-preview'), { kind: 'preview', commit: '=merge.commit', inputs: '={ notes: if approval-result.route = "notes" then notes-result.notes else approve.note }' });
  assert.deepEqual(params('publish-release'), { kind: 'release', commit: '=merge.commit', inputs: '={ publish: "true", notes: if approval-result.route = "notes" then notes-result.notes else approve.note }' });
  assert.deepEqual(evaluate(params('publish-release').inputs.slice(1), { 'approval-result': { route: 'merge' }, approve: { note: '更新说明' } }).value, { publish: 'true', notes: '更新说明' });
  assert.deepEqual(process.flowElements.filter(e => e.action === 'run-workflows').map(e => e.id), ['prebuild', 'checks', 'premerge', 'deploy', 'publish-preview', 'publish-release']);
  const options = values(nodes.approve)[0].options;
  assert.deepEqual(options.map(option => [option.id, option.name]), [['deploy', '部署'], ['preview', '发布预览版'], ['release', '发布正式版'], ['notify', '全部完成后通知 Agent']]);
  const notify = options.find(option => option.id === 'notify');
  assert.equal(notify.default, 'true');
  assert.equal(notify.shown, undefined);
  for (const option of options.filter(option => option.id !== 'notify')) {
    assert.equal(option.default, undefined);
    for (const deploy of [false, true]) for (const preview of [false, true]) for (const release of [false, true]) {
      const kinds = { deploy, preview, release };
      assert.equal(evaluate(option.shown.slice(1), { kinds }).value, kinds[option.id]);
    }
  }
  const executorEnv = params('execute').EXECUTOR;
  const session = { agent: 'codex', model: 'gpt-6', effort: 'high' };
  assert.deepEqual(evaluate(executorEnv.slice(1), { inputs: { executor: null }, github: { event: { coda: { session } } } }).value, session, '取不到会话的（跨目录）用发起会话的');
  assert.deepEqual(evaluate(executorEnv.slice(1), { inputs: { executor: { agent: 'kimi' } } }).value, { agent: 'kimi' });
  // 没有第一项任务时，先交主 Agent 写；不叫醒它，随会话的下一条输入告诉它。
  assert.equal(route('brief-choice', { inputs: { task: '' } }), 'brief');
  assert.equal(route('brief-choice', { inputs: { task: '第一项' } }), 'lane');
  assert.deepEqual([nodes.brief.wake, nodes.brief.assignee], ['false', undefined]);
  assert.deepEqual(values(nodes.brief).map(v => [v.id, v.note]), [['start', 'required']]);
  for (const [value, target] of [['brief', 'brief'], ['lane', 'lane']]) assert.equal(route('after-brief', { 'brief-result': { route: value } }), target);
  for (const [field, given, written] of [['TITLE', 'title', 'title'], ['TASK', 'task', 'task']]) {
    const expression = params('lane')[field].slice(1);
    assert.equal(evaluate(expression, { inputs: { task: '', title: '' }, 'brief-result': { [written]: '写的' } }).value, '写的');
    assert.equal(evaluate(expression, { inputs: { task: '给的', title: '给的' } }).value, '给的', given);
  }
  for (const [title, expected] of [['', '监督开发'], ['修好输入框', '开发：修好输入框']]) {
    assert.equal(evaluate(process.title.slice(2, -2), { inputs: { title } }).value, expected);
  }
  // 用户拒绝验收或暂不合并时必须附言：写意见或附截图。
  assert.deepEqual(values(nodes.device).map(v => [v.id, v.note]), [['yes', undefined], ['no', 'required']]);
  assert.deepEqual(values(nodes.approve).map(v => [v.id, v.note]), [['merge', undefined], ['stop', 'required']]);
});

test('审查前检查失败自动续作同一会话，连续三次升级，成功记录提交和运行供 PR 复用', t => {
  const f = fixture(t, false); f.run('lane'); f.task('code', 'first'); f.run('execute');
  const session = f.state().executor.session;
  for (let i = 1; i <= 3; i++) {
    assert.equal(f.run('gate').outputs.head, f.state().executor.head);
    assert.equal(f.run('gate-failed').outputs.route, i === 3 ? 'review' : 'revise');
    assert.equal(f.state().failures.length, i);
    if (i < 3) {
      f.task('code', `fix ${i}`); f.run('revise');
      assert.equal(f.state().executor.session, session);
      assert.match(f.calls('agent').at(-1).prompt, /项目检查未通过.*提交/);
      assert.match(f.calls('agent').at(-1).prompt, /workflow_status/);
    }
  }
  assert.equal(f.run('review').outputs.feedback.split('项目检查未通过').length - 1, 3);
  const runs = [{ workflow: 'test', state: 'succeeded', runId: 'check-1' }];
  f.run('gate-passed', { RUNS: JSON.stringify(runs) });
  assert.equal(f.state().failures.length, 0);
  assert.match(f.run('review').outputs.checks, /test: succeeded coda:\/\/workflow-runs\/check-1/);
  f.review('accept', '汇报'); f.run('accept');
  assert.equal(f.run('pr').outputs.checked, 'true');
  f.task('code', 'new change'); f.run('revise');
  f.review('accept', '汇报'); f.run('accept');
  assert.equal(f.run('pr').outputs.checked, 'false', '新提交不能复用旧结果');
});

test('发布说明为空交主 Agent 编写，非发布选择不要求说明', t => {
  const f = fixture(t); f.run('lane');
  for (const preview of [false, true]) for (const release of [false, true]) for (const note of ['', '  ', '修复输入问题']) {
    const { outputs } = f.run('approval', { APPROVAL: JSON.stringify({ choice: 'merge', options: { preview, release }, note }) });
    const missing = (preview || release) && !note.trim();
    assert.equal(outputs.route, missing ? 'notes' : 'merge');
  }
  assert.equal(f.run('approval', { APPROVAL: JSON.stringify({ choice: 'stop', options: { release: true } }) }).outputs.route, 'stop');
});

test('流程在执行及续作后先检查，失败分流，PR 同提交绕过检查，发布传用户说明', async () => {
  const { root, problem } = await readWorkflow(workflow, 'develop'); assert.ok(!problem, problem);
  const process = root.rootElements.find(e => e.$type === 'bpmn:Process');
  const nodes = Object.fromEntries(process.flowElements.map(e => [e.id, e]));
  for (const id of ['execute-report', 'revise-report']) assert.equal(nodes[id].targetRef.id, 'gate');
  assert.equal(nodes['checks-review'].targetRef.id, 'gate-route');
  assert.equal(nodes['gate-revise'].targetRef.id, 'revise');
  assert.equal(nodes['gate-escalate'].targetRef.id, 'report');
  assert.equal(nodes['reuse-passed'].targetRef.id, 'premerge');
  for (const checked of [true, false]) assert.equal(evaluate(nodes['reuse-passed'].conditionExpression.body.slice(1), { pr: { checked } }).value, checked);
  for (const id of ['publish-preview', 'publish-release']) {
    const input = nodes[id].extensionElements.values.find(v => v.name === 'inputs');
    assert.equal(evaluate(input.value.slice(1), { 'approval-result': { route: 'merge' }, approve: { note: '用户修改后的发布说明' } }).value.notes, '用户修改后的发布说明');
  }
});


test('发布说明由主 Agent 补写或直接使用用户备注，空说明不放行', async t => {
  const f = fixture(t); f.run('lane');
  const { root, problem } = await readWorkflow(workflow, 'develop'); assert.ok(!problem, problem);
  const process = root.rootElements.find(e => e.$type === 'bpmn:Process');
  const nodes = Object.fromEntries(process.flowElements.map(e => [e.id, e]));
  assert.equal(nodes['write-notes'].assignee, undefined, '交发起会话主 Agent');
  assert.equal(nodes['write-notes'].name, '写发布说明');
  assert.equal(nodes['approval-missing'].targetRef.id, 'write-notes');
  assert.equal(nodes['notes-missing'].targetRef.id, 'write-notes');
  assert.equal(nodes['notes-ready'].targetRef.id, 'merge');
  assert.equal(nodes['notes-result'].extensionElements.values.find(v => v.name === 'NOTES').value, '=write-notes');
  for (const text of ['approve.options.preview', 'approve.options.release', '上次公开版本以来合并的改动', '面向用户', '备注必填']) assert.ok(nodes['write-notes'].documentation[0].text.includes(text));
  assert.doesNotMatch(workflow, /\{\{review\.note\}\}/);
  for (const note of [undefined, '', '  ']) {
    const result = f.run('notes', { NOTES: JSON.stringify({ note }) }).outputs;
    assert.equal(result.route, 'notes');
    assert.ok(result.feedback);
    assert.equal(evaluate(nodes['notes-missing'].conditionExpression.body.slice(1), { 'notes-result': result }).value, true);
  }
  for (const preview of [false, true]) for (const release of [false, true]) {
    if (!preview && !release) continue;
    for (const note of ['', '用户自己的说明']) {
      const approve = { choice: 'merge', options: { preview, release }, note };
      const approval = f.run('approval', { APPROVAL: JSON.stringify(approve) }).outputs;
      assert.equal(evaluate(nodes['approval-missing'].conditionExpression.body.slice(1), { 'approval-result': approval }).value, !note);
      const notes = f.run('notes', { NOTES: JSON.stringify({ note: '主 Agent 的发布说明' }) }).outputs;
      assert.equal(notes.route, 'ready');
      for (const id of ['publish-preview', 'publish-release']) {
        const input = nodes[id].extensionElements.values.find(v => v.name === 'inputs');
        const result = evaluate(input.value.slice(1), { approve, 'approval-result': approval, 'notes-result': notes });
        assert.equal(result.warnings.length, 0);
        assert.equal(result.value.notes, note || '主 Agent 的发布说明');
      }
    }
  }
});


test('gate 推送后才输出检查 head，重试更新同一分支，通过后清理且不污染泳道', t => {
  const f = fixture(t); f.run('lane'); f.task('code', 'first'); f.run('execute');
  const laneHead = f.state().head;
  const ref = 'refs/heads/composer-check/run-1';
  assert.equal(f.git('ls-remote', 'origin', ref), '');
  for (const answer of ['second', 'third']) {
    f.task('code', answer); f.run('revise');
    const head = f.run('gate').outputs.head;
    assert.equal(f.git('ls-remote', 'origin', ref).split('\t')[0], head);
    assert.equal(f.git('ls-remote', 'origin', f.state().lane).split('\t')[0], laneHead);
  }
  f.review('accept', '汇报'); f.run('accept');
  assert.equal(f.git('ls-remote', 'origin', ref), '');
  assert.equal(f.git('ls-remote', 'origin', f.state().lane).split('\t')[0], f.state().executor.head);
});

test('gate 推送失败保留 Git 原因且不输出 head', t => {
  const f = fixture(t); f.run('lane'); f.task('code', 'first'); f.run('execute');
  f.git('remote', 'set-url', '--push', 'origin', join(f.root, 'missing.git'));
  const failed = f.run('gate', {}, 128);
  assert.match(failed.stderr, /missing.git/);
  assert.match(failed.stderr, /推送执行者提交/);
  assert.deepEqual(failed.outputs, {});
});

test('gate 检出 Git 工作区且先于检查', async () => {
  const { root, problem } = await readWorkflow(workflow, 'develop'); assert.ok(!problem, problem);
  const process = root.rootElements.find(e => e.$type === 'bpmn:Process');
  const nodes = Object.fromEntries(process.flowElements.map(e => [e.id, e]));
  assert.notEqual(nodes.gate.checkout, false);
  assert.equal(nodes['gate-checks'].sourceRef.id, 'gate');
  assert.equal(nodes['gate-checks'].targetRef.id, 'gate-fork');
  assert.equal(nodes['gate-fork-checks'].targetRef.id, 'checks');
  assert.equal(nodes['reuse-missing'].targetRef.id, 'gate');
});

test('PR 实际输出经类型转换和网关求值：同提交复用，缺失或新提交回 gate', async t => {
  const { root, problem } = await readWorkflow(workflow, 'develop'); assert.ok(!problem, problem);
  const process = root.rootElements.find(e => e.$type === 'bpmn:Process');
  const nodes = Object.fromEntries(process.flowElements.map(e => [e.id, e]));
  const gateway = nodes['reuse-checks'];
  const next = outputs => {
    // 对齐 coda backend/src/components/workflows/bpmn-runs.mjs 的 typed：
    // 脚本输出先把 true/false 字符串变成布尔值，再按任务 id 进入 FEEL。
    // check 包只校验流程方言；这里用与引擎相同的 feelin 求值真实 BPMN 条件。
    const pr = Object.fromEntries(Object.entries(outputs).map(([key, value]) =>
      [key, value === 'true' ? true : value === 'false' ? false : value]));
    const selected = process.flowElements.filter(flow => flow.sourceRef === gateway).find(flow => {
      if (flow === gateway.default) return false;
      const result = evaluate(flow.conditionExpression.body.slice(1), { pr });
      assert.deepEqual(result.warnings, []);
      return result.value === true;
    }) ?? gateway.default;
    return selected.targetRef.id;
  };
  const f = fixture(t, false); f.run('lane'); f.task('code', 'first'); f.run('execute');
  assert.equal(next(f.run('pr').outputs), 'gate', '尚无检查结果');
  const head = f.run('gate').outputs.head;
  const ref = f.state().checkRef;
  f.run('gate-passed', { RUNS: '[]' });
  f.review('accept', '汇报'); f.run('accept');
  assert.equal(f.git('ls-remote', 'origin', ref), '');
  assert.equal(next(f.run('pr').outputs), 'premerge');
  const state = f.state(); delete state.checks;
  writeFileSync(join(f.env.CODA_ARTIFACTS, 'develop.json'), JSON.stringify(state));
  assert.equal(next(f.run('pr').outputs), 'gate', '检查记录缺失');
  assert.equal(f.run('gate').outputs.head, head);
  assert.equal(f.git('ls-remote', 'origin', ref).split('\t')[0], head);
  f.run('gate-passed', { RUNS: '[]' });
  f.review('accept', '汇报'); f.run('accept');
  assert.equal(f.git('ls-remote', 'origin', ref), '');
  assert.equal(next(f.run('pr').outputs), 'premerge');
  assert.equal(f.git('ls-remote', 'origin', f.state().lane).split('\t')[0], head);
  assert.equal(f.state().approved.length, 1);
  f.task('code', 'new change'); f.run('revise');
  f.review('accept', '汇报'); f.run('accept');
  assert.equal(next(f.run('pr').outputs), 'gate', '新提交不能复用旧检查');
});

// 评审环节：照引擎走一次「评审」——是否进入、三份各自的网关、调用参数、出错边界与结束事件的输出——得到 =reviews，
// 再交给「整理审查材料」。review-commit 的结果由 outcome 给（评审没完成时它也正常结束，decision 为 INCOMPLETE）；
// 没给的这一份是调用本身没成，走出错边界。ends 是每一份走到的结束事件。
async function reviewing() {
  const { root, problem } = await readWorkflow(workflow, 'develop'); assert.ok(!problem, problem);
  const process = root.rootElements.find(e => e.$type === 'bpmn:Process');
  const sub = process.flowElements.find(e => e.id === 'reviews');
  const elements = [...process.flowElements, ...sub.flowElements];
  const nodes = Object.fromEntries(elements.map(e => [e.id, e]));
  const values = node => node.extensionElements?.values ?? [];
  const read = (value, context) => value.startsWith('=') ? evaluate(value.slice(1), context).value : value;
  // 引擎把结束事件的输出一律转成文字（对象、列表是 JSON 文本，null 是空字符串），再把 'true'、'false' 还原成布尔。
  const output = value => { const given = value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value); return given === 'true' ? true : given === 'false' ? false : given; };
  const route = (id, context) => {
    const node = nodes[id], flows = elements.filter(e => e.sourceRef === node);
    return (flows.find(e => e.conditionExpression && evaluate(e.conditionExpression.body.trim().slice(1), context).value) ?? node.default).targetRef.id;
  };
  const next = id => elements.find(e => e.$type === 'bpmn:SequenceFlow' && e.sourceRef === nodes[id]).targetRef.id;
  const deliver = (context, outcome = {}) => {
    const calls = [], ends = [];
    if (route('reviews-choice', context) === 'report') return { calls, reviews: null };
    assert.equal(next('reviews'), 'report');
    const reviews = read(sub.loopCharacteristics.inputCollection, context).map(slot => {
      const local = { ...context, slot };
      for (let step = next('reviews-start'); ;) {
        const node = nodes[step];
        if (node.$type === 'bpmn:EndEvent') { ends.push(step); return Object.fromEntries(values(node).map(v => [v.name, output(read(v.value, local))])); }
        if (node.$type === 'bpmn:ExclusiveGateway') step = route(step, local);
        else if (node.$type === 'bpmn:CallActivity') {
          calls.push({ called: node.calledElement, ...Object.fromEntries(values(node).map(v => [v.name, read(v.value, local)])) });
          const given = outcome[slot.slot];
          local[step] = given;
          step = given ? next(step) : next(elements.find(e => e.attachedToRef === node && e.eventDefinitions?.[0].$type === 'bpmn:ErrorEventDefinition').id);
        } else step = next(step);
      }
    });
    return { calls, reviews, ends };
  };
  return { process, sub, nodes, elements, route, next, deliver };
}

test('评审者的位置不设默认可不填；评审在项目检查通过后、整理材料前，检查失败升级的路不经过它', async () => {
  const { process, sub, nodes, elements, route, next } = await reviewing();
  const inputs = Object.fromEntries((process.extensionElements?.values ?? []).map(v => [v.name, v]));
  for (const [name, label] of [['reviewer', '评审者'], ['reviewer2', '第二评审者'], ['reviewerOnce', '首次评审者']]) {
    assert.deepEqual([inputs[name].type, inputs[name].label, inputs[name].default, inputs[name].defaultFrom, inputs[name].required], ['agent', label, undefined, undefined, undefined], name);
  }
  assert.equal(next('checks'), 'gate-passed');
  assert.equal(next('gate-passed'), 'reviews-choice');
  assert.equal(nodes['gate-escalate'].targetRef.id, 'report', '连续三次检查失败直接升级，不评审');
  assert.equal(nodes['checks-feedback'].targetRef.id, 'check-feedback', '检查没过不评审');
  assert.equal(sub.optional, true, '没人评审时卡片上不出现这一段');
  assert.equal(sub.loopCharacteristics.isSequential, false, '三份同时进行');
  // 每一份从开始走得到的都是结束事件：跳过、评完、没评成各一个，出错边界接住调用失败。
  const inner = sub.flowElements, ends = inner.filter(e => e.$type === 'bpmn:EndEvent').map(e => e.id);
  assert.deepEqual(ends, ['review-skipped', 'review-lost', 'review-done']);
  const boundary = inner.filter(e => e.$type === 'bpmn:BoundaryEvent');
  assert.deepEqual(boundary.map(e => [e.attachedToRef.id, e.eventDefinitions[0].$type, e.eventDefinitions[0].errorRef, e.cancelActivity]), [['review-call', 'bpmn:ErrorEventDefinition', undefined, true]]);
  for (const node of inner.filter(e => !['bpmn:SequenceFlow', 'bpmn:EndEvent'].includes(e.$type))) {
    const outgoing = inner.filter(e => e.sourceRef === node);
    assert.ok(outgoing.length, `${node.id} 有出口`);
    const reached = new Set(), walk = id => { if (reached.has(id)) return; reached.add(id); for (const e of inner.filter(f => f.sourceRef?.id === id)) walk(e.targetRef.id); };
    walk(node.id);
    assert.ok([...reached].some(id => ends.includes(id)), `${node.id} 走得到结束事件`);
  }
  assert.deepEqual(inner.filter(e => e.$type === 'bpmn:SequenceFlow' && ends.includes(e.sourceRef.id)), [], '结束事件之后没有连线');
  assert.equal(elements.filter(e => e.$type === 'bpmn:ParallelGateway' && sub.flowElements.includes(e)).length, 0, '汇合由多实例完成，不另设并行网关');
  assert.equal(nodes['review-call'].calledElement, 'review-commit');
  assert.equal(route('reviews-choice', { inputs: { reviewer: null, reviewer2: null, reviewerOnce: null }, 'gate-passed': { first: true } }), 'report');
  const review = nodes.review.documentation[0].text;
  assert.match(review, /评审者的发现是否成立由你判断，不成立的不必转给执行者。/);
  const section = review.match(/\{\{(if report\.reviews[\s\S]*?)\}\}/)[1];
  assert.equal(evaluate(section, { report: { reviews: '' } }).value, '');
  assert.equal(evaluate(section, { report: { reviews: '评审者（a）：可以' } }).value, '\n评审者的发现：\n评审者（a）：可以');
  assert.equal(nodes.report.extensionElements.values.find(v => v.name === 'REVIEWS').value, '=reviews');
});

test('填了几位评审者就调用几次，参数是这次交付；首次评审者只评每项任务的第一次', async () => {
  const { deliver } = await reviewing();
  const agents = { reviewer: { agent: 'a1', model: 'm1' }, reviewer2: { agent: 'a2' }, reviewerOnce: { agent: 'a3', effort: 'high' } };
  const context = (filled, first) => ({ inputs: { reviewer: null, reviewer2: null, reviewerOnce: null, ...Object.fromEntries(filled.map(slot => [slot, agents[slot]])) },
    gate: { head: 'h'.repeat(40) }, 'gate-passed': { base: 'b'.repeat(40), task: '第一项任务', first } });
  const outcome = { reviewer: { decision: 'APPROVE', line: 'ok', findings: '[]', report: 'r1' }, reviewer2: { decision: 'APPROVE', line: 'ok', findings: '[]', report: 'r2' },
    reviewerOnce: { decision: 'APPROVE', line: 'ok', findings: '[]', report: 'r3' } };
  assert.deepEqual(deliver(context([], true)), { calls: [], reviews: null }, '都不填时不进评审');
  for (const [filled, first, called] of [
    [['reviewer'], true, ['reviewer']],
    [['reviewer', 'reviewer2'], true, ['reviewer', 'reviewer2']],
    [['reviewer', 'reviewer2', 'reviewerOnce'], true, ['reviewer', 'reviewer2', 'reviewerOnce']],
    [['reviewer', 'reviewer2', 'reviewerOnce'], false, ['reviewer', 'reviewer2']],
    [['reviewerOnce'], true, ['reviewerOnce']],
    [['reviewerOnce'], false, []],
    [['reviewer2'], false, ['reviewer2']],
  ]) {
    const { calls, reviews } = deliver(context(filled, first), outcome);
    assert.deepEqual(calls, called.map(slot => ({ called: 'review-commit', base: 'b'.repeat(40), head: 'h'.repeat(40), task: '第一项任务', reviewer: agents[slot] })), `${filled} ${first}`);
    if (!called.length) { assert.equal(reviews, null); continue; }
    assert.deepEqual(reviews.map(r => r.state), ['reviewer', 'reviewer2', 'reviewerOnce'].map(slot => called.includes(slot) ? 'done' : 'skipped'));
    for (const r of reviews.filter(r => r.state === 'done')) assert.deepEqual(r, { state: 'done', slot: r.slot, who: JSON.stringify(agents[r.slot]), head: 'h'.repeat(40), ...outcome[r.slot] });
  }
});

test('gate-passed 给评审对照的泳道提交与任务书，首次只在新执行会话后的第一次通过', t => {
  const f = fixture(t, false); f.run('lane'); f.task('code', 'first'); f.run('execute');
  const passed = () => f.run('gate-passed', { RUNS: '[]' }).outputs;
  assert.deepEqual(passed(), { base: f.state().head, task: f.state().task, first: 'true' });
  f.review('revise', '再改改'); f.task('code', 'second'); f.run('revise');
  assert.equal(passed().first, 'false', '同一会话修改后的交付不算第一次');
  f.review('next', '第二项：补齐状态'); assert.equal(f.run('accept').outputs.route, 'execute');
  f.task('two', 'next task'); f.run('execute');
  assert.deepEqual(passed(), { base: f.state().head, task: '第二项：补齐状态', first: 'true' }, '下一项任务的第一次交付');
});

test('审查材料带上每位评审者的结果：没评成的写原因，别人的发现照常；发现多时卡片只留严重程度、标题和位置', async t => {
  const { deliver } = await reviewing();
  const f = fixture(t, false); f.run('lane'); f.task('code', 'first'); f.run('execute');
  const head = f.state().executor.head, path = join(f.env.CODA_ARTIFACTS, 'reviews.md');
  const material = reviews => f.run('review', { REVIEWS: reviews === null ? '' : JSON.stringify(reviews) }).outputs.reviews;
  assert.equal(material(null), '', '没有评审者时没有这一段');

  const context = { inputs: { reviewer: { agent: 'a1', model: 'm1', effort: 'high' }, reviewer2: { agent: 'a2' }, reviewerOnce: { agent: 'a3' } },
    gate: { head }, 'gate-passed': { base: f.state().head, task: f.state().task, first: true } };
  const findings = [{ severity: 'P1', title: '漏了失败路径', location: 'scripts/a.mjs:12', detail: '失败时状态没写回。\n第二行' }, { severity: 'P3', title: '命名', location: '', detail: '' }];
  const { reviews } = deliver(context, { reviewer: { decision: 'REQUEST_CHANGES', line: '有一个要改', findings: JSON.stringify(findings), report: '评审原文一' },
    reviewerOnce: { decision: 'APPROVE', line: '可以', findings: '[]', report: '评审原文三' } });
  const text = material(reviews);
  assert.equal(text, [
    '评审者（a1 · m1 · high）：有一个要改\n- [P1] 漏了失败路径（scripts/a.mjs:12）\n  失败时状态没写回。\n  第二行\n- [P3] 命名',
    `第二评审者（a2）：没评成。调用 review-commit 没有成功，原因见本运行 coda://workflow-runs/run-1 的「评审这次交付」（workflow_status）。`,
    `首次评审者（a3）：可以\n评审原文：${path}`,
  ].join('\n\n'));
  for (const raw of ['评审原文一', '评审原文三', '失败时状态没写回。']) assert.ok(readFileSync(path, 'utf8').includes(raw), raw);
  assert.equal(f.run('review', { REVIEWS: JSON.stringify(reviews) }).status, 0, '评审没评成不让这一步失败');

  // 评的不是这次交付（之前的提交、检查连续失败后升级）时不带。
  f.task('code', 'second'); f.run('revise');
  assert.equal(material(reviews), '');

  const many = Array.from({ length: 60 }, (_, i) => ({ severity: `P${i % 4}`, title: `问题 ${i}`, location: `src/file-${i}.mjs:${i}`, detail: `第 ${i} 条的说明，`.repeat(8) }));
  const crowded = deliver({ ...context, gate: { head: f.state().executor.head } }, { reviewer: { decision: 'REQUEST_CHANGES', line: '很多问题', findings: JSON.stringify(many), report: '原文' } }).reviews;
  const card = material(crowded);
  for (const finding of many) assert.ok(card.includes(`- [${finding.severity}] ${finding.title}（${finding.location}）`), finding.title);
  assert.ok(!many.some(finding => card.includes(finding.detail)), '说明不进卡片');
  assert.ok(card.includes(`每条的说明与评审原文见 ${path}`));
  const file = readFileSync(path, 'utf8');
  for (const finding of many) assert.ok(file.includes(finding.detail), finding.title);
});

test('两位评审都没评完：调用节点正常结束，审查卡上两位都写没评成和原因', async t => {
  const { deliver } = await reviewing();
  const f = fixture(t, false); f.run('lane'); f.task('code', 'first'); f.run('execute');
  const head = f.state().executor.head;
  const context = { inputs: { reviewer: { agent: 'a1' }, reviewer2: { agent: 'a2', model: 'm2' }, reviewerOnce: null },
    gate: { head }, 'gate-passed': { base: f.state().head, task: f.state().task, first: true } };
  const incomplete = why => ({ decision: 'INCOMPLETE', line: `评审没有完成：${why}`, findings: '[]', report: '被停下了。' });
  const { calls, reviews, ends } = deliver(context, { reviewer: incomplete('评审会话没有正常结束'), reviewer2: incomplete('评审方没有按格式给出结论') });
  assert.equal(calls.length, 2);
  // 两份都从调用的正常出口走到 review-done，没有经过出错边界：「评审这次交付」这个节点没有失败。
  assert.deepEqual(ends, ['review-done', 'review-done', 'review-skipped']);
  assert.deepEqual(reviews.slice(0, 2).map(r => [r.state, r.decision]), [['done', 'INCOMPLETE'], ['done', 'INCOMPLETE']]);
  const card = f.run('review', { REVIEWS: JSON.stringify(reviews) }).outputs.reviews;
  assert.equal(card, ['评审者（a1）：没评成：评审没有完成：评审会话没有正常结束', '第二评审者（a2 · m2）：没评成：评审没有完成：评审方没有按格式给出结论'].join('\n\n')
    + `\n评审原文：${join(f.env.CODA_ARTIFACTS, 'reviews.md')}`);
  assert.ok(readFileSync(join(f.env.CODA_ARTIFACTS, 'reviews.md'), 'utf8').includes('被停下了。'), '评审方返回的文字留在产物里');
});

test('发现的标题和位置里的换行压成空格，说明原样', async t => {
  const { deliver } = await reviewing();
  const f = fixture(t, false); f.run('lane'); f.task('code', 'first'); f.run('execute');
  const head = f.state().executor.head, path = join(f.env.CODA_ARTIFACTS, 'reviews.md');
  const context = { inputs: { reviewer: { agent: 'a1' }, reviewer2: null, reviewerOnce: null }, gate: { head }, 'gate-passed': { base: f.state().head, task: f.state().task, first: true } };
  const findings = [{ severity: 'P2', title: '标题\n第二行', location: 'a.mjs:1\r\n  b.mjs:2', detail: '说明\n第二行' }];
  const { reviews } = deliver(context, { reviewer: { decision: 'REQUEST_CHANGES', line: '要改', findings: JSON.stringify(findings), report: '原文' } });
  const card = f.run('review', { REVIEWS: JSON.stringify(reviews) }).outputs.reviews;
  assert.equal(card, `评审者（a1）：要改\n- [P2] 标题 第二行（a.mjs:1 b.mjs:2）\n  说明\n  第二行\n评审原文：${path}`);
  assert.ok(readFileSync(path, 'utf8').startsWith('评审者（a1）：要改\n- [P2] 标题 第二行（a.mjs:1 b.mjs:2）\n  说明\n  第二行'));
});

// 备用执行者：审查卡上由主 Agent 决定换不换；换了是新开会话从泳道当前提交重做同一项，退回次数只数「退回修改」。
test('备用执行者不设默认可不填；「换备用执行者重做」新开会话回 gate，「再派一项」仍用执行者；审查卡显示退回次数', async () => {
  const { process, nodes, route, next } = await reviewing();
  const inputs = Object.fromEntries((process.extensionElements?.values ?? []).map(v => [v.name, v]));
  const backup = inputs.executor2;
  assert.deepEqual([backup.type, backup.label, backup.default, backup.defaultFrom, backup.required], ['agent', '备用执行者', undefined, undefined, undefined]);
  const choices = nodes.review.extensionElements.values;
  assert.deepEqual(choices.map(v => [v.id, v.name]), [['revise', '退回修改'], ['sync', '让执行者合并目标分支'], ['next', '通过，再派一项'], ['swap', '换备用执行者重做'], ['accept', '通过，可以验收']]);
  assert.equal(route('how', { decide: { route: 'swap' } }), 'swap');
  assert.equal(next('swap'), 'gate', '换人后的交付照常推送、检查、评审、审查');
  assert.match(nodes.swap.script, /develop\.mjs" swap/);
  const env = node => Object.fromEntries(node.extensionElements.values.map(v => [v.name, v.value]));
  assert.equal(env(nodes.swap).EXECUTOR, '=inputs.executor2');
  assert.doesNotMatch(env(nodes.execute).EXECUTOR, /executor2/, '再派一项仍用开工时的执行者');
  for (const [executor2, expected] of [[null, false], [{ agent: 'a2' }, true]]) assert.equal(evaluate(env(nodes.decide).BACKUP.slice(1), { inputs: { executor2 } }).value, expected);
  const card = context => nodes.review.documentation[0].text.replace(/\{\{([\s\S]*?)\}\}/g, (_, expression) => evaluate(expression, context).value ?? '');
  const report = { session: 's', branch: 'b', head: 'h', lane: 'l', checks: '', answer: '', reviews: '', feedback: '', returns: '2' };
  const none = card({ report, inputs: { executor2: null } }), filled = card({ report, inputs: { executor2: { agent: 'a2', model: 'm2' } } });
  assert.ok(none.includes('这一项任务已退回 2 次'));
  assert.ok(none.includes('备用执行者：未指定，不能换人'));
  assert.ok(filled.includes('备用执行者：a2 · m2'));
  assert.match(nodes.review.documentation[0].text, /选择「换备用执行者重做」时备注必填/);
});

test('换备用执行者重做：新开会话从泳道当前提交开工，带任务书、备注和上一位的分支与提交；之后退回续新会话，退回次数只数退回修改', t => {
  const f = fixture(t, false); f.run('lane'); f.task('code', 'first'); f.run('execute');
  const laneHead = f.state().head, first = f.state().executor;
  const returns = () => f.run('review').outputs.returns;
  const passed = () => f.run('gate-passed', { RUNS: '[]' }).outputs.first;
  assert.equal(returns(), '0');
  assert.equal(passed(), 'true');
  assert.equal(f.review('revise', '改一下'), 'revise'); assert.equal(returns(), '1');
  f.task('code', 'second'); f.run('revise');
  assert.equal(f.state().executor.session, first.session);
  const previous = f.state().executor;
  assert.equal(f.run('gate-failed').outputs.route, 'revise'); assert.equal(returns(), '1', '检查失败的自动退回不算');
  f.task('code', 'third'); f.run('revise');
  const before = f.state().executor;
  assert.equal(f.state().failures.length, 1);

  const swap = f.run('decide', { REVIEW: JSON.stringify({ choice: 'swap', note: '上一位绕远了，接手的人只改输入框' }), BACKUP: 'true' }).outputs.route;
  assert.equal(swap, 'swap');
  f.task('redo', 'redo'); f.run('swap', { EXECUTOR: JSON.stringify({ agent: 'backup', model: 'm2', options: { fast: true } }) });
  const call = f.calls('agent').at(-1), swapped = f.state().executor;
  assert.deepEqual(call.args.slice(0, -2), ['--commit', laneHead, '--title', '修好输入框', '--agent', 'backup', '--model', 'm2', '--option', 'fast=true', '--json'], '新开会话，不是续旧会话');
  assert.notEqual(swapped.session, before.session);
  assert.equal(f.git('rev-parse', `${swapped.head}^`), laneHead, '上一位没被接受的提交不带过来');
  for (const text of ['不再委派', '第一项：修好输入框', '上一位绕远了，接手的人只改输入框', before.branch, before.head, '可以参考，也可以不用']) assert.ok(call.prompt.includes(text), text);
  assert.ok(!call.prompt.includes(previous.head), '只给上一位最后的提交');
  assert.equal(f.state().failures.length, 0, '换人后连续检查失败重新计数');
  assert.equal(returns(), '1', '换人不算退回');
  assert.equal(passed(), 'true', '换人后的第一次交付算这项任务的第一次');
  assert.equal(passed(), 'false');

  assert.equal(f.review('revise', '再改改'), 'revise'); assert.equal(returns(), '2');
  f.task('redo', 'redo again'); f.run('revise');
  assert.deepEqual(f.calls('agent').at(-1).args.slice(0, -2), ['--continue', swapped.session, '--json'], '之后的退回续新会话');

  f.review('next', '第二项：补齐状态'); assert.equal(f.run('accept').outputs.route, 'execute');
  f.task('two', 'next task'); f.run('execute');
  assert.deepEqual(f.calls('agent').at(-1).args.slice(0, 6), ['--commit', f.state().head, '--title', '修好输入框', '--agent', 'codex'], '再派一项用执行者');
  assert.equal(returns(), '0', '新一项任务归零');
});

test('没填备用执行者时选「换备用执行者重做」：回到审查卡说明，不开会话、运行不失败；没写备注同样回去', t => {
  const f = fixture(t, false); f.run('lane'); f.task('code', 'first'); f.run('execute');
  const executor = f.state().executor, calls = f.calls('agent').length;
  const decide = (note, BACKUP) => f.run('decide', { REVIEW: JSON.stringify({ choice: 'swap', note }), BACKUP }).outputs.route;
  assert.equal(decide('换人', 'false'), 'review');
  assert.match(f.run('review').outputs.feedback, /没有填备用执行者/);
  assert.equal(decide('  ', 'true'), 'review');
  assert.match(f.run('review').outputs.feedback, /换备用执行者重做必须在备注中写/);
  assert.equal(f.calls('agent').length, calls);
  assert.deepEqual(f.state().executor, executor);
  assert.equal(f.run('review').outputs.returns, '0');
});

test('换人后的第一次交付，首次评审者会评', async t => {
  const { deliver } = await reviewing();
  const f = fixture(t, false); f.run('lane'); f.task('code', 'first'); f.run('execute');
  f.run('gate-passed', { RUNS: '[]' });
  f.run('decide', { REVIEW: JSON.stringify({ choice: 'swap', note: '换人' }), BACKUP: 'true' });
  f.task('redo', 'redo'); f.run('swap', { EXECUTOR: JSON.stringify({ agent: 'backup' }) });
  const passed = f.run('gate-passed', { RUNS: '[]' }).outputs;
  const once = { agent: 'a3' };
  const { calls } = deliver({ inputs: { reviewer: null, reviewer2: null, reviewerOnce: once }, gate: { head: f.state().executor.head }, 'gate-passed': { ...passed, first: passed.first === 'true' } },
    { reviewerOnce: { decision: 'APPROVE', line: 'ok', findings: '[]', report: 'r' } });
  assert.deepEqual(calls, [{ called: 'review-commit', base: f.state().head, head: f.state().executor.head, task: f.state().task, reviewer: once }]);
});

// 目标分支在执行者开工之后前进：clean 的不碰同一个文件，冲突的改同一个文件。
const advance = (f, file, text) => {
  f.git('switch', 'main');
  writeFileSync(join(f.work, file), text); f.git('add', file); f.git('commit', '-qm', `base ${file}`); f.git('push', '-q', 'origin', 'main');
  return f.git('rev-parse', 'HEAD');
};
const delivered = f => { f.run('gate'); f.run('gate-passed', { RUNS: '[]' }); };
const syncTexts = ['目标分支是 main', 'git fetch origin main', '合并（merge）', '不要变基', '泳道只能快进', '数据库迁移等版本号', '顺延', '跑和冲突相关的测试', '只做这件事', '回报冲突了哪些文件', '不需要合并'];

test('通过可以验收：目标分支有不冲突的新提交时照常快进泳道，不产生合并提交', t => {
  const f = fixture(t, false); f.run('lane'); f.task('code', 'worker change'); f.run('execute'); delivered(f);
  advance(f, 'other', 'other');
  const lane = f.state().lane, head = f.state().executor.head;
  f.review('accept', '汇报');
  assert.equal(f.run('accept').outputs.route, 'pr');
  assert.equal(f.git('ls-remote', 'origin', lane).split('\t')[0], head);
  assert.equal(f.git('rev-list', '--parents', '-n', '1', head).split(' ').length, 2, '执行者的提交不是合并提交，流程没有另外提交');
  assert.equal(f.state().approved.length, 1);
  assert.equal(f.state().feedback, '');
});

test('通过可以验收：目标分支有冲突的新提交时泳道不动、不记入已通过，同一会话收到固定说明，不算退回；合并后再通过照常快进', t => {
  const f = fixture(t, false); f.run('lane'); f.task('base', 'worker change'); f.run('execute'); delivered(f);
  const lane = f.state().lane, before = f.state(), laneHead = f.git('ls-remote', 'origin', lane).split('\t')[0];
  const baseHead = advance(f, 'base', 'target change');
  f.review('accept', '汇报');
  assert.deepEqual(f.run('accept').outputs, { route: 'sync' });
  assert.equal(f.git('ls-remote', 'origin', lane).split('\t')[0], laneHead, '泳道没动');
  assert.equal(f.git('ls-remote', 'origin', 'main').split('\t')[0], baseHead, '目标分支没动');
  assert.equal(f.git('show-ref', '--heads', 'main').split(' ')[0], baseHead);
  assert.equal(f.state().approved.length, 0, '不记入已通过');
  assert.equal(f.state().head, before.head);
  assert.equal(f.state().returns, 0);
  const feedback = f.run('review').outputs.feedback;
  for (const text of [...syncTexts, '冲突的文件', '- base']) assert.ok(feedback.includes(text), text);
  assert.equal(f.run('review').outputs.returns, '0');
  f.task('base', 'resolved', undefined, 'main'); f.run('revise');
  assert.equal(f.state().executor.session, before.executor.session, '同一执行会话');
  assert.deepEqual(f.calls('agent').at(-1).args.slice(0, -2), ['--continue', before.executor.session, '--json']);
  for (const text of [...syncTexts, '- base']) assert.ok(f.calls('agent').at(-1).prompt.includes(text), text);
  f.git('merge-base', '--is-ancestor', baseHead, f.state().executor.head);
  delivered(f);
  assert.equal(f.state().reviewed, true);
  f.review('accept', '修复后的汇报');
  assert.equal(f.run('accept').outputs.route, 'pr');
  assert.equal(f.git('ls-remote', 'origin', lane).split('\t')[0], f.state().executor.head);
  assert.equal(f.state().approved.length, 1);
  assert.equal(f.state().returns, 0);
});

test('通过，再派一项不试合并：目标分支有冲突也照常快进泳道', t => {
  const f = fixture(t, false); f.run('lane'); f.task('base', 'worker change'); f.run('execute'); delivered(f);
  advance(f, 'base', 'target change');
  f.review('next', '第二项：补齐状态');
  assert.equal(f.run('accept').outputs.route, 'execute');
  assert.equal(f.git('ls-remote', 'origin', f.state().lane).split('\t')[0], f.state().head);
  assert.equal(f.state().approved.length, 1);
});

for (const note of ['版本号会撞，注意迁移', '', '  ']) test(`让执行者合并目标分支（备注 ${JSON.stringify(note)}）：同一会话续作，带固定说明，不算退回，之后首次评审者不评`, t => {
  const f = fixture(t, false); f.run('lane'); f.task('code', 'first'); f.run('execute');
  const session = f.state().executor.session;
  assert.equal(f.run('gate-passed', { RUNS: '[]' }).outputs.first, 'true');
  assert.equal(f.review('sync', note), 'revise');
  assert.equal(f.state().returns, 0);
  assert.equal(f.state().head, f.git('ls-remote', 'origin', f.state().lane).split('\t')[0], '泳道没动');
  f.task('code', 'merged'); f.run('revise');
  assert.equal(f.state().executor.session, session);
  const prompt = f.calls('agent').at(-1).prompt;
  assert.deepEqual(f.calls('agent').at(-1).args.slice(0, -2), ['--continue', session, '--json']);
  for (const text of syncTexts) assert.ok(prompt.includes(text), text);
  assert.ok(!prompt.includes('冲突的文件'), '没试合并，没有冲突文件');
  assert.equal(prompt.includes('主 Agent 的备注'), Boolean(note.trim()));
  if (note.trim()) assert.ok(prompt.endsWith(`主 Agent 的备注：\n${note}\n`));
  assert.equal(f.run('review').outputs.returns, '0');
  assert.equal(f.run('gate-passed', { RUNS: '[]' }).outputs.first, 'false', '同一会话继续，首次评审者不再评');
});
