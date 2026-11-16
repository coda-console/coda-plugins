// 块（plugins/composer/.coda/workflows/piece.bpmn、scripts/piece.mjs）：临时 Git 仓库、假的 coda-agent，gh 只记调用（块不开 PR），
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
    writeFileSync(join(work, file), text); git('add', file); git('commit', '-qm', `lane ${file}`); git('push', '-q', 'origin', `HEAD:refs/heads/${BRANCH}`);
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
  assert.deepEqual(f.run('review').outputs, { session: 'worker-1', head, answer: 'first answer', branch: BRANCH, temp: TEMP,
    checks: '此提交项目检查未通过。', feedback: '', returns: '0', reviews: '' });

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
  assert.deepEqual(f.run('land').outputs, { route: 'landed', commit: head });
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
  assert.deepEqual(passed, { base: f.remote(BRANCH), task: f.env.TASK, checks: 'test: succeeded coda://workflow-runs/check-1' });
  assert.equal(f.run('review').outputs.checks, passed.checks);
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

test('块的流程定义：输入、回路、审查卡答复、结束输出与放弃的出错结束；不开 PR、不出用户卡、不装机、不部署、不跑合并前检查', async () => {
  const { process, sub, elements, nodes, values, params, route, next } = await definition();
  assert.equal(process.name, '块'); assert.equal(process.kind, undefined, '不是一种开发流程实现');
  const inputs = Object.fromEntries(values(process).map(v => [v.name, v]));
  assert.deepEqual(Object.keys(inputs), ['branch', 'base', 'title', 'task', 'sync', 'executor', 'executor2', 'reviewer', 'reviewer2']);
  for (const name of ['branch', 'base', 'title', 'task']) assert.equal(inputs[name].required, true, name);
  assert.deepEqual([inputs.sync.type, inputs.sync.default], ['boolean', 'false']);
  // 必填且没有默认值：引擎 resolveInputs 对没给、又无默认的 required 输入在启动时报「需要参数 executor」，不再落到发起会话。
  assert.deepEqual([inputs.executor.type, inputs.executor.required, inputs.executor.default, inputs.executor.defaultFrom], ['agent', true, undefined, undefined]);
  for (const name of ['executor2', 'reviewer', 'reviewer2']) assert.deepEqual([inputs[name].type, inputs[name].default, inputs[name].required], ['agent', undefined, undefined], name);
  assert.deepEqual(Object.fromEntries(Object.entries(params('execute')).filter(([k]) => k !== 'EXECUTOR')), { BRANCH: '=inputs.branch', BASE: '=inputs.base', TITLE: '=inputs.title', TASK: '=inputs.task', SYNC: '=inputs.sync' });
  // 执行者只来自 inputs.executor，没有取发起会话的回退；引擎把 env 里的对象转成 JSON 文本，脚本再解析。
  assert.equal(params('execute').EXECUTOR, '=inputs.executor');
  const executor = { agent: 'codex', model: 'gpt-6' };
  assert.deepEqual(JSON.parse(JSON.stringify(evaluate(params('execute').EXECUTOR.slice(1), { inputs: { executor } }).value)), executor);
  assert.equal(params('swap').EXECUTOR, '=inputs.executor2');

  assert.deepEqual(elements.filter(e => e.$type === 'bpmn:UserTask').map(e => [e.id, e.assignee]), [['review', undefined]], '只有交给主 Agent 的审查卡');
  assert.deepEqual(elements.filter(e => e.action === 'run-workflows').map(e => [e.id, params(e.id).hook, params(e.id).commit]), [['checks', 'check', '=gate.head']]);
  assert.ok(!elements.some(e => ['hold-group', 'tell-session', 'workflow-kinds'].includes(e.action)));
  assert.deepEqual(values(nodes.review).map(v => [v.id, v.name]), [['revise', '退回修改'], ['sync', '让执行者合并需求分支'], ['swap', '换备用执行者重做'], ['land', '合进需求分支'], ['abandon', '放弃']]);
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
  assert.deepEqual(values(nodes.landed).map(v => [v.name, v.value]), [['commit', '=land.commit'], ['run', '=run.id']], '合进需求分支的提交与本运行，调用它的需求运行写进「需求进行中」');
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
  for (const [title, expected] of [['补齐状态', '块：补齐状态']]) assert.equal(evaluate(process.title.slice(1), { inputs: { title } }).value, expected);
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
  const first = f.state().executor.head, lane = f.remote(BRANCH);
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
  const pushed = f.remote(TEMP);
  const again = f.run('review-round').outputs;
  assert.deepEqual([again.base, again.head], [head, head]);
  assert.deepEqual(JSON.parse(again.previous).map(p => [p.id, p.response.disposition]), [['reviewer:1', 'disputed']]);
  assert.deepEqual(JSON.parse(again.previous2).map(p => [p.id, p.response]), [['reviewer2:1', undefined]], '没回应的那条也交复评');
  const upheld = JSON.stringify([{ id: 'reviewer:1', status: 'upheld', reason: '还是没有' }]);
  assert.equal(f.run('triage', { REVIEWS: JSON.stringify([reviewed('reviewer', head, [], { resolutions: upheld }),
    reviewed('reviewer2', head, [], { decision: 'APPROVE', resolutions: JSON.stringify([{ id: 'reviewer2:1', status: 'resolved' }]) })]) }).outputs.route, 'review');
  assert.equal(f.remote(TEMP), pushed, '没有推送');
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
  assert.deepEqual(f.run('review-round').outputs.base, f.remote(BRANCH));
});

test('流程定义：评审之后分流，交执行者的回路与升级都回到审查卡', async () => {
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
  const card = nodes.review.documentation[0].text, expression = [...card.matchAll(/{{(.*?)}}/g)].find(m => m[1].includes('rounds.text'))[1];
  assert.equal(evaluate(expression, { rounds: { text: '' } }).value, '');
  assert.match(evaluate(expression, { rounds: { text: '经过' } }).value, /^\n收敛经过（.*）：\n经过$/);
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
