import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Adapter, SUBMISSION_WAIT_MS } from '../../../plugins/grok-bot/agent/session.mjs';
import { FakeNative } from './native-fixture.mjs';
import { fakeClock, mailbox, temporary, harness } from './helpers.mjs';
import { schemas } from '../../../check/schema.mjs';

async function setup(t, { auth = true, settings = {}, root = temporary(t), mcp, permission, native = new FakeNative() } = {}) {
  if (auth) writeFileSync(join(root, 'native-auth.json'), JSON.stringify({ accessToken: 'fixture' }), { mode: 0o600 });
  const events = [], logs = [], processed = mailbox(), calls = [], requests = mailbox();
  const clock = fakeClock();
  const adapter = new Adapter({ env: { CODA_PLUGIN_STATE: root, CODA_PLUGIN_SETTINGS: JSON.stringify(settings) }, fetcher: native.fetch, clock,
    rpc: { notify(method, params) { events.push({ method, params }); }, async request(method, params) { requests.push({ method, params });
      if (method === '_coda/remote/code') return { code: 'bind-code', addresses: ['http://100.64.0.1:8080'] };
      if (method === 'session/request_permission') return permission ? permission(params) : { outcome: { outcome: 'selected', optionId: '1' } };
      throw new Error(method);
    } }, log: text => logs.push(text), mcpFactory: server => ({
      list: async () => ({ tools: (server.name === 'diagnostics' ? ['machines', 'machine_diagnostics'] : ['status', 'read_thread', 'read_tool_call', 'agents', 'workflow_status', 'workflow_list', 'new_session', 'send', 'spawn', 'cancel', 'exec']).map(name => ({ name })) }),
      call: async (name, args, signal) => { calls.push({ name, args, server: server.name }); if (mcp) return mcp(name, args, signal);
        return { content: [{ type: 'text', text: JSON.stringify(name === 'status' ? { turn: 'coda-ticket' } : { name, args }) }] }; }, close() {} }) });
  const original = adapter.nativeEvent.bind(adapter);
  adapter.nativeEvent = async (s, e) => { await original(s, e); processed.push(e); };
  t.after(() => adapter.close());
  await adapter.handle('initialize', { clientCapabilities: { _meta: { coda: { waits: {}, remote: {} } } } });
  const open = { cwd: root, mcpServers: [{ name: 'coda' }, { name: 'diagnostics' }], systemPrompt: { mode: 'append', content: [{ type: 'text', text: 'DO NOT INJECT THIS' }] } };
  const result = await adapter.handle('session/new', open), id = result.sessionId;
  const s = adapter.session(id);
  const h = { adapter, s, id, result, root, native, clock, events, logs, calls, requests, open,
    text: () => events.filter(e => e.params.update?.sessionUpdate === 'agent_message_chunk').map(e => e.params.update.content.text).join('\n'),
    select: () => adapter.handle('session/set_config_option', { sessionId: id, configId: 'bot', value: 'inspector' }),
    prompt: text => adapter.handle('session/prompt', { sessionId: id, prompt: [{ type: 'text', text }] }),
    remote: (method, params = {}) => adapter.handle('_coda/remote', { sessionId: id, method, params }),
    until: async predicate => { for (;;) { const e = await processed.next(); if (predicate(e)) return e; } },
    async emit(e) { native.emit(e); const key = e.rows ? 'entry' : Object.keys(e)[0] === 'agentState' ? 'live' : Object.keys(e)[0]; return this.until(x => x[key]); },
  };
  return h;
}
const live = value => ({ agentState: { live: [{ agentId: 'inspector', ...value }] } });
const settle = id => live({ lastTurnSettlement: { turnId: id, outcome: 'success', settledAtMs: '100' } });
const heartbeat = { heartbeat: { serverTimeMs: '200' } };
async function connected(t, options) { const h = await setup(t, options); await h.select(); await h.until(e => e.connected); await h.remote('hello'); await h.s.routines.flight; return h; }
async function sent(h, text = '原样正文') {
  const done = h.prompt(text), request = await h.native.next('SendGrokBotUserMessage');
  await h.emit(h.native.row(`u${h.native.entries.length}`, { kind: 'message', role: 'user', content: text, clientNonce: request.params.messageId, requestId: request.params.messageId }));
  return { done, id: request.params.messageId, request };
}
async function reply(h, id, text = '42', entry = 'reply') { await h.emit(h.native.row(entry, { kind: 'send-message', requestId: id, message: { type: 'text', content: text } })); }

