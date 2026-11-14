// The cross-review step and the PR identity used before that step starts.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readWorkflow } from '@coda-console/protocol/workflow';
import { evaluate } from 'feelin';

const script = fileURLToPath(new URL('../../../plugins/review/scripts/review.mjs', import.meta.url));

test('GitHub-returned PR URLs share the event key without deriving repository identity from origin', () => {
  const source = readFileSync(new URL('../../../plugins/review/.coda/workflows/pull-request.bpmn', import.meta.url), 'utf8');
  const expression = /coda:key='=([^']+)'/.exec(source)?.[1];
  assert.ok(expression);
  const key = (pr, event = {}, repository = 'Owner/Repo') => evaluate(expression, { inputs: { pr }, github: { event, repository } }).value;
  const expected = 'https://github.com/owner/repo/pull/402';
  for (const pr of [expected, 'https://GitHub.com/OWNER/Repo/pull/402']) assert.equal(key(pr), expected, pr);
  assert.equal(key('', { number: 402, pull_request: { html_url: expected } }), expected);
  assert.equal(key(expected, {}, 'Old/Repository'), expected);
  assert.notEqual(key('https://github.com/owner/repo/pull/403'), expected);
  assert.notEqual(key('https://github.com/other/repo/pull/402'), expected);
  for (const pr of ['', '402', '00402', 'main', `${expected}/`, `${expected}?tab=checks#comment`,
    'https://other.example/owner/repo/pull/402', 'https://github.com/owner/repo/issues/402'])
    assert.equal(key(pr), null, pr);
});

test('a pull request starts the lifecycle as the plugin setting says, where neither the session nor its project set it', () => {
  const source = readFileSync(new URL('../../../plugins/review/.coda/workflows/pull-request.bpmn', import.meta.url), 'utf8');
  const expression = /<process id="pull-request"[^>]*coda:autoRun="=([^"]+)"/.exec(source)?.[1];
  assert.equal(expression, 'vars.review.autoRun');
  for (const on of [true, false]) assert.equal(evaluate(expression, { vars: { review: { autoRun: on } } }).value, on);
  const manifest = JSON.parse(readFileSync(new URL('../../../plugins/review/package.json', import.meta.url), 'utf8'));
  assert.deepEqual([manifest.contributes.configuration.properties['review.autoRun'].type, manifest.contributes.configuration.properties['review.autoRun'].default], ['boolean', true]);
});

test('manual review uses the explicit PR and rejects a missing one', t => {
  const root = mkdtempSync(join(tmpdir(), 'review-pr-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin'), summary = join(root, 'summary.md');
  mkdirSync(bin);
  const stub = (name, body) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  // GitHub has no such pull request: what gh is asked shows which one the review went for.
  stub('gh', 'echo "no pull request $3" >&2; exit 1');
  const review = (pr = '', extra = {}) => {
    writeFileSync(summary, '');
    const done = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root, PR: pr,
      REVIEWERS: JSON.stringify({ '*': { agent: 'codex' } }), SESSION: JSON.stringify({ agent: 'codex' }), GITHUB_STEP_SUMMARY: summary, ...extra } });
    return { code: done.status, said: done.stderr.trim().split('\n').at(-1), summary: readFileSync(summary, 'utf8').trim() };
  };
  assert.deepEqual(review('https://github.com/acme/app/pull/4'), { code: 1, said: '读不到 PR https://github.com/acme/app/pull/4：no pull request https://github.com/acme/app/pull/4',
    summary: '交叉评审没有进行：读不到 PR https://github.com/acme/app/pull/4：no pull request https://github.com/acme/app/pull/4' });
  assert.deepEqual([review().code, review().said], [1, '请填写 GitHub 返回的完整 PR 地址']);
  // A reviewer chosen for the run (简易开发) is taken as it is: no row of the table need match the session.
  const table = { REVIEWERS: JSON.stringify({ kimi: { agent: 'codex' } }) };
  assert.match(review('', table).said, /评审组合里没有适用于「codex」的一行/);
  assert.equal(review('', { ...table, REVIEWER: JSON.stringify({ agent: 'claude-sdk' }) }).said, '请填写 GitHub 返回的完整 PR 地址');
});

