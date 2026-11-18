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
import { evaluateTyped, typedOutputs } from './feel.mjs';

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
  // noCommit 时不提交。回答就是 answer。exit 是做完、给出回复后的退出码（失败但会话还在）；lost 时接回会话（--continue）直接失败、不给回复。
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
if (continued && task.lost) process.exit(1);
const session = continued ? value('--continue') : 'worker-' + calls.length, cwd = join(root, session);
const git = (...params) => execFileSync('git', params, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
if (!continued) execFileSync('git', ['worktree', 'add', '-q', '--detach', cwd, value('--commit')], { stdio: 'pipe' });
if (task.advance) git('push', '-q', 'origin', task.advance + ':refs/heads/req/run-1');
if (task.merge) { git('fetch', '-q', 'origin', task.merge); spawnSync('git', ['merge', '--no-commit', 'FETCH_HEAD'], { cwd }); }
if (!task.noCommit) { writeFileSync(join(cwd, task.file), task.text ?? task.answer); git('add', '-A'); git('commit', '-qm', task.subject ?? 'fix'); }
console.log(JSON.stringify({ session, branch: null, head: git('rev-parse', 'HEAD'), answer: task.answer }));
process.exit(task.exit ?? 0);
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
  // 一个块合进了需求分支：在需求分支上另提交一个；message 照块（piece）合入的提交写，带 Coda-Piece: <运行 ID>。
  const land = (file, text, message = `块 ${file}`) => {
    git('fetch', '-q', 'origin', state().branch); git('switch', '-q', '--detach', 'FETCH_HEAD');
    writeFileSync(join(work, file), text); git('add', file); git('commit', '-qm', message); git('push', '-q', 'origin', `HEAD:refs/heads/${state().branch}`);
    return git('rev-parse', 'HEAD');
  };
  const answer = (action, name, choice, note, extra = {}) => run(action, { [name]: JSON.stringify({ choice, note }), ...extra }).outputs;
  const progress = (choice, note) => { const { feedback, route } = answer('progress', 'PROGRESS', choice, note); return { feedback, route }; };
  // 「派一块」「跟上目标分支」的答复：全部输出（派块的标量）。fixer 是开工填没填执行者。
  const dispatch = (choice, note, fixer = true) => answer('progress', 'PROGRESS', choice, note, { FIXER: String(fixer) });
  const reason = () => run('resume').outputs.reason;
  // 目标分支前进：在 main 上另提交一个。
  const advanceMain = (file, text) => {
    git('fetch', '-q', 'origin', 'main'); git('switch', '-q', '--detach', 'FETCH_HEAD');
    writeFileSync(join(work, file), text); git('add', file); git('commit', '-qm', `main ${file}`); git('push', '-q', 'origin', 'HEAD:refs/heads/main');
    return git('rev-parse', 'HEAD');
  };
  const task = value => writeFileSync(join(root, 'agent-task'), JSON.stringify(value));
  const agentCalls = () => JSON.parse(readFileSync(join(root, 'agent-calls'), 'utf8'));
  return { root, work, origin, env, git, run, state, calls, remote, land, answer, progress, dispatch, reason, advanceMain, task, agentCalls };
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
    return (flows.find(e => e.conditionExpression && evaluateTyped(e.conditionExpression.body.trim().slice(1), context)) ?? node.default).targetRef.id;
  };
  const next = id => elements.find(e => e.$type === 'bpmn:SequenceFlow' && e.sourceRef === nodes[id]).targetRef.id;
  return { process, elements, nodes, values, params, route, next };
}

test('建需求分支：从目标分支最新提交建 req/<运行 ID> 并推送；远端已有同名需求分支时沿用，从头重跑不失败', t => {
  const f = fixture(t);
  const created = f.run('branch').outputs;
  assert.deepEqual(created, { title: '输入框', goal: '输入框可以输入', base: 'main', branch: 'req/run-1' });
  assert.equal(f.remote('req/run-1'), f.remote('main'));
  const landed = f.land('one', 'first piece');
  f.git('switch', '-q', 'main');
  writeFileSync(join(f.work, 'later'), 'later'); f.git('add', 'later'); f.git('commit', '-qm', 'main moved'); f.git('push', '-q', 'origin', 'main');
  assert.equal(f.run('branch').outputs.branch, 'req/run-1');
  assert.equal(f.remote('req/run-1'), landed, '沿用已有需求分支，不重建、不丢已合进去的块');
  f.run('branch', { BASE: 'main', GITHUB_RUN_ID: 'run-2' });
  assert.equal(f.remote('req/run-2'), f.remote('main'));
  assert.equal(f.calls().filter(c => c.args[0] === 'repo').length, 2, '有 base 不查默认分支');
});

test('用户开启时主 Agent 写的需求：第一行需求名，其后是目标与完成标准，缺一样回到同一张卡', t => {
  const f = fixture(t);
  const brief = note => f.run('brief', { BRIEF: JSON.stringify({ choice: 'start', note }) }).outputs;
  assert.deepEqual(brief('输入框\n\n## 目标\n能输入\n\n## 完成标准\n- 能输入'), { feedback: '', route: 'req', title: '输入框', goal: '## 目标\n能输入\n\n## 完成标准\n- 能输入' });
  for (const note of ['只有需求名', '', '  \n  ']) {
    const written = brief(note);
    assert.equal(written.route, 'brief');
    assert.match(written.feedback, /第一行写需求名，空一行后写目标与完成标准/);
  }
});

test('需求进行中：提交验收与暂停必须写备注，缺了回到同一张卡且保留回来的原因；放弃直接结束', t => {
  const f = fixture(t); f.run('branch');
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
  const f = fixture(t); f.run('branch');
  assert.deepEqual(f.answer('paused', 'PAUSED', 'continue'), { route: 'continue' });
  assert.equal(f.reason(), '用户在「需求已暂停」选了继续。');
  assert.deepEqual(f.answer('paused', 'PAUSED', 'continue', '后端已经上线了'), { route: 'continue' });
  assert.equal(f.reason(), '用户在「需求已暂停」选了继续。\n用户的话：\n后端已经上线了');
  assert.deepEqual(f.answer('paused', 'PAUSED', 'abandon'), { route: 'abandon' });
});

// 派块的参数照引擎读：答复的输出先把 "true"/"false" 变成布尔值，再读 callActivity 上的 FEEL（参数保留表达式的类型）。
const pieceInputs = async (outputs, inputs) => {
  const { params } = await definition();
  return Object.fromEntries(Object.entries(params('piece')).map(([name, value]) => [name, evaluate(value.slice(1), { inputs, req: { branch: 'req/run-1', base: 'main' }, 'progress-result': typedOutputs(outputs) }).value]));
};
// review-commit 的输出交给「记下整体评审结果」：发现按 level 分级。
const reviewed = (findings, extra = {}) => ({ DECISION: findings.some(f => f.level === 'must') ? 'REQUEST_CHANGES' : findings.length ? 'COMMENT' : 'APPROVE',
  FINDINGS: JSON.stringify(findings.map(f => ({ kind: 'correctness', location: '', detail: '', ...f }))), LINE: findings.some(f => f.level === 'must') ? '评审要求修改' : '评审通过', REPORT: '评审原文', ...extra });
const KICKOFF = { executor: { agent: 'codex', model: 'gpt-6.1-sol', options: { 'service-tier': 'priority' } }, executor2: { agent: 'claude-sdk' }, reviewer: { agent: 'kimi', effort: 'high' }, overallReviewer: { agent: 'grok' } };

test('派一块：第一行标题、其后任务书，人选默认取开工单的执行者、备用执行者与评审者（整体评审者不评块）', async t => {
  const f = fixture(t); f.run('branch');
  f.run('check-failed', { STEP: '项目检查' });
  const outputs = f.dispatch('piece', '修好登录跳转\n\n## 背景\n登录后停在空白页\n\n## 验收\n- 跳到首页');
  assert.deepEqual([outputs.route, outputs.feedback, outputs.title, outputs.task, outputs.sync], ['piece', '', '修好登录跳转', '## 背景\n登录后停在空白页\n\n## 验收\n- 跳到首页', 'false']);
  assert.equal(f.reason(), '', '派出去了，回来的原因已处理');
  assert.deepEqual(await pieceInputs(outputs, KICKOFF), { branch: 'req/run-1', base: 'main', title: '修好登录跳转', task: '## 背景\n登录后停在空白页\n\n## 验收\n- 跳到首页', sync: false,
    executor: KICKOFF.executor, executor2: KICKOFF.executor2, reviewer: KICKOFF.reviewer });
});