test('new/load probes leave no state files; selected Bot and binding persist without instructions', async t => {
  const h = await setup(t, { auth: false });
  for (let i = 0; i < 4; i++) await h.adapter.open(h.open, false);
  await h.adapter.open({ ...h.open, sessionId: 'never-persisted' }, true);
  assert.deepEqual(readdirSync(h.root), []);
  await h.remote('hello');
  assert.equal(readdirSync(h.root).length, 1);
  assert.doesNotMatch(readFileSync(h.adapter.file(h.id), 'utf8'), /instructions|DO NOT/);
});

test('native send is unchanged; settlement before reply waits; events are valid ACP and tool details are not invented', async t => {
  const h = await connected(t), run = await sent(h, '正文😀'.repeat(2000));
  assert.equal(run.request.params.text, '正文😀'.repeat(2000));
  assert.equal(run.request.params.sessionId, '');
  assert.doesNotMatch(JSON.stringify(run.request), /DO NOT INJECT|coda-session-instructions/);
  await h.emit(live({ isRunning: true, activity: { kind: 'thinking' } }));
  await h.emit(live({ isRunning: true, activity: { kind: 'tool', tool: 'SetStatus', detail: '检查机器' } }));
  await h.emit(settle(run.id));
  await h.emit(heartbeat);
  assert.ok(h.s.turn, 'terminal state alone is not a reply');
  await reply(h, run.id); await h.emit(heartbeat);
  assert.equal((await run.done).stopReason, 'end_turn');
  assert.match(h.text(), /42/);
  const tool = h.events.find(e => e.params.update?.title === '检查机器').params.update;
  assert.equal(tool.rawInput, undefined); assert.equal(tool.rawOutput, undefined);
  assert.ok(h.events.some(e => e.params.update?.toolCallId === tool.toolCallId && e.params.update.status === 'completed'));
  for (const e of h.events.filter(e => e.method === 'session/update')) assert.equal(schemas.zSessionNotification.safeParse(e.params).success, true, JSON.stringify(e.params));
});

test('reply before settlement, duplicate rows, and history reconciliation deliver text once', async t => {
  const h = await connected(t), run = await sent(h);
  const event = h.native.row('answer', { kind: 'send-message', requestId: run.id, message: { type: 'text', content: 'unique-answer' } });
  await h.emit(event); h.native.emit(event);
  await h.emit(settle(run.id)); await h.emit(heartbeat); await run.done;
  assert.equal(h.text().match(/unique-answer/g).length, 1);
});

test('desktop-initiated main run is autonomous', async t => {
  const h = await connected(t);
  const start = h.events.length;
  await h.emit(live({ isRunning: true }));
  await h.emit(h.native.row('desktop', { kind: 'message', role: 'user', content: 'desktop input', requestId: 'desktop-run' }));
  await reply(h, 'desktop-run', 'desktop response'); await h.emit(settle('desktop-run')); await h.emit(heartbeat);
  const events = h.events.slice(start);
  assert.equal(events[0].params.state, 'handling');
  assert.equal(events.at(-1).params.state, 'waiting');
});

test('widget maps options to Coda permission and selected value to native Respond', async t => {
  const h = await connected(t), run = await sent(h);
  await h.emit(h.native.row('widget1', { kind: 'send-message', requestId: run.id, message: { type: 'widget', widget: { prompt: '选择', options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }] } } }));
  const permission = await h.requests.next();
  assert.equal(permission.method, 'session/request_permission');
  assert.deepEqual(permission.params.options.map(o => o.name), ['A', 'B']);
  assert.deepEqual((await h.native.next('RespondGrokBotWidget')).params, { agentId: 'inspector', sessionId: '', entryId: 'widget1', value: 'b' });
  await h.emit(settle(run.id)); await h.emit(heartbeat); await run.done;
});

