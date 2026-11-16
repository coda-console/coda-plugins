// 需求运行（plugins/composer/.coda/workflows/develop.bpmn、scripts/develop.mjs）：临时 Git 仓库、假的 gh，
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

const script = fileURLToPath(new URL('../../../plugins/composer/scripts/develop.mjs', import.meta.url));
const workflow = readFileSync(new URL('../../../plugins/composer/.coda/workflows/develop.bpmn', import.meta.url), 'utf8');
// 已发布的定义（10.0.0、10.1.4）：正在跑的需求运行按它的快照走，脚本取当前装着的版本。
const olds = ['10.0.0', '10.1.4'].map(version => ({ version, source: readFileSync(new URL(`./fixtures/develop-${version}.bpmn`, import.meta.url), 'utf8') }));
const old = olds[0].source;
const manifest = JSON.parse(readFileSync(new URL('../../../plugins/composer/package.json', import.meta.url), 'utf8'));
const PR = 'https://github.com/example/fixture/pull/1';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'composer-develop-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const work = join(root, 'work'), origin = join(root, 'origin.git'), bin = join(root, 'bin'), artifacts = join(root, 'artifacts');
  for (const path of [work, bin, artifacts]) mkdirSync(path);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CODA_ARTIFACTS: artifacts, RUNNER_TEMP: root,
    GITHUB_RUN_ID: 'run-1', GITHUB_OUTPUT: join(root, 'outputs'), CODA_THREAD_ID: 'thread-1', TITLE: '输入框', GOAL: '输入框可以输入', BASE: '',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'false', GIT_CONFIG_KEY_1: 'core.hooksPath', GIT_CONFIG_VALUE_1: '/dev/null',
    FIXTURE: root };
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: work, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  writeFileSync(join(work, 'base'), 'base');
  git('add', 'base'); git('commit', '-qm', 'base');
  git('init', '--bare', '-q', origin); git('remote', 'add', 'origin', origin); git('push', '-q', 'origin', 'main');
  const gh = join(bin, 'gh');
  writeFileSync(gh, `#!${process.execPath}\n` + String.raw`
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2), root = process.env.FIXTURE;
const calls = JSON.parse(readFileSync(join(root, 'gh-calls'), 'utf8'));
const body = args.includes('--body-file') ? readFileSync(args[args.indexOf('--body-file') + 1], 'utf8') : null;
calls.push({ args, body, thread: process.env.CODA_THREAD_ID ?? null }); writeFileSync(join(root, 'gh-calls'), JSON.stringify(calls));
const state = () => JSON.parse(readFileSync(join(process.env.CODA_ARTIFACTS, 'develop.json'), 'utf8'));
if (args[0] === 'repo') console.log('main');
else if (args[1] === 'list' && args.includes('merged')) console.log(process.env.LANE_PRS || '[]');
else if (args[1] === 'list') { if (process.env.OPEN_PR) console.log(process.env.OPEN_PR); }
else if (args[1] === 'create') console.log('${PR}');
else if (args[1] === 'merge') { if (process.env.MERGE_EXIT) { process.stderr.write(process.env.MERGE_STDERR || ''); process.exit(Number(process.env.MERGE_EXIT)); } }
else if (args[1] === 'view' && args.includes('headRefOid,statusCheckRollup')) {
  console.log(JSON.stringify({ headRefOid: process.env.PR_HEAD || state().head, statusCheckRollup: [{}] }));
  process.exit(Number(process.env.CHECKS_QUERY_EXIT || 0));
}
else if (args[1] === 'view' && (args.includes('state,headRefOid,mergeCommit') || args.includes('state,mergeable')))
  console.log(JSON.stringify({ state: process.env.PR_STATE || 'OPEN', mergeable: process.env.PR_MERGEABLE || 'MERGEABLE', headRefOid: process.env.PR_HEAD || state().head, mergeCommit: { oid: 'f'.repeat(40) } }));
else if (args[1] === 'view') console.log('f'.repeat(40));
else if (args[1] === 'checks') {
  process.stdout.write(process.env.CHECKS_STDOUT || 'checks passed\n');
  process.stderr.write(process.env.CHECKS_STDERR || '');
  process.exit(Number(process.env.CHECKS_EXIT || 0));
}
`);
  chmodSync(gh, 0o755);
  writeFileSync(join(root, 'gh-calls'), '[]');
  // 执行者：开新会话时从 --commit 建工作树；advance 是别人先推进需求分支的提交，merge 是要合并进来的远端分支（留着冲突，由 file 写好解决），
  // noCommit 时不提交。回答就是 answer。
  const agent = join(bin, 'coda-agent');
  writeFileSync(agent, `#!${process.execPath}\n` + String.raw`
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const args = process.argv.slice(2), root = process.env.FIXTURE;
const value = key => args[args.indexOf(key) + 1];
const task = JSON.parse(readFileSync(join(root, 'agent-task'), 'utf8'));
const calls = JSON.parse(readFileSync(join(root, 'agent-calls'), 'utf8'));
calls.push({ args, prompt: readFileSync(value('--prompt-file'), 'utf8') }); writeFileSync(join(root, 'agent-calls'), JSON.stringify(calls));
const continued = args.includes('--continue');
const session = continued ? value('--continue') : 'worker-' + calls.length, cwd = join(root, session);
const git = (...params) => execFileSync('git', params, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
if (!continued) execFileSync('git', ['worktree', 'add', '-q', '--detach', cwd, value('--commit')], { stdio: 'pipe' });
if (task.advance) git('push', '-q', 'origin', task.advance + ':refs/heads/lane/run-1');
if (task.merge) { git('fetch', '-q', 'origin', task.merge); spawnSync('git', ['merge', '--no-commit', 'FETCH_HEAD'], { cwd }); }
if (!task.noCommit) { writeFileSync(join(cwd, task.file), task.text ?? task.answer); git('add', '-A'); git('commit', '-qm', task.subject ?? 'fix'); }
console.log(JSON.stringify({ session, branch: null, head: git('rev-parse', 'HEAD'), answer: task.answer }));
`);
  chmodSync(agent, 0o755);
  writeFileSync(join(root, 'agent-calls'), '[]');
  const state = () => JSON.parse(readFileSync(join(artifacts, 'develop.json'), 'utf8'));
  const calls = () => JSON.parse(readFileSync(join(root, 'gh-calls'), 'utf8'));
  const run = (action, extra = {}, expected = 0) => {
    writeFileSync(env.GITHUB_OUTPUT, '');
    const result = spawnSync(process.execPath, [script, action], { cwd: work, env: { ...env, ...extra }, encoding: 'utf8' });
    assert.equal(result.status, expected, result.stderr);
    const outputs = Object.fromEntries([...readFileSync(env.GITHUB_OUTPUT, 'utf8').matchAll(/(\w+)<<([^\n]+)\n([\s\S]*?)\n\2\n/g)].map(([, key, , value]) => [key, value]));
    return { ...result, outputs };
  };
  const remote = ref => git('ls-remote', 'origin', ref).split('\t')[0];
  // 一个块合进了需求分支：在需求分支上另提交一个。
  const land = (file, text) => {
    git('fetch', '-q', 'origin', state().lane); git('switch', '-q', '--detach', 'FETCH_HEAD');
    writeFileSync(join(work, file), text); git('add', file); git('commit', '-qm', `lane ${file}`); git('push', '-q', 'origin', `HEAD:refs/heads/${state().lane}`);
    return git('rev-parse', 'HEAD');
  };
  const answer = (action, name, choice, note, extra = {}) => run(action, { [name]: JSON.stringify({ choice, note }), ...extra }).outputs;
  const progress = (choice, note) => answer('progress', 'PROGRESS', choice, note);
  const reason = () => run('resume').outputs.reason;
  // 目标分支前进：在 main 上另提交一个。
  const advanceMain = (file, text) => {
    git('fetch', '-q', 'origin', 'main'); git('switch', '-q', '--detach', 'FETCH_HEAD');
    writeFileSync(join(work, file), text); git('add', file); git('commit', '-qm', `main ${file}`); git('push', '-q', 'origin', 'HEAD:refs/heads/main');
    return git('rev-parse', 'HEAD');
  };
  const task = value => writeFileSync(join(root, 'agent-task'), JSON.stringify(value));
  const agentCalls = () => JSON.parse(readFileSync(join(root, 'agent-calls'), 'utf8'));
  return { root, work, origin, env, git, run, state, calls, remote, land, answer, progress, reason, advanceMain, task, agentCalls };
}

async function definition(source = workflow) {
  const { root, problem } = await readWorkflow(source, 'develop'); assert.ok(!problem, problem);
  const process = root.rootElements.find(e => e.$type === 'bpmn:Process');
  const subs = process.flowElements.filter(e => e.$type === 'bpmn:SubProcess');
  const elements = [...process.flowElements, ...subs.flatMap(s => s.flowElements)];
  const nodes = Object.fromEntries(elements.map(e => [e.id, e]));
  const values = node => node.extensionElements?.values ?? [];
  const params = id => Object.fromEntries(values(nodes[id]).map(v => [v.name, v.value]));
  const route = (id, context) => {
    const node = nodes[id], flows = elements.filter(e => e.sourceRef === node);
    const typed = Object.fromEntries(Object.entries(context).map(([key, value]) => [key, typeof value === 'object' && value
      ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, v === 'true' ? true : v === 'false' ? false : v])) : value]));
    return (flows.find(e => e.conditionExpression && evaluate(e.conditionExpression.body.trim().slice(1), typed).value) ?? node.default).targetRef.id;
  };
  const next = id => elements.find(e => e.$type === 'bpmn:SequenceFlow' && e.sourceRef === nodes[id]).targetRef.id;
  return { process, elements, nodes, values, params, route, next };
}