test('派一块：备注最前面换人的行覆盖开工值，「无」表示这一块不用，没写的照旧；开工值渲染出的行原样能读回', async t => {
  const f = fixture(t); f.run('branch');
  const note = '- 执行者：opencode，模型 big-1，强度 max，模式 build\n评审者: 无\n\n补测试\n给登录跳转补回归测试';
  const outputs = f.dispatch('piece', note);
  assert.deepEqual([outputs.route, outputs.title, outputs.task], ['piece', '补测试', '给登录跳转补回归测试']);
  assert.deepEqual(await pieceInputs(outputs, KICKOFF), { branch: 'req/run-1', base: 'main', title: '补测试', task: '给登录跳转补回归测试', sync: false,
    executor: { agent: 'opencode', model: 'big-1', effort: 'max', mode: 'build' }, executor2: KICKOFF.executor2, reviewer: null });
  // 开工值在「需求进行中」里写成同样的行：抄过来就是同一组人选（其他选项不在行里）。
  const { nodes } = await definition(), doc = nodes.progress.documentation[0].text;
  const rendered = doc.replace(/{{([\s\S]*?)}}/g, (_, e) => { const v = evaluate(e, { inputs: { ...KICKOFF, delivery: '', devices: false }, req: {}, resume: { reason: '' } }).value; return v ?? ''; });
  const lines = rendered.split('\n').filter(l => /^- (执行者|评审者)：/.test(l)).slice(0, 2);
  const back = await pieceInputs(f.dispatch('piece', `${lines.join('\n')}\n标题\n任务`), { executor: null, executor2: null, reviewer: null });
  assert.deepEqual([back.executor, back.reviewer], [{ agent: 'codex', model: 'gpt-6.1-sol' }, { agent: 'kimi', effort: 'high' }]);
  // 人选只有执行者、备用执行者、评审者三行：「第二评审者」不是换人的行，不派。
  assert.equal(f.dispatch('piece', '第二评审者：cursor\n标题\n任务').title, '第二评审者：cursor', '不认第二评审者');
});

test('派块的写法解析不了、开工没填执行者备注也没写：不派，带着原因回到需求进行中，回来的原因保留', t => {
  const f = fixture(t); f.run('branch');
  f.run('check-failed', { STEP: '合并前检查' });
  for (const [choice, note, fixer, why] of [
    ['piece', '', true, '第一行写这一块的标题，其后写任务书'],
    ['piece', '只有标题', true, '第一行写这一块的标题，其后写任务书'],
    ['piece', '执行者：codex\n', true, '第一行写这一块的标题，其后写任务书'],
    ['piece', '执行者：codex，温度 0.3\n标题\n任务', true, '「执行者」那一行的「温度 0.3」看不懂'],
    ['piece', '执行者：codex，模型 a，模型 b\n标题\n任务', true, '「执行者」那一行的「模型 b」看不懂'],
    ['piece', '执行者：无\n标题\n任务', true, '「执行者」那一行冒号后要先写 Agent ID'],
    ['piece', '评审者：Codex Big\n标题\n任务', true, '「评审者」那一行冒号后要先写 Agent ID'],
    ['piece', '评审者：kimi\n- 评审者：无\n标题\n任务', true, '「评审者」写了两次'],
    ['piece', '标题\n任务', false, '开工没填执行者'],
    ['sync', '', false, '开工没填执行者'],
  ]) {
    const outputs = f.dispatch(choice, note, fixer);
    assert.equal(outputs.route, 'progress', note);
    assert.ok(outputs.feedback.includes(why) && outputs.feedback.endsWith('这一块没有派出去。'), `${note}：${outputs.feedback}`);
    assert.equal(outputs.title, '', '不派');
  }
  assert.match(f.reason(), /合并前检查未通过/, '写法不对不清掉回来的原因');
  // 开工没填执行者时，备注里写了就能派。
  assert.equal(f.dispatch('piece', '执行者：codex\n标题\n任务', false).route, 'piece');
});

test('跟上目标分支：派 sync=true 的块，标题与任务固定，备注写了附在后面，最前面换人的行照样认', async t => {
  const f = fixture(t); f.run('branch');
  const plain = f.dispatch('sync');
  assert.deepEqual([plain.route, plain.feedback, plain.title, plain.sync], ['piece', '', '跟上 main', 'true']);
  assert.match(plain.task, /^把目标分支 main 最新的提交合并进需求分支 req\/run-1，让需求分支跟上它：解冲突，数据库迁移等版本号和目标分支撞号时顺延需求分支这边的/);
  const inputs = await pieceInputs(plain, KICKOFF);
  assert.deepEqual([inputs.sync, inputs.executor, inputs.reviewer], [true, KICKOFF.executor, KICKOFF.reviewer]);
  const noted = f.dispatch('sync', '执行者：claude-sdk\n注意 migrations 目录');
  assert.equal(noted.task, `${plain.task}\n\n注意 migrations 目录`);
  assert.deepEqual((await pieceInputs(noted, KICKOFF)).executor, { agent: 'claude-sdk' });
});

test('块结束回到需求进行中：合进了写上提交和块的运行；没正常结束（失败、取消、主 Agent 在块里放弃）带着原因、要先核实合入状态，需求运行不失败', t => {
  const f = fixture(t); f.run('branch');
  f.run('piece-landed', { TITLE: '修好登录跳转', COMMIT: 'c'.repeat(40), PIECE_RUN: 'piece-7' });
  const landed = f.reason();
  for (const part of ['块「修好登录跳转」已合进需求分支 req/run-1', `提交 ${'c'.repeat(40)}`, 'coda://workflow-runs/piece-7']) assert.ok(landed.includes(part), part);
  assert.equal(landed, `块「修好登录跳转」已合进需求分支 req/run-1：提交 ${'c'.repeat(40)}，运行 coda://workflow-runs/piece-7。`);
  f.dispatch('piece', '下一块\n任务');
  assert.equal(f.reason(), '', '下一块派出去就清掉');
  // 块已推进需求分支、随后删临时分支失败（piece.test.mjs「删临时分支失败」）：块失败，但不能说没合进、需求分支没动。
  f.land('next', 'next', '下一块\n\nCoda-Piece: piece-8');
  f.run('piece-failed', { TITLE: '下一块' });
  const lost = f.reason();
  for (const part of ['块「下一块」没有正常结束', '你在块里选了放弃', '可能已经合进需求分支 req/run-1', '合入状态待核实', 'Coda-Piece: <块运行 ID>', 'coda://workflow-runs/run-1', '「块」调用的块运行', '确认没合进才重新派这一块'])
    assert.ok(lost.includes(part), part);
  assert.doesNotMatch(lost, /需求分支没动|没有合进需求分支/);
});

test('提交验收开需求分支进目标分支的 PR：不带会话开，正文是汇报、从需求分支历史读的块与改动区域；再提交更新同一个 PR', t => {
  const f = fixture(t); f.run('branch');
  const first = f.land('one', 'first', '输入框可以输入\n\nCoda-Piece: piece-9');
  const head = f.land('two', 'second', '补齐状态\n\nCoda-Piece: piece-12');
  f.progress('submit', '汇报');
  const opened = f.run('pr').outputs;
  const summary = `汇报\n\n块：\n- ${first.slice(0, 12)} 输入框可以输入（coda://workflow-runs/piece-9）\n- ${head.slice(0, 12)} 补齐状态（coda://workflow-runs/piece-12）\n\n改动：2 个文件 +2 -0\n- 根目录：2 个文件 +2 -0`;
  assert.deepEqual(opened, { checked: 'false', url: PR, head, base: f.remote('main'), branch: 'req/run-1', summary,
    task: '需求：输入框\n\n目标与完成标准：\n输入框可以输入\n\n主 Agent 的汇报：\n汇报' });
  assert.ok(!f.calls().some(c => c.args[1] === 'list' && c.args.includes('merged')), '块不开 PR，不从 GitHub 找');
  const created = f.calls().filter(c => c.args[1] === 'create');
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].args.slice(0, 8), ['pr', 'create', '--base', 'main', '--head', 'req/run-1', '--title', '输入框']);
  assert.equal(created[0].thread, null, '不带会话开 PR，PR 观察不会因此启动 PR 生命流程');
  assert.equal(created[0].body, summary);
  // 从头重跑后运行暂存没了 PR：从 GitHub 找到开着的那个，只更新。
  const third = f.land('three', 'third');
  f.progress('submit', '新汇报');
  const updated = f.run('pr', { OPEN_PR: PR }).outputs;
  assert.equal(updated.url, PR);
  assert.equal(f.calls().filter(c => c.args[1] === 'create').length, 1);
  const edit = f.calls().find(c => c.args[1] === 'edit');
  assert.deepEqual(edit.args.slice(0, 3), ['pr', 'edit', PR]);
  assert.ok(edit.body.startsWith(`新汇报\n\n块：\n- ${first.slice(0, 12)} 输入框可以输入（coda://workflow-runs/piece-9）\n- ${head.slice(0, 12)} 补齐状态（coda://workflow-runs/piece-12）\n- ${third.slice(0, 12)} 块 three\n\n改动：3 个文件 +3 -0`), edit.body);
  assert.deepEqual(f.calls().find(c => c.args[1] === 'list' && c.args.includes('open')).args,
    ['pr', 'list', '--head', 'req/run-1', '--base', 'main', '--state', 'open', '--limit', '1', '--json', 'url', '--jq', '.[].url']);
});

