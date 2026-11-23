// 需求运行（plugins/composer/.coda/workflows/develop.bpmn、scripts/develop.mjs）：临时 Git 仓库、假的 gh，
// 网关条件用与引擎同版本的 FEEL 求值；脚本输出先照引擎把 "true"/"false" 变成布尔值。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { readWorkflow } from '@coda-console/protocol/workflow';
import { evaluate } from 'feelin';
import { evaluateTyped, typedOutputs } from './feel.mjs';
import { readContract, scopeViolations } from '../../../plugins/composer/scripts/shared.mjs';

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
  f.run('piece-landed', { TITLE: '修好登录跳转', COMMIT: 'c'.repeat(40), PIECE_RUN: 'piece-7', BY: '' });
  assert.equal(f.reason(), landed, '不是用户定的：写法不变');
  f.run('piece-landed', { TITLE: '修好登录跳转', COMMIT: 'c'.repeat(40), PIECE_RUN: 'piece-7', BY: 'user' });
  assert.equal(f.reason(), `${landed}\n这是用户定的：你对这一块的退回已满三次，这次又要退回，用户改成了不退，合进需求分支。`);
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
  assert.deepEqual(opened, { checked: 'false', withContract: 'false', url: PR, head, base: f.remote('main'), branch: 'req/run-1', summary,
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

test('整体评审评不评：填了整体评审者、不是只合进了一块且它评成过（跟上目标分支的块、流程直推的不算）、这次运行还没评过才评；勾「重新整体评审」再评一次', t => {
  const f = fixture(t); f.run('branch');
  const plan = (reviewer = true) => f.run('overall-plan', { REVIEWER: String(reviewer) }).outputs;
  f.land('one', 'first', '块一\n\nCoda-Piece: piece-1');
  f.run('piece-landed', { TITLE: '块一', COMMIT: 'c'.repeat(40), PIECE_RUN: 'piece-1', REVIEWED: 'true' });
  // 跟上目标分支的块是执行者的合并提交，不带 Coda-Piece；提交验收时流程直接推的合并提交同样不算。
  const main = f.advanceMain('m', 'main');
  f.git('fetch', '-q', 'origin', 'req/run-1'); f.git('switch', '-q', '--detach', 'FETCH_HEAD'); f.git('merge', '-q', '--no-ff', '--no-edit', main);
  f.git('push', '-q', 'origin', 'HEAD:refs/heads/req/run-1');
  f.advanceMain('n', 'main again');
  submitTo(f);
  assert.equal(f.state().pushed.length, 1, '提交验收时流程又推了一个合并提交');
  assert.deepEqual(plan(), { review: 'false', evidence: '项目检查：\ntest: succeeded coda://workflow-runs/c1' }, '只有一块且它评成过：跳过');
  f.land('two', 'second', '块二\n\nCoda-Piece: piece-2');
  f.run('piece-landed', { TITLE: '块二', COMMIT: 'd'.repeat(40), PIECE_RUN: 'piece-2', REVIEWED: 'true' });
  submitTo(f);
  assert.deepEqual(f.state().landed, ['piece-2', 'piece-1']);
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

  // 只合进一块且它评成过：跳过；勾「重新整体评审」就当没评过，照常评一次，下一次又跳过。
  const single = fixture(t); single.run('branch');
  single.land('one', 'first', '块一\n\nCoda-Piece: piece-1');
  single.run('piece-landed', { TITLE: '块一', COMMIT: 'c'.repeat(40), PIECE_RUN: 'piece-1', REVIEWED: 'true' });
  const alone = () => single.run('overall-plan', { REVIEWER: 'true' }).outputs.review;
  submitTo(single);
  assert.equal(alone(), 'false', '只有一块且它评成过：跳过');
  submitTo(single, { again: true });
  assert.equal(alone(), 'true', '勾了重新整体评审：单块也评');
  submitTo(single);
  assert.equal(alone(), 'false');

  // 只有一块，但它没评审者（评审者：无）或没评成：照常整体评审。
  for (const reviewed of ['false', undefined]) {
    const g = fixture(t); g.run('branch');
    g.land('one', 'first', '块一\n\nCoda-Piece: piece-1');
    g.run('piece-landed', { TITLE: '块一', COMMIT: 'c'.repeat(40), PIECE_RUN: 'piece-1', ...reviewed && { REVIEWED: reviewed } });
    submitTo(g);
    assert.equal(g.run('overall-plan', { REVIEWER: 'true' }).outputs.review, 'true', `块没评成（REVIEWED=${reviewed}）`);
  }
});

test('整理整体评审：没评或没有必须修往下走，小问题与原有问题写进 PR 描述和汇总；有必须修或没评成交主 Agent 一页结论；自动合并要这次运行评成过、整体评审没出过必须修', t => {
  const f = fixture(t); f.run('branch');
  f.land('one', 'first', '块一\n\nCoda-Piece: piece-1'); f.land('two', 'second', '块二\n\nCoda-Piece: piece-2');
  const landed = (run, reviewed) => f.run('piece-landed', { TITLE: run, COMMIT: 'c'.repeat(40), PIECE_RUN: run, REVIEWED: reviewed });
  landed('piece-1', 'false'); landed('piece-2', 'false');
  let pr = submitTo(f);
  const overall = (AUTO = 'true') => f.run('overall', { SUMMARY: pr.summary, AUTO }).outputs;
  const edits = () => f.calls().filter(c => c.args[1] === 'edit');
  const report = n => join(f.env.CODA_ARTIFACTS, `overall-review-${n}.md`);
  f.run('overall-plan', { REVIEWER: 'false' });
  const before = edits().length;
  assert.deepEqual(overall(), { route: 'accept', summary: pr.summary, auto: 'false', review: '', note: '' }, '块评审者、整体评审者都没有：往下走，开了 autoMerge 也出批准卡');
  landed('piece-1', 'true');
  assert.equal(overall().auto, 'false', '块二没评成：还是出批准卡');
  landed('piece-2', 'true');
  assert.equal(overall().auto, 'true', '合进的每一块都评成过：开了 autoMerge 就自动合并');
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
  assert.deepEqual([skipped.visited, skipped.end.id], [['fill', 'merged-inputs', 'run-merged', 'after-run'], 'done']);
});

test('合并后的流程：勾了的都被「这一项这次不跑」去掉，不进 run-merged，运行成功结束', async t => {
  const skipped = await afterSkip(t, ['publish-preview', 'publish-release'], [{ result: 'completed', choice: 'skip', note: '' }]);
  assert.equal(skipped.merged.only, '[]');
  assert.deepEqual([skipped.visited, skipped.end.id, skipped.end.status], [['fill', 'merged-inputs'], 'done-none', '已完成，没有要跑的合并后流程']);
  assert.equal(skipped.end.extensionElements.values.find(v => v.name === 'afterMerge').value, '没有运行合并后的流程，没有什么要再等的', '补填时都选了不跑');
});

test('合并后的流程都成功：结束时的 afterMerge 按批准卡上的名字逐项列出，拿不到名字用流程名；没跑的几条路都写没有运行', async t => {
  const f = fixture(t); f.run('branch');
  const runs = [{ workflow: 'deploy', runId: 'r1', state: 'succeeded' }, { workflow: 'publish-preview', runId: 'r2', state: 'succeeded' }, { workflow: 'unlisted', runId: 'r3', state: 'succeeded' }];
  const joiners = [{ id: 'deploy', name: '部署' }, { id: 'publish-preview', name: '发布预览版' }];
  assert.deepEqual(f.run('ran', { RUNS: JSON.stringify(runs), JOINERS: JSON.stringify(joiners) }).outputs, { line: '合并后的流程已全部结束，不用再等：部署：成功；发布预览版：成功；unlisted：成功' });
  // 没跑的路：没勾、归属需求交付、自动合并时白名单为空（留着之前批准卡的答复也一样）都不经 run-merged，直接到写着「没有运行」的结束。
  const { nodes, route, next } = await definition();
  const end = context => {
    let step = 'merged-choice';
    while (nodes[step].$type !== 'bpmn:EndEvent') step = nodes[step].$type === 'bpmn:ExclusiveGateway' ? route(step, context) : next(step);
    return step;
  };
  const picked = { 'approval-result': { only: '["deploy"]', missing: '' } };
  assert.equal(end({ inputs: { delivery: '' }, overall: { auto: false }, 'approval-result': { only: '[]', missing: '' } }), 'done-none', '没勾');
  assert.equal(end({ inputs: { delivery: 'deliver-1' }, overall: { auto: false }, ...picked }), 'done-none', '归属需求交付');
  assert.equal(end({ inputs: { delivery: '' }, overall: { auto: true }, 'approval-result': { only: '[]', missing: '' }, approve: { options: { notify: false } } }), 'done-none', '自动合并，白名单为空');
  assert.equal(end({ inputs: { delivery: '' }, overall: { auto: true }, ...picked, 'merged-inputs': { only: '["deploy"]' } }), 'done', '自动合并，白名单非空：照样跑');
  assert.equal(end({ inputs: { delivery: '' }, overall: { auto: false }, ...picked, 'merged-inputs': { only: '["deploy"]' } }), 'done', '勾了：跑完才到 done');
});

test('需求运行的定义：输入、进行中的三种答复、暂停卡、收尾各处失败回到进行中、整体评审、合并方式与合并后的流程', async () => {
  const { process, elements, nodes, values, params, route, next } = await definition();
  assert.equal(process.name, '监督开发'); assert.equal(process.kind, undefined); assert.equal(process.concurrency, undefined);
  assert.deepEqual(values(process).filter(v => v.$type === 'coda:Join').map(j => j.hook), ['develop'], '开发流程：加入挂点 develop');
  const inputs = Object.fromEntries(values(process).filter(v => v.$type === 'coda:Input').map(v => [v.name, v]));
  assert.deepEqual(Object.keys(inputs), ['title', 'devices', 'device', 'hold', 'delivery', 'executor', 'executor2', 'reviewer', 'overallReviewer', 'autoMerge', 'base', 'contract']);
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
  // 「提交验收」带勾选项「重新整体评审」：默认不勾，只在填了整体评审者时给出；「交用户批准」只在契约模式、且不是需求交付的成员（delivery 为空）时给出。
  assert.deepEqual(values(nodes.progress)[0].options.map(o => [o.id, o.name, o.default, o.shown]), [['again', '重新整体评审', 'false', '=inputs.overallReviewer != null'], ['escalate', '交用户批准', 'false', '=inputs.contract != "" and inputs.delivery = ""']]);
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
  assert.deepEqual(params('piece-landed'), { TITLE: '=progress-result.title', COMMIT: '=piece.commit', PIECE_RUN: '=piece.run', REVIEWED: '=piece.reviewed', BY: '=piece.by' });
  assert.deepEqual(params('progress-result').FIXER, '=inputs.executor != null');
  // 填了整体评审者，提交验收的说明里写怎么评；批准卡写评没评过的是「整理整体评审」的 note。
  const overallSaid = [...doc.matchAll(/{{(.*?)}}/gs)].find(m => m[1].includes('inputs.overallReviewer'))[1];
  assert.equal(evaluate(overallSaid, { inputs: { overallReviewer: null, contract: '' } }).value, '');
  assert.equal(evaluate(overallSaid, { inputs: { overallReviewer: { agent: 'c' }, contract: CONTRACT } }).value, '需求分支 head 与最近一次评完的整体评审的 head 不同时由整体评审者评整条需求分支（head 没变不重评；勾「重新整体评审」一定评），有必须修或没评成时交你看结论，');
  assert.equal(evaluate(overallSaid, { inputs: { overallReviewer: { agent: 'c' }, contract: '' } }).value, '这次运行还没整体评审过时由整体评审者评一次整条需求分支（只合进了一块且它评成过时跳过；勾「重新整体评审」就当没评过），有必须修或没评成时交你看结论，');
  const reasonLine = [...doc.matchAll(/{{(.*?)}}/gs)].find(m => m[1].includes('resume.reason'))[1];
  assert.equal(evaluate(reasonLine, { resume: { reason: '' } }).value, '');
  assert.equal(evaluate(reasonLine, { resume: { reason: '合并前检查未通过' } }).value, '回到进行中的原因：\n合并前检查未通过\n');
  // 收尾按是否归属需求交付分段写：成员运行没有用户的批准卡和「暂不合并」。
  const ending = [...doc.matchAll(/{{(.*?)}}/gs)].find(m => m[1].includes('inputs.delivery'))[1];
  const own = evaluate(ending, { inputs: { delivery: '', devices: true, contract: '' } }).value, member = evaluate(ending, { inputs: { delivery: 'deliver-1', devices: true, contract: '' } }).value;
  assert.equal(own, '再交用户设备验收，然后跑合并前检查与 GitHub 检查，通过后由用户批准合并（合并提交）。任何失败和用户的「暂不合并」都带着原因回到这里。');
  assert.equal(evaluate(ending, { inputs: { delivery: '', devices: false, contract: '' } }).value, '然后跑合并前检查与 GitHub 检查，通过后由用户批准合并（合并提交）。任何失败和用户的「暂不合并」都带着原因回到这里。');
  assert.equal(evaluate(ending, { inputs: { delivery: '', devices: false, autoMerge: true, contract: '' } }).value,
    '然后跑合并前检查与 GitHub 检查，通过后直接合并（合并提交；这次运行一次都没评成过、或整体评审出过必须修时照常由用户批准）。任何失败和用户的「暂不合并」都带着原因回到这里。', '自动合并不看填没填整体评审者');
  assert.equal(evaluate(ending, { inputs: { delivery: '', devices: false, autoMerge: true, contract: CONTRACT } }).value,
    '然后跑合并前检查与 GitHub 检查，通过后，范围门禁在当前 head 上没有违例、整体评审评在当前 head 上且没有必须修、这次没勾「交用户批准」时直接合并（合并提交，合并后只跑契约 hooks 里列的流程，没列的不跑），否则由用户批准合并（合并提交）。任何失败和用户的「暂不合并」都带着原因回到这里。', '契约模式的自动合并按当前 head 写');
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
  assert.equal(next('pr'), 'gate-choice', '开 PR 之后先过契约模式的范围门禁（非契约模式绕过），再到预编与检查的分叉');
  // 需求分支 head 在检查的同时预编：只在随后会进设备验收时，不挡检查，失败也不算数。
  assert.deepEqual(elements.filter(e => e.sourceRef === nodes['pr-fork']).map(e => e.targetRef.id), ['reuse-checks', 'prebuild-choice']);
  for (const [devices, delivery, target] of [[true, '', 'prebuild'], [false, '', 'prebuilt'], [true, 'deliver-1', 'prebuilt']]) assert.equal(route('prebuild-choice', { inputs: { devices, delivery } }), target);
  assert.equal(params('prebuild').commit, '=pr.head');
  assert.equal(params('prebuild').hook, 'prebuild');
  for (const device of ['', 'duo-testbed']) assert.deepEqual(evaluate(params('prebuild').inputs.slice(1), { inputs: { device } }).value, device ? { device } : {});
  for (const id of ['prebuild-done', 'prebuild-failed-done', 'prebuild-skip']) assert.equal(nodes[id].targetRef.id, 'prebuilt');
  assert.deepEqual(params('checks'), { hook: 'check', commit: '=pr.head', inputs: '=if pr.withContract then { contract: inputs.contract } else {}' });
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
  assert.deepEqual(params('overall-plan'), { REVIEWER: '=inputs.overallReviewer != null', CONTRACT: '=inputs.contract', review: undefined, evidence: undefined });
  assert.equal(next('overall-plan'), 'overall-choice');
  for (const [review, target] of [[true, 'overall-call'], [false, 'overall']]) assert.equal(route('overall-choice', { 'overall-plan': { review } }), target);
  assert.equal(nodes['overall-call'].calledElement, 'review-commit');
  assert.deepEqual(params('overall-call'), { base: '=pr.base', head: '=pr.head', task: '=pr.task', reviewer: '=inputs.overallReviewer', evidence: '=overall-plan.evidence' });
  assert.equal(nodes['overall-failed'].attachedToRef.id, 'overall-call');
  assert.deepEqual([next('overall-failed'), next('overall-lost'), next('overall-call'), next('overall-reviewed')], ['overall-lost', 'overall', 'overall-reviewed', 'overall']);
  assert.deepEqual(params('overall-reviewed'), { DECISION: '=overall-call.decision', FINDINGS: '=overall-call.findings', LINE: '=overall-call.line', REPORT: '=overall-call.report' });
  assert.deepEqual(params('overall'), { SUMMARY: '=pr.summary', AUTO: '=inputs.autoMerge', CONTRACT: '=inputs.contract', route: undefined, summary: undefined, auto: undefined, review: undefined, note: undefined });
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
  assert.equal(route('delivery-choice', { inputs: { delivery: '' } }), 'joiners', '不属于需求交付：先列出合并后的流程，再分流');
  assert.equal(route('auto-merge-choice', { overall: { auto: false } }), 'approve');
  assert.equal(route('auto-merge-choice', { overall: { auto: true } }), 'approval-result', '自动合并：不出批准卡');
  assert.equal(route('delivery-choice', { inputs: { delivery: 'deliver-1' } }), 'delivery');
  assert.deepEqual(values(nodes.delivery).map(v => [v.id, v.name]), [['revise', '退回修改'], ['merge', '放行合并']]);
  for (const [value, target] of [['delivery', 'delivery'], ['progress', 'resume'], ['merge', 'merge']]) assert.equal(route('after-delivery', { 'delivery-result': { route: value } }), target);
  // 批准卡：勾选项是项目在需求分支 head 上加入挂点 merged 的流程，卡上只有数据，不写引导。
  assert.equal(nodes.joiners.action, 'hook-joiners');
  assert.deepEqual(params('joiners'), { hook: 'merged', commit: '=pr.head' });
  assert.equal(next('joiners'), 'auto-merge-choice');
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
  assert.deepEqual(envs('approval-result'), { APPROVAL: '=approve', JOINERS: '=joiners.list', AUTO: '=overall.auto', CONTRACT: '=inputs.contract' });
  assert.deepEqual(outputs('approval-result'), ['route', 'only', 'picked', 'inputs', 'missing', 'asks', 'needs']);
  for (const [value, target] of [['stop', 'resume'], ['merge', 'merge']]) assert.equal(route('after-approval', { 'approval-result': { route: value } }), target);
  assert.equal(route('after-merge', { merge: { route: 'conflict' } }), 'resume');
  assert.equal(route('after-merge', { merge: { route: 'merged' } }), 'merged-choice');
  assert.ok(!elements.some(e => e.id === 'stopped'), '暂不合并不再结束运行');
  for (const id of ['kinds', 'write-notes', 'notes-result', 'deploy', 'publish-preview', 'publish-release']) assert.ok(!nodes[id], id);

  // 合并后：成员运行不跑；独立交付只跑勾了的（自动合并时是白名单里的，与批准卡上勾的一样处理），没写的文字先交主 Agent 逐项写。
  for (const delivery of ['', 'deliver-1']) for (const only of ['[]', '["deploy","publish-preview"]']) for (const missing of ['', 'notes']) for (const auto of [false, true]) {
    const visited = [], context = { inputs: { delivery }, overall: { auto }, 'approval-result': { only, missing } };
    let step = 'merged-choice';
    while (nodes[step].$type !== 'bpmn:EndEvent') {
      visited.push(step);
      step = nodes[step].$type === 'bpmn:ExclusiveGateway' ? route(step, context) : next(step);
    }
    const runs = !delivery && only !== '[]';
    assert.deepEqual(visited.filter(id => !nodes[id].$type.endsWith('Gateway')), runs ? [...(missing ? ['fill'] : []), 'merged-inputs', 'run-merged', 'after-run'] : [], `${delivery}|${only}|${missing}|${auto}`);
    assert.equal(step, runs ? 'done' : 'done-none', `${delivery}|${only}|${missing}|${auto}`);
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
  // 结束时交给发起会话的 afterMerge 写明合并后流程的结果：跑了的是 after-run 写的一句，没跑的各条路都到 done-none；两个结束输出的名字一样（同上一块的简易开发）。
  assert.deepEqual(values(nodes.done).map(v => v.name), ['pr', 'commit', 'notify', 'afterMerge']);
  assert.deepEqual(values(nodes['done-none']).map(v => v.name), ['pr', 'commit', 'notify', 'afterMerge']);
  assert.equal(values(nodes.done).find(v => v.name === 'afterMerge').value, '=after-run.line');
  assert.equal(values(nodes['done-none']).find(v => v.name === 'afterMerge').value, '没有运行合并后的流程，没有什么要再等的');
  assert.deepEqual(params('after-run'), { RUNS: '=run-merged.runs', JOINERS: '=joiners.list', line: undefined });
  assert.deepEqual(elements.filter(e => e.targetRef === nodes.done).map(e => e.sourceRef.id), ['after-run'], '只有跑了合并后的流程才到 done');
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

test('自动合并：满足条件（overall.auto）就在合并前检查和 GitHub 检查、列出合并后的流程之后不出批准卡，直接到「读取批准」合成答复再合并；其余照常出批准卡；成员运行照旧进待交付', async () => {
  const flow = await definition(), { nodes, values, route } = flow;
  const stops = ['merge', 'approve', 'delivery'];
  const at = (auto, inputs = {}) => walk(flow, 'overall-route', { overall: { route: 'accept', auto }, 'approval-result': { route: 'merge' }, inputs: { devices: false, delivery: '', ...inputs }, acceptance: { route: 'passed' } }, stops);
  const merged = at(true);
  assert.deepEqual([merged.at(-1), merged.includes('premerge'), merged.includes('github-checks'), merged.includes('approve')], ['merge', true, true, false]);
  assert.deepEqual(merged.slice(merged.indexOf('github-checks')), ['github-checks', 'delivery-choice', 'joiners', 'auto-merge-choice', 'approval-result', 'after-approval', 'merge'], '先列出加入者，再分流，自动合并不经批准卡');
  assert.equal(at(true, { devices: true }).at(-1), 'merge', '设备验收通过之后');
  const manual = at(false);
  assert.deepEqual(manual.slice(manual.indexOf('github-checks')), ['github-checks', 'delivery-choice', 'joiners', 'auto-merge-choice', 'approve'], '不自动合并：照旧出批准卡');
  const member = at(true, { delivery: 'deliver-1' });
  assert.deepEqual(member.slice(member.indexOf('github-checks')), ['github-checks', 'delivery-choice', 'delivery'], '需求交付的成员：不列加入者，进待交付，路不变');
  // 判定只在「整理整体评审」的 auto；收尾各处只引用它。
  for (const text of [nodes['auto-merge-needed'].conditionExpression.body, nodes.done.notify, values(nodes.done).find(v => v.name === 'notify').value]) {
    assert.ok(text.includes('overall.auto = true') && !text.includes('inputs.autoMerge'), text);
  }
  assert.ok(!nodes['merged-only'].conditionExpression.body.includes('overall.auto'), '是否运行合并后的流程只看成员与 only');
  assert.equal(nodes['merged-only'].conditionExpression.body, '=inputs.delivery != "" or approval-result.only = "[]"');
  // 自动合并时白名单非空照样到 run-merged；留着之前批准卡的答复不影响，照常通知。
  const stale = { approve: { options: { notify: false } }, inputs: { delivery: '' }, overall: { auto: true } };
  assert.equal(route('merged-choice', { ...stale, 'approval-result': { only: '["deploy"]', missing: '' } }), 'fill-choice');
  assert.equal(route('merged-choice', { ...stale, 'approval-result': { only: '[]', missing: '' } }), 'done-none');
  assert.equal(route('merged-choice', { ...stale, inputs: { delivery: 'deliver-1' }, 'approval-result': { only: '["deploy"]' } }), 'done-none', '成员运行不跑');
  for (const expression of ['done', 'done-none'].flatMap(id => [nodes[id].notify, values(nodes[id]).find(v => v.name === 'notify').value])) {
    assert.equal(evaluate(expression.slice(1), stale).value, true);
    assert.equal(evaluate(expression.slice(1), { ...stale, overall: { auto: false } }).value, false, '批准卡上没勾通知');
  }
});

// 自动路径上批准卡没有执行过，读它得到空值：自动路径会求值的表达式在上下文里不给 approve（也不给 fill 等没执行的节点）时不抛错、结果正确。
test('自动路径上没执行过的节点读到空值：approval-result 的环境变量、merged-choice 条件、结束事件的 notify、fill 的说明、tell-device 都不出错', async () => {
  const flow = await definition(), { nodes, values, params, route } = flow;
  const expect = (expression, context) => { const result = evaluate(expression.slice(1), context); assert.deepEqual(result.problems ?? [], [], expression); return result.value; };
  const joiners = { list: [{ id: 'deploy', name: '部署' }] };
  const context = { inputs: { delivery: '', contract: CONTRACT, devices: false, autoMerge: true }, overall: { auto: true }, joiners, pr: { head: 'h', url: PR }, req: { title: '输入框' }, run: { id: 'run-1' }, merge: { commit: 'm' } };
  assert.equal(context.approve, undefined);
  const envs = params('approval-result');
  assert.equal(expect(envs.AUTO, context), true);
  assert.equal(expect(envs.CONTRACT, context), CONTRACT);
  assert.deepEqual(expect(envs.JOINERS, context), joiners.list);
  assert.equal(expect(envs.APPROVAL, context), null, '没有批准卡：空值，脚本在自动路径上不读它');
  for (const only of ['[]', '["deploy"]']) for (const missing of ['', 'notes']) {
    const ctx = { ...context, 'approval-result': { only, missing, asks: '「发布说明」：部署要' } };
    assert.equal(route('merged-choice', ctx), only === '[]' ? 'done-none' : 'fill-choice');
    assert.equal(route('fill-choice', ctx), missing ? 'fill' : 'merged-inputs');
  }
  for (const id of ['done', 'done-none']) for (const expression of [nodes[id].notify, values(nodes[id]).find(v => v.name === 'notify').value]) {
    assert.equal(expect(expression, context), true, '自动路径视为勾上「全部完成后通知 Agent」');
  }
  assert.equal(expect(values(nodes.done).find(v => v.name === 'pr').value, context), PR);
  assert.equal(expect(params('tell-device').text, context), '需求「输入框」：用户设备验收通过，接下来跑合并前检查与 GitHub 检查，通过后流程自动合并。');
  // fill 的说明：按 overall.auto 分两种写法，自动路径读 approval-result 和 loopCounter 不出错。
  const doc = nodes.fill.documentation[0].text;
  const render = ctx => doc.replace(/{{([\s\S]*?)}}/g, (_, e) => { const r = evaluate(e, ctx); assert.deepEqual(r.problems ?? [], [], e); return r.value ?? ''; });
  const filled = { ...context, 'approval-result': { asks: '「发布说明」：部署要' }, loopCounter: 1 };
  const auto = render(filled), manual = render({ ...filled, overall: { auto: false } });
  assert.ok(auto.startsWith('契约的 hooks 里列的流程要一段文字') && !auto.includes('用户批准合并时勾的') && auto.includes('「发布说明」：部署要'), auto);
  assert.ok(manual.startsWith('用户批准合并时勾的流程要一段文字，批准卡上没有写：') && !manual.includes('契约的 hooks'), manual);
  assert.equal(auto.split('\n').slice(1).join('\n'), manual.split('\n').slice(1).join('\n'), '除第一句外两种写法一样');
});

// 假宿主：照流程定义从开始走到结束。网关按 FEEL 分流（并行网关走检查那一支），脚本步骤真跑 develop.mjs（env 照 coda:env 求值、输出照引擎转布尔），
// 人工任务按引擎展开文字后交给 answers 里的函数答，调用的流程和服务步骤也由 answers 给结果（没给的服务步骤当作成功、没有输出）。
async function host(f, inputs, message, answers) {
  const { nodes, values, route, next } = await definition();
  // 走到结束事件为止（不执行它），end 是结束事件的 ID。
  const context = { inputs, run: { id: 'run-1', message } }, visited = [], cards = [];
  const value = v => (v.startsWith('=') ? evaluateTyped(v.slice(1), context) : v);
  const render = text => text.replace(/{{([\s\S]*?)}}/g, (_, e) => { const v = evaluateTyped(e, context); return v === null || v === undefined ? '' : String(v); });
  let step = 'start';
  while (nodes[step].$type !== 'bpmn:EndEvent') {
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
  return { visited, cards, context, end: step };
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
    overallReviewer: { agent: 'grok' }, autoMerge: true, base: '', contract: '' }, '输入框可以输入', {
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

// 契约模式（README.md「契约模式」）。
const CONTRACT = JSON.stringify({ required: ['docs/a.md'], allowed: ['docs/'], approved: { skeleton: {} }, hooks: [] });
const RUNS = JSON.stringify([{ workflow: 'test', state: 'succeeded', runId: 'c1' }]);
const put = (f, path, text) => { mkdirSync(join(f.work, path, '..'), { recursive: true }); writeFileSync(join(f.work, path), text); };
// 在需求分支上提交一批改动（edit 里改工作区），推到远端。
const change = (f, edit, message = 'change') => {
  f.git('fetch', '-q', 'origin', f.state().branch); f.git('switch', '-q', '--detach', 'FETCH_HEAD');
  edit(); f.git('add', '-A'); f.git('commit', '-qm', message); f.git('push', '-q', 'origin', `HEAD:refs/heads/${f.state().branch}`);
};
// 提交验收（options 是勾选项）、跟上目标分支、开 PR，env 与流程里 coda:env 一致；返回 pr 的输出。
const submitContract = (f, options = {}, contract = CONTRACT, env = {}) => {
  f.run('progress', { PROGRESS: JSON.stringify({ choice: 'submit', note: '汇报', options }), ...env });
  f.run('sync-base', { FIXER: 'true' });
  return f.run('pr', { CONTRACT: contract }).outputs;
};
const gate = (f, pr, contract = CONTRACT, expected = 0) => f.run('gate', { CONTRACT: contract, BASE_COMMIT: pr.base, HEAD_COMMIT: pr.head }, expected).outputs;

test('契约的解析与校验：必须是 JSON 对象，required、allowed、hooks 都有且是非空字符串的数组，allowed 至少一项；别的键不管', () => {
  const good = { required: ['plugins/composer/README.md'], allowed: ['plugins/composer/', 'test/plugins/composer/'], approved: { skeleton: {} }, hooks: [] };
  assert.deepEqual(readContract(JSON.stringify(good)), { contract: good });
  assert.deepEqual(readContract(JSON.stringify({ required: [], allowed: ['a'], hooks: ['deploy'], approved: 3, 别的: null })).error, undefined, '别的键不读不校验，required、hooks 可以是空数组');
  for (const [text, error] of [
    ['{', '不是合法的 JSON'], ['', '不是合法的 JSON'],
    ['[]', '必须是 JSON 对象'], ['"x"', '必须是 JSON 对象'], ['null', '必须是 JSON 对象'], ['3', '必须是 JSON 对象'],
    [JSON.stringify({ allowed: ['a'], hooks: [] }), '缺少 required'],
    [JSON.stringify({ required: [], hooks: [] }), '缺少 allowed'],
    [JSON.stringify({ required: [], allowed: ['a'] }), '缺少 hooks'],
    [JSON.stringify({ required: 'a', allowed: ['a'], hooks: [] }), 'required 必须是数组'],
    [JSON.stringify({ required: [], allowed: { a: 1 }, hooks: [] }), 'allowed 必须是数组'],
    [JSON.stringify({ required: [], allowed: ['a'], hooks: null }), 'hooks 必须是数组'],
    [JSON.stringify({ required: ['a', ''], allowed: ['a'], hooks: [] }), 'required 的第 2 项必须是非空字符串'],
    [JSON.stringify({ required: [], allowed: ['a', 3], hooks: [] }), 'allowed 的第 2 项必须是非空字符串'],
    [JSON.stringify({ required: [], allowed: ['a'], hooks: [null] }), 'hooks 的第 1 项必须是非空字符串'],
    [JSON.stringify({ required: [], allowed: [], hooks: [] }), 'allowed 至少要有一项'],
  ]) assert.deepEqual(readContract(text), { error }, text);
});

test('契约模式开工校验：契约不合规范、没填整体评审者时 branch 非零退出、不建需求分支；留空与现在一样', t => {
  const f = fixture(t);
  const statePath = join(f.root, 'artifacts', 'develop.json');
  const refused = (extra, why) => {
    const result = f.run('branch', extra, 1);
    assert.ok(result.stderr.includes(why), result.stderr);
    assert.equal(f.remote('req/run-1'), '', '没建需求分支');
    assert.equal(existsSync(statePath), false, '没写状态文件');
  };
  refused({ CONTRACT: JSON.stringify({ required: [], allowed: [], hooks: [] }), REVIEWER: 'true' }, '契约不合规范：allowed 至少要有一项');
  refused({ CONTRACT: '{', REVIEWER: 'true' }, '契约不合规范：不是合法的 JSON');
  refused({ CONTRACT, REVIEWER: 'false' }, '契约模式必须填整体评审者');
  refused({ CONTRACT }, '契约模式必须填整体评审者');
  assert.deepEqual(f.run('branch', { CONTRACT, REVIEWER: 'true' }).outputs, { title: '输入框', goal: '输入框可以输入', base: 'main', branch: 'req/run-1' });
  assert.equal(f.remote('req/run-1'), f.remote('main'));
  const g = fixture(t);
  assert.deepEqual(g.run('branch', { CONTRACT: '', REVIEWER: 'false' }).outputs, { title: '输入框', goal: '输入框可以输入', base: 'main', branch: 'req/run-1' }, '留空不校验、不要求整体评审者');
  assert.deepEqual(Object.keys(g.state()).sort(), ['base', 'branch', 'feedback', 'goal', 'report', 'title']);
});

test('范围门禁的判定：越界、没改到的必改项；区域条目与路径条目（目录前缀与完整文件路径）；仓库根 .coda/ 的文件区域条目命中不了', () => {
  const declared = { 文档: ['docs/', 'README.md'], 仓库: ['scripts/', '.coda/'], 插件: ['plugins/composer/'] };
  const check = (allowed, files, required = []) => scopeViolations({ required, allowed }, declared, files);
  assert.deepEqual(check(['docs/'], ['docs/a.md', 'scripts/x.mjs'], ['docs/a.md', 'plugins/composer/README.md']), { outside: ['scripts/x.mjs'], missing: ['plugins/composer/README.md'] });
  assert.deepEqual(check(['docs/'], []), { outside: [], missing: [] });
  assert.deepEqual(check(['docs/'], ['docs/a.md'], ['docs/']), { outside: [], missing: [] });
  // 区域条目：与区域名完全相同，命中归属这个区域的文件（最长前缀归属）；required 同样。
  assert.deepEqual(check(['文档'], ['docs/a.md', 'README.md', 'scripts/x.mjs']), { outside: ['scripts/x.mjs'], missing: [] });
  assert.deepEqual(check(['文档', '插件'], ['docs/a.md'], ['文档', '插件']), { outside: [], missing: ['插件'] });
  assert.deepEqual(check(['docs/'], ['docs/a.md'], ['文档']), { outside: [], missing: [] }, 'required 的区域条目同样按区域命中，与 allowed 无关');
  // 路径条目：以 / 结尾是目录前缀，否则是完整文件路径（不是前缀）。
  assert.deepEqual(check(['docs'], ['docs/a.md']), { outside: ['docs/a.md'], missing: [] }, '没有 / 结尾的 docs 只命中名为 docs 的文件');
  assert.deepEqual(check(['docs'], ['docs']), { outside: [], missing: [] });
  assert.deepEqual(check(['docs/a.md'], ['docs/a.md', 'docs/a.md.bak', 'docs/b.md']), { outside: ['docs/a.md.bak', 'docs/b.md'], missing: [] });
  assert.deepEqual(check(['docs/'], ['docs/x/y.md', 'docs.md', 'mydocs/a.md']), { outside: ['docs.md', 'mydocs/a.md'], missing: [] });
  assert.deepEqual(check(['scripts/'], [], ['scripts/x.mjs']), { outside: [], missing: ['scripts/x.mjs'] });
  // 都不在区域里的文件，区域条目命中不了；没有区域定义时所有条目都是路径条目。
  assert.deepEqual(check(['文档'], ['other/x']), { outside: ['other/x'], missing: [] });
  assert.deepEqual(scopeViolations({ required: ['文档'], allowed: ['文档'] }, {}, ['文档']), { outside: [], missing: [] }, '没有这个区域，「文档」就是路径条目');
  // 仓库根 .coda/：区域条目命中不了（哪怕它属于区域），以 .coda/ 开头的路径条目才行。
  assert.deepEqual(check(['仓库'], ['scripts/x.mjs', '.coda/areas.json', '.coda/workflows/a.bpmn'], ['仓库']), { outside: ['.coda/areas.json', '.coda/workflows/a.bpmn'], missing: [] });
  assert.deepEqual(check(['.coda/'], ['.coda/areas.json', '.coda/workflows/a.bpmn', 'scripts/x.mjs']), { outside: ['scripts/x.mjs'], missing: [] });
  assert.deepEqual(check(['.coda/areas.json'], ['.coda/areas.json', '.coda/other.json']), { outside: ['.coda/other.json'], missing: [] });
  assert.deepEqual(check(['仓库'], ['.coda/areas.json'], ['仓库']), { outside: ['.coda/areas.json'], missing: ['仓库'] }, '只改 .coda/ 下的文件，区域条目的必改项也算没改到');
  assert.deepEqual(check(['仓库', '.coda/'], ['.coda/areas.json'], ['.coda/']), { outside: [], missing: [] });
  // 不在仓库根的 .coda/（如 plugins/composer/.coda/）不受这条限制。
  assert.deepEqual(check(['插件'], ['plugins/composer/.coda/workflows/develop.bpmn'], ['插件']), { outside: [], missing: [] });
  assert.deepEqual(check(['插件', 'plugins/composer/.coda/'], ['plugins/composer/.coda/workflows/develop.bpmn']), { outside: [], missing: [] });
  // 路径含 U+FFFD（无法按 UTF-8 解码）：哪怕与 allowed 的完整路径条目、目录前缀条目字面相符也越界，required 的同名条目也不算命中；别的文件照旧。
  assert.deepEqual(check(['bad-\uFFFD', 'bad/', 'docs/'], ['bad-\uFFFD', 'bad/x-\uFFFD', 'docs/a.md'], ['bad-\uFFFD', 'bad/']), { outside: ['bad-\uFFFD', 'bad/x-\uFFFD'], missing: ['bad-\uFFFD', 'bad/'] });
  assert.deepEqual(check(['文档'], ['docs/a-\uFFFD.md', 'docs/b.md'], ['文档']), { outside: ['docs/a-\uFFFD.md'], missing: [] }, '区域条目同样命中不了，别的文件照常命中');
});

test('范围门禁这一步：改名两侧都算改动文件，区域定义读 base 的，违例带清单回到进行中，通过记下 head，勾「交用户批准」有违例也往下走', t => {
  const f = fixture(t);
  put(f, 'old/a.txt', 'a'); put(f, 'docs/a.md', 'doc'); put(f, '.coda/areas.json', '{ "文档": ["docs/"], "仓库": ["scripts/", ".coda/"] }');
  f.git('add', '-A'); f.git('commit', '-qm', 'seed'); f.git('push', '-q', 'origin', 'main');
  f.run('branch', { CONTRACT, REVIEWER: 'true' });
  change(f, () => {
    mkdirSync(join(f.work, 'new')); f.git('mv', 'old/a.txt', 'new/a.txt'); put(f, 'docs/b.md', 'b'); put(f, 'src/x.txt', 'x');
    put(f, '.coda/areas.json', '{ "文档": ["docs/"], "仓库": ["scripts/", ".coda/"], "源码": ["src/"] }');
  });
  const pr = submitContract(f);
  const contract = (allowed, required = []) => JSON.stringify({ required, allowed, hooks: [] });
  // 改名拆成一删一加：只放行新路径，旧路径越界；删除的文件也算改动文件。
  assert.deepEqual(gate(f, pr, contract(['new/', '文档', '源码', '.coda/'])), { route: 'progress' });
  assert.deepEqual(f.state().gate, { head: pr.head, outside: ['old/a.txt', 'src/x.txt'], missing: [] }, '「源码」不是 base 上的区域：head 上新加的区域不算，它按路径条目');
  assert.equal(f.reason(), `范围门禁没过，需求分支 head ${pr.head}。\n越界的改动（不在契约的 allowed 内）：\n- old/a.txt\n- src/x.txt\n处理：派块把越界的改动拿掉、把必改项补上，再提交验收；确实需要越界，提交验收时勾「交用户批准」，由用户在批准卡上决定。`);
  // 越界与没改到的必改项都写进原因；区域条目（含 head 上改了区域定义的 .coda/areas.json）不能命中仓库根 .coda/ 下的文件。
  assert.deepEqual(gate(f, pr, contract(['new/', 'old/', '文档', 'src/', '仓库'], ['docs/c.md', '仓库'])), { route: 'progress' });
  assert.deepEqual(f.state().gate, { head: pr.head, outside: ['.coda/areas.json'], missing: ['docs/c.md', '仓库'] });
  assert.equal(f.reason(), `范围门禁没过，需求分支 head ${pr.head}。\n越界的改动（不在契约的 allowed 内）：\n- .coda/areas.json\n没改到的必改项（契约的 required）：\n- docs/c.md\n- 仓库\n处理：派块把越界的改动拿掉、把必改项补上，再提交验收；确实需要越界，提交验收时勾「交用户批准」，由用户在批准卡上决定。`);
  assert.equal(f.calls().filter(c => c.args[1] === 'edit').length, 0, 'PR 留着不动');
  // 通过：记下这个 head 过了门禁。
  assert.deepEqual(gate(f, pr, contract(['new/', 'old/a.txt', '文档', 'src/x.txt', '.coda/areas.json'], ['new/a.txt', '文档'])), { route: 'pass' });
  assert.deepEqual(f.state().gate, { head: pr.head, outside: [], missing: [] });
  // 这次勾了「交用户批准」：违例照常算、记进状态文件，但不打回，回来的原因也清掉了。
  submitContract(f, { escalate: true });
  assert.equal(f.state().escalate, true);
  assert.deepEqual(gate(f, pr, contract(['new/'], ['docs/c.md'])), { route: 'pass' });
  assert.deepEqual(f.state().gate, { head: pr.head, outside: ['.coda/areas.json', 'docs/b.md', 'old/a.txt', 'src/x.txt'], missing: ['docs/c.md'] });
  assert.equal(f.reason(), '');
  // 每次提交验收重新取值：下一次不勾，有违例又打回。
  submitContract(f);
  assert.equal(f.state().escalate, false);
  assert.equal(gate(f, pr, contract(['new/'])).route, 'progress');
  // 契约坏了（流程里开工时已经校验过）：这一步也不放行。
  assert.match(f.run('gate', { CONTRACT: '{', BASE_COMMIT: pr.base, HEAD_COMMIT: pr.head }, 1).stderr, /契约不合规范：不是合法的 JSON/);
});

test('范围门禁这一步：路径含非法 UTF-8 字节的改动一定越界、不让必改项算改到，原因里列出它并注明', t => {
  const f = fixture(t);
  f.run('branch', { CONTRACT, REVIEWER: 'true' });
  const base = f.remote('main');
  // 有的文件系统（macOS）不允许非法 UTF-8 的文件名：用 git 底层命令直接造出路径为 bad-\xFF 的提交。
  const plumbing = (args, input) => { const r = spawnSync('git', args, { cwd: f.work, env: f.env, input }); assert.equal(r.status, 0, String(r.stderr)); return r.stdout; };
  const blob = plumbing(['hash-object', '-w', '--stdin'], 'x').toString().trim();
  const tree = plumbing(['mktree', '-z'], Buffer.concat([plumbing(['ls-tree', '-z', base]), Buffer.from(`100644 blob ${blob}\tbad-`), Buffer.from([0xff, 0])])).toString().trim();
  const head = plumbing(['commit-tree', tree, '-p', base, '-m', 'bad path']).toString().trim();
  f.git('push', '-q', 'origin', `${head}:refs/heads/${f.state().branch}`);
  const contract = JSON.stringify({ required: ['bad-\uFFFD'], allowed: ['bad-\uFFFD', 'docs/'], hooks: [] });
  assert.deepEqual(f.run('gate', { CONTRACT: contract, BASE_COMMIT: base, HEAD_COMMIT: head }).outputs, { route: 'progress' });
  assert.deepEqual(f.state().gate, { head, outside: ['bad-\uFFFD'], missing: ['bad-\uFFFD'] });
  const reason = f.reason();
  assert.ok(reason.includes('越界的改动（不在契约的 allowed 内）：\n- bad-\uFFFD（路径无法按 UTF-8 解码）\n'), reason);
  assert.ok(reason.includes('没改到的必改项（契约的 required）：\n- bad-\uFFFD\n处理：'), '必改项那一行不加注明');
});

test('范围门禁在流程里的位置：开 PR 之后、预编与项目检查之前；非契约模式绕过；违例回到进行中', async () => {
  const flow = await definition(), { elements, nodes, values, params, route, next } = flow;
  const into = id => elements.filter(e => e.$type === 'bpmn:SequenceFlow' && e.targetRef === nodes[id]).map(e => e.sourceRef.id).sort();
  assert.equal(next('pr'), 'gate-choice');
  assert.deepEqual(into('pr-fork'), ['after-gate', 'gate-choice'], '两条路都经 pr 到门禁，之后才分叉到预编与项目检查');
  assert.deepEqual([into('gate-choice'), into('gate'), into('after-gate')], [['pr'], ['gate-choice'], ['gate']]);
  assert.deepEqual(into('pr'), ['after-sync', 'after-sync-resolve'], '跟上目标分支的两条路都经 pr');
  for (const [contract, target] of [['', 'pr-fork'], [CONTRACT, 'gate']]) assert.equal(route('gate-choice', { inputs: { contract } }), target);
  assert.deepEqual(params('gate'), { CONTRACT: '=inputs.contract', BASE_COMMIT: '=pr.base', HEAD_COMMIT: '=pr.head', route: undefined });
  assert.equal(nodes.gate.name, '范围门禁');
  assert.equal(route('after-gate', { gate: { route: 'progress' } }), 'resume');
  assert.equal(route('after-gate', { gate: { route: 'pass' } }), 'pr-fork');
  const base = { 'progress-result': { route: 'submit' }, sync: { route: 'pr' }, pr: { checked: false }, gate: { route: 'pass' } };
  assert.deepEqual(walk(flow, 'pr', { ...base, inputs: { contract: CONTRACT } }, ['checks']), ['pr', 'gate-choice', 'gate', 'after-gate', 'pr-fork', 'reuse-checks', 'checks']);
  assert.deepEqual(walk(flow, 'pr', { ...base, inputs: { contract: '' } }, ['checks']), ['pr', 'gate-choice', 'pr-fork', 'reuse-checks', 'checks'], '非契约模式不多跑一步');
  assert.equal(walk(flow, 'pr', { ...base, gate: { route: 'progress' }, inputs: { contract: CONTRACT } }, ['checks', 'resume']).at(-1), 'resume');
  // 开工校验要的输入。
  assert.deepEqual(params('req'), { TITLE: params('req').TITLE, GOAL: params('req').GOAL, BASE: '=inputs.base', CONTRACT: '=inputs.contract', REVIEWER: '=inputs.overallReviewer != null', title: undefined, goal: undefined, base: undefined, branch: undefined });
  assert.deepEqual([params('pr').CONTRACT, params('checks-passed').CONTRACT], ['=inputs.contract', '=inputs.contract']);
  const input = values(flow.process).find(v => v.$type === 'coda:Input' && v.name === 'contract');
  assert.deepEqual([input.label, input.default, input.required], ['契约', '', undefined]);
  for (const text of ['整份契约的 JSON', '留空不启用', 'required', 'allowed', 'hooks', 'approved']) assert.ok(input.description.includes(text), text);
});

test('契约只交给提交验收的项目检查：契约模式且没勾「交用户批准」时 inputs 是 { contract: 原文 }，其余为空；合并前检查、预编、块都不带', async () => {
  const { params } = await definition();
  const inputs = (contract, withContract) => evaluateTyped(params('checks').inputs.slice(1), { inputs: { contract }, pr: typedOutputs({ withContract }) });
  assert.deepEqual(inputs(CONTRACT, 'true'), { contract: CONTRACT }, '原文原样，不重新序列化');
  assert.deepEqual(inputs(CONTRACT, 'false'), {}, '勾了交用户批准：不带');
  assert.deepEqual(inputs('', 'false'), {}, '非契约模式：不带');
  assert.deepEqual(Object.keys(params('premerge')), ['hook', 'commit']);
  assert.ok(!JSON.stringify(params('prebuild')).includes('contract'));
  assert.ok(!JSON.stringify(params('piece')).includes('contract'), '块不传契约');
});

test('「交用户批准」：选项与说明只在契约模式出现', async () => {
  const { nodes, values } = await definition();
  const escalate = values(nodes.progress)[0].options.find(o => o.id === 'escalate');
  assert.deepEqual([escalate.name, escalate.default], ['交用户批准', 'false']);
  assert.ok(escalate.detail.includes('范围门禁有违例也不打回') && escalate.detail.includes('项目检查不按契约校验') && escalate.detail.includes('不自动合并'));
  const shown = (contract, delivery = '') => evaluateTyped(escalate.shown.slice(1), { inputs: { contract, delivery } });
  assert.deepEqual([shown(''), shown(CONTRACT)], [false, true]);
  assert.deepEqual([shown(CONTRACT, 'deliver-run-1'), shown('', 'deliver-run-1')], [false, false], '需求交付的成员没有「交用户批准」');
  const render = (contract, extra = {}) => nodes.progress.documentation[0].text.replace(/{{([\s\S]*?)}}/g, (_, e) => { const v = evaluateTyped(e, { inputs: { ...KICKOFF, delivery: '', ...extra, contract, devices: false }, req: { base: 'main' }, resume: { reason: '' } }); return v ?? ''; });
  // 没填整体评审者、没开自动合并时，契约模式只多下面这一段；整体评审与自动合并的说明按模式分开写，下面单独断言。
  const plain = render('', { overallReviewer: null }), contracted = render(CONTRACT, { overallReviewer: null });
  for (const word of ['契约模式', '范围门禁', '交用户批准']) assert.ok(!plain.includes(word), word);
  assert.equal(contracted.replace(/\n契约模式：.*(?=\n)/, ''), plain, '契约模式只多这一段');
  const added = /\n契约模式：(.*)(?=\n)/.exec(contracted)[1];
  for (const text of ['范围门禁', 'allowed', 'required', '交用户批准', '不打回', '项目检查不按契约校验', '不自动合并', '批准卡']) assert.ok(added.includes(text), text);
  // 需求交付的成员：契约模式的说明照样有范围门禁，但不提「交用户批准」。
  const member = render(CONTRACT, { overallReviewer: null, delivery: 'deliver-run-1' }), memberAdded = /\n契约模式：(.*)(?=\n)/.exec(member)[1];
  for (const text of ['范围门禁', 'allowed', 'required', '回到这里', '改回范围内']) assert.ok(memberAdded.includes(text), text);
  assert.ok(!member.includes('交用户批准'), '成员的说明里没有「交用户批准」');
  // 整体评审与自动合并的说明：非契约模式照旧，契约模式按 head 写。
  const [p, c] = [render('', { autoMerge: true }), render(CONTRACT, { autoMerge: true })];
  for (const text of ['这次运行还没整体评审过时由整体评审者评一次整条需求分支', '只合进了一块且它评成过时跳过', '这次运行一次都没评成过、或整体评审出过必须修时照常由用户批准']) assert.ok(p.includes(text) && !c.includes(text), text);
  for (const text of ['head 与最近一次评完的整体评审的 head 不同时', 'head 没变不重评', '范围门禁在当前 head 上没有违例、整体评审评在当前 head 上且没有必须修', '合并后只跑契约 hooks 里列的流程']) assert.ok(c.includes(text) && !p.includes(text), text);
  const review = nodes.review.documentation[0].text.replace(/{{([\s\S]*?)}}/g, (_, e) => evaluateTyped(e, { inputs: { contract: CONTRACT }, req: {}, pr: {}, overall: {} }) ?? '');
  assert.ok(review.includes('再提交验收会在新 head 上重评') && !review.includes('不再评，要再评'), review);
  const reviewPlain = nodes.review.documentation[0].text.replace(/{{([\s\S]*?)}}/g, (_, e) => evaluateTyped(e, { inputs: { contract: '' }, req: {}, pr: {}, overall: {} }) ?? '');
  assert.ok(reviewPlain.includes('这次运行已经整体评审过，再提交验收不再评，要再评就勾「重新整体评审」。') && !reviewPlain.includes('新 head'), reviewPlain);
});

test('交用户批准的这次提交：整理整体评审的 auto 一律为 false，汇总最前面写明并列出范围门禁的违例，PR 描述不带它；没勾照旧', t => {
  const run = (f, extra) => f.run('overall', { AUTO: 'true', CONTRACT, ...extra }).outputs;
  const prepare = (f, options, files) => {
    f.run('branch', { CONTRACT, REVIEWER: 'true' });
    for (const file of files) change(f, () => put(f, file, file), `块 ${file}\n\nCoda-Piece: piece-${file}`), f.run('piece-landed', { TITLE: file, COMMIT: 'c'.repeat(40), PIECE_RUN: `piece-${file}`, REVIEWED: 'true' });
    const pr = submitContract(f, options);
    assert.equal(gate(f, pr).route, 'pass');
    f.run('overall-plan', { REVIEWER: 'true' });
    return pr;
  };
  const banner = '【交用户批准】这次提交是主 Agent 交给用户批准的，项目检查没有按契约校验，不自动合并。\n范围门禁的违例：';
  // 勾了、有违例：auto 为 false，不管整体评审评没评成。
  const f = fixture(t), pr = prepare(f, { escalate: true }, ['one']);
  const escalated = run(f, { SUMMARY: pr.summary });
  assert.deepEqual([escalated.route, escalated.auto], ['accept', 'false']);
  assert.equal(escalated.summary, `${banner}\n越界的改动（不在契约的 allowed 内）：\n- one\n没改到的必改项（契约的 required）：\n- docs/a.md\n\n${pr.summary}`);
  f.run('overall-reviewed', reviewed([{ level: 'nit', title: '变量名', location: 'one:1' }]));
  const minor = run(f, { SUMMARY: pr.summary });
  assert.equal(minor.auto, 'false');
  assert.ok(minor.summary.startsWith(banner) && minor.summary.includes('整体评审的小问题'), minor.summary);
  const edit = f.calls().find(c => c.args[1] === 'edit');
  assert.ok(edit.body.startsWith(pr.summary) && !edit.body.includes('交用户批准'), '说明只在批准卡和待交付卡的汇总里，不进 PR 描述');
  // 勾了、没有违例：写明没有。
  const g = fixture(t), clean = prepare(g, { escalate: true }, ['docs/a.md']);
  g.run('overall-reviewed', reviewed([]));
  const ok = run(g, { SUMMARY: clean.summary });
  assert.deepEqual([ok.auto, ok.summary], ['false', `${banner}没有。\n\n${clean.summary}`]);
  // 没勾：与非契约模式一样，auto 照 autoMerge 与评审判定，汇总不加说明。
  const h = fixture(t), plain = prepare(h, {}, ['docs/a.md']);
  h.run('overall-reviewed', reviewed([]));
  assert.deepEqual([run(h, { SUMMARY: plain.summary }).auto, run(h, { SUMMARY: plain.summary }).summary], ['true', plain.summary]);
  assert.equal(run(h, { SUMMARY: plain.summary, AUTO: 'false' }).auto, 'false');
  // 非契约模式（没有 CONTRACT）即使状态里有 escalate 也不受影响。
  assert.deepEqual([run(h, { SUMMARY: plain.summary, CONTRACT: '' }).auto, run(h, { SUMMARY: plain.summary, CONTRACT: '' }).summary], ['true', plain.summary]);
});

test('需求交付的成员运行（delivery 非空）没有「交用户批准」：答复里传了 escalate 也记为没勾，门禁有违例回到进行中、项目检查带契约、汇总没有批准说明', t => {
  const f = fixture(t);
  f.run('branch', { CONTRACT, REVIEWER: 'true' }); change(f, () => put(f, 'other.txt', 'x'));
  const pr = submitContract(f, { escalate: true }, CONTRACT, { DELIVERY: 'deliver-run-1' });
  assert.equal(pr.withContract, 'true');
  assert.deepEqual([f.state().escalate, f.state().member], [false, true]);
  assert.deepEqual(gate(f, pr), { route: 'progress' });
  const reason = f.reason();
  assert.ok(reason.includes('- other.txt') && reason.endsWith('再提交验收。') && !reason.includes('交用户批准'), reason);
  f.run('overall-plan', { REVIEWER: 'true' });
  const overall = f.run('overall', { AUTO: 'true', CONTRACT, SUMMARY: pr.summary }).outputs;
  assert.deepEqual([overall.auto, overall.summary], ['false', pr.summary], '汇总最前面没有「交用户批准」的说明');
  // 独立的需求运行（没有 DELIVERY）同样的答复照旧记为勾了。
  const g = fixture(t);
  g.run('branch', { CONTRACT, REVIEWER: 'true' }); change(g, () => put(g, 'other.txt', 'x'));
  assert.equal(submitContract(g, { escalate: true }, CONTRACT, { DELIVERY: '' }).withContract, 'false');
  assert.deepEqual([g.state().escalate, g.state().member], [true, false]);
});

test('项目检查结果的复用区分带不带契约：同一个 head，不带契约通过的不能当带契约通过用，反过来也不行；同一模式照常复用', t => {
  const f = fixture(t); f.run('branch', { CONTRACT, REVIEWER: 'true' }); change(f, () => put(f, 'docs/a.md', 'doc'));
  const passed = () => f.run('checks-passed', { RUNS, CONTRACT });
  const checked = options => submitContract(f, options).checked;
  assert.equal(checked({}), 'false');
  passed();
  assert.equal(f.state().checks.contract, true, '记下这次通过时带了契约');
  assert.equal(checked({}), 'true', '同一个 head、同样带契约：复用');
  assert.equal(checked({ again: true }), 'true');
  assert.equal(checked({ escalate: true }), 'false', '带契约通过的不能当作不带契约通过');
  passed();
  assert.equal(f.state().checks.contract, false, '勾了交用户批准：这次的项目检查没带契约');
  assert.equal(checked({ escalate: true }), 'true', '同一个 head、同样不带契约：复用');
  assert.equal(checked({}), 'false', '不带契约通过的不能当作带契约通过');
  passed();
  assert.equal(checked({}), 'true');
  change(f, () => put(f, 'docs/b.md', 'more'));
  assert.equal(checked({}), 'false', 'head 变了照旧重跑');
  // 非契约模式：照旧按 head 复用。
  const g = fixture(t); g.run('branch'); g.land('one', 'first'); g.progress('submit', '汇报');
  assert.equal(g.run('pr').outputs.checked, 'false');
  g.run('checks-passed', { RUNS });
  assert.equal(g.run('pr').outputs.checked, 'true');
});

test('pr 输出的 withContract 是带不带契约的唯一判定：契约模式没勾为 true，契约模式勾了、非契约模式为 false', t => {
  const f = fixture(t); f.run('branch', { CONTRACT, REVIEWER: 'true' }); change(f, () => put(f, 'docs/a.md', 'doc'));
  assert.equal(submitContract(f).withContract, 'true');
  assert.equal(submitContract(f, { again: true }).withContract, 'true');
  assert.equal(submitContract(f, { escalate: true }).withContract, 'false');
  assert.equal(submitContract(f).withContract, 'true', '每次提交验收重新取值');
  const g = fixture(t); g.run('branch'); g.land('one', 'first'); g.progress('submit', '汇报');
  assert.equal(g.run('pr').outputs.withContract, 'false');
});

test('范围门禁：.gitmodules 里写了 ignore = all 的子模块，只更新指针的提交也算改动文件', t => {
  const f = fixture(t);
  const link = sha => f.git('update-index', '--add', '--cacheinfo', `160000,${sha},vendor/lib`);
  put(f, '.gitmodules', '[submodule "vendor/lib"]\n\tpath = vendor/lib\n\turl = ../lib.git\n\tignore = all\n');
  f.git('add', '.gitmodules'); link('1'.repeat(40)); f.git('commit', '-qm', 'submodule'); f.git('push', '-q', 'origin', 'main');
  f.run('branch', { CONTRACT, REVIEWER: 'true' });
  // 只更新指针的提交：不经 git add -A（工作区没有检出子模块，add -A 会把它当作删除）。
  f.git('fetch', '-q', 'origin', f.state().branch); f.git('switch', '-q', '--detach', 'FETCH_HEAD');
  link('2'.repeat(40)); f.git('commit', '-qm', 'pointer'); f.git('push', '-q', 'origin', `HEAD:refs/heads/${f.state().branch}`);
  const pr = submitContract(f);
  assert.equal(f.git('ls-tree', pr.head, 'vendor/lib'), `160000 commit ${'2'.repeat(40)}\tvendor/lib`, '提交后仍是子模块（160000），指向新的提交');
  assert.equal(f.git('diff', '--name-only', `${pr.base}...${pr.head}`), '', 'ignore = all 下普通 diff 看不到指针变化');
  assert.equal(gate(f, pr, JSON.stringify({ required: [], allowed: ['docs/'], hooks: [] })).route, 'progress');
  assert.deepEqual(f.state().gate, { head: pr.head, outside: ['vendor/lib'], missing: [] });
  assert.equal(gate(f, pr, JSON.stringify({ required: ['vendor/lib'], allowed: ['vendor/lib'], hooks: [] })).route, 'pass');
});

// 契约模式的整体评审按 head 走（README.md「整体评审」）：round 在需求分支上提一个改动（change 为 false 时 head 不变），提交验收、过门禁、定整体评审。
const contracted = (t, hooks = []) => {
  const contract = JSON.stringify({ required: ['docs/a.md'], allowed: ['docs/'], hooks });
  const f = fixture(t); f.run('branch', { CONTRACT: contract, REVIEWER: 'true' });
  let n = 0;
  const round = (options = {}, change_ = true) => {
    if (change_) change(f, () => put(f, 'docs/a.md', `v${n++}`));
    const pr = submitContract(f, options, contract);
    assert.equal(gate(f, pr, contract).route, 'pass');
    return { pr, plan: (extra = {}) => f.run('overall-plan', { REVIEWER: 'true', CONTRACT: contract, ...extra }).outputs.review };
  };
  const overall = (pr, extra = {}) => f.run('overall', { SUMMARY: pr.summary, AUTO: 'true', CONTRACT: contract, ...extra }).outputs;
  return { f: Object.assign(f, { contract }), contract, round, overall };
};

test('契约模式定整体评审按 head：head 变了就评，没变不评，勾「重新整体评审」一定评；没评成不算评过；只合进一块且它评成过也评', t => {
  const { f, round } = contracted(t);
  mkdirSync(join(f.work, 'docs'));
  f.land('docs/b.md', 'x', '块一\n\nCoda-Piece: piece-1');
  f.run('piece-landed', { TITLE: '块一', COMMIT: 'c'.repeat(40), PIECE_RUN: 'piece-1', REVIEWED: 'true' });
  let { plan } = round();
  assert.deepEqual(f.state().landed, ['piece-1']);
  assert.equal(plan(), 'true', '只合进了一块且它评成过：契约模式照样评');
  assert.equal(plan({ REVIEWER: 'false' }), 'false', '没填整体评审者不评');
  // 没评成（调用没成、没评完）：最近一次评完的还没有，照样评；评完后同一 head 不评。
  f.run('overall-lost');
  ({ plan } = round({}, false));
  assert.equal(plan(), 'true');
  f.run('overall-reviewed', reviewed([], { DECISION: 'INCOMPLETE', LINE: '评审没有完成：没有合格的 review 代码块', FINDINGS: '[]', REPORT: '' }));
  ({ plan } = round({}, false));
  assert.equal(plan(), 'true');
  f.run('overall-reviewed', reviewed([]));
  ({ plan } = round({}, false));
  assert.equal(plan(), 'false', '同一个 head 已评完：不重评');
  ({ plan } = round({ again: true }, false));
  assert.equal(plan(), 'true', '勾了「重新整体评审」：同一个 head 也评');
  ({ plan } = round({}, false));
  assert.equal(plan(), 'false', '勾选只管这一次提交');
  // head 变了：评；评完了那一个 head 又不评。又一次没评成不动最近一次评完的 head，仍然评。
  ({ plan } = round());
  assert.equal(plan(), 'true', 'head 变了');
  f.run('overall-lost');
  ({ plan } = round({}, false));
  assert.equal(plan(), 'true', '新 head 上没评成：最近一次评完的仍是旧 head');
  f.run('overall-reviewed', reviewed([]));
  ({ plan } = round({}, false));
  assert.equal(plan(), 'false');
  assert.equal(f.state().overall.head, f.state().head);
});

test('契约模式的 auto：开了 autoMerge、没勾「交用户批准」、门禁在当前 head 上无违例、最近一次评完的整体评审就是当前 head 且没有必须修；旧提交上出过的必须修不再粘住', t => {
  const { f, round, overall } = contracted(t);
  const must = [{ level: 'must', title: '登录后停在空白页', location: 'app.mjs:3' }];
  const verdict = (pr, extra) => { const { route, auto } = overall(pr, extra); return [route, auto]; };
  // 第一个 head：评出必须修，交主 Agent，不自动合并。
  let { pr, plan } = round();
  assert.equal(plan(), 'true');
  f.run('overall-reviewed', reviewed(must));
  assert.deepEqual(verdict(pr), ['review', 'false']);
  assert.equal(f.state().overallMust, true);
  // 修好后新 head 上重评、没有必须修：自动合并（不再粘住）。
  ({ pr, plan } = round());
  assert.equal(plan(), 'true');
  f.run('overall-reviewed', reviewed([]));
  assert.deepEqual(verdict(pr), ['accept', 'true']);
  assert.equal(overall(pr, { AUTO: 'false' }).auto, 'false', '没开 autoMerge');
  // 同一个 head 再提交验收（不重评）：评审与门禁都还是当前 head，照样自动合并。
  ({ pr, plan } = round({}, false));
  assert.equal(plan(), 'false');
  assert.equal(overall(pr).auto, 'true');
  // 勾了「交用户批准」：不自动合并。
  ({ pr, plan } = round({ escalate: true }, false));
  plan();
  assert.equal(overall(pr).auto, 'false');
  // 同一个 head 已有评完且没有必须修的整体评审：没发起重评，照旧复用，auto 为 true；勾「重新整体评审」再评但没评成（调用没成、没评完），auto 为 false，route 仍是 review。
  ({ pr, plan } = round());
  assert.equal(plan(), 'true');
  f.run('overall-reviewed', reviewed([]));
  ({ pr, plan } = round({}, false));
  assert.equal(plan(), 'false');
  assert.deepEqual(verdict(pr), ['accept', 'true'], '没发起重评：复用同一个 head 上评完的结果');
  ({ pr, plan } = round({ again: true }, false));
  assert.equal(plan(), 'true');
  f.run('overall-lost');
  assert.deepEqual(verdict(pr), ['review', 'false'], '重评的调用没成功');
  ({ pr, plan } = round({ again: true }, false));
  assert.equal(plan(), 'true');
  f.run('overall-reviewed', reviewed([], { DECISION: 'INCOMPLETE', LINE: '评审没有完成', FINDINGS: '[]', REPORT: '' }));
  assert.deepEqual(verdict(pr), ['review', 'false'], '重评没评完');
  assert.equal(f.state().overall.head, f.state().head, '最近一次评完的还是同一个 head 上的那份');
  // 下一次不重评的提交：outcome 清掉，又复用那份，auto 为 true。
  ({ pr, plan } = round({}, false));
  assert.equal(plan(), 'false');
  assert.deepEqual(verdict(pr), ['accept', 'true']);
  // 评审是旧 head 的：新 head 上没评成（调用没成、没评完）。
  ({ pr, plan } = round());
  assert.equal(plan(), 'true');
  f.run('overall-lost');
  assert.equal(overall(pr).auto, 'false', '新 head 上没评成：最近一次评完的是旧 head');
  f.run('overall-reviewed', reviewed([], { DECISION: 'INCOMPLETE', LINE: '评审没有完成', FINDINGS: '[]', REPORT: '' }));
  assert.deepEqual(verdict(pr), ['review', 'false'], '没评完不算评完');
  // 当前 head 有必须修。
  f.run('overall-reviewed', reviewed(must));
  assert.deepEqual(verdict(pr), ['review', 'false']);
  // 门禁是旧 head 算的：新 head 评好了，但没有对新 head 跑过门禁。
  const oldGate = f.state().gate;
  change(f, () => put(f, 'docs/a.md', 'newer'));
  const next = submitContract(f, {}, f.contract);
  assert.notEqual(next.head, oldGate.head);
  f.run('overall-plan', { REVIEWER: 'true', CONTRACT });
  f.run('overall-reviewed', reviewed([]));
  assert.equal(overall(next).auto, 'false', '门禁记的是旧 head');
  assert.deepEqual(f.state().gate, oldGate);
  // 门禁在当前 head 上有违例：不自动合并（正常走到这里只有勾了交用户批准，这里直接改状态核对判定本身）。
  assert.equal(gate(f, next, f.contract).route, 'pass');
  assert.equal(overall(next).auto, 'true');
  for (const violation of [{ outside: ['x'], missing: [] }, { outside: [], missing: ['docs/b.md'] }]) {
    const state = f.state(); writeFileSync(join(f.env.CODA_ARTIFACTS, 'develop.json'), JSON.stringify({ ...state, gate: { ...state.gate, ...violation } }));
    assert.equal(overall(next).auto, 'false', JSON.stringify(violation));
  }
});

// hook-joiners 的列表：lint 声明了默认勾选，但不在任何白名单里。
const LIST = JSON.stringify([
  { id: 'deploy', name: '部署', default: false },
  { id: 'lint', name: '代码检查', default: true },
  { id: 'publish-preview', name: '发布预览版', default: false, inputs: [{ id: 'notes', label: '发布说明' }] },
]);

test('自动合并在「读取批准」里合成答复：只勾契约 hooks 白名单里的加入者，没写的不勾（含默认勾选的）；白名单为空 only 是 []；批准卡留着旧答复也不读', t => {
  const f = fixture(t); f.run('branch');
  const contract = hooks => JSON.stringify({ required: [], allowed: ['a'], hooks });
  const auto = (hooks, extra = {}) => f.run('approval', { AUTO: 'true', CONTRACT: hooks ? contract(hooks) : '', JOINERS: LIST, ...extra }).outputs;
  assert.deepEqual(auto(['deploy']), { route: 'merge', only: '["deploy"]', picked: '部署', inputs: '{}', missing: '', asks: '', needs: '{}' });
  assert.equal(auto(['deploy', 'publish-preview']).only, '["deploy","publish-preview"]', '按列表的顺序');
  assert.deepEqual([auto([]).route, auto([]).only], ['merge', '[]'], '白名单为空');
  assert.deepEqual(auto(null), { route: 'merge', only: '[]', picked: '', inputs: '{}', missing: '', asks: '', needs: '{}' }, '非契约模式只开 autoMerge：白名单是空的，默认勾选的也不跑');
  // 白名单里的加入者要文字：卡上没有写，交主 Agent 补填（missing、asks、needs 照旧）。
  assert.deepEqual([auto(['publish-preview']).missing, auto(['publish-preview']).asks, auto(['publish-preview']).needs], ['notes', '「发布说明」：发布预览版要', '{"notes":["publish-preview"]}']);
  // 早先出过批准卡、用户选过「暂不合并」：之后自动路径不读那份旧答复。
  const stale = JSON.stringify({ choice: 'stop', note: '先别合', options: { lint: true } });
  assert.deepEqual([auto(['deploy'], { APPROVAL: stale }).route, auto(['deploy'], { APPROVAL: stale }).only], ['merge', '["deploy"]']);
  assert.equal(auto(null, { APPROVAL: stale }).route, 'merge');
  assert.equal(auto(['deploy'], { APPROVAL: 'null' }).only, '["deploy"]', '这条路上没有批准卡');
  assert.equal(f.reason(), '', '没有回到进行中');
  // 人工路径（没有 AUTO）不受 hooks 约束，照旧按用户在卡上的勾选。
  const manual = f.run('approval', { AUTO: 'false', CONTRACT: contract(['deploy']), JOINERS: LIST, APPROVAL: JSON.stringify({ choice: 'merge', options: { lint: true, 'publish-preview': true }, inputs: { notes: '说明' } }) }).outputs;
  assert.deepEqual([manual.route, manual.only, manual.inputs], ['merge', '["lint","publish-preview"]', '{"notes":"说明"}']);
  assert.match(f.run('approval', { AUTO: 'false', CONTRACT: contract(['deploy']), JOINERS: LIST, APPROVAL: JSON.stringify({ choice: 'stop', note: '再等等' }) }).outputs.route, /stop/);
  assert.match(f.reason(), /用户选了暂不合并：\n再等等/);
});

test('自动合并时白名单里有不是当前 head 上挂点 merged 加入者的名字：不合并，带着原因回到进行中，原因写明名字和当前有哪些加入者', t => {
  const f = fixture(t); f.run('branch');
  const out = f.run('approval', { AUTO: 'true', CONTRACT: JSON.stringify({ required: [], allowed: ['a'], hooks: ['deploy', 'ghost', 'phantom'] }), JOINERS: LIST }).outputs;
  assert.deepEqual([out.route, out.only, out.picked], ['stop', '[]', '']);
  const reason = f.reason();
  assert.match(reason, /自动合并没有合并/);
  assert.ok(reason.includes('不是需求分支 head 上挂点 merged 的加入者：ghost、phantom。'), reason);
  assert.ok(reason.includes('当前 head 上挂点 merged 的加入者：deploy、lint、publish-preview'), reason);
  assert.match(reason, /交用户批准/);
  // 没有任何加入者。
  f.run('approval', { AUTO: 'true', CONTRACT: JSON.stringify({ required: [], allowed: ['a'], hooks: ['deploy'] }), JOINERS: '[]' });
  assert.ok(f.reason().includes('当前 head 上挂点 merged 的加入者：没有'), f.reason());
});

test('假宿主走一遍契约模式加自动合并加非空白名单：门禁、带契约的项目检查、当前 head 的整体评审、列出加入者后不出批准卡，合并后只跑白名单里的，结束时 afterMerge 逐项列出、notify 为 true', async t => {
  const f = fixture(t);
  const contract = JSON.stringify({ required: ['one'], allowed: ['one'], approved: { skeleton: {} }, hooks: ['deploy'] });
  const progress = [{ choice: 'piece', note: '块一\n做第一块' }, { choice: 'submit', note: '做了什么\n- 输入框能输入\n需要你知道：无', options: { again: false, escalate: false } }];
  const reviews = [];
  const joiners = [{ id: 'deploy', name: '部署', default: false }, { id: 'lint', name: '代码检查', default: true }];
  const { nodes, values, params } = await definition();
  const run = await host(f, { title: '输入框', devices: false, device: '', hold: '', delivery: '', executor: { agent: 'codex' }, executor2: null, reviewer: { agent: 'kimi' },
    overallReviewer: { agent: 'grok' }, autoMerge: true, base: '', contract }, '输入框可以输入', {
    progress: () => progress.shift(),
    piece: () => ({ commit: f.land('one', 'first', '块一\n\nCoda-Piece: piece-1'), run: 'piece-1', reviewed: true }),
    checks: () => ({ runs: [{ workflow: 'test', state: 'succeeded', runId: 'c1' }] }),
    'overall-call': () => { reviews.push(f.state().head); return { decision: 'APPROVE', line: '评审通过', report: '评审原文', findings: '[]', head: f.state().head }; },
    joiners: () => ({ list: joiners }),
    'run-merged': () => ({ runs: [{ workflow: 'deploy', runId: 'r1', state: 'succeeded' }] }),
  });
  const { visited, cards, context } = run;
  const at = id => visited.indexOf(id);
  assert.deepEqual(visited.filter(id => ['pr', 'gate', 'checks', 'checks-passed', 'overall-plan', 'overall-call', 'overall-reviewed', 'overall', 'premerge', 'github-checks', 'joiners', 'auto-merge-choice', 'approval-result', 'merge', 'merged-inputs', 'run-merged', 'after-run'].includes(id)),
    ['pr', 'gate', 'checks', 'checks-passed', 'overall-plan', 'overall-call', 'overall-reviewed', 'overall', 'premerge', 'github-checks', 'joiners', 'auto-merge-choice', 'approval-result', 'merge', 'merged-inputs', 'run-merged', 'after-run']);
  assert.ok(at('gate') < at('checks') && at('github-checks') < at('joiners') && at('joiners') < at('auto-merge-choice'), '门禁在项目检查前，加入者在是否自动合并前');
  assert.ok(!visited.includes('approve') && !cards.some(c => c.step === 'approve'), '不出批准卡');
  assert.equal(run.end, 'done');
  assert.deepEqual(evaluateTyped(params('checks').inputs.slice(1), context), { contract }, '项目检查带契约');
  assert.deepEqual([reviews.length, reviews[0], f.state().overall.head], [1, f.state().head, f.state().head], '整体评审评在当前 head 上');
  assert.deepEqual(f.state().gate, { head: f.state().head, outside: [], missing: [] });
  assert.deepEqual([context.overall.auto, context['approval-result'].route, context['approval-result'].only], [true, 'merge', '["deploy"]'], '只勾白名单里的，默认勾选的 lint 不跑');
  assert.equal(context['merged-inputs'].only, '["deploy"]');
  assert.ok(f.calls().some(c => c.args[1] === 'merge' && c.args.includes('--match-head-commit') && c.args.includes(f.state().head)), '合并了需求分支 head');
  const out = name => evaluateTyped(values(nodes.done).find(v => v.name === name).value.slice(1), context);
  assert.equal(out('afterMerge'), '合并后的流程已全部结束，不用再等：部署：成功');
  assert.equal(out('notify'), true);
  assert.equal(evaluateTyped(nodes.done.notify.slice(1), context), true);
});