test('建需求分支：从目标分支最新提交建 lane/<运行 ID> 并推送；远端已有同名需求分支时沿用，从头重跑不失败', t => {
  const f = fixture(t);
  const lane = f.run('lane').outputs;
  assert.deepEqual(lane, { title: '输入框', goal: '输入框可以输入', base: 'main', lane: 'lane/run-1' });
  assert.equal(f.remote('lane/run-1'), f.remote('main'));
  const landed = f.land('one', 'first lane PR');
  f.git('switch', '-q', 'main');
  writeFileSync(join(f.work, 'later'), 'later'); f.git('add', 'later'); f.git('commit', '-qm', 'main moved'); f.git('push', '-q', 'origin', 'main');
  assert.equal(f.run('lane').outputs.lane, 'lane/run-1');
  assert.equal(f.remote('lane/run-1'), landed, '沿用已有需求分支，不重建、不丢已合进去的块');
  f.run('lane', { BASE: 'main', GITHUB_RUN_ID: 'run-2' });
  assert.equal(f.remote('lane/run-2'), f.remote('main'));
  assert.equal(f.calls().filter(c => c.args[0] === 'repo').length, 2, '有 base 不查默认分支');
});

test('用户开启时主 Agent 写的需求：第一行需求名，其后是目标与完成标准，缺一样回到同一张卡', t => {
  const f = fixture(t);
  const brief = note => f.run('brief', { BRIEF: JSON.stringify({ choice: 'start', note }) }).outputs;
  assert.deepEqual(brief('输入框\n\n## 目标\n能输入\n\n## 完成标准\n- 能输入'), { feedback: '', route: 'lane', title: '输入框', goal: '## 目标\n能输入\n\n## 完成标准\n- 能输入' });
  for (const note of ['只有需求名', '', '  \n  ']) {
    const written = brief(note);
    assert.equal(written.route, 'brief');
    assert.match(written.feedback, /第一行写需求名，空一行后写目标与完成标准/);
  }
});

test('需求进行中：提交验收与暂停必须写备注，缺了回到同一张卡且保留回来的原因；放弃直接结束', t => {
  const f = fixture(t); f.run('lane');
  assert.equal(f.reason(), '', '第一次进来没有原因');
  f.run('check-failed', { STEP: '合并前检查' });
  for (const [choice, text] of [['submit', '提交验收必须在备注中写给用户的改动汇报。'], ['pause', '暂停必须在备注中写为什么暂停、等什么。']]) {
    for (const note of [undefined, '', '  ']) assert.deepEqual(f.progress(choice, note), { feedback: text, route: 'progress' });
  }
  assert.match(f.reason(), /合并前检查未通过/, '没写全备注不清掉回来的原因');
  assert.deepEqual(f.progress('submit', '做了什么\n- 能输入\n需要你知道：无'), { feedback: '', route: 'submit' });
  assert.equal(f.state().report, '做了什么\n- 能输入\n需要你知道：无');
  assert.equal(f.reason(), '');
  assert.deepEqual(f.progress('pause', '等后端先上线'), { feedback: '', route: 'pause' });
  assert.deepEqual(f.progress('abandon'), { feedback: '', route: 'abandon' });
  assert.equal(f.state().report, '做了什么\n- 能输入\n需要你知道：无', '暂停、放弃不动汇报');
});

test('需求已暂停：用户选继续带着原因回到进行中，选放弃结束', t => {
  const f = fixture(t); f.run('lane');
  assert.deepEqual(f.answer('paused', 'PAUSED', 'continue'), { route: 'continue' });
  assert.equal(f.reason(), '用户在「需求已暂停」选了继续。');
  assert.deepEqual(f.answer('paused', 'PAUSED', 'continue', '后端已经上线了'), { route: 'continue' });
  assert.equal(f.reason(), '用户在「需求已暂停」选了继续。\n用户的话：\n后端已经上线了');
  assert.deepEqual(f.answer('paused', 'PAUSED', 'abandon'), { route: 'abandon' });
});

test('提交验收开需求分支进目标分支的 PR：不带会话开，正文是汇报、从 GitHub 读的已合并块与改动区域；再提交更新同一个 PR', t => {
  const f = fixture(t); f.run('lane');
  const head = f.land('one', 'first');
  f.progress('submit', '汇报');
  const prs = [{ number: 12, title: '补齐状态', url: 'https://github.com/example/fixture/pull/12' }, { number: 9, title: '输入框可以输入', url: 'https://github.com/example/fixture/pull/9' }];
  const opened = f.run('pr', { LANE_PRS: JSON.stringify(prs) }).outputs;
  const summary = '汇报\n\n块：\n- 输入框可以输入（https://github.com/example/fixture/pull/9）\n- 补齐状态（https://github.com/example/fixture/pull/12）\n\n改动：1 个文件 +1 -0\n- 根目录：1 个文件 +1 -0';
  assert.deepEqual(opened, { checked: 'false', url: PR, head, base: f.remote('main'), lane: 'lane/run-1', summary,
    task: '需求：输入框\n\n目标与完成标准：\n输入框可以输入\n\n主 Agent 的汇报：\n汇报' });
  assert.deepEqual(f.calls().find(c => c.args[1] === 'list' && c.args.includes('merged')).args,
    ['pr', 'list', '--base', 'lane/run-1', '--state', 'merged', '--limit', '200', '--json', 'number,title,url']);
  const created = f.calls().filter(c => c.args[1] === 'create');
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].args.slice(0, 8), ['pr', 'create', '--base', 'main', '--head', 'lane/run-1', '--title', '输入框']);
  assert.equal(created[0].thread, null, '不带会话开 PR，PR 观察不会因此启动 PR 生命流程');
  assert.equal(created[0].body, summary);
  // 从头重跑后运行暂存没了 PR：从 GitHub 找到开着的那个，只更新。
  f.land('two', 'second');
  f.progress('submit', '新汇报');
  const updated = f.run('pr', { OPEN_PR: PR }).outputs;
  assert.equal(updated.url, PR);
  assert.equal(f.calls().filter(c => c.args[1] === 'create').length, 1);
  const edit = f.calls().find(c => c.args[1] === 'edit');
  assert.deepEqual(edit.args.slice(0, 3), ['pr', 'edit', PR]);
  assert.match(edit.body, /^新汇报\n\n块：\n（还没有合进需求分支的块）\n\n改动：2 个文件 \+2 -0/);
  assert.deepEqual(f.calls().find(c => c.args[1] === 'list' && c.args.includes('open')).args,
    ['pr', 'list', '--head', 'lane/run-1', '--base', 'main', '--state', 'open', '--limit', '1', '--json', 'url', '--jq', '.[].url']);
});

test('项目检查按需求分支 head 复用：同一 head 通过过就不再跑，需求分支动了就再跑', async t => {
  const { route } = await definition();
  const f = fixture(t); f.run('lane'); f.land('one', 'first'); f.progress('submit', '汇报');
  assert.equal(route('reuse-checks', { pr: f.run('pr').outputs }), 'checks');
  f.run('checks-passed', { RUNS: JSON.stringify([{ workflow: 'test', state: 'succeeded', runId: 'c1' }]) });
  assert.equal(route('reuse-checks', { pr: f.run('pr').outputs }), 'premerge');
  assert.match(f.run('github-checks').outputs.evidence, /^项目检查：\ntest: succeeded coda:\/\/workflow-runs\/c1\n合并前检查与 GitHub 检查已通过。$/);
  f.land('two', 'second');
  assert.equal(route('reuse-checks', { pr: f.run('pr').outputs }), 'checks');
});

test('收尾的失败与「暂不合并」都带着原因回到需求进行中', t => {
  const f = fixture(t); f.run('lane'); f.land('one', 'first'); f.progress('submit', '汇报'); f.run('pr');
  const head = f.state().head;
  for (const step of ['项目检查', '合并前检查', 'GitHub 检查']) {
    f.run('check-failed', { STEP: step });
    const text = f.reason();
    for (const part of [`${step}未通过`, head, 'coda://workflow-runs/run-1', 'workflow_status', '派一块修好后再提交验收']) assert.ok(text.includes(part), part);
  }
  for (const [action, name, choice, note, route, expected] of [
    ['preview', 'PREVIEW', 'progress', '先合入最新 main', 'progress', '安装预览版需处理：\n先合入最新 main'],
    ['device', 'DEVICE', 'no', '按钮没有响应', 'progress', '设备验收不通过：\n按钮没有响应'],
    ['delivery', 'DELIVERY_RESULT', 'revise', '需求验收：按钮没有响应', 'progress', '所属需求退回修改：\n需求验收：按钮没有响应'],
    ['approval', 'APPROVAL', 'stop', '这周先不上', 'stop', '用户选了暂不合并：\n这周先不上'],
  ]) {
    f.progress('submit', '汇报');
    assert.equal(f.answer(action, name, choice, note).route, route, action);
    assert.equal(f.reason(), expected, action);
  }
  f.progress('submit', '汇报');
  assert.equal(f.run('device', { DEVICE: JSON.stringify({ choice: 'no', note: '', attachments: ['/uploads/a/shot.png'] }) }).outputs.route, 'progress', '只附截图也算附言');
  assert.equal(f.reason(), '设备验收不通过：\n附件：\n- /uploads/a/shot.png');
  f.progress('submit', '汇报');
  assert.deepEqual(f.answer('review', 'REVIEW', 'progress', '先修 P1'), { route: 'progress' });
  assert.match(f.reason(), /^整体评审后主 Agent 选了回到进行中。\n先修 P1\n评审的发现与原文：.*reviews\.md$/);
  f.progress('submit', '汇报');
  assert.deepEqual(f.answer('review', 'REVIEW', 'continue'), { route: 'continue' });
  assert.equal(f.reason(), '', '继续验收不回去');
  // 缺必填意见时留在原卡，不回到进行中。
  for (const [action, name, choice, route, text] of [['preview', 'PREVIEW', 'progress', 'preview', /回到进行中必须/], ['device', 'DEVICE', 'no', 'device', /必须写验收意见或附上截图/], ['delivery', 'DELIVERY_RESULT', 'revise', 'delivery', /退回修改必须/]]) {
    const result = f.answer(action, name, choice, '  ');
    assert.equal(result.route, route); assert.match(result.feedback, text);
    assert.equal(f.reason(), '');
  }
  for (const [action, name, choice, route] of [['preview', 'PREVIEW', 'installed', 'device'], ['device', 'DEVICE', 'yes', 'passed'], ['delivery', 'DELIVERY_RESULT', 'merge', 'merge']]) {
    assert.deepEqual(f.answer(action, name, choice), { feedback: '', route }, action);
  }
});