test('块列表也列出在合并提交第二父链上的块：跟上目标分支的块开工后别的块先合入，它把需求分支合进自己再快进', t => {
  const f = fixture(t); f.run('branch');
  const start = f.remote('req/run-1');
  const other = f.land('b', 'b', '补齐状态\n\nCoda-Piece: piece-b');
  const main = f.advanceMain('m', 'm');
  // 跟上目标分支的块：从开工时的需求分支 head 合并目标分支，再把已前进的需求分支合进来，快进进需求分支。
  f.git('switch', '-q', '--detach', start); f.git('merge', '-q', '--no-ff', '--no-edit', main);
  const synced = f.git('rev-parse', 'HEAD');
  f.git('merge', '-q', '--no-edit', other); f.git('push', '-q', 'origin', 'HEAD:refs/heads/req/run-1');
  const head = f.git('rev-parse', 'HEAD');
  assert.deepEqual(parents(f, head), [synced, other], '别的块在第二父链上');
  f.progress('submit', '汇报');
  const summary = f.run('pr').outputs.summary;
  const list = summary.split('\n\n')[1].split('\n').slice(1);
  assert.ok(list.includes(`- ${other.slice(0, 12)} 补齐状态（coda://workflow-runs/piece-b）`), summary);
  assert.deepEqual(list.filter(line => !line.includes('piece-b')).map(line => line.slice(2, 14)), [synced.slice(0, 12), head.slice(0, 12)], 'first-parent 上没带标记的照列');
});

test('项目检查按需求分支 head 复用：同一 head 通过过就不再跑，需求分支动了就再跑', async t => {
  const { route } = await definition();
  const f = fixture(t); f.run('branch'); f.land('one', 'first'); f.progress('submit', '汇报');
  assert.equal(route('reuse-checks', { pr: f.run('pr').outputs }), 'checks');
  f.run('checks-passed', { RUNS: JSON.stringify([{ workflow: 'test', state: 'succeeded', runId: 'c1' }]) });
  assert.equal(route('reuse-checks', { pr: f.run('pr').outputs }), 'overall-plan');
  assert.equal(f.run('overall-plan', { REVIEWER: 'true' }).outputs.evidence, '项目检查：\ntest: succeeded coda://workflow-runs/c1', '整体评审时项目检查已有结论，交给评审者');
  f.land('two', 'second');
  assert.equal(route('reuse-checks', { pr: f.run('pr').outputs }), 'checks');
});

test('收尾的失败与「暂不合并」都带着原因回到需求进行中', t => {
  const f = fixture(t); f.run('branch'); f.land('one', 'first'); f.progress('submit', '汇报'); f.run('pr');
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
  f.run('overall-reviewed', reviewed([{ level: 'must', title: '登录后停在空白页', location: 'app.mjs:3' }]));
  assert.deepEqual(f.answer('review', 'REVIEW', 'progress', '先修登录'), { route: 'progress' });
  assert.equal(f.reason(), `整体评审后主 Agent 选了回到进行中。\n先修登录\n整体评审的结论：\n评审要求修改\n必须修 1 条：\n- 登录后停在空白页（app.mjs:3）\n小问题 0 条，原有问题 0 条。\n评审原文：${join(f.env.CODA_ARTIFACTS, 'overall-review-1.md')}`);
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
  const f = fixture(t); f.run('branch'); f.land('one', 'first'); f.progress('submit', '汇报'); f.run('pr');
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
  for (const part of ['合并冲突', '目标分支 main', '选「跟上目标分支」派一块', '再提交验收', '重新跑检查、批准合并及合并后的流程']) assert.ok(text.includes(part), part);
  for (const [mergeable, stderr] of [['UNKNOWN', 'network unavailable'], ['MERGEABLE', 'HTTP 403: Forbidden']]) {
    const result = f.run('merge', { MERGE_EXIT: '7', MERGE_STDERR: stderr, PR_MERGEABLE: mergeable }, 7);
    assert.equal(result.stderr, stderr);
    assert.deepEqual(result.outputs, {});
  }
});

// 提交验收到项目检查有了结论：答复「提交验收」（options 是勾选项），跟上目标分支，开或更新 PR，记下通过的检查。
const submitTo = (f, options = {}) => {
  f.run('progress', { PROGRESS: JSON.stringify({ choice: 'submit', note: '汇报', options }) });
  f.run('sync-base', { FIXER: 'true' });
  const pr = f.run('pr').outputs;
  if (pr.checked !== 'true') f.run('checks-passed', { RUNS: JSON.stringify([{ workflow: 'test', state: 'succeeded', runId: 'c1' }]) });
  return pr;
};

test('整体评审评不评：填了整体评审者、合进过不止一块（跟上目标分支的块、流程直推的不算）、这次运行还没评过才评；勾「重新整体评审」再评一次', t => {
  const f = fixture(t); f.run('branch');
  const plan = (reviewer = true) => f.run('overall-plan', { REVIEWER: String(reviewer) }).outputs;
  f.land('one', 'first', '块一\n\nCoda-Piece: piece-1');
  // 跟上目标分支的块是执行者的合并提交，不带 Coda-Piece；提交验收时流程直接推的合并提交同样不算。
  const main = f.advanceMain('m', 'main');
  f.git('fetch', '-q', 'origin', 'req/run-1'); f.git('switch', '-q', '--detach', 'FETCH_HEAD'); f.git('merge', '-q', '--no-ff', '--no-edit', main);
  f.git('push', '-q', 'origin', 'HEAD:refs/heads/req/run-1');
  f.advanceMain('n', 'main again');
  submitTo(f);
  assert.equal(f.state().pushed.length, 1, '提交验收时流程又推了一个合并提交');
  assert.deepEqual(plan(), { review: 'false', evidence: '项目检查：\ntest: succeeded coda://workflow-runs/c1' }, '只有一块：跳过');
  f.land('two', 'second', '块二\n\nCoda-Piece: piece-2');
  submitTo(f);
  assert.equal(f.state().landed, 2);
  assert.equal(plan(false).review, 'false', '没填整体评审者不评');
  assert.equal(plan().review, 'true', '两块、还没评过：评');
  // 没评成（调用没成、没评完）不算评过，下次提交验收照样评。
  f.run('overall-lost');
  submitTo(f);
  assert.equal(plan().review, 'true');
  f.run('overall-reviewed', reviewed([], { DECISION: 'INCOMPLETE', LINE: '评审没有完成：没有合格的 review 代码块', FINDINGS: '[]', REPORT: '' }));
  submitTo(f);
  assert.equal(plan().review, 'true');
  // 评过了：再提交验收不再评；勾「重新整体评审」这一次照常评，下一次又不评。
  f.run('overall-reviewed', reviewed([]));
  submitTo(f);
  assert.equal(plan().review, 'false', '评过之后不再评');
  submitTo(f, { again: true });
  assert.equal(plan().review, 'true', '勾了重新整体评审');
  submitTo(f);
  assert.equal(plan().review, 'false');
});

test('整理整体评审：没评或没有必须修往下走，小问题与原有问题写进 PR 描述和汇总；有必须修或没评成交主 Agent 一页结论；自动合并只看这次运行出没出过必须修', t => {
  const f = fixture(t); f.run('branch');
  f.land('one', 'first', '块一\n\nCoda-Piece: piece-1'); f.land('two', 'second', '块二\n\nCoda-Piece: piece-2');
  let pr = submitTo(f);
  const overall = (AUTO = 'true') => f.run('overall', { SUMMARY: pr.summary, AUTO }).outputs;
  const edits = () => f.calls().filter(c => c.args[1] === 'edit');
  const report = n => join(f.env.CODA_ARTIFACTS, `overall-review-${n}.md`);
  f.run('overall-plan', { REVIEWER: 'false' });
  const before = edits().length;
  assert.deepEqual(overall(), { route: 'accept', summary: pr.summary, auto: 'true', review: '', note: '' }, '没评：往下走，开了 autoMerge 就自动合并');
  assert.equal(overall('false').auto, 'false', '没开 autoMerge');
  assert.equal(edits().length, before, '没有要补的，不改 PR 描述');

  // 评了，只有小问题和原有问题：往下走，写进 PR 描述和汇总，照样自动合并。
  f.run('overall-plan', { REVIEWER: 'true' });
  f.run('overall-reviewed', reviewed([{ level: 'nit', title: '变量名', location: 'one:1', detail: '可以更短' }, { level: 'existing', title: '旧的重复', location: 'base:1' }]));
  assert.equal(readFileSync(report(1), 'utf8'), '评审原文');
  const tail = '整体评审的小问题（没有修）：\n- 变量名（one:1）\n  可以更短\n\n整体评审提到的原有问题（不是这个需求引入的）：\n- 旧的重复（base:1）';
  assert.deepEqual(overall(), { route: 'accept', summary: `${pr.summary}\n\n${tail}`, auto: 'true', note: '，整条需求分支已整体评审',
    review: `评审通过\n必须修 0 条。\n小问题 1 条，原有问题 1 条。\n评审原文：${report(1)}` });
  assert.deepEqual([edits().at(-1).args.slice(0, 3), edits().at(-1).body], [['pr', 'edit', PR], `${pr.summary}\n\n${tail}`]);

  // 再评一次，有必须修：交主 Agent，卡上必须修每条一句加位置，小问题、原有问题只给条数；自动合并关掉。
  pr = submitTo(f, { again: true });
  f.run('overall-plan', { REVIEWER: 'true' });
  f.run('overall-reviewed', reviewed([{ level: 'must', title: '登录后停在空白页', location: 'app.mjs:3', detail: '跳转写错' }, { level: 'must', title: '第二套缓存', location: 'cache.mjs:1' },
    { level: 'nit', title: '变量名', location: 'one:1' }]));
  const must = overall();
  assert.deepEqual([must.route, must.auto], ['review', 'false']);
  assert.equal(must.review, `评审要求修改\n必须修 2 条：\n- 登录后停在空白页（app.mjs:3）\n- 第二套缓存（cache.mjs:1）\n小问题 1 条，原有问题 0 条。\n评审原文：${report(2)}`);
  // 派块修好、再提交验收：不再评，往下走；这次运行出过必须修，照常出批准卡。小问题是在旧 head 上评的，写明。
  const old = f.state().head;
  f.land('three', 'fix', '修登录\n\nCoda-Piece: piece-3');
  pr = submitTo(f);
  assert.equal(f.run('overall-plan', { REVIEWER: 'true' }).outputs.review, 'false');
  const after = overall();
  assert.deepEqual([after.route, after.auto, after.review, after.note], ['accept', 'false', '', `，整条需求分支在 ${old.slice(0, 12)} 时整体评审过`]);
  assert.ok(after.summary.endsWith(`整体评审的小问题（没有修，评审时需求分支 head ${old.slice(0, 12)}）：\n- 变量名（one:1）`), after.summary);

  // 没评成：调用没成、没评完都交主 Agent，写明原因。
  pr = submitTo(f, { again: true });
  f.run('overall-plan', { REVIEWER: 'true' });
  f.run('overall-lost');
  const lost = overall();
  assert.deepEqual([lost.route, lost.review], ['review', '没评成：调用 review-commit 没有成功，原因见本运行 coda://workflow-runs/run-1 的「评审整条需求分支」（workflow_status）。']);
  pr = submitTo(f, { again: true });
  f.run('overall-plan', { REVIEWER: 'true' });
  f.run('overall-reviewed', reviewed([], { DECISION: 'INCOMPLETE', LINE: '评审没有完成：评审方没有按格式给出结论', FINDINGS: '[]', REPORT: '' }));
  assert.deepEqual([overall().route, overall().review], ['review', '没评成：评审没有完成：评审方没有按格式给出结论']);
});