test('interrupt calls native service; late output remains visible without reopening a closed prompt', async t => {
  const h = await connected(t), run = await sent(h);
  await h.adapter.handle('session/cancel', { sessionId: h.id });
  assert.equal((await run.done).stopReason, 'cancelled');
  assert.equal((await h.native.next('InterruptGrokBotAgentRun')).params.sessionId, '');
  await reply(h, run.id, 'late reply');
  assert.equal(h.s.turn.autonomous, true); assert.match(h.text(), /late reply/);
});

test('awaiting is explained in Coda and logged without pretending to resolve auto-review', async t => {
  const h = await connected(t);
  await h.emit(live({ isRunning: true, awaiting: { approvalId: 'sample' } }));
  assert.match(h.text(), /Grok 客户端/);
  assert.ok(h.logs.some(x => x.includes('approvalId')));
  assert.equal(h.native.requests.some(r => r.method.includes('Resolve')), false);
});

test('login polls officially, includes Continue hint, writes private credentials and refreshes Bot options', async t => {
  const h = await setup(t, { auth: false });
  await h.prompt('hello'); await h.native.next('poll');
  assert.match(h.text(), /loginDeepControl/); assert.match(h.text(), /Continue/);
  await h.clock.untilTimer(2000); h.clock.advance(2000); await h.native.next('poll');
  await h.adapter.loginTask;
  assert.equal(statSync(join(h.root, 'native-auth.json')).mode & 0o777, 0o600);
  assert.equal(h.adapter.bots[0].agentId, 'inspector');
  assert.doesNotMatch(h.text(), /fixture-access/);
});

test('disconnect reconnects with committed cursor; expired cursor replays by entry ID without repeats', async t => {
  const h = await connected(t), run = await sent(h);
  await reply(h, run.id, 'once', 'dedup');
  h.native.drop();
  // Wait for the adapter's synchronous error report, then advance retry time.
  await new Promise(resolve => { const old = h.adapter.log; h.adapter.log = value => { old(value); resolve(); }; if (h.logs.length) resolve(); });
  await h.clock.untilTimer(1000); h.clock.advance(1000); await h.native.next('WatchGrokBotTranscripts');
  await h.until(e => e.connected);
  const requests = h.native.requests.filter(r => r.method === 'WatchGrokBotTranscripts');
  assert.equal(requests.at(-1).params.cursors[0].afterUpdatedSeq, '2');
  h.native.emit({ cursorTooOld: {} });
  await h.native.next('ListGrokBotTranscriptEntries');
  // A connection that fails again before a heartbeat increases the backoff.
  await h.clock.untilTimer(2000); h.clock.advance(2000);
  await h.native.next('WatchGrokBotTranscripts'); await h.until(e => e.connected);
  await h.emit(settle(run.id)); await h.emit(heartbeat); await run.done;
  assert.equal(h.text().match(/once/g).length, 1);
});

test('Coda tools preserve whitelist, routing, authorization ticket and stable request ID', async t => {
  const h = await connected(t), run = await sent(h);
  for (const name of ['read_thread', 'machines', 'machine_diagnostics']) await h.remote('tool', { name });
  assert.equal(h.calls.find(c => c.name === 'machines').server, 'diagnostics');
  for (const name of ['spawn', 'cancel', 'exec']) await assert.rejects(h.remote('tool', { name }), /不允许代理/);
  for (const method of ['input', 'say', 'done']) await assert.rejects(h.remote(method), /未知的远端方法/);
  await assert.rejects(h.remote('tool', { name: 'new_session', arguments: {} }), /project/);
  const args = { project: 'code', agent: 'codex', prompt: 'fix' };
  await h.remote('tool', { name: 'new_session', arguments: args });
  await h.remote('tool', { name: 'new_session', arguments: { prompt: 'fix', agent: 'codex', project: 'code' } });
  const writes = h.calls.filter(c => c.name === 'new_session');
  assert.equal(writes[0].args.turn, 'coda-ticket'); assert.equal(writes[0].args.requestId, writes[1].args.requestId);
  await reply(h, run.id); await h.emit(settle(run.id)); await h.emit(heartbeat); await run.done;
});