test('合并：用合并提交进目标分支（--merge），冲突带着原因回到进行中，重跑不再合并', t => {
  const f = fixture(t); f.run('lane'); f.land('one', 'first'); f.progress('submit', '汇报'); f.run('pr');
  f.git('switch', '--detach');
  assert.deepEqual(f.run('merge').outputs, { route: 'merged', commit: 'f'.repeat(40) });
  assert.deepEqual(f.calls().find(c => c.args[1] === 'merge').args,
    ['pr', 'merge', PR, '--repo', 'github.com/example/fixture', '--merge', '--match-head-commit', f.state().head, '--delete-branch']);
  assert.deepEqual(f.run('merge', { PR_STATE: 'MERGED' }).outputs, { route: 'merged', commit: 'f'.repeat(40) });
  assert.equal(f.calls().filter(c => c.args[1] === 'merge').length, 1, '重跑不再合并');
  assert.match(f.run('merge', { PR_STATE: 'MERGED', PR_HEAD: 'a'.repeat(40) }, 1).stderr, /已合并，但 head 不一致/);
  assert.match(f.run('merge', { PR_STATE: 'CLOSED' }, 1).stderr, /已关闭但未合并/);

  assert.deepEqual(f.run('merge', { MERGE_EXIT: '1', PR_MERGEABLE: 'CONFLICTING' }).outputs, { route: 'conflict' });
  const text = f.reason();
  for (const part of ['合并冲突', '目标分支 main', 'sync=true 的块', '再提交验收', '重新跑检查、批准合并及合并后的流程']) assert.ok(text.includes(part), part);
  for (const [mergeable, stderr] of [['UNKNOWN', 'network unavailable'], ['MERGEABLE', 'HTTP 403: Forbidden']]) {
    const result = f.run('merge', { MERGE_EXIT: '7', MERGE_STDERR: stderr, PR_MERGEABLE: mergeable }, 7);
    assert.equal(result.stderr, stderr);
    assert.deepEqual(result.outputs, {});
  }
});

test('整体评审的材料：只取评需求分支这个 head 的，没评成的指向本运行「评审整条需求分支」', t => {
  const f = fixture(t); f.run('lane'); f.land('one', 'first'); f.progress('submit', '汇报'); f.run('pr');
  const head = f.state().head, path = join(f.env.CODA_ARTIFACTS, 'reviews.md');
  const reviews = [
    { state: 'done', slot: 'reviewer', who: JSON.stringify({ agent: 'a1', effort: 'high' }), head, decision: 'APPROVE', line: '可以', findings: '[]', report: '原文' },
    { state: 'lost', slot: 'reviewer2', who: JSON.stringify({ agent: 'a2' }), head },
  ];
  assert.equal(f.run('reviewed', { REVIEWS: JSON.stringify(reviews) }).outputs.reviews, [
    '评审者（a1 · high）：可以',
    '第二评审者（a2）：没评成。调用 review-commit 没有成功，原因见本运行 coda://workflow-runs/run-1 的「评审整条需求分支」（workflow_status）。',
  ].join('\n\n') + `\n评审原文：${path}`);
  assert.ok(readFileSync(path, 'utf8').includes('原文'));
  f.land('two', 'second'); f.run('pr');
  assert.equal(f.run('reviewed', { REVIEWS: JSON.stringify(reviews) }).outputs.reviews, '', '需求分支动了，旧的评审不带');
});

test('PR 汇总按 .coda/areas.json 最长前缀归区域，未声明走顶层目录，改名按新路径，二进制只计文件', t => {
  const f = fixture(t);
  const write = (path, text) => { mkdirSync(join(f.work, path, '..'), { recursive: true }); writeFileSync(join(f.work, path), text); };
  const lines = n => 'line\n'.repeat(n);
  write('old/Big.swift', 'big\nbody\n'); f.git('add', '-A'); f.git('commit', '-qm', 'big'); f.git('push', '-q', 'origin', 'main');
  f.run('lane'); f.progress('submit', '汇报');
  f.git('fetch', '-q', 'origin', 'lane/run-1'); f.git('switch', '-q', '--detach', 'FETCH_HEAD');
  write('.coda/areas.json', '{ "iPhone 客户端": ["iOS/"], "共享": ["iOS/Shared/", "AGENTS.md"] }\n');
  write('iOS/App.swift', lines(5)); write('iOS/Shared/Model.swift', lines(6)); write('AGENTS.md', lines(1));
  write('Sources/Core.swift', lines(8)); write('notes.txt', lines(2)); write('img.png', Buffer.from([0, 1, 2, 0]));
  f.git('mv', 'old/Big.swift', 'iOS/Big.swift'); f.git('rm', '-q', 'base');
  const changes = () => {
    f.git('add', '-A'); f.git('commit', '-qm', 'change'); f.git('push', '-q', 'origin', 'HEAD:refs/heads/lane/run-1');
    return f.run('pr').outputs.summary.split('\n\n').at(-1);
  };
  assert.equal(changes(), ['改动：9 个文件 +23 -1',
    '- Sources：1 个文件 +8 -0', '- 共享：2 个文件 +7 -0', '- iPhone 客户端：2 个文件 +5 -0', '- 根目录：3 个文件 +2 -1', '- .coda：1 个文件 +1 -0'].join('\n'));
  f.git('rm', '-q', '.coda/areas.json');
  assert.equal(changes(), ['改动：8 个文件 +22 -1', '- iOS：3 个文件 +11 -0', '- Sources：1 个文件 +8 -0', '- 根目录：4 个文件 +3 -1'].join('\n'));
  write('.coda/areas.json', '{ "iOS": ');
  f.git('add', '-A'); f.git('commit', '-qm', 'broken'); f.git('push', '-q', 'origin', 'HEAD:refs/heads/lane/run-1');
  assert.match(f.run('pr', {}, 1).stderr, /JSON/);
});

test('GitHub 检查等待全部完成，检查失败和查询错误保持失败并留下日志', t => {
  const f = fixture(t); f.run('lane'); f.land('one', 'first'); f.progress('submit', '汇报'); f.run('pr');
  assert.match(f.run('github-checks').stdout, /checks passed/);
  const query = ['pr', 'view', PR, '--json', 'headRefOid,statusCheckRollup'];
  assert.deepEqual(f.calls().at(-2).args, ['pr', 'checks', PR, '--watch']);
  assert.deepEqual(f.calls().at(-1).args, query);
  f.run('github-checks', { CHECKS_QUERY_EXIT: '1' }, 1);
  assert.match(f.run('github-checks', { PR_HEAD: 'stale' }, 1).stderr, /PR head 不一致/);
  const failed = f.run('github-checks', { CHECKS_EXIT: '1', CHECKS_STDOUT: 'build\tfail\n' }, 1);
  assert.ok(failed.stdout.includes('build\tfail'));
  assert.deepEqual(failed.outputs, {});
});

// hook-joiners 给批准卡的列表：发布预览版、发布正式版都要发布说明（notes）。
const JOINERS = JSON.stringify([
  { id: 'deploy', name: '部署', detail: '预览空间', default: false },
  { id: 'publish-preview', name: '发布预览版', default: false, inputs: [{ id: 'notes', label: '发布说明' }] },
  { id: 'publish-release', name: '发布正式版', default: false, inputs: [{ id: 'notes', label: '发布说明' }] },
]);

test('合并后的流程：从批准卡读出勾了哪些加入者、卡上写了的文字与没写的输入；主 Agent 补写的并进 inputs，没写字的失败', t => {
  const f = fixture(t); f.run('lane');
  const approve = (options, inputs = {}) => f.run('approval', { APPROVAL: JSON.stringify({ choice: 'merge', options, inputs, note: '' }), JOINERS }).outputs;
  const none = { deploy: false, 'publish-preview': false, 'publish-release': false, notify: true };
  assert.deepEqual(approve(none, { notes: '' }), { route: 'merge', only: '[]', picked: '', inputs: '{}', missing: '', asks: '', needs: '{}' });
  assert.deepEqual(approve({ ...none, deploy: true }), { route: 'merge', only: '["deploy"]', picked: '部署', inputs: '{}', missing: '', asks: '', needs: '{}' });
  assert.deepEqual(approve({ ...none, deploy: true, 'publish-preview': true, 'publish-release': true }, { notes: '  ' }),
    { route: 'merge', only: '["deploy","publish-preview","publish-release"]', picked: '部署、发布预览版、发布正式版', inputs: '{}', missing: 'notes', asks: '「发布说明」：发布预览版、发布正式版要', needs: '{"notes":["publish-preview","publish-release"]}' });
  assert.deepEqual(approve({ ...none, 'publish-preview': true }, { notes: ' 修复输入问题 ' }),
    { route: 'merge', only: '["publish-preview"]', picked: '发布预览版', inputs: '{"notes":"修复输入问题"}', missing: '', asks: '', needs: '{}' });
  assert.equal(f.reason(), '', '合并不回到进行中');

  const fill = (extra, code = 0) => f.run('inputs', extra, code);
  assert.deepEqual(fill({ INPUTS: '{"notes":"卡上写的"}', MISSING: '', ASKS: '', FILLS: '', ONLY: '["deploy"]' }).outputs, { inputs: '{"notes":"卡上写的"}', only: '["deploy"]' });
  const fills = JSON.stringify([{ result: 'completed', choice: 'done', note: ' 主 Agent 写的 ' }, { result: 'completed', choice: 'done', note: '另一段' }]);
  assert.deepEqual(fill({ INPUTS: '{"keep":"卡上的"}', MISSING: 'notes,extra', ASKS: '「发布说明」：发布预览版要\n「别的」：部署要', FILLS: fills,
    NEEDS: '{"notes":["publish-preview"],"extra":["deploy"]}', ONLY: '["deploy","publish-preview"]' }).outputs,
    { inputs: '{"keep":"卡上的","notes":"主 Agent 写的","extra":"另一段"}', only: '["deploy","publish-preview"]' });
  const empty = fill({ INPUTS: '{}', MISSING: 'notes', ASKS: '「发布说明」：发布预览版要', FILLS: JSON.stringify([{ result: 'completed', note: '', attachments: ['/a.png'] }]) }, 1);
  assert.match(empty.stderr, /「发布说明」：发布预览版要：没有填写，不运行合并后的流程/);
  assert.deepEqual(empty.outputs, {});
});

