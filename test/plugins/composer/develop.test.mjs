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
    FIXTURE: root, AGENT: 'codex', MODEL: '', EFFORT: '', MODE: '' };
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
else if (args[1] === 'merge') process.exit(Number(process.env.MERGE_EXIT || 0));
else if (args[1] === 'view') {
  if (args.includes('statusCheckRollup')) {
    console.log(process.env.CHECKS_COUNT || '1');
    process.exit(Number(process.env.CHECKS_QUERY_EXIT || 0));
  }
  console.log('f'.repeat(40));
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
  const task = (file, answer, exit) => writeFileSync(join(root, 'agent-task'), JSON.stringify({ file, answer, exit }));
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
  f.task('one', 'first answer\nEOF_answer\n继续'); f.run('execute', { MODEL: 'cheap', EFFORT: 'low', MODE: 'auto' });
  const first = f.state().executor;
  assert.equal(f.git('ls-remote', 'origin', lane).split('\t')[0], latest, '执行者不推送');
  const report = f.run('review').outputs;
  assert.equal(report.answer, first.answer); assert.equal(report.branch, first.branch); assert.equal(report.head, first.head);
  const call = f.calls('agent')[0];
  assert.deepEqual(call.args.slice(0, -2), ['--commit', latest, '--title', '修好输入框', '--agent', 'codex', '--model', 'cheap', '--effort', 'low', '--mode', 'auto', '--json']);
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
  f.review('accept'); assert.equal(f.run('accept').outputs.route, 'preview');
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
  f.review('accept'); assert.equal(f.run('accept').outputs.route, 'preview');
  assert.deepEqual(f.run('preview', { PREVIEW: JSON.stringify({ choice: 'installed' }) }).outputs, { feedback: '', route: 'device' });
  assert.equal(f.state().feedback, '');
  assert.equal(f.run('device', { DEVICE: JSON.stringify({ choice: 'no' }) }).outputs.route, 'device');
  assert.equal(f.device('no'), 'device');
  assert.equal(f.device('no', '按钮没有响应'), 'review');
  assert.equal(f.run('review').outputs.feedback, '设备验收不通过：\n按钮没有响应');
  f.review('revise', '修复按钮回调'); f.task('two', 'button fixed'); f.run('revise');
  f.review('accept'); assert.equal(f.run('accept').outputs.route, 'preview');
  assert.equal(f.device('yes'), 'pr');
  const summary = f.run('pr').outputs.summary;
  const created = f.calls('gh').find(c => c.args[1] === 'create');
  assert.deepEqual(created.args.slice(0, 6), ['pr', 'create', '--base', 'main', '--head', lane]);
  assert.equal(created.args[created.args.indexOf('--title') + 1], '修好输入框');
  const approved = f.state().approved;
  assert.equal(created.body, [
    `## 第 1 项\n\n<details><summary>任务</summary>\n\n${task}\n\n</details>\n\nremoved wrapper\n\n提交：${approved[0].head}`,
    `## 第 2 项\n\n<details><summary>任务</summary>\n\n第二项：补齐状态\n\n</details>\n\nsecond answer\n\n提交：${approved[1].head}`,
    `## 第 3 项\n\n<details><summary>任务</summary>\n\n第二项：补齐状态\n\n</details>\n\nbase integrated\n\n提交：${approved[2].head}`,
    `## 第 4 项\n\n<details><summary>任务</summary>\n\n第二项：补齐状态\n\n</details>\n\nbutton fixed\n\n提交：${approved[3].head}`,
  ].join('\n\n'));
  assert.equal(summary, created.body, '批准卡片使用同一份正文');
  assert.ok(!created.body.includes('first answer'), '未通过的改动不放进 PR 汇总');
  assert.equal(f.run('pr').outputs.summary, created.body);
  assert.equal(f.calls('gh').filter(c => c.args[1] === 'create').length, 1);
  assert.equal(f.calls('gh').filter(c => c.args[1] === 'edit').length, 1);
  assert.equal(f.calls('gh').find(c => c.args[1] === 'edit').body, created.body);
});

