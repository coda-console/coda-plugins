// 泳道 PR（plugins/composer/.coda/workflows/lane-pr.bpmn、scripts/lane-pr.mjs）：临时 Git 仓库、假的 coda-agent 与 gh，
// 网关条件用与引擎同版本的 FEEL 求值。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { readWorkflow } from '@coda-console/protocol/workflow';
import { evaluate } from 'feelin';

const script = fileURLToPath(new URL('../../../plugins/composer/scripts/lane-pr.mjs', import.meta.url));
const workflow = readFileSync(new URL('../../../plugins/composer/.coda/workflows/lane-pr.bpmn', import.meta.url), 'utf8');
// 10.0.0 的流程定义：在途运行按开工时的快照走，脚本却按当前装着的版本取，它引用的动作和输入输出都得留着。
const old = readFileSync(new URL('./fixtures/lane-pr-10.0.0.bpmn', import.meta.url), 'utf8');
const PR = 'https://github.com/example/fixture/pull/7';

function fixture(t, { sync = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'composer-lane-pr-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const work = join(root, 'work'), origin = join(root, 'origin.git'), bin = join(root, 'bin'), artifacts = join(root, 'artifacts');
  for (const path of [work, bin, artifacts]) mkdirSync(path);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CODA_ARTIFACTS: artifacts, RUNNER_TEMP: root,
    GITHUB_RUN_ID: 'pr-run-1', GITHUB_OUTPUT: join(root, 'outputs'), CODA_THREAD_ID: 'thread-1',
    LANE: 'req-1', TITLE: '输入框可以输入', TASK: '## 背景\n\n输入框没反应\n\n## 验收\n- 能输入', SYNC: String(sync),
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
  git('init', '--bare', '-q', origin); git('remote', 'add', 'origin', origin);
  git('push', '-q', 'origin', 'main', 'main:refs/heads/lane/req-1');
  const install = (name, body) => {
    const path = join(bin, name);
    writeFileSync(path, `#!${process.execPath}\n${body}`); chmodSync(path, 0o755);
  };
  install('coda-agent', String.raw`
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
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
if (task.merge) {
  git('fetch', 'origin', task.merge);
  spawnSync('git', ['merge', '--no-commit', 'FETCH_HEAD'], { cwd, encoding: 'utf8' });
}
if (!task.noCommit) { writeFileSync(join(cwd, task.file), task.answer); git('add', '-A'); git('commit', '-qm', task.answer); }
console.log(JSON.stringify({ session, branch, head: git('rev-parse', 'HEAD'), answer: task.answer }));
`);
  install('gh', String.raw`
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2), root = process.env.FIXTURE;
const calls = JSON.parse(readFileSync(join(root, 'gh-calls'), 'utf8'));
const body = args.includes('--body-file') ? readFileSync(args[args.indexOf('--body-file') + 1], 'utf8') : null;
calls.push({ args, body, thread: process.env.CODA_THREAD_ID ?? null }); writeFileSync(join(root, 'gh-calls'), JSON.stringify(calls));
const state = () => JSON.parse(readFileSync(join(process.env.CODA_ARTIFACTS, 'lane-pr.json'), 'utf8'));
if (args[1] === 'create') console.log('${PR}');
else if (args[1] === 'list') { if (process.env.OPEN_PR) console.log(process.env.OPEN_PR); }
else if (args[1] === 'merge') { if (process.env.MERGE_EXIT) process.exit(Number(process.env.MERGE_EXIT)); }
else if (args[1] === 'view' && args.includes('state,headRefOid,mergeCommit')) console.log(JSON.stringify({ state: process.env.PR_STATE || 'OPEN', headRefOid: state().executor.head, mergeCommit: { oid: 'f'.repeat(40) } }));
else if (args[1] === 'view' && args.includes('state,mergeable')) console.log(JSON.stringify({ state: 'OPEN', mergeable: process.env.PR_MERGEABLE || 'MERGEABLE' }));
else if (args[1] === 'view') console.log('f'.repeat(40));
`);
  writeFileSync(join(root, 'agent-calls'), '[]'); writeFileSync(join(root, 'gh-calls'), '[]');
  const state = () => JSON.parse(readFileSync(join(artifacts, 'lane-pr.json'), 'utf8'));
  const calls = name => JSON.parse(readFileSync(join(root, `${name}-calls`), 'utf8'));
  const task = (file, answer, merge) => writeFileSync(join(root, 'agent-task'), JSON.stringify({ file, answer, merge }));
  const run = (action, extra = {}, expected = 0) => {
    writeFileSync(env.GITHUB_OUTPUT, '');
    const result = spawnSync(process.execPath, [script, action], { cwd: work, env: { ...env, ...extra }, encoding: 'utf8' });
    assert.equal(result.status, expected, result.stderr);
    const outputs = Object.fromEntries([...readFileSync(env.GITHUB_OUTPUT, 'utf8').matchAll(/(\w+)<<([^\n]+)\n([\s\S]*?)\n\2\n/g)].map(([, key, , value]) => [key, value]));
    return { ...result, outputs };
  };
  const decide = (choice, note = '', BACKUP = 'false') => run('decide', { REVIEW: JSON.stringify({ choice, note }), BACKUP }).outputs.route;
  const remote = ref => git('ls-remote', 'origin', ref).split('\t')[0];
  // 别的泳道 PR 合进了泳道：在泳道上另提交一个。
  const advanceLane = (file, text) => {
    git('fetch', '-q', 'origin', 'lane/req-1'); git('switch', '-q', '--detach', 'FETCH_HEAD');
    writeFileSync(join(work, file), text); git('add', file); git('commit', '-qm', `lane ${file}`); git('push', '-q', 'origin', 'HEAD:refs/heads/lane/req-1');
    return git('rev-parse', 'HEAD');
  };
  const delivered = () => { run('gate'); run('gate-passed', { RUNS: '[]' }); };
  return { root, work, env, git, run, state, calls, task, decide, remote, advanceLane, delivered };
}

async function definition(source = workflow) {
  const { root, problem } = await readWorkflow(source, 'lane-pr'); assert.ok(!problem, problem);
  const process = root.rootElements.find(e => e.$type === 'bpmn:Process');
  const sub = process.flowElements.find(e => e.id === 'reviews');
  const elements = [...process.flowElements, ...sub.flowElements];
  const nodes = Object.fromEntries(elements.map(e => [e.id, e]));
  const values = node => node.extensionElements?.values ?? [];
  const params = id => Object.fromEntries(values(nodes[id]).map(v => [v.name, v.value]));
  const route = (id, context) => {
    const node = nodes[id], flows = elements.filter(e => e.sourceRef === node);
    return (flows.find(e => e.conditionExpression && evaluate(e.conditionExpression.body.trim().slice(1), context).value) ?? node.default).targetRef.id;
  };
  const next = id => elements.find(e => e.$type === 'bpmn:SequenceFlow' && e.sourceRef === nodes[id]).targetRef.id;
  return { process, sub, elements, nodes, values, params, route, next };
}

test('执行者从泳道当前 head 开工；第一次交付开进泳道的 PR，不带会话、正文含任务原文，之后的交付更新同一个 PR', t => {
  const f = fixture(t);
  const laneHead = f.advanceLane('other', 'other');
  f.task('one', 'first answer'); f.run('execute', { EXECUTOR: JSON.stringify({ agent: 'codex', model: 'cheap', effort: 'low', mode: 'auto', options: { 'fast-mode': true } }) });
  const call = f.calls('agent')[0];
  assert.deepEqual(call.args.slice(0, -2), ['--commit', laneHead, '--title', '输入框可以输入', '--agent', 'codex', '--model', 'cheap', '--effort', 'low', '--mode', 'auto',
    '--option', 'fast-mode=true', '--json']);
  for (const text of ['执行者', '不再委派', 'AGENTS.md', '不推送', '不写防御性、冗余', '只跑与改动直接相关的快检查', '输入框没反应']) assert.ok(call.prompt.includes(text), text);
  assert.ok(!call.prompt.includes('跟上目标分支'), '普通泳道 PR 不带跟上目标分支的说明');
  const head = f.run('gate').outputs.head;
  assert.equal(head, f.state().executor.head);
  assert.equal(f.remote('lane-pr/pr-run-1'), head);
  assert.equal(f.remote('lane/req-1'), laneHead, '泳道不动');
  const created = f.calls('gh').filter(c => c.args[1] === 'create');
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].args.slice(0, 8), ['pr', 'create', '--base', 'lane/req-1', '--head', 'lane-pr/pr-run-1', '--title', '输入框可以输入']);
  assert.equal(created[0].thread, null, '不带会话开 PR，PR 观察不会因此启动 PR 生命流程');
  assert.ok(created[0].body.includes(f.env.TASK), '正文含任务原文');
  assert.equal(f.state().pr, PR);
  assert.equal(f.run('review').outputs.pr, PR);

  assert.equal(f.decide('revise', '删除多余封装'), 'revise');
  f.task('one', 'removed wrapper'); f.run('revise');
  assert.deepEqual(f.calls('agent')[1].args.slice(0, -2), ['--continue', 'worker-1', '--json']);
  const updated = f.run('gate').outputs.head;
  assert.notEqual(updated, head);
  assert.equal(f.remote('lane-pr/pr-run-1'), updated, '推同一个分支就是更新同一个 PR');
  assert.equal(f.calls('gh').filter(c => c.args[1] === 'create').length, 1);
});