// 主 Agent 选「这一项这次不跑」：要这段文字的加入者全部从 only 里去掉，其余照跑；一个不剩就不进 run-merged、照常结束。
async function afterSkip(t, ticked, fills) {
  const f = fixture(t); f.run('lane');
  const { nodes, route, next } = await definition();
  const options = Object.fromEntries(ticked.map(id => [id, true]));
  const approval = f.run('approval', { APPROVAL: JSON.stringify({ choice: 'merge', options, inputs: {}, note: '' }), JOINERS }).outputs;
  const merged = f.run('inputs', { INPUTS: approval.inputs, MISSING: approval.missing, ASKS: approval.asks, NEEDS: approval.needs, ONLY: approval.only, FILLS: JSON.stringify(fills) }).outputs;
  const context = { inputs: { delivery: '' }, 'approval-result': approval, 'merged-inputs': merged }, visited = [];
  let step = 'merged-choice';
  while (nodes[step].$type !== 'bpmn:EndEvent') {
    if (!nodes[step].$type.endsWith('Gateway')) visited.push(step);
    step = nodes[step].$type === 'bpmn:ExclusiveGateway' ? route(step, context) : next(step);
  }
  return { visited, end: nodes[step], merged };
}

test('合并后的流程：主 Agent 选「这一项这次不跑」，要这段文字的加入者都不跑，其余照跑，运行成功结束', async t => {
  const skipped = await afterSkip(t, ['deploy', 'publish-preview', 'publish-release'], [{ result: 'completed', choice: 'skip', note: '' }]);
  assert.deepEqual([skipped.merged.only, skipped.merged.inputs], ['["deploy"]', '{}']);
  assert.deepEqual([skipped.visited, skipped.end.id], [['fill', 'merged-inputs', 'run-merged'], 'done']);
});

test('合并后的流程：勾了的都被「这一项这次不跑」去掉，不进 run-merged，运行成功结束', async t => {
  const skipped = await afterSkip(t, ['publish-preview', 'publish-release'], [{ result: 'completed', choice: 'skip', note: '' }]);
  assert.equal(skipped.merged.only, '[]');
  assert.deepEqual([skipped.visited, skipped.end.id, skipped.end.status], [['fill', 'merged-inputs'], 'done-none', '已完成，没有要跑的合并后流程']);
});

