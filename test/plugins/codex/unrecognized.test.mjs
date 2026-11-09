// What of Codex the Codex entry has not adapted, told to Coda as `_coda/unrecognized` (plugins/codex/agent/unrecognized.mjs):
// what codex-acp says of it, how the entry tells Coda, and, through the real adapter and a fixture app-server, an unregistered
// item, an agent message without deltas, an unregistered notification and request, and a tool the known list lacks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { AgentProcess } from '../../../check/process.mjs';
import { clientCapabilities } from '../../../check/coda/domain/agent-protocol.mjs';
import { CodexUnrecognized, codexAgentMessage, codexUnrecognizedItem, codexUnrecognizedNotification, reportedCodexUnrecognized, rolloutTools }
  from '../../../plugins/codex/agent/unrecognized.mjs';
import known from '../../../plugins/codex/agent/known-tools.json' with { type: 'json' };
import { pluginEnv } from '../command.mjs';
import { pluginDir, resolveFrom } from '../plugin.mjs';

const message = (fields = {}) => ({ type: 'agentMessage', id: 'm', text: '你好', phase: 'final_answer', memoryCitation: null, delivery: null, questions: null, ...fields });
const chunk = (text, id = 'm') => ({ sessionUpdate: 'agent_message_chunk', messageId: id, content: { type: 'text', text } });
const told = (update, ...unrecognized) => ({ ...update, _meta: { ...update._meta, coda: { ...update._meta?.coda, unrecognized } } });
const info = { sessionUpdate: 'session_info_update' };
const output = (name, lost = false) => ({ kind: 'output', name, lost });
const update = (u, sessionId = 's') => ({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: u } });
const initialize = (taken = true) => ({ jsonrpc: '2.0', id: 0, method: 'initialize',
  params: { protocolVersion: 1, clientCapabilities: { _meta: { coda: { waits: {}, ...(taken ? { unrecognized: {} } : {}) } } } } });

test('an agent message streamed is codex-acp\'s; one whose text came without deltas is said from its text, and told', () => {
  assert.equal(codexAgentMessage(message(), true), null);
  assert.equal(codexAgentMessage(message({ text: '' }), false), null);
  assert.deepEqual(codexAgentMessage(message(), false), told(chunk('你好'), output('item:agentMessage.unstreamed')));
  // An async one is questions.mjs's, and nothing of it is unregistered.
  assert.deepEqual(codexAgentMessage(message({ delivery: 'async' }), false), chunk('你好'));
  assert.equal(codexAgentMessage(message({ delivery: 'async' }), true), null);
});

test('an agent message\'s unregistered fields and values are told, its text shown however it came', () => {
  assert.deepEqual(codexAgentMessage(message({ delivery: 'sync' }), true), told(info, output('item:agentMessage.delivery=sync')));
  assert.deepEqual(codexAgentMessage(message({ delivery: 'sync' }), false), told(chunk('你好'), output('item:agentMessage.delivery=sync')));
  assert.deepEqual(codexAgentMessage(message({ phase: 'aside', audience: 'team' }), true),
    told(info, output('item:agentMessage.audience'), output('item:agentMessage.phase=aside')));
  // A registered field that is not shown is not told.
  assert.equal(codexAgentMessage(message({ memoryCitation: { entries: [] } }), true), null);
});

test('an item of an unregistered type is shown from its text, or told as lost; a registered one stays codex-acp\'s', () => {
  assert.deepEqual(codexUnrecognizedItem({ type: 'fooBar', id: 'f', text: '新东西' }), told(chunk('新东西', 'f'), output('item:fooBar')));
  assert.deepEqual(codexUnrecognizedItem({ type: 'fooBar', id: 'f', summary: '摘要' }), told(chunk('摘要', 'f'), output('item:fooBar')));
  assert.deepEqual(codexUnrecognizedItem({ type: 'bazQux', id: 'b' }),
    told(info, { ...output('item:bazQux', true), detail: 'Codex 发来一项「bazQux」，入口还不认识，没有显示' }));
  assert.equal(codexUnrecognizedItem({ type: 'enteredReviewMode', id: 'r' }), null);
  assert.deepEqual(codexUnrecognizedNotification('thread/fooChanged'), told(info, output('notification:thread/fooChanged')));
  assert.equal(codexUnrecognizedNotification('thread/readState/changed'), null);
});

