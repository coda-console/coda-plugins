// 块（plugins/composer/.coda/workflows/piece.bpmn、scripts/piece.mjs）：临时 Git 仓库、假的 coda-agent，gh 只记调用（块不开 PR），
// 网关条件用与引擎同版本的 FEEL 求值；脚本输出先照引擎把 "true"/"false" 变成布尔值。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { readWorkflow } from '@coda-console/protocol/workflow';
import { evaluate } from 'feelin';
import { evaluateTyped } from './feel.mjs';

const script = fileURLToPath(new URL('../../../plugins/composer/scripts/piece.mjs', import.meta.url));
const workflow = readFileSync(new URL('../../../plugins/composer/.coda/workflows/piece.bpmn', import.meta.url), 'utf8');
const BRANCH = 'req/develop-1', TEMP = 'piece/pr-run-1';

function fixture(t, { sync = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'composer-piece-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const work = join(root, 'work'), origin = join(root, 'origin.git'), bin = join(root, 'bin'), artifacts = join(root, 'artifacts');
  for (const path of [work, bin, artifacts]) mkdirSync(path);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CODA_ARTIFACTS: artifacts, RUNNER_TEMP: root,
    GITHUB_RUN_ID: 'pr-run-1', GITHUB_OUTPUT: join(root, 'outputs'), CODA_THREAD_ID: 'thread-1',
    BRANCH, BASE: 'main', TITLE: '输入框可以输入', TASK: '## 背景\n\n输入框没反应\n\n## 验收\n- 能输入', SYNC: String(sync),
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
  git('push', '-q', 'origin', 'main', `main:refs/heads/${BRANCH}`);
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
if (task.exit && task.silent) process.exit(task.exit);
const continued = args.includes('--continue');
// lost：记下的会话接不回（被删了），--continue 一律非零退出、没有输出。
if (task.lost && continued) process.exit(1);
const session = continued ? value('--continue') : 'worker-' + calls.length;
const branch = 'agent/' + session, cwd = join(root, session);
const git = (...params) => execFileSync('git', params, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
if (!continued) execFileSync('git', ['worktree', 'add', '-b', branch, cwd, value('--commit')], { stdio: 'pipe' });
// garbage：会话开成了，但标准输出不是完整回复。
if (task.garbage) { console.log(task.garbage); process.exit(0); }
if (task.merge) {
  git('fetch', 'origin', task.merge);
  spawnSync('git', ['merge', '--no-commit', 'FETCH_HEAD'], { cwd, encoding: 'utf8' });
}
// extra：先另提交一个，交付就有两个提交。
if (task.extra) { writeFileSync(join(cwd, task.extra), task.extra); git('add', '-A'); git('commit', '-qm', task.extra); }
if (!task.noCommit) { writeFileSync(join(cwd, task.file), task.answer); git('add', '-A'); git('commit', '-qm', task.answer); }
// 会话失败时 coda-agent 照样在标准输出给出会话（工作已提交）、以非零退出；silent 是连会话都没开成。
console.log(JSON.stringify({ session, branch, head: git('rev-parse', 'HEAD'), answer: task.answer }));
process.exit(task.exit ?? 0);
`);
  // 块不用 gh：只记下调用，任何调用都算错。
  install('gh', String.raw`
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const path = join(process.env.FIXTURE, 'gh-calls');
writeFileSync(path, JSON.stringify([...JSON.parse(readFileSync(path, 'utf8')), process.argv.slice(2)]));
process.exit(1);
`);
  writeFileSync(join(root, 'agent-calls'), '[]'); writeFileSync(join(root, 'gh-calls'), '[]');
  const state = () => JSON.parse(readFileSync(join(artifacts, 'piece.json'), 'utf8'));
  const calls = name => JSON.parse(readFileSync(join(root, `${name}-calls`), 'utf8'));
  const task = (file, answer, merge, fail = {}) => writeFileSync(join(root, 'agent-task'), JSON.stringify({ file, answer, merge, ...fail }));
  // 步骤的检出方式照流程定义：coda:checkout="false" 的步骤在没有 .git、没有 origin 的空目录里跑，一用 git 就失败。
  const empty = join(root, 'empty'); mkdirSync(empty);
  const noCheckout = new Set([...workflow.matchAll(/<scriptTask\b[^>]*>[\s\S]*?<\/scriptTask>/g)]
    .filter(([task]) => /coda:checkout="false"/.test(task.slice(0, task.indexOf('>'))))
    .map(([task]) => task.match(/piece\.mjs" ([\w-]+)</)[1]));
  const run = (action, extra = {}, expected = 0) => {
    writeFileSync(env.GITHUB_OUTPUT, '');
    const cwd = noCheckout.has(action) ? empty : work;
    const result = spawnSync(process.execPath, [script, action], { cwd, env: { ...env, ...(cwd === empty && { GIT_CEILING_DIRECTORIES: root }), ...extra }, encoding: 'utf8' });
    assert.equal(result.status, expected, result.stderr);
    const outputs = Object.fromEntries([...readFileSync(env.GITHUB_OUTPUT, 'utf8').matchAll(/(\w+)<<([^\n]+)\n([\s\S]*?)\n\2\n/g)].map(([, key, , value]) => [key, value]));
    return { ...result, outputs };
  };
  const decide = (choice, note = '', BACKUP = 'false') => run('decide', { REVIEW: JSON.stringify({ choice, note }), BACKUP }).outputs.route;
  const remote = ref => git('ls-remote', 'origin', `refs/heads/${ref}`).split('\t')[0];
  // 别的块合进了需求分支：在需求分支上另提交一个。
  const advance = (file, text) => {
    git('fetch', '-q', 'origin', BRANCH); git('switch', '-q', '--detach', 'FETCH_HEAD');
    writeFileSync(join(work, file), text); git('add', file); git('commit', '-qm', `需求分支提交 ${file}`); git('push', '-q', 'origin', `HEAD:refs/heads/${BRANCH}`);
    return git('rev-parse', 'HEAD');
  };
  const delivered = () => { run('gate'); run('gate-passed', { RUNS: '[]' }); };
  // 需求分支上带本运行 trailer 的提交。
  const landedCommits = () => { git('fetch', '-q', 'origin', BRANCH); return git('log', '--format=%H', '--grep=^Coda-Piece: pr-run-1$', 'FETCH_HEAD').split('\n').filter(Boolean); };
  return { root, work, env, git, run, state, calls, task, decide, remote, advance, delivered, landedCommits };
}

async function definition(source = workflow) {
  const { root, problem } = await readWorkflow(source, 'piece'); assert.ok(!problem, problem);
  const process = root.rootElements.find(e => e.$type === 'bpmn:Process');
  const elements = process.flowElements;
  const nodes = Object.fromEntries(elements.map(e => [e.id, e]));
  const values = node => node.extensionElements?.values ?? [];
  const params = id => Object.fromEntries(values(nodes[id]).map(v => [v.name, v.value]));
  const route = (id, context) => {
    const node = nodes[id], flows = elements.filter(e => e.sourceRef === node);
    return (flows.find(e => e.conditionExpression && evaluateTyped(e.conditionExpression.body.trim().slice(1), context)) ?? node.default).targetRef.id;
  };
  const next = id => elements.find(e => e.$type === 'bpmn:SequenceFlow' && e.sourceRef === nodes[id]).targetRef.id;
  return { process, elements, nodes, values, params, route, next };
}

test('执行者从需求分支当前 head 开工；交付推到临时分支，不开 PR；之后的交付推同一个临时分支', t => {
  const f = fixture(t);
  const branchHead = f.advance('other', 'other');
  f.task('one', 'first answer'); f.run('execute', { EXECUTOR: JSON.stringify({ agent: 'codex', model: 'cheap', effort: 'low', mode: 'auto', options: { 'fast-mode': true } }) });
  const call = f.calls('agent')[0];
  assert.deepEqual(call.args.slice(0, -2), ['--commit', branchHead, '--title', '输入框可以输入', '--agent', 'codex', '--model', 'cheap', '--effort', 'low', '--mode', 'auto',
    '--option', 'fast-mode=true', '--json']);
  for (const text of ['执行者', '不再委派', 'AGENTS.md', '不推送', '不写防御性、冗余', '只跑与改动直接相关的快检查', '输入框没反应']) assert.ok(call.prompt.includes(text), text);
  assert.ok(!call.prompt.includes('跟上目标分支'), '普通的块不带跟上目标分支的说明');
  const head = f.run('gate').outputs.head;
  assert.equal(head, f.state().executor.head);
  assert.equal(f.remote(TEMP), head);
  assert.equal(f.remote(BRANCH), branchHead, '需求分支不动');
  const card = f.run('review').outputs;
  assert.deepEqual({ ...card, answer: undefined, changes: undefined }, { session: 'worker-1', head, branch: BRANCH, temp: TEMP, tip: branchHead,
    checks: '此提交项目检查未通过。', feedback: '', returns: '0', review: '没填评审者，这一块不评审。', answer: undefined, changes: undefined });
  assert.equal(card.changes, '改动：1 个文件 +1 -0\n- 根目录：1 个文件 +1 -0');

  assert.equal(f.decide('revise', '删除多余封装'), 'revise');
  f.task('one', 'removed wrapper'); f.run('revise');
  assert.deepEqual(f.calls('agent')[1].args.slice(0, -2), ['--continue', 'worker-1', '--json']);
  const updated = f.run('gate').outputs.head;
  assert.notEqual(updated, head);
  assert.equal(f.remote(TEMP), updated, '推同一个临时分支');
  assert.deepEqual(f.calls('gh'), [], '不开 PR，也不用 gh');
});

test('合进需求分支：试合并需求分支当前 head，干净时把这一块 squash 成一个提交、以需求分支 head 为父快进推送，删掉临时分支，输出这个提交', t => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'agent-task'), JSON.stringify({ extra: 'first-step', file: 'one', answer: 'change' }));
  f.run('execute'); f.delivered();
  const head = f.state().executor.head;
  assert.equal(f.git('rev-list', '--count', `${f.remote(BRANCH)}..${head}`), '2', '执行者交了两个提交');
  const tip = f.advance('other', 'other');
  assert.equal(f.decide('land'), 'land');
  const landed = f.run('land').outputs;
  assert.equal(landed.route, 'landed');
  assert.equal(f.remote(BRANCH), landed.commit, '需求分支到了这个提交');
  assert.equal(f.git('rev-parse', `${landed.commit}^@`), tip, '只有一个父提交：合入时的需求分支 head');
  assert.equal(f.git('log', '-1', '--format=%B', landed.commit), '输入框可以输入\n\nCoda-Piece: pr-run-1');
  assert.deepEqual(f.git('diff', '--name-only', tip, landed.commit).split('\n'), ['first-step', 'one'], '两个提交压成一个');
  assert.equal(f.remote(TEMP), '', '临时分支已删');
  assert.deepEqual(f.calls('gh'), [], '不开 PR、不合 PR');
});

test('合进需求分支时交付相对需求分支没有改动（空交付，或净改动为零只剩合并提交）：不生成提交、不推送，带说明交回同一执行会话，不算退回', t => {
  const message = `这次交付相对需求分支 ${BRANCH} 没有改动，没有可以合入的内容`;
  const check = (f, session, tip) => {
    assert.equal(f.decide('land'), 'land');
    assert.deepEqual(f.run('land').outputs, { route: 'sync' });
    assert.equal(f.remote(BRANCH), tip, '需求分支没动');
    assert.deepEqual(f.landedCommits(), [], '没有合入提交');
    assert.ok(f.remote(TEMP), '临时分支还在');
    assert.ok(f.run('review').outputs.feedback.includes(message));
    assert.equal(f.run('review').outputs.returns, '0');
    f.task('after', 'added', BRANCH); f.run('revise');
    assert.equal(f.state().executor.session, session, '同一会话');
    assert.ok(f.calls('agent').at(-1).prompt.includes(message));
  };
  // 空交付：交付就是需求分支 head（head 是需求分支的祖先），连续三次退回后主 Agent 仍选了合进。
  const empty = fixture(t); writeFileSync(join(empty.root, 'agent-task'), JSON.stringify({ noCommit: true, answer: '改好了' })); empty.run('execute');
  empty.delivered();
  check(empty, empty.state().executor.session, empty.remote(BRANCH));
  // 净改动为零：执行者把改动撤掉，又合并了需求分支，交付只剩一个合并提交。
  const net = fixture(t); net.task('one', 'change'); net.run('execute');
  const { session } = net.state().executor, cwd = join(net.root, session);
  const worker = (...args) => { const result = spawnSync('git', args, { cwd, env: net.env, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
  worker('revert', '--no-edit', 'HEAD');
  const tip = net.advance('other', 'other');
  worker('fetch', '-q', 'origin', BRANCH); worker('merge', '-q', '--no-edit', 'FETCH_HEAD');
  net.git('fetch', '-q', 'origin', BRANCH);
  const head = worker('rev-parse', 'HEAD');
  assert.equal(net.git('rev-parse', `${head}^{tree}`), net.git('rev-parse', `${tip}^{tree}`), '交付的树和需求分支 head 的树相同');
  assert.equal(net.git('rev-parse', `${head}^@`).split('\n').length, 2, '交付是合并提交');
  const state = JSON.parse(readFileSync(join(net.root, 'artifacts', 'piece.json'), 'utf8'));
  writeFileSync(join(net.root, 'artifacts', 'piece.json'), JSON.stringify({ ...state, executor: { ...state.executor, head } }));
  net.delivered();
  check(net, session, tip);
});

test('删临时分支失败：合入提交已推进需求分支，这一步仍失败（调用它的需求运行由出错边界接住，不能断言没合进）', t => {
  const f = fixture(t);
  f.task('one', 'change'); f.run('execute'); f.delivered();
  // 远端拒绝删除临时分支。
  const hook = join(f.root, 'origin.git', 'hooks', 'pre-receive');
  writeFileSync(hook, `#!/bin/sh\nwhile read old new ref; do case "$ref:$new" in refs/heads/piece/*:0000000000000000000000000000000000000000) echo 不许删 >&2; exit 1;; esac; done\n`); chmodSync(hook, 0o755);
  const failed = f.run('land', {}, 1);
  assert.match(failed.stderr, /不许删/);
  assert.deepEqual(f.landedCommits().length, 1, '需求分支已有这一块的合入提交');
  assert.equal(f.remote(TEMP), f.state().executor.head, '临时分支还在');
});

test('重跑不重复合入：合入后需求分支又前进了，再跑 land 认出已合入的提交、原样交出，不再推送；临时分支已删也照样成功', t => {
  for (const sync of [false, true]) {
    const f = fixture(t, { sync });
    f.task('one', 'change'); f.run('execute'); f.delivered();
    const first = f.run('land').outputs;
    assert.equal(first.route, 'landed');
    // 后来合进需求分支的改了同一个文件：重新试合并会冲突，只有先认出已合入才不走错。
    const moved = f.advance('one', 'later piece');
    assert.deepEqual(f.run('land').outputs, first, `sync=${sync}`);
    assert.equal(f.remote(BRANCH), moved, '需求分支不动');
    if (!sync) assert.deepEqual(f.landedCommits(), [first.commit], '只合入一次');
  }
});

test('跟上目标分支的块合入后运行从头重跑：execute 换了 head，land 仍认出推送前记下的合并提交，不再推送', t => {
  const f = fixture(t, { sync: true });
  f.advance('other', 'other');
  const advanceMain = name => { f.git('switch', '-q', 'main'); writeFileSync(join(f.work, name), name); f.git('add', name); f.git('commit', '-qm', name); f.git('push', '-q', 'origin', 'main'); };
  advanceMain('main-1');
  f.task('m1', 'merged main', 'main'); f.run('execute'); f.delivered();
  const first = f.run('land').outputs;
  assert.equal(first.route, 'landed');
  // 从头重跑：执行者又合并了前进了的目标分支，新 head 不是需求分支的祖先。
  advanceMain('main-2');
  f.task('m2', 'merged main again', 'main'); f.run('execute'); f.delivered();
  assert.notEqual(f.state().executor.head, first.commit);
  assert.deepEqual(f.run('land').outputs, first);
  assert.equal(f.remote(BRANCH), first.commit, '需求分支没再动');
});

test('合进需求分支前试合并发现冲突：需求分支不动，同一执行会话收到需求分支与冲突文件，不算退回；合并需求分支后再合进去', t => {
  const f = fixture(t);
  f.task('base', 'worker change'); f.run('execute'); f.delivered();
  const session = f.state().executor.session;
  const tip = f.advance('base', 'other piece');
  f.decide('land');
  assert.deepEqual(f.run('land').outputs, { route: 'sync' });
  assert.equal(f.remote(BRANCH), tip, '需求分支没动');
  assert.ok(f.remote(TEMP), '临时分支还在');
  const feedback = f.run('review').outputs.feedback;
  for (const text of [`需求分支是 ${BRANCH}`, `git fetch origin ${BRANCH}`, '合并（merge）', '不要变基', '顺延', '冲突的文件', '- base']) assert.ok(feedback.includes(text), text);
  assert.equal(f.run('review').outputs.returns, '0');
  f.task('base', 'resolved', BRANCH); f.run('revise');
  assert.equal(f.state().executor.session, session);
  assert.ok(f.calls('agent').at(-1).prompt.includes('- base'));
  f.git('merge-base', '--is-ancestor', tip, f.state().executor.head);
  f.delivered();
  const landed = f.run('land').outputs;
  assert.equal(landed.route, 'landed');
  assert.equal(f.git('rev-parse', `${landed.commit}^@`), tip, '执行者的合并提交也压进一个提交，接在需求分支 head 上');
  assert.equal(f.git('show', `${landed.commit}:base`), 'resolved');
});

test('跟上目标分支的块：执行者收到合并 origin/<base> 的说明；合进需求分支时以它的合并提交快进，不 squash', t => {
  const f = fixture(t, { sync: true });
  f.advance('other', 'other'); // 需求分支与 main 分叉，合并 main 是真的合并提交。
  f.git('switch', '-q', 'main');
  writeFileSync(join(f.work, 'main-change'), 'main'); f.git('add', 'main-change'); f.git('commit', '-qm', 'main moved'); f.git('push', '-q', 'origin', 'main');
  const main = f.git('rev-parse', 'HEAD');
  f.task('migration', 'merged main', 'main'); f.run('execute');
  for (const text of ['跟上目标分支 main', 'git fetch origin main', 'origin/main 合并（merge）', '不要变基', '以合并提交快进', '祖先关系', '顺延需求分支这边的']) assert.ok(f.calls('agent')[0].prompt.includes(text), text);
  const head = f.state().executor.head;
  assert.equal(f.git('rev-parse', `${head}^@`).split('\n').length, 2, '执行者交的是合并提交');
  f.delivered();
  assert.deepEqual(f.run('land').outputs, { route: 'landed', commit: head, reviewed: 'false', by: '' });
  assert.equal(f.remote(BRANCH), head, '需求分支快进到这个合并提交');
  f.git('merge-base', '--is-ancestor', main, f.remote(BRANCH));
  assert.equal(f.remote(TEMP), '');
  assert.deepEqual(f.calls('gh'), []);
});

test('跟上目标分支的块：需求分支 head 不是它的祖先时不推送，交回执行者先合并需求分支', t => {
  const f = fixture(t, { sync: true });
  f.task('one', 'merged main'); f.run('execute'); f.delivered();
  const tip = f.advance('other', 'other');
  assert.deepEqual(f.run('land').outputs, { route: 'sync' });
  assert.equal(f.remote(BRANCH), tip);
  assert.match(f.state().feedback, /需求分支是 req\/develop-1/);
  assert.ok(!f.state().feedback.includes('冲突的文件'), '能干净合并，只是不能快进');
  f.task('two', 'merged branch', BRANCH); f.run('revise'); f.delivered();
  assert.equal(f.run('land').outputs.route, 'landed');
  assert.equal(f.remote(BRANCH), f.state().executor.head);
});

test('审查答复：退回和换人必须写备注，没填备用执行者不能换，合并需求分支备注可选；退回次数只数退回修改', t => {
  const f = fixture(t);
  f.task('code', 'first'); f.run('execute'); f.delivered();
  const tip = f.remote(BRANCH), first = f.state().executor;
  for (const [choice, note, backup, text] of [['revise', '  ', 'true', /退回修改必须/], ['swap', '', 'true', /换备用执行者重做必须/], ['swap', '换人', 'false', /没有填备用执行者/]]) {
    assert.equal(f.decide(choice, note, backup), 'review');
    assert.match(f.run('review').outputs.feedback, text);
  }
  assert.equal(f.run('review').outputs.returns, '0');
  assert.equal(f.decide('revise', '改一下'), 'revise');
  assert.equal(f.run('review').outputs.returns, '1');
  f.task('code', 'second'); f.run('revise');
  assert.equal(f.decide('sync'), 'revise');
  assert.ok(f.state().feedback.startsWith(`需求分支是 ${BRANCH}`));
  assert.ok(!f.state().feedback.includes('主 Agent 的备注'));
  assert.equal(f.decide('sync', '版本号会撞'), 'revise');
  assert.ok(f.state().feedback.endsWith('主 Agent 的备注：\n版本号会撞'));
  f.task('code', 'third'); f.run('revise');
  assert.equal(f.run('review').outputs.returns, '1', '合并需求分支不算退回');

  assert.equal(f.decide('swap', '上一位绕远了', 'true'), 'swap');
  f.task('redo', 'redo'); f.run('swap', { EXECUTOR: JSON.stringify({ agent: 'backup', model: 'm2' }) });
  const call = f.calls('agent').at(-1);
  assert.deepEqual(call.args.slice(0, -2), ['--commit', tip, '--title', '输入框可以输入', '--agent', 'backup', '--model', 'm2', '--json']);
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
  assert.deepEqual(passed, { base: f.remote(BRANCH), head: f.state().executor.head, task: f.env.TASK, checks: 'test: succeeded coda://workflow-runs/check-1', previous: '' });
  assert.equal(f.run('review').outputs.checks, passed.checks);
});

test('普通块交付相对需求分支没有新提交：不进检查和评审，自动退回同一执行会话并计入连续失败，三次交主 Agent；sync 块没有新提交照常合入', t => {
  const noCommit = { noCommit: true, answer: '改好了' };
  const f = fixture(t); writeFileSync(join(f.root, 'agent-task'), JSON.stringify(noCommit)); f.run('execute');
  const session = f.state().executor.session, tip = f.remote(BRANCH);
  for (let i = 1; i <= 3; i++) {
    if (i > 1) f.run('revise');
    assert.equal(f.run('gate').outputs.empty, 'true');
    assert.equal(f.run('gate-failed', { EMPTY: 'true' }).outputs.route, i === 3 ? 'review' : 'revise');
  }
  assert.equal(f.state().executor.head, tip, '执行者没提交，交付就是需求分支 head');
  assert.equal(f.state().executor.session, session, '同一会话');
  const { feedback } = f.run('review').outputs;
  assert.equal(feedback.split(`这次交付相对需求分支 ${BRANCH} 没有新提交：先 git status 看工作区，把这一项的改动提交到当前分支再回报`).length - 1, 3);
  assert.ok(!feedback.includes('项目检查未通过'));
  assert.ok(f.calls('agent')[1].prompt.includes('没有新提交'), '退回时把说明交给执行者');

  const g = fixture(t, { sync: true }); writeFileSync(join(g.root, 'agent-task'), JSON.stringify(noCommit)); g.run('execute');
  assert.equal(g.run('gate').outputs.empty, 'false', 'sync 块没有新提交是正常的');
  g.run('gate-passed', { RUNS: '[]' });
  assert.equal(g.run('land').outputs.route, 'landed');
});

test('放弃：删掉临时分支，需求分支不动；重跑时临时分支已不在就跳过，照样成功', t => {
  const f = fixture(t); f.task('code', 'first'); f.run('execute'); f.delivered();
  const tip = f.remote(BRANCH);
  assert.ok(f.remote(TEMP));
  assert.equal(f.decide('abandon', '方向不对'), 'abandon');
  assert.deepEqual(f.run('abandon').outputs, {});
  assert.equal(f.remote(TEMP), '', '临时分支已删');
  assert.equal(f.remote(BRANCH), tip);
  f.run('abandon');
  assert.deepEqual(f.calls('gh'), []);
});

test('换备用执行者成功后运行从头重跑 execute：接回备用会话，当前执行者仍是备用；接不回时回退新开也用备用；检查失败计数只在新开会话时清零', t => {
  const f = fixture(t);
  f.task('code', 'first'); f.run('execute'); f.run('gate'); f.run('gate-failed');
  assert.equal(f.state().failures.length, 1);
  const backup = { agent: 'backup', model: 'm2' };
  assert.equal(f.decide('swap', '换人', 'true'), 'swap');
  f.task('redo', 'redo'); f.run('swap', { EXECUTOR: JSON.stringify(backup) });
  const session = f.state().executor.session;
  assert.deepEqual(f.state().failures, [], '新开的备用会话重新计数');
  f.run('gate'); f.run('gate-failed');
  // 从头重跑 execute，流程参数仍是原执行者；有备用会话就接回它。
  f.task('redo', 'more'); f.run('execute');
  assert.deepEqual(f.calls('agent').at(-1).args.slice(0, 2), ['--continue', session]);
  assert.equal(f.state().executor.session, session);
  assert.deepEqual(f.state().agent, backup, '换人的决定不被撤回');
  assert.equal(f.state().failures.length, 1, '接回同一会话，检查失败计数保留');
  // 备用会话接不回（回复里没有 session）：回退新开用的是备用执行者，新会话重新计数。
  f.task('redo', 'fresh', undefined, { lost: true }); f.run('execute');
  const [continued, opened] = f.calls('agent').slice(-2);
  assert.deepEqual(continued.args.slice(0, 2), ['--continue', session]);
  assert.ok(opened.args.includes('--commit') && opened.args.join(' ').includes('--agent backup --model m2') && !opened.args.includes('codex'));
  assert.notEqual(f.state().executor.session, session);
  assert.deepEqual(f.state().agent, backup);
  assert.deepEqual(f.state().failures, []);
});

test('执行步骤失败后再跑：接回失败时已开的会话并发续跑说明，不另开；连会话都没开成时才新开', t => {
  const f = fixture(t);
  f.task('one', 'work', undefined, { exit: 1, silent: true }); f.run('execute', {}, 1);
  f.task('one', 'work', undefined, { exit: 1 }); f.run('execute', {}, 1);
  assert.deepEqual(f.calls('agent').map(c => c.args.includes('--commit')), [true, true], '没开成会话的失败，再跑新开');
  assert.deepEqual(f.state().opening, { action: 'execute', session: 'worker-2', text: f.env.TASK, agent: { agent: 'codex' } });
  f.task('one', 'finished'); f.run('execute');
  const calls = f.calls('agent');
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2].args.slice(0, -2), ['--continue', 'worker-2', '--json']);
  for (const text of ['git status', 'git log', '不要从头重做', '输入框没反应', '执行者']) assert.ok(calls[2].prompt.includes(text), text);
  assert.equal(f.state().executor.session, 'worker-2');
  assert.equal(f.state().opening, undefined, '成功后不再接');
  assert.deepEqual(f.state().failures, []);
  f.delivered();
  assert.equal(f.remote(TEMP), f.state().executor.head, '接回会话做完的提交照常推送');
});