test('需求运行的定义：输入、进行中的三种答复、暂停卡、收尾各处失败回到进行中、整体评审、合并方式与合并后的流程', async () => {
  const { process, elements, nodes, values, params, route, next } = await definition();
  assert.equal(process.name, '监督开发'); assert.equal(process.kind, undefined); assert.equal(process.concurrency, undefined);
  assert.deepEqual(values(process).filter(v => v.$type === 'coda:Join').map(j => j.hook), ['develop'], '开发流程：加入挂点 develop');
  const inputs = Object.fromEntries(values(process).filter(v => v.$type === 'coda:Input').map(v => [v.name, v]));
  assert.deepEqual(Object.keys(inputs), ['title', 'devices', 'device', 'hold', 'delivery', 'executor', 'executor2', 'reviewer', 'reviewer2', 'reviewer3', 'base']);
  assert.deepEqual(Object.values(inputs).filter(v => v.required), [], '用户在会话里开启时什么都不必填');
  for (const name of ['title', 'device', 'delivery', 'base']) assert.equal(inputs[name].default, '', name);
  assert.deepEqual([inputs.devices.type, inputs.devices.default], ['boolean', 'false']);
  for (const name of ['executor', 'executor2', 'reviewer', 'reviewer2', 'reviewer3']) assert.deepEqual([inputs[name].type, inputs[name].default, inputs[name].defaultFrom], ['agent', undefined, undefined], name);
  assert.equal(nodes.start.eventDefinitions, undefined, '不订阅 PR 事件');
  assert.ok(manifest.files.includes('.coda/workflows')); assert.ok(manifest.files.includes('scripts'));
  for (const [title, expected] of [['', '监督开发'], ['输入框', '需求：输入框']]) assert.equal(evaluate(process.title.slice(2, -2), { inputs: { title } }).value, expected);

  // 目标是发起时带的需求文字（run.message）；需求名和它缺一样就先交主 Agent 写需求，不叫醒它。
  for (const [title, message, target] of [['', '', 'brief'], ['输入框', '', 'brief'], ['', '能输入', 'brief'], ['输入框', '能输入', 'lane']]) {
    assert.equal(route('brief-choice', { inputs: { title }, run: { message } }), target, `${title}|${message}`);
  }
  const briefed = [...nodes.brief.documentation[0].text.matchAll(/{{(.*?)}}/gs)].find(m => m[1].includes('run.message'))[1];
  assert.equal(evaluate(briefed, { run: { message: '' } }).value, '');
  assert.equal(evaluate(briefed, { run: { message: '能输入' } }).value, '发起时带的需求：\n能输入\n');
  assert.deepEqual([nodes.brief.wake, nodes.brief.assignee], ['false', undefined]);
  assert.deepEqual(values(nodes.brief).map(v => [v.id, v.note]), [['start', 'required']]);
  for (const [value, target] of [['brief', 'brief'], ['lane', 'lane']]) assert.equal(route('after-brief', { 'brief-result': { route: value } }), target);
  for (const [field, written] of [['TITLE', 'title'], ['GOAL', 'goal']]) {
    const expression = params('lane')[field].slice(1);
    for (const [title, message] of [['', ''], ['输入框', ''], ['', '能输入']]) {
      assert.equal(evaluate(expression, { inputs: { title }, run: { message }, 'brief-result': { [written]: '写的' } }).value, '写的', `${field} ${title}|${message}`);
    }
    assert.equal(evaluate(expression, { inputs: { title: '输入框' }, run: { message: '能输入' } }).value, field === 'TITLE' ? '输入框' : '能输入');
  }

  // 进行中：交主 Agent，三种答复；每次进来都经过「整理回来的原因」。
  assert.equal(next('lane'), 'resume');
  assert.equal(next('resume'), 'progress');
  assert.equal(nodes.progress.assignee, undefined);
  assert.deepEqual(values(nodes.progress).map(v => [v.id, v.name, v.note]), [['submit', '提交验收', 'required'], ['pause', '暂停', 'required'], ['abandon', '放弃', undefined]]);
  for (const [value, target] of [['progress', 'progress'], ['pause', 'paused'], ['abandon', 'abandoned'], ['submit', 'sync']]) assert.equal(route('after-progress', { 'progress-result': { route: value } }), target);
  const doc = nodes.progress.documentation[0].text;
  for (const text of ['workflow_run 发起一个块（piece）', 'branch="{{lane.lane}}"', 'base="{{lane.base}}"', 'title', 'task', 'executor、executor2、reviewer、reviewer2。executor 必传', '没理由另定的块传下面的开工执行者', '按你手上的执行者名单（有的话）另定', '开工值有就默认传它', '开工没填的，每块自己定', 'reviewer、reviewer2 仍由你按这一块的性质逐个定，有执行者名单就从名单选',
    '可以同时发起', 'sync=true', '以合并提交快进进需求分支', 'mac-preview-install', '加入挂点 premerge 的流程', '{{lane.lane}}', '{{lane.goal}}']) assert.ok(doc.includes(text), text);
  assert.ok(!doc.includes('reviewerOnce'), '块没有只评第一次交付的位置');
  assert.ok(!doc.includes('不传 executor 用你的 Agent'), '不再悄悄落到主会话');
  // 开工值照引擎渲染：模板里 {{…}} 的值是对象就转成 JSON 文本，null 是空文本。
  const asText = v => v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  const render = (text, context) => text.replace(/{{([\s\S]*?)}}/g, (_, e) => asText(evaluate(e, context).value));
  const line = (text, head) => text.split('\n').find(l => l.startsWith(head));
  const chosen = { agent: 'codex', model: 'gpt-6.1-sol', effort: 'ultra', options: { 'service-tier': 'priority' } }, backup = { agent: 'claude-sdk', model: 'claude-opus-5-5' };
  const filled = render(doc, { inputs: { reviewer: null, reviewer2: null, reviewer3: null, delivery: '', devices: false, executor: chosen, executor2: backup }, run: { id: 'run-1' }, lane: {}, resume: { reason: '' } });
  assert.equal(line(filled, '开工执行者，'), `开工执行者，值是 JSON，原样作 workflow_run 的 executor 输入：${JSON.stringify(chosen)}`);
  assert.equal(line(filled, '开工备用执行者，'), `开工备用执行者，原样作 executor2 输入：${JSON.stringify(backup)}`);
  assert.deepEqual(JSON.parse(line(filled, '开工执行者，').split('：').slice(1).join('：')), chosen, '渲染出的文字能直接解析成 agent 对象');
  const empty = render(doc, { inputs: { reviewer: null, reviewer2: null, reviewer3: null, delivery: '', devices: false, executor: null, executor2: null }, run: { id: 'run-1' }, lane: {}, resume: { reason: '' } });
  assert.match(line(empty, '开工执行者，'), /：没填，每块自己定$/);
  assert.match(line(empty, '开工备用执行者，'), /：没填，每块自己定$/);
  // 只填了第三整体评审者也算要整体评审：进行中的说明与批准卡都这样写。
  const reviewed = (text, needle) => [...text.matchAll(/{{(.*?)}}/gs)].find(m => m[1].includes('inputs.reviewer3') && m[1].includes(needle))[1];
  const nobody = { reviewer: null, reviewer2: null, reviewer3: null };
  for (const [text, needle, said] of [[doc, '整体评审一次', '整体评审一次（只有测试、文档、风格类的小问题时先交开工执行者就地修、原评审者复评），'], [nodes.approve.documentation[0].text, '整条需求分支已整体评审', '，整条需求分支已整体评审']]) {
    assert.equal(evaluate(reviewed(text, needle), { inputs: nobody }).value, '');
    assert.equal(evaluate(reviewed(text, needle), { inputs: { ...nobody, reviewer3: { agent: 'c' } } }).value, said);
  }
  const reasonLine = [...doc.matchAll(/{{(.*?)}}/gs)].find(m => m[1].includes('resume.reason'))[1];
  assert.equal(evaluate(reasonLine, { resume: { reason: '' } }).value, '');
  assert.equal(evaluate(reasonLine, { resume: { reason: '合并前检查未通过' } }).value, '回到进行中的原因：\n合并前检查未通过\n');
  // 收尾按是否归属需求交付分段写：成员运行没有用户的批准卡和「暂不合并」。
  const ending = [...doc.matchAll(/{{(.*?)}}/gs)].find(m => m[1].includes('inputs.delivery'))[1];
  const own = evaluate(ending, { inputs: { delivery: '', devices: true } }).value, member = evaluate(ending, { inputs: { delivery: 'deliver-1', devices: true } }).value;
  assert.equal(own, '再交用户设备验收，最后由用户批准合并（合并提交）。任何失败和用户的「暂不合并」都带着原因回到这里。');
  assert.equal(evaluate(ending, { inputs: { delivery: '', devices: false } }).value, '最后由用户批准合并（合并提交）。任何失败和用户的「暂不合并」都带着原因回到这里。');
  assert.equal(member, '之后进入「待交付」，由需求交付运行 deliver-1 统一验收、批准，没有用户的「暂不合并」。任何失败和待交付的「退回修改」都带着原因回到这里。');
  assert.equal(nodes.paused.assignee, 'user');
  assert.deepEqual(values(nodes.paused).map(v => [v.id, v.name]), [['continue', '继续'], ['abandon', '放弃']]);
  assert.match(nodes.paused.documentation[0].text, /\{\{progress\.note\}\}/);
  assert.equal(route('after-paused', { 'paused-result': { route: 'continue' } }), 'resume');
  assert.equal(route('after-paused', { 'paused-result': { route: 'abandon' } }), 'abandoned');
  assert.equal(nodes.abandoned.$type, 'bpmn:EndEvent');

  // 收尾：PR → 项目检查（复用）→ 合并前检查 → GitHub 检查 → 整体评审 → 设备验收 → 待交付或批准。
  assert.equal(next('pr'), 'pr-fork');
  // 需求分支 head 在检查的同时预编：只在随后会进设备验收时，不挡检查，失败也不算数。
  assert.deepEqual(elements.filter(e => e.sourceRef === nodes['pr-fork']).map(e => e.targetRef.id), ['reuse-checks', 'prebuild-choice']);
  for (const [devices, delivery, target] of [[true, '', 'prebuild'], [false, '', 'prebuilt'], [true, 'deliver-1', 'prebuilt']]) assert.equal(route('prebuild-choice', { inputs: { devices, delivery } }), target);
  assert.equal(params('prebuild').commit, '=pr.head');
  assert.equal(params('prebuild').hook, 'prebuild');
  for (const device of ['', 'duo-testbed']) assert.deepEqual(evaluate(params('prebuild').inputs.slice(1), { inputs: { device } }).value, device ? { device } : {});
  for (const id of ['prebuild-done', 'prebuild-failed-done', 'prebuild-skip']) assert.equal(nodes[id].targetRef.id, 'prebuilt');
  assert.deepEqual(params('checks'), { hook: 'check', commit: '=pr.head' });
  assert.equal(next('checks'), 'checks-passed');
  assert.equal(next('checks-passed'), 'premerge');
  assert.deepEqual(params('premerge'), { hook: 'premerge', commit: '=pr.head' });
  assert.equal(next('premerge'), 'github-checks');
  assert.equal(next('github-checks'), 'reviews-choice');
  for (const [boundary, task, step] of [['checks-failed', 'checks-feedback', '项目检查'], ['premerge-failed', 'premerge-feedback', '合并前检查'], ['github-checks-failed', 'github-feedback', 'GitHub 检查']]) {
    assert.equal(nodes[boundary].eventDefinitions[0].$type, 'bpmn:ErrorEventDefinition');
    assert.equal(next(boundary), task);
    assert.deepEqual(params(task), { STEP: step });
    assert.equal(next(task), 'resume', `${step}失败回到进行中`);
  }
  // 整体评审：填了才评，对整条需求分支评一次；发现交主 Agent。
  for (const [reviewer, reviewer2, reviewer3, target] of [[null, null, null, 'acceptance-choice'], [{ agent: 'a' }, null, null, 'overall-round'], [null, { agent: 'b' }, null, 'overall-round'], [null, null, { agent: 'c' }, 'overall-round']]) {
    assert.equal(route('reviews-choice', { inputs: { reviewer, reviewer2, reviewer3 } }), target);
  }
  assert.equal(nodes.reviews.optional, true);
  assert.equal(nodes['review-call'].calledElement, 'review-commit');
  assert.equal(next('overall-round'), 'reviews');
  assert.deepEqual(params('review-call'), { base: '=overall-round.base', head: '=pr.head', task: '=pr.task', reviewer: '=slot.who', evidence: '=github-checks.evidence', previous: '=slot.previous' });
  const slots = evaluate(nodes.reviews.loopCharacteristics.inputCollection.slice(1), { inputs: { reviewer: { agent: 'a' }, reviewer2: null, reviewer3: { agent: 'c' } }, 'overall-round': { previous: 'p1', previous2: '', previous3: 'p3' } }).value;
  assert.deepEqual(slots, [{ slot: 'reviewer', who: { agent: 'a' }, previous: 'p1' }, { slot: 'reviewer2', who: null, previous: '' }, { slot: 'reviewer3', who: { agent: 'c' }, previous: 'p3' }]);
  assert.equal(nodes['review-failed'].attachedToRef.id, 'review-call');
  assert.equal(next('reviews'), 'overall-triage');
  assert.equal(next('overall-rounds'), 'reviewed');
  assert.equal(params('reviewed').REVIEWS, '=reviews');
  assert.equal(nodes.review.assignee, undefined);
  assert.deepEqual(values(nodes.review).map(v => [v.id, v.name]), [['continue', '继续验收'], ['progress', '回到进行中']]);
  // 卡上展开的是「整理整体评审」的输出，不是多实例子流程 reviews 的结果列表。
  const card = nodes.review.documentation[0].text, found = '评审者（a）：评审要求修改\n- [P1] 标题';
  const shown = card.replace(/\{\{([\s\S]*?)\}\}/g, (_, expression) => evaluate(expression, {
    lane: { title: '需求', base: 'main' }, pr: { url: 'https://github.com/o/r/pull/1', head: 'h1' }, reviews: [null, null], reviewed: { reviews: found }, 'overall-rounds': { text: '' },
  }).value ?? '');
  assert.ok(shown.includes(`的发现：\n${found}\n`), shown);
  assert.equal(route('after-review', { 'review-result': { route: 'progress' } }), 'resume');
  assert.equal(route('after-review', { 'review-result': { route: 'continue' } }), 'acceptance-choice');
  for (const [devices, delivery, target] of [[true, '', 'acceptance'], [false, '', 'delivery-choice'], [true, 'deliver-1', 'delivery-choice']]) {
    assert.equal(route('acceptance-choice', { inputs: { devices, delivery } }), target);
  }
  assert.equal(route('acceptance-route', { acceptance: { route: 'return' } }), 'resume');
  assert.equal(route('acceptance-route', { acceptance: { route: 'passed' } }), 'tell-device');
  const tell = (field) => evaluate(params('tell-device')[field].slice(1), { lane: { title: '输入框' }, run: { id: 'run-1' }, pr: { head: 'head-1' } }).value;
  assert.equal(tell('text'), '需求「输入框」：用户设备验收通过，接下来等用户批准合并。');
  assert.equal(tell('key'), 'run-1:device:head-1');
  assert.equal(next('tell-device'), 'delivery-choice');
  assert.equal(route('delivery-choice', { inputs: { delivery: '' } }), 'joiners');
  assert.equal(route('delivery-choice', { inputs: { delivery: 'deliver-1' } }), 'delivery');
  assert.deepEqual(values(nodes.delivery).map(v => [v.id, v.name]), [['revise', '退回修改'], ['merge', '放行合并']]);
  for (const [value, target] of [['delivery', 'delivery'], ['progress', 'resume'], ['merge', 'merge']]) assert.equal(route('after-delivery', { 'delivery-result': { route: value } }), target);
  // 批准卡：勾选项是项目在需求分支 head 上加入挂点 merged 的流程，卡上只有数据，不写引导。
  assert.equal(nodes.joiners.action, 'hook-joiners');
  assert.deepEqual(params('joiners'), { hook: 'merged', commit: '=pr.head' });
  assert.equal(next('joiners'), 'approve');
  assert.equal(nodes.approve.assignee, 'user');
  assert.deepEqual(values(nodes.approve).map(v => [v.id, v.note]), [['merge', undefined], ['stop', 'required']]);
  assert.deepEqual(values(nodes.approve)[0].options.map(o => [o.$type, o.value ?? o.id, o.default]), [['coda:OptionList', '=joiners.list', undefined], ['coda:Option', 'notify', 'true']]);
  const face = nodes.approve.documentation[0].text;
  for (const text of ['{{pr.url}}', '项目检查、合并前检查、GitHub 检查已通过']) assert.ok(face.includes(text), text);
  // 汇总：整体评审分流过就用它的（只有 P3 时带上没修的小问题），没整体评审用开 PR 时的。
  for (const card of [face, nodes.delivery.documentation[0].text]) {
    const summary = [...card.matchAll(/{{(.*?)}}/g)].find(m => m[1].includes('summary'))[1];
    assert.equal(evaluate(summary, { pr: { summary: '开 PR 时' } }).value, '开 PR 时');
    assert.equal(evaluate(summary, { pr: { summary: '开 PR 时' }, 'overall-triage': { summary: '带 P3' } }).value, '带 P3');
  }
  assert.doesNotMatch(face, /勾选|默认|发布说明|暂不合并|部署/);
  const envs = id => Object.fromEntries(values(nodes[id]).filter(v => v.$type === 'coda:Env').map(v => [v.name, v.value]));
  const outputs = id => values(nodes[id]).filter(v => v.$type === 'coda:Output').map(v => v.name);
  assert.deepEqual(envs('approval-result'), { APPROVAL: '=approve', JOINERS: '=joiners.list' });
  assert.deepEqual(outputs('approval-result'), ['route', 'only', 'picked', 'inputs', 'missing', 'asks', 'needs']);
  for (const [value, target] of [['stop', 'resume'], ['merge', 'merge']]) assert.equal(route('after-approval', { 'approval-result': { route: value } }), target);
  assert.equal(route('after-merge', { merge: { route: 'conflict' } }), 'resume');
  assert.equal(route('after-merge', { merge: { route: 'merged' } }), 'merged-choice');
  assert.ok(!elements.some(e => e.id === 'stopped'), '暂不合并不再结束运行');
  for (const id of ['kinds', 'write-notes', 'notes-result', 'deploy', 'publish-preview', 'publish-release']) assert.ok(!nodes[id], id);

  // 合并后：成员运行不跑；独立交付只跑勾了的，没写的文字先交主 Agent 逐项写。
  for (const delivery of ['', 'deliver-1']) for (const only of ['[]', '["deploy","publish-preview"]']) for (const missing of ['', 'notes']) {
    const visited = [], context = { inputs: { delivery }, 'approval-result': { only, missing } };
    for (let step = 'merged-choice'; step !== 'done';) {
      visited.push(step);
      step = nodes[step].$type === 'bpmn:ExclusiveGateway' ? route(step, context) : next(step);
    }
    const runs = !delivery && only !== '[]';
    assert.deepEqual(visited.filter(id => !nodes[id].$type.endsWith('Gateway')), runs ? [...(missing ? ['fill'] : []), 'merged-inputs', 'run-merged'] : [], `${delivery}|${only}|${missing}`);
  }
  const loop = nodes.fill.loopCharacteristics;
  assert.deepEqual([loop.isSequential, loop.inputElement], [true, 'input']);
  assert.deepEqual(evaluate(loop.inputCollection.slice(1), { 'approval-result': { missing: 'notes,extra' } }).value, ['notes', 'extra']);
  assert.equal(nodes.fill.assignee, undefined, '交主 Agent');
  assert.deepEqual(values(nodes.fill).map(v => [v.id, v.note]), [['done', 'required'], ['skip', undefined]]);
  const asked = [...nodes.fill.documentation[0].text.matchAll(/{{(.*?)}}/gs)].find(m => m[1].includes('loopCounter'))[1];
  assert.equal(evaluate(asked, { 'approval-result': { asks: '「发布说明」：发布预览版要\n「别的」：部署要' }, loopCounter: 2 }).value, '「别的」：部署要');
  assert.deepEqual(envs('merged-inputs'), { INPUTS: '=approval-result.inputs', MISSING: '=approval-result.missing', ASKS: '=approval-result.asks', FILLS: '=fill', NEEDS: '=approval-result.needs', ONLY: '=approval-result.only' });
  assert.equal(route('left', { 'merged-inputs': { only: '["deploy"]' } }), 'run-merged');
  assert.deepEqual(params('run-merged'), { hook: 'merged', only: '=merged-inputs.only', commit: '=merge.commit', inputs: '=merged-inputs.inputs' });
  assert.deepEqual(elements.filter(e => e.action === 'run-workflows').map(e => e.id), ['prebuild', 'checks', 'premerge', 'run-merged']);
  for (const context of [{ inputs: { delivery: '' }, approve: { options: { notify: false } } }, { inputs: { delivery: 'deliver-1' } }]) {
    assert.equal(evaluate(nodes.done.notify.slice(1), context).value, context.inputs.delivery ? true : false);
  }
  assert.deepEqual(values(nodes.done).map(v => v.name), ['pr', 'commit', 'notify']);
  // 流程只定位置，不写 Ultra 或模型的知识。
  assert.doesNotMatch(workflow, /ultra|codex|claude|kimi|grok|opencode|cursor|gpt|sonnet|opus|haiku|gemini/i);
  assert.doesNotMatch(workflow, /squash 合并/, '进目标分支用合并提交');
});