test('what codex-acp tells is said to Coda once a session and name, after the update it rode on, which goes on without it', () => {
  const unrecognized = new CodexUnrecognized();
  unrecognized.fromCoda(initialize());
  const said = unrecognized.fromAgent(update(told({ ...chunk('新东西', 'f'), _meta: { codex: { phase: 'final_answer' } } }, output('item:fooBar'))));
  assert.deepEqual(said, [
    update({ ...chunk('新东西', 'f'), _meta: { codex: { phase: 'final_answer' } } }),
    { jsonrpc: '2.0', method: '_coda/unrecognized', params: { sessionId: 's', kind: 'output', name: 'item:fooBar', lost: false } },
  ]);
  // Told alone, it is all that is said; told again in the session, nothing is.
  assert.deepEqual(unrecognized.fromAgent(update(told(info, output('item:fooBar')))), []);
  assert.deepEqual(unrecognized.fromAgent(update(told(chunk('又一个', 'g'), output('item:fooBar')))), [update(chunk('又一个', 'g'))]);
  // Another session is told too; Codex's own metadata stays.
  const async = told({ ...chunk('问'), _meta: { coda: { asyncQuestions: [{ title: '？' }] } } }, output('item:fooBar'));
  assert.deepEqual(unrecognized.fromAgent(update(async, 'child')), [update({ ...chunk('问'), _meta: { coda: { asyncQuestions: [{ title: '？' }] } } }, 'child'),
    { jsonrpc: '2.0', method: '_coda/unrecognized', params: { sessionId: 'child', kind: 'output', name: 'item:fooBar', lost: false } }]);
  assert.deepEqual(unrecognized.report({ sessionId: 's', kind: 'tool', name: 'tool:functions.new', lost: false }).map(m => m.params.name), ['tool:functions.new']);
  assert.deepEqual(unrecognized.report({ sessionId: 's', kind: 'tool', name: 'tool:functions.new', lost: false }), []);
});

test('a Coda that does not take reports is told nothing, and still sees the text', () => {
  const unrecognized = new CodexUnrecognized();
  unrecognized.fromCoda(initialize(false));
  assert.deepEqual(unrecognized.fromAgent(update(told(chunk('新东西', 'f'), output('item:fooBar')))), [update(chunk('新东西', 'f'))]);
  assert.deepEqual(unrecognized.fromAgent(update(told(info, output('item:bazQux', true)))), []);
  assert.deepEqual(unrecognized.report({ sessionId: 's', kind: 'tool', name: 'tool:functions.new', lost: false }), []);
});

test('the tools a rollout gave the model, by namespace, MCP tools aside; none before it gave any', () => {
  const line = tools => JSON.stringify({ type: 'response_item', payload: { type: 'additional_tools', tools } });
  assert.equal(rolloutTools(`${JSON.stringify({ type: 'session_meta', payload: {} })}\n`), null);
  const text = [
    JSON.stringify({ type: 'session_meta', payload: {} }),
    line([{ type: 'namespace', name: 'functions', tools: [{ type: 'custom', name: 'exec' }, { type: 'function', name: 'request_user_input_async' }] },
      { type: 'namespace', name: 'mcp__coda', tools: [{ type: 'function', name: 'spawn' }] }, { type: 'web_search' }]),
    line([{ type: 'namespace', name: 'clock', tools: [{ type: 'function', name: 'sleep' }] }, { type: 'function', name: 'shell' }]),
  ].join('\n');
  assert.deepEqual([...rolloutTools(text)], ['functions.exec', 'functions.request_user_input_async', 'web_search', 'clock.sleep', 'functions.shell']);
  // The async tools Codex is given are adapted.
  assert.ok(['functions.request_user_input_async', 'functions.send_user_message_async'].every(tool => known[tool].startsWith('已适配')));
});

test('the unrecognized output patch fails loudly once the locked adapter changes', () => {
  const bundle = readFileSync(resolveFrom('codex', '@agentclientprotocol/codex-acp'), 'utf8');
  const patched = reportedCodexUnrecognized(bundle);
  for (const pattern of [/default:\n\s+return codexUnrecognizedItem\(event\.item\);/, /default:\n\s+return codexUnrecognizedNotification\(notification\.method\);/,
    /codexTurnCompleted\(notification\.params\.threadId\);/, /codexUnrecognizedRequest\(method, params\);/,
    /return codexThread\(await this\.sendRequest\(\{ method: "thread\/start", params \}\)\);/, /return codexThread\(await this\.sendRequest\(\{ method: "thread\/resume", params \}\)\);/]) {
    assert.match(patched, pattern);
  }
  for (const [before, after] of [['case "enteredReviewMode":\n        return null;', 'case "enteredReviewMode":\n        return void 0;'],
    ['case "autoApprovalReview/strictReviewRequired":\n        return null;', 'case "autoApprovalReview/strictReviewRequired":\n        break;'],
    ['case "turn/completed":\n        await this.flushPendingPlanUpdates();', 'case "turn/completed":\n        await this.flushPlanUpdates();'],
    ['return await handler.handleUserInput(params);', 'return handler.handleUserInput(params);'],
    ['{ method: "thread/start", params }', '{ method: "thread/start", params: params }']]) {
    assert.throws(() => reportedCodexUnrecognized(bundle.replace(before, after)), /no longer matches/);
  }
});