test('从头重跑时 gate 先从 GitHub 找已开的进泳道 PR，找到就沿用，不再开', t => {
  const f = fixture(t);
  f.task('one', 'change'); f.run('execute');
  f.run('gate', { OPEN_PR: PR });
  assert.deepEqual(f.calls('gh').find(c => c.args[1] === 'list').args,
    ['pr', 'list', '--head', 'lane-pr/pr-run-1', '--base', 'lane/req-1', '--state', 'open', '--limit', '1', '--json', 'url', '--jq', '.[].url']);
  assert.equal(f.calls('gh').filter(c => c.args[1] === 'create').length, 0);
  assert.equal(f.state().pr, PR);
  f.run('gate');
  assert.equal(f.calls('gh').filter(c => c.args[1] === 'list').length, 1, '记下之后不再找');
});

test('合进泳道后泳道又前进了，从失败处重跑 land 仍交出原结果，不再改 PR 或泳道；PR 已关闭未合并时报错', t => {
  for (const sync of [false, true]) {
    const f = fixture(t, { sync });
    f.task('one', 'change'); f.run('execute'); f.delivered();
    const first = f.run('land').outputs;
    assert.equal(first.route, 'landed');
    // 后来合进泳道的改了同一个文件：重新试合并会冲突，只有先认终态才不走错。
    const moved = f.advanceLane('one', 'later lane PR');
    // squash 的 GitHub 已标为合并；快进的可能还没标，按这次交付已是泳道的祖先认。
    assert.deepEqual(f.run('land', { PR_STATE: sync ? 'OPEN' : 'MERGED' }).outputs, first, `sync=${sync}`);
    assert.equal(f.remote('lane/req-1'), moved, '泳道不动');
    assert.equal(f.calls('gh').filter(c => c.args[1] === 'merge').length, sync ? 0 : 1);
    assert.match(f.run('land', { PR_STATE: 'CLOSED' }, 1).stderr, /PR 已关闭但未合并/);
  }
});

