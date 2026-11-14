// The simple development flow (plugins/review/.coda/workflows/simple.bpmn): its routes as Coda reads them, and its steps
// against a throwaway repository, a fake gh and the run's artifacts.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readWorkflow } from '@coda-console/protocol/workflow';
import { evaluate } from 'feelin';

const script = fileURLToPath(new URL('../../../plugins/review/scripts/simple.mjs', import.meta.url));
const workflow = readFileSync(new URL('../../../plugins/review/.coda/workflows/simple.bpmn', import.meta.url), 'utf8');

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'review-simple-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const work = join(root, 'work'), origin = join(root, 'origin.git'), bin = join(root, 'bin'), artifacts = join(root, 'artifacts');
  for (const path of [work, bin, artifacts]) mkdirSync(path);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CODA_ARTIFACTS: artifacts, RUNNER_TEMP: root, FIXTURE: root,
    GITHUB_RUN_ID: 'run-1', GITHUB_OUTPUT: join(root, 'outputs'), BRANCH: 'agent/work', BASE: '',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'false', GIT_CONFIG_KEY_1: 'core.hooksPath', GIT_CONFIG_VALUE_1: '/dev/null' };
  const git = (...args) => {
    const done = spawnSync('git', args, { cwd: work, env, encoding: 'utf8' });
    assert.equal(done.status, 0, done.stderr);
    return done.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  writeFileSync(join(work, 'base'), 'base'); git('add', 'base'); git('commit', '-qm', 'base');
  git('init', '--bare', '-q', origin); git('remote', 'add', 'origin', origin); git('push', '-q', 'origin', 'main');
  const commit = (file, text) => { writeFileSync(join(work, file), text); git('add', file); git('commit', '-qm', text); return git('rev-parse', 'HEAD'); };
  // gh: the repository's default branch, a pull request it opens and edits, and its state after a merge as GH_STATE says.
  writeFileSync(join(bin, 'gh'), `#!${process.execPath}\n${String.raw`
const { appendFileSync, readFileSync } = require('node:fs');
const args = process.argv.slice(2), root = process.env.FIXTURE;
const body = args.includes('--body-file') ? readFileSync(args[args.indexOf('--body-file') + 1], 'utf8') : null;
appendFileSync(root + '/gh-calls', JSON.stringify({ args, body }) + '\n');
if (args[0] === 'repo') console.log('main');
else if (args[1] === 'create') console.log('https://github.com/acme/app/pull/7');
else if (args[1] === 'merge') { if (process.env.MERGE_EXIT) { console.error('merge refused'); process.exit(Number(process.env.MERGE_EXIT)); } }
else if (args[1] === 'view') console.log(JSON.stringify({ state: process.env.GH_STATE || 'MERGED', mergeable: process.env.GH_MERGEABLE || 'MERGEABLE', mergeCommit: { oid: 'f'.repeat(40) } }));
`}`);
  chmodSync(join(bin, 'gh'), 0o755);
  writeFileSync(join(root, 'gh-calls'), '');
  const run = (action, extra = {}, expected = 0) => {
    writeFileSync(env.GITHUB_OUTPUT, '');
    const done = spawnSync(process.execPath, [script, action], { cwd: work, env: { ...env, ...extra }, encoding: 'utf8' });
    assert.equal(done.status, expected, done.stderr);
    return Object.fromEntries([...readFileSync(env.GITHUB_OUTPUT, 'utf8').matchAll(/(\w+)<<([^\n]+)\n([\s\S]*?)\n\2\n/g)].map(([, key, , value]) => [key, value]));
  };
  const calls = () => readFileSync(join(root, 'gh-calls'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const state = () => JSON.parse(readFileSync(join(artifacts, 'simple.json'), 'utf8'));
  const remote = ref => spawnSync('git', ['ls-remote', origin, ref], { encoding: 'utf8' }).stdout.split('\t')[0];
  return { work, git, commit, run, calls, state, remote };
}

test('简易开发推送主 Agent 分支的最新提交到运行自己的分支，开一个 PR，之后每次修改更新同一个 PR', t => {
  const f = fixture(t);
  const report = '做了什么\n- 输入框可以正常输入\n需要你知道：无';
  // 分支还没有比目标分支新的提交：交回主 Agent 的「交上改动」。
  f.git('branch', 'agent/work');
  assert.deepEqual(f.run('push', { REPORT: JSON.stringify({ choice: 'done', note: report }) }), {
    feedback: '分支 agent/work 上没有比 main 新的提交：请把改动提交到这个分支再答复。', route: 'report' });
  f.git('switch', '-q', 'agent/work');
  const first = f.commit('input', '修好输入框');
  const pushed = f.run('push', { REPORT: JSON.stringify({ choice: 'done', note: report }) });
  assert.deepEqual(pushed, { route: 'checks', feedback: '', head: first, lane: 'simple/run-1' });
  assert.equal(f.remote('refs/heads/simple/run-1'), first);
  assert.equal(f.remote('refs/heads/agent/work'), '', '主 Agent 的分支不推');
  const opened = f.run('pr', { DEVICES: 'true' });
  assert.deepEqual(opened, { url: 'https://github.com/acme/app/pull/7', head: first, review: 'true', device: 'true', summary: report });
  const created = f.calls().find(c => c.args[1] === 'create');
  assert.deepEqual(created.args.slice(0, 8), ['pr', 'create', '--base', 'main', '--head', 'simple/run-1', '--title', '修好输入框']);
  assert.equal(created.body, report);
  // 评审一次：要求修改后主 Agent 不改，理由写进 PR 与批准卡；之后不再评审。
  f.run('reviewed', { REVIEW: JSON.stringify({ line: '评审要求修改（REQUEST_CHANGES）', report: '### 要求修改\n\n- **[P1]** 漏了空值' }) });
  f.run('kept', { ANSWER: JSON.stringify({ choice: 'kept', note: '空值在上游已挡住' }) });
  const kept = f.run('pr', { DEVICES: 'true' });
  assert.equal(kept.review, 'false');
  assert.equal(kept.summary, `${report}\n\n评审：评审要求修改（REQUEST_CHANGES）\n\n没有照评审意见改的：\n空值在上游已挡住`);
  const edited = f.calls().filter(c => c.args[1] === 'edit');
  assert.deepEqual(edited.map(c => c.args.slice(0, 3)), [['pr', 'edit', 'https://github.com/acme/app/pull/7']]);
  assert.match(edited[0].body, /<details><summary>评审意见<\/summary>\n\n### 要求修改/);
  // 设备验收不行：意见和截图交回主 Agent；没有新提交就答复的，再交回一次。
  assert.deepEqual(f.run('accepted', { ROUTE: 'failed', DEVICE: JSON.stringify({ choice: 'no', note: '', attachments: ['/uploads/a/shot.png'] }) }), {
    feedback: `设备验收不通过（提交 ${first}）：\n附件：\n- /uploads/a/shot.png`, route: 'fix' });
  assert.equal(f.run('problem').text, `设备验收不通过（提交 ${first}）：\n附件：\n- /uploads/a/shot.png`);
  assert.equal(f.run('push').route, 'fix');
  assert.match(f.run('problem').text, /分支 agent\/work 上没有新的提交/);
  const second = f.commit('input', '按截图修好');
  assert.equal(f.run('push').head, second);
  assert.equal(f.remote('refs/heads/simple/run-1'), second);
  assert.equal(f.state().report, report, '开了 PR 之后汇报不变');
  assert.deepEqual(f.run('pr', { DEVICES: 'true' }).device, 'true', '新提交要重新验收');
  assert.deepEqual(f.run('accepted', { ROUTE: 'passed' }), { route: 'premerge' });
  assert.deepEqual([f.run('pr', { DEVICES: 'true' }).device, f.run('pr', { DEVICES: 'false' }).device], ['false', 'false']);
  assert.deepEqual(f.run('accepted', { ROUTE: 'changed' }), { route: 'push' });
  assert.equal(f.calls().filter(c => c.args[1] === 'create').length, 1);
});

test('准备分支：给了就用给的；没给就从目标分支的最新提交开 agent/simple-<运行>，再走同一遍时沿用', t => {
  const f = fixture(t);
  assert.deepEqual(f.run('lane'), { branch: 'agent/work', made: 'false' });
  assert.equal(f.git('branch', '--list', 'agent/*'), '', '给了分支时不替主 Agent 开');
  assert.equal(f.calls().length, 0);

  const made = f.run('lane', { BRANCH: '' });
  assert.deepEqual(made, { branch: 'agent/simple-run-1', made: 'true', base: 'main', repo: realpathSync(f.work) });
  assert.equal(f.git('rev-parse', 'agent/simple-run-1'), f.git('rev-parse', 'origin/main'));
  assert.deepEqual(f.calls().map(c => c.args[0]), ['repo'], '目标分支留空时读仓库的默认分支');
  // 主 Agent 在这条分支上提交，推送照常；再走一遍准备分支，分支不被重置。
  f.git('switch', '-q', 'agent/simple-run-1');
  const head = f.commit('lane', '在流程开的分支上改');
  assert.equal(f.run('push', { BRANCH: 'agent/simple-run-1', REPORT: JSON.stringify({ note: '汇报' }) }).head, head);
  assert.equal(f.run('lane', { BRANCH: '', BASE: 'main' }).branch, 'agent/simple-run-1');
  assert.equal(f.git('rev-parse', 'agent/simple-run-1'), head);
});

test('检查没过交回主 Agent 并写明运行；合并冲突交回，其余合并失败让步骤失败；合并后交出合并提交', t => {
  const f = fixture(t);
  f.git('switch', '-q', '-c', 'agent/work'); const head = f.commit('one', '改动');
  f.run('push', { REPORT: JSON.stringify({ note: '汇报' }) }); f.run('pr', { DEVICES: 'false' });
  f.run('failed', { STEP: 'GitHub 检查', LINES: '\n  - ci：没通过' });
  assert.equal(f.run('problem').text, `GitHub 检查没通过，提交 ${head}。运行：coda://workflow-runs/run-1，用 workflow_status 查看「GitHub 检查」调用的流程、失败的步骤和日志，查明原因修好。\n- ci：没通过`);
  assert.deepEqual(f.run('merge', { METHOD: 'squash' }), { route: 'merged', commit: 'f'.repeat(40) });
  const merged = f.calls().find(c => c.args[1] === 'merge');
  assert.deepEqual(merged.args, ['pr', 'merge', 'https://github.com/acme/app/pull/7', '--repo', 'github.com/acme/app', '--squash', '--match-head-commit', head, '--delete-branch']);
  const conflict = f.run('merge', { MERGE_EXIT: '1', GH_STATE: 'OPEN', GH_MERGEABLE: 'CONFLICTING' });
  assert.equal(conflict.route, 'conflict');
  assert.match(f.run('problem').text, /与目标分支 main 有冲突[\s\S]*合入分支 agent\/work/);
  f.run('merge', { MERGE_EXIT: '1', GH_STATE: 'OPEN', GH_MERGEABLE: 'MERGEABLE' }, 1);
});

test('简易开发的流程定义：开启时什么都不必选，第一张任务不叫醒主 Agent，只评审一轮，拒绝必须附言', async () => {
  const { root, problem } = await readWorkflow(workflow, 'simple'); assert.ok(!problem, problem);
  const process = root.rootElements.find(e => e.$type === 'bpmn:Process');
  const acceptance = process.flowElements.find(e => e.id === 'acceptance');
  assert.equal(acceptance.optional, true);
  const elements = [...process.flowElements, ...acceptance.flowElements];
  const nodes = Object.fromEntries(elements.map(e => [e.id, e]));
  const values = node => node.extensionElements?.values ?? [];
  const params = id => Object.fromEntries(values(nodes[id]).map(v => [v.name, v.value]));
  const route = (id, context) => {
    const node = nodes[id], flows = elements.filter(e => e.sourceRef === node);
    return (flows.find(e => e.conditionExpression && evaluate(e.conditionExpression.body.trim().slice(1), context).value) ?? node.default).targetRef.id;
  };
  assert.equal(process.name, '简易开发');
  assert.equal(process.kind, undefined);
  assert.deepEqual(values(process).filter(v => v.$type === 'coda:Join').map(j => j.hook), ['develop'], '开发流程：加入挂点 develop');
  const inputs = Object.fromEntries(values(process).filter(v => v.$type === 'coda:Input').map(v => [v.name, v]));
  assert.deepEqual([inputs.branch.type, inputs.branch.defaultFrom, inputs.branch.required], ['branch', 'session.branch', undefined], '没给、会话也没有时由准备分支开一条');
  assert.deepEqual([inputs.reviewer.type, inputs.reviewer.defaultFrom, inputs.reviewer.required], ['agent', undefined, undefined], '不选按评审组合');
  assert.deepEqual([inputs.devices.type, inputs.devices.default], ['boolean', 'false']);
  assert.deepEqual([nodes.report.wake, nodes.report.assignee], ['false', undefined]);
  for (const [id, choices] of [['report', [['done', 'required']]], ['answer', [['fixed', undefined], ['kept', 'required']]],
    ['device', [['yes', undefined], ['no', 'required']]], ['approve', [['merge', undefined], ['stop', 'required']]], ['preview', [['installed', undefined], ['changed', 'required']]]])
    assert.deepEqual(values(nodes[id]).map(v => [v.id, v.note]), choices, id);
  for (const id of ['device', 'approve']) assert.equal(nodes[id].assignee, 'user');
  for (const id of ['report', 'answer', 'fix', 'preview', 'fill']) assert.equal(nodes[id].assignee, undefined, id);
  // 先准备分支，之后所有步骤与任务都用它定下的分支。
  assert.equal(nodes['start-lane'].targetRef.id, 'lane');
  assert.equal(nodes['lane-report'].targetRef.id, 'report');
  assert.equal(params('lane').BRANCH, '=inputs.branch');
  for (const id of ['push', 'merge']) assert.equal(params(id).BRANCH, '=lane.branch', id);
  assert.doesNotMatch(workflow, /\{\{inputs\.branch\}\}/);
  const told = evaluate(/\{\{(if lane\.made[\s\S]*?)\}\}/.exec(nodes.report.documentation[0].text)[1], { lane: { made: true, base: 'main', repo: '/work/app' } }).value;
  assert.equal(told, '这条分支是流程从 main 的最新提交替你开的，在仓库 /work/app 里：在那里用 git worktree add 开你自己的工作树，改动提交到这条分支。');
  assert.equal(evaluate(/\{\{(if lane\.made[\s\S]*?)\}\}/.exec(nodes.report.documentation[0].text)[1], { lane: { made: false, branch: 'agent/work' } }).value, '');
  // 推送：没推上去回到交上改动或修改；推上去跑检查。
  for (const [value, target] of [['report', 'report'], ['fix', 'problem'], ['checks', 'checks']]) assert.equal(route('pushed', { push: { route: value } }), target);
  // 开 PR 之后：没评审过先评审，要验收先验收，否则合并前检查。
  for (const [review, device, target] of [[true, true, 'review'], [false, true, 'acceptance'], [false, false, 'premerge']])
    assert.equal(route('after-pr', { pr: { review, device } }), target);
  assert.equal(route('verdict', { review: { changes: true } }), 'answer');
  assert.equal(route('verdict', { review: { changes: false } }), 'after-review');
  assert.equal(route('answer-how', { answer: { chose: { kept: true } } }), 'kept-record');
  assert.equal(route('answer-how', { answer: { chose: { kept: false } } }), 'push');
  assert.equal(nodes['kept-pr'].targetRef.id, 'pr', '不改也只更新 PR，不再评审');
  for (const [value, target] of [['push', 'push'], ['fix', 'problem'], ['premerge', 'premerge']]) assert.equal(route('after-acceptance', { accepted: { route: value } }), target);
  for (const [chose, target] of [[{ changed: true }, 'acceptance-changed'], [{ changed: false }, 'device']]) assert.equal(route('after-preview', { preview: { chose } }), target);
  for (const [passed, target] of [[false, 'github-feedback'], [true, 'joiners']]) assert.equal(route('github-how', { 'github-checks': { passed }, github: { event: {} } }), target);
  for (const [value, target] of [['conflict', 'problem'], ['merged', 'after-merged']]) assert.equal(route('merged', { merge: { route: value } }), target);
  // 批准卡：勾选项是项目在这个提交上加入挂点 merged 的流程，卡上只有数据。
  assert.deepEqual(params('joiners'), { hook: 'merged', commit: '=pr.head' });
  assert.equal(nodes['joiners-approve'].targetRef.id, 'approve');
  assert.deepEqual(values(nodes.approve)[0].options.map(o => [o.id ?? o.value, o.default]), [['=joiners.list', undefined], ['notify', 'true']]);
  assert.doesNotMatch(nodes.approve.documentation[0].text, /「合并」以|部署|发布|暂不合并/);
  assert.deepEqual([params('approval').APPROVED, params('approval').JOINERS], ['=approve', '=joiners.list']);
  // 合并后：没勾就结束；勾了的先补没写的文字，再在合并提交上运行。
  for (const only of ['[]', '["deploy"]']) for (const missing of ['', 'notes']) {
    const visited = [], context = { approval: { only, missing } };
    for (let step = 'after-merged'; step !== 'done';) {
      if (!nodes[step].$type.endsWith('Gateway')) visited.push(step);
      step = nodes[step].$type === 'bpmn:ExclusiveGateway' ? route(step, context) : elements.find(e => e.sourceRef === nodes[step]).targetRef.id;
    }
    assert.deepEqual(visited, only === '[]' ? [] : [...(missing ? ['fill'] : []), 'merged-inputs', 'run-merged'], `${only}|${missing}`);
  }
  assert.deepEqual([nodes.fill.loopCharacteristics.isSequential, nodes.fill.loopCharacteristics.inputCollection], [true, '=split(approval.missing, ",")']);
  assert.deepEqual(values(nodes.fill).filter(v => v.$type === 'coda:Choice').map(v => [v.id, v.note]), [['done', 'required'], ['skip', undefined]]);
  assert.deepEqual([params('merged-inputs').FILLS, params('merged-inputs').MISSING, params('merged-inputs').NEEDS, params('merged-inputs').ONLY], ['=fill', '=approval.missing', '=approval.needs', '=approval.only']);
  for (const id of ['kinds', 'notes', 'publishing', 'deploy', 'publish']) assert.equal(nodes[id], undefined, id);
  assert.equal(route('approved', { approve: { chose: { stop: true } } }), 'stopped');
  assert.equal(route('approved', { approve: { chose: { stop: false } } }), 'approval');
  // 所有要主 Agent 修改的都先读出要改的地方，再进「修改后答复」，从推送重走。
  assert.deepEqual(elements.filter(e => e.targetRef?.id === 'fix').map(e => e.sourceRef.id), ['problem']);
  assert.deepEqual(elements.filter(e => e.targetRef?.id === 'problem').map(e => e.sourceRef.id).sort(), ['after-acceptance', 'checks-feedback', 'github-feedback', 'merged', 'premerge-feedback', 'pushed']);
  assert.equal(nodes['fix-push'].targetRef.id, 'push');
  assert.deepEqual(params('review').REVIEWER, '=inputs.reviewer');
  assert.deepEqual(params('checks'), { hook: 'check', commit: '=push.head' });
  assert.deepEqual(params('premerge'), { hook: 'premerge', commit: '=pr.head' });
  assert.deepEqual(params('run-merged'), { hook: 'merged', only: '=merged-inputs.only', commit: '=merge.commit', inputs: '=merged-inputs.inputs' });
  for (const [failed, target] of [['checks-failed', 'checks'], ['premerge-failed', 'premerge']]) assert.equal(nodes[failed].attachedToRef.id, target);
  assert.equal(evaluate(nodes.done.notify.slice(1), { approval: { notify: false } }).value, false);
});

// What "这一项这次不跑" does after the merge: the session writes no text for an input, so every ticked workflow asking for it
// drops out of `only` and the rest run; with none left the run ends as merged without run-workflows.
async function afterSkip(t, ticked, fills) {
  const root = mkdtempSync(join(tmpdir(), 'review-simple-skip-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scripts = fileURLToPath(new URL('../../../plugins/review/scripts/approval.mjs', import.meta.url)), out = join(root, 'out');
  const run = (args, env) => {
    writeFileSync(out, '');
    const done = spawnSync(process.execPath, [scripts, ...args], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, GITHUB_OUTPUT: out, ...env } });
    assert.equal(done.status, 0, done.stderr);
    return Object.fromEntries([...readFileSync(out, 'utf8').matchAll(/(\w+)<<EOF_\1\n([\s\S]*?)\nEOF_\1\n/g)].map(([, k, v]) => [k, v]));
  };
  const JOINERS = JSON.stringify([
    { id: 'deploy', name: '部署' },
    { id: 'publish-preview', name: '发布预览版', inputs: [{ id: 'notes', label: '发布说明' }] },
    { id: 'publish-release', name: '发布正式版', inputs: [{ id: 'notes', label: '发布说明' }] },
  ]);
  const approval = run([], { APPROVED: JSON.stringify({ choice: 'merge', options: Object.fromEntries(ticked.map(id => [id, true])), inputs: {} }), JOINERS });
  const merged = run(['inputs'], { INPUTS: approval.inputs, MISSING: approval.missing, ASKS: approval.asks, NEEDS: approval.needs, ONLY: approval.only, FILLS: JSON.stringify(fills) });
  const { root: definition, problem } = await readWorkflow(workflow, 'simple'); assert.ok(!problem, problem);
  const flow = definition.rootElements.find(e => e.$type === 'bpmn:Process');
  const elements = [...flow.flowElements, ...flow.flowElements.find(e => e.id === 'acceptance').flowElements];
  const nodes = Object.fromEntries(elements.map(e => [e.id, e])), context = { approval, 'merged-inputs': merged }, visited = [];
  let step = 'after-merged';
  while (nodes[step].$type !== 'bpmn:EndEvent') {
    const flows = elements.filter(e => e.sourceRef === nodes[step]);
    if (nodes[step].$type !== 'bpmn:ExclusiveGateway') visited.push(step);
    step = (nodes[step].$type === 'bpmn:ExclusiveGateway'
      ? flows.find(e => e.conditionExpression && evaluate(e.conditionExpression.body.trim().slice(1), context).value) ?? { targetRef: nodes[step].default.targetRef }
      : flows[0]).targetRef.id;
  }
  return { visited, end: nodes[step], merged };
}

test('skipping a text drops every ticked workflow that asks for it and runs the others', async t => {
  const skipped = await afterSkip(t, ['deploy', 'publish-preview', 'publish-release'], [{ result: 'completed', choice: 'skip', note: '' }]);
  assert.deepEqual([skipped.merged.only, skipped.merged.inputs], ['["deploy"]', '{}']);
  assert.deepEqual([skipped.visited, skipped.end.id], [['fill', 'merged-inputs', 'run-merged'], 'done']);
});

test('skipping the only texts asked for leaves nothing to run: no run-workflows, the run ends as merged', async t => {
  const skipped = await afterSkip(t, ['publish-preview', 'publish-release'], [{ result: 'completed', choice: 'skip', note: '' }]);
  assert.equal(skipped.merged.only, '[]');
  assert.deepEqual([skipped.visited, skipped.end.id, skipped.end.status], [['fill', 'merged-inputs'], 'done-none', '已合并，没有要跑的合并后流程']);
});
