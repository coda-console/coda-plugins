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

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'composer-develop-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const work = join(root, 'work'), origin = join(root, 'origin.git'), bin = join(root, 'bin'), artifacts = join(root, 'artifacts');
  for (const path of [work, bin, artifacts]) mkdirSync(path);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CODA_ARTIFACTS: artifacts, RUNNER_TEMP: root,
    GITHUB_RUN_ID: 'run-1', GITHUB_OUTPUT: join(root, 'outputs'), TITLE: '修好输入框', TASK: '第一项：修好输入框', BASE: '',
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
else if (args[1] === 'view') console.log('f'.repeat(40));
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
  f.run('lane');
  const lane = f.state().lane;
  assert.match(lane, /^lane\/修好输入框-run-1$/);
  assert.equal(f.state().head, latest);
  assert.equal(f.git('ls-remote', 'origin', lane).split('\t')[0], latest);
  f.task('one', 'first answer\nEOF_answer\n继续'); f.run('execute', { MODEL: 'cheap', EFFORT: 'low', MODE: 'auto' });
  const first = f.state().executor;
  assert.equal(f.git('ls-remote', 'origin', lane).split('\t')[0], latest, '执行者不推送');
  const report = f.run('review').outputs;
  assert.equal(report.answer, first.answer); assert.equal(report.branch, first.branch); assert.equal(report.head, first.head);
  const call = f.calls('agent')[0];
  assert.deepEqual(call.args.slice(0, -2), ['--commit', latest, '--title', '修好输入框', '--agent', 'codex', '--model', 'cheap', '--effort', 'low', '--mode', 'auto', '--json']);
  for (const text of ['执行者', '不再委派', 'AGENTS.md', '不推送', '不写防御性、冗余', '不顺手重构', '实际跑了哪些验证', '第一项']) assert.ok(call.prompt.includes(text), text);
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
  assert.equal(f.run('device', { DEVICE: JSON.stringify({ choice: 'no' }) }).outputs.route, 'device');
  assert.equal(f.device('no'), 'device');
  assert.equal(f.device('no', '按钮没有响应'), 'review');
  assert.match(f.run('review').outputs.feedback, /按钮没有响应/);
  f.review('revise', '修复按钮回调'); f.task('two', 'button fixed'); f.run('revise');
  f.review('accept'); assert.equal(f.run('accept').outputs.route, 'preview');
  assert.equal(f.device('yes'), 'pr');
  f.run('pr');
  const created = f.calls('gh').find(c => c.args[1] === 'create');
  assert.deepEqual(created.args.slice(0, 6), ['pr', 'create', '--base', 'main', '--head', lane]);
  for (const answer of ['removed wrapper', 'second answer', 'button fixed']) assert.ok(created.body.includes(answer));
  assert.ok(!created.body.includes('first answer'), '未通过的改动不放进 PR 汇总');
  f.run('pr');
  assert.equal(f.calls('gh').filter(c => c.args[1] === 'create').length, 1);
  assert.equal(f.calls('gh').filter(c => c.args[1] === 'edit').length, 1);
});