test('普通泳道 PR：合进泳道前试合并泳道当前 head，干净时 squash 合进泳道并删除分支，输出 PR 与合并提交', t => {
  const f = fixture(t);
  f.task('one', 'change'); f.run('execute'); f.delivered();
  f.advanceLane('other', 'other');
  assert.equal(f.decide('land'), 'land');
  const landed = f.run('land').outputs;
  assert.deepEqual(landed, { route: 'landed', pr: PR, commit: 'f'.repeat(40) });
  const merge = f.calls('gh').find(c => c.args[1] === 'merge');
  assert.deepEqual(merge.args, ['pr', 'merge', PR, '--repo', 'github.com/example/fixture', '--squash', '--match-head-commit', f.state().executor.head, '--delete-branch']);
  // 已合并（重跑这一步）时不再合并，直接给原合并提交。
  assert.deepEqual(f.run('land', { PR_STATE: 'MERGED' }).outputs, landed);
  assert.equal(f.calls('gh').filter(c => c.args[1] === 'merge').length, 1);
});

test('合进泳道前试合并发现冲突：泳道不动，同一执行会话收到泳道与冲突文件，不算退回；合并泳道后再合进去', t => {
  const f = fixture(t);
  f.task('base', 'worker change'); f.run('execute'); f.delivered();
  const session = f.state().executor.session;
  const laneHead = f.advanceLane('base', 'other lane PR');
  f.decide('land');
  assert.deepEqual(f.run('land').outputs, { route: 'sync' });
  assert.equal(f.remote('lane/req-1'), laneHead, '泳道没动');
  assert.equal(f.calls('gh').filter(c => c.args[1] === 'merge').length, 0);
  const feedback = f.run('review').outputs.feedback;
  for (const text of ['泳道是 lane/req-1', 'git fetch origin lane/req-1', '合并（merge）', '不要变基', '顺延', '冲突的文件', '- base']) assert.ok(feedback.includes(text), text);
  assert.equal(f.run('review').outputs.returns, '0');
  f.task('base', 'resolved', 'lane/req-1'); f.run('revise');
  assert.equal(f.state().executor.session, session);
  assert.ok(f.calls('agent').at(-1).prompt.includes('- base'));
  f.git('merge-base', '--is-ancestor', laneHead, f.state().executor.head);
  f.delivered();
  assert.equal(f.run('land').outputs.route, 'landed');
});

test('GitHub 合并时报冲突也交回执行者合并泳道；其余合并失败保留退出码', t => {
  const f = fixture(t);
  f.task('one', 'change'); f.run('execute'); f.delivered();
  assert.deepEqual(f.run('land', { MERGE_EXIT: '1', PR_MERGEABLE: 'CONFLICTING' }).outputs, { route: 'sync' });
  assert.match(f.state().feedback, /git fetch origin lane\/req-1/);
  f.run('land', { MERGE_EXIT: '7' }, 7);
});

test('跟上目标分支的泳道 PR：执行者收到只合并不变基的说明；合进泳道时快进泳道到它的 head，不 squash', t => {
  const f = fixture(t, { sync: true });
  f.git('switch', '-q', 'main');
  writeFileSync(join(f.work, 'main-change'), 'main'); f.git('add', 'main-change'); f.git('commit', '-qm', 'main moved'); f.git('push', '-q', 'origin', 'main');
  const main = f.git('rev-parse', 'HEAD');
  f.task('migration', 'merged main', 'main'); f.run('execute');
  for (const text of ['跟上目标分支', '合并（merge）', '不要变基', '快进', '祖先关系', '顺延泳道这边的']) assert.ok(f.calls('agent')[0].prompt.includes(text), text);
  const head = f.state().executor.head;
  f.git('merge-base', '--is-ancestor', main, head);
  f.delivered();
  assert.match(f.calls('gh').find(c => c.args[1] === 'create').args.join(' '), /--base lane\/req-1/);
  assert.deepEqual(f.run('land').outputs, { route: 'landed', pr: PR, commit: head });
  assert.equal(f.remote('lane/req-1'), head, '泳道快进到它的 head');
  f.git('merge-base', '--is-ancestor', main, f.remote('lane/req-1'));
  assert.equal(f.calls('gh').filter(c => c.args[1] === 'merge').length, 0, '不 squash');
});