test('PR 汇总按 .coda/areas.json 最长前缀归区域，未声明走顶层目录，改名按新路径，二进制只计文件', t => {
  const f = fixture(t);
  const write = (path, text) => { mkdirSync(join(f.work, path, '..'), { recursive: true }); writeFileSync(join(f.work, path), text); };
  const lines = n => 'line\n'.repeat(n);
  write('old/Big.swift', 'big\nbody\n'); f.git('add', '-A'); f.git('commit', '-qm', 'big'); f.git('push', '-q', 'origin', 'main');
  f.run('branch'); f.progress('submit', '汇报');
  f.git('fetch', '-q', 'origin', 'req/run-1'); f.git('switch', '-q', '--detach', 'FETCH_HEAD');
  write('.coda/areas.json', '{ "iPhone 客户端": ["iOS/"], "共享": ["iOS/Shared/", "AGENTS.md"] }\n');
  write('iOS/App.swift', lines(5)); write('iOS/Shared/Model.swift', lines(6)); write('AGENTS.md', lines(1));
  write('Sources/Core.swift', lines(8)); write('notes.txt', lines(2)); write('img.png', Buffer.from([0, 1, 2, 0]));
  f.git('mv', 'old/Big.swift', 'iOS/Big.swift'); f.git('rm', '-q', 'base');
  const changes = () => {
    f.git('add', '-A'); f.git('commit', '-qm', 'change'); f.git('push', '-q', 'origin', 'HEAD:refs/heads/req/run-1');
    return f.run('pr').outputs.summary.split('\n\n').at(-1);
  };
  assert.equal(changes(), ['改动：9 个文件 +23 -1',
    '- Sources：1 个文件 +8 -0', '- 共享：2 个文件 +7 -0', '- iPhone 客户端：2 个文件 +5 -0', '- 根目录：3 个文件 +2 -1', '- .coda：1 个文件 +1 -0'].join('\n'));
  f.git('rm', '-q', '.coda/areas.json');
  assert.equal(changes(), ['改动：8 个文件 +22 -1', '- iOS：3 个文件 +11 -0', '- Sources：1 个文件 +8 -0', '- 根目录：4 个文件 +3 -1'].join('\n'));
  write('.coda/areas.json', '{ "iOS": ');
  f.git('add', '-A'); f.git('commit', '-qm', 'broken'); f.git('push', '-q', 'origin', 'HEAD:refs/heads/req/run-1');
  assert.match(f.run('pr', {}, 1).stderr, /JSON/);
});