// 跟上目标分支（sync-base / sync-resolve）：真 Git 小仓库，需求分支与 main 各自前进。
const parents = (f, commit) => f.git('rev-list', '--parents', '-n', '1', commit).split(' ').slice(1);

test('跟上目标分支：需求分支已包含目标分支不动；需求分支是它的祖先就快进；分叉能干净合并就推保留双亲的合并提交，汇总列出它', t => {
  const f = fixture(t); f.run('lane'); f.progress('submit', '汇报');
  const sync = (extra = {}) => f.run('sync-base', { FIXER: 'true', ...extra }).outputs.route;
  assert.equal(sync(), 'pr');
  assert.equal(f.remote('lane/run-1'), f.remote('main'), '刚建的需求分支就是目标分支');
  const landed = f.land('one', 'first');
  assert.equal(sync(), 'pr');
  assert.equal(f.remote('lane/run-1'), landed, '已包含：不动');

  const f2 = fixture(t); f2.run('lane'); f2.progress('submit', '汇报');
  const main = f2.advanceMain('two', 'main moved');
  assert.equal(f2.run('sync-base', { FIXER: 'false' }).outputs.route, 'pr');
  assert.equal(f2.remote('lane/run-1'), main, '快进到目标分支');
  assert.equal(f2.state().pushed, undefined, '快进没有流程自己做的提交');

  const lane = f.land('three', 'lane'), base = f.advanceMain('four', 'main');
  assert.equal(sync({ FIXER: 'false' }), 'pr', '干净合并不需要执行者');
  const merged = f.remote('lane/run-1');
  assert.deepEqual(parents(f, merged), [lane, base], '需求分支在前、目标分支在后');
  assert.equal(f.git('show', '-s', '--format=%s', merged), '合并 main 到 lane/run-1');
  assert.equal(f.git('ls-tree', '--name-only', merged).split('\n').sort().join(','), 'base,four,one,three');
  assert.deepEqual(f.state().pushed, [{ commit: merged, subject: '合并 main 到 lane/run-1', why: '跟上 main' }]);
  const summary = f.run('pr').outputs.summary;
  assert.ok(summary.includes(`块：\n（还没有合进需求分支的块）\n\n流程直接推到需求分支的提交：\n- ${merged.slice(0, 12)} 合并 main 到 lane/run-1（跟上 main）\n\n改动：`), summary);
  assert.equal(f.state().head, merged, '之后的检查跑在新 head 上');
});

test('跟上目标分支有冲突：没填执行者带着冲突文件回到进行中；填了就交执行者从需求分支 head 合并，两端都包含才推送', t => {
  const f = fixture(t); f.run('lane'); f.progress('submit', '汇报');
  const lane = f.land('shared', 'lane side'), base = f.advanceMain('shared', 'main side');
  assert.equal(f.run('sync-base', { FIXER: 'false' }).outputs.route, 'progress');
  const text = f.reason();
  for (const part of ['有冲突', '- shared', '没填开工执行者', 'sync=true 的块']) assert.ok(text.includes(part), part);
  assert.equal(f.remote('lane/run-1'), lane, '需求分支不动');

  f.progress('submit', '汇报');
  assert.equal(f.run('sync-base', { FIXER: 'true' }).outputs.route, 'resolve');
  f.task({ merge: 'main', file: 'shared', text: 'both', answer: '解好了', subject: '合并 main' });
  assert.equal(f.run('sync-resolve', { EXECUTOR: JSON.stringify({ agent: 'codex', model: 'm1' }) }).outputs.route, 'pr');
  const call = f.agentCalls()[0], resolved = f.remote('lane/run-1');
  assert.deepEqual(call.args.slice(0, 8), ['--commit', lane, '--title', '输入框：跟上 main', '--agent', 'codex', '--model', 'm1']);
  for (const part of ['不再委派', '- shared', `git merge ${base}`, '不要变基', '顺延需求分支这边的']) assert.ok(call.prompt.includes(part), part);
  assert.deepEqual(parents(f, resolved), [lane, base]);
  assert.deepEqual(f.state().pushed.map(p => [p.commit, p.why]), [[resolved, '跟上 main，执行者解冲突']]);

  // 执行者没有把目标分支合并进来：不推送，回到进行中。
  const f2 = fixture(t); f2.run('lane'); f2.progress('submit', '汇报');
  const lane2 = f2.land('shared', 'lane side'); f2.advanceMain('shared', 'main side');
  f2.run('sync-base', { FIXER: 'true' });
  f2.task({ file: 'other', answer: '没合' });
  assert.equal(f2.run('sync-resolve', { EXECUTOR: JSON.stringify({ agent: 'codex' }) }).outputs.route, 'progress');
  assert.match(f2.reason(), /执行者没有把 main .* 合并进需求分支[\s\S]*没合/);
  assert.equal(f2.remote('lane/run-1'), lane2);
});