test('跟上目标分支的泳道 PR：泳道 head 不是它的祖先时不推送，交回执行者先合并泳道', t => {
  const f = fixture(t, { sync: true });
  f.task('one', 'merged main'); f.run('execute'); f.delivered();
  const laneHead = f.advanceLane('other', 'other');
  assert.deepEqual(f.run('land').outputs, { route: 'sync' });
  assert.equal(f.remote('lane/req-1'), laneHead);
  assert.match(f.state().feedback, /泳道是 lane\/req-1/);
  assert.ok(!f.state().feedback.includes('冲突的文件'), '能干净合并，只是不能快进');
  f.task('two', 'merged lane', 'lane/req-1'); f.run('revise'); f.delivered();
  assert.equal(f.run('land').outputs.route, 'landed');
  assert.equal(f.remote('lane/req-1'), f.state().executor.head);
});

test('审查答复：退回和换人必须写备注，没填备用执行者不能换，合并泳道备注可选；退回次数只数退回修改', t => {
  const f = fixture(t);
  f.task('code', 'first'); f.run('execute'); f.delivered();
  const laneHead = f.remote('lane/req-1'), first = f.state().executor;
  for (const [choice, note, backup, text] of [['revise', '  ', 'true', /退回修改必须/], ['swap', '', 'true', /换备用执行者重做必须/], ['swap', '换人', 'false', /没有填备用执行者/]]) {
    assert.equal(f.decide(choice, note, backup), 'review');
    assert.match(f.run('review').outputs.feedback, text);
  }
  assert.equal(f.run('review').outputs.returns, '0');
  assert.equal(f.decide('revise', '改一下'), 'revise');
  assert.equal(f.run('review').outputs.returns, '1');
  f.task('code', 'second'); f.run('revise');
  assert.equal(f.decide('sync'), 'revise');
  assert.ok(f.state().feedback.startsWith('泳道是 lane/req-1'));
  assert.ok(!f.state().feedback.includes('主 Agent 的备注'));
  assert.equal(f.decide('sync', '版本号会撞'), 'revise');
  assert.ok(f.state().feedback.endsWith('主 Agent 的备注：\n版本号会撞'));
  f.task('code', 'third'); f.run('revise');
  assert.equal(f.run('review').outputs.returns, '1', '合并泳道不算退回');

  assert.equal(f.decide('swap', '上一位绕远了', 'true'), 'swap');
  f.task('redo', 'redo'); f.run('swap', { EXECUTOR: JSON.stringify({ agent: 'backup', model: 'm2' }) });
  const call = f.calls('agent').at(-1);
  assert.deepEqual(call.args.slice(0, -2), ['--commit', laneHead, '--title', '输入框可以输入', '--agent', 'backup', '--model', 'm2', '--json']);
  for (const text of ['输入框没反应', '上一位绕远了', first.branch, '可以参考，也可以不用']) assert.ok(call.prompt.includes(text), text);
  assert.equal(f.run('review').outputs.returns, '1', '换人不算退回');
  assert.equal(f.decide('abandon'), 'abandon');
});

test('审查前检查失败自动续作同一会话，连续三次交回主 Agent；通过后记录检查给审查卡和评审', t => {
  const f = fixture(t); f.task('code', 'first'); f.run('execute');
  const session = f.state().executor.session;
  for (let i = 1; i <= 3; i++) {
    f.run('gate');
    assert.equal(f.run('gate-failed').outputs.route, i === 3 ? 'review' : 'revise');
    if (i < 3) { f.task('code', `fix ${i}`); f.run('revise'); assert.equal(f.state().executor.session, session); }
  }
  assert.equal(f.run('review').outputs.feedback.split('项目检查未通过').length - 1, 3);
  const passed = f.run('gate-passed', { RUNS: JSON.stringify([{ workflow: 'test', state: 'succeeded', runId: 'check-1' }]) }).outputs;
  assert.deepEqual(passed, { base: f.remote('lane/req-1'), task: f.env.TASK, checks: 'test: succeeded coda://workflow-runs/check-1' });
  assert.equal(f.run('review').outputs.checks, passed.checks);
});

test('放弃：关闭 PR 并删除分支，泳道不动', t => {
  const f = fixture(t); f.task('code', 'first'); f.run('execute'); f.delivered();
  const laneHead = f.remote('lane/req-1');
  assert.deepEqual(f.run('abandon').outputs, { pr: PR });
  assert.deepEqual(f.calls('gh').at(-1).args, ['pr', 'close', PR, '--repo', 'github.com/example/fixture', '--delete-branch']);
  assert.equal(f.remote('lane/req-1'), laneHead);
});