test('运行从头重跑（上次执行已成功）：接回同一执行会话并发续跑说明，不新开；换备用执行者仍新开', t => {
  const f = fixture(t);
  f.task('one', 'first'); f.run('execute');
  const first = f.state().executor;
  f.task('one', 'again'); f.run('execute');
  const calls = f.calls('agent');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].args.slice(0, -2), ['--continue', first.session, '--json']);
  for (const text of ['git status', 'git log', '不要从头重做', '输入框没反应']) assert.ok(calls[1].prompt.includes(text), text);
  assert.equal(f.state().executor.session, first.session);
  assert.equal(f.state().opening, undefined);
    f.delivered();
  assert.equal(f.decide('swap', '换人', 'true'), 'swap');
  f.task('redo', 'redo'); f.run('swap', { EXECUTOR: JSON.stringify({ agent: 'backup' }) });
  assert.ok(f.calls('agent')[2].args.includes('--commit'), '换备用执行者是有意新开');
});

test('退回修改失败后再跑：接回同一会话并发续跑说明；第一次退回修改不带', t => {
  const f = fixture(t);
  f.task('one', 'first'); f.run('execute'); f.delivered();
  assert.equal(f.decide('revise', '删除多余封装'), 'revise');
  f.task('one', 'half', undefined, { exit: 1 }); f.run('revise', {}, 1);
  assert.deepEqual(f.state().opening, { action: 'revise', session: 'worker-1', text: '删除多余封装', agent: { agent: 'codex' } });
  f.task('one', 'done'); f.run('revise');
  const [, firstTry, rerun] = f.calls('agent');
  assert.deepEqual(firstTry.args.slice(0, -2), ['--continue', 'worker-1', '--json']);
  assert.ok(!firstTry.prompt.includes('git status') && firstTry.prompt.includes('删除多余封装'));
  assert.deepEqual(rerun.args.slice(0, -2), ['--continue', 'worker-1', '--json']);
  for (const text of ['git status', 'git log', '不要从头重做', '删除多余封装']) assert.ok(rerun.prompt.includes(text), text);
  assert.equal(f.state().opening, undefined, '成功后不再接');
  assert.equal(f.state().feedback, '');
});