test('检查失败回最近执行会话，修好更新 PR 重跑；交由 gh 删除泳道，分支已删除仍交出合并提交', t => {
  const f = fixture(t); f.run('lane'); f.task('code', 'implementation'); f.run('execute');
  f.review('accept'); f.run('accept'); f.device('yes'); f.run('pr');
  const session = f.state().executor.session;
  for (const step of ['项目检查', 'GitHub 检查', '合并前检查']) {
    f.run('check-failed', { STEP: step });
    const feedback = f.run('review').outputs.feedback;
    assert.ok(feedback.includes(step)); assert.ok(feedback.includes(f.state().head));
    assert.match(feedback, /workflow_status.*读取错误和日志/);
    f.review('revise', `${step}：修复断言`); f.task('code', step); f.run('revise');
    assert.equal(f.state().executor.session, session);
    f.review('accept'); assert.equal(f.run('accept').outputs.route, 'pr');
    f.run('pr');
  }
  assert.equal(f.run('merge', { MERGE_EXIT: '1' }, 1).outputs.commit, undefined);
  assert.equal(f.git('ls-remote', 'origin', f.state().lane).split('\t')[0], f.state().head, '合并失败不删除泳道');
  f.git('push', 'origin', '--delete', f.state().lane);
  f.git('switch', '--detach');
  f.git('branch', '-D', f.state().lane);
  const merged = f.run('merge').outputs.commit;
  assert.equal(merged, 'f'.repeat(40)); assert.notEqual(merged, f.state().head);
  assert.deepEqual(f.calls('gh').find(c => c.args[1] === 'merge').args,
    ['pr', 'merge', f.state().pr, '--squash', '--match-head-commit', f.state().head, '--delete-branch']);
  assert.deepEqual(f.calls('gh').find(c => c.args[0] === 'pr' && c.args[1] === 'view').args,
    ['pr', 'view', f.state().pr, '--json', 'mergeCommit', '--jq', '.mergeCommit.oid']);
  assert.equal(f.git('ls-remote', 'origin', f.state().lane), '', '远端泳道已由 GitHub 自动删除');
});

test('泳道不接受分叉，Agent 非零退出不进入审查', t => {
  const f = fixture(t); f.run('lane');
  for (const code of [1, 2, 130]) { f.task('code', '', code); f.run('execute', {}, code); assert.equal(f.state().executor, undefined); }
  f.task('code', 'worker change'); f.run('execute'); f.review('accept');
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
  f.review('accept'); assert.equal(f.run('accept').outputs.route, 'pr');
  assert.equal(f.run('pr').outputs.url, 'https://github.com/example/fixture/pull/1');
  assert.equal(f.state().phase, 'check');
});

test('归属需求跳过设备验收，待交付退回续作，更新同一 PR 后放行合并', t => {
  const f = fixture(t, true, 'requirement-1');
  f.run('lane'); f.task('one', 'first change'); f.run('execute');
  f.review('next', '第二项'); assert.equal(f.run('accept').outputs.route, 'execute');
  f.task('two', 'second change'); f.run('execute');
  f.review('accept'); assert.equal(f.run('accept').outputs.route, 'pr');
  const pr = f.run('pr').outputs;
  assert.match(pr.summary, /first change/); assert.match(pr.summary, /second change/);
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
  f.review('accept'); assert.equal(f.run('accept').outputs.route, 'pr');
  const updated = f.run('pr').outputs;
  assert.equal(updated.url, pr.url); assert.notEqual(updated.head, pr.head);
  assert.match(updated.summary, /button fixed/);
  assert.equal(f.calls('gh').filter(c => c.args[1] === 'create').length, 1);
  assert.equal(f.calls('gh').filter(c => c.args[1] === 'edit').length, 1);
  f.run('github-checks');
  assert.deepEqual(delivery('merge'), { feedback: '', route: 'premerge' });
  assert.equal(f.run('merge').outputs.commit, 'f'.repeat(40));
});