test('GitHub 检查等待全部完成，检查失败和查询错误保持失败并留下日志', t => {
  const f = fixture(t); f.run('branch'); f.land('one', 'first'); f.progress('submit', '汇报'); f.run('pr');
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
  const f = fixture(t); f.run('branch');
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
  const f = fixture(t); f.run('branch');
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
  assert.deepEqual(Object.keys(inputs), ['title', 'devices', 'device', 'hold', 'delivery', 'executor', 'executor2', 'reviewer', 'overallReviewer', 'autoMerge', 'base']);
  assert.deepEqual(Object.values(inputs).filter(v => v.required), [], '用户在会话里开启时什么都不必填');
  for (const name of ['title', 'device', 'delivery', 'base']) assert.equal(inputs[name].default, '', name);
  for (const name of ['devices', 'autoMerge']) assert.deepEqual([inputs[name].type, inputs[name].default], ['boolean', 'false'], name);
  for (const name of ['executor', 'executor2', 'reviewer', 'overallReviewer']) assert.deepEqual([inputs[name].type, inputs[name].default, inputs[name].defaultFrom], ['agent', undefined, undefined], name);
  assert.equal(nodes.start.eventDefinitions, undefined, '不订阅 PR 事件');
  assert.ok(manifest.files.includes('.coda/workflows')); assert.ok(manifest.files.includes('scripts'));
  for (const [title, expected] of [['', '监督开发'], ['输入框', '需求：输入框']]) assert.equal(evaluate(process.title.slice(2, -2), { inputs: { title } }).value, expected);

  // 目标是发起时带的需求文字（run.message）；需求名和它缺一样就先交主 Agent 写需求，不叫醒它。
  for (const [title, message, target] of [['', '', 'brief'], ['输入框', '', 'brief'], ['', '能输入', 'brief'], ['输入框', '能输入', 'req']]) {
    assert.equal(route('brief-choice', { inputs: { title }, run: { message } }), target, `${title}|${message}`);
  }
  const briefed = [...nodes.brief.documentation[0].text.matchAll(/{{(.*?)}}/gs)].find(m => m[1].includes('run.message'))[1];
  assert.equal(evaluate(briefed, { run: { message: '' } }).value, '');
  assert.equal(evaluate(briefed, { run: { message: '能输入' } }).value, '发起时带的需求：\n能输入\n');
  assert.deepEqual([nodes.brief.wake, nodes.brief.assignee], ['false', undefined]);
  assert.deepEqual(values(nodes.brief).map(v => [v.id, v.note]), [['start', 'required']]);
  for (const [value, target] of [['brief', 'brief'], ['req', 'req']]) assert.equal(route('after-brief', { 'brief-result': { route: value } }), target);
  for (const [field, written] of [['TITLE', 'title'], ['GOAL', 'goal']]) {
    const expression = params('req')[field].slice(1);
    for (const [title, message] of [['', ''], ['输入框', ''], ['', '能输入']]) {
      assert.equal(evaluate(expression, { inputs: { title }, run: { message }, 'brief-result': { [written]: '写的' } }).value, '写的', `${field} ${title}|${message}`);
    }
    assert.equal(evaluate(expression, { inputs: { title: '输入框' }, run: { message: '能输入' } }).value, field === 'TITLE' ? '输入框' : '能输入');
  }

  // 进行中：交主 Agent，五种答复；每次进来都经过「整理回来的原因」。
  assert.equal(next('req'), 'resume');
  assert.equal(next('resume'), 'progress');
  assert.equal(nodes.progress.assignee, undefined);
  assert.deepEqual(values(nodes.progress).map(v => [v.id, v.name, v.note]), [['submit', '提交验收', 'required'], ['piece', '派一块', 'required'], ['sync', '跟上目标分支', undefined], ['pause', '暂停', 'required'], ['abandon', '放弃', undefined]]);
  for (const [value, target] of [['progress', 'progress'], ['piece', 'piece'], ['pause', 'paused'], ['abandon', 'abandoned-flows'], ['submit', 'sync']]) assert.equal(route('after-progress', { 'progress-result': { route: value } }), target);
  // 「提交验收」带勾选项「重新整体评审」：默认不勾，只在填了整体评审者时给出。
  assert.deepEqual(values(nodes.progress)[0].options.map(o => [o.id, o.name, o.default, o.shown]), [['again', '重新整体评审', 'false', '=inputs.overallReviewer != null']]);
  const doc = nodes.progress.documentation[0].text;
  for (const text of ['「派一块」：备注第一行是这一块的标题', '其后是自足的任务书（背景、范围、验收要求）', '块里的任务交到这个会话', '写着合入的提交和块的运行', '块失败或你在块里选了放弃，也带着原因回到这里',
    '「跟上目标分支」', '以合并提交快进进需求分支', '写了附在固定任务后面', '一次只派一块：派出后等它结束才回到这里', '在备注最前面', '有执行者名单就从名单选',
    '「模型 …」「强度 …」「模式 …」', '写「无」表示这一块不用', '写法看不懂', 'mac-preview-install', '加入挂点 premerge 的流程', '{{req.branch}}', '{{req.goal}}',
    '取舍标准：只有必须修才派块修；评审者说成立不等于现在要修。', '测试是红的或会偶发失败', '会扩散、越晚越难改的结构问题（跨模块或会被照着写', '修复块只修那一条，不顺手带小问题，不加设计改动，不把以后的需求提前做进来。']) assert.ok(doc.includes(text), text);
  assert.doesNotMatch(doc, /workflow_run 发起一个块|值是 JSON|可以同时发起|sync=true/, '不再让主 Agent 自己发起块、抄开工 JSON');
  // 开工人选照引擎渲染成备注的写法，没填的写「没填」。
  const render = (text, context) => text.replace(/{{([\s\S]*?)}}/g, (_, e) => { const v = evaluate(e, context).value; return v === null || v === undefined ? '' : String(v); });
  const line = (text, head) => text.split('\n').find(l => l.startsWith(head));
  const chosen = { agent: 'codex', model: 'gpt-6.1-sol', effort: 'ultra', options: { 'service-tier': 'priority' } }, backup = { agent: 'claude-sdk', mode: 'plan' };
  const people = { reviewer: { agent: 'kimi' }, overallReviewer: { agent: 'grok' }, delivery: '', devices: false };
  const filled = render(doc, { inputs: { ...people, executor: chosen, executor2: backup }, run: { id: 'run-1' }, req: {}, resume: { reason: '' } });
  assert.equal(line(filled, '- 执行者：'), '- 执行者：codex，模型 gpt-6.1-sol，强度 ultra');
  assert.equal(line(filled, '- 备用执行者：'), '- 备用执行者：claude-sdk，模式 plan');
  assert.equal(line(filled, '- 评审者：'), '- 评审者：kimi');
  const section = filled.slice(filled.indexOf('块的人选默认用开工时填的：'), filled.indexOf('难的或性质不同的块要换人'));
  assert.deepEqual(section.split('\n').slice(1).filter(Boolean).map(l => l.split('：')[0]), ['- 执行者', '- 备用执行者', '- 评审者'], '人选只列这三行，整体评审者不在其中');
  const empty = render(doc, { inputs: { ...people, executor: null, executor2: null, reviewer: null }, run: { id: 'run-1' }, req: {}, resume: { reason: '' } });
  assert.equal(line(empty, '- 执行者：'), '- 执行者：没填');
  assert.equal(line(empty, '- 评审者：'), '- 评审者：没填');

  // 派块：callActivity 调 piece（本运行的子运行），需求分支与目标分支来自建需求分支，标题、任务、是否跟上目标分支来自答复；
  // 合进了记下提交与块的运行，出错边界（含主 Agent 在块里放弃）带着原因，都回到进行中。
  assert.equal(nodes.piece.$type, 'bpmn:CallActivity');
  assert.equal(nodes.piece.calledElement, 'piece');
  const call = params('piece');
  assert.deepEqual(Object.keys(call), ['branch', 'base', 'title', 'task', 'sync', 'executor', 'executor2', 'reviewer'], '参数正是块的输入，不再传已删的 reviewer2、autoLandMinor');
  const { root: pieceRoot } = await readWorkflow(readFileSync(new URL('../../../plugins/composer/.coda/workflows/piece.bpmn', import.meta.url), 'utf8'), 'piece');
  const pieceProcess = pieceRoot.rootElements.find(e => e.$type === 'bpmn:Process');
  assert.deepEqual(Object.keys(call), pieceProcess.extensionElements.values.filter(v => v.$type === 'coda:Input').map(v => v.name), '与块声明的输入一一对应');
  assert.deepEqual([call.branch, call.base, call.title, call.task, call.sync], ['=req.branch', '=req.base', '=progress-result.title', '=progress-result.task', '=progress-result.sync']);
  assert.equal(nodes['piece-failed'].attachedToRef.id, 'piece');
  assert.equal(nodes['piece-failed'].eventDefinitions[0].$type, 'bpmn:ErrorEventDefinition');
  assert.equal(next('piece-failed'), 'piece-lost');
  assert.equal(next('piece-lost'), 'resume', '块失败回到进行中，需求运行不失败');
  assert.equal(next('piece'), 'piece-landed');
  assert.equal(next('piece-landed'), 'resume');
  assert.deepEqual(params('piece-landed'), { TITLE: '=progress-result.title', COMMIT: '=piece.commit', PIECE_RUN: '=piece.run' });
  assert.deepEqual(params('progress-result').FIXER, '=inputs.executor != null');
  // 填了整体评审者，提交验收的说明里写怎么评；批准卡写评没评过的是「整理整体评审」的 note。
  const overallSaid = [...doc.matchAll(/{{(.*?)}}/gs)].find(m => m[1].includes('inputs.overallReviewer'))[1];
  assert.equal(evaluate(overallSaid, { inputs: { overallReviewer: null } }).value, '');
  assert.equal(evaluate(overallSaid, { inputs: { overallReviewer: { agent: 'c' } } }).value, '需求分支上合进过不止一块、这次运行还没整体评审过时由整体评审者评一次整条需求分支（勾「重新整体评审」就当没评过），有必须修或没评成时交你看结论，');
  const reasonLine = [...doc.matchAll(/{{(.*?)}}/gs)].find(m => m[1].includes('resume.reason'))[1];
  assert.equal(evaluate(reasonLine, { resume: { reason: '' } }).value, '');
  assert.equal(evaluate(reasonLine, { resume: { reason: '合并前检查未通过' } }).value, '回到进行中的原因：\n合并前检查未通过\n');
  // 收尾按是否归属需求交付分段写：成员运行没有用户的批准卡和「暂不合并」。
  const ending = [...doc.matchAll(/{{(.*?)}}/gs)].find(m => m[1].includes('inputs.delivery'))[1];
  const own = evaluate(ending, { inputs: { delivery: '', devices: true } }).value, member = evaluate(ending, { inputs: { delivery: 'deliver-1', devices: true } }).value;
  assert.equal(own, '再交用户设备验收，然后跑合并前检查与 GitHub 检查，通过后由用户批准合并（合并提交）。任何失败和用户的「暂不合并」都带着原因回到这里。');
  assert.equal(evaluate(ending, { inputs: { delivery: '', devices: false } }).value, '然后跑合并前检查与 GitHub 检查，通过后由用户批准合并（合并提交）。任何失败和用户的「暂不合并」都带着原因回到这里。');
  assert.equal(evaluate(ending, { inputs: { delivery: '', devices: false, autoMerge: true } }).value,
    '然后跑合并前检查与 GitHub 检查，通过后直接合并（合并提交；这次运行的整体评审出过必须修时照常由用户批准）。任何失败和用户的「暂不合并」都带着原因回到这里。', '自动合并不看填没填整体评审者');
  assert.equal(member, '然后跑合并前检查与 GitHub 检查，通过后进入「待交付」，由需求交付运行 deliver-1 统一验收、批准，没有用户的「暂不合并」。任何失败和待交付的「退回修改」都带着原因回到这里。');
  assert.equal(nodes.paused.assignee, 'user');
  assert.deepEqual(values(nodes.paused).map(v => [v.id, v.name]), [['continue', '继续'], ['abandon', '放弃']]);
  assert.match(nodes.paused.documentation[0].text, /\{\{progress\.note\}\}/);
  assert.equal(route('after-paused', { 'paused-result': { route: 'continue' } }), 'resume');
  // 两条放弃路径都先运行加入挂点 abandoned 的流程，再到结束：不写 only、commit，不挂出错边界；只传 run 和 branch。
  assert.equal(route('after-paused', { 'paused-result': { route: 'abandon' } }), 'abandoned-flows');
  assert.equal(nodes['abandoned-flows'].action, 'run-workflows');
  assert.deepEqual(Object.keys(params('abandoned-flows')).sort(), ['hook', 'inputs']);
  assert.equal(params('abandoned-flows').hook, 'abandoned');
  assert.ok(!elements.some(e => e.attachedToRef === nodes['abandoned-flows']), '失败就让运行失败');
  assert.equal(next('abandoned-flows'), 'abandoned');
  assert.equal(nodes.abandoned.$type, 'bpmn:EndEvent');
  assert.equal(elements.filter(e => e.targetRef === nodes.abandoned).length, 1, '只有 abandoned-flows 能到结束');
  // 函数名写错 workflow_check 也能过，所以实际求值一次：得到 {run, branch}。
  assert.deepEqual(evaluate(params('abandoned-flows').inputs.slice(1), { run: { id: 'run-1' }, req: { branch: 'req/abc' } }).value, { run: 'run-1', branch: 'req/abc' });

  // 收尾：PR → 项目检查（复用）→ 整体评审 → 设备验收 → 合并前检查 → GitHub 检查 → 待交付、批准或自动合并（顺序见「提交验收的顺序」那个用例）。
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
  assert.equal(next('checks-passed'), 'overall-plan');
  assert.deepEqual(params('premerge'), { hook: 'premerge', commit: '=pr.head' });
  assert.equal(next('premerge'), 'github-checks');
  assert.equal(next('github-checks'), 'delivery-choice');
  for (const [boundary, task, step] of [['checks-failed', 'checks-feedback', '项目检查'], ['premerge-failed', 'premerge-feedback', '合并前检查'], ['github-checks-failed', 'github-feedback', 'GitHub 检查']]) {
    assert.equal(nodes[boundary].eventDefinitions[0].$type, 'bpmn:ErrorEventDefinition');
    assert.equal(next(boundary), task);
    assert.deepEqual(params(task), { STEP: step });
    assert.equal(next(task), 'resume', `${step}失败回到进行中`);
  }
  // 整体评审：「定整体评审」说评才调一次 review-commit（一位整体评审者，评整条需求分支，不增量复评）；评不评、评没评成都经过「整理整体评审」。
  assert.deepEqual(params('overall-plan'), { REVIEWER: '=inputs.overallReviewer != null', review: undefined, evidence: undefined });
  assert.equal(next('overall-plan'), 'overall-choice');
  for (const [review, target] of [[true, 'overall-call'], [false, 'overall']]) assert.equal(route('overall-choice', { 'overall-plan': { review } }), target);
  assert.equal(nodes['overall-call'].calledElement, 'review-commit');
  assert.deepEqual(params('overall-call'), { base: '=pr.base', head: '=pr.head', task: '=pr.task', reviewer: '=inputs.overallReviewer', evidence: '=overall-plan.evidence' });
  assert.equal(nodes['overall-failed'].attachedToRef.id, 'overall-call');
  assert.deepEqual([next('overall-failed'), next('overall-lost'), next('overall-call'), next('overall-reviewed')], ['overall-lost', 'overall', 'overall-reviewed', 'overall']);
  assert.deepEqual(params('overall-reviewed'), { DECISION: '=overall-call.decision', FINDINGS: '=overall-call.findings', LINE: '=overall-call.line', REPORT: '=overall-call.report' });
  assert.deepEqual(params('overall'), { SUMMARY: '=pr.summary', AUTO: '=inputs.autoMerge', route: undefined, summary: undefined, auto: undefined, review: undefined, note: undefined });
  for (const [value, target] of [['review', 'review'], ['accept', 'acceptance-choice']]) assert.equal(route('overall-route', { overall: { route: value } }), target);
  for (const id of ['overall-round', 'reviews', 'overall-triage', 'overall-fix', 'overall-rounds', 'reviewed']) assert.ok(!nodes[id], `${id} 已删`);
  assert.equal(nodes.review.assignee, undefined);
  assert.deepEqual(values(nodes.review).map(v => [v.id, v.name]), [['continue', '继续验收'], ['progress', '回到进行中']]);
  assert.equal(route('after-review', { 'review-result': { route: 'progress' } }), 'resume');
  assert.equal(route('after-review', { 'review-result': { route: 'continue' } }), 'acceptance-choice');
  for (const [devices, delivery, target] of [[true, '', 'acceptance'], [false, '', 'premerge'], [true, 'deliver-1', 'premerge']]) {
    assert.equal(route('acceptance-choice', { inputs: { devices, delivery } }), target);
  }
  assert.equal(route('acceptance-route', { acceptance: { route: 'return' } }), 'resume');
  assert.equal(route('acceptance-route', { acceptance: { route: 'passed' } }), 'tell-device');
  const tell = (field, extra = {}) => evaluate(params('tell-device')[field].slice(1), { req: { title: '输入框' }, run: { id: 'run-1' }, pr: { head: 'head-1' }, inputs: { delivery: '' }, ...extra }).value;
  // 按之后的实际去向说：先跑合并前检查与 GitHub 检查，之后归属需求交付的进交付验收，自动合并（overall.auto）的直接合并，其余等用户批准合并。
  assert.equal(tell('text', { overall: { auto: false } }), '需求「输入框」：用户设备验收通过，接下来跑合并前检查与 GitHub 检查，通过后等用户批准合并。');
  assert.equal(tell('text', { overall: { auto: true } }), '需求「输入框」：用户设备验收通过，接下来跑合并前检查与 GitHub 检查，通过后流程自动合并。');
  assert.equal(tell('text', { inputs: { delivery: 'deliver-1' }, overall: { auto: true } }), '需求「输入框」：用户设备验收通过，接下来跑合并前检查与 GitHub 检查，通过后进入需求交付验收。');
  assert.equal(tell('key'), 'run-1:device:head-1');
  assert.equal(next('tell-device'), 'premerge');
  assert.equal(route('delivery-choice', { inputs: { delivery: '' } }), 'auto-merge-choice');
  assert.equal(route('auto-merge-choice', { inputs: { delivery: '' } }), 'joiners');
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
  for (const text of ['{{pr.url}}', '项目检查、合并前检查、GitHub 检查已通过{{overall.note}}。']) assert.ok(face.includes(text), text);
  // 汇总：「整理整体评审」每次都经过，用它的（评过有小问题、原有问题时带上）。
  for (const card of [face, nodes.delivery.documentation[0].text]) assert.deepEqual([...card.matchAll(/{{(.*?)}}/g)].map(m => m[1]).filter(e => e.includes('summary')), ['overall.summary']);
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
  assert.deepEqual(elements.filter(e => e.action === 'run-workflows').map(e => e.id), ['abandoned-flows', 'prebuild', 'checks', 'premerge', 'run-merged']);
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
  const f = fixture(t); f.run('branch'); f.progress('submit', '汇报');
  const sync = (extra = {}) => f.run('sync-base', { FIXER: 'true', ...extra }).outputs.route;
  assert.equal(sync(), 'pr');
  assert.equal(f.remote('req/run-1'), f.remote('main'), '刚建的需求分支就是目标分支');
  const landed = f.land('one', 'first');
  assert.equal(sync(), 'pr');
  assert.equal(f.remote('req/run-1'), landed, '已包含：不动');

  const f2 = fixture(t); f2.run('branch'); f2.progress('submit', '汇报');
  const main = f2.advanceMain('two', 'main moved');
  assert.equal(f2.run('sync-base', { FIXER: 'false' }).outputs.route, 'pr');
  assert.equal(f2.remote('req/run-1'), main, '快进到目标分支');
  assert.equal(f2.state().pushed, undefined, '快进没有流程自己做的提交');

  const landedHead = f.land('three', '块'), base = f.advanceMain('four', 'main');
  assert.equal(sync({ FIXER: 'false' }), 'pr', '干净合并不需要执行者');
  const merged = f.remote('req/run-1');
  assert.deepEqual(parents(f, merged), [landedHead, base], '需求分支在前、目标分支在后');
  assert.equal(f.git('show', '-s', '--format=%s', merged), '合并 main 到 req/run-1');
  assert.equal(f.git('ls-tree', '--name-only', merged).split('\n').sort().join(','), 'base,four,one,three');
  assert.deepEqual(f.state().pushed, [{ commit: merged, subject: '合并 main 到 req/run-1', why: '跟上 main' }]);
  const summary = f.run('pr').outputs.summary;
  assert.ok(summary.includes(`块：\n- ${landed.slice(0, 12)} 块 one\n- ${landedHead.slice(0, 12)} 块 three\n\n流程直接推到需求分支的提交：\n- ${merged.slice(0, 12)} 合并 main 到 req/run-1（跟上 main）\n\n改动：`), summary);
  assert.equal(f.state().head, merged, '之后的检查跑在新 head 上');
});