test('流程推需求分支被拒（需求分支被别人推进了）：不重试、不覆盖，带着原因回到进行中；需求分支没动的推送失败保留退出码', t => {
  const f = fixture(t); f.run('lane'); f.progress('submit', '汇报');
  const lane = f.land('shared', 'lane side'); f.advanceMain('shared', 'main side');
  f.run('sync-base', { FIXER: 'true' });
  // 别人推进了需求分支：执行者解冲突期间需求分支前进一个提交。
  f.git('switch', '-q', '--detach', lane); writeFileSync(join(f.work, 'other'), 'other'); f.git('add', 'other'); f.git('commit', '-qm', 'other');
  const other = f.git('rev-parse', 'HEAD');
  f.task({ advance: other, merge: 'main', file: 'shared', text: 'both', answer: '解好了' });
  assert.equal(f.run('sync-resolve', { EXECUTOR: JSON.stringify({ agent: 'codex' }) }).outputs.route, 'progress');
  assert.equal(f.remote('lane/run-1'), other, '别人的提交还在');
  for (const part of ['被拒', `需求分支已不是 ${lane}`, '流程没有覆盖', '重新提交验收']) assert.ok(f.reason().includes(part), part);
  assert.equal(f.state().pushed, undefined);

  // 服务端拒收、需求分支没动：不是被推进了，保留原退出码。
  const f2 = fixture(t); f2.run('lane'); f2.progress('submit', '汇报');
  f2.land('one', 'lane'); f2.advanceMain('two', 'main');
  const hook = join(f2.origin, 'hooks', 'pre-receive');
  writeFileSync(hook, '#!/bin/sh\nexit 1\n'); chmodSync(hook, 0o755);
  assert.deepEqual(f2.run('sync-base', { FIXER: 'true' }, 1).outputs, {});
});

// 整体评审各份的输出（review-commit 的结果加位置、评的 head）。
const overallReview = (slot, head, findings, extra = {}) => ({ state: 'done', slot, who: JSON.stringify({ agent: slot }), head, reviewed: head,
  decision: findings.length ? 'COMMENT' : 'APPROVE', line: '结论', findings: JSON.stringify(findings), report: '原文', resolutions: '[]', blocking: 'P2', ...extra });
const DOC = { severity: 'P2', kind: 'documentation', title: 'README 漏了新输入', location: 'README.md:1', detail: '补一句' };
const NIT = { severity: 'P3', kind: 'style', title: '变量名', location: 'one:1', detail: '可以更短' };
const responded = (text, responses) => `${text}\n\n\`\`\`responses\n${JSON.stringify({ responses })}\n\`\`\``;

function submitted(t) {
  const f = fixture(t); f.run('lane'); f.land('one', 'first'); f.progress('submit', '汇报');
  f.run('sync-base', { FIXER: 'true' });
  const pr = f.run('pr').outputs;
  return { f, pr };
}

test('整体评审只有 P3：不出主 Agent 的卡，直接验收，P3 原样写进 PR 描述和批准卡用的汇总', t => {
  const { f, pr } = submitted(t);
  assert.deepEqual(f.run('overall-round', { BASE: pr.base }).outputs, { base: pr.base, previous: '', previous2: '', previous3: '' }, '完整评审整条需求分支');
  const result = f.run('overall-triage', { REVIEWS: JSON.stringify([overallReview('reviewer', pr.head, [NIT]), overallReview('reviewer2', pr.head, []), { state: 'skipped' }]), SUMMARY: pr.summary, FIXER: 'false' }).outputs;
  assert.equal(result.route, 'accept');
  assert.equal(result.summary, `${pr.summary}\n\n整体评审的小问题（P3，没有修）：\n- reviewer:1 [P3·style] 变量名（one:1）\n  可以更短`);
  const edit = f.calls().filter(c => c.args[1] === 'edit').at(-1);
  assert.deepEqual([edit.args.slice(0, 3), edit.body], [['pr', 'edit', PR], result.summary]);
  // 没有发现：汇总不变，不改 PR 描述。
  const edits = f.calls().filter(c => c.args[1] === 'edit').length;
  f.run('sync-base', { FIXER: 'true' }); f.run('pr');
  assert.deepEqual(f.run('overall-triage', { REVIEWS: JSON.stringify([overallReview('reviewer', pr.head, [])]), SUMMARY: pr.summary, FIXER: 'true' }).outputs, { route: 'accept', summary: pr.summary });
  assert.equal(f.calls().filter(c => c.args[1] === 'edit').length, edits);
});

test('整体评审的 P2 小问题：开工执行者在需求分支上修，普通推送，汇总列出修复提交；新 head 增量复评，修好了直接验收', t => {
  const { f, pr } = submitted(t);
  f.run('overall-round', { BASE: pr.base });
  assert.equal(f.run('overall-triage', { REVIEWS: JSON.stringify([overallReview('reviewer', pr.head, [DOC, NIT])]), SUMMARY: pr.summary, FIXER: 'true' }).outputs.route, 'fix');
  f.task({ file: 'README.md', text: '新输入', subject: '补 README', answer: responded('补了', [{ id: 'reviewer:1', disposition: 'fixed', commit: 'c1', reason: '补了一句' }]) });
  assert.equal(f.run('overall-fix', { EXECUTOR: JSON.stringify({ agent: 'codex' }) }).outputs.route, 'pr');
  const call = f.agentCalls()[0], fixed = f.remote('lane/run-1');
  assert.deepEqual(call.args.slice(0, 6), ['--commit', pr.head, '--title', '输入框：整体评审修复', '--agent', 'codex']);
  for (const part of ['不再委派', '- reviewer:1 [P2·documentation·阻塞] README 漏了新输入（README.md:1）', '三个反引号加 responses']) assert.ok(call.prompt.includes(part), part);
  assert.ok(!call.prompt.includes('reviewer:2'), 'P3 不交执行者');
  assert.deepEqual(parents(f, fixed), [pr.head], '普通推送，接在需求分支 head 后面');

  // 回到开 PR：汇总列出直接推到需求分支的修复提交，新 head 重跑检查。
  const again = f.run('pr').outputs;
  assert.equal(again.head, fixed);
  assert.equal(again.checked, 'false', '新 head 照常跑全部检查');
  assert.ok(again.summary.includes(`流程直接推到需求分支的提交：\n- ${fixed.slice(0, 12)} 补 README（整体评审修复）`), again.summary);
  assert.ok(f.calls().filter(c => c.args[1] === 'create' || c.args[1] === 'edit').at(-1).body.includes(`- ${fixed.slice(0, 12)} 补 README（整体评审修复）`), 'PR 描述里也有');

  const round = f.run('overall-round', { BASE: again.base }).outputs;
  assert.equal(round.base, pr.head, '增量复评：base 是上次评过的 head');
  assert.deepEqual(JSON.parse(round.previous).map(p => [p.id, p.response?.disposition]), [['reviewer:1', 'fixed'], ['reviewer:2', undefined]]);
  assert.deepEqual([round.previous2, round.previous3], ['[]', '[]']);
  const resolutions = JSON.stringify([{ id: 'reviewer:1', status: 'resolved', reason: '补上了' }]);
  const done = f.run('overall-triage', { REVIEWS: JSON.stringify([overallReview('reviewer', fixed, [], { resolutions })]), SUMMARY: again.summary, FIXER: 'true' }).outputs;
  assert.equal(done.route, 'accept');
  assert.ok(done.summary.includes('补 README（整体评审修复）') && done.summary.includes('- reviewer:2 [P3·style] 变量名'), '批准卡的汇总：修复提交和没修的 P3');
});