test('审查材料带上评审者的结果，只取评这次交付的', t => {
  const f = fixture(t); f.task('code', 'first'); f.run('execute');
  const head = f.state().executor.head, path = join(f.env.CODA_ARTIFACTS, 'reviews.md');
  const reviews = [
    { state: 'done', slot: 'reviewer', who: JSON.stringify({ agent: 'a1', model: 'm1' }), head, decision: 'REQUEST_CHANGES', line: '有一个要改',
      findings: JSON.stringify([{ severity: 'P1', title: '漏了失败路径', location: 'a.mjs:1', detail: '说明' }]), report: '原文' },
    { state: 'lost', slot: 'reviewer2', who: JSON.stringify({ agent: 'a2' }), head },
    { state: 'skipped' },
  ];
  assert.equal(f.run('review', { REVIEWS: JSON.stringify(reviews) }).outputs.reviews, [
    '评审者（a1 · m1）：有一个要改\n- [P1] 漏了失败路径（a.mjs:1）\n  说明',
    '第二评审者（a2）：没评成。调用 review-commit 没有成功，原因见本运行 coda://workflow-runs/pr-run-1 的「评审这次交付」（workflow_status）。',
  ].join('\n\n') + `\n评审原文：${path}`);
  f.task('code', 'second'); f.run('revise');
  assert.equal(f.run('review', { REVIEWS: JSON.stringify(reviews) }).outputs.reviews, '', '评的不是这次交付时不带');
});

test('泳道 PR 流程定义：输入、回路、审查卡答复、结束输出；不出用户卡、不装机、不部署、不跑合并前检查', async () => {
  const { process, sub, elements, nodes, values, params, route, next } = await definition();
  assert.equal(process.name, '泳道 PR'); assert.equal(process.kind, undefined, '不是一种开发流程实现');
  const inputs = Object.fromEntries(values(process).map(v => [v.name, v]));
  assert.deepEqual(Object.keys(inputs), ['lane', 'title', 'task', 'sync', 'executor', 'executor2', 'reviewer', 'reviewer2']);
  for (const name of ['lane', 'title', 'task']) assert.equal(inputs[name].required, true, name);
  assert.deepEqual([inputs.sync.type, inputs.sync.default], ['boolean', 'false']);
  // 必填且没有默认值：引擎 resolveInputs 对没给、又无默认的 required 输入在启动时报「需要参数 executor」，不再落到发起会话。
  assert.deepEqual([inputs.executor.type, inputs.executor.required, inputs.executor.default, inputs.executor.defaultFrom], ['agent', true, undefined, undefined]);
  for (const name of ['executor2', 'reviewer', 'reviewer2']) assert.deepEqual([inputs[name].type, inputs[name].default, inputs[name].required], ['agent', undefined, undefined], name);
  assert.deepEqual(Object.fromEntries(Object.entries(params('execute')).filter(([k]) => k !== 'EXECUTOR')), { LANE: '=inputs.lane', TITLE: '=inputs.title', TASK: '=inputs.task', SYNC: '=inputs.sync' });
  // 执行者只来自 inputs.executor，没有取发起会话的回退；引擎把 env 里的对象转成 JSON 文本，脚本再解析。
  assert.equal(params('execute').EXECUTOR, '=inputs.executor');
  const executor = { agent: 'codex', model: 'gpt-6' };
  assert.deepEqual(JSON.parse(JSON.stringify(evaluate(params('execute').EXECUTOR.slice(1), { inputs: { executor } }).value)), executor);
  assert.equal(params('swap').EXECUTOR, '=inputs.executor2');

  assert.deepEqual(elements.filter(e => e.$type === 'bpmn:UserTask').map(e => [e.id, e.assignee]), [['review', undefined]], '只有交给主 Agent 的审查卡');
  assert.deepEqual(elements.filter(e => e.action === 'run-workflows').map(e => [e.id, params(e.id).hook, params(e.id).commit]), [['checks', 'check', '=gate.head']]);
  assert.ok(!elements.some(e => ['hold-group', 'tell-session', 'workflow-kinds'].includes(e.action)));
  assert.deepEqual(values(nodes.review).map(v => [v.id, v.name]), [['revise', '退回修改'], ['sync', '让执行者合并泳道'], ['swap', '换备用执行者重做'], ['land', '合进泳道'], ['abandon', '放弃']]);
  for (const [value, target] of [['review', 'rounds'], ['revise', 'revise'], ['swap', 'swap'], ['abandon', 'abandon'], ['land', 'land']]) assert.equal(route('how', { decide: { route: value } }), target);
  assert.equal(next('rounds'), 'report', '每次出审查卡前先整理收敛经过');
  for (const id of ['execute', 'revise', 'swap']) assert.equal(next(id), 'gate');
  assert.equal(next('gate'), 'checks');
  assert.equal(next('checks'), 'gate-passed');
  assert.equal(next('gate-passed'), 'review-round');
  assert.equal(next('review-round'), 'reviews-choice');
  assert.equal(nodes['checks-failed'].attachedToRef.id, 'checks');
  assert.equal(route('gate-route', { 'check-feedback': { route: 'review' } }), 'rounds', '连续三次检查失败交回主 Agent，不评审');
  assert.equal(route('gate-route', { 'check-feedback': { route: 'revise' } }), 'revise');
  assert.equal(route('after-land', { land: { route: 'sync' } }), 'revise', '冲突交回同一个执行会话');
  assert.equal(route('after-land', { land: { route: 'landed' } }), 'landed');
  for (const id of ['landed', 'abandoned']) assert.equal(nodes[id].notify, 'true', `${id} 结果回发起会话`);
  assert.deepEqual(values(nodes.landed).map(v => [v.name, v.value]), [['pr', '=land.pr'], ['commit', '=land.commit']]);
  assert.deepEqual(values(nodes.abandoned).map(v => [v.name, v.value]), [['pr', '=abandon.pr']]);
  for (const [sync, text] of [[false, 'squash 合进泳道并删除分支'], [true, '把泳道快进到这次交付']]) {
    const expression = [...nodes.review.documentation[0].text.matchAll(/{{(.*?)}}/g)].find(m => m[1].includes('inputs.sync'))[1];
    assert.ok(evaluate(expression, { inputs: { sync } }).value.includes(text));
  }

  // 评审：两个位置各一份，填了的评每一次交付；没有只评第一次交付的位置。
  assert.equal(sub.optional, true);
  assert.equal(nodes['review-call'].calledElement, 'review-commit');
  assert.deepEqual(params('review-call'), { base: '=review-round.base', head: '=review-round.head', task: '=review-round.task', reviewer: '=slot.who', evidence: '=review-round.checks', previous: '=slot.previous' });
  for (const [reviewers, target] of [[{ reviewer: { agent: 'a1' } }, 'reviews'], [{ reviewer2: { agent: 'a2' } }, 'reviews'], [{}, 'rounds']]) {
    assert.equal(route('reviews-choice', { inputs: { reviewer: null, reviewer2: null, ...reviewers } }), target);
  }
  const slots = evaluate(sub.loopCharacteristics.inputCollection.slice(1), { inputs: { reviewer: { agent: 'a1' }, reviewer2: null }, 'review-round': { previous: '[]', previous2: '' } }).value;
  assert.deepEqual(slots.map(s => [s.slot, s.who, s.previous]), [['reviewer', { agent: 'a1' }, '[]'], ['reviewer2', null, '']]);
  assert.doesNotMatch(workflow, /reviewerOnce|首次评审|\.first\b/);
  for (const [title, expected] of [['补齐状态', '泳道 PR：补齐状态']]) assert.equal(evaluate(process.title.slice(1), { inputs: { title } }).value, expected);
  // 流程只定位置，不写 Ultra 或模型的知识。
  assert.doesNotMatch(workflow, /ultra|codex|claude|kimi|grok|opencode|cursor|gpt|sonnet|opus|haiku|gemini/i);
});