test('coda-agent 退出 0 但输出不是完整回复：这一步失败、错误带输出摘要，不记执行者；会话能取到就记下接回', t => {
  const f = fixture(t);
  f.task('one', 'work', undefined, { garbage: 'not json' });
  assert.match(f.run('execute', {}, 1).stderr, /session、branch、head[\s\S]*not json/);
  f.task('one', 'work', undefined, { garbage: JSON.stringify({ session: 'worker-1' }) });
  assert.match(f.run('execute', {}, 1).stderr, /worker-1/);
  assert.deepEqual(f.state().opening, { action: 'execute', session: 'worker-1', text: f.env.TASK, agent: { agent: 'codex' } });
  assert.equal(f.state().executor, undefined);
  f.task('one', 'done'); f.run('execute');
  assert.deepEqual(f.calls('agent').at(-1).args.slice(0, 2), ['--continue', 'worker-1']);
  assert.equal(f.state().executor.session, 'worker-1');
  assert.equal(f.state().opening, undefined);
});

test('换备用执行者失败后再跑：接回这次新开的备用会话，不另开、不接原执行者；成功后再选换人仍新开', t => {
  const f = fixture(t);
  f.task('code', 'first'); f.run('execute'); f.delivered();
  const first = f.state().executor, backup = { EXECUTOR: JSON.stringify({ agent: 'backup' }) };
  assert.equal(f.decide('swap', '换人', 'true'), 'swap');
  f.task('redo', 'half', undefined, { exit: 1 }); f.run('swap', backup, 1);
  assert.deepEqual({ ...f.state().opening, text: undefined }, { action: 'swap', session: 'worker-2', text: undefined, agent: { agent: 'backup' } });
  assert.ok(f.state().opening.text.includes('换人'));
  assert.equal(f.state().executor.session, first.session, '没成功前执行者不变');
  f.task('redo', 'done'); f.run('swap', backup);
  const resumed = f.calls('agent').at(-1);
  assert.deepEqual(resumed.args.slice(0, -2), ['--continue', 'worker-2', '--json']);
  assert.ok(resumed.prompt.includes('git log') && resumed.prompt.includes('换给你重做') && resumed.prompt.includes('换人'));
  assert.equal(f.state().executor.session, 'worker-2');
  assert.equal(f.calls('agent').length, 3);
  f.delivered();
  assert.equal(f.decide('swap', '再换一次', 'true'), 'swap');
  f.task('redo', 'again'); f.run('swap', backup);
  assert.deepEqual(f.calls('agent').at(-1).args.slice(0, 4), ['--commit', f.remote(BRANCH), '--title', '输入框可以输入']);
  assert.equal(f.state().executor.session, 'worker-4');
});

