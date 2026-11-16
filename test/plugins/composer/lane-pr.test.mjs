// 泳道 PR（plugins/composer/.coda/workflows/lane-pr.bpmn、scripts/lane-pr.mjs）：临时 Git 仓库、假的 coda-agent 与 gh，
// 网关条件用与引擎同版本的 FEEL 求值。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { readWorkflow } from '@coda-console/protocol/workflow';
import { evaluate } from 'feelin';

const script = fileURLToPath(new URL('../../../plugins/composer/scripts/lane-pr.mjs', import.meta.url));
const workflow = readFileSync(new URL('../../../plugins/composer/.coda/workflows/lane-pr.bpmn', import.meta.url), 'utf8');
// 已发布的流程定义（10.0.0、10.1.4、10.3.0）：在途运行按开工时的快照走，脚本却按当前装着的版本取，它引用的动作和输入输出都得留着。
const olds = ['10.0.0', '10.1.4', '10.3.0'].map(version => ({ version, source: readFileSync(new URL(`./fixtures/lane-pr-${version}.bpmn`, import.meta.url), 'utf8') }));
const old = olds[0].source;
const PR = 'https://github.com/example/fixture/pull/7', PARENT = 'https://github.com/example/fixture/pull/6';

function fixture(t, { sync = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'composer-lane-pr-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const work = join(root, 'work'), origin = join(root, 'origin.git'), bin = join(root, 'bin'), artifacts = join(root, 'artifacts');
  for (const path of [work, bin, artifacts]) mkdirSync(path);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CODA_ARTIFACTS: artifacts, RUNNER_TEMP: root,
    GITHUB_RUN_ID: 'pr-run-1', GITHUB_OUTPUT: join(root, 'outputs'), GITHUB_STEP_SUMMARY: join(root, 'summary'), CODA_THREAD_ID: 'thread-1',
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
const { mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');
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
// rebase：先 git rebase --onto <新基> <旧基>，冲突的话写好文件后继续变基。files：一次改好几个文件，null 是删除。
if (task.rebase) spawnSync('git', ['rebase', '--onto', ...task.rebase], { cwd, encoding: 'utf8' });
const write = () => {
  for (const [file, text] of Object.entries(task.files ?? { [task.file]: task.answer })) {
    if (text === null) rmSync(join(cwd, file));
    else { mkdirSync(dirname(join(cwd, file)), { recursive: true }); writeFileSync(join(cwd, file), text); }
  }
  git('add', '-A');
};
const rebasing = () => spawnSync('git', ['rev-parse', '-q', '--verify', 'REBASE_HEAD'], { cwd }).status === 0;
if (rebasing()) { write(); git('-c', 'core.editor=true', 'rebase', '--continue'); }
else if (!task.noCommit) { write(); git('commit', '-qm', task.answer); }
// 会话失败时 coda-agent 照样在标准输出给出会话（工作已提交）、以非零退出；silent 是连会话都没开成。
console.log(JSON.stringify({ session, branch, head: git('rev-parse', 'HEAD'), answer: task.answer }));
process.exit(task.exit ?? 0);
`);
  install('gh', String.raw`
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2), root = process.env.FIXTURE;
const calls = JSON.parse(readFileSync(join(root, 'gh-calls'), 'utf8'));
const body = args.includes('--body-file') ? readFileSync(args[args.indexOf('--body-file') + 1], 'utf8') : null;
calls.push({ args, body, thread: process.env.CODA_THREAD_ID ?? null }); writeFileSync(join(root, 'gh-calls'), JSON.stringify(calls));
const state = () => JSON.parse(readFileSync(join(process.env.CODA_ARTIFACTS, 'lane-pr.json'), 'utf8'));
// gh api 只认放弃用到的两种：按分支名查 matching-refs（--jq 精确比对后只输出存在的 ref）、DELETE 引用；分支在不在以假的 origin 为准。
if (args[0] === 'api') {
  const path = args.find(arg => arg.startsWith('repos/')), method = args.includes('--method') ? args[args.indexOf('--method') + 1] : 'GET';
  if (args[args.indexOf('--hostname') + 1] !== 'github.com') process.exit(2);
  const origin = join(root, 'origin.git'), ref = 'refs/' + path.replace(/^repos\/[^/]+\/[^/]+\/git\/(?:matching-refs|refs)\//, '');
  const git = (...params) => require('node:child_process').spawnSync('git', ['--git-dir', origin, ...params], { encoding: 'utf8' });
  const exists = git('rev-parse', '--verify', '-q', ref).status === 0;
  if (method === 'DELETE') process.exit(exists ? git('update-ref', '-d', ref).status : 1);
  if (exists) console.log(ref);
}
else if (args[0] === 'repo' && args[1] === 'view') console.log('https://github.com/example/fixture');
else if (args[1] === 'create') console.log('${PR}');
else if (args[1] === 'edit' && process.env.EDIT_EXIT) process.exit(Number(process.env.EDIT_EXIT));
else if (args[1] === 'list') { if (process.env.OPEN_PR) console.log(process.env.OPEN_PR); }
else if (args[1] === 'merge') { if (process.env.MERGE_EXIT) process.exit(Number(process.env.MERGE_EXIT)); }
else if (args[1] === 'view' && args.includes('state,headRefOid,mergeCommit')) console.log(JSON.stringify({ state: process.env.PR_STATE || 'OPEN', headRefOid: state().executor.head, mergeCommit: { oid: 'f'.repeat(40) } }));
// 前置泳道 PR：开工时取全部字段，「查看前置泳道 PR」只取 state；内容在 FIXTURE/parent。本运行的 PR 只取 state 时看 OWN_STATE（默认开着）。
else if (args[1] === 'view' && args.includes('url,state,headRefName,headRefOid,baseRefName')) console.log(readFileSync(join(root, 'parent'), 'utf8'));
else if (args[1] === 'view' && args.at(-1) === 'state' && args[2] === '${PR}') console.log(JSON.stringify({ state: process.env.OWN_STATE || 'OPEN' }));
// 重接前读前置合并时的最终 head（FIXTURE/parent 的 headRefOid）。
else if (args[1] === 'view' && args.at(-1) === 'headRefOid') console.log(JSON.stringify({ headRefOid: JSON.parse(readFileSync(join(root, 'parent'), 'utf8')).headRefOid }));
else if (args[1] === 'view' && args.at(-1) === 'state,baseRefName') { const { state, baseRefName } = JSON.parse(readFileSync(join(root, 'parent'), 'utf8')); console.log(JSON.stringify({ state, baseRefName })); }
else if (args[1] === 'view' && args.includes('state,mergeable')) console.log(JSON.stringify({ state: 'OPEN', mergeable: process.env.PR_MERGEABLE || 'MERGEABLE' }));
else if (args[1] === 'view') console.log('f'.repeat(40));
`);
  writeFileSync(join(root, 'agent-calls'), '[]'); writeFileSync(join(root, 'gh-calls'), '[]');
  const state = () => JSON.parse(readFileSync(join(artifacts, 'lane-pr.json'), 'utf8'));
  const calls = name => JSON.parse(readFileSync(join(root, `${name}-calls`), 'utf8'));
  const task = (file, answer, merge, fail = {}) => writeFileSync(join(root, 'agent-task'), JSON.stringify({ file, answer, merge, ...fail }));
  // 步骤的检出方式照流程定义：coda:checkout="false" 的步骤在没有 .git、没有 origin 的空目录里跑，一用 git 就失败。
  const empty = join(root, 'empty'); mkdirSync(empty);
  const noCheckout = new Set([...workflow.matchAll(/<scriptTask\b[^>]*>[\s\S]*?<\/scriptTask>/g)]
    .filter(([task]) => /coda:checkout="false"/.test(task.slice(0, task.indexOf('>'))))
    .map(([task]) => task.match(/lane-pr\.mjs" ([\w-]+)</)[1]));
  // cwd：在别的检出里跑（流程每次重试都是新检出的工作区，见 fresh）。
  const run = (action, extra = {}, expected = 0, cwd = noCheckout.has(action) ? empty : work) => {
    writeFileSync(env.GITHUB_OUTPUT, '');
    const result = spawnSync(process.execPath, [script, action], { cwd, env: { ...env, ...(cwd === empty && { GIT_CEILING_DIRECTORIES: root }), ...extra }, encoding: 'utf8' });
    assert.equal(result.status, expected, result.stderr);
    const outputs = Object.fromEntries([...readFileSync(env.GITHUB_OUTPUT, 'utf8').matchAll(/(\w+)<<([^\n]+)\n([\s\S]*?)\n\2\n/g)].map(([, key, , value]) => [key, value]));
    return { ...result, outputs };
  };
  const decide = (choice, note = '', BACKUP = 'false') => run('decide', { REVIEW: JSON.stringify({ choice, note }), BACKUP }).outputs.route;
  const remote = ref => git('ls-remote', 'origin', ref).split('\t')[0];
  // 别的泳道 PR 合进了泳道：在泳道上另提交一个。
  const advanceLane = (file, text) => {
    git('fetch', '-q', 'origin', 'lane/req-1'); git('switch', '-q', '--detach', 'FETCH_HEAD');
    mkdirSync(dirname(join(work, file)), { recursive: true }); writeFileSync(join(work, file), text); git('add', file); git('commit', '-qm', `lane ${file}`); git('push', '-q', 'origin', 'HEAD:refs/heads/lane/req-1');
    return git('rev-parse', 'HEAD');
  };
  const delivered = () => { run('gate'); run('gate-passed', { RUNS: '[]' }); };
  // 前置泳道 PR：从泳道开 lane-pr/parent-run，提交几个散提交后推送；squash 把它压成一个提交合进泳道。
  const setParent = fields => writeFileSync(join(root, 'parent'), JSON.stringify({ ...JSON.parse(readFileSync(join(root, 'parent'), 'utf8')), ...fields }));
  const parent = (files = { 'p1': 'parent one', 'p2': 'parent two' }) => {
    git('fetch', '-q', 'origin', 'lane/req-1'); git('switch', '-q', '--detach', 'FETCH_HEAD');
    const commits = Object.entries(files).map(([file, text]) => { writeFileSync(join(work, file), text); git('add', file); git('commit', '-qm', `parent ${file}`); return git('rev-parse', 'HEAD'); });
    git('push', '-q', 'origin', 'HEAD:refs/heads/lane-pr/parent-run');
    writeFileSync(join(root, 'parent'), JSON.stringify({ url: PARENT, state: 'OPEN', headRefName: 'lane-pr/parent-run', headRefOid: commits.at(-1), baseRefName: 'lane/req-1' }));
    return { head: commits.at(-1), commits };
  };
  const squash = head => {
    git('fetch', '-q', 'origin', 'lane/req-1'); git('switch', '-q', '--detach', 'FETCH_HEAD');
    git('merge', '-q', '--squash', head); git('commit', '-qm', 'parent (squash)'); git('push', '-q', 'origin', 'HEAD:refs/heads/lane/req-1');
    setParent({ state: 'MERGED' });
    return git('rev-parse', 'HEAD');
  };
  // 新检出的工作区：从 origin 克隆，没有上一次工作区里留下的对象。
  let checkouts = 0;
  const fresh = () => { const dir = join(root, `checkout-${++checkouts}`); git('clone', '-q', origin, dir); return dir; };
  return { root, work, env, git, run, state, calls, task, decide, remote, advanceLane, delivered, parent, setParent, squash, fresh };
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
  assert.equal(f.run('review').outputs.stack, '', '没叠放，审查卡不提示');

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

test('放弃（在没有检出的空目录里只用 gh）：关闭 PR，分支在就用 gh api 删除，泳道不动', t => {
  const f = fixture(t); f.task('code', 'first'); f.run('execute'); f.delivered();
  const laneHead = f.remote('lane/req-1');
  assert.ok(f.remote('lane-pr/pr-run-1'));
  assert.deepEqual(f.run('abandon').outputs, { pr: PR });
  const [close, find, remove] = f.calls('gh').slice(-3).map(c => c.args);
  assert.deepEqual(close, ['pr', 'close', PR, '--repo', 'github.com/example/fixture']);
  assert.deepEqual(find, ['api', '--hostname', 'github.com', 'repos/example/fixture/git/matching-refs/heads/lane-pr/pr-run-1',
    '--jq', '.[] | select(.ref == "refs/heads/lane-pr/pr-run-1") | .ref']);
  assert.deepEqual(remove, ['api', '--hostname', 'github.com', '--method', 'DELETE', 'repos/example/fixture/git/refs/heads/lane-pr/pr-run-1']);
  assert.equal(f.remote('lane-pr/pr-run-1'), '', '分支已删');
  assert.equal(f.remote('lane/req-1'), laneHead);
});

test('放弃重跑：PR 已关闭、分支还在时补删分支；分支已不在时跳过删除、照样成功', t => {
  const f = fixture(t); f.task('code', 'first'); f.run('execute'); f.delivered();
  f.run('abandon');
  f.git('push', '-q', 'origin', `${f.state().executor.head}:refs/heads/lane-pr/pr-run-1`);
  assert.ok(f.remote('lane-pr/pr-run-1'));
  assert.deepEqual(f.run('abandon').outputs, { pr: PR });
  assert.equal(f.remote('lane-pr/pr-run-1'), '');
  const deletes = () => f.calls('gh').filter(c => c.args.includes('DELETE')).length;
  assert.equal(deletes(), 2);
  assert.deepEqual(f.run('abandon').outputs, { pr: PR });
  assert.equal(deletes(), 2, '分支已不在就不再删');
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
  assert.equal(f.remote('lane-pr/pr-run-1'), f.state().executor.head, '接回会话做完的提交照常推送');
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
  assert.equal(f.state().pr, '', '其余状态照旧重建');
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
  assert.deepEqual(f.calls('agent').at(-1).args.slice(0, 4), ['--commit', f.remote('lane/req-1'), '--title', '输入框可以输入']);
  assert.equal(f.state().executor.session, 'worker-4');
});

test('泳道 PR 流程定义：输入、回路、审查卡答复、结束输出；不出用户卡、不装机、不部署、不跑合并前检查', async () => {
  const { process, sub, elements, nodes, values, params, route, next } = await definition();
  assert.equal(process.name, '泳道 PR'); assert.equal(process.kind, undefined, '不是一种开发流程实现');
  const inputs = Object.fromEntries(values(process).map(v => [v.name, v]));
  assert.deepEqual(Object.keys(inputs), ['lane', 'title', 'task', 'sync', 'dependsOn', 'executor', 'executor2', 'reviewer', 'reviewer2', 'autoLandMinor']);
  for (const name of ['lane', 'title', 'task']) assert.equal(inputs[name].required, true, name);
  assert.deepEqual([inputs.sync.type, inputs.sync.default], ['boolean', 'false']);
  assert.deepEqual([inputs.dependsOn.type, inputs.dependsOn.default, inputs.dependsOn.label], ['string', '', '前置泳道 PR']);
  assert.deepEqual([inputs.autoLandMinor.type, inputs.autoLandMinor.default, inputs.autoLandMinor.label], ['boolean', 'false', '小改动免主控审查']);
  // 必填且没有默认值：引擎 resolveInputs 对没给、又无默认的 required 输入在启动时报「需要参数 executor」，不再落到发起会话。
  assert.deepEqual([inputs.executor.type, inputs.executor.required, inputs.executor.default, inputs.executor.defaultFrom], ['agent', true, undefined, undefined]);
  for (const name of ['executor2', 'reviewer', 'reviewer2']) assert.deepEqual([inputs[name].type, inputs[name].default, inputs[name].required], ['agent', undefined, undefined], name);
  assert.deepEqual(Object.fromEntries(Object.entries(params('execute')).filter(([k]) => k !== 'EXECUTOR')), { LANE: '=inputs.lane', TITLE: '=inputs.title', TASK: '=inputs.task', SYNC: '=inputs.sync', DEPENDS_ON: '=inputs.dependsOn' });
  // 执行者只来自 inputs.executor，没有取发起会话的回退；引擎把 env 里的对象转成 JSON 文本，脚本再解析。
  assert.equal(params('execute').EXECUTOR, '=inputs.executor');
  const executor = { agent: 'codex', model: 'gpt-6' };
  assert.deepEqual(JSON.parse(JSON.stringify(evaluate(params('execute').EXECUTOR.slice(1), { inputs: { executor } }).value)), executor);
  assert.equal(params('swap').EXECUTOR, '=inputs.executor2');

  assert.deepEqual(elements.filter(e => e.$type === 'bpmn:UserTask').map(e => [e.id, e.assignee]), [['review', undefined]], '只有交给主 Agent 的审查卡');
  assert.deepEqual(elements.filter(e => e.action === 'run-workflows').map(e => [e.id, params(e.id).hook, params(e.id).commit]), [['checks', 'check', '=gate.head']]);
  assert.ok(!elements.some(e => ['hold-group', 'tell-session', 'workflow-kinds'].includes(e.action)));
  assert.deepEqual(values(nodes.review).map(v => [v.id, v.name]), [['revise', '退回修改'], ['sync', '让执行者合并泳道'], ['swap', '换备用执行者重做'], ['land', '合进泳道'], ['abandon', '放弃']]);
  for (const [value, target] of [['review', 'rounds'], ['revise', 'revise'], ['swap', 'swap'], ['abandon', 'abandon'], ['land', 'land'], ['stack', 'stack-status']]) assert.equal(route('how', { decide: { route: value } }), target);
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
  assert.deepEqual(values(nodes.landed).map(v => [v.name, v.value]), [['pr', '=land.pr'], ['commit', '=land.commit'], ['autoLanded', '=land.auto = "true"'], ['summary', '=land.summary']]);
  for (const [auto, expected] of [['true', true], [undefined, false]]) assert.equal(evaluate('land.auto = "true"', { land: { pr: PR, ...(auto && { auto }) } }).value, expected);
  assert.deepEqual(values(nodes.abandoned).map(v => [v.name, v.value]), [['pr', '=abandon.pr']]);
  for (const [sync, text] of [[false, 'squash 合进泳道并删除分支'], [true, '把泳道快进到这次交付']]) {
    const expression = [...nodes.review.documentation[0].text.matchAll(/{{(.*?)}}/g)].find(m => m[1].includes('inputs.sync'))[1];
    assert.ok(evaluate(expression, { inputs: { sync } }).value.includes(text));
  }

  // 评审：两个位置各一份，填了的评每一次交付；没有只评第一次交付的位置。
  assert.equal(sub.optional, true);
  assert.equal(nodes['review-call'].calledElement, 'review-commit');
  assert.deepEqual(params('review-call'), { base: '=review-round.base', head: '=review-round.head', task: '=review-round.task', reviewer: '=slot.who', evidence: '=review-round.checks', previous: '=slot.previous' });
  for (const [reviewers, target] of [[{ reviewer: { agent: 'a1' } }, 'reviews'], [{ reviewer2: { agent: 'a2' } }, 'reviews'], [{}, 'stack-status']]) {
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
  assert.equal(f.run('triage', { REVIEWS: JSON.stringify([reviewed('reviewer', second, [], { decision: 'APPROVE', resolutions })]) }).outputs.route, 'pass');
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
    reviewed('reviewer2', head, [], { decision: 'APPROVE', resolutions: JSON.stringify([{ id: 'reviewer2:1', status: 'resolved' }]) })]) }).outputs.route, 'escalate');
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
  assert.equal(route('triage-route', { triage: { route: 'escalate' } }), 'rounds', '升级直接交主 Agent，不等前置、不判免审');
  assert.equal(route('triage-route', { triage: { route: 'pass' } }), 'stack-status');
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

test('10.3.0 的流程定义：分流只认 fix 交执行者，pass 与 escalate 都走默认分支交主 Agent 审查', async () => {
  const { route } = await definition(olds.find(o => o.version === '10.3.0').source);
  assert.equal(route('triage-route', { triage: { route: 'fix' } }), 'address');
  for (const value of ['pass', 'escalate']) assert.equal(route('triage-route', { triage: { route: value } }), 'rounds', value);
});

// 旧定义里每个脚本步骤：动作名、env 与输出。
const steps = source => [...source.matchAll(/<scriptTask id="([^"]+)"[\s\S]*?<\/scriptTask>/g)].map(([text, id]) => ({ id,
  action: /lane-pr\.mjs" ([\w-]+)</.exec(text)[1], env: [...text.matchAll(/<coda:env name="(\w+)"/g)].map(m => m[1]), outputs: [...text.matchAll(/<coda:output name="(\w+)"/g)].map(m => m[1]) }));

for (const { version, source: old } of olds) test(`${version} 的流程定义：它引用的每个动作新脚本都还有，env 与输出不变，照它的顺序走得通`, t => {
  const before = steps(old), now = steps(workflow), source = readFileSync(script, 'utf8');
  assert.deepEqual(before.map(s => s.action), version === '10.3.0'
    ? ['execute', 'gate', 'gate-failed', 'gate-passed', 'review-round', 'triage', 'address', 'rounds', 'review', 'decide', 'revise', 'swap', 'land', 'abandon']
    : ['execute', 'gate', 'gate-failed', 'gate-passed', 'review', 'decide', 'revise', 'swap', 'land', 'abandon']);
  for (const step of before) {
    assert.ok(source.includes(`case '${step.action}':`), step.action);
    // 新定义同一步骤可以多收 env、多给输出（旧定义不传、不收），旧的一个都不能少。
    const same = now.find(s => s.id === step.id);
    assert.equal(same.action, step.action, step.id);
    for (const key of ['env', 'outputs']) assert.deepEqual(same[key].filter(name => step[key].includes(name)), step[key], `${step.id} ${key}`);
  }
  // 旧定义调用 review-commit 用的参数，新能力都还收，新加的都不必填。
  const capability = readFileSync(new URL('../../../plugins/review/.coda/capabilities/review-commit.bpmn', import.meta.url), 'utf8');
  const inputs = Object.fromEntries([...capability.matchAll(/<coda:input name="(\w+)"([^>]*)\/>/g)].map(m => [m[1], m[2].includes('required="true"')]));
  const passed = [...old.matchAll(/<callActivity[\s\S]*?<\/callActivity>/g)][0][0].matchAll(/<coda:param name="(\w+)"/g);
  const given = [...passed].map(m => m[1]);
  for (const name of given) assert.ok(name in inputs, name);
  assert.deepEqual(Object.keys(inputs).filter(name => inputs[name] && !given.includes(name)), []);

  // 照旧定义的路径跑一遍：旧定义声明的输出每步都给出；多给的只能是新定义同一步骤声明的（旧定义不收）。
  const f = fixture(t), declared = Object.fromEntries(before.map(s => [s.action, s.outputs]));
  const check = (action, extra, expected) => {
    const keys = Object.keys(f.run(action, extra, expected).outputs);
    assert.deepEqual(keys.filter(key => declared[action].includes(key)).sort(), [...declared[action]].sort(), action);
    for (const key of keys.filter(key => !declared[action].includes(key))) assert.ok(now.some(s => s.action === action && s.outputs.includes(key)), `${action} ${key}`);
  };
  f.task('one', 'first'); check('execute');
  check('gate'); check('gate-failed'); f.task('one', 'second'); check('revise');
  check('gate'); check('gate-passed', { RUNS: '[]' });
  check('review', { REVIEWS: JSON.stringify([reviewed('reviewer', f.state().executor.head, [BUG])]) });
  f.run('decide', { REVIEW: JSON.stringify({ choice: 'swap', note: '换人' }), BACKUP: 'true' });
  check('decide', { REVIEW: JSON.stringify({ choice: 'land', note: '' }), BACKUP: 'false' });
  f.task('two', 'redo'); check('swap'); f.run('gate'); f.run('gate-passed', { RUNS: '[]' });
  check('land'); check('abandon');
});

test('接回会话失败：清掉记录，同一次里从泳道当前 head 新开会话给原任务，只回退一次', t => {
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

test('首次开工新建状态：只有输入、空的 pr、feedback、returns，成功后记下执行者与检查失败计数', t => {
  const f = fixture(t);
  f.task('one', 'first'); f.run('execute');
  const { executor, ...rest } = f.state();
  assert.deepEqual(rest, { lane: 'lane/req-1', branch: 'lane-pr/pr-run-1', title: '输入框可以输入', task: f.env.TASK, sync: false, pr: '', feedback: '', returns: 0,
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

// 叠放：评审通过的一份（APPROVE、没有发现）；叠放与免审都在分流 pass 之后。
const approved = head => reviewed('reviewer', head, [], { decision: 'APPROVE', line: '可以合' });
const ancestorOf = (f, older, newer) => spawnSync('git', ['merge-base', '--is-ancestor', older, newer], { cwd: f.work }).status === 0;

test('叠放：前置开着时从它的 head 开工、草稿 PR 开进它的分支、只评增量；前置 squash 合进泳道后 rebase --onto 只重接自己的提交，切回泳道、转正，重新检查并以泳道为 base 完整评审', t => {
  const f = fixture(t);
  const parent = f.parent();
  f.task('child', 'child work'); f.run('execute', { DEPENDS_ON: PARENT });
  assert.deepEqual(f.calls('agent')[0].args.slice(0, 2), ['--commit', parent.head], '从前置的 head 开工');
  assert.deepEqual(f.calls('gh')[0].args, ['repo', 'view', '--json', 'url', '--jq', '.url'], '先认当前仓库');
  assert.deepEqual(f.calls('gh')[1].args, ['pr', 'view', PARENT, '--repo', 'github.com/example/fixture', '--json', 'url,state,headRefName,headRefOid,baseRefName']);
  assert.deepEqual(f.state().stack, { pr: PARENT, branch: 'lane-pr/parent-run', head: parent.head, restacked: false });
  const first = f.state().executor.head;

  f.run('gate', { OPEN_PR: '' });
  assert.deepEqual(f.calls('gh').find(c => c.args[1] === 'list').args, ['pr', 'list', '--head', 'lane-pr/pr-run-1', '--state', 'open', '--limit', '1', '--json', 'url', '--jq', '.[].url'], '只按分支找');
  const created = f.calls('gh').find(c => c.args[1] === 'create');
  assert.deepEqual(created.args.slice(0, 9), ['pr', 'create', '--base', 'lane-pr/parent-run', '--head', 'lane-pr/pr-run-1', '--draft', '--title', '输入框可以输入']);
  assert.ok(created.body.includes(PARENT));
  assert.equal(f.run('gate-passed', { RUNS: '[]' }).outputs.base, parent.head);
  assert.deepEqual([f.run('review-round').outputs.base, f.state().converge.full], [parent.head, true], '评审只评这个 PR 自己的增量');
  assert.equal(f.run('triage', { REVIEWS: JSON.stringify([approved(first)]) }).outputs.route, 'pass');
  assert.equal(f.run('review').outputs.stack, PARENT, '仍叠放、还没重接，审查卡提示');
  assert.equal(f.run('stack-status').outputs.route, 'wait', '前置还开着就等');
  assert.equal(f.calls('gh').at(-1).args.join(' '), `pr view ${PARENT} --repo github.com/example/fixture --json state,baseRefName`);

  const lane = f.squash(parent.head);
  assert.equal(f.run('stack-status').outputs.route, 'restack');
  assert.equal(f.run('restack').outputs.route, 'gate');
  const head = f.state().executor.head;
  assert.equal(f.remote('lane-pr/pr-run-1'), head, '推送了重接后的 head');
  assert.deepEqual(f.git('rev-list', '--parents', '-n', '1', head).split(' '), [head, lane], '只有一个父提交：接在 squash 后的泳道上，没有双亲合并');
  assert.deepEqual(f.git('rev-list', `${lane}..${head}`).split('\n'), [head], '只重接了自己的一个提交');
  for (const commit of parent.commits) assert.ok(!ancestorOf(f, commit, head), `前置 squash 前的散提交 ${commit} 没有带进来`);
  assert.equal(f.git('show', `${head}:child`), 'child work');
  const [edit, ready] = f.calls('gh').slice(-2).map(c => c.args);
  assert.deepEqual(edit, ['pr', 'edit', PR, '--repo', 'github.com/example/fixture', '--base', 'lane/req-1']);
  assert.deepEqual(ready, ['pr', 'ready', PR, '--repo', 'github.com/example/fixture']);
  assert.deepEqual({ ...f.state().stack, note: undefined }, { pr: PARENT, branch: 'lane-pr/parent-run', head: parent.head, restacked: true, note: undefined });
  assert.match(f.state().stack.note, /reset --hard/);

  // 回到推送、检查、评审：base 是泳道最新 head，不是变基前评过的 head。
  f.delivered();
  assert.equal(f.run('review').outputs.stack, '', '重接之后审查卡不再提示');
  assert.equal(f.calls('gh').filter(c => c.args[1] === 'create').length, 1);
  assert.deepEqual(f.run('review-round').outputs.base, lane);
  assert.equal(f.run('triage', { REVIEWS: JSON.stringify([approved(head)]) }).outputs.route, 'pass');
  assert.equal(f.run('stack-status').outputs.route, 'ready');
  assert.equal(f.decide('land'), 'land', '重接之后可以合进泳道');
  assert.equal(f.run('land').outputs.route, 'landed');
  // 之后交给同一执行会话的修改先说明分支已被重接，说过一次就不再说。
  f.decide('revise', '再改一下'); f.task('child', 'more'); f.run('revise');
  assert.match(f.calls('agent').at(-1).prompt, /重接到了泳道[\s\S]*再改一下/);
  assert.equal(f.state().stack.note, undefined);
});

test('叠放：重接推送用 --force-with-lease，远端分支被别人改过时不覆盖、状态不动；重试在新检出的工作区重新变基并推送', t => {
  const f = fixture(t);
  const parent = f.parent();
  f.task('child', 'child work'); f.run('execute', { DEPENDS_ON: PARENT }); f.delivered();
  const first = f.state().executor.head, lane = f.squash(parent.head);
  const moved = f.advanceLane('other', 'other');
  f.git('push', '-q', '--force', 'origin', `${moved}:refs/heads/lane-pr/pr-run-1`);
  const before = f.state();
  f.run('restack', {}, 1);
  assert.equal(f.remote('lane-pr/pr-run-1'), moved, '租约不符，远端不动');
  const { pushing, ...stack } = f.state().stack;
  assert.deepEqual({ ...f.state(), stack }, before, '推之前失败，除了这次推送的记录，状态没动');
  assert.deepEqual([pushing.lane, pushing.from], [moved, first], '重接到泳道最新 head');
  assert.equal(f.calls('gh').filter(c => ['edit', 'ready'].includes(c.args[1])).length, 0);

  f.git('push', '-q', '--force', 'origin', `${first}:refs/heads/lane-pr/pr-run-1`);
  const lanes = f.remote('lane/req-1');
  assert.equal(f.run('restack', {}, 0, f.fresh()).outputs.route, 'gate');
  const head = f.state().executor.head;
  assert.notEqual(head, first);
  assert.equal(f.remote('lane-pr/pr-run-1'), head);
  f.git('fetch', '-q', 'origin', 'lane-pr/pr-run-1');
  assert.deepEqual(f.git('rev-list', '--parents', '-n', '1', head).split(' '), [head, lanes], '重新变基到泳道最新 head');
  assert.ok(!ancestorOf(f, parent.head, head) && ancestorOf(f, lane, head));
  assert.deepEqual([f.state().stack.restacked, f.state().stack.pushed, f.state().base], [true, undefined, lanes]);
  assert.deepEqual(f.calls('gh').slice(-2).map(c => c.args[1]), ['edit', 'ready']);
});

test('叠放：推送成功但没来得及记下结果（或响应丢了），重试在新检出的工作区按记下的推送收尾，不再变基、推送', t => {
  const f = fixture(t);
  const parent = f.parent();
  f.task('child', 'child work'); f.run('execute', { DEPENDS_ON: PARENT }); f.delivered();
  const first = f.state().executor.head, lane = f.squash(parent.head), path = join(f.env.CODA_ARTIFACTS, 'lane-pr.json');
  const before = readFileSync(path, 'utf8');
  f.run('restack', { EDIT_EXIT: '1' }, 1);
  const head = f.remote('lane-pr/pr-run-1');
  // 回到推送前那一刻落盘的状态：只有这次推送的记录，远端却已是新 head。
  const crashed = JSON.parse(before);
  crashed.stack.pushing = { lane, from: first, head };
  writeFileSync(path, JSON.stringify(crashed));
  const noPush = { GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_2: 'remote.origin.pushurl', GIT_CONFIG_VALUE_2: join(f.root, 'no-such-remote') };
  assert.equal(f.run('restack', noPush, 0, f.fresh()).outputs.route, 'gate');
  assert.equal(f.state().executor.head, head, '用记下的新 head，不再变基');
  assert.equal(f.remote('lane-pr/pr-run-1'), head);
  assert.deepEqual([f.state().stack.restacked, f.state().stack.pushing, f.state().stack.pushed, f.state().base], [true, undefined, undefined, lane]);
  assert.match(f.state().stack.note, new RegExp(`远端分支 lane-pr/pr-run-1 现在是 ${head}`));
  assert.deepEqual(f.calls('gh').slice(-2).map(c => c.args[1]), ['edit', 'ready']);
});

test('叠放：重接推送成功、改 PR 失败后，重试在新检出的工作区不再变基、推送，只切 base、转正', t => {
  const f = fixture(t);
  const parent = f.parent();
  f.task('child', 'child work'); f.run('execute', { DEPENDS_ON: PARENT }); f.delivered();
  const lane = f.squash(parent.head);
  f.run('restack', { EDIT_EXIT: '1' }, 1);
  const head = f.state().executor.head;
  assert.equal(f.remote('lane-pr/pr-run-1'), head, '推送成功');
  assert.deepEqual([f.state().stack.pushed, f.state().stack.restacked], [lane, false]);
  assert.match(f.state().stack.note, /reset --hard/);

  // 重试时推送一律失败：成功就说明没有再推。
  const noPush = { GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_2: 'remote.origin.pushurl', GIT_CONFIG_VALUE_2: join(f.root, 'no-such-remote') };
  assert.equal(f.run('restack', noPush, 0, f.fresh()).outputs.route, 'gate');
  assert.equal(f.state().executor.head, head, '不再变基');
  assert.equal(f.remote('lane-pr/pr-run-1'), head);
  assert.deepEqual([f.state().stack.restacked, f.state().stack.pushed, f.state().base], [true, undefined, lane]);
  assert.deepEqual(f.calls('gh').slice(-2).map(c => c.args.slice(1)), [['edit', PR, '--repo', 'github.com/example/fixture', '--base', 'lane/req-1'], ['ready', PR, '--repo', 'github.com/example/fixture']]);
});

test('叠放：重接冲突交原执行会话变基解冲突，回来核对后收尾', t => {
  const f = fixture(t);
  const parent = f.parent();
  f.task('shared', 'child version'); f.run('execute', { DEPENDS_ON: PARENT }); f.delivered();
  const first = f.state().executor.head;
  f.squash(parent.head);
  const lane = f.advanceLane('shared', 'lane version');
  assert.equal(f.run('restack').outputs.route, 'revise');
  assert.equal(f.remote('lane-pr/pr-run-1'), first, '冲突时远端不动');
  assert.deepEqual([f.state().executor.head, f.state().stack.restacked], [first, false]);
  for (const text of ['- shared', `git rebase --onto ${lane} ${parent.head}`, '不要 merge', '已 squash 合进泳道 lane/req-1']) assert.ok(f.state().feedback.includes(text), text);

  f.task('shared', 'resolved', undefined, { rebase: [lane, parent.head] }); f.run('revise');
  assert.deepEqual(f.calls('agent').at(-1).args.slice(0, 2), ['--continue', 'worker-1'], '同一执行会话');
  const head = f.state().executor.head;
  assert.ok(ancestorOf(f, lane, head) && !ancestorOf(f, parent.head, head));
  assert.equal(f.run('restack').outputs.route, 'gate');
  assert.equal(f.remote('lane-pr/pr-run-1'), head);
  assert.equal(f.state().stack.restacked, true);
  assert.equal(f.state().stack.note, undefined, '执行者自己重接的不用再提醒');
  assert.deepEqual(f.calls('gh').slice(-2).map(c => c.args[1]), ['edit', 'ready']);
});

// 叠放升级后，执行者已直接变基到泳道上：gate 解绑叠放之后照常检查、以泳道为 base 评审，合进泳道。
function landsAfterRecovery(f, lane) {
  assert.equal(f.state().stack.restacked, true);
  assert.deepEqual([f.state().stack.recover, f.state().stack.pending], [undefined, undefined]);
  assert.equal(f.run('gate-passed', { RUNS: '[]' }).outputs.base, lane, '以泳道为 base');
  assert.equal(f.run('review-round').outputs.base, lane);
  assert.equal(f.run('stack-status').outputs.route, 'ready');
  assert.equal(f.decide('land'), 'land');
  assert.equal(f.run('land').outputs.route, 'landed');
  assert.equal(f.calls('gh').filter(c => c.args[1] === 'merge').at(-1).args[2], PR);
}

test('叠放：执行者解冲突后没变基到泳道上交主 Agent；退回修改变基到泳道后，推送时切回泳道、转正，照常合进泳道', t => {
  const f = fixture(t);
  const parent = f.parent();
  f.task('shared', 'child version'); f.run('execute', { DEPENDS_ON: PARENT }); f.delivered();
  const first = f.state().executor.head;
  f.squash(parent.head);
  const lane = f.advanceLane('shared', 'lane version');
  assert.equal(f.run('restack').outputs.route, 'revise');
  f.task('more', 'still on parent'); f.run('revise');
  assert.equal(f.run('restack').outputs.route, 'review');
  assert.match(f.state().feedback, /没有变基到泳道上/);
  assert.equal(f.remote('lane-pr/pr-run-1'), first);
  assert.deepEqual([f.state().stack.recover, f.state().stack.pending, f.state().stack.restacked], [true, undefined, false]);

  f.decide('revise', '变基到泳道'); f.task('shared', 'resolved', undefined, { rebase: [lane, parent.head] }); f.run('revise');
  const head = f.run('gate').outputs.head;
  assert.equal(f.remote('lane-pr/pr-run-1'), head);
  assert.deepEqual(f.calls('gh').filter(c => ['view', 'edit', 'ready'].includes(c.args[1])).slice(-3).map(c => c.args.slice(1)),
    [['view', PR, '--repo', 'github.com/example/fixture', '--json', 'state'], ['edit', PR, '--repo', 'github.com/example/fixture', '--base', 'lane/req-1'],
      ['ready', PR, '--repo', 'github.com/example/fixture']]);
  landsAfterRecovery(f, lane);
});

test('叠放：前置在开工时的 head 之上追加提交后 squash 合进泳道（分支已删，只剩 refs/pull），取回前置最终 head 核对后照常重接', t => {
  const f = fixture(t);
  const parent = f.parent();
  f.task('child', 'child work'); f.run('execute', { DEPENDS_ON: PARENT }); f.delivered();
  // 前置退回修改，在原 head 上再推一个提交，以它 squash 合进泳道；合并后前置分支被删，只有 refs/pull/6/head 还指着它。
  f.git('switch', '-q', '--detach', parent.head); writeFileSync(join(f.work, 'p3'), 'parent three'); f.git('add', 'p3'); f.git('commit', '-qm', 'parent p3');
  const final = f.git('rev-parse', 'HEAD');
  f.setParent({ headRefOid: final });
  const lane = f.squash(final);
  f.git('push', '-q', 'origin', `${final}:refs/pull/6/head`, ':refs/heads/lane-pr/parent-run');
  assert.equal(f.run('stack-status').outputs.route, 'restack');
  // 新检出的工作区（--no-local：不拷对象库，只取分支能到的提交），本来没有前置最终 head。
  const checkout = join(f.root, 'checkout-pull'); f.git('clone', '-q', '--no-local', join(f.root, 'origin.git'), checkout);
  assert.notEqual(spawnSync('git', ['cat-file', '-e', final], { cwd: checkout }).status, 0, '新检出的工作区里本来没有前置最终 head');
  assert.equal(f.run('restack', {}, 0, checkout).outputs.route, 'gate');
  assert.deepEqual(f.calls('gh').find(c => c.args.at(-1) === 'headRefOid').args, ['pr', 'view', PARENT, '--repo', 'github.com/example/fixture', '--json', 'headRefOid']);
  const head = f.state().executor.head;
  f.git('fetch', '-q', 'origin', 'lane-pr/pr-run-1');
  assert.deepEqual(f.git('rev-list', '--parents', '-n', '1', head).split(' '), [head, lane], '只重接了自己的提交');
  assert.equal(f.git('show', `${head}:p3`), 'parent three', '追加的前置提交随 squash 在泳道里');
  assert.deepEqual([f.state().stack.restacked, f.state().stack.recover], [true, undefined]);
});

test('叠放：前置被 force-push 改写成不含开工时 head 的提交后 squash 合进泳道，不自动重接，交主 Agent 判断依赖', t => {
  const f = fixture(t);
  const parent = f.parent(), old = f.remote('lane/req-1');
  f.task('child', 'child work'); f.run('execute', { DEPENDS_ON: PARENT }); f.delivered();
  const first = f.state().executor.head;
  // 前置换人重做：从泳道重新提交、force-push，历史里不再有开工时的 head。
  f.git('switch', '-q', '--detach', old); writeFileSync(join(f.work, 'p1'), 'parent redo'); f.git('add', 'p1'); f.git('commit', '-qm', 'parent redo');
  const rewritten = f.git('rev-parse', 'HEAD');
  f.git('push', '-q', '--force', 'origin', `${rewritten}:refs/heads/lane-pr/parent-run`);
  f.setParent({ headRefOid: rewritten });
  f.squash(rewritten);
  assert.equal(f.run('stack-status').outputs.route, 'restack');
  assert.equal(f.run('restack').outputs.route, 'review');
  assert.match(f.state().feedback, new RegExp(`合并时的 head ${rewritten} 不再以这个 PR 开工时的前置 head ${parent.head} 为祖先[\\s\\S]*核对依赖是否仍成立`));
  assert.deepEqual([f.state().stack.restacked, f.state().stack.recover, f.state().stack.pushing], [false, true, undefined]);
  assert.equal(f.remote('lane-pr/pr-run-1'), first, '分支不动');
  assert.equal(f.calls('gh').filter(c => ['edit', 'ready'].includes(c.args[1])).length, 0);
  assert.equal(f.decide('land'), 'stack', '没解绑前照旧拦住');
});

test('叠放：等待期间前置被改为合进别的分支，开着或已合并都不重接，交主 Agent', t => {
  const f = fixture(t);
  const parent = f.parent();
  f.task('child', 'child work'); f.run('execute', { DEPENDS_ON: PARENT }); f.delivered();
  assert.equal(f.run('stack-status').outputs.route, 'wait');
  for (const state of ['OPEN', 'MERGED']) {
    f.setParent({ state, baseRefName: 'main' });
    assert.equal(f.run('stack-status').outputs.route, 'review', state);
    assert.match(f.state().feedback, /改为合进 main，不再合进泳道 lane\/req-1/);
    assert.deepEqual([f.state().stack.recover, f.state().stack.restacked, f.state().stack.head], [true, false, parent.head]);
  }
  assert.equal(f.remote('lane-pr/pr-run-1'), f.state().executor.head, '没有重接');
});

test('叠放：重接后运行从头重跑接回原执行会话，也带上重接提示，交出去且成功后才清；换人新开的会话不带', t => {
  const f = fixture(t);
  const parent = f.parent();
  f.task('child', 'child work'); f.run('execute', { DEPENDS_ON: PARENT }); f.delivered();
  f.squash(parent.head);
  assert.equal(f.run('restack').outputs.route, 'gate');
  const note = f.state().stack.note;
  f.task('child', 'half', undefined, { exit: 1 }); f.run('execute', {}, 1);
  assert.deepEqual(f.calls('agent').at(-1).args.slice(0, 2), ['--continue', 'worker-1']);
  assert.ok(f.calls('agent').at(-1).prompt.includes(note), '接回原会话带上重接提示');
  assert.equal(f.state().stack.note, note, '没成功不清');
  f.task('child', 'done'); f.run('execute');
  assert.ok(f.calls('agent').at(-1).prompt.includes(note));
  assert.equal(f.state().stack.note, undefined, '交出去且成功后才清');
  f.task('child', 'more'); f.run('execute');
  assert.ok(!f.calls('agent').at(-1).prompt.includes('重接到了泳道'), '只说一次');

  const g = fixture(t);
  const p2 = g.parent();
  g.task('child', 'child work'); g.run('execute', { DEPENDS_ON: PARENT }); g.delivered();
  g.squash(p2.head); g.run('restack');
  assert.equal(g.decide('swap', '换人', 'true'), 'swap');
  g.task('redo', 'redo'); g.run('swap', { EXECUTOR: JSON.stringify({ agent: 'backup' }) });
  assert.ok(!g.calls('agent').at(-1).prompt.includes('重接到了泳道'), '换人新开的会话不带');
  assert.equal(g.state().stack.note, undefined, '新会话不在重接前的分支上，提示作废');
});

test('叠放：前置关了没合并交主 Agent，重接前选合进泳道被拦下；退回修改变基到泳道后 PR 已被关掉就重新开进泳道，照常合进泳道', t => {
  const f = fixture(t);
  const parent = f.parent();
  f.task('child', 'child work'); f.run('execute', { DEPENDS_ON: PARENT }); f.delivered();
  assert.equal(f.decide('land'), 'stack');
  assert.match(f.state().feedback, /前置还没合进泳道、没有重接，现在不能合进泳道/);
  assert.equal(f.calls('gh').filter(c => c.args[1] === 'merge').length, 0);
  f.setParent({ state: 'CLOSED' });
  assert.equal(f.run('stack-status').outputs.route, 'review');
  assert.match(f.run('review').outputs.feedback, /已关闭、没有合并/);
  assert.equal(f.state().stack.recover, true);
  assert.equal(f.decide('land'), 'stack', '没解绑前照旧拦住');

  const lane = f.remote('lane/req-1');
  f.decide('revise', '改为直接基于泳道'); f.task('child', 'moved', undefined, { rebase: [lane, parent.head] }); f.run('revise');
  f.run('gate', { OWN_STATE: 'CLOSED' });
  const created = f.calls('gh').filter(c => c.args[1] === 'create');
  assert.equal(created.length, 2);
  assert.deepEqual(created[1].args.slice(0, 8), ['pr', 'create', '--base', 'lane/req-1', '--head', 'lane-pr/pr-run-1', '--title', '输入框可以输入'], '重新开进泳道的正式 PR');
  assert.equal(f.calls('gh').filter(c => c.args[1] === 'edit').length, 0);
  landsAfterRecovery(f, lane);
});

test('叠放：执行者改写了祖先时不自动重接、交主 Agent；没变基到最新泳道仍拦住，退回修改变基到泳道后切回泳道，照常合进泳道', t => {
  const f = fixture(t);
  const parent = f.parent(), old = f.remote('lane/req-1');
  f.task('child', 'child work'); f.run('execute', { DEPENDS_ON: PARENT }); f.delivered();
  // 执行者自己把提交挪到了泳道上（前置的 head 不再是祖先）：前置合进泳道后不自动重接。
  f.decide('revise', '改'); f.task('child', 'moved', undefined, { rebase: [old, parent.head] }); f.run('revise'); f.delivered();
  const lane = f.squash(parent.head);
  assert.equal(f.run('stack-status').outputs.route, 'restack');
  assert.equal(f.run('restack').outputs.route, 'review');
  assert.match(f.state().feedback, /不再以前置的 head .* 为祖先/);
  assert.deepEqual([f.state().stack.restacked, f.state().stack.recover], [false, true]);

  // 还在旧泳道上：不解绑，评审仍对前置的 head，合进泳道仍拦住。
  f.decide('revise', '再改'); f.task('child', 'again'); f.run('revise');
  f.run('gate');
  assert.deepEqual([f.state().stack.restacked, f.state().stack.recover, f.state().base], [false, true, parent.head]);
  assert.equal(f.decide('land'), 'stack');

  f.decide('revise', '变基到泳道最新 head'); f.task('child', 'rebased', undefined, { rebase: [lane, old] }); f.run('revise');
  f.run('gate');
  assert.deepEqual(f.calls('gh').slice(-2).map(c => c.args[1]), ['edit', 'ready']);
  landsAfterRecovery(f, lane);
});

test('叠放：升级后换备用执行者从泳道开工，推送时解绑叠放', t => {
  const f = fixture(t);
  const parent = f.parent();
  f.task('child', 'child work'); f.run('execute', { DEPENDS_ON: PARENT }); f.delivered();
  f.setParent({ state: 'CLOSED' });
  assert.equal(f.run('stack-status').outputs.route, 'review');
  const lane = f.remote('lane/req-1');
  assert.equal(f.decide('swap', '前置关了，从泳道重做', 'true'), 'swap');
  f.task('child', 'redo'); f.run('swap', { EXECUTOR: JSON.stringify({ agent: 'backup' }) });
  assert.deepEqual(f.calls('agent').at(-1).args.slice(0, 2), ['--commit', lane], '不从已失效的前置 head 开工');
  assert.ok(!ancestorOf(f, parent.head, f.state().executor.head));
  f.run('gate');
  assert.equal(f.state().stack.restacked, true);
  assert.equal(f.state().base, lane);
});

test('叠放开工的校验：sync 不能叠放，地址不合法、不在当前仓库、前置关了、多级叠放、叠在自己上都拒绝；前置已合进泳道就不叠放', t => {
  const f = fixture(t, { sync: true });
  f.parent();
  f.task('child', 'work');
  assert.match(f.run('execute', { DEPENDS_ON: PARENT }, 2).stderr, /sync/);
  const g = fixture(t);
  g.parent(); g.task('child', 'work');
  for (const [fields, text] of [[{ state: 'CLOSED' }, /已关闭、没有合并/], [{ baseRefName: 'lane-pr/grand-run' }, /单前置线性叠放，不支持多级/],
    [{ baseRefName: 'lane/other' }, /不是泳道 lane\/req-1/], [{ headRefName: 'lane-pr/pr-run-1' }, /不能叠在自己上/]]) {
    const saved = readFileSync(join(g.root, 'parent'), 'utf8');
    g.setParent(fields);
    assert.match(g.run('execute', { DEPENDS_ON: PARENT }, 2).stderr, text);
    writeFileSync(join(g.root, 'parent'), saved);
  }
  for (const url of ['example/fixture#6', 'https://github.com/example/fixture/issues/6', `${PARENT}/files`]) {
    assert.match(g.run('execute', { DEPENDS_ON: url }, 2).stderr, /不是 PR 的完整地址/, url);
  }
  // 别的仓库（含 fork）的 PR：开着且分支、提交都一样，或已合进同名泳道，都不放行。
  const other = 'https://github.com/someone/fixture/pull/6';
  for (const state of ['OPEN', 'MERGED']) {
    const saved = readFileSync(join(g.root, 'parent'), 'utf8');
    g.setParent({ state, url: other });
    assert.match(g.run('execute', { DEPENDS_ON: other }, 2).stderr, /不在当前仓库 github\.com\/example\/fixture/, state);
    assert.match(g.run('execute', { DEPENDS_ON: PARENT }, 2).stderr, /不在当前仓库/, `${state}：gh 给的 PR 地址也要在当前仓库`);
    writeFileSync(join(g.root, 'parent'), saved);
  }
  assert.equal(g.calls('gh').filter(c => c.args[2] === other).length, 0, '地址不在当前仓库，不再查 PR');
  assert.equal(g.calls('agent').length, 0, '都没开工');
  g.setParent({ state: 'MERGED' });
  g.run('execute', { DEPENDS_ON: PARENT.replace('example/fixture', 'Example/Fixture') });
  assert.deepEqual(g.calls('agent')[0].args.slice(0, 2), ['--commit', g.remote('lane/req-1')], '前置已合进泳道，照常从泳道开工');
  assert.equal(g.state().stack, undefined);
});

test('叠放与免审的流程定义：分流升级直接交主 Agent；通过后先看前置，等一分钟再看；重接回到推送；免审只在开了开关、填了评审者时判定', async () => {
  const { nodes, route, next, params, values } = await definition();
  for (const [value, target] of [['wait', 'stack-wait'], ['restack', 'restack'], ['review', 'rounds'], ['ready', 'minor-choice']]) assert.equal(route('stack-route', { 'stack-status': { route: value } }), target, value);
  assert.equal(nodes['stack-wait'].$type, 'bpmn:IntermediateCatchEvent');
  assert.equal(nodes['stack-wait'].eventDefinitions[0].timeDuration.body, 'PT1M');
  assert.equal(next('stack-wait'), 'stack-status');
  assert.equal(nodes['stack-status'].checkout, 'false', '只用 gh，不检出');
  for (const [value, target] of [['gate', 'gate'], ['revise', 'restack-revise'], ['review', 'rounds']]) assert.equal(route('restack-route', { restack: { route: value } }), target, value);
  assert.equal(next('restack-revise'), 'restack');
  const reviewer = { agent: 'a1' };
  for (const [inputs, target] of [[{ autoLandMinor: true, sync: false, reviewer }, 'minor'], [{ autoLandMinor: false, sync: false, reviewer }, 'rounds'],
    [{ autoLandMinor: true, sync: true, reviewer }, 'rounds'], [{ autoLandMinor: true, sync: false }, 'rounds']]) {
    assert.equal(route('minor-choice', { inputs: { reviewer: null, reviewer2: null, ...inputs } }), target, JSON.stringify(inputs));
  }
  assert.deepEqual(params('minor'), { REVIEWS: '=reviews', AUTO: '=inputs.autoLandMinor', route: undefined });
  for (const [value, target] of [['land', 'land'], ['review', 'rounds']]) assert.equal(route('minor-route', { minor: { route: value } }), target);
  assert.deepEqual(values(nodes.land).map(v => v.name), ['route', 'pr', 'commit', 'auto', 'summary']);
  // 审查卡的叠放提示按「整理审查材料」的 stack：没叠放、已重接（空）和旧版脚本没有这个输出（null）都不提示。
  assert.deepEqual(values(nodes.report).filter(v => v.$type === 'coda:Output').map(v => v.name).at(-1), 'stack');
  const card = nodes.review.documentation[0].text, expression = [...card.matchAll(/{{(.*?)}}/g)].find(m => m[1].includes('report.stack'))[1];
  assert.ok(!card.includes('inputs.dependsOn'), '不按开工输入判断');
  for (const report of [{}, { stack: '' }]) assert.equal(evaluate(expression, { report }).value, '', JSON.stringify(report));
  assert.match(evaluate(expression, { report: { stack: PARENT } }).value, /叠在前置泳道 PR .*pull\/6.*不会合并/);
});

// 免审：交付 files 后走到判定；reviews 缺省是一位评审者 APPROVE、没有发现。
function minorAfter(t, files, { seed, reviews, auto = 'true' } = {}) {
  const f = fixture(t);
  if (seed) for (const [file, text] of Object.entries(seed)) f.advanceLane(file, text);
  writeFileSync(join(f.root, 'agent-task'), JSON.stringify({ files, answer: 'minor change' }));
  f.run('execute'); f.delivered(); f.run('review-round');
  const head = f.state().executor.head, given = JSON.stringify(reviews?.(head) ?? [approved(head), { state: 'skipped' }]);
  f.run('triage', { REVIEWS: given });
  assert.equal(f.run('stack-status').outputs.route, 'ready');
  return { f, route: f.run('minor', { REVIEWS: given, AUTO: auto }).outputs.route };
}

test('小改动免主控审查：只加带断言的测试、评审全 APPROVE 时直接合进泳道，步骤摘要与结束输出带完整审计', t => {
  const { f, route } = minorAfter(t, { 'test/plugins/x/new.test.mjs': "test('x', () => { assert.equal(1, 1); });\n" });
  assert.equal(route, 'land');
  const landed = f.run('land').outputs;
  assert.deepEqual({ ...landed, summary: undefined }, { route: 'landed', pr: PR, commit: 'f'.repeat(40), auto: 'true', summary: undefined });
  for (const text of ['小改动免主控审查，已自动合进泳道', 'autoLandMinor', `PR：${PR}`, `合入提交：${'f'.repeat(40)}`, '- A test/plugins/x/new.test.mjs',
    '项目检查：\n此提交未声明项目检查流程。', '- 评审者（reviewer）：APPROVE 可以合']) assert.ok(landed.summary.includes(text), text);
  assert.ok(readFileSync(f.env.GITHUB_STEP_SUMMARY, 'utf8').includes(landed.summary));
  // 出过审查卡（rounds）之后再合进泳道就不是免审。
  f.run('rounds');
  assert.equal(f.run('land', { PR_STATE: 'MERGED' }).outputs.auto, undefined);
});

test('小改动免主控审查：只改插件 README 也免审', t => {
  assert.equal(minorAfter(t, { 'plugins/composer/README.md': '说明\n' }).route, 'land');
});

test('小改动免主控审查：删测试文件、新增 skip、只删断言、改了源码都回到审查卡，并在步骤摘要写明原因', t => {
  const seed = { 'test/a.test.mjs': "test('a', () => {\n  assert.equal(1, 1);\n});\n" };
  for (const [files, text] of [[{ 'test/a.test.mjs': null }, /删了测试文件 test\/a\.test\.mjs/],
    [{ 'test/b.test.mjs': "test.skip('b', () => { assert.ok(1); });\n" }, /test\/b\.test\.mjs 新增了 skip、todo 或 only/],
    [{ 'test/a.test.mjs': "test('a', () => {\n  console.log(1);\n});\n" }, /test\/a\.test\.mjs 删了断言、没有新增断言/],
    [{ 'test/c.test.mjs': "assert.ok(1);\n", 'plugins/composer/scripts/x.mjs': 'x\n' }, /改了测试与说明文档以外的文件：plugins\/composer\/scripts\/x\.mjs/]]) {
    const { f, route } = minorAfter(t, files, { seed });
    assert.equal(route, 'review', String(text));
    assert.match(readFileSync(f.env.GITHUB_STEP_SUMMARY, 'utf8'), text);
    assert.equal(f.state().auto, undefined);
  }
});

test('小改动免主控审查：重命名测试文件并删掉唯一的断言，按重命名比对、不免审', t => {
  const { f, route } = minorAfter(t, { 'test/a.test.mjs': null, 'test/b.test.mjs': "test('a', () => {\n  console.log(1);\n  const x = 1;\n  const y = 2;\n});\n" },
    { seed: { 'test/a.test.mjs': "test('a', () => {\n  assert.equal(1, 1);\n  const x = 1;\n  const y = 2;\n});\n" } });
  assert.match(f.git('diff', '--name-status', '-M', `${f.state().base}...${f.state().executor.head}`), /^R\d+\ttest\/a\.test\.mjs\ttest\/b\.test\.mjs$/, '确实是重命名');
  assert.equal(route, 'review');
  assert.match(readFileSync(f.env.GITHUB_STEP_SUMMARY, 'utf8'), /test\/b\.test\.mjs 删了断言、没有新增断言/);
});

test('小改动免主控审查：评审没评成或有发现、没有评审者、没开开关都回到审查卡', t => {
  for (const [reviews, auto, text] of [
    [head => [reviewed('reviewer', head, [], { decision: 'INCOMPLETE', line: '超时' })], 'true', /评审者的结论是 INCOMPLETE/],
    [head => [approved(head), reviewed('reviewer2', head, [{ ...BUG, severity: 'P3', kind: 'style' }], { decision: 'COMMENT' })], 'true', /第二评审者的结论是 COMMENT/],
    [() => [{ state: 'skipped' }, { state: 'skipped' }], 'true', /没有评审者/],
    [undefined, 'false', /没开小改动免主控审查/]]) {
    const { f, route } = minorAfter(t, { 'test/a.test.mjs': 'assert.ok(1);\n' }, { reviews, auto });
    assert.equal(route, 'review', String(text));
    assert.match(readFileSync(f.env.GITHUB_STEP_SUMMARY, 'utf8'), text);
  }
});
