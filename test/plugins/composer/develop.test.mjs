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
  // 一个泳道 PR 合进了泳道：在泳道上另提交一个。
  const land = (file, text) => {
    git('fetch', '-q', 'origin', state().lane); git('switch', '-q', '--detach', 'FETCH_HEAD');
    writeFileSync(join(work, file), text); git('add', file); git('commit', '-qm', `lane ${file}`); git('push', '-q', 'origin', `HEAD:refs/heads/${state().lane}`);
    return git('rev-parse', 'HEAD');
  };
  const answer = (action, name, choice, note, extra = {}) => run(action, { [name]: JSON.stringify({ choice, note }), ...extra }).outputs;
  const progress = (choice, note) => answer('progress', 'PROGRESS', choice, note);
  const reason = () => run('resume').outputs.reason;
  return { root, work, env, git, run, state, calls, remote, land, answer, progress, reason };
}

async function definition() {
  const { root, problem } = await readWorkflow(workflow, 'develop'); assert.ok(!problem, problem);
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

test('建泳道：从目标分支最新提交建 lane/<运行 ID> 并推送；远端已有同名泳道时沿用，从头重跑不失败', t => {
  const f = fixture(t);
  const lane = f.run('lane').outputs;
  assert.deepEqual(lane, { title: '输入框', goal: '输入框可以输入', base: 'main', lane: 'lane/run-1' });
  assert.equal(f.remote('lane/run-1'), f.remote('main'));
  const landed = f.land('one', 'first lane PR');
  f.git('switch', '-q', 'main');
  writeFileSync(join(f.work, 'later'), 'later'); f.git('add', 'later'); f.git('commit', '-qm', 'main moved'); f.git('push', '-q', 'origin', 'main');
  assert.equal(f.run('lane').outputs.lane, 'lane/run-1');
  assert.equal(f.remote('lane/run-1'), landed, '沿用已有泳道，不重建、不丢已合进去的泳道 PR');
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

test('提交验收开泳道进目标分支的 PR：不带会话开，正文是汇报、从 GitHub 读的已合并泳道 PR 与改动区域；再提交更新同一个 PR', t => {
  const f = fixture(t); f.run('lane');
  const head = f.land('one', 'first');
  f.progress('submit', '汇报');
  const prs = [{ number: 12, title: '补齐状态', url: 'https://github.com/example/fixture/pull/12' }, { number: 9, title: '输入框可以输入', url: 'https://github.com/example/fixture/pull/9' }];
  const opened = f.run('pr', { LANE_PRS: JSON.stringify(prs) }).outputs;
  const summary = '汇报\n\n泳道 PR：\n- 输入框可以输入（https://github.com/example/fixture/pull/9）\n- 补齐状态（https://github.com/example/fixture/pull/12）\n\n改动：1 个文件 +1 -0\n- 根目录：1 个文件 +1 -0';
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
  assert.match(edit.body, /^新汇报\n\n泳道 PR：\n（还没有合进泳道的泳道 PR）\n\n改动：2 个文件 \+2 -0/);
  assert.deepEqual(f.calls().find(c => c.args[1] === 'list' && c.args.includes('open')).args,
    ['pr', 'list', '--head', 'lane/run-1', '--base', 'main', '--state', 'open', '--limit', '1', '--json', 'url', '--jq', '.[].url']);
});

test('项目检查按泳道 head 复用：同一 head 通过过就不再跑，泳道动了就再跑', async t => {
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
    for (const part of [`${step}未通过`, head, 'coda://workflow-runs/run-1', 'workflow_status', '提泳道 PR 修好后再提交验收']) assert.ok(text.includes(part), part);
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
  for (const part of ['合并冲突', '目标分支 main', 'sync=true 的泳道 PR', '再提交验收', '重新跑检查、批准合并']) assert.ok(text.includes(part), part);
  for (const [mergeable, stderr] of [['UNKNOWN', 'network unavailable'], ['MERGEABLE', 'HTTP 403: Forbidden']]) {
    const result = f.run('merge', { MERGE_EXIT: '7', MERGE_STDERR: stderr, PR_MERGEABLE: mergeable }, 7);
    assert.equal(result.stderr, stderr);
    assert.deepEqual(result.outputs, {});
  }
});

test('整体评审的材料：只取评泳道这个 head 的，没评成的指向本运行「评审整条泳道」', t => {
  const f = fixture(t); f.run('lane'); f.land('one', 'first'); f.progress('submit', '汇报'); f.run('pr');
  const head = f.state().head, path = join(f.env.CODA_ARTIFACTS, 'reviews.md');
  const reviews = [
    { state: 'done', slot: 'reviewer', who: JSON.stringify({ agent: 'a1', effort: 'high' }), head, decision: 'APPROVE', line: '可以', findings: '[]', report: '原文' },
    { state: 'lost', slot: 'reviewer2', who: JSON.stringify({ agent: 'a2' }), head },
  ];
  assert.equal(f.run('reviewed', { REVIEWS: JSON.stringify(reviews) }).outputs.reviews, [
    '评审者（a1 · high）：可以',
    '第二评审者（a2）：没评成。调用 review-commit 没有成功，原因见本运行 coda://workflow-runs/run-1 的「评审整条泳道」（workflow_status）。',
  ].join('\n\n') + `\n评审原文：${path}`);
  assert.ok(readFileSync(path, 'utf8').includes('原文'));
  f.land('two', 'second'); f.run('pr');
  assert.equal(f.run('reviewed', { REVIEWS: JSON.stringify(reviews) }).outputs.reviews, '', '泳道动了，旧的评审不带');
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

test('发布说明：勾选发布而备注为空交主 Agent 写，空说明不放行，非发布选择不要求', t => {
  const f = fixture(t); f.run('lane');
  for (const preview of [false, true]) for (const release of [false, true]) for (const note of ['', '  ', '修复输入问题']) {
    const { outputs } = f.run('approval', { APPROVAL: JSON.stringify({ choice: 'merge', options: { preview, release }, note }) });
    assert.equal(outputs.route, (preview || release) && !note.trim() ? 'notes' : 'merge');
  }
  for (const note of [undefined, '', '  ']) assert.deepEqual(f.run('notes', { NOTES: JSON.stringify({ note }) }).outputs, { route: 'notes', feedback: '请在备注填写面向用户的发布说明。', notes: note ?? '' });
  assert.deepEqual(f.run('notes', { NOTES: JSON.stringify({ note: '主 Agent 的发布说明' }) }).outputs, { route: 'ready', feedback: '', notes: '主 Agent 的发布说明' });
});

test('需求运行的定义：输入、进行中的三种答复、暂停卡、收尾各处失败回到进行中、整体评审、合并方式与部署发布', async () => {
  const { process, elements, nodes, values, params, route, next } = await definition();
  assert.equal(process.name, '监督开发'); assert.equal(process.kind, 'develop'); assert.equal(process.concurrency, undefined);
  const inputs = Object.fromEntries(values(process).map(v => [v.name, v]));
  assert.deepEqual(Object.keys(inputs), ['title', 'goal', 'devices', 'device', 'hold', 'delivery', 'reviewer', 'reviewer2', 'reviewer3', 'base']);
  assert.deepEqual(Object.values(inputs).filter(v => v.required), [], '用户在会话里开启时什么都不必填');
  for (const name of ['title', 'goal', 'device', 'delivery', 'base']) assert.equal(inputs[name].default, '', name);
  assert.deepEqual([inputs.devices.type, inputs.devices.default], ['boolean', 'false']);
  for (const name of ['reviewer', 'reviewer2', 'reviewer3']) assert.deepEqual([inputs[name].type, inputs[name].default, inputs[name].defaultFrom], ['agent', undefined, undefined], name);
  assert.equal(nodes.start.eventDefinitions, undefined, '不订阅 PR 事件');
  assert.ok(manifest.files.includes('.coda/workflows')); assert.ok(manifest.files.includes('scripts'));
  for (const [title, expected] of [['', '监督开发'], ['输入框', '需求：输入框']]) assert.equal(evaluate(process.title.slice(2, -2), { inputs: { title } }).value, expected);

  // 没有目标时先交主 Agent 写需求，不叫醒它。
  assert.equal(route('brief-choice', { inputs: { goal: '' } }), 'brief');
  assert.equal(route('brief-choice', { inputs: { goal: '目标' } }), 'lane');
  assert.deepEqual([nodes.brief.wake, nodes.brief.assignee], ['false', undefined]);
  assert.deepEqual(values(nodes.brief).map(v => [v.id, v.note]), [['start', 'required']]);
  for (const [value, target] of [['brief', 'brief'], ['lane', 'lane']]) assert.equal(route('after-brief', { 'brief-result': { route: value } }), target);
  for (const [field, written] of [['TITLE', 'title'], ['GOAL', 'goal']]) {
    const expression = params('lane')[field].slice(1);
    assert.equal(evaluate(expression, { inputs: { goal: '', title: '' }, 'brief-result': { [written]: '写的' } }).value, '写的');
    assert.equal(evaluate(expression, { inputs: { goal: '给的', title: '给的' } }).value, '给的');
  }

  // 进行中：交主 Agent，三种答复；每次进来都经过「整理回来的原因」。
  assert.equal(next('lane'), 'resume');
  assert.equal(next('resume'), 'progress');
  assert.equal(nodes.progress.assignee, undefined);
  assert.deepEqual(values(nodes.progress).map(v => [v.id, v.name, v.note]), [['submit', '提交验收', 'required'], ['pause', '暂停', 'required'], ['abandon', '放弃', undefined]]);
  for (const [value, target] of [['progress', 'progress'], ['pause', 'paused'], ['abandon', 'abandoned'], ['submit', 'pr']]) assert.equal(route('after-progress', { 'progress-result': { route: value } }), target);
  const doc = nodes.progress.documentation[0].text;
  for (const text of ['workflow_run 发起一个泳道 PR（lane-pr）', 'lane="{{run.id}}"', 'title', 'task', 'executor、executor2、reviewer、reviewer2（', '由你按这一块的性质逐个定',
    '可以同时发起', 'sync=true', '快进进泳道', 'mac-preview-install', 'kind=premerge', '{{lane.lane}}', '{{lane.goal}}']) assert.ok(doc.includes(text), text);
  assert.ok(!doc.includes('reviewerOnce'), '泳道 PR 没有只评第一次交付的位置');
  // 只填了第三整体评审者也算要整体评审：进行中的说明与批准卡都这样写。
  const reviewed = (text, needle) => [...text.matchAll(/{{(.*?)}}/gs)].find(m => m[1].includes('inputs.reviewer3') && m[1].includes(needle))[1];
  const nobody = { reviewer: null, reviewer2: null, reviewer3: null };
  for (const [text, needle, said] of [[doc, '整体评审一次', '整体评审一次，'], [nodes.approve.documentation[0].text, '整条泳道已整体评审', '，整条泳道已整体评审']]) {
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
  // 泳道 head 在检查的同时预编：只在随后会进设备验收时，不挡检查，失败也不算数。
  assert.deepEqual(elements.filter(e => e.sourceRef === nodes['pr-fork']).map(e => e.targetRef.id), ['reuse-checks', 'prebuild-choice']);
  for (const [devices, delivery, target] of [[true, '', 'prebuild'], [false, '', 'prebuilt'], [true, 'deliver-1', 'prebuilt']]) assert.equal(route('prebuild-choice', { inputs: { devices, delivery } }), target);
  assert.equal(params('prebuild').commit, '=pr.head');
  for (const device of ['', 'duo-testbed']) assert.deepEqual(evaluate(params('prebuild').inputs.slice(1), { inputs: { device } }).value, device ? { device } : {});
  for (const id of ['prebuild-done', 'prebuild-failed-done', 'prebuild-skip']) assert.equal(nodes[id].targetRef.id, 'prebuilt');
  assert.deepEqual(params('checks'), { kind: 'check', commit: '=pr.head' });
  assert.equal(next('checks'), 'checks-passed');
  assert.equal(next('checks-passed'), 'premerge');
  assert.deepEqual(params('premerge'), { kind: 'premerge', commit: '=pr.head' });
  assert.equal(next('premerge'), 'github-checks');
  assert.equal(next('github-checks'), 'reviews-choice');
  for (const [boundary, task, step] of [['checks-failed', 'checks-feedback', '项目检查'], ['premerge-failed', 'premerge-feedback', '合并前检查'], ['github-checks-failed', 'github-feedback', 'GitHub 检查']]) {
    assert.equal(nodes[boundary].eventDefinitions[0].$type, 'bpmn:ErrorEventDefinition');
    assert.equal(next(boundary), task);
    assert.deepEqual(params(task), { STEP: step });
    assert.equal(next(task), 'resume', `${step}失败回到进行中`);
  }
  // 整体评审：填了才评，对整条泳道评一次；发现交主 Agent。
  for (const [reviewer, reviewer2, reviewer3, target] of [[null, null, null, 'acceptance-choice'], [{ agent: 'a' }, null, null, 'reviews'], [null, { agent: 'b' }, null, 'reviews'], [null, null, { agent: 'c' }, 'reviews']]) {
    assert.equal(route('reviews-choice', { inputs: { reviewer, reviewer2, reviewer3 } }), target);
  }
  assert.equal(nodes.reviews.optional, true);
  assert.equal(nodes['review-call'].calledElement, 'review-commit');
  assert.deepEqual(params('review-call'), { base: '=pr.base', head: '=pr.head', task: '=pr.task', reviewer: '=slot.who', evidence: '=github-checks.evidence' });
  const slots = evaluate(nodes.reviews.loopCharacteristics.inputCollection.slice(1), { inputs: { reviewer: { agent: 'a' }, reviewer2: null, reviewer3: { agent: 'c' } } }).value;
  assert.deepEqual(slots, [{ slot: 'reviewer', who: { agent: 'a' } }, { slot: 'reviewer2', who: null }, { slot: 'reviewer3', who: { agent: 'c' } }]);
  assert.equal(nodes['review-failed'].attachedToRef.id, 'review-call');
  assert.equal(next('reviews'), 'reviewed');
  assert.equal(params('reviewed').REVIEWS, '=reviews');
  assert.equal(nodes.review.assignee, undefined);
  assert.deepEqual(values(nodes.review).map(v => [v.id, v.name]), [['continue', '继续验收'], ['progress', '回到进行中']]);
  // 卡上展开的是「整理整体评审」的输出，不是多实例子流程 reviews 的结果列表。
  const card = nodes.review.documentation[0].text, found = '评审者（a）：评审要求修改\n- [P1] 标题';
  const shown = card.replace(/\{\{([\s\S]*?)\}\}/g, (_, expression) => evaluate(expression, {
    lane: { title: '需求', base: 'main' }, pr: { url: 'https://github.com/o/r/pull/1', head: 'h1' }, reviews: [null, null], reviewed: { reviews: found },
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
  assert.equal(route('delivery-choice', { inputs: { delivery: '' } }), 'kinds');
  assert.equal(route('delivery-choice', { inputs: { delivery: 'deliver-1' } }), 'delivery');
  assert.deepEqual(values(nodes.delivery).map(v => [v.id, v.name]), [['revise', '退回修改'], ['merge', '放行合并']]);
  for (const [value, target] of [['delivery', 'delivery'], ['progress', 'resume'], ['merge', 'merge']]) assert.equal(route('after-delivery', { 'delivery-result': { route: value } }), target);
  assert.equal(next('kinds'), 'approve');
  assert.equal(nodes.approve.assignee, 'user');
  assert.deepEqual(values(nodes.approve).map(v => [v.id, v.note]), [['merge', undefined], ['stop', 'required']]);
  assert.match(nodes.approve.documentation[0].text, /合并提交/);
  for (const [value, target] of [['notes', 'write-notes'], ['stop', 'resume'], ['merge', 'merge']]) assert.equal(route('after-approval', { 'approval-result': { route: value } }), target);
  assert.equal(route('notes-route', { 'notes-result': { route: 'notes' } }), 'write-notes');
  assert.equal(route('notes-route', { 'notes-result': { route: 'ready' } }), 'merge');
  assert.equal(route('after-merge', { merge: { route: 'conflict' } }), 'resume');
  assert.equal(route('after-merge', { merge: { route: 'merged' } }), 'deploy-choice');
  assert.ok(!elements.some(e => e.id === 'stopped'), '暂不合并不再结束运行');

  for (const delivery of ['', 'deliver-1']) for (const deploy of [false, true]) for (const preview of [false, true]) for (const release of [false, true]) {
    const options = { deploy, preview, release }, called = [], context = { inputs: { delivery }, approve: { options } };
    for (let step = 'deploy-choice'; step !== 'done';) {
      if (nodes[step].action === 'run-workflows') called.push(params(step).kind);
      step = nodes[step].$type === 'bpmn:ExclusiveGateway' ? route(step, context) : next(step);
    }
    assert.deepEqual(called, delivery ? [] : ['deploy', 'preview', 'release'].filter(kind => options[kind]));
  }
  assert.deepEqual(params('deploy'), { kind: 'deploy', commit: '=merge.commit' });
  for (const id of ['publish-preview', 'publish-release']) {
    const notes = note => evaluate(params(id).inputs.slice(1), { 'approval-result': { route: note ? 'merge' : 'notes' }, 'notes-result': { notes: '主 Agent 写的' }, approve: { note } }).value.notes;
    assert.equal(notes('用户写的'), '用户写的'); assert.equal(notes(''), '主 Agent 写的');
  }
  assert.deepEqual(elements.filter(e => e.action === 'run-workflows').map(e => e.id), ['prebuild', 'checks', 'premerge', 'deploy', 'publish-preview', 'publish-release']);
  for (const context of [{ inputs: { delivery: '' }, approve: { options: { notify: false } } }, { inputs: { delivery: 'deliver-1' } }]) {
    assert.equal(evaluate(nodes.done.notify.slice(1), context).value, context.inputs.delivery ? true : false);
  }
  assert.deepEqual(values(nodes.done).map(v => v.name), ['pr', 'commit', 'notify']);
  // 流程只定位置，不写 Ultra 或模型的知识。
  assert.doesNotMatch(workflow, /ultra|codex|claude|kimi|grok|opencode|cursor|gpt|sonnet|opus|haiku|gemini/i);
  assert.doesNotMatch(workflow, /squash 合并/, '进目标分支用合并提交');
});