test('the session that opened the pull request is given the rules the reviewer was given, word for word', t => {
  const root = mkdtempSync(join(tmpdir(), 'review-rules-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin'), work = join(root, 'work'), outputs = join(root, 'outputs'), prompt = join(root, 'prompt.md');
  mkdirSync(bin); mkdirSync(join(work, '.coda'), { recursive: true });
  const stub = (name, body) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  stub('gh', 'exit 0');
  // The reviewer keeps what it was asked and finds one blocking problem.
  stub('coda-agent', `while [ "$1" != --prompt-file ]; do shift; done; cp "$2" ${JSON.stringify(prompt)}
printf '%s\\n' '\`\`\`review' '{"findings":[{"severity":"P1","title":"t"}]}' '\`\`\`'`);
  const git = (...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgSign=false', ...args],
    { cwd: work, encoding: 'utf8' }).stdout.trim();
  git('init', '-q');
  writeFileSync(join(work, '.coda/review.md'), '项目准则：只跑相关测试。');
  git('add', '.'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(work, 'a'), 'x'); git('add', '.'); git('commit', '-qm', 'head');
  const head = git('rev-parse', 'HEAD');
  writeFileSync(outputs, '');
  const done = spawnSync(process.execPath, [script], { cwd: work, encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root,
    RUNNER_TEMP: root, GITHUB_OUTPUT: outputs, REVIEWERS: JSON.stringify({ '*': { agent: 'codex' } }), PRINCIPLES: '["tests"]', BLOCKING: 'P2',
    PULL_REQUEST: JSON.stringify({ number: 1, html_url: 'https://github.com/acme/app/pull/1', head: { sha: head, ref: 'f' }, base: { sha: base, ref: 'main' } }) } });
  assert.equal(done.status, 0, done.stderr);
  const rules = /^rules<<EOF_rules\n([\s\S]*?)\nEOF_rules$/m.exec(readFileSync(outputs, 'utf8'))?.[1];
  assert.ok(readFileSync(prompt, 'utf8').includes(`\n${rules}\n`), 'the reviewer is given the same rules');
  for (const part of ['项目准则：只跑相关测试。', '只报可操作的发现', '**测试**', 'P3 低优']) assert.ok(rules.includes(part), part);
  assert.doesNotMatch(rules, /<!--|\{\{/);
});

// The plugin binds its saved preference to each card option; Coda separately tests defaults, overrides and hidden options.
test('merge options default to the configured selection, including an explicit empty selection', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../../plugins/review/package.json', import.meta.url), 'utf8'));
  const setting = manifest.contributes.configuration.properties['review.mergeOptions'];
  // What follows the merge besides these is the project's workflows joining the hook merged: each says its own default.
  assert.deepEqual(setting.items.anyOf.map(item => item.const), ['deleteBranch', 'notify']);
  const source = readFileSync(new URL('../../../plugins/review/.coda/workflows/pull-request.bpmn', import.meta.url), 'utf8');
  const options = [...source.matchAll(/<coda:option default='=([^']+)' id="([^"]+)"/g)];
  const selected = values => options.filter(([, expression]) => evaluate(expression, { vars: { review: { mergeOptions: values } } }).value === true).map(([, , id]) => id);
  assert.deepEqual(options.map(([, , id]) => id), ['deleteBranch', 'notify']);
  assert.deepEqual(selected(setting.default), []);
  assert.deepEqual(selected(['deleteBranch', 'notify']), ['deleteBranch', 'notify']);
  assert.deepEqual(selected(['notify']), ['notify']);
  assert.deepEqual(selected([]), []);
});

// The approval records which workflows joining the hook merged were ticked, and the text they ask for that the card
// left empty; after the merge, what the session wrote for each is added, and an answer with no text fails.
const JOINERS = JSON.stringify([
  { id: 'deploy', name: '部署', default: false },
  { id: 'publish-preview', name: '发布预览版', default: false, inputs: [{ id: 'notes', label: '发布说明' }] },
  { id: 'publish-release', name: '发布正式版', default: false, inputs: [{ id: 'notes', label: '发布说明' }] },
]);
const approvalRunner = t => {
  const root = mkdtempSync(join(tmpdir(), 'review-approval-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const approval = fileURLToPath(new URL('../../../plugins/review/scripts/approval.mjs', import.meta.url)), out = join(root, 'out');
  return (args, env, code = 0) => {
    writeFileSync(out, '');
    const done = spawnSync(process.execPath, [approval, ...args], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, GITHUB_OUTPUT: out, ...env } });
    assert.equal(done.status, code, done.stderr);
    return { ...done, outputs: Object.fromEntries([...readFileSync(out, 'utf8').matchAll(/(\w+)<<EOF_\1\n([\s\S]*?)\nEOF_\1\n/g)].map(([, k, v]) => [k, v])) };
  };
};
test('the approval names the ticked workflows of the hook merged, what the card wrote for them and what it left empty', t => {
  const run = approvalRunner(t);
  const approve = (options, inputs = {}) => { const { at, ...rest } = run([], { APPROVED: JSON.stringify({ choice: 'merge', options, inputs }), JOINERS }).outputs; assert.match(at, /^\d+$/); return rest; };
  assert.deepEqual(approve({ deleteBranch: false, deploy: false, 'publish-preview': false, 'publish-release': false, notify: false }),
    { deleteBranch: 'false', notify: 'false', only: '[]', inputs: '{}', missing: '', asks: '', needs: '{}', what: '合并' });
  assert.deepEqual(approve({ deleteBranch: true, deploy: true, 'publish-preview': true, 'publish-release': true, notify: true }, { notes: '' }),
    { deleteBranch: 'true', notify: 'true', only: '["deploy","publish-preview","publish-release"]', inputs: '{}', missing: 'notes',
      asks: '「发布说明」：发布预览版、发布正式版要', needs: '{"notes":["publish-preview","publish-release"]}', what: '合并 · 合并后删除远程分支 · 部署 · 发布预览版 · 发布正式版 · 全部完成后通知 Agent' });
  assert.deepEqual(approve({ 'publish-release': true }, { notes: ' 新版说明 ' }),
    { deleteBranch: 'false', notify: 'false', only: '["publish-release"]', inputs: '{"notes":"新版说明"}', missing: '', asks: '', needs: '{}', what: '合并 · 发布正式版' });

  assert.deepEqual(run(['inputs'], { INPUTS: '{"notes":"卡上的"}', MISSING: '', ASKS: '', FILLS: 'null', ONLY: '["deploy"]' }).outputs, { inputs: '{"notes":"卡上的"}', only: '["deploy"]' });
  assert.deepEqual(run(['inputs'], { INPUTS: '{}', MISSING: 'notes', ASKS: '「发布说明」：发布正式版要', FILLS: JSON.stringify([{ result: 'completed', choice: 'done', note: '会话写的' }]),
    NEEDS: '{"notes":["publish-release"]}', ONLY: '["publish-release"]' }).outputs, { inputs: '{"notes":"会话写的"}', only: '["publish-release"]' });
  const empty = run(['inputs'], { INPUTS: '{}', MISSING: 'notes', ASKS: '「发布说明」：发布正式版要', FILLS: JSON.stringify([{ result: 'completed', note: '', attachments: ['/a.png'] }]) }, 1);
  assert.match(empty.stderr, /「发布说明」：发布正式版要：没有填写，不运行合并后的流程/);
  assert.deepEqual(empty.outputs, {});
});

async function pullRequestGraph() {
  const source = readFileSync(new URL('../../../plugins/review/.coda/workflows/pull-request.bpmn', import.meta.url), 'utf8');
  const { root, problem } = await readWorkflow(source, 'pull-request'); assert.ok(!problem, problem);
  const nodes = {}, flows = [];
  const index = container => { for (const e of container.flowElements ?? []) { if (e.$type === 'bpmn:SequenceFlow') flows.push(e); else nodes[e.id] = e; index(e); } };
  index(root.rootElements.find(e => e.$type === 'bpmn:Process'));
  const values = id => nodes[id].extensionElements?.values ?? [];
  const params = id => Object.fromEntries(values(id).filter(v => v.$type === 'coda:Param').map(v => [v.name, v.value]));
  const envs = id => Object.fromEntries(values(id).filter(v => v.$type === 'coda:Env').map(v => [v.name, v.value]));
  const route = (id, context) => {
    const out = flows.filter(f => f.sourceRef.id === id);
    return (out.find(f => f.conditionExpression && evaluate(f.conditionExpression.body.trim().slice(1), context).value) ?? nodes[id].default ?? out[0]).targetRef.id;
  };
  return { nodes, values, params, envs, route };
}

test('the merge card offers the workflows joining the hook merged, and after the merge only the ticked ones run', async () => {
  const { nodes, values, params, envs, route } = await pullRequestGraph();
  assert.equal(nodes.kinds, undefined);
  assert.equal(nodes.joiners.action, 'hook-joiners');
  assert.deepEqual(params('joiners'), { hook: 'merged', commit: '=reviewing.head' });
  assert.equal(route('standing', { approval: { at: '1' }, review: { changesAt: '2' } }), 'joiners');
  assert.equal(route('joiners', {}), 'approve');
  const [merge] = values('approve');
  assert.deepEqual(merge.options.map(o => o.id ?? o.value), ['deleteBranch', '=joiners.list', 'notify']);
  assert.doesNotMatch(nodes.approve.documentation[0].text, /「合并」以|部署|发布|作废|点「/);
  assert.deepEqual(envs('approval'), { APPROVED: '=approve', JOINERS: '=joiners.list' });
  assert.equal(route('delivering-or-not', { approval: { only: '[]' } }), 'merged-here');
  assert.equal(route('delivering-or-not', { approval: { only: '["deploy"]' } }), 'delivering');
  assert.equal(nodes.delivering.optional, true);
  for (const [missing, target] of [['', 'merged-inputs'], ['notes', 'fill']]) assert.equal(route('fill-choice', { approval: { missing } }), target);
  const loop = nodes.fill.loopCharacteristics;
  assert.deepEqual([loop.isSequential, loop.inputElement], [true, 'input']);
  assert.deepEqual(evaluate(loop.inputCollection.slice(1), { approval: { missing: 'notes,extra' } }).value, ['notes', 'extra']);
  assert.deepEqual(values('fill').map(v => [v.id, v.note]), [['done', 'required'], ['skip', undefined]]);
  assert.equal(nodes.fill.assignee, undefined);
  assert.equal(route('fill', {}), 'merged-inputs');
  assert.deepEqual(envs('merged-inputs'), { INPUTS: '=approval.inputs', MISSING: '=approval.missing', ASKS: '=approval.asks', FILLS: '=fill', NEEDS: '=approval.needs', ONLY: '=approval.only' });
  assert.equal(route('merged-inputs', {}), 'left');
  assert.equal(route('left', { 'merged-inputs': { only: '["deploy"]' } }), 'run-merged');
  assert.deepEqual(params('run-merged'), { hook: 'merged', only: '=merged-inputs.only', commit: '=github.event.pull_request.merge_commit_sha', inputs: '=merged-inputs.inputs' });
  assert.deepEqual(Object.values(nodes).filter(n => n.action === 'run-workflows').map(n => params(n.id).hook), ['check', 'premerge', 'merged']);
  for (const id of ['notes', 'notes-user', 'publishing', 'deploy', 'publish']) assert.equal(nodes[id], undefined, id);
});

// What "这一项这次不跑" does: the session writes no text for an input, so every ticked workflow asking for it drops out of
// `only` and the rest run; with none left the run goes on to its end without run-workflows.
async function afterSkip(t, ticked, fills) {
  const run = approvalRunner(t), { nodes, params, route } = await pullRequestGraph();
  const approval = run([], { APPROVED: JSON.stringify({ choice: 'merge', options: Object.fromEntries(ticked.map(id => [id, true])), inputs: {} }), JOINERS }).outputs;
  const merged = run(['inputs'], { INPUTS: approval.inputs, MISSING: approval.missing, ASKS: approval.asks, NEEDS: approval.needs, ONLY: approval.only, FILLS: JSON.stringify(fills) }).outputs;
  return { approval, merged, next: route('left', { 'merged-inputs': merged }), nodes, params };
}

test('skipping a text drops every ticked workflow that asks for it and runs the others', async t => {
  const skipped = await afterSkip(t, ['deploy', 'publish-preview', 'publish-release'], [{ result: 'completed', choice: 'skip', note: '' }]);
  assert.equal(skipped.approval.only, '["deploy","publish-preview","publish-release"]');
  assert.deepEqual([skipped.merged.only, skipped.merged.inputs, skipped.next], ['["deploy"]', '{}', 'run-merged']);
  const written = await afterSkip(t, ['deploy', 'publish-preview', 'publish-release'], [{ result: 'completed', choice: 'done', note: '新版说明' }]);
  assert.deepEqual([written.merged.only, written.merged.inputs, written.next], ['["deploy","publish-preview","publish-release"]', '{"notes":"新版说明"}', 'run-merged']);
});

test('skipping the only texts asked for leaves nothing to run: no run-workflows, the run ends as merged', async t => {
  const skipped = await afterSkip(t, ['publish-preview', 'publish-release'], [{ result: 'completed', choice: 'skip', note: '' }]);
  assert.deepEqual([skipped.merged.only, skipped.next], ['[]', 'delivered-none']);
  assert.equal(skipped.nodes['delivered-none'].$type, 'bpmn:EndEvent');
  assert.equal(skipped.nodes['delivered-none'].status, '已合并，没有要跑的合并后流程');
});

// Each answer of a task that fixes a failed version, followed through the flow: pushed waits quietly for the new version.
test('fixing a failed version: pushed waits for the new version, again reruns the step, rejected goes to the user', async () => {
  const source = readFileSync(new URL('../../../plugins/review/.coda/workflows/pull-request.bpmn', import.meta.url), 'utf8');
  const { root, problem } = await readWorkflow(source, 'pull-request'); assert.ok(!problem, problem);
  const process = root.rootElements.find(e => e.$type === 'bpmn:Process');
  const nodes = {}, flows = [], parent = {};
  const index = container => {
    for (const e of container.flowElements ?? []) {
      if (e.$type === 'bpmn:SequenceFlow') flows.push(e); else nodes[e.id] = e;
      if (e.$type === 'bpmn:SubProcess') { for (const c of e.flowElements ?? []) parent[c.id] = e; index(e); }
    }
  };
  index(process);
  const outputs = node => Object.fromEntries((node.extensionElements?.values ?? []).filter(v => v.$type === 'coda:Output').map(v => [v.name, v.value]));
  // Where the flow goes from a node, through gateways and out of subprocesses, to the next step that waits or works.
  const STEPS = ['bpmn:UserTask', 'bpmn:ServiceTask', 'bpmn:ScriptTask', 'bpmn:ReceiveTask', 'bpmn:SubProcess'];
  const next = (id, context) => {
    const out = flows.filter(f => f.sourceRef.id === id);
    const to = (out.find(f => f.conditionExpression && evaluate(f.conditionExpression.body.trim().slice(1), context).value) ?? nodes[id].default ?? out[0]).targetRef.id;
    if (STEPS.includes(nodes[to].$type)) return to;
    if (nodes[to].$type === 'bpmn:EndEvent') { context[parent[to].id] = outputs(nodes[to]); return next(parent[to].id, context); }
    return next(to, context);
  };
  const answer = (task, choice) => next(task, { [task]: { result: 'completed', choice, chose: { [choice]: true } } });
  const boundary = task => Object.values(nodes).find(n => n.$type === 'bpmn:BoundaryEvent' && n.attachedToRef.id === task && n.eventDefinitions[0].$type === 'bpmn:ErrorEventDefinition').id;
  for (const [task, again, user] of [['fix-checks', 'run-checks', 'checks-user'], ['fix-premerge', 'premerge', 'premerge-user'], ['unblock', 'merge', 'unblock-user']]) {
    assert.deepEqual(nodes[task].extensionElements.values.map(c => c.id), ['again', 'pushed'], task);
    assert.match(nodes[task].documentation[0].text, /choice pushed/, task);
    assert.equal(answer(task, 'pushed'), 'waiting', task);
    assert.equal(answer(task, 'again'), again, task);
    assert.equal(next(boundary(task), {}), user, task);
  }
  // The new version's event takes the waiting run back to the start: checks, then review.
  assert.equal(nodes.waiting.messageRef.name, 'pull_request.synchronize');
  assert.equal(next('waiting', { github: { event: { pull_request: { draft: false } } } }), 'checking');
  assert.equal(next('after-checking', { checking: { outcome: 'passed' } }), 'reviewing');
});