test('整体评审的回路：只反驳不重跑检查直接复评，坚持就交主 Agent，卡上附收敛经过；两轮上限；没填执行者、推送被拒', t => {
  const { f, pr } = submitted(t);
  f.run('overall-round', { BASE: pr.base });
  f.run('overall-triage', { REVIEWS: JSON.stringify([overallReview('reviewer', pr.head, [DOC])]), SUMMARY: pr.summary, FIXER: 'true' });
  f.task({ noCommit: true, answer: responded('不成立', [{ id: 'reviewer:1', disposition: 'disputed', reason: 'README 已经写了', evidence: 'README.md:9' }]) });
  assert.equal(f.run('overall-fix', { EXECUTOR: JSON.stringify({ agent: 'codex' }) }).outputs.route, 'again');
  const round = f.run('overall-round', { BASE: pr.base }).outputs;
  assert.equal(round.base, pr.head, '没有新提交：base 与 head 相同');
  const upheld = JSON.stringify([{ id: 'reviewer:1', status: 'upheld', reason: '没写' }]);
  assert.equal(f.run('overall-triage', { REVIEWS: JSON.stringify([overallReview('reviewer', pr.head, [], { resolutions: upheld })]), SUMMARY: pr.summary, FIXER: 'true' }).outputs.route, 'escalate');
  const text = f.run('overall-rounds').outputs.text;
  for (const part of [`评审（head ${pr.head.slice(0, 12)}）：`, '- reviewer:1 [P2·documentation·阻塞] README 漏了新输入', '交执行者修第 1 轮', '- reviewer:1：disputed：README 已经写了；证据：README.md:9',
    '- reviewer:1 → upheld：没写', '结论：升级给主 Agent：reviewer:1：执行者反驳了，评审者仍坚持', `全文：${join(f.env.CODA_ARTIFACTS, 'converge.md')}`]) assert.ok(text.includes(part), part);
  assert.equal(f.state().converge.waiting, false);

  // 重新提交验收：收敛从头开始；修两轮仍有 P2 就交主 Agent，第二轮续同一个执行会话。
  f.progress('submit', '汇报'); f.run('sync-base', { FIXER: 'true' });
  let head = f.run('pr').outputs.head;
  f.run('overall-round', { BASE: pr.base });
  f.run('overall-triage', { REVIEWS: JSON.stringify([overallReview('reviewer', head, [DOC])]), SUMMARY: '', FIXER: 'true' });
  const kept = JSON.stringify([{ id: 'reviewer:1', status: 'upheld', reason: '还不全' }]);
  for (const round of [1, 2]) {
    f.task({ file: 'README.md', text: `第 ${round} 次`, answer: responded('改了', [{ id: 'reviewer:1', disposition: 'fixed' }]) });
    assert.equal(f.run('overall-fix', { EXECUTOR: JSON.stringify({ agent: 'codex' }) }).outputs.route, 'pr');
    head = f.run('pr').outputs.head;
    f.run('overall-round', { BASE: pr.base });
    const route = f.run('overall-triage', { REVIEWS: JSON.stringify([overallReview('reviewer', head, [], { resolutions: kept })]), SUMMARY: '', FIXER: 'true' }).outputs.route;
    assert.equal(route, round === 1 ? 'fix' : 'escalate', `第 ${round} 轮之后`);
  }
  assert.deepEqual(f.agentCalls().slice(-2).map(c => c.args[0]), ['--commit', '--continue'], '第二轮续同一会话');
  assert.match(f.run('overall-rounds').outputs.text, /自动修了 2 轮仍有 P2 发现/);

  // 没填开工执行者：P2 小问题也交主 Agent。
  f.progress('submit', '汇报'); f.run('sync-base', { FIXER: 'false' }); head = f.run('pr').outputs.head;
  f.run('overall-round', { BASE: pr.base });
  assert.equal(f.run('overall-triage', { REVIEWS: JSON.stringify([overallReview('reviewer', head, [DOC])]), SUMMARY: '', FIXER: 'false' }).outputs.route, 'escalate');

  // 修复推送被拒：别人推进了需求分支，不覆盖，回到进行中。
  f.progress('submit', '汇报'); f.run('sync-base', { FIXER: 'true' }); head = f.run('pr').outputs.head;
  f.run('overall-round', { BASE: pr.base });
  f.run('overall-triage', { REVIEWS: JSON.stringify([overallReview('reviewer', head, [DOC])]), SUMMARY: '', FIXER: 'true' });
  f.git('switch', '-q', '--detach', head); writeFileSync(join(f.work, 'other'), 'other'); f.git('add', 'other'); f.git('commit', '-qm', 'other');
  const other = f.git('rev-parse', 'HEAD');
  f.task({ advance: other, file: 'README.md', text: '再改', answer: '改了' });
  assert.equal(f.run('overall-fix', { EXECUTOR: JSON.stringify({ agent: 'codex' }) }).outputs.route, 'progress');
  assert.equal(f.remote('lane/run-1'), other);
  assert.match(f.reason(), /被拒/);
});

test('新流程定义：提交验收先跟上目标分支，再开 PR；整体评审之后分流，就地修回到开 PR 重跑全部检查，卡与答复不变', async () => {
  const { nodes, params, route, next, values } = await definition();
  assert.equal(route('after-progress', { 'progress-result': { route: 'submit' } }), 'sync');
  assert.deepEqual(params('sync'), { FIXER: '=inputs.executor != null', route: undefined });
  for (const [value, target] of [['pr', 'pr'], ['resolve', 'sync-resolve'], ['progress', 'resume']]) assert.equal(route('after-sync', { sync: { route: value } }), target, value);
  assert.deepEqual(params('sync-resolve'), { EXECUTOR: '=inputs.executor', route: undefined });
  for (const [value, target] of [['pr', 'pr'], ['progress', 'resume']]) assert.equal(route('after-sync-resolve', { 'sync-resolve': { route: value } }), target, value);
  for (const id of ['sync-resolve', 'overall-fix']) assert.equal(nodes[id].checkout, undefined, `${id} 在步骤工作区里推送`);
  assert.equal(nodes.sync.checkout, undefined, '在步骤工作区里试合并、做合并提交');
  assert.equal(next('pr'), 'pr-fork', '同步之后照常开 PR、跑全部检查');
  assert.deepEqual(params('overall-round'), { BASE: '=pr.base', base: undefined, previous: undefined, previous2: undefined, previous3: undefined });
  assert.deepEqual(Object.fromEntries(values(nodes['review-done']).map(v => [v.name, v.value])), {
    state: 'done', slot: '=slot.slot', who: '=slot.who', head: '=pr.head', decision: '=review-call.decision', line: '=review-call.line',
    findings: '=review-call.findings', report: '=review-call.report', reviewed: '=review-call.head', resolutions: '=review-call.resolutions', blocking: '=review-call.blocking' });
  assert.deepEqual(params('overall-triage'), { REVIEWS: '=reviews', SUMMARY: '=pr.summary', FIXER: '=inputs.executor != null', route: undefined, summary: undefined });
  for (const [value, target] of [['accept', 'acceptance-choice'], ['fix', 'overall-fix'], ['escalate', 'overall-rounds']]) assert.equal(route('overall-triage-route', { 'overall-triage': { route: value } }), target, value);
  for (const [value, target] of [['pr', 'pr'], ['again', 'overall-round'], ['progress', 'resume'], ['review', 'overall-rounds']]) assert.equal(route('overall-fix-route', { 'overall-fix': { route: value } }), target, value);
  assert.equal(next('overall-rounds'), 'reviewed');
  assert.equal(next('reviewed'), 'review');
  const previous = await definition(old);
  for (const id of ['review', 'approve', 'delivery']) assert.deepEqual(values(nodes[id]).map(v => [v.$type, v.id, v.name, v.note, v.primary]), values(previous.nodes[id]).map(v => [v.$type, v.id, v.name, v.note, v.primary]), `${id} 的答复不变`);
  const card = nodes.review.documentation[0].text, expression = [...card.matchAll(/{{(.*?)}}/g)].find(m => m[1].includes('overall-rounds.text'))[1];
  assert.equal(evaluate(expression, { 'overall-rounds': { text: '' } }).value, '');
  assert.match(evaluate(expression, { 'overall-rounds': { text: '经过' } }).value, /^\n收敛经过（.*）：\n经过\n$/);
});

// 旧定义里每个脚本步骤：动作名、env 与输出。
const steps = source => [...source.matchAll(/<scriptTask id="([^"]+)"[\s\S]*?<\/scriptTask>/g)].map(([text, id]) => ({ id,
  action: /develop\.mjs" ([\w-]+)</.exec(text)[1], env: [...text.matchAll(/<coda:env name="(\w+)"/g)].map(m => m[1]), outputs: [...text.matchAll(/<coda:output name="(\w+)"/g)].map(m => m[1]) }));

for (const { version, source: old } of olds) test(`${version} 的流程定义：它引用的每个动作新脚本都还有，env 与输出不变，照它的顺序走得通`, t => {
  const before = steps(old), now = steps(workflow), source = readFileSync(script, 'utf8');
  assert.deepEqual([...new Set(before.map(s => s.action))], ['brief', 'lane', 'resume', 'progress', 'paused', 'pr', 'check-failed', 'checks-passed', 'github-checks', 'reviewed', 'review',
    'preview', 'device', 'delivery', 'approval', 'merge', 'inputs']);
  for (const step of before) {
    assert.ok(source.includes(`case '${step.action}':`) || source.includes(`action === '${step.action}'`), step.action);
    const same = now.find(s => s.id === step.id);
    assert.deepEqual([same.action, same.env, same.outputs], [step.action, step.env, step.outputs], step.id);
  }
  // 旧定义调用 review-commit 用的参数，能力都还收，新加的都不必填。
  const capability = readFileSync(new URL('../../../plugins/review/.coda/capabilities/review-commit.bpmn', import.meta.url), 'utf8');
  const inputs = Object.fromEntries([...capability.matchAll(/<coda:input name="(\w+)"([^>]*)\/>/g)].map(m => [m[1], m[2].includes('required="true"')]));
  const given = [...[...old.matchAll(/<callActivity id="review-call"[\s\S]*?<\/callActivity>/g)][0][0].matchAll(/<coda:param name="(\w+)"/g)].map(m => m[1]);
  for (const name of given) assert.ok(name in inputs, name);
  assert.deepEqual(Object.keys(inputs).filter(name => inputs[name] && !given.includes(name)), []);

  // 照旧定义的路径跑一遍（提交验收直接开 PR，不经同步）：每步给出的输出正是旧定义声明的。
  const f = fixture(t), declared = Object.fromEntries(before.map(s => [s.action, s.outputs]));
  const check = (action, extra = {}) => assert.deepEqual(Object.keys(f.run(action, extra).outputs).sort(), [...declared[action]].sort(), action);
  check('lane'); check('resume'); f.land('one', 'first');
  check('progress', { PROGRESS: JSON.stringify({ choice: 'submit', note: '汇报' }) });
  check('pr'); check('checks-passed', { RUNS: '[]' }); check('github-checks');
  check('reviewed', { REVIEWS: JSON.stringify([overallReview('reviewer', f.state().head, [DOC])]) });
  check('review', { REVIEW: JSON.stringify({ choice: 'continue' }) });
  check('approval', { APPROVAL: JSON.stringify({ choice: 'merge', options: {} }), JOINERS: '[]' });
  check('inputs', { INPUTS: '{}', MISSING: '', ONLY: '[]' });
  f.git('switch', '-q', '--detach'); check('merge');
});