test('检查失败回最近执行会话，修好更新 PR 重跑；合并后删除远端泳道并交出合并提交', t => {
  const f = fixture(t); f.run('lane'); f.task('code', 'implementation'); f.run('execute');
  f.review('accept'); f.run('accept'); f.device('yes'); f.run('pr');
  const session = f.state().executor.session;
  for (const step of ['项目检查', '合并前检查']) {
    f.run('check-failed', { STEP: step });
    const feedback = f.run('review').outputs.feedback;
    assert.ok(feedback.includes(step)); assert.ok(feedback.includes(f.state().head));
    assert.match(feedback, /workflow_status.*读取错误和日志/);
    f.review('revise', `${step}：修复断言`); f.task('code', step); f.run('revise');
    assert.equal(f.state().executor.session, session);
    f.review('accept'); assert.equal(f.run('accept').outputs.route, 'pr');
    f.run('pr');
  }
  f.run('merge', { MERGE_EXIT: '1' }, 1);
  assert.equal(f.git('ls-remote', 'origin', f.state().lane).split('\t')[0], f.state().head, '合并失败不删除泳道');
  const merged = f.run('merge').outputs.commit;
  assert.equal(merged, 'f'.repeat(40)); assert.notEqual(merged, f.state().head);
  assert.deepEqual(f.calls('gh').find(c => c.args[1] === 'merge').args,
    ['pr', 'merge', f.state().pr, '--squash', '--match-head-commit', f.state().head]);
  assert.deepEqual(f.calls('gh').find(c => c.args[0] === 'pr' && c.args[1] === 'view').args,
    ['pr', 'view', f.state().pr, '--json', 'mergeCommit', '--jq', '.mergeCommit.oid']);
  assert.equal(f.git('ls-remote', 'origin', f.state().lane), '', '合并成功后清理远端泳道');
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

test('显式 base 与并行功能运行各自建泳道', t => {
  const f = fixture(t); f.git('branch', 'release'); f.git('push', '-q', 'origin', 'release');
  f.run('lane', { BASE: 'release' }); const one = f.state();
  f.run('lane', { BASE: 'release', GITHUB_RUN_ID: 'run-2' }); const two = f.state();
  assert.equal(one.base, 'release'); assert.equal(two.base, 'release'); assert.notEqual(one.lane, two.lane);
  assert.equal(f.calls('gh').length, 0, '有 base 不查默认分支');
});

test('开发流程定义、回路、检查提交与部署选择符合运行契约', async () => {
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
  assert.deepEqual(values(process).filter(v => v.required).map(v => v.name), ['title', 'task']);
  assert.equal(nodes.start.eventDefinitions, undefined, '不订阅旧 PR 生命周期');
  assert.ok(manifest.files.includes('.coda/workflows')); assert.ok(manifest.files.includes('scripts'));
  assert.doesNotMatch(workflow, /review\/scripts|vars\.review/);
  assert.match(nodes.review.documentation[0].text, /git diff \{\{report.lane\}\}\.\.\.\{\{report.head\}\}/);
  assert.equal(nodes.review.assignee, undefined, '默认交给发起会话 Agent');
  assert.equal(nodes.device.assignee, 'user'); assert.equal(nodes.approve.assignee, 'user');
  for (const [value, target] of [['review', 'report'], ['revise', 'revise'], ['accept', 'accept']]) assert.equal(route('how', { decide: { route: value } }), target);
  for (const value of ['execute', 'pr', 'preview']) assert.equal(route('after-accept', { accept: { route: value } }), value);
  for (const [value, target] of [['device', 'device'], ['review', 'report'], ['pr', 'pr']]) assert.equal(route('after-device', { 'device-result': { route: value } }), target);
  for (const [failed, target] of [['checks-failed', 'checks'], ['premerge-failed', 'premerge']]) {
    assert.equal(nodes[failed].attachedToRef.id, target);
    assert.equal(nodes[failed].eventDefinitions[0].$type, 'bpmn:ErrorEventDefinition');
  }
  assert.deepEqual(params('checks'), { kind: 'check', commit: '=pr.head' });
  assert.deepEqual(params('premerge'), { kind: 'premerge', commit: '=pr.head' });
  assert.deepEqual(params('deploy'), { kind: 'deploy', commit: '=merge.commit' });
  assert.equal(nodes['approval-premerge'].targetRef.id, 'premerge');
  assert.equal(route('after-approval', { approve: { chose: { stop: true } } }), 'stopped');
  assert.equal(route('deploy-choice', { approve: { options: { deploy: true } } }), 'deploy');
  assert.equal(route('deploy-choice', { approve: { options: { deploy: false } } }), 'done');
  const option = values(nodes.approve)[0].options[0];
  assert.equal(option.default, undefined);
  for (const deploy of [false, true]) assert.equal(evaluate(option.shown.slice(1), { kinds: { deploy } }).value, deploy);
  const agent = params('execute').AGENT;
  assert.equal(evaluate(agent.slice(1), { inputs: { agent: '' }, github: { event: { coda: { session: { agent: 'codex' } } } } }).value, 'codex');
  assert.equal(evaluate(agent.slice(1), { inputs: { agent: 'kimi' } }).value, 'kimi');
});