test('从头重跑 branch：保留流程直推的记录，之后的汇总仍把它们列在「流程直接推到需求分支的提交」里，不列成块', t => {
  const f = fixture(t); f.run('branch'); f.progress('submit', '汇报');
  const landed = f.land('one', 'first'), base = f.advanceMain('two', 'main');
  assert.equal(f.run('sync-base', { FIXER: 'false' }).outputs.route, 'pr');
  const merged = f.remote('req/run-1'), pushed = f.state().pushed;
  assert.equal(pushed.length, 1);
  f.run('branch');
  assert.deepEqual(f.state().pushed, pushed, '重跑不丢记录');
  assert.equal(f.state().feedback, '', '其余照旧重置');
  const summary = f.run('pr').outputs.summary;
  assert.ok(summary.includes(`块：\n- ${landed.slice(0, 12)} 块 one\n\n流程直接推到需求分支的提交：\n- ${merged.slice(0, 12)} 合并 main 到 req/run-1（跟上 main）\n\n改动：`), summary);
});

test('跟上目标分支有冲突：没填执行者带着冲突文件回到进行中；填了就交执行者从需求分支 head 合并，两端都包含才推送', t => {
  const f = fixture(t); f.run('branch'); f.progress('submit', '汇报');
  const landedHead = f.land('shared', '块 side'), base = f.advanceMain('shared', 'main side');
  assert.equal(f.run('sync-base', { FIXER: 'false' }).outputs.route, 'progress');
  const text = f.reason();
  for (const part of ['有冲突', '- shared', '没填开工执行者', '选「跟上目标分支」派一块（备注最前面写执行者）']) assert.ok(text.includes(part), part);
  assert.equal(f.remote('req/run-1'), landedHead, '需求分支不动');

  f.progress('submit', '汇报');
  assert.equal(f.run('sync-base', { FIXER: 'true' }).outputs.route, 'resolve');
  f.task({ merge: 'main', file: 'shared', text: 'both', answer: '解好了', subject: '合并 main' });
  assert.equal(f.run('sync-resolve', { EXECUTOR: JSON.stringify({ agent: 'codex', model: 'm1' }) }).outputs.route, 'pr');
  const call = f.agentCalls()[0], resolved = f.remote('req/run-1');
  assert.deepEqual(call.args.slice(0, 8), ['--commit', landedHead, '--title', '输入框：跟上 main', '--agent', 'codex', '--model', 'm1']);
  for (const part of ['不再委派', '- shared', `git merge ${base}`, '不要变基', '顺延需求分支这边的']) assert.ok(call.prompt.includes(part), part);
  assert.deepEqual(parents(f, resolved), [landedHead, base]);
  assert.deepEqual(f.state().pushed.map(p => [p.commit, p.why]), [[resolved, '跟上 main，执行者解冲突']]);

  // 执行者没有把目标分支合并进来：不推送，回到进行中。
  const f2 = fixture(t); f2.run('branch'); f2.progress('submit', '汇报');
  const landed2 = f2.land('shared', '块 side'); f2.advanceMain('shared', 'main side');
  f2.run('sync-base', { FIXER: 'true' });
  f2.task({ file: 'other', answer: '没合' });
  assert.equal(f2.run('sync-resolve', { EXECUTOR: JSON.stringify({ agent: 'codex' }) }).outputs.route, 'progress');
  assert.match(f2.reason(), /执行者没有把 main .* 合并进需求分支[\s\S]*没合/);
  assert.equal(f2.remote('req/run-1'), landed2);
});