// 评审子流程一份的输出（review-commit 的结果加位置、评的 head）。
const reviewed = (slot, head, findings, extra = {}) => ({ state: 'done', slot, who: JSON.stringify({ agent: slot }), head, reviewed: head,
  decision: 'REQUEST_CHANGES', line: '要改', findings: JSON.stringify(findings), report: '原文', resolutions: '[]', blocking: 'P2', ...extra });
const BUG = { severity: 'P2', kind: 'correctness', title: '漏了失败路径', location: 'one:1', detail: '失败时没有退出码' };
const answer = (text, responses) => `${text}\n\n\`\`\`responses\n${JSON.stringify({ responses })}\n\`\`\``;

test('执行者固定说明：只跑涉及的测试文件，验证命令传出原始退出码，改坏验证只跑命中的用例，结果自己送回、不另起 Monitor', t => {
  const f = fixture(t); f.task('one', 'first'); f.run('execute');
  const prompt = f.calls('agent')[0].prompt;
  // run-held 在 zsh 里执行，status 是 zsh 的只读变量：退出码变量必须叫别的名字。
  assert.doesNotMatch(prompt, /\bstatus=/);
  for (const text of ['只跑改动直接涉及的测试文件', '不跑无文件参数的 `check.sh backend`、`--all`、完整 workflows 套件、客户端编译，任务明确要求的除外',
    '验证命令必须把原始检查的退出码传出去', 'rc=0; <检查> > "$log" 2>&1 || rc=$?; tail -n 80 "$log"; exit "$rc"',
    '改坏验证（故意改错看测试红）只跑命中的那个用例，沿用默认时限；挂住了先定位原因，不要调大时限重跑',
    '不能只 echo 退出码，不能让最后一条 tail / grep / cmp 决定成败', 'run-held 和流程运行的结果会自己送回，不要另起 Monitor 或后台任务去盯日志']) assert.ok(prompt.includes(text), text);
});