test('块的流程定义：输入、回路、审查卡答复、结束输出与放弃的出错结束；只在三轮没过时出用户卡，不开 PR、不装机、不部署、不跑合并前检查', async () => {
  const { process, elements, nodes, values, params, route, next } = await definition();
  assert.equal(process.name, '块'); assert.equal(process.kind, undefined, '不是一种开发流程实现');
  const inputs = Object.fromEntries(values(process).map(v => [v.name, v]));
  assert.deepEqual(Object.keys(inputs), ['branch', 'base', 'title', 'task', 'sync', 'executor', 'executor2', 'reviewer']);
  for (const name of ['branch', 'base', 'title', 'task']) assert.equal(inputs[name].required, true, name);
  assert.deepEqual([inputs.sync.type, inputs.sync.default], ['boolean', 'false']);
  // 必填且没有默认值：引擎 resolveInputs 对没给、又无默认的 required 输入在启动时报「需要参数 executor」，不再落到发起会话。
  assert.deepEqual([inputs.executor.type, inputs.executor.required, inputs.executor.default, inputs.executor.defaultFrom], ['agent', true, undefined, undefined]);
  for (const name of ['executor2', 'reviewer']) assert.deepEqual([inputs[name].type, inputs[name].default, inputs[name].required], ['agent', undefined, undefined], name);
  assert.deepEqual(Object.fromEntries(Object.entries(params('execute')).filter(([k]) => k !== 'EXECUTOR')), { BRANCH: '=inputs.branch', BASE: '=inputs.base', TITLE: '=inputs.title', TASK: '=inputs.task', SYNC: '=inputs.sync' });
  // 执行者只来自 inputs.executor，没有取发起会话的回退；引擎把 env 里的对象转成 JSON 文本，脚本再解析。
  assert.equal(params('execute').EXECUTOR, '=inputs.executor');
  const executor = { agent: 'codex', model: 'gpt-6' };
  assert.deepEqual(JSON.parse(JSON.stringify(evaluate(params('execute').EXECUTOR.slice(1), { inputs: { executor } }).value)), executor);
  assert.equal(params('swap').EXECUTOR, '=inputs.executor2');

  assert.deepEqual(elements.filter(e => e.$type === 'bpmn:UserTask').map(e => [e.id, e.assignee]), [['review', undefined], ['stuck', 'user']], '主 Agent 的审查卡，和三轮没过时给用户的卡');
  assert.deepEqual(elements.filter(e => e.action === 'run-workflows').map(e => [e.id, params(e.id).hook, params(e.id).commit]), [['checks', 'check', '=gate.head']]);
  assert.ok(!elements.some(e => ['hold-group', 'tell-session', 'workflow-kinds'].includes(e.action)));
  assert.deepEqual(values(nodes.review).map(v => [v.id, v.name]), [['revise', '退回修改'], ['sync', '让执行者合并需求分支'], ['swap', '换备用执行者重做'], ['land', '合进需求分支'], ['abandon', '放弃']]);
  for (const [value, target] of [['review', 'report'], ['revise', 'revise'], ['stuck', 'stuck'], ['swap', 'swap'], ['abandon', 'abandon'], ['land', 'land']]) assert.equal(route('how', { decide: { route: value } }), target);
  assert.equal(next('report'), 'review');
  assert.equal(nodes.report.checkout, undefined, '改动范围要读 diff，检出仓库');
  assert.equal(params('report').REVIEWER, '=inputs.reviewer != null');
  assert.deepEqual(values(nodes.stuck).map(v => [v.id, v.name]), [['continue', '继续修'], ['land', '不退了，合进需求分支'], ['abandon', '放弃这一块']]);
  assert.equal(next('stuck'), 'stuck-result');
  assert.equal(params('stuck-result').STUCK, '=stuck');
  for (const [value, target] of [['revise', 'revise'], ['land', 'land'], ['abandon', 'abandon']]) assert.equal(route('stuck-route', { 'stuck-result': { route: value } }), target);
  for (const id of ['execute', 'revise', 'swap']) assert.equal(next(id), 'gate');
  assert.equal(next('gate'), 'has-new');
  assert.equal(route('has-new', { gate: { empty: 'false' } }), 'checks');
  assert.equal(route('has-new', { gate: { empty: 'true' } }), 'check-feedback', '没有新提交的交付当作检查没过自动退回，不进检查和评审');
  assert.equal(params('check-feedback').EMPTY, '=gate.empty');
  assert.equal(next('checks'), 'gate-passed');
  assert.equal(next('gate-passed'), 'review-choice');
  assert.equal(nodes['checks-failed'].attachedToRef.id, 'checks');
  assert.equal(route('gate-route', { 'check-feedback': { route: 'review' } }), 'report', '连续三次检查失败交回主 Agent，不评审');
  assert.equal(route('gate-route', { 'check-feedback': { route: 'revise' } }), 'revise');
  assert.equal(route('after-land', { land: { route: 'sync' } }), 'revise', '冲突交回同一个执行会话');
  assert.equal(route('after-land', { land: { route: 'landed' } }), 'landed');
  for (const id of ['landed', 'abandoned']) assert.equal(nodes[id].notify, 'true', `${id} 结果回发起会话`);
  assert.deepEqual(values(nodes.landed).map(v => [v.name, v.value]), [['commit', '=land.commit'], ['run', '=run.id'], ['reviewed', '=land.reviewed'], ['by', '=land.by']], '合进需求分支的提交、本运行与最后一次交付评成没有，调用它的需求运行写进「需求进行中」、定整体评审');
  assert.equal(next('abandon'), 'abandoned');
  // 放弃以出错结束：运行失败，原因就是这个结束事件的名字，callActivity 调它的流程由出错边界接住、拿到原因。
  assert.deepEqual(nodes.abandoned.eventDefinitions.map(e => e.$type), ['bpmn:ErrorEventDefinition']);
  assert.equal(nodes.abandoned.name, '主 Agent 放弃了这一块，需求分支没动');
  assert.deepEqual(process.flowElements.filter(e => e.$type === 'bpmn:EndEvent' && !e.eventDefinitions?.length).map(e => e.id), ['landed'], '没合入就不正常结束');
  assert.doesNotMatch(workflow, /gh pr|pull request|PR 地址/i);
  for (const [sync, text] of [[false, '把这一块 squash 成一个提交，接在需求分支 head 上快进推送'], [true, '以这次交付的合并提交快进需求分支']]) {
    const expression = [...nodes.review.documentation[0].text.matchAll(/{{(.*?)}}/g)].find(m => m[1].includes('inputs.sync'))[1];
    assert.ok(evaluate(expression, { inputs: { sync } }).value.includes(text));
  }

  // 评审：只调一次 review-commit，评完（含没评成、调用没成）都照常整理材料出审查卡，结论不决定去向。
  assert.deepEqual(elements.filter(e => e.calledElement === 'review-commit').map(e => e.id), ['review-call']);
  assert.ok(!elements.some(e => e.$type === 'bpmn:SubProcess' || e.loopCharacteristics), '没有多位评审者同时评');
  assert.deepEqual(params('review-call'), { base: '=gate-passed.base', head: '=gate-passed.head', task: '=gate-passed.task', reviewer: '=inputs.reviewer', evidence: '=gate-passed.checks', previous: '=gate-passed.previous' });
  for (const [reviewer, target] of [[{ agent: 'a1' }, 'review-call'], [null, 'report']]) assert.equal(route('review-choice', { inputs: { reviewer } }), target);
  assert.equal(next('review-call'), 'reviewed');
  assert.deepEqual(params('reviewed'), { DECISION: '=review-call.decision', FINDINGS: '=review-call.findings', LINE: '=review-call.line', REPORT: '=review-call.report', RESOLUTIONS: '=review-call.resolutions' });
  assert.equal(nodes['review-failed'].attachedToRef.id, 'review-call');
  assert.equal(next('review-failed'), 'review-lost');
  for (const id of ['reviewed', 'review-lost']) assert.equal(next(id), 'report', id);
  assert.doesNotMatch(workflow, /triage|address|rounds|minor|autoLandMinor|reviewer2/);
  assert.doesNotMatch(workflow, /reviewerOnce|首次评审|\.first\b/);
  for (const [title, expected] of [['补齐状态', '块：补齐状态']]) assert.equal(evaluate(process.title.slice(1), { inputs: { title } }).value, expected);
  // 流程只定位置，不写 Ultra 或模型的知识。
  assert.doesNotMatch(workflow, /ultra|codex|claude|kimi|grok|opencode|cursor|gpt|sonnet|opus|haiku|gemini/i);
});

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