test('slow send registers background before cancel and reports late failure visibly', async t => {
  let reject, entered = mailbox();
  const h = await connected(t, { mcp: async name => {
    if (name === 'status') return { structuredContent: { turn: 'ticket' } };
    entered.push(true); return new Promise((_, no) => { reject = no; });
  } });
  const run = await sent(h);
  const pending = h.remote('tool', { name: 'send', arguments: { childId: 'other', prompt: 'fix' } });
  await entered.next();
  assert.ok(h.events.some(e => e.params.title === 'Coda · send 等待结果' && e.params.state === 'waiting'));
  h.clock.advance(SUBMISSION_WAIT_MS); assert.match(JSON.stringify(await pending), /已提交/);
  await h.adapter.handle('session/cancel', { sessionId: h.id }); await run.done;
  reject(new Error('RPC connection closed'));
  // Complete the rejected operation through the promise microtask queue.
  await h.emit(live({}));
  assert.match(h.text(), /后台调用失败/);
  assert.ok(h.events.some(e => e.params.update?.status === 'failed' && e.params.update.rawOutput === 'RPC connection closed'));
});

test('telemetry rejects normalization traversal and missing diagnostics is actionable', async t => {
  const h = await connected(t);
  await assert.rejects(h.remote('telemetry', { path: '/api/.\n./.\t./admin' }), /只允许/);
  h.s.diagnosticsEnabled = false; h.s.routes.delete('machines');
  await assert.rejects(h.remote('tool', { name: 'machines' }), /安装并为这个目录启用/);
});

test('updatedSeq changes and process reload do not redisplay an already delivered body', async t => {
  const h = await connected(t), run = await sent(h);
  await reply(h, run.id, 'persisted-once', 'persistent-entry'); await h.emit(settle(run.id)); await h.emit(heartbeat); await run.done;
  h.s.watch.close(); h.s.routines.close(); h.adapter.sessions.delete(h.id);
  await h.adapter.open({ ...h.open, sessionId: h.id }, true); await h.until(e => e.connected);
  const row = { ...h.native.entries.find(e => e.entryId === 'persistent-entry'), updatedSeq: '99' };
  h.native.entries = h.native.entries.map(e => e.entryId === row.entryId ? row : e);
  h.native.emit({ rows: { agentId: 'inspector', entries: [row] } });
  await h.emit(live({ hasRunningSubagents: true }));
  assert.equal(h.text().match(/persisted-once/g).length, 1);
  assert.equal(h.adapter.session(h.id).saved.stream.afterUpdatedSeq, '99');
});

test('old settlement does not terminate a new native run and missing reply waits until the configured turn timeout', async t => {
  const h = await connected(t), run = await sent(h);
  await h.emit(live({ isRunning: true, lastTurnSettlement: { turnId: 'previous', outcome: 'success', settledAtMs: '1' } }));
  assert.equal(h.s.turn.nativeId, run.id); assert.equal(h.s.turn.settlement, undefined);
  await h.emit(settle(run.id)); await h.emit(heartbeat);
  assert.ok(h.s.turn);
  await h.emit(heartbeat); assert.ok(h.s.turn);
  h.clock.advance(h.adapter.timeout);
  assert.equal((await run.done).stopReason, 'end_turn');
  assert.match(h.text(), /本轮已结束/);
});

test('login HTTP failure is visible and can be retried without leaving a fake successful credential', async t => {
  const native = new FakeNative(); native.pollAnswers = [500];
  const h = await setup(t, { auth: false, native });
  await h.prompt('hello'); await h.adapter.loginTask;
  assert.match(h.text(), /登录未完成/);
  assert.equal(readdirSync(h.root).includes('native-auth.json'), false);
  native.pollAnswers = [{ accessToken: 'retry-token' }];
  await h.prompt('/login'); await h.adapter.loginTask;
  assert.equal(statSync(join(h.root, 'native-auth.json')).mode & 0o777, 0o600);
});