test('评审有阻塞级发现：同一执行会话逐条处理，有新提交就推送、检查后增量复评，收敛了才交主 Agent，卡上附收敛经过', t => {
  const f = fixture(t); f.task('one', 'first'); f.run('execute'); f.delivered();
  const first = f.state().executor.head, lane = f.remote('lane/req-1');
  const full = f.run('review-round').outputs;
  assert.deepEqual(full, { base: lane, head: first, task: f.env.TASK, checks: '此提交未声明项目检查流程。', previous: '', previous2: '' }, '第一次是完整评审');
  assert.equal(f.run('triage', { REVIEWS: JSON.stringify([reviewed('reviewer', first, [BUG]), { state: 'skipped' }]) }).outputs.route, 'fix');

  writeFileSync(join(f.root, 'agent-task'), JSON.stringify({ file: 'one', answer: answer('修好了', [{ id: 'reviewer:1', disposition: 'fixed', commit: 'c1', reason: '加了退出码' }]) }));
  assert.equal(f.run('address').outputs.route, 'gate');
  const call = f.calls('agent').at(-1), second = f.state().executor.head;
  assert.deepEqual(call.args.slice(0, -2), ['--continue', 'worker-1', '--json']);
  for (const text of ['不再委派', `提交 ${first}`, '- reviewer:1 [P2·correctness·阻塞] 漏了失败路径（one:1）', '失败时没有退出码', 'fixed', 'disputed', '三个反引号加 responses']) assert.ok(call.prompt.includes(text), text);
  assert.notEqual(second, first);

  f.delivered();
  const again = f.run('review-round').outputs;
  assert.deepEqual([again.base, again.head, again.previous2], [first, second, '[]'], '增量复评：base 是上次评过的 head');
  assert.deepEqual(JSON.parse(again.previous), [{ ...BUG, id: 'reviewer:1', response: { disposition: 'fixed', commit: 'c1', reason: '加了退出码', evidence: '' } }]);

  const resolutions = JSON.stringify([{ id: 'reviewer:1', status: 'resolved', reason: '修好了' }]);
  assert.equal(f.run('triage', { REVIEWS: JSON.stringify([reviewed('reviewer', second, [], { decision: 'APPROVE', resolutions })]) }).outputs.route, 'review');
  const text = f.run('rounds').outputs.text;
  for (const part of [`评审（head ${first.slice(0, 12)}）：`, '结论：交执行者逐条修复或反驳', '- reviewer:1：fixed c1，加了退出码', `复评（head ${second.slice(0, 12)}）：`,
    '- reviewer:1 → resolved：修好了', '结论：没有阻塞级发现，交主 Agent 审查', `全文：${join(f.env.CODA_ARTIFACTS, 'converge.md')}`]) assert.ok(text.includes(part), part);
  assert.equal(f.run('review').outputs.returns, '0', '自动修不算退回');
});

test('只反驳、没有新提交：不重跑检查，直接交原评审者确认；评审者坚持就升级；既不修也不反驳直接交主 Agent', t => {
  const f = fixture(t); f.task('one', 'first'); f.run('execute'); f.delivered();
  const head = f.state().executor.head;
  f.run('review-round');
  f.run('triage', { REVIEWS: JSON.stringify([reviewed('reviewer', head, [BUG]), reviewed('reviewer2', head, [{ ...BUG, severity: 'P3', kind: 'style' }], { decision: 'COMMENT' })]) });
  writeFileSync(join(f.root, 'agent-task'), JSON.stringify({ noCommit: true, answer: answer('不成立', [{ id: 'reviewer:1', disposition: 'disputed', reason: '有退出码', evidence: 'one:3' }]) }));
  assert.equal(f.run('address').outputs.route, 'again');
  const pushes = f.calls('gh').length;
  const again = f.run('review-round').outputs;
  assert.deepEqual([again.base, again.head], [head, head]);
  assert.deepEqual(JSON.parse(again.previous).map(p => [p.id, p.response.disposition]), [['reviewer:1', 'disputed']]);
  assert.deepEqual(JSON.parse(again.previous2).map(p => [p.id, p.response]), [['reviewer2:1', undefined]], '没回应的那条也交复评');
  const upheld = JSON.stringify([{ id: 'reviewer:1', status: 'upheld', reason: '还是没有' }]);
  assert.equal(f.run('triage', { REVIEWS: JSON.stringify([reviewed('reviewer', head, [], { resolutions: upheld }),
    reviewed('reviewer2', head, [], { decision: 'APPROVE', resolutions: JSON.stringify([{ id: 'reviewer2:1', status: 'resolved' }]) })]) }).outputs.route, 'review');
  assert.equal(f.calls('gh').length, pushes, '没有推送、没有开 PR');
  assert.match(f.run('rounds').outputs.text, /升级给主 Agent：reviewer:1：执行者反驳了，评审者仍坚持/);

  // 主 Agent 退回后重新完整评审，再一次：执行者既没有新提交也没有反驳。
  f.decide('revise', '改一下'); f.task('one', 'second'); f.run('revise'); f.delivered();
  const second = f.state().executor.head;
  assert.deepEqual(f.run('review-round').outputs.previous, '', '审查卡之后是完整评审');
  f.run('triage', { REVIEWS: JSON.stringify([reviewed('reviewer', second, [BUG])]) });
  assert.deepEqual(f.state().converge.findings.map(x => [x.id, x.status]), [['reviewer:1', 'superseded'], ['reviewer2:1', 'resolved'], ['reviewer:2', 'open']]);
  writeFileSync(join(f.root, 'agent-task'), JSON.stringify({ noCommit: true, answer: '看了' }));
  assert.equal(f.run('address').outputs.route, 'review');
  assert.match(f.run('rounds').outputs.text, /- reviewer:2：没有按格式回应\n结论：执行者没有新提交，也没有反驳，升级给主 Agent/);
});

test('修的新提交检查连续失败交主 Agent 后，之后的评审回到完整评审', t => {
  const f = fixture(t); f.task('one', 'first'); f.run('execute'); f.delivered();
  f.run('review-round');
  f.run('triage', { REVIEWS: JSON.stringify([reviewed('reviewer', f.state().executor.head, [BUG])]) });
  f.task('one', 'fix'); assert.equal(f.run('address').outputs.route, 'gate');
  for (let i = 0; i < 3; i++) { f.run('gate'); f.run('gate-failed'); }
  f.run('rounds');
  f.decide('revise', '先把检查修好'); f.task('one', 'checked'); f.run('revise'); f.delivered();
  assert.deepEqual(f.run('review-round').outputs.base, f.remote('lane/req-1'));
});