test('GitHub 检查等待全部完成，无检查通过，检查失败和查询错误保持失败并留下日志', t => {
  const f = fixture(t, false);
  f.run('lane'); f.task('code', 'implementation'); f.run('execute');
  f.review('accept'); f.run('accept'); f.run('pr');
  assert.match(f.run('github-checks').stdout, /checks passed/);
  const query = ['pr', 'view', f.state().pr, '--json', 'statusCheckRollup', '--jq', '.statusCheckRollup | length'];
  assert.deepEqual(f.calls('gh').at(-2).args, query);
  assert.deepEqual(f.calls('gh').at(-1).args, ['pr', 'checks', f.state().pr, '--watch']);
  const count = f.calls('gh').length;
  f.run('github-checks', { CHECKS_COUNT: '0', CHECKS_EXIT: '1' });
  assert.equal(f.calls('gh').length, count + 1, '无检查时只查询数量，不启动等待');
  assert.deepEqual(f.calls('gh').at(-1).args, query);
  f.run('github-checks', { CHECKS_QUERY_EXIT: '1' }, 1);
  assert.equal(f.calls('gh').length, count + 2, '查询失败时不启动等待');
  assert.deepEqual(f.calls('gh').at(-1).args, query);
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
  const nodes = Object.fromEntries(process.flowElements.map(e => [e.id, e]));
  const values = node => node.extensionElements?.values ?? [];
  const params = id => Object.fromEntries(values(nodes[id]).map(v => [v.name, v.value]));
  const route = (id, context) => {
    const node = nodes[id];
    const flows = process.flowElements.filter(e => e.sourceRef === node);
    return (flows.find(e => e.conditionExpression && evaluate(e.conditionExpression.body.trim().slice(1), context).value) ?? node.default).targetRef.id;
  };
  assert.equal(process.name, '开发'); assert.equal(process.concurrency, undefined);
  assert.deepEqual(values(process).filter(v => v.required).map(v => v.name), ['title', 'task', 'devices']);
  const devices = values(process).find(v => v.name === 'devices');
  assert.equal(devices.type, 'boolean'); assert.equal(devices.default, undefined);
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
  for (const [value, target] of [['review', 'report'], ['revise', 'revise'], ['accept', 'accept']]) assert.equal(route('how', { decide: { route: value } }), target);
  for (const value of ['execute', 'pr', 'preview']) assert.equal(route('after-accept', { accept: { route: value } }), value);
  assert.deepEqual(values(nodes.preview).map(v => [v.id, v.name]), [['installed', '已装好'], ['review', '回到审查']]);
  assert.match(nodes.preview.documentation[0].text, /preview-result.feedback/);
  assert.equal(nodes['preview-result-flow'].targetRef.id, 'preview-result');
  assert.equal(params('preview-result').PREVIEW, '=preview');
  assert.match(nodes['preview-result'].script, /develop\.mjs" preview/);
  for (const [value, target] of [['preview', 'preview'], ['review', 'report'], ['device', 'device']]) assert.equal(route('after-preview', { 'preview-result': { route: value } }), target);
  assert.equal(nodes['pr-check'].targetRef.id, 'checks');
  assert.doesNotMatch(workflow, /无客户端改动，跳过|没有客户端改动时确认/);
  for (const [value, target] of [['device', 'device'], ['review', 'report'], ['pr', 'tell-device']]) assert.equal(route('after-device', { 'device-result': { route: value } }), target);
  assert.match(nodes.review.documentation[0].text, /\{\{report.feedback\}\}/, '验收失败的备注随审查任务交回');
  assert.deepEqual(process.flowElements.filter(e => e.action === 'tell-session').map(e => e.id), ['tell-device', 'tell-approval']);
  for (const id of ['tell-device', 'tell-approval']) assert.equal(params(id).session, undefined, '通知运行所属会话');
  assert.equal(nodes['told-device-pr'].sourceRef.id, 'tell-device');
  assert.equal(nodes['told-device-pr'].targetRef.id, 'pr');
  assert.equal(nodes['approve-route'].targetRef.id, 'tell-approval');
  assert.equal(nodes['told-approval-route'].sourceRef.id, 'tell-approval');
  assert.equal(nodes['told-approval-route'].targetRef.id, 'after-approval');
  const context = { inputs: { title: '修好输入框' }, run: { id: 'run-1' }, accept: { head: 'head-1' }, pr: { head: 'head-1' } };
  const message = (id, field, extra = {}) => evaluate(params(id)[field].slice(1), { ...context, ...extra }).value;
  assert.equal(message('tell-device', 'text'), '功能「修好输入框」：用户设备验收通过，接下来开 PR、跑检查。');
  assert.equal(message('tell-device', 'key'), 'run-1:device:head-1');
  for (const choice of ['merge', 'stop']) for (const deploy of [false, true]) for (const preview of [false, true]) for (const release of [false, true]) {
    const options = choice === 'stop' ? {} : { deploy, preview, release };
    const approve = { choice, chose: { stop: choice === 'stop' }, options, note: '补齐说明' };
    const selections = [['deploy', '部署'], ['preview', '发布预览版'], ['release', '发布正式版']];
    const text = choice === 'stop' ? '选择暂不合并。' : '批准合并，' + selections.map(([kind, label]) => `${options[kind] ? '已' : '未'}勾选${label}。`).join('');
    assert.equal(message('tell-approval', 'text', { approve }), `功能「修好输入框」：用户${text}`);
    assert.equal(message('tell-approval', 'key', { approve }), `run-1:approve:head-1:${choice}` + selections.map(([kind]) => `:${options[kind] ? kind : 'no-' + kind}`).join(''));
    assert.equal(route('after-approval', { approve }), choice === 'stop' ? 'stopped' : 'premerge');
  }
  for (const [failed, target] of [['checks-failed', 'checks'], ['github-checks-failed', 'github-checks'], ['premerge-failed', 'premerge']]) {
    assert.equal(nodes[failed].attachedToRef.id, target);
    assert.equal(nodes[failed].eventDefinitions[0].$type, 'bpmn:ErrorEventDefinition');
  }
  assert.deepEqual(params('checks'), { kind: 'check', commit: '=pr.head' });
  assert.equal(nodes['checks-github'].targetRef.id, 'github-checks');
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
  for (const [value, target] of [['delivery', 'delivery'], ['review', 'report'], ['premerge', 'premerge']]) assert.equal(route('after-delivery', { 'delivery-result': { route: value } }), target);
  assert.deepEqual(params('premerge'), { kind: 'premerge', commit: '=pr.head' });
  assert.deepEqual(params('deploy'), { kind: 'deploy', commit: '=merge.commit' });
  assert.equal(nodes['approval-premerge'].targetRef.id, 'premerge');
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
  assert.deepEqual(params('publish-preview'), { kind: 'preview', commit: '=merge.commit' });
  assert.deepEqual(params('publish-release'), { kind: 'release', commit: '=merge.commit', inputs: '={ publish: "true" }' });
  assert.deepEqual(evaluate(params('publish-release').inputs.slice(1), {}).value, { publish: 'true' });
  assert.deepEqual(process.flowElements.filter(e => e.action === 'run-workflows').map(e => e.id), ['checks', 'premerge', 'deploy', 'publish-preview', 'publish-release']);
  const options = values(nodes.approve)[0].options;
  assert.deepEqual(options.map(option => [option.id, option.name]), [['deploy', '部署'], ['preview', '发布预览版'], ['release', '发布正式版']]);
  for (const option of options) {
    assert.equal(option.default, undefined);
    for (const deploy of [false, true]) for (const preview of [false, true]) for (const release of [false, true]) {
      const kinds = { deploy, preview, release };
      assert.equal(evaluate(option.shown.slice(1), { kinds }).value, kinds[option.id]);
    }
  }
  const agent = params('execute').AGENT;
  assert.equal(evaluate(agent.slice(1), { inputs: { agent: '' }, github: { event: { coda: { session: { agent: 'codex' } } } } }).value, 'codex');
  assert.equal(evaluate(agent.slice(1), { inputs: { agent: 'kimi' } }).value, 'kimi');
});