// Through the real adapter: the fixture app-server's turn says what the entry has not registered; Codex gave the model the
// known tools, an MCP tool and one more.
const tools = [
  ...Object.entries(Object.groupBy(Object.keys(known).filter(tool => tool.includes('.')), tool => tool.split('.')[0]))
    .map(([name, each]) => ({ type: 'namespace', name, tools: each.map(tool => ({ type: 'function', name: tool.split('.')[1] })) })),
  ...Object.keys(known).filter(tool => !tool.includes('.')).map(type => ({ type })),
  { type: 'namespace', name: 'mcp__coda', tools: [{ type: 'function', name: 'spawn' }] },
  { type: 'namespace', name: 'functions', tools: [{ type: 'function', name: 'brand_new' }] },
];
async function run(t, taken) {
  const root = mkdtempSync(join(tmpdir(), 'coda-codex-unrecognized-'));
  let proc;
  t.after(async () => { if (proc) { await proc.terminate(1000); proc.kill(); } rmSync(root, { recursive: true, force: true }); });
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const program = join(root, 'codex');
  writeFileSync(program, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fileURLToPath(new URL('./app-server-fixture.mjs', import.meta.url)))}\n`);
  chmodSync(program, 0o700); writeFileSync(join(root, 'died'), '');
  const messages = [];
  proc = new AgentProcess({ command: `exec ${quote(process.execPath)} ${quote(join(pluginDir('codex'), 'agent/entry.mjs'))}`, cwd: root,
    env: pluginEnv('codex', { CODEX_PATH: program, FAKE_CODEX_STATE: root, CODEX_HOME: join(root, 'home'), FAKE_CODEX_TOOLS: JSON.stringify(tools) }),
    onMessage(message) { messages.push(message); } });
  const request = async (method, params) => {
    const reply = await proc.request(method, params, { timeout: 10000 });
    assert.equal(reply.error, undefined, JSON.stringify(reply.error));
    return reply.result;
  };
  // Coda's own capabilities, with or without taking reports, whichever its contract says.
  const capabilities = clientCapabilities(), { unrecognized, ...coda } = capabilities._meta.coda;
  await request('initialize', { protocolVersion: 1, clientCapabilities: { ...capabilities, _meta: { ...capabilities._meta, coda: taken ? { ...coda, unrecognized: {} } : coda } } });
  const { sessionId } = await request('session/new', { cwd: root, mcpServers: [] });
  assert.equal((await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'unrecognized' }] })).stopReason, 'end_turn');
  // The tools are read once the turn has ended.
  if (!taken) await delay(300);
  for (let i = 0; taken && i < 100 && !messages.some(m => m.params?.kind === 'tool'); i++) await delay(20);
  const answers = existsSync(join(root, 'answers.ndjson')) ? readFileSync(join(root, 'answers.ndjson'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  return { sessionId, messages, answers };
}
const shown = messages => messages.filter(m => m.params?.update?.sessionUpdate === 'agent_message_chunk').map(m => m.params.update.content.text);

test('through the real adapter, what is not registered is told once, its text shown, and the rest goes on as before', { timeout: 15000 }, async t => {
  const { sessionId, messages, answers } = await run(t, true);
  const reports = messages.filter(m => m.method === '_coda/unrecognized').map(m => m.params);
  assert.deepEqual(reports.sort((a, b) => a.name.localeCompare(b.name)), [
    { sessionId, kind: 'output', name: 'item:agentMessage.unstreamed', lost: false },
    { sessionId, kind: 'output', name: 'item:bazQux', lost: true, detail: 'Codex 发来一项「bazQux」，入口还不认识，没有显示' },
    { sessionId, kind: 'output', name: 'item:fooBar', lost: false },
    { sessionId, kind: 'output', name: 'notification:thread/fooChanged', lost: false },
    { sessionId, kind: 'output', name: 'request:item/tool/bar', lost: true, detail: 'Codex 请求了「item/tool/bar」，入口还不认识，回了不支持' },
    { sessionId, kind: 'tool', name: 'tool:functions.brand_new', lost: false },
  ]);
  assert.deepEqual(shown(messages), ['新东西', '又一个新东西', '逐段的回复', '没有增量的回复']);
  assert.equal(messages.some(m => m.params?.update?._meta?.coda?.unrecognized), false);
  // The request is refused as codex-acp refused it before.
  assert.deepEqual(answers.find(a => a.id === 'fake-request').error, { code: -32601, message: 'Unhandled method item/tool/bar' });
});

test('through the real adapter, a Coda that does not take reports is told nothing, and still sees the text', { timeout: 15000 }, async t => {
  const { messages } = await run(t, false);
  assert.equal(messages.some(m => m.method === '_coda/unrecognized'), false);
  assert.deepEqual(shown(messages), ['新东西', '又一个新东西', '逐段的回复', '没有增量的回复']);
});