test('stdio ACP and both real MCP clients integrate with the fake native transport', async t => {
  const root = temporary(t), native = new FakeNative();
  writeFileSync(join(root, 'native-auth.json'), JSON.stringify({ accessToken: 'fixture' }), { mode: 0o600 });
  const h = await harness(t, { root, fetcher: native.fetch });
  await h.select(); await h.remote('hello');
  await h.remote('tool', { name: 'read_thread', arguments: { reference: 'thread' } });
  await h.remote('tool', { name: 'machines' });
  assert.deepEqual(h.discovered().sort(), ['coda', 'diagnostics']);
  assert.deepEqual(h.calls().map(c => [c.name, c.server]), [['read_thread', 'coda'], ['machines', 'diagnostics']]);
  const done = h.prompt('stdio input'), request = await native.next('SendGrokBotUserMessage');
  const id = request.params.messageId;
  native.emit(native.row('rpc-user', { kind: 'message', role: 'user', clientNonce: id, requestId: id }));
  native.emit(native.row('rpc-answer', { kind: 'send-message', requestId: id, message: { type: 'text', content: 'stdio reply' } }));
  native.emit(settle(id)); native.emit(heartbeat);
  assert.equal((await done).stopReason, 'end_turn');
  assert.match(h.text(), /stdio reply/);
});

const automation = runs => [{ automationId: 'automation', recordJson: JSON.stringify({ name: 'Coda 巡检', runs }) }];
const routineEvents = h => h.events.filter(e => e.params.waitId?.startsWith('grok-routine:')).map(e => e.params);

test('Routine records follow executor/run IDs, stop polling at completion, and its main conclusion is autonomous', async t => {
  const h = await connected(t);
  const calls = h.native.requests.length;
  h.clock.advance(3600000);
  assert.equal(h.native.requests.length, calls, 'idle has no polling or patrol dispatch');
  const run = { id: 'routine-run', status: 'running', startedAt: h.clock.now(), finishedAt: null };
  h.native.automations = automation([run]);
  h.native.subagents = [{ subagentId: 'sand-subagent-routine-run', subagentType: 'executor' }];
  await h.emit(live({ hasRunningSubagents: true })); await h.s.routines.flight;
  assert.equal(h.s.turn, null, 'a run record does not create an empty conversation turn');
  assert.equal(h.s.saved.runs[run.id].executorId, h.native.subagents[0].subagentId);
  assert.deepEqual(routineEvents(h).map(e => e.state), ['waiting']);
  run.status = 'ok'; run.finishedAt = run.startedAt + 7000;
  h.native.automations = automation([run]); h.native.subagents = [];
  h.clock.advance(5000); await h.s.routines.flight;
  assert.deepEqual(routineEvents(h).map(e => e.state), ['waiting', 'done']);
  assert.match(routineEvents(h).at(-1).title, /成功（7 秒）/);
  const end = h.native.requests.length; h.clock.advance(60000);
  assert.equal(h.native.requests.length, end);
  await h.emit(live({ isRunning: true, activity: { kind: 'thinking' } }));
  assert.equal(h.s.turn.autonomous, true);
  await h.emit(settle('main-completion')); await h.emit(heartbeat);
  assert.ok(h.s.turn, 'Routine completion is not a substitute for its main reply');
  await reply(h, 'main-completion', 'COMPLETION_PATH_PROBE'); await h.emit(heartbeat);
  assert.equal(h.s.turn, null); assert.match(h.text(), /COMPLETION_PATH_PROBE/);
  assert.equal(h.native.requests.some(r => r.method === 'SendGrokBotUserMessage'), false);
  assert.ok(h.native.requests.filter(r => r.method === 'WatchGrokBotTranscripts').every(r => r.params.includeUnlistedAgents));
  assert.ok(h.native.requests.every(r => r.headers['x-cursor-client-version'] === '0.78.1'));
});