test('新流程定义：评审之后分流，交执行者的回路与升级都回到审查卡；审查卡答复不变', async () => {
  const { nodes, params, route, next, values } = await definition();
  assert.deepEqual(params('triage'), { REVIEWS: '=reviews', route: undefined });
  assert.equal(next('reviews'), 'triage');
  assert.equal(route('triage-route', { triage: { route: 'fix' } }), 'address');
  assert.equal(route('triage-route', { triage: { route: 'review' } }), 'rounds');
  for (const [value, target] of [['gate', 'gate'], ['again', 'review-round'], ['review', 'rounds']]) assert.equal(route('address-route', { address: { route: value } }), target, value);
  assert.equal(nodes.address.checkout, undefined, '和 revise 一样在执行会话里改');
  assert.deepEqual(Object.fromEntries(values(nodes['review-done']).map(v => [v.name, v.value])), {
    state: 'done', slot: '=slot.slot', who: '=slot.who', head: '=review-round.head', decision: '=review-call.decision', line: '=review-call.line',
    findings: '=review-call.findings', report: '=review-call.report', reviewed: '=review-call.head', resolutions: '=review-call.resolutions', blocking: '=review-call.blocking' });
  const old = await definition(oldSource());
  assert.deepEqual(values(nodes.review).map(v => [v.id, v.name]), values(old.nodes.review).map(v => [v.id, v.name]), '审查卡答复不变');
  const card = nodes.review.documentation[0].text, expression = [...card.matchAll(/{{(.*?)}}/g)].find(m => m[1].includes('rounds.text'))[1];
  assert.equal(evaluate(expression, { rounds: { text: '' } }).value, '');
  assert.match(evaluate(expression, { rounds: { text: '经过' } }).value, /^\n收敛经过（.*）：\n经过$/);
});

function oldSource() { return old; }

// 旧定义里每个脚本步骤：动作名、env 与输出。
const steps = source => [...source.matchAll(/<scriptTask id="([^"]+)"[\s\S]*?<\/scriptTask>/g)].map(([text, id]) => ({ id,
  action: /lane-pr\.mjs" ([\w-]+)</.exec(text)[1], env: [...text.matchAll(/<coda:env name="(\w+)"/g)].map(m => m[1]), outputs: [...text.matchAll(/<coda:output name="(\w+)"/g)].map(m => m[1]) }));

test('10.0.0 的流程定义：它引用的每个动作新脚本都还有，env 与输出不变，照它的顺序走得通', t => {
  const before = steps(old), now = steps(workflow), source = readFileSync(script, 'utf8');
  assert.deepEqual(before.map(s => s.action), ['execute', 'gate', 'gate-failed', 'gate-passed', 'review', 'decide', 'revise', 'swap', 'land', 'abandon']);
  for (const step of before) {
    assert.ok(source.includes(`case '${step.action}':`), step.action);
    const same = now.find(s => s.id === step.id);
    assert.deepEqual([same.action, same.env, same.outputs], [step.action, step.env, step.outputs], step.id);
  }
  // 旧定义调用 review-commit 用的参数，新能力都还收，新加的都不必填。
  const capability = readFileSync(new URL('../../../plugins/review/.coda/capabilities/review-commit.bpmn', import.meta.url), 'utf8');
  const inputs = Object.fromEntries([...capability.matchAll(/<coda:input name="(\w+)"([^>]*)\/>/g)].map(m => [m[1], m[2].includes('required="true"')]));
  const passed = [...old.matchAll(/<callActivity[\s\S]*?<\/callActivity>/g)][0][0].matchAll(/<coda:param name="(\w+)"/g);
  const given = [...passed].map(m => m[1]);
  for (const name of given) assert.ok(name in inputs, name);
  assert.deepEqual(Object.keys(inputs).filter(name => inputs[name] && !given.includes(name)), []);

  // 照旧定义的路径跑一遍：每步给出的输出正是旧定义声明的。
  const f = fixture(t), declared = Object.fromEntries(before.map(s => [s.action, s.outputs]));
  const check = (action, extra, expected) => assert.deepEqual(Object.keys(f.run(action, extra, expected).outputs).sort(), [...declared[action]].sort(), action);
  f.task('one', 'first'); check('execute');
  check('gate'); check('gate-failed'); f.task('one', 'second'); check('revise');
  check('gate'); check('gate-passed', { RUNS: '[]' });
  check('review', { REVIEWS: JSON.stringify([reviewed('reviewer', f.state().executor.head, [BUG])]) });
  f.run('decide', { REVIEW: JSON.stringify({ choice: 'swap', note: '换人' }), BACKUP: 'true' });
  check('decide', { REVIEW: JSON.stringify({ choice: 'land', note: '' }), BACKUP: 'false' });
  f.task('two', 'redo'); check('swap'); f.run('gate'); f.run('gate-passed', { RUNS: '[]' });
  check('land'); check('abandon');
});