test('流程推需求分支被拒（需求分支被别人推进了）：不重试、不覆盖，带着原因回到进行中；需求分支没动的推送失败保留退出码', t => {
  const f = fixture(t); f.run('branch'); f.progress('submit', '汇报');
  const landedHead = f.land('shared', '块 side'); f.advanceMain('shared', 'main side');
  f.run('sync-base', { FIXER: 'true' });
  // 别人推进了需求分支：执行者解冲突期间需求分支前进一个提交。
  f.git('switch', '-q', '--detach', landedHead); writeFileSync(join(f.work, 'other'), 'other'); f.git('add', 'other'); f.git('commit', '-qm', 'other');
  const other = f.git('rev-parse', 'HEAD');
  f.task({ advance: other, merge: 'main', file: 'shared', text: 'both', answer: '解好了' });
  assert.equal(f.run('sync-resolve', { EXECUTOR: JSON.stringify({ agent: 'codex' }) }).outputs.route, 'progress');
  assert.equal(f.remote('req/run-1'), other, '别人的提交还在');
  for (const part of ['被拒', `需求分支已不是 ${landedHead}`, '流程没有覆盖', '重新提交验收']) assert.ok(f.reason().includes(part), part);
  assert.equal(f.state().pushed, undefined);

  // 服务端拒收、需求分支没动：不是被推进了，保留原退出码。
  const f2 = fixture(t); f2.run('branch'); f2.progress('submit', '汇报');
  f2.land('one', '块'); f2.advanceMain('two', 'main');
  const hook = join(f2.origin, 'hooks', 'pre-receive');
  writeFileSync(hook, '#!/bin/sh\nexit 1\n'); chmodSync(hook, 0o755);
  assert.deepEqual(f2.run('sync-base', { FIXER: 'true' }, 1).outputs, {});
});

test('执行者合并目标分支失败：会话记进运行状态，再跑接回它、先核对现场；接不回（没有会话 ID）才从需求分支 head 新开一次', t => {
  const f = fixture(t); f.run('branch'); f.progress('submit', '汇报');
  const head = f.land('shared', 'branch side'), base = f.advanceMain('shared', 'main side'), executor = { EXECUTOR: JSON.stringify({ agent: 'codex' }) };
  f.run('sync-base', { FIXER: 'true' });
  f.task({ merge: 'main', file: 'shared', text: 'both', answer: '解到一半', exit: 1 });
  f.run('sync-resolve', executor, 1);
  assert.equal(f.state().sync.session, 'worker-1');
  assert.equal(f.remote('req/run-1'), head, '失败不推送');
  f.task({ noCommit: true, answer: '解好了' });
  assert.equal(f.run('sync-resolve', executor).outputs.route, 'pr');
  const resumed = f.agentCalls()[1];
  assert.deepEqual(resumed.args.slice(0, 2), ['--continue', 'worker-1']);
  for (const part of ['不再委派', '上一次没有正常结束', 'git status', '原任务：', `git merge ${base}`]) assert.ok(resumed.prompt.includes(part), part);
  assert.deepEqual(parents(f, f.remote('req/run-1')), [head, base], '上次做好的合并提交推到需求分支');

  const f2 = fixture(t); f2.run('branch'); f2.progress('submit', '汇报');
  const head2 = f2.land('shared', 'branch side'), base2 = f2.advanceMain('shared', 'main side');
  f2.run('sync-base', { FIXER: 'true' });
  f2.task({ merge: 'main', file: 'shared', text: 'both', answer: '解到一半', exit: 1 });
  f2.run('sync-resolve', executor, 1);
  f2.task({ lost: true, merge: 'main', file: 'shared', text: 'both', answer: '重新解好了' });
  assert.equal(f2.run('sync-resolve', executor).outputs.route, 'pr');
  const calls = f2.agentCalls();
  assert.deepEqual(calls.map(c => c.args[0]), ['--commit', '--continue', '--commit'], '接不回只新开一次');
  assert.deepEqual(calls[2].args.slice(0, 2), ['--commit', head2]);
  assert.ok(!calls[2].prompt.includes('上一次没有正常结束'), '新开的会话不用核对现场');
  assert.equal(f2.state().sync.session, undefined);
  assert.deepEqual(parents(f2, f2.remote('req/run-1')), [head2, base2]);
});

test('执行者做完、推需求分支因网络失败退出：会话 ID 已落盘，再跑接回同一会话推送，不另开', t => {
  const executor = { EXECUTOR: JSON.stringify({ agent: 'codex' }) };
  // 服务端拒收、需求分支没动：推送失败保留退出码（同网络失败），去掉钩子后再跑。
  const block = f => { const hook = join(f.origin, 'hooks', 'pre-receive'); writeFileSync(hook, '#!/bin/sh\nexit 1\n'); chmodSync(hook, 0o755); return () => rmSync(hook); };

  const f = fixture(t); f.run('branch'); f.progress('submit', '汇报');
  const head = f.land('shared', 'branch side'), base = f.advanceMain('shared', 'main side');
  f.run('sync-base', { FIXER: 'true' });
  let unblock = block(f);
  f.task({ merge: 'main', file: 'shared', text: 'both', answer: '解好了' });
  f.run('sync-resolve', executor, 1);
  assert.equal(f.state().sync.session, 'worker-1', '推送前已记下会话');
  assert.equal(f.remote('req/run-1'), head);
  unblock();
  f.task({ noCommit: true, answer: '已经解好了' });
  assert.equal(f.run('sync-resolve', executor).outputs.route, 'pr');
  assert.deepEqual(f.agentCalls().map(c => c.args.slice(0, 2)), [['--commit', head], ['--continue', 'worker-1']]);
  assert.deepEqual(parents(f, f.remote('req/run-1')), [head, base]);
  assert.equal(f.state().sync.session, undefined, '推送成功后清掉');
});

// 从 from 走到 stops 之一：网关按 context 分流（并行网关走检查那一支），其余走唯一的出口；返回经过的节点，最后一个是停下的。
const walk = ({ nodes, route, next }, from, context, stops) => {
  const visited = [from];
  while (!stops.includes(visited.at(-1))) {
    const step = visited.at(-1);
    visited.push(step === 'pr-fork' ? 'reuse-checks' : nodes[step].$type === 'bpmn:ExclusiveGateway' ? route(step, context) : next(step));
  }
  return visited;
};