test('接回会话失败：清掉记录，同一次里从需求分支当前 head 新开会话给原任务，只回退一次', t => {
  const f = fixture(t);
  f.task('one', 'first'); f.run('execute');
  f.task('one', 'again', undefined, { lost: true });
  const rerun = f.run('execute');
  assert.match(rerun.stderr, /接回会话 worker-1 失败[\s\S]*新开/);
  let calls = f.calls('agent');
  assert.deepEqual(calls.map(c => c.args.includes('--commit')), [true, false, true]);
  assert.ok(!calls[2].prompt.includes('git status') && calls[2].prompt.includes('输入框没反应'), '新开的会话给原任务，不带续跑说明');
  assert.equal(f.state().executor.session, 'worker-3');
  assert.equal(f.state().opening, undefined);
  // 新开的会话再失败就照常失败：不再回退，状态里是它自己的会话，旧的执行者记录已清。
  f.task('one', 'half', undefined, { lost: true, exit: 1 });
  f.run('execute', {}, 1);
  calls = f.calls('agent');
  assert.deepEqual(calls.slice(3).map(c => c.args.includes('--commit')), [false, true], '接回一次、新开一次，不再回退');
  assert.deepEqual(f.state().opening, { action: 'execute', session: 'worker-5', text: f.env.TASK, agent: { agent: 'codex' } });
  assert.equal(f.state().executor.session, 'worker-3', '动作没成功，执行者记录不动');
  f.task('one', 'done'); f.run('execute');
  assert.deepEqual(f.calls('agent').slice(5).map(c => c.args.slice(0, 2)), [['--continue', 'worker-5']]);
  assert.equal(f.state().executor.session, 'worker-5');
  assert.equal(f.state().opening, undefined);
});

test('接回的会话输出不是完整回复，也按接不回新开', t => {
  const f = fixture(t);
  f.task('one', 'first'); f.run('execute');
  f.task('one', 'again', undefined, { garbage: 'not json' });
  f.run('execute', {}, 1);
  assert.deepEqual(f.calls('agent').map(c => c.args.includes('--commit')), [true, false, true], '接回一次、新开一次，新开的也不完整就失败');
  assert.deepEqual(f.state().opening, { action: 'execute', text: f.env.TASK, agent: { agent: 'codex' } }, '接不回的会话已去掉，动作还在');
  f.task('one', 'again'); f.run('execute');
  assert.equal(f.calls('agent').length, 4);
  assert.ok(f.calls('agent')[3].args.includes('--commit'));
});

test('接回的会话非零退出但回复完整：不新开，会话留在 opening，按失败退出；下次恢复仍接回同一会话', t => {
  const f = fixture(t);
  f.task('one', 'first'); f.run('execute');
  f.task('one', 'half', undefined, { exit: 1 });
  f.run('execute', {}, 1);
  assert.deepEqual(f.calls('agent').map(c => c.args.includes('--commit')), [true, false], '只接回一次，不新开');
  assert.deepEqual(f.state().opening, { action: 'execute', session: 'worker-1', text: f.env.TASK, agent: { agent: 'codex' } });
  f.task('one', 'done'); f.run('execute');
  assert.deepEqual(f.calls('agent').slice(2).map(c => c.args.slice(0, 2)), [['--continue', 'worker-1']]);
  assert.equal(f.state().executor.session, 'worker-1');
  assert.equal(f.state().opening, undefined);
});

test('退回修改接不回会话：不新开，按失败处理并说明；记录留着', t => {
  const f = fixture(t);
  f.task('one', 'first'); f.run('execute'); f.delivered();
  assert.equal(f.decide('revise', '删除多余封装'), 'revise');
  f.task('one', 'second', undefined, { lost: true });
  assert.match(f.run('revise', {}, 1).stderr, /退回修改接不回会话 worker-1[\s\S]*原会话/);
  assert.equal(f.calls('agent').length, 2);
  assert.ok(!f.calls('agent').some((c, i) => i > 0 && c.args.includes('--commit')));
  assert.equal(f.state().executor.session, 'worker-1');
  assert.equal(f.state().opening.action, 'revise');
});

test('换人失败后运行从头重跑：按 opening 接回备用会话、配换人的任务，不接原执行者', t => {
  const f = fixture(t);
  f.task('code', 'first'); f.run('execute'); f.delivered();
  const first = f.state().executor, backup = { EXECUTOR: JSON.stringify({ agent: 'backup' }) };
  assert.equal(f.decide('swap', '换人', 'true'), 'swap');
  f.task('redo', 'half', undefined, { exit: 1 }); f.run('swap', backup, 1);
  assert.equal(f.state().opening.session, 'worker-2');
  f.task('redo', 'done'); f.run('execute');
  const resumed = f.calls('agent').at(-1);
  assert.deepEqual(resumed.args.slice(0, -2), ['--continue', 'worker-2', '--json']);
  for (const text of ['git status', 'git log', '不要从头重做', '换给你重做', '换人', first.branch]) assert.ok(resumed.prompt.includes(text), text);
  assert.equal(f.state().executor.session, 'worker-2');
  assert.equal(f.state().opening, undefined);
  assert.equal(f.calls('agent').length, 3);
});