test('Routine baseline is quiet; changed notifications reveal failed runs once, including after reload', async t => {
  const native = new FakeNative();
  const old = { id: 'old', startedAt: 1, finishedAt: 2, status: 'ok' };
  native.automations = automation([old]);
  const h = await connected(t, { native });
  assert.deepEqual(routineEvents(h), []);
  native.automations = automation([old, { id: 'failed', startedAt: 10, finishedAt: 1010, status: 'failed' }]);
  native.emit({ agentStateChanged: { agentId: 'inspector', families: ['automations'] } });
  await h.until(e => e.routinesChanged); await h.s.routines.flight;
  assert.deepEqual(routineEvents(h).map(e => e.state), ['waiting', 'failed']);
  h.s.watch.close(); h.s.routines.close(); h.adapter.sessions.delete(h.id);
  await h.adapter.open({ ...h.open, sessionId: h.id }, true); await h.until(e => e.connected);
  await h.adapter.session(h.id).routines.flight;
  assert.deepEqual(routineEvents(h).map(e => e.state), ['waiting', 'failed']);
});

test('expired login requests reauthentication without resending a message', async t => {
  const h = await connected(t);
  h.native.handler = async method => method === 'SendGrokBotUserMessage' ? new Response('{}', { status: 401 }) : undefined;
  assert.equal((await h.prompt('once')).stopReason, 'end_turn');
  assert.match(h.text(), /401.*认证失效请发送 \/login/);
  assert.equal(h.native.requests.filter(r => r.method === 'SendGrokBotUserMessage').length, 1);
});

test('expired cursor pages past 1000 rows and resumes at the recovered cursor without duplicating the missed reply', async t => {
  const h = await connected(t);
  h.native.row('missed', { kind: 'send-message', requestId: 'missed-run', message: { type: 'text', content: 'older-page-reply' } }, 1);
  for (let n = 2; n <= 1001; n++) h.native.row(`record-${n}`, { kind: 'record' }, n);
  h.native.emit({ cursorTooOld: { agentId: 'inspector' } });
  await h.clock.untilTimer(1000); h.clock.advance(1000); await h.until(e => e.connected);
  assert.equal(h.text().match(/older-page-reply/g).length, 1);
  const requests = h.native.requests.filter(r => r.method === 'ListGrokBotTranscriptEntries');
  assert.ok(requests.some(r => r.params.beforeSeq === '2'));
  assert.equal(h.native.requests.filter(r => r.method === 'WatchGrokBotTranscripts').at(-1).params.cursors[0].afterUpdatedSeq, '1001');
  await h.emit(settle('missed-run')); await h.emit(heartbeat);
  assert.equal(h.text().match(/older-page-reply/g).length, 1);
});

test('Routine disappearance without a retained result ends its activity as unconfirmed, not success', async t => {
  const h = await connected(t);
  h.native.automations = automation([{ id: 'lost', status: 'running', startedAt: 10 }]);
  h.native.subagents = [{ subagentId: 'sand-subagent-lost' }];
  await h.emit(live({ hasRunningSubagents: true })); await h.s.routines.flight;
  h.native.automations = []; h.native.subagents = [];
  await h.emit(live({ hasRunningSubagents: false })); await h.s.routines.flight;
  assert.deepEqual(routineEvents(h).map(e => e.state), ['waiting', 'failed']);
  assert.match(routineEvents(h).at(-1).title, /无法确认结果/);
  const calls = h.native.requests.length; h.clock.advance(60000);
  assert.equal(h.native.requests.length, calls);
});

test('native failure terminates activity as failed; an old failure cannot close another run', async t => {
  const h = await connected(t), run = await sent(h);
  await h.emit(live({ isRunning: true, activity: { kind: 'tool', tool: 'SetStatus', detail: '检查连接' } }));
  h.native.emit({ turnFailed: { agentId: 'inspector', turnId: 'old-run', code: 'old_failure' } });
  await h.until(e => e.failed);
  assert.equal(h.s.turn.nativeId, run.id);
  h.native.emit({ turnFailed: { agentId: 'inspector', turnId: run.id, code: 'connection_failed' } });
  await h.until(e => e.failed); await run.done;
  const tool = h.events.find(e => e.params.update?.title === '检查连接').params.update;
  assert.ok(h.events.some(e => e.params.update?.toolCallId === tool.toolCallId && e.params.update.status === 'failed'));
});