test('提交验收的顺序：跟上目标分支、开 PR、项目检查、整体评审、设备验收、合并前检查、GitHub 检查，最后待交付、批准或自动合并', async () => {
  const flow = await definition();
  const order = ['sync', 'pr', 'checks', 'overall-plan', 'overall-call', 'overall', 'acceptance', 'premerge', 'github-checks'];
  const context = { 'progress-result': { route: 'submit' }, sync: { route: 'pr' }, pr: { checked: false }, 'overall-plan': { review: true }, overall: { route: 'accept', auto: false },
    inputs: { devices: true, delivery: '' }, acceptance: { route: 'passed' } };
  const visited = walk(flow, 'after-progress', context, ['approve', 'delivery', 'merge']);
  assert.deepEqual(visited.filter(id => order.includes(id)), order, visited.join(' → '));
  assert.equal(visited.at(-1), 'approve');
  // 同一 head 的项目检查复用，评审时检查已有结论；没评也一样往下走，合并前检查仍在设备验收之后。
  const reused = walk(flow, 'pr', { ...context, pr: { checked: true }, 'overall-plan': { review: false } }, ['approve']);
  assert.deepEqual(reused.filter(id => order.includes(id)), ['pr', 'overall-plan', 'overall', 'acceptance', 'premerge', 'github-checks']);
  // 有必须修：先交主 Agent，继续验收才接着走设备验收和合并前检查；回到进行中就不跑。
  const escalated = { ...context, overall: { route: 'review', auto: false } };
  assert.deepEqual(walk(flow, 'overall', { ...escalated, 'review-result': { route: 'continue' } }, ['approve']).filter(id => [...order, 'review'].includes(id)),
    ['overall', 'review', 'acceptance', 'premerge', 'github-checks']);
  assert.deepEqual(walk(flow, 'overall', { ...escalated, 'review-result': { route: 'progress' } }, ['resume', 'premerge']).at(-1), 'resume');
});

test('自动合并：开了且这次运行的整体评审没出过必须修（overall.auto）就在合并前检查和 GitHub 检查之后直接合并、不跑合并后的流程；出过必须修照常出批准卡；成员运行照旧进待交付', async () => {
  const flow = await definition(), { nodes, values, route } = flow;
  const stops = ['merge', 'approve', 'delivery'];
  const at = (auto, inputs = {}) => walk(flow, 'overall-route', { overall: { route: 'accept', auto }, inputs: { devices: false, delivery: '', ...inputs }, acceptance: { route: 'passed' } }, stops);
  const merged = at(true);
  assert.deepEqual([merged.at(-1), merged.includes('premerge'), merged.includes('github-checks'), merged.includes('joiners')], ['merge', true, true, false]);
  assert.equal(at(true, { devices: true }).at(-1), 'merge', '设备验收通过之后');
  assert.equal(at(false).at(-1), 'approve', '出过必须修');
  assert.equal(at(true, { delivery: 'deliver-1' }).at(-1), 'delivery');
  // 判定只在「整理整体评审」的 auto；收尾各处只引用它。
  for (const text of [nodes['auto-merge-needed'].conditionExpression.body, nodes['merged-only'].conditionExpression.body, nodes.done.notify, values(nodes.done).find(v => v.name === 'notify').value]) {
    assert.ok(text.includes('overall.auto = true') && !text.includes('inputs.autoMerge'), text);
  }
  // 自动合并后不跑合并后的流程（哪怕留着之前批准卡的答复），照常通知。
  const stale = { approve: { options: { notify: false } }, 'approval-result': { only: '["deploy"]', missing: '' }, inputs: { delivery: '' } };
  assert.equal(route('merged-choice', { ...stale, overall: { auto: true } }), 'done');
  assert.equal(route('merged-choice', { ...stale, overall: { auto: false } }), 'fill-choice');
  for (const expression of [nodes.done.notify, values(nodes.done).find(v => v.name === 'notify').value]) {
    assert.equal(evaluate(expression.slice(1), { ...stale, overall: { auto: true } }).value, true);
    assert.equal(evaluate(expression.slice(1), { ...stale, overall: { auto: false } }).value, false, '批准卡上没勾通知');
  }
});

// 假宿主：照流程定义从开始走到结束。网关按 FEEL 分流（并行网关走检查那一支），脚本步骤真跑 develop.mjs（env 照 coda:env 求值、输出照引擎转布尔），
// 人工任务按引擎展开文字后交给 answers 里的函数答，调用的流程和服务步骤也由 answers 给结果（没给的服务步骤当作成功、没有输出）。
async function host(f, inputs, message, answers) {
  const { nodes, values, route, next } = await definition();
  const context = { inputs, run: { id: 'run-1', message } }, visited = [], cards = [];
  const value = v => (v.startsWith('=') ? evaluateTyped(v.slice(1), context) : v);
  const render = text => text.replace(/{{([\s\S]*?)}}/g, (_, e) => { const v = evaluateTyped(e, context); return v === null || v === undefined ? '' : String(v); });
  for (let step = 'start'; nodes[step].$type !== 'bpmn:EndEvent';) {
    const node = nodes[step], type = node.$type;
    visited.push(step);
    if (type === 'bpmn:ScriptTask') {
      const env = Object.fromEntries(values(node).filter(v => v.$type === 'coda:Env').map(v => [v.name, value(v.value)]).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v ?? null)]));
      context[step] = typedOutputs(f.run(/develop\.mjs" (\S+)/.exec(node.script)[1], env).outputs);
    } else if (type === 'bpmn:UserTask') {
      const text = render(node.documentation[0].text);
      cards.push({ step, text });
      context[step] = answers[step](text);
    } else if (type === 'bpmn:CallActivity' || type === 'bpmn:ServiceTask') context[step] = answers[step]?.() ?? {};
    step = step === 'pr-fork' ? 'reuse-checks' : type === 'bpmn:ExclusiveGateway' ? route(step, context) : next(step);
  }
  return { visited, cards, context };
}

test('假宿主走一遍：两块的需求提交验收，整体评审有必须修回到进行中，派块修好再提交验收不再评，合并前检查后出批准卡', async t => {
  const f = fixture(t);
  const pieces = [['块一', 'one'], ['块二', 'two'], ['修登录跳转', 'fix']];
  const progress = [
    { choice: 'piece', note: '块一\n做第一块' }, { choice: 'piece', note: '块二\n做第二块' }, { choice: 'submit', note: '做了什么\n- 输入框能输入\n需要你知道：无', options: { again: false } },
    { choice: 'piece', note: '修登录跳转\n只修整体评审的必须修 1' }, { choice: 'submit', note: '做了什么\n- 输入框能输入，登录跳转修好\n需要你知道：无', options: { again: false } },
  ];
  let landed = 0;
  const run = await host(f, { title: '输入框', devices: false, device: '', hold: '', delivery: '', executor: { agent: 'codex' }, executor2: null, reviewer: { agent: 'kimi' },
    overallReviewer: { agent: 'grok' }, autoMerge: true, base: '' }, '输入框可以输入', {
    progress: () => progress.shift(),
    piece: () => { const [title, file] = pieces[landed++]; return { commit: f.land(file, title, `${title}\n\nCoda-Piece: piece-${landed}`), run: `piece-${landed}` }; },
    checks: () => ({ runs: [{ workflow: 'test', state: 'succeeded', runId: 'c1' }] }),
    'overall-call': () => ({ decision: 'REQUEST_CHANGES', line: '评审要求修改（REQUEST_CHANGES）', report: '评审原文', resolutions: '[]', head: f.state().head, base: f.remote('main'),
      findings: JSON.stringify([{ level: 'must', kind: 'correctness', title: '登录后停在空白页', location: 'app.mjs:3', detail: '' }, { level: 'nit', kind: 'style', title: '变量名', location: 'one:1', detail: '可以更短' }]) }),
    review: () => ({ choice: 'progress', note: '先修登录跳转' }),
    joiners: () => ({ list: [] }),
    approve: () => ({ choice: 'merge', options: { notify: true }, inputs: {} }),
  });
  const { visited, cards } = run;
  assert.equal(visited.filter(id => id === 'overall-call').length, 1, '整体评审只评一次');
  assert.deepEqual(visited.filter(id => ['overall-call', 'review', 'premerge', 'github-checks', 'approve', 'merge'].includes(id)), ['overall-call', 'review', 'premerge', 'github-checks', 'approve', 'merge']);
  assert.ok(!visited.slice(0, visited.indexOf('review')).includes('premerge'), '有必须修回到进行中之前没跑合并前检查');
  const card = id => cards.find(c => c.step === id).text;
  const overallCard = card('review'), approveCard = card('approve'), backCard = cards.filter(c => c.step === 'progress')[3].text;
  for (const text of ['必须修 1 条：\n- 登录后停在空白页（app.mjs:3）\n小问题 1 条，原有问题 0 条。', `评审原文：${join(f.env.CODA_ARTIFACTS, 'overall-review-1.md')}`, '只有必须修才回到进行中派块修', '不把以后的需求提前做进来'])
    assert.ok(overallCard.includes(text), text);
  assert.ok(backCard.includes('整体评审后主 Agent 选了回到进行中。\n先修登录跳转\n整体评审的结论：'), backCard);
  for (const text of ['做了什么\n- 输入框能输入，登录跳转修好', '整体评审的小问题（没有修，评审时需求分支 head', '- 变量名（one:1）', '项目检查、合并前检查、GitHub 检查已通过，整条需求分支在 ']) assert.ok(approveCard.includes(text), text);
  t.diagnostic(`「整体评审结论」卡：\n${overallCard}`);
  t.diagnostic(`「批准合并」卡：\n${approveCard}`);
});