test('退回修改失败后运行从头重跑：按 opening 接回执行会话、配退回意见', t => {
  const f = fixture(t);
  f.task('one', 'first'); f.run('execute'); f.delivered();
  assert.equal(f.decide('revise', '删除多余封装'), 'revise');
  f.task('one', 'half', undefined, { exit: 1 }); f.run('revise', {}, 1);
  f.task('one', 'done'); f.run('execute');
  const resumed = f.calls('agent').at(-1);
  assert.deepEqual(resumed.args.slice(0, -2), ['--continue', 'worker-1', '--json']);
  for (const text of ['git status', '这次要你做的', '删除多余封装']) assert.ok(resumed.prompt.includes(text), text);
  assert.ok(!resumed.prompt.includes('输入框没反应'));
  assert.equal(f.state().opening, undefined);
});

test('换人接回失败、新开也失败后运行从头重跑：仍做换人，用 opening 记的备用执行者配置，不用 execute 的配置', t => {
  const f = fixture(t);
  f.task('code', 'first'); f.run('execute'); f.delivered();
  const backup = { EXECUTOR: JSON.stringify({ agent: 'backup', model: 'm2' }) };
  assert.equal(f.decide('swap', '换人', 'true'), 'swap');
  f.task('redo', 'half', undefined, { exit: 1 }); f.run('swap', backup, 1);
  // 从 execute 恢复：接回的备用会话接不回，回退新开用的是备用执行者配置；新开也没开成。
  f.task('redo', 'half', undefined, { lost: true, exit: 1, silent: true }); f.run('execute', {}, 1);
  const [continued, opened] = f.calls('agent').slice(-2);
  assert.deepEqual(continued.args.slice(0, 2), ['--continue', 'worker-2']);
  assert.ok(opened.args.includes('--commit') && opened.args.join(' ').includes('--agent backup --model m2') && !opened.args.includes('codex'), '回退新开用备用执行者配置');
  assert.ok(opened.prompt.includes('换给你重做') && !opened.prompt.includes('git status'));
  assert.deepEqual({ ...f.state().opening, text: undefined }, { action: 'swap', text: undefined, agent: { agent: 'backup', model: 'm2' } }, '会话去掉，动作和配置还在');
  // 再从头重跑：仍做换人，没有会话就用 opening 的配置新开。
  f.task('redo', 'done'); f.run('execute');
  const redo = f.calls('agent').at(-1);
  assert.ok(redo.args.includes('--commit') && redo.args.join(' ').includes('--agent backup --model m2') && !redo.args.includes('codex'));
  assert.ok(redo.prompt.includes('换给你重做') && redo.prompt.includes('换人') && !redo.prompt.includes('git status'));
  assert.equal(f.state().executor.session, 'worker-5');
  assert.equal(f.state().opening, undefined);
  assert.deepEqual(f.state().agent, { agent: 'backup', model: 'm2' }, '之后的退回修改用当前执行者');
});

test('首次开工新建状态：只有输入、空的 feedback、returns，成功后记下执行者与检查失败计数', t => {
  const f = fixture(t);
  f.task('one', 'first'); f.run('execute');
  const { executor, ...rest } = f.state();
  assert.deepEqual(rest, { branch: BRANCH, base: 'main', temp: TEMP, title: '输入框可以输入', task: f.env.TASK, sync: false, feedback: '', returns: 0,
    agent: { agent: 'codex' }, failures: [] });
  assert.equal(executor.session, 'worker-1');
});

test('退回修改中断后运行从头重跑：execute 以上一次的完整状态为底，检查失败计数、退回次数照旧，紧接着检查失败正常累加', t => {
  const f = fixture(t);
  f.task('one', 'first'); f.run('execute');
  for (let i = 1; i <= 3; i++) {
    f.run('gate'); f.run('gate-failed');
    if (i < 3) { f.task('one', `fix ${i}`); f.run('revise'); }
  }
  assert.equal(f.state().failures.length, 3);
  assert.equal(f.decide('revise', '删除多余封装'), 'revise');
  f.task('one', 'half', undefined, { exit: 1 }); f.run('revise', {}, 1);
  const before = f.state();
  f.task('one', 'done'); f.run('execute');
  const after = f.state();
  assert.equal(after.returns, 1, '退回次数不归零');
  assert.equal(after.failures.length, 3, '接回同一会话，检查失败计数保留');
  assert.equal(after.executor.session, 'worker-1');
  assert.deepEqual({ ...after, executor: undefined, feedback: undefined, opening: undefined }, { ...before, executor: undefined, feedback: undefined, opening: undefined });
  f.run('gate'); assert.equal(f.run('gate-failed').outputs.route, 'review');
  assert.equal(f.state().failures.length, 4);
});

// review-commit 的输出（评审结果入账的 env）。
const verdict = (findings, extra = {}) => ({ DECISION: findings.some(f => f.level === 'must') ? 'REQUEST_CHANGES' : 'APPROVE', LINE: '评审结论一句话',
  FINDINGS: JSON.stringify(findings), REPORT: '评审原文全文', RESOLUTIONS: '[]', ...extra });
const MUST = { level: 'must', kind: 'correctness', title: '漏了失败路径', location: 'one:1', detail: '失败时没有退出码' };
const CONTRACT = { level: 'must', kind: 'contract', title: '改了输出格式', location: 'one:2', detail: '调用方读不懂' };
const NIT = { level: 'nit', kind: 'style', title: '命名', location: 'one:3', detail: '' };
const OLD = { level: 'existing', kind: 'scope', title: '原来就超范围', location: 'two:1', detail: '' };
const withReport = done => `我先读一下代码。\n\n进度：改好了，跑一下测试。\n\n## 交付说明\n1. ${done}\n2. node --test one.test.mjs，通过`;

test('执行者交块的格式：固定说明要求最后一条以「交付说明」开头给两段；审查卡只放最后一条回复，没按格式时放全部并说明', t => {
  const f = fixture(t); f.task('one', withReport('能输入：做到了')); f.run('execute'); f.delivered();
  const prompt = f.calls('agent')[0].prompt;
  for (const text of ['回答的最后一条消息以单独一行「交付说明」开头', '1. 任务书的完成标准逐条：做到了，还是没做到及原因。', '2. 怎么把改动跑起来验的：命令或操作与结果；没跑就写「没跑」和原因。']) assert.ok(prompt.includes(text), text);
  assert.ok(prompt.indexOf('交付说明') < prompt.indexOf('输入框没反应'), '格式要求在固定说明里，任务书前面');
  assert.equal(f.run('review').outputs.answer, '## 交付说明\n1. 能输入：做到了\n2. node --test one.test.mjs，通过');
  assert.equal(f.decide('revise', '再改'), 'revise');
  f.task('one', '改好了'); f.run('revise');
  assert.ok(f.calls('agent').at(-1).prompt.includes('以单独一行「交付说明」开头'), '退回修改同样带');
  assert.equal(f.run('review').outputs.answer, '（执行者没有以「交付说明」开头给最后一条回复，下面是这一次的全部回答）\n改好了');
});

test('一位评审者：评审要求修改也直接出审查卡；一页结论写必须修逐条、小问题与原有问题只给条数、评审原文路径、改动范围与看改动的命令', async t => {
  const { nodes } = await definition();
  const f = fixture(t); f.task('one', withReport('能输入：做到了')); f.run('execute');
  const passed = (f.run('gate'), f.run('gate-passed', { RUNS: JSON.stringify([{ workflow: 'test', state: 'succeeded', runId: 'check-1' }]) }).outputs);
  const head = f.state().executor.head, tip = f.remote(BRANCH);
  assert.deepEqual(passed, { base: tip, head, task: f.env.TASK, checks: 'test: succeeded coda://workflow-runs/check-1', previous: '' }, '第一次评需求分支 head 到这次交付');
  f.run('reviewed', verdict([MUST, NIT, CONTRACT, OLD, { ...NIT, kind: 'contract', title: '小问题也动了契约' }]));
  const card = f.run('review', { REVIEWER: 'true' }).outputs, report = join(f.env.CODA_ARTIFACTS, 'review-1.md');
  assert.equal(card.review, ['评审结论一句话', '必须修 2 条：', '- #1 漏了失败路径（one:1）', '- #2 改了输出格式（one:2）〔评审者认为涉及对外契约〕',
    '小问题 2 条，原有问题 1 条。', '其中评审者认为涉及对外契约或任务范围的：「原来就超范围」、「小问题也动了契约」', `评审原文：${report}`].join('\n'));
  assert.equal(readFileSync(report, 'utf8'), '评审原文全文');
  assert.equal(card.checks, 'test: succeeded coda://workflow-runs/check-1');
  assert.equal(card.changes, '改动：1 个文件 +7 -0\n- 根目录：1 个文件 +7 -0');
  assert.equal(card.tip, tip);
  // 卡片照引擎展开：一页结论依次是执行者回复、检查、评审、改动范围、看改动的命令，说明换成不要求读 diff 与取舍标准。
  const doc = nodes.review.documentation[0].text, rendered = doc.replace(/{{([\s\S]*?)}}/g, (_, e) => evaluate(e, { report: card, inputs: { title: '输入框可以输入', sync: false, executor2: null } }).value ?? '');
  const order = ['执行者最后一条回复：\n## 交付说明\n1. 能输入：做到了', '项目检查结果：\ntest: succeeded', '评审结论：\n评审结论一句话', '改动范围：\n改动：1 个文件', `看改动（备查）：git fetch origin ${BRANCH} ${TEMP} && git diff ${tip}...${head}`];
  order.reduce((at, part) => { const i = rendered.indexOf(part); assert.ok(i > at, part); return i; }, -1);
  for (const text of ['不要求读 diff。只在三种情况下读有疑问的那部分：评审者说动了对外契约或超出任务书；执行者和评审者各执一词；改动范围明显超出任务书。',
    '只有必须修才退回；评审者说成立不等于现在要修。必须修是合并后用户会遇到错的结果、丢数据、安全问题，对外契约写错，测试是红的或会偶发失败，漏了任务书要求的事或做了任务书之外的事，以及会扩散、越晚越难改的结构问题（跨模块或会被照着写：绕过已有边界、依赖方向反过来、第二个事实来源或第二套做同一件事的机制、迁移只做一半）；其余是小问题。退回时只列要修的那几条，定了不改的单独一行写「#编号 不改」，后面可以接理由，如「#2 不改：只影响少见路径」；不顺手带小问题，不加设计改动，不把以后的需求提前做进来。']) assert.ok(rendered.includes(text), text);
  assert.doesNotMatch(rendered, /收敛|免主控审查|第二评审者|严重程度/);
  // 没评成与调用没成也照常出卡；没填评审者、检查没过各有一句。
  f.run('reviewed', verdict([], { DECISION: 'INCOMPLETE', LINE: '评审没有完成：没有合格的 review 代码块' }));
  assert.equal(f.run('review', { REVIEWER: 'true' }).outputs.review, '没评成：评审没有完成：没有合格的 review 代码块');
  assert.deepEqual(f.state().findings.map(x => [x.id, x.status]), [['#1', 'open'], ['#2', 'open']], '没评成不入账');
  f.run('review-lost');
  assert.match(f.run('review', { REVIEWER: 'true' }).outputs.review, /^没评成：调用 review-commit 没有成功，原因见本运行 coda:\/\/workflow-runs\/pr-run-1 的「评审这次交付」/);
  assert.equal(f.run('review').outputs.review, '没填评审者，这一块不评审。');
  f.run('gate'); f.run('gate-failed');
  assert.equal(f.run('review', { REVIEWER: 'true' }).outputs.review, '项目检查没通过，这次交付没有评审。');
});

test('退回之后复评：只评上次评过的提交之后的变动，带上没关的必须修，任务书后附历次退回意见；定了不改的由流程关掉，不再交评审者', t => {
  const f = fixture(t); f.task('one', 'first'); f.run('execute'); f.delivered();
  const first = f.state().executor.head;
  f.run('reviewed', verdict([MUST, CONTRACT, NIT]));
  assert.equal(f.decide('revise', '修 #1\n#2 不改：调用方已经跟着改了'), 'revise');
  assert.deepEqual(f.state().findings.map(x => [x.id, x.status]), [['#1', 'open'], ['#2', 'declined']]);
  f.task('one', 'fixed'); f.run('revise');
  f.run('gate');
  const again = f.run('gate-passed', { RUNS: '[]' }).outputs, second = f.state().executor.head;
  assert.deepEqual([again.base, again.head], [first, second], '复评：base 是上次评过的 head');
  assert.deepEqual(JSON.parse(again.previous), [{ id: '#1', ...MUST }], '定了不改的 #2 已关掉，不交评审者');
  // 定了不改的条目带上标题和位置：评审者在意见里只看得到编号。
  assert.equal(again.task, `${f.env.TASK}\n\n下面是主 Agent 历次「退回修改」的意见（原文，按先后），其中写明不改的已经关闭，不要再提：\n第 1 次：\n修 #1\n#2 不改：调用方已经跟着改了\n\n主 Agent 定了不改、已经关闭的条目（编号对应上面意见里的编号）：\n- #2 改了输出格式（one:2）`);
  f.run('reviewed', verdict([{ ...MUST, title: '新问题', location: 'one:9' }], { RESOLUTIONS: JSON.stringify([{ id: '#1', status: 'resolved' }]) }));
  assert.deepEqual(f.state().findings.map(x => [x.id, x.status]), [['#1', 'resolved'], ['#2', 'declined'], ['#3', 'open']]);
  const review = f.run('review', { REVIEWER: 'true' }).outputs.review;
  assert.ok(review.includes('必须修 1 条：\n- #3 新问题（one:9）\n小问题 0 条，原有问题 0 条。\n评审原文：'), review);
  assert.doesNotMatch(review, /#2|定了不改/);
  assert.equal(f.run('review').outputs.returns, '1');

  // 第二次退回：只带上还开着的 #3，任务书后附两次的意见。
  f.decide('revise', '修 #3'); f.task('one', 'again'); f.run('revise'); f.run('gate');
  const third = f.run('gate-passed', { RUNS: '[]' }).outputs;
  assert.equal(third.base, second);
  assert.deepEqual(JSON.parse(third.previous).map(x => x.id), ['#3']);
  assert.ok(third.task.includes('第 1 次：\n修 #1') && third.task.includes('第 2 次：\n修 #3'));
  f.run('reviewed', verdict([], { RESOLUTIONS: JSON.stringify([{ id: '#3', status: 'resolved' }]) }));
  assert.ok(f.run('review', { REVIEWER: 'true' }).outputs.review.startsWith('评审结论一句话\n必须修 0 条。\n小问题 0 条'));

  // 换人或合并需求分支之后回到完整评审：base 是需求分支 head，之前没关的作废。
  f.run('reviewed', verdict([MUST]));
  assert.equal(f.decide('sync'), 'revise'); f.task('one', 'merged'); f.run('revise'); f.run('gate');
  const full = f.run('gate-passed', { RUNS: '[]' }).outputs;
  assert.deepEqual([full.base, full.previous], [f.remote(BRANCH), '']);
  f.run('reviewed', verdict([]));
  assert.equal(f.state().findings.at(-1).status, 'superseded');
});

// 换人、让执行者合并需求分支（审查卡上选，或合入时试合并有冲突）之后，到有一次完整评审评成为止都按完整评审算，不带之前的发现：
// 这次完整评审没评成、主 Agent 又退回时，不能拿换人或合并之前评过的提交当起点。
test('换人或合并需求分支之后完整评审没评成、主 Agent 再退回：仍是完整评审，不带之前的发现；评成之后再退回才从它评过的提交复评', t => {
  const incomplete = { DECISION: 'INCOMPLETE', LINE: '评审没有完成：没有合格的 review 代码块' };
  const ways = {
    sync: f => { assert.equal(f.decide('sync'), 'revise'); f.task('one', 'merged', BRANCH); f.run('revise'); },
    swap: f => { assert.equal(f.decide('swap', '换人', 'true'), 'swap'); f.task('redo', 'redo'); f.run('swap', { EXECUTOR: JSON.stringify({ agent: 'backup' }) }); },
    land: f => {
      f.advance('one', 'other piece'); assert.equal(f.decide('land'), 'land'); assert.equal(f.run('land').outputs.route, 'sync');
      f.task('one', 'resolved', BRANCH); f.run('revise');
    },
  };
  for (const [way, change] of Object.entries(ways)) {
    const f = fixture(t); f.task('one', 'first'); f.run('execute'); f.delivered();
    f.run('reviewed', verdict([MUST]));
    const old = f.state().reviewed;
    change(f); f.run('gate');
    const full = f.run('gate-passed', { RUNS: '[]' }).outputs;
    assert.deepEqual([full.base, full.previous], [f.remote(BRANCH), ''], `${way}：之后的第一次评审是完整评审`);
    f.run('reviewed', verdict([], incomplete));
    assert.equal(f.run('review', { REVIEWER: 'true' }).outputs.review, '没评成：评审没有完成：没有合格的 review 代码块', `${way}：完整评审没评成，不列之前的发现`);
    // 没评成之后再退回：还是完整评审，不能从换人或合并之前评过的提交算起，也不带之前的发现。
    assert.equal(f.decide('revise', '再改一下'), 'revise'); f.task('one', 'again'); f.run('revise'); f.run('gate');
    const next = f.run('gate-passed', { RUNS: '[]' }).outputs;
    assert.notEqual(next.base, old, way);
    assert.deepEqual([next.base, next.previous], [f.remote(BRANCH), ''], `${way}：没评成之后再退回仍是完整评审`);
    // 完整评审评成了，之前的作废；再退回才是复评，从这次评成的提交算起。
    f.run('reviewed', verdict([]));
    assert.equal(f.state().findings[0].status, 'superseded', way);
    assert.equal(f.decide('revise', '再退一次'), 'revise'); f.task('one', 'more'); f.run('revise'); f.run('gate');
    const rereview = f.run('gate-passed', { RUNS: '[]' }).outputs;
    assert.deepEqual([rereview.base, rereview.previous], [next.head, '[]'], `${way}：评成之后的退回是复评`);
  }
});

test('复评没评成（评审者出错、超时、答复不合格，或调用没成）：审查卡仍列出上一轮还开着的必须修，注明这一轮没有重新核实；评成的复评在坚持的条目后写理由', t => {
  const f = fixture(t); f.task('one', 'first'); f.run('execute'); f.delivered();
  f.run('reviewed', verdict([MUST, CONTRACT, { ...MUST, title: '第三条', location: 'one:3' }]));
  assert.equal(f.decide('revise', '修 #1、#2\n#3 不改：不影响'), 'revise'); f.task('one', 'fixed'); f.run('revise'); f.run('gate'); f.run('gate-passed', { RUNS: '[]' });
  const listed = '\n上一轮还开着的必须修（这一轮没有重新核实）：\n- #1 漏了失败路径（one:1）\n- #2 改了输出格式（one:2）〔评审者认为涉及对外契约〕';
  f.run('reviewed', verdict([], { DECISION: 'INCOMPLETE', LINE: '评审没有完成：没有合格的 review 代码块' }));
  assert.equal(f.run('review', { REVIEWER: 'true' }).outputs.review, `没评成：评审没有完成：没有合格的 review 代码块${listed}`, '评审没完成；定了不改的 #3 不列');
  f.run('review-lost');
  const lost = f.run('review', { REVIEWER: 'true' }).outputs.review;
  assert.match(lost, /^没评成：调用 review-commit 没有成功，原因见本运行 coda:\/\/workflow-runs\/pr-run-1 的「评审这次交付」（workflow_status）。/);
  assert.ok(lost.endsWith(listed), lost);
  // 项目检查没过时没有评审，不列；没有开着的必须修时也不列。
  f.run('gate'); f.run('gate-failed');
  assert.equal(f.run('review', { REVIEWER: 'true' }).outputs.review, '项目检查没通过，这次交付没有评审。');

  // 评成的复评：坚持的条目后面是评审者给的理由（现在的代码还缺什么），解决了的不再列。
  const g = fixture(t); g.task('one', 'first'); g.run('execute'); g.delivered();
  g.run('reviewed', verdict([MUST, CONTRACT]));
  g.decide('revise', '修 #1、#2'); g.task('one', 'fixed'); g.run('revise'); g.run('gate'); g.run('gate-passed', { RUNS: '[]' });
  g.run('reviewed', verdict([], { DECISION: 'REQUEST_CHANGES', RESOLUTIONS: JSON.stringify([{ id: '#1', status: 'upheld', reason: '失败时\n还是没有退出码' }, { id: '#2', status: 'resolved' }]) }));
  assert.deepEqual(g.state().findings.map(x => [x.id, x.status]), [['#1', 'open'], ['#2', 'resolved']]);
  assert.equal(g.run('review', { REVIEWER: 'true' }).outputs.review.split('\n').slice(0, 4).join('\n'), '评审结论一句话\n必须修 1 条：\n- #1 漏了失败路径（one:1）\n  现在的代码还缺：失败时 还是没有退出码');
});

test('合进需求分支时输出 reviewed：最后一次交付有评成的评审才是 true；没评审者、没评成、评的是之前的交付都是 false', t => {
  const landed = setup => { const f = fixture(t); f.task('one', 'first'); f.run('execute'); f.delivered(); setup(f); f.decide('land'); return f.run('land').outputs.reviewed; };
  assert.equal(landed(f => f.run('reviewed', verdict([NIT]))), 'true');
  assert.equal(landed(() => {}), 'false', '没评审者（评审者：无）');
  assert.equal(landed(f => f.run('reviewed', verdict([], { DECISION: 'INCOMPLETE', LINE: '评审没有完成' }))), 'false', '没评成');
  assert.equal(landed(f => f.run('review-lost')), 'false', '调用没成');
  assert.equal(landed(f => { f.run('reviewed', verdict([MUST])); f.decide('revise', '修 #1'); f.task('one', 'fixed'); f.run('revise'); f.run('gate'); f.run('gate-failed'); }), 'false', '评过的是之前的交付');
});

test('同一块退回满三次后再退回：不退回，出用户卡「这一块三轮没过」列这次的意见和还开着的必须修；继续修清零并按这次的意见退回，放弃同主 Agent 放弃', t => {
  const f = fixture(t); f.task('one', 'first'); f.run('execute'); f.delivered();
  f.run('reviewed', verdict([MUST]));
  for (let i = 1; i <= 3; i++) { assert.equal(f.decide('revise', `第 ${i} 次`), 'revise'); f.task('one', `fix ${i}`); f.run('revise'); }
  const calls = f.calls('agent').length;
  const stuck = f.run('decide', { REVIEW: JSON.stringify({ choice: 'revise', note: '第 4 次：#1 还没修' }), BACKUP: 'false' }).outputs;
  assert.deepEqual(stuck, { route: 'stuck', stuck: '主 Agent 这次的退回意见：\n第 4 次：#1 还没修\n\n还开着的必须修：\n- #1 漏了失败路径（one:1）' });
  assert.equal(f.state().returns, 3, '没退回，次数不变');
  assert.equal(f.state().notes.length, 3);
  assert.equal(f.run('stuck', { STUCK: JSON.stringify({ choice: 'continue' }) }).outputs.route, 'revise');
  assert.deepEqual([f.state().returns, f.state().feedback, f.state().notes.at(-1), f.state().pending], [1, '第 4 次：#1 还没修', '第 4 次：#1 还没修', undefined], '清零后按这次的意见退回，算新一轮的第一次');
  f.task('one', 'fix 4'); f.run('revise');
  assert.equal(f.calls('agent').length, calls + 1);
  assert.ok(f.calls('agent').at(-1).prompt.includes('第 4 次：#1 还没修'));
  assert.equal(f.decide('revise', '再退一次'), 'revise', '清零后又能退回');

  const g = fixture(t); g.task('one', 'first'); g.run('execute'); g.delivered();
  for (let i = 1; i <= 3; i++) { g.decide('revise', `第 ${i} 次`); g.task('one', `fix ${i}`); g.run('revise'); }
  assert.equal(g.decide('revise', '还要改'), 'stuck');
  assert.equal(g.run('stuck', { STUCK: JSON.stringify({ choice: 'abandon' }) }).outputs.route, 'abandon');
  assert.ok(g.run('decide', { REVIEW: JSON.stringify({ choice: 'revise', note: '还要改' }), BACKUP: 'false' }).outputs.stuck.endsWith('还开着的必须修：\n没有'));
});

test('三轮没过用户选「不退了，合进需求分支」：不再退回执行者，走同一个 land 合进需求分支，结果记明是用户定的；主 Agent 自己合进的不带这个记号', t => {
  const f = fixture(t); f.task('one', 'first'); f.run('execute'); f.delivered();
  f.run('reviewed', verdict([MUST]));
  for (let i = 1; i <= 3; i++) { f.decide('revise', `第 ${i} 次`); f.task('one', `fix ${i}`); f.run('revise'); }
  assert.equal(f.decide('revise', '第 4 次'), 'stuck');
  const agentCalls = f.calls('agent').length, head = f.state().executor.head, tip = f.git('rev-parse', `origin/${BRANCH}`);
  assert.equal(f.run('stuck', { STUCK: JSON.stringify({ choice: 'land' }) }).outputs.route, 'land');
  assert.equal(f.state().pending, undefined);
  assert.equal(f.calls('agent').length, agentCalls, '没有退回执行者');
  const landed = f.run('land').outputs;
  assert.deepEqual([landed.route, landed.by], ['landed', 'user']);
  assert.equal(f.remote(BRANCH), landed.commit, '合进了需求分支');
  assert.equal(f.git('rev-parse', `${landed.commit}^@`), tip, '同「合进需求分支」：squash 成一个提交接在需求分支 head 上');
  assert.equal(f.git('log', '-1', '--format=%B', landed.commit), '输入框可以输入\n\nCoda-Piece: pr-run-1');
  assert.notEqual(head, landed.commit);
  assert.equal(f.state().returns, 3, '退回次数不变');

  // 主 Agent 自己合进：没有用户记号；用户选了合进但有冲突交回执行者后，主 Agent 再答复，记号清掉。
  const g = fixture(t); g.task('one', 'first'); g.run('execute'); g.delivered();
  assert.equal(g.decide('land'), 'land');
  assert.equal(g.run('land').outputs.by, '');
  const h = fixture(t); h.task('one', 'first'); h.run('execute'); h.delivered();
  for (let i = 1; i <= 3; i++) { h.decide('revise', `第 ${i} 次`); h.task('one', `fix ${i}`); h.run('revise'); }
  h.decide('revise', '第 4 次'); h.run('stuck', { STUCK: JSON.stringify({ choice: 'land' }) });
  assert.equal(h.state().userLand, true);
  h.decide('land');
  assert.equal(h.state().userLand, undefined);
});

test('「不改」只认独立成行的写法：行首（可带 -、*）是「#编号 不改」，后面是行尾或「：」「:」「，」「,」接理由；句子中间提到的不算', t => {
  for (const [note, declined] of [
    ['修 #1，#1 不改会继续导致失败', []],
    ['#3 不改的话会失败', []],
    ['#1 不改，理由\n#2 不改：这次只修 #3\n#3\n不改', ['#1', '#2']],
    ['#2 不改', ['#2']],
    ['- #2 不改：只影响少见路径', ['#2']],
    ['  * #1 不改, 理由\n#3 不改:理由', ['#1', '#3']],
  ]) {
    const f = fixture(t); f.task('one', 'first'); f.run('execute'); f.delivered();
    f.run('reviewed', verdict([1, 2, 3].map(n => ({ ...MUST, title: `问题 ${n}` }))));
    f.decide('revise', note);
    assert.deepEqual(f.state().findings.filter(x => x.status === 'declined').map(x => x.id), declined, note);
    f.task('one', 'fixed'); f.run('revise'); f.run('gate');
    assert.deepEqual(JSON.parse(f.run('gate-passed', { RUNS: '[]' }).outputs.previous).map(x => x.id), ['#1', '#2', '#3'].filter(id => !declined.includes(id)), note);
  }
});
