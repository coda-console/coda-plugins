// From Coda's backend/test/claude-entry.test.mjs at ef1d2311, as plain node:test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { ClaudeSession } from '../../../plugins/claude/agent/session.mjs';
import { describeChange } from '../../../plugins/claude/agent/permissions.mjs';
import { OTHER } from '../../../plugins/claude/agent/questions.mjs';
import { nextRun } from '../../../plugins/claude/agent/waits.mjs';
import { sdkEnvironment } from '../../../plugins/claude/agent/auth.mjs';
import { serviceSettings } from '../../../plugins/claude/agent/providers.mjs';
import { SessionTitle } from '../../../plugins/claude/agent/titles.mjs';
import { ClaudeSessionLimits, accountHash } from '../../../plugins/claude/agent/limits.mjs';
import { fixtureSdk, queries } from './fixture-sdk.mjs';
import { substituted } from '../substitute.mjs';

// The Claude entry on its own (agents/claude/), Coda's side played here: what it is asked over ACP, and what it says.
const entry = fileURLToPath(new URL('../../../plugins/claude/agent/entry.mjs', import.meta.url));
const fixture = fileURLToPath(new URL('./fixture-sdk.mjs', import.meta.url));
async function until(fn) { for (let i = 0; i < 1000; i++) { const value = await fn(); if (value) return value; await delay(5); } throw new Error('Timed out'); }
async function setup(t, { env = {}, sdk = fixtureSdk(), ...options } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'coda-claude-entry-'));
  const out = [], answered = new Set();
  let inbox, next = 0;
  const session = new ClaudeSession({ sdk, env: { ...process.env, CODA_PLUGIN_STATE: cwd, ...env }, environment: value => ({ ...value }), ...options });
  session.connect({ readable: new ReadableStream({ start(controller) { inbox = controller; } }), writable: new WritableStream({ write(m) { out.push(m); } }) });
  t.after(async () => { await session.close(); await rm(cwd, { recursive: true, force: true }); });
  const send = message => inbox.enqueue({ jsonrpc: '2.0', ...message });
  const request = (method, params) => { const id = `coda-${++next}`; send({ id, method, params }); return until(() => out.find(m => m.id === id && !m.method)); };
  const c = { cwd, out, session, send, request,
    open: async (params = {}) => {
      await request('initialize', { protocolVersion: 1, clientCapabilities: {} });
      const opened = (await request('session/new', { cwd, mcpServers: [], ...params })).result;
      c.sessionId = opened.sessionId; c.query = queries.get(opened.sessionId);
      return opened;
    },
    prompt: text => request('session/prompt', { sessionId: c.sessionId, prompt: [{ type: 'text', text }] }),
    waits: () => out.filter(m => m.method === '_coda/wait').map(m => m.params),
    updates: (sessionId = c.sessionId) => out.filter(m => m.method === 'session/update' && m.params.sessionId === sessionId).map(m => m.params.update),
    said: (sessionId = c.sessionId) => c.updates(sessionId).filter(u => u.sessionUpdate === 'agent_message_chunk').map(u => u.content.text),
    // What the SDK says, in its order, once what it has queued is through and all it brought is written.
    emit: async (...messages) => { for (const message of messages) c.query.emit(message); await c.query.stop(undefined); await request('_test/written'); },
    asked: method => until(() => out.findLast(m => m.method === method && m.id !== undefined && !answered.has(m.id))),
    answer: (id, result) => { answered.add(id); send({ id, result }); } };
  return c;
}
const system = (subtype, fields = {}) => ({ type: 'system', subtype, ...fields });
const wait = (c, waitId) => c.waits().filter(w => w.waitId === waitId).map(({ sessionId: _, ...w }) => w);

test('session/new lists the concrete models the SDK resolves its rows to, and settings go to the SDK as chosen', async t => {
  const c = await setup(t);
  const init = (await c.request('initialize', { protocolVersion: 1, clientCapabilities: {} })).result;
  assert.deepEqual(init.agentCapabilities, { loadSession: true, sessionCapabilities: { additionalDirectories: {}, systemPrompt: {} }, _meta: { coda: { waits: {} } } });
  // It takes a message into the turn going (docs/agent-protocol.md「插话」).
  assert.deepEqual(init._meta, { steering: { supported: true } });
  // The SDK it runs, by its own package version.
  assert.deepEqual(init.agentInfo, { name: 'claude-agent-sdk', version: JSON.parse(readFileSync(new URL('../../../plugins/claude/node_modules/@anthropic-ai/claude-agent-sdk/package.json', import.meta.url), 'utf8')).version });
  const opened = (await c.request('session/new', { cwd: c.cwd, mcpServers: [{ name: 'coda', command: 'node', args: ['shim.mjs'], env: [] }] })).result;
  c.sessionId = opened.sessionId; c.query = queries.get(opened.sessionId);
  const option = id => opened.configOptions.find(o => o.id === id);
  // An alias and the model it resolves to are one model, under the ID it runs as; a context variant is another.
  assert.deepEqual(option('model').options, [
    { value: 'fixture-model-v1', name: 'Fixture model (fixture-model-v1)' }, { value: 'other-model', name: 'Other model (other-model)' },
    { value: 'fixture-model-v1[1m]', name: 'Fixture long context (fixture-model-v1[1m])' }, { value: 'claude-custom-1', name: 'Custom (claude-custom-1)' }]);
  assert.deepEqual([option('model').category, option('model').currentValue], ['model', 'fixture-model-v1']);
  // Until one is chosen the model has its own, the choice marked as the agent's default.
  assert.deepEqual([option('effort').category, option('effort').currentValue, option('effort').options.map(o => o.value)], ['thought_level', 'default', ['default', 'low', 'high']]);
  assert.deepEqual(option('effort').options[0]._meta, { coda: { default: true } });
  assert.deepEqual([option('mode').category, option('mode').currentValue], ['mode', 'default']);
  assert.equal(c.query.options.permissionMode, 'default');
  assert.equal(c.query.options.allowDangerouslySkipPermissions, true);
  assert.deepEqual(c.query.options.mcpServers, { coda: { command: 'node', args: ['shim.mjs'] } });
  assert.equal(c.query.options.sessionId, c.sessionId);
  assert.deepEqual(c.query.options.systemPrompt, { type: 'preset', preset: 'claude_code' });
  assert.deepEqual(c.query.options.settings, { crossSessionInbound: 'refuse' });
  assert.equal(c.query.options.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS, '1');
  const set = (configId, value) => c.request('session/set_config_option', { sessionId: c.sessionId, configId, value });
  const changed = (await set('model', 'fixture-model-v1[1m]')).result.configOptions;
  assert.equal(c.query.model, 'fixture-model-v1[1m]');
  assert.deepEqual(changed.find(o => o.id === 'effort').options.map(o => o.value), ['default', 'high']);
  assert.equal((await set('effort', 'low')).error.code, -32602, 'an effort the model does not have');
  await set('effort', 'high'); assert.equal(c.query.effort, 'high');
  const back = (await set('effort', 'default')).result.configOptions;
  assert.deepEqual([c.query.effort, back.find(o => o.id === 'effort').currentValue], [null, 'default'], 'back to the model\'s own');
  await set('effort', 'high');
  await set('mode', 'plan'); assert.equal(c.query.mode, 'plan');
  assert.equal((await set('model', 'fixture-alias')).error.code, -32602, 'an alias is not a model');
  const full = (await set('mode', 'bypassPermissions')).result.configOptions;
  assert.equal(c.query.mode, 'bypassPermissions');
  assert.equal(full.find(o => o.id === 'mode').currentValue, 'bypassPermissions');
  await set('mode', 'default'); assert.equal(c.query.mode, 'default');
  assert.equal((await set('mode', 'unknown')).error.code, -32602);
  // The init of a turn says what runs: the variant chosen is kept for the model it is of.
  await c.prompt('hello');
  assert.equal(c.updates().findLast(u => u.sessionUpdate === 'config_option_update').configOptions.find(o => o.id === 'model').currentValue, 'fixture-model-v1[1m]');
  assert.deepEqual(c.updates().findLast(u => u.sessionUpdate === 'available_commands_update').availableCommands, [{ name: 'fixture', description: 'Fixture command' }]);
  assert.equal((await c.request('session/new', { cwd: c.cwd, mcpServers: [] })).error.code, -32600, 'one session a process');
});

test('Coda\'s session instructions follow Claude Code\'s system prompt, on a new session and a loaded one; other modes are refused', async t => {
  const systemPrompt = text => ({ mode: 'append', content: [{ type: 'text', text }] });
  const c = await setup(t);
  await c.open({ systemPrompt: systemPrompt('# Coda client\n\nReplies are shown in Coda.') });
  assert.deepEqual(c.query.options.systemPrompt, { type: 'preset', preset: 'claude_code', append: '# Coda client\n\nReplies are shown in Coda.' });
  await c.prompt('one');
  const again = await setup(t);
  await again.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  assert.ok((await again.request('session/load', { sessionId: c.sessionId, cwd: c.cwd, mcpServers: [], systemPrompt: systemPrompt('newer') })).result);
  assert.deepEqual(queries.get(c.sessionId).options.systemPrompt, { type: 'preset', preset: 'claude_code', append: 'newer' });
  const refused = await setup(t);
  await refused.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  assert.equal((await refused.request('session/new', { cwd: c.cwd, mcpServers: [], systemPrompt: { mode: 'override', content: [{ type: 'text', text: 'x' }] } })).error.code, -32602);
  assert.equal((await refused.request('session/new', { cwd: c.cwd, mcpServers: [], systemPrompt: { mode: 'append', content: [{ type: 'image', data: '', mimeType: 'image/png' }] } })).error.code, -32602);
  // Refused before anything started: the process still opens its one session.
  assert.ok((await refused.request('session/new', { cwd: c.cwd, mcpServers: [] })).result.sessionId);
});

test('session/load resumes the native session it names, and one that is not there is not found', async t => {
  const c = await setup(t), first = await c.open();
  await c.prompt('one');
  const other = await setup(t);
  await other.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  assert.equal((await other.request('session/load', { sessionId: '00000000-0000-4000-8000-000000000000', cwd: c.cwd, mcpServers: [] })).error.code, -32002);
  const again = await setup(t);
  await again.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  const loaded = (await again.request('session/load', { sessionId: first.sessionId, cwd: c.cwd, mcpServers: [] })).result;
  assert.ok(loaded.configOptions.length);
  assert.equal(queries.get(first.sessionId).options.resume, first.sessionId);
  again.sessionId = first.sessionId; again.query = queries.get(first.sessionId);
  await again.prompt('history');
  assert.deepEqual(again.said(), ['one|history']);
});

test('a prompt is answered by the result that names its input: ended, cancelled, or failed with what went wrong', async t => {
  const c = await setup(t); await c.open();
  assert.deepEqual((await c.prompt('hello')).result, { stopReason: 'end_turn' });
  assert.deepEqual(c.updates().find(u => u.sessionUpdate === 'usage_update'), { sessionUpdate: 'usage_update', used: 10, size: 1000, cost: { amount: 0, currency: 'USD' } });
  const held = c.prompt('hold');
  await until(() => c.said().includes('holding'));
  c.send({ method: 'session/cancel', params: { sessionId: c.sessionId } });
  assert.deepEqual((await held).result, { stopReason: 'cancelled' });
  // A result of another input, or of none, does not answer this one; a failure that names no input fails every prompt.
  const pending = c.prompt('delayed');
  await until(() => c.query.inputId);
  await c.emit({ type: 'result', subtype: 'success', is_error: false, user_message_uuid: 'another' });
  await c.emit({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['认证失败'] });
  const failed = await pending;
  assert.deepEqual([failed.error.code, failed.error.message], [-32603, '认证失败']);
});

test('streamed text is said as it streams, and the complete message adds only what did not stream', async t => {
  const c = await setup(t); await c.open();
  const streaming = c.prompt('stream');
  await until(() => c.said().join('') === 'first second');
  await writeFile(join(c.cwd, '.finish-stream'), '');
  await streaming;
  assert.deepEqual(c.said(), ['first ', 'second']);
  const ids = new Set(c.updates().filter(u => u.sessionUpdate === 'agent_message_chunk').map(u => u.messageId));
  assert.equal(ids.size, 1, 'one message');
  // A thought, a tool and its result, with the text of the message that called it.
  await c.emit({ type: 'assistant', message: { id: 'm2', content: [{ type: 'thinking', thinking: '想一下' }] } },
    { type: 'assistant', message: { id: 'm2', content: [{ type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: '/x' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'read-1', content: [{ type: 'text', text: '内容' }] }] }, tool_use_result: { file: '/x' } },
    // A result for a call it never said is nobody's.
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'unknown', content: 'x' }] } });
  assert.deepEqual(c.updates().slice(-3), [
    { sessionUpdate: 'agent_thought_chunk', messageId: 'm2', content: { type: 'text', text: '想一下' } },
    { sessionUpdate: 'tool_call', toolCallId: 'read-1', title: 'Read', rawInput: { file_path: '/x' }, status: 'in_progress' },
    { sessionUpdate: 'tool_call_update', toolCallId: 'read-1', status: 'completed', rawOutput: { file: '/x' }, content: [{ type: 'content', content: { type: 'text', text: '内容' } }] }]);
});

const quotaReason = "You've hit your session limit · resets 1am (Asia/Singapore)";
const apiError = (error, reason, fields = {}) => ({ type: 'assistant', error, ...fields,
  message: { id: 'api-error', model: '<synthetic>', content: [{ type: 'text', text: reason }] } });

test('Claude quota failures reach ACP as quota_exhausted, retaining the reset time instead of an assistant reply', async t => {
  for (const variant of ['assistant', 'result-only', 'rejected-window', 'no-input-id']) await t.test(variant, async t => {
    const c = await setup(t); await c.open();
    const pending = c.prompt('manual'); await until(() => c.query.inputId);
    const reason = variant === 'rejected-window' ? 'Subscription window exhausted' : quotaReason;
    if (variant !== 'result-only') await c.emit(apiError('rate_limit', reason));
    if (variant === 'rejected-window') await c.emit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour' } });
    await c.emit({ type: 'result', subtype: 'success', is_error: true, result: reason,
      ...(variant === 'no-input-id' ? {} : { user_message_uuid: c.query.inputId }) });
    assert.deepEqual((await pending).error, { code: -32603, message: reason, data: { _meta: { coda: { failure: { kind: 'quota_exhausted' } } } } });
    assert.deepEqual(c.said(), []);
  });
});

test('quota evidence belongs to its failed turn: normal prose, warnings, recovery, cancellation and child errors do not fail a prompt', async t => {
  for (const variant of ['prose', 'warning', 'recovered', 'cancelled', 'child']) await t.test(variant, async t => {
    const c = await setup(t); await c.open();
    const pending = c.prompt('manual'); await until(() => c.query.inputId);
    if (variant === 'prose') await c.emit(apiError(undefined, quotaReason));
    if (variant === 'warning') await c.emit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', utilization: 1 } });
    if (variant === 'child') await c.emit(apiError('rate_limit', quotaReason, { parent_tool_use_id: 'child' }));
    if (['recovered', 'cancelled'].includes(variant)) await c.emit(apiError('rate_limit', quotaReason),
      { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour' } });
    if (variant === 'recovered') await c.emit(apiError(undefined, 'Recovered'));
    await c.emit({ type: 'result', subtype: 'success', is_error: variant === 'cancelled', result: quotaReason,
      stop_reason: variant === 'cancelled' ? 'interrupt' : 'end_turn', user_message_uuid: c.query.inputId });
    assert.deepEqual((await pending).result, { stopReason: variant === 'cancelled' ? 'cancelled' : 'end_turn' });
    // Another failed turn must not inherit the earlier rejected window or API error.
    const before = c.query.inputId, next = c.prompt('manual'); await until(() => c.query.inputId !== before);
    await c.emit({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['HTTP 429 Too Many Requests'], user_message_uuid: c.query.inputId });
    assert.equal((await next).error.data, undefined);
  });
});

test('a quota failure in an autonomous turn is a failed activity, and the successful task it handles stays successful', async t => {
  const c = await setup(t); await c.open();
  await c.prompt('hello');
  await c.emit(system('task_started', { task_id: 'completed-task', task_type: 'local_bash', is_backgrounded: true }),
    system('task_notification', { task_id: 'completed-task', status: 'completed' }),
    system('init', { session_id: c.sessionId }), apiError('rate_limit', quotaReason),
    { type: 'result', subtype: 'success', is_error: true, result: quotaReason });
  assert.deepEqual(wait(c, 'completed-task').map(w => w.state), ['waiting', 'handling', 'done']);
  assert.deepEqual(wait(c, 'turn-1').map(w => w.state), ['handling', 'failed']);
  assert.deepEqual(wait(c, 'turn-1').at(-1), { waitId: 'turn-1', state: 'failed', title: '额度不足', detail: quotaReason });
  assert.deepEqual(c.said(), ['hello']);
  // A later autonomous turn starts with no quota failure carried over.
  await c.emit(system('init', { session_id: c.sessionId }), { type: 'assistant', message: { id: 'later', content: [{ type: 'text', text: '接着做' }] } },
    { type: 'result', subtype: 'success', is_error: false });
  assert.equal(wait(c, 'turn-2').at(-1).state, 'done');
});

test('quota failure keeps its classification while queued steering is dropped', async t => {
  const c = await setup(t); await c.open();
  const pending = c.prompt('hold'); await until(() => c.said().includes('holding'));
  await c.request('_session/steering', { sessionId: c.sessionId, prompt: [{ type: 'text', text: 'must not run' }] });
  await c.emit(apiError('rate_limit', quotaReason),
    { type: 'result', subtype: 'success', is_error: true, result: quotaReason, user_message_uuid: c.query.inputId });
  assert.equal((await pending).error.data._meta.coda.failure.kind, 'quota_exhausted');
  assert.ok(!c.query.entries.some(e => e.text === 'must not run'));
  assert.deepEqual((await c.prompt('after reset')).result, { stopReason: 'end_turn' });
});

test('a failed scheduled turn has a failure card while its recurring schedule remains waiting', async t => {
  const c = await setup(t); await c.open();
  await c.query.stop([{ id: 'cron', schedule: '0 9 1 1 *', recurring: true, prompt: 'check' }]);
  await c.emit(system('init', { session_id: c.sessionId }), apiError('rate_limit', quotaReason),
    { type: 'result', subtype: 'success', is_error: true, result: quotaReason });
  assert.deepEqual(wait(c, 'cron').map(w => w.state), ['waiting', 'handling', 'waiting']);
  assert.deepEqual(wait(c, 'turn-1').at(-1), { waitId: 'turn-1', state: 'failed', title: '额度不足', detail: quotaReason });
});

test('a background command is waited on from its start; it ends as a turn takes in its end, or as the session goes idle', async t => {
  const c = await setup(t); await c.open();
  await c.prompt('background');
  assert.deepEqual(wait(c, 'bg-1'), [{ waitId: 'bg-1', state: 'waiting', kind: 'task', title: '后台测试', stoppable: true, toolCallId: 'tool-bg' }]);
  // Where it writes, as its launch said.
  await c.emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-bg', content: 'Output is being written to: /tmp/tasks/bg-1.output' }] } });
  assert.deepEqual(wait(c, 'bg-1').at(-1), { waitId: 'bg-1', state: 'waiting', outputFile: '/tmp/tasks/bg-1.output' });
  // Ended with no turn going: it will wake Claude, so it is still waited on.
  await c.emit(system('task_notification', { task_id: 'bg-1', status: 'completed' }));
  assert.equal(wait(c, 'bg-1').at(-1).state, 'waiting');
  // Claude takes it up in a turn of its own: handled before anything said in it, and done when that turn ends.
  await c.emit(system('init', { session_id: c.sessionId, model: 'fixture-model-v1', permissionMode: 'default' }));
  await c.emit({ type: 'assistant', message: { id: 'woken', content: [{ type: 'text', text: '处理结果' }] } });
  const order = c.out.filter(m => m.method === '_coda/wait' || m.params?.update?.sessionUpdate === 'agent_message_chunk').slice(-2);
  assert.deepEqual(order.map(m => m.params.state ?? m.params.update.content.text), ['handling', '处理结果']);
  await c.emit({ type: 'result', subtype: 'success', is_error: false });
  assert.equal(wait(c, 'bg-1').at(-1).state, 'done');
  // One that ends while a turn goes is taken in by it, and ends at once.
  await c.prompt('background-second');
  const held = c.prompt('hold');
  await until(() => c.said().includes('holding'));
  await c.emit(system('task_notification', { task_id: 'bg-2', status: 'failed' }));
  assert.equal(wait(c, 'bg-2').at(-1).state, 'failed');
  c.send({ method: 'session/cancel', params: { sessionId: c.sessionId } }); await held;
  // One that ends after the turn, before an idle: not woken for, it ends as the session says idle.
  await c.emit(system('task_started', { task_id: 'bg-3', task_type: 'local_bash', description: '三', is_backgrounded: true }),
    system('task_notification', { task_id: 'bg-3', status: 'killed' }));
  assert.equal(wait(c, 'bg-3').at(-1).state, 'waiting');
  await c.emit(system('session_state_changed', { state: 'idle' }));
  assert.equal(wait(c, 'bg-3').at(-1).state, 'cancelled');
  // What leaves the list of background tasks has ended; ambient ones are not waited on.
  await c.emit(system('background_tasks_changed', { tasks: [{ task_id: 'bg-4', task_type: 'local_bash' }, { task_id: 'watch', task_type: 'monitor', ambient: true }] }));
  assert.deepEqual(wait(c, 'watch'), []);
  await c.emit(system('session_state_changed', { state: 'running' }), system('background_tasks_changed', { tasks: [] }), system('session_state_changed', { state: 'idle' }));
  assert.equal(wait(c, 'bg-4').at(-1).state, 'done');
});

test('Coda stops a task through the SDK; the stop is confirmed by the task\'s own end', async t => {
  const c = await setup(t); await c.open();
  await c.prompt('background');
  assert.deepEqual((await c.request('_coda/wait/stop', { sessionId: c.sessionId, waitId: 'bg-1' })).result, {});
  await until(() => wait(c, 'bg-1').some(w => w.state === 'cancelled'));
  assert.equal((await c.request('_coda/wait/stop', { sessionId: c.sessionId, waitId: 'bg-1' })).error.code, -32602, 'nothing left to stop');
  // One that ended and is yet to be taken in is not stopped again: it ends now, as it ended.
  await c.emit(system('task_started', { task_id: 'bg-2', task_type: 'local_bash', is_backgrounded: true }), system('task_notification', { task_id: 'bg-2', status: 'failed' }));
  assert.equal(wait(c, 'bg-2').at(-1).state, 'waiting');
  assert.deepEqual((await c.request('_coda/wait/stop', { sessionId: c.sessionId, waitId: 'bg-2' })).result, {});
  assert.equal(wait(c, 'bg-2').at(-1).state, 'failed');
});

test('a command in the foreground is its tool call, not a wait; put in the background, it is waited on', async t => {
  const c = await setup(t); await c.open();
  // A subagent in the background runs its commands while no turn goes: each ends with its call, none is left waited on.
  await c.emit(system('task_started', { task_id: 'agent-1', tool_use_id: 'agent-call', task_type: 'local_agent', description: '查', is_backgrounded: true }));
  for (const id of ['fg-1', 'fg-2'])
    await c.emit(system('task_started', { task_id: id, tool_use_id: `${id}-call`, task_type: 'local_bash', description: id, is_backgrounded: false, parent_task_id: 'agent-1' }),
      system('task_updated', { task_id: id, patch: { status: 'completed' } }), system('task_notification', { task_id: id, status: 'completed' }));
  assert.deepEqual([...new Set(c.waits().map(w => w.waitId))], ['agent-1']);
  // One past its timeout is put in the background, as begun there.
  await c.emit(system('task_started', { task_id: 'fg-3', tool_use_id: 'fg-3-call', task_type: 'local_bash', description: 'build', is_backgrounded: false }),
    system('task_updated', { task_id: 'fg-3', patch: { is_backgrounded: true } }));
  assert.deepEqual(wait(c, 'fg-3'), [{ waitId: 'fg-3', state: 'waiting', kind: 'task', title: 'build', stoppable: true, toolCallId: 'fg-3-call' }]);
  // The list of background tasks can say so first.
  await c.emit(system('task_started', { task_id: 'fg-4', run_id: 'r4', tool_use_id: 'fg-4-call', task_type: 'local_bash', description: 'test', is_backgrounded: false }),
    system('background_tasks_changed', { tasks: [{ task_id: 'fg-3', task_type: 'local_bash' }, { task_id: 'fg-4', run_id: 'r4', task_type: 'local_bash', description: 'test' }] }));
  assert.deepEqual(wait(c, 'fg-4'), [{ waitId: 'fg-4', state: 'waiting', kind: 'task', title: 'test', stoppable: true, toolCallId: 'fg-4-call' }]);
});

test('a turn of Claude\'s own handles what its opening message names, else the one wakeup there is, else a wait of its own', async t => {
  const c = await setup(t); await c.open();
  await c.prompt('scheduled');
  assert.deepEqual(wait(c, 'cron-1')[0], { waitId: 'cron-1', state: 'waiting', kind: 'timer', title: 'fixture followup', detail: '47 11 23 9 *',
    recurring: false, stoppable: false, at: new Date(nextRun('47 11 23 9 *')).toISOString() });
  // Two commands end; the turn that follows says which woke it.
  for (const [id, run] of [['bg-8', 'run-8'], ['bg-9', 'run-9']])
    await c.emit(system('task_started', { task_id: id, run_id: run, task_type: 'local_bash', description: id, is_backgrounded: true }), system('task_notification', { task_id: id, status: 'completed' }));
  await c.emit(system('init', { session_id: c.sessionId }), { type: 'user', message: { role: 'user', content: '<task-notification>' }, origin: { kind: 'task-notification', runId: 'run-9' } });
  assert.deepEqual(['bg-8', 'bg-9'].map(id => wait(c, id).at(-1).state), ['waiting', 'handling'], 'the one it names is the one handled');
  await c.emit({ type: 'result', subtype: 'success', is_error: false });
  assert.deepEqual(['bg-8', 'bg-9'].map(id => wait(c, id).at(-1).state), ['waiting', 'done']);
  await c.emit(system('session_state_changed', { state: 'idle' }));
  // The only wakeup there is: handled, and the snapshot that removes it while it is handled ends it with the turn.
  await c.emit(system('init', { session_id: c.sessionId }));
  await c.emit({ type: 'assistant', message: { id: 'cron-turn', content: [{ type: 'text', text: '定时执行' }] } });
  assert.equal(wait(c, 'cron-1').at(-1).state, 'handling');
  await c.query.stop([]);
  assert.equal(wait(c, 'cron-1').at(-1).state, 'handling');
  await c.emit({ type: 'result', subtype: 'success', is_error: false });
  assert.equal(wait(c, 'cron-1').at(-1).state, 'done');
  // Nothing to say what woke it: a wait of the turn's own, which fails with the reason when that turn fails.
  await c.emit(system('init', { session_id: c.sessionId }), { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['出错了'], uuid: 'r' });
  const own = c.waits().filter(w => w.waitId.startsWith('turn-'));
  assert.deepEqual(own.map(({ sessionId: _, ...w }) => w), [{ waitId: 'turn-1', state: 'handling', kind: 'task', title: 'Claude 自主继续', stoppable: false }, { waitId: 'turn-1', state: 'failed', detail: '出错了' }]);
  assert.ok(!c.said().includes('出错了'));
});

test('what Claude asks in a turn of its own comes after what that turn handles, so that Coda takes it in that turn', async t => {
  const c = await setup(t); await c.open();
  await c.emit(system('init', { session_id: c.sessionId }));
  const asking = c.query.options.canUseTool('Bash', { command: 'ls' }, { signal: new AbortController().signal, toolUseID: 'own-bash' });
  const request = await c.asked('session/request_permission');
  const said = c.out.filter(m => m.method === '_coda/wait' || m === request);
  assert.deepEqual(said.map(m => m.params.state ?? m.method), ['handling', 'session/request_permission']);
  c.answer(request.id, { outcome: { outcome: 'selected', optionId: 'deny' } });
  assert.equal((await asking).behavior, 'deny');
});

test('a subagent\'s report handed back is that subagent\'s turn; Claude Code\'s turn for its notice after says nothing and is not told', async t => {
  const c = await setup(t); await c.open();
  await c.prompt('hello');
  await c.emit(system('task_started', { task_id: 'agent-1', run_id: 'run-a', tool_use_id: 'agent-call', task_type: 'local_agent', description: '查', is_backgrounded: true }));
  // Its report comes before its end is told: the turn it opens is the subagent's all the same, and ends it with the turn.
  await c.emit(system('init', { session_id: c.sessionId }),
    { type: 'user', message: { role: 'user', content: '<agent-message from="agent-1">' }, origin: { kind: 'peer', from: 'agent-1', senderTaskId: 'agent-1' } },
    system('task_notification', { task_id: 'agent-1', status: 'completed' }),
    { type: 'assistant', message: { id: 'read', content: [{ type: 'text', text: '子 Agent 查完了' }] } }, { type: 'result', subtype: 'success', is_error: false });
  assert.deepEqual(wait(c, 'agent-1').map(w => w.state), ['waiting', 'handling', 'done']);
  // The notice of its end, which reaches no model, opens a turn that says nothing: not told at all.
  await c.emit(system('init', { session_id: c.sessionId }),
    { type: 'user', message: { role: 'user', content: '<task-notification>' }, origin: { kind: 'task-notification', producer: 'session-task', runId: 'run-a' } },
    { type: 'result', subtype: 'success', is_error: false });
  assert.deepEqual(c.waits().filter(w => w.waitId.startsWith('turn-')), []);
  assert.deepEqual(wait(c, 'agent-1').map(w => w.state), ['waiting', 'handling', 'done']);
  // One that names nothing and says something is told as a wait of its own before what it says.
  await c.emit(system('init', { session_id: c.sessionId }), { type: 'assistant', message: { id: 'own', content: [{ type: 'text', text: '自己接着做' }] } },
    { type: 'result', subtype: 'success', is_error: false });
  const told = c.out.filter(m => (m.method === '_coda/wait' && m.params.waitId === 'turn-1') || (m.method === 'session/update' && m.params.update.content?.text === '自己接着做'));
  assert.deepEqual(told.map(m => m.params.state ?? m.params.update.sessionUpdate), ['handling', 'agent_message_chunk', 'done']);
});

test('a recurring wakeup that fires waits for its next time; several of which none is due make a turn of no known cause', async t => {
  const c = await setup(t); await c.open();
  // Neither is due now: the first of January.
  await c.query.stop([{ id: 'hourly', schedule: '0 9 1 1 *', recurring: true, prompt: '看看 CI' }, { id: 'daily', schedule: '0 10 1 1 *', recurring: true, prompt: '日报' }]);
  await c.emit(system('init', { session_id: c.sessionId }), { type: 'assistant', message: { id: 'which', content: [{ type: 'text', text: '到点了' }] } },
    { type: 'result', subtype: 'success', is_error: false });
  assert.deepEqual(wait(c, 'turn-1').map(w => w.state), ['handling', 'done'], 'which of them fired is not told');
  assert.deepEqual(['hourly', 'daily'].map(id => wait(c, id).length), [1, 1]);
  // The one Claude says fired is handled, and waits again.
  await c.emit(system('init', { session_id: c.sessionId }), { type: 'user', message: { role: 'user', content: '看看 CI' }, origin: { kind: 'task-notification', subkind: 'scheduled-trigger' } });
  assert.equal(wait(c, 'hourly').at(-1).state, 'handling');
  await c.emit({ type: 'result', subtype: 'success', is_error: false });
  assert.equal(wait(c, 'hourly').at(-1).state, 'waiting');
  assert.ok(Date.parse(wait(c, 'hourly').at(-1).at) > Date.now());
  assert.equal(new Date(nextRun('0 * * * *', Date.parse('2026-10-12T10:30:00')) ).getMinutes(), 0);
  assert.equal(nextRun('*/15 9-17 * * 1-5', Date.parse('2026-10-10T12:00:00')), Date.parse('2026-10-12T09:00:00'), 'a weekday schedule skips the weekend');
  assert.equal(nextRun('0 0 31 2 *'), null, 'never');
  assert.equal(nextRun('every hour'), null);
});

test('a subagent\'s session is its launching call: what it says before its task is kept for it, its model and continued runs are told', async t => {
  const c = await setup(t); await c.open();
  await c.prompt('hello');
  const child = 'agent-call';
  await c.emit({ type: 'assistant', message: { id: 'launch', content: [{ type: 'tool_use', id: child, name: 'Agent', input: { description: '查环境', subagent_type: 'Explore' } }] } },
    { type: 'assistant', parent_tool_use_id: child, message: { id: 'c1', model: 'child-model', content: [{ type: 'text', text: '子 Agent 第一句' }] } });
  assert.deepEqual(c.updates(child), [], 'not before Coda knows the session');
  await c.emit(system('task_started', { task_id: 'agent-1', tool_use_id: child, task_type: 'local_agent', description: '查环境', is_backgrounded: true }));
  assert.deepEqual(wait(c, 'agent-1'), [{ waitId: 'agent-1', state: 'waiting', kind: 'subagent', title: '查环境', stoppable: true, childSessionId: child, toolCallId: child, model: 'child-model' }]);
  assert.deepEqual(c.said(child), ['子 Agent 第一句']);
  // Its permission requests are in its session.
  const asking = c.query.options.canUseTool('Bash', { command: 'ls' }, { signal: new AbortController().signal, toolUseID: 'child-bash', agentID: 'agent-1', suggestions: [] });
  const request = await c.asked('session/request_permission');
  assert.equal(request.params.sessionId, child);
  c.answer(request.id, { outcome: { outcome: 'selected', optionId: 'allow-once' } });
  assert.deepEqual(await asking, { behavior: 'allow', updatedInput: { command: 'ls' } });
  await c.emit({ type: 'stream_event', parent_tool_use_id: child, event: { type: 'message_start', message: { id: 'c2', model: 'next-model' } } });
  assert.deepEqual(wait(c, 'agent-1').at(-1), { waitId: 'agent-1', state: 'waiting', model: 'next-model' });
  // Ended in the turn; continued by another call it is a new run of the same session.
  const held = c.prompt('hold'); await until(() => c.said().includes('holding'));
  await c.emit(system('task_notification', { task_id: 'agent-1', status: 'completed' }));
  await c.emit(system('task_started', { task_id: 'agent-1', tool_use_id: child, task_type: 'local_agent', description: '查环境' }));
  assert.equal(wait(c, 'agent-1').at(-1).state, 'done', 'a repeated start of the same call revives nothing');
  await c.emit(system('task_started', { task_id: 'agent-1', tool_use_id: 'send-call', task_type: 'local_agent', description: '修评审' }));
  assert.deepEqual(wait(c, 'agent-1#2'), [{ waitId: 'agent-1#2', state: 'waiting', kind: 'subagent', title: '修评审', childSessionId: child, stoppable: true, model: 'next-model' }]);
  c.send({ method: 'session/cancel', params: { sessionId: c.sessionId } }); await held;
});

test('a subagent listed and ended before its start is one run: its end waits for its session, and a start of that run begins none', async t => {
  const c = await setup(t); await c.open();
  const held = c.prompt('hold'); await until(() => c.said().includes('holding'));
  const child = 'agent-call';
  await c.emit(system('background_tasks_changed', { tasks: [{ task_id: 'agent-1', run_id: 'r1', task_type: 'local_agent', description: '查环境' }] }),
    { type: 'assistant', parent_tool_use_id: child, message: { id: 'c1', model: 'child-model', content: [{ type: 'text', text: '子 Agent 说完了' }] } },
    system('task_notification', { task_id: 'agent-1', status: 'completed' }));
  assert.equal(wait(c, 'agent-1').at(-1).state, 'waiting', 'not ended before its session is known');
  await c.emit(system('task_started', { task_id: 'agent-1', run_id: 'r1', tool_use_id: child, task_type: 'local_agent', description: '查环境' }));
  assert.deepEqual(wait(c, 'agent-1').slice(-2), [{ waitId: 'agent-1', state: 'waiting', childSessionId: child, toolCallId: child, model: 'child-model' },
    { waitId: 'agent-1', state: 'done' }], 'the turn going takes in its end once its session is told');
  assert.deepEqual(c.said(child), ['子 Agent 说完了']);
  c.send({ method: 'session/cancel', params: { sessionId: c.sessionId } }); await held;
  // Its start comes only after the turn took in its end: nothing begins, and what it said there is passed on.
  await c.emit(system('background_tasks_changed', { tasks: [{ task_id: 'agent-2', run_id: 'r2', task_type: 'local_agent', description: '查日志' }] }),
    { type: 'assistant', parent_tool_use_id: 'late-call', message: { id: 'c2', content: [{ type: 'text', text: '迟到的身份' }] } },
    system('task_notification', { task_id: 'agent-2', status: 'completed' }), system('session_state_changed', { state: 'idle' }));
  assert.equal(wait(c, 'agent-2').at(-1).state, 'done', 'with no turn to take it in, the idle session ends it');
  await c.emit(system('task_started', { task_id: 'agent-2', run_id: 'r2', tool_use_id: 'late-call', task_type: 'local_agent', description: '查日志' }));
  assert.deepEqual([wait(c, 'agent-2').at(-1).state, c.waits().filter(w => w.waitId.startsWith('agent-1#') || w.waitId.startsWith('agent-2#'))], ['done', []]);
  assert.deepEqual(c.said('late-call'), ['迟到的身份']);
});

test('all a subagent says before its task is kept for it, however much: its text whole and once, its tools as they went', async t => {
  const c = await setup(t); await c.open();
  await c.prompt('hello');
  const child = 'agent-call', pieces = Array.from({ length: 600 }, (_, i) => String(i % 10)), stream = event => ({ type: 'stream_event', parent_tool_use_id: child, event });
  await c.emit(stream({ type: 'message_start', message: { id: 'c1', model: 'child-model' } }),
    stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    ...pieces.map(text => stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })),
    { type: 'assistant', parent_tool_use_id: child, message: { id: 'c1', model: 'child-model', content: [{ type: 'text', text: pieces.join('') }] } },
    { type: 'assistant', parent_tool_use_id: child, message: { id: 'c1', model: 'child-model', content: [{ type: 'tool_use', id: 'child-tool', name: 'Bash', input: { command: 'ls' } }] } },
    { type: 'user', parent_tool_use_id: child, message: { content: [{ type: 'tool_result', tool_use_id: 'child-tool', content: 'done' }] } });
  await c.emit(system('task_started', { task_id: 'agent-1', tool_use_id: child, task_type: 'local_agent', description: '查环境' }));
  assert.equal(c.said(child).join(''), pieces.join(''));
  assert.deepEqual(c.updates(child).filter(u => u.toolCallId === 'child-tool').map(u => [u.sessionUpdate, u.status]), [['tool_call', 'in_progress'], ['tool_call_update', 'completed']]);
});

test('a subagent listed before its start is told its launching call\'s session once the start says it, and what it said there goes with it', async t => {
  const c = await setup(t); await c.open();
  await c.prompt('hello');
  const child = 'agent-call';
  // The snapshot names no tool call: the subagent is waited on, its session not yet known.
  await c.emit(system('background_tasks_changed', { tasks: [{ task_id: 'agent-1', run_id: 'r1', task_type: 'local_agent', description: '查环境' }] }),
    { type: 'assistant', parent_tool_use_id: child, message: { id: 'c1', model: 'child-model', content: [{ type: 'text', text: '子 Agent 第一句' }] } });
  assert.deepEqual(c.updates(child), []);
  await c.emit(system('task_started', { task_id: 'agent-1', run_id: 'r1', tool_use_id: child, task_type: 'local_agent', description: '查环境', is_backgrounded: true }));
  assert.deepEqual(wait(c, 'agent-1').at(-1), { waitId: 'agent-1', state: 'waiting', childSessionId: child, toolCallId: child, model: 'child-model' });
  assert.deepEqual(c.said(child), ['子 Agent 第一句']);
  const asking = c.query.options.canUseTool('Bash', { command: 'ls' }, { signal: new AbortController().signal, toolUseID: 'child-bash', agentID: 'agent-1', suggestions: [] });
  const request = await c.asked('session/request_permission');
  assert.equal(request.params.sessionId, child, 'its requests are in its session');
  c.answer(request.id, { outcome: { outcome: 'selected', optionId: 'allow-once' } });
  await asking;
  // A command listed first gets its launching call the same way.
  await c.emit(system('background_tasks_changed', { tasks: [{ task_id: 'agent-1', run_id: 'r1', task_type: 'local_agent', description: '查环境' },
    { task_id: 'bg-1', run_id: 'r2', task_type: 'local_bash', description: 'sleep' }] }));
  await c.emit(system('task_started', { task_id: 'bg-1', run_id: 'r2', tool_use_id: 'bash-call', task_type: 'local_bash', description: 'sleep' }));
  assert.deepEqual(wait(c, 'bg-1').at(-1), { waitId: 'bg-1', state: 'waiting', toolCallId: 'bash-call' });
});

test('what a subagent launches is told in its session, once a wait has told Coda that session: what it said before goes first', async t => {
  const c = await setup(t); await c.open();
  await c.prompt('hello');
  const sessions = waitId => c.waits().filter(w => w.waitId === waitId).map(w => w.sessionId);
  const at = (waitId, fields = {}) => c.out.findIndex(m => m.method === '_coda/wait' && m.params.waitId === waitId && Object.entries(fields).every(([k, v]) => m.params[k] === v));
  // A command its subagent launched while that subagent is listed with no launching call, and one whose subagent is not yet known.
  await c.emit(system('background_tasks_changed', { tasks: [{ task_id: 'agent-1', run_id: 'r1', task_type: 'local_agent', description: '查环境' }] }),
    system('task_started', { task_id: 'bg-1', tool_use_id: 'bash-1', task_type: 'local_bash', description: 'sleep', is_backgrounded: true, parent_task_id: 'agent-1' }),
    system('task_updated', { task_id: 'bg-1', patch: { description: 'sleep 60' } }),
    system('task_started', { task_id: 'bg-2', tool_use_id: 'bash-2', task_type: 'local_bash', description: 'tail', is_backgrounded: true, parent_task_id: 'agent-2' }));
  assert.deepEqual([wait(c, 'bg-1'), wait(c, 'bg-2')], [[], []], 'not before Coda knows the session');
  await c.emit(system('task_started', { task_id: 'agent-1', run_id: 'r1', tool_use_id: 'agent-call', task_type: 'local_agent', description: '查环境', is_backgrounded: true }));
  assert.deepEqual(wait(c, 'bg-1'), [{ waitId: 'bg-1', state: 'waiting', kind: 'task', title: 'sleep', stoppable: true, toolCallId: 'bash-1' },
    { waitId: 'bg-1', state: 'waiting', title: 'sleep 60' }]);
  assert.deepEqual(sessions('bg-1'), ['agent-call', 'agent-call']);
  assert.ok(at('agent-1', { childSessionId: 'agent-call' }) < at('bg-1'), 'after the wait that names the session');
  // A subagent it launches is in its session too, and what that one launched follows it into its own.
  await c.emit(system('task_started', { task_id: 'agent-2', tool_use_id: 'agent-2-call', task_type: 'local_agent', description: '看日志', is_backgrounded: true, parent_task_id: 'agent-1' }));
  assert.deepEqual(c.waits().filter(w => w.waitId === 'agent-2'), [{ sessionId: 'agent-call', waitId: 'agent-2', state: 'waiting', kind: 'subagent', title: '看日志',
    stoppable: true, childSessionId: 'agent-2-call', toolCallId: 'agent-2-call' }]);
  assert.deepEqual(c.waits().filter(w => w.waitId === 'bg-2'), [{ sessionId: 'agent-2-call', waitId: 'bg-2', state: 'waiting', kind: 'task', title: 'tail', stoppable: true, toolCallId: 'bash-2' }]);
  assert.ok(at('agent-2') < at('bg-2'));
  // Its end, as the session settles, is told there too; the main thread's own stay in the session's own.
  await c.emit(system('task_started', { task_id: 'bg-3', tool_use_id: 'bash-3', task_type: 'local_bash', description: 'build', is_backgrounded: true }),
    system('task_notification', { task_id: 'bg-1', status: 'completed' }), system('session_state_changed', { state: 'idle' }));
  assert.deepEqual(c.waits().filter(w => w.waitId === 'bg-1').at(-1), { sessionId: 'agent-call', waitId: 'bg-1', state: 'done' });
  assert.deepEqual(sessions('bg-3'), [c.sessionId]);
});

test('Coda stops what a subagent launched by that subagent\'s session', async t => {
  const c = await setup(t); await c.open();
  await c.emit(system('task_started', { task_id: 'agent-1', tool_use_id: 'agent-call', task_type: 'local_agent', description: '查环境', is_backgrounded: true }),
    system('task_started', { task_id: 'bg-1', tool_use_id: 'bash-1', task_type: 'local_bash', description: 'sleep', is_backgrounded: true, parent_task_id: 'agent-1' }));
  assert.deepEqual((await c.request('_coda/wait/stop', { sessionId: 'agent-call', waitId: 'bg-1' })).result, {});
  await until(() => wait(c, 'bg-1').some(w => w.state === 'cancelled'));
  assert.deepEqual([...new Set(c.waits().filter(w => w.waitId === 'bg-1').map(w => w.sessionId))], ['agent-call']);
  assert.equal((await c.request('_coda/wait/stop', { sessionId: 'agent-call', waitId: 'bg-1' })).error.code, -32602, 'nothing left to stop');
});

test('approvals offer allow once, each suggested rule by its whole sentence, and deny; a withdrawn one is withdrawn from Coda too', async t => {
  const c = await setup(t); await c.open();
  const reading = { type: 'addRules', destination: 'session', behavior: 'allow', rules: [{ toolName: 'Read', ruleContent: `/${homedir()}/.local/**` }] };
  const suggestions = [{ type: 'addRules', destination: 'localSettings', behavior: 'allow', rules: [{ toolName: 'Bash', ruleContent: 'ls x' }] },
    { type: 'addDirectories', destination: 'session', directories: ['/opt/skills'] }, reading, reading,
    { type: 'addRules', destination: 'session', behavior: 'allow', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }] },
    { type: 'replaceRules', destination: 'userSettings', behavior: 'allow', rules: [{ toolName: 'WebFetch', ruleContent: 'domain:example.com' }] }];
  const asking = c.query.options.canUseTool('Bash', { command: 'ls x' }, { signal: new AbortController().signal, toolUseID: 'bash-1', decisionReason: 'outside cwd', suggestions });
  const request = await c.asked('session/request_permission');
  assert.deepEqual(request.params.options, [{ optionId: 'allow-once', name: '仅允许本次', kind: 'allow_once' },
    { optionId: 'suggestion-0', name: '允许这条完全相同的命令（本项目 · 本机）', kind: 'allow_always' },
    { optionId: 'suggestion-1', name: '允许访问目录 /opt/skills（本会话）', kind: 'allow_always' },
    { optionId: 'suggestion-2', name: '允许读取 ~/.local/**（本会话）', kind: 'allow_always' },
    { optionId: 'suggestion-3', name: '允许以此开头的命令 npm test（本会话）', kind: 'allow_always' },
    { optionId: 'suggestion-4', name: '替换现有规则为：允许访问 example.com（所有项目）', kind: 'allow_always' },
    { optionId: 'deny', name: '拒绝', kind: 'reject_once' }]);
  assert.deepEqual(request.params.toolCall, { toolCallId: 'bash-1', title: 'Bash', rawInput: { command: 'ls x' }, status: 'pending',
    content: [{ type: 'content', content: { type: 'text', text: 'outside cwd' } }] });
  c.answer(request.id, { outcome: { outcome: 'selected', optionId: 'suggestion-3' } });
  assert.deepEqual(await asking, { behavior: 'allow', updatedInput: { command: 'ls x' }, updatedPermissions: [suggestions[4]] });
  assert.equal(describeChange({ type: 'setMode', mode: 'acceptEdits', destination: 'session' }), '切换为「自动允许修改文件」模式（本会话）');
  // An option never offered, and a refusal, deny.
  const invented = c.query.options.canUseTool('Bash', {}, { signal: new AbortController().signal, toolUseID: 'bash-2' });
  c.answer((await c.asked('session/request_permission')).id, { outcome: { outcome: 'selected', optionId: 'suggestion-9' } });
  assert.equal((await invented).behavior, 'deny');
  // The SDK stops waiting (the turn was interrupted): Coda is told to stop asking, and the SDK is answered at once.
  const controller = new AbortController();
  const withdrawn = c.query.options.canUseTool('Bash', {}, { signal: controller.signal, toolUseID: 'bash-3' });
  const pending = await c.asked('session/request_permission');
  controller.abort();
  assert.equal((await withdrawn).behavior, 'deny');
  await until(() => c.out.some(m => m.method === '$/cancel_request' && m.params.requestId === pending.id));
});

test('Claude\'s questions are a plain form: a choice per question, one of them the answer written beside it', async t => {
  const c = await setup(t); await c.open();
  const input = { questions: [{ question: '选一个', header: '方式', options: [{ label: 'A', description: '第一种' }, { label: 'B' }], multiSelect: false },
    { question: '选多个', options: [{ label: 'X' }, { label: 'Y' }], multiSelect: true }] };
  const asking = c.query.options.canUseTool('AskUserQuestion', input, { signal: new AbortController().signal, toolUseID: 'ask-1' });
  const request = await c.asked('elicitation/create');
  const choices = [{ const: 'A', title: 'A — 第一种' }, { const: 'B', title: 'B' }, { const: OTHER, title: '其他（写在下面）' }];
  assert.deepEqual(request.params, { sessionId: c.sessionId, toolCallId: 'ask-1', mode: 'form', message: 'Claude 需要你的回答', requestedSchema: { type: 'object', properties: {
    q0: { title: '选一个', description: '方式', type: 'string', oneOf: choices }, q0_other: { type: 'string', title: '其他' },
    q1: { title: '选多个', description: '', type: 'array', items: { anyOf: [{ const: 'X', title: 'X' }, { const: 'Y', title: 'Y' }, { const: OTHER, title: '其他（写在下面）' }] }, minItems: 1 },
    q1_other: { type: 'string', title: '其他' } }, required: ['q0', 'q1'] } });
  c.answer(request.id, { action: 'accept', content: { q0: OTHER, q0_other: 'C', q1: ['X', OTHER], q1_other: 'Z' } });
  assert.deepEqual((await asking).updatedInput.answers, { 选一个: 'C', 选多个: 'X, Z' });
  const declined = c.query.options.canUseTool('AskUserQuestion', input, { signal: new AbortController().signal, toolUseID: 'ask-2' });
  c.answer((await c.asked('elicitation/create')).id, { action: 'decline' });
  assert.equal((await declined).behavior, 'deny');
});

test('an MCP server\'s form passes as it is, and its link is a link', async t => {
  const c = await setup(t); await c.open();
  for (const text of ['form', 'url']) {
    const prompt = c.prompt(text), request = await c.asked('elicitation/create');
    if (text === 'url') assert.deepEqual(request.params, { sessionId: c.sessionId, mode: 'url', message: '登录后确认', url: 'https://example.com/authorize', elicitationId: 'url-1' });
    else assert.deepEqual(request.params.requestedSchema.required, ['n']);
    c.answer(request.id, text === 'url' ? { action: 'accept' } : { action: 'accept', content: { n: 3 } });
    await prompt;
  }
  assert.deepEqual(c.said().map(JSON.parse), [{ action: 'accept', content: { n: 3 } }, { action: 'accept' }]);
});

test('the plan windows a session reports go to the limits file in the plugin\'s state, merged with what is there; nothing is said to Coda', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'coda-claude-limits-')), path = join(dir, 'limits.json');
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path, JSON.stringify({ version: 1, windows: { seven_day_opus: { utilization: 0.5, resetsAt: 4102444800 } } }));
  const c = await setup(t, { env: { CODA_PLUGIN_STATE: dir } }); await c.open();
  const before = c.out.length;
  await c.prompt('rate-limit');
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).windows, { seven_day_opus: { utilization: 0.5, resetsAt: 4102444800 },
    five_hour: { utilization: 0.11, resetsAt: 4102444800 - 86400 }, seven_day: { utilization: 0.91, resetsAt: 4102444800 } });
  assert.ok(!c.out.slice(before).some(m => JSON.stringify(m).includes('rate_limit')));
  assert.equal(new ClaudeSessionLimits({ path, now: () => 0 }).quota().length, 3);
});

test('a session files what it reports under the account it started as, and an older one of another account files nothing', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'coda-claude-account-')), path = join(dir, 'limits.json');
  t.after(() => rm(dir, { recursive: true, force: true }));
  // The SDK as it starts a session signed in as `email`.
  const as = email => {
    const base = fixtureSdk();
    return { ...base, query: options => {
      const q = base.query(options), start = q.initializationResult.bind(q);
      q.initializationResult = async () => ({ ...(await start()), account: email ? { email } : {} });
      return q;
    } };
  };
  const a = await setup(t, { env: { CODA_PLUGIN_STATE: dir }, sdk: as('A@example.com') }); await a.open();
  await a.prompt('rate-limit');
  assert.equal(JSON.parse(await readFile(path, 'utf8')).account, accountHash('a@example.com'));
  const b = await setup(t, { env: { CODA_PLUGIN_STATE: dir }, sdk: as('b@example.com') }); await b.open();
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { version: 1, windows: {}, account: accountHash('b@example.com') });
  await a.prompt('rate-limit');
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).windows, {}, 'what A\'s session reports is not B\'s');
  const unknown = await setup(t, { env: { CODA_PLUGIN_STATE: dir }, sdk: as(null) }); await unknown.open();
  assert.equal(JSON.parse(await readFile(path, 'utf8')).account, undefined, 'a session that does not say who it is names no one');
});

test('the entry speaks ACP over standard input and output with the SDK it is given, and ends with its input or a signal', { timeout: 20000 }, async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'coda-claude-stdio-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const run = () => {
    const child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CODA_PLUGIN_STATE: cwd, ...substituted({ '@anthropic-ai/claude-agent-sdk': fixture }) } });
    t.after(() => child.kill());
    const messages = [], pending = new Map(); let stderr = '', next = 0;
    child.stderr.on('data', chunk => { stderr += chunk; });
    createInterface({ input: child.stdout }).on('line', line => {
      const message = JSON.parse(line); messages.push(message);
      if (message.id !== undefined && !message.method) { pending.get(message.id)?.(message); pending.delete(message.id); }
      if (message.method === 'session/request_permission') child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } }) + '\n');
    });
    const request = (method, params) => new Promise(resolve => { const id = ++next; pending.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
    return { child, messages, request, exit: once(child, 'exit'), stderr: () => stderr };
  };
  const p = run();
  assert.equal((await p.request('initialize', { protocolVersion: 1, clientCapabilities: {} })).result.agentCapabilities.loadSession, true);
  const { sessionId } = (await p.request('session/new', { cwd, mcpServers: [] })).result;
  // A request Coda answers while the prompt it is part of runs.
  assert.deepEqual((await p.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'permission' }] })).result, { stopReason: 'end_turn' });
  assert.ok(p.messages.some(m => m.params?.update?.content?.text?.includes('"behavior":"allow"')));
  p.child.stdin.end();
  assert.deepEqual(await p.exit, [0, null]); assert.equal(p.stderr(), '');
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    const q = run();
    await q.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    q.child.kill(signal);
    assert.deepEqual(await q.exit, [0, null]); assert.equal(q.stderr(), '');
  }
});

test('without a token file the SDK receives the user\'s existing authentication unchanged', async () => {
  const env = { HOME: '/tmp/new-coda-user', ANTHROPIC_API_KEY: 'test-only', CLAUDE_CODE_USE_VERTEX: '1' };
  assert.deepEqual(await sdkEnvironment(env), env);
  assert.notEqual(await sdkEnvironment(env), env);
});

test('a token file is confined to the SDK\'s environment and supersedes conflicting credentials', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'sdk-auth-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'token'), token = 'sk-ant-oat01-test-only';
  await writeFile(path, token + '\n', { mode: 0o600 });
  const env = { CODA_CLAUDE_OAUTH_TOKEN_FILE: path, PATH: '/example',
    ANTHROPIC_API_KEY: 'api', ANTHROPIC_AUTH_TOKEN: 'bearer', ANTHROPIC_BASE_URL: 'https://invalid', ANTHROPIC_CUSTOM_HEADERS: 'Authorization: stale',
    CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CODE_USE_FOUNDRY: '1',
    CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'refresh', CLAUDE_CODE_OAUTH_SCOPES: 'old', CLAUDE_CODE_OAUTH_TOKEN: 'stale' };
  assert.deepEqual(await sdkEnvironment(env), { CODA_CLAUDE_OAUTH_TOKEN_FILE: path, PATH: '/example', CLAUDE_CODE_OAUTH_TOKEN: token });
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'stale');
  await writeFile(path, 'sk-ant-oat01-replacement');
  assert.equal((await sdkEnvironment(env)).CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat01-replacement');
  // The session starts its SDK with it, and a token file it cannot use stops the start.
  const c = await setup(t, { sdk: fixtureSdk() });
  c.session.environment = sdkEnvironment; c.session.env = { ...process.env, CODA_CLAUDE_OAUTH_TOKEN_FILE: path };
  await c.open();
  assert.equal(c.query.options.env.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat01-replacement');
  const broken = await setup(t);
  broken.session.environment = sdkEnvironment; broken.session.env = { CODA_CLAUDE_OAUTH_TOKEN_FILE: 'relative' };
  await broken.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  assert.match((await broken.request('session/new', { cwd: broken.cwd, mcpServers: [] })).error.message, /must be absolute/);
});

test('unsafe or malformed token files fail closed without echoing secrets', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'sdk-auth-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'token');
  const load = value => sdkEnvironment({ CODA_CLAUDE_OAUTH_TOKEN_FILE: value });
  await assert.rejects(load('relative'), /must be absolute/);
  await assert.rejects(load(path), /cannot read/);
  await assert.rejects(load(dir), /regular file/);
  await writeFile(path, 'sk-ant-oat01-secret', { mode: 0o644 });
  await assert.rejects(load(path), /mode 0600/);
  await chmod(path, 0o600);
  await symlink(path, join(dir, 'link'));
  await assert.rejects(load(join(dir, 'link')), /cannot read/);
  for (const invalid of ['', 'sk-ant-oat01-secret\nsecond-secret', ' sk-ant-oat01-secret', 'x'.repeat(8193), 'sk-ant-api03-secret']) {
    await writeFile(path, invalid);
    await assert.rejects(load(path), error => {
      assert.equal(error.message, 'Claude SDK setup token: file must contain one subscription OAuth token');
      return true;
    });
  }
});

function titles() {
  let info = {}, alive = true;
  const published = [], generated = [], renamed = [];
  const sdk = { async getSessionInfo() { return info; }, async renameSession(id, title, options) { renamed.push({ id, title, options }); info = { customTitle: title }; } };
  const query = { async generateSessionTitle(context, options) { generated.push({ context, options }); return '修复空白思考'; } };
  const title = new SessionTitle({ sdk, query, cwd: '/project', sessionId: 'session', alive: () => alive, publish: async value => published.push(value) });
  return { title, query, published, generated, renamed, setInfo: value => { info = value; }, close: () => { alive = false; } };
}

test('a title is generated once, even after its publication failed, and one the session has survives resume', async () => {
  const c = titles(); c.title.append('请修复界面上空白的思考消息。');
  let fail = true;
  c.title.publish = async title => { if (fail) { fail = false; throw new Error('temporary notification failure'); } c.published.push(title); };
  await Promise.all([c.title.refresh(), c.title.refresh(true)]);
  assert.deepEqual(c.published, []);
  await c.title.refresh(true);
  assert.deepEqual(c.published, ['修复空白思考']);
  assert.deepEqual(c.generated[0].options, { persist: false });
  assert.deepEqual(c.renamed.map(value => value.id), ['session']);
  c.title.append('another prompt'); await c.title.refresh(true);
  assert.equal(c.generated.length, 1); assert.equal(c.published.length, 1);
  const resumed = titles(); resumed.setInfo({ customTitle: '用户起的标题', summary: '原始输入' });
  resumed.title.append('enough context for a title'); await resumed.title.refresh(true);
  assert.deepEqual(resumed.published, ['用户起的标题']); assert.equal(resumed.generated.length, 0);
});

test('a failed title is tried again; a rename and the session\'s end beat a title still being generated; context is bounded', async () => {
  const c = titles(); c.title.append('enough context for a useful title');
  c.query.generateSessionTitle = async () => { throw new Error('temporary failure'); };
  await c.title.refresh(true); assert.equal(c.published.length, 0);
  c.query.generateSessionTitle = async () => { c.setInfo({ customTitle: '手动重命名' }); return '过时的生成标题'; };
  await c.title.refresh(true);
  assert.deepEqual(c.published, ['手动重命名']); assert.equal(c.renamed.length, 0);
  const closed = titles(); closed.title.append('enough context for a useful title');
  closed.query.generateSessionTitle = async () => { closed.close(); return 'too late'; };
  await closed.title.refresh(true);
  assert.equal(closed.published.length, 0); assert.equal(closed.renamed.length, 0);
  const long = titles(); long.title.append('x'.repeat(100_000));
  const bounded = long.title.context.length;
  long.title.append('newest prompt');
  assert.equal(long.title.context.length, bounded); assert.ok(long.title.context.endsWith('newest prompt'));
});

test('the session publishes its title as session info, and a stopped turn starts no title generation', async t => {
  let stored = null, calls = 0, release;
  const sdk = fixtureSdk(), make = sdk.query;
  sdk.getSessionInfo = async () => ({ customTitle: stored });
  sdk.renameSession = async (_id, title) => { stored = title; };
  sdk.query = options => Object.assign(make(options), { generateSessionTitle: () => { calls++; return new Promise(resolve => { release = resolve; }); } });
  const c = await setup(t, { sdk }); await c.open();
  const held = c.prompt('hold'); await until(() => c.said().includes('holding'));
  c.send({ method: 'session/cancel', params: { sessionId: c.sessionId } }); await held;
  await delay(20); assert.equal(calls, 0);
  await c.prompt('Please fix the empty thinking messages');
  await until(() => release); release('隐藏空白思考');
  const info = await until(() => c.updates().find(u => u.sessionUpdate === 'session_info_update'));
  assert.deepEqual(info, { sessionUpdate: 'session_info_update', title: '隐藏空白思考' });
});

// A model service of another plugin, as Coda hands it to Claude's processes (docs/plugins.md「模型服务」): listing `models`;
// `env` chooses it alone.
async function modelService(t, { ref = 'magpie/anthropic', title = 'Magpie · Anthropic', models = ['fake/alpha', 'fake/beta'] } = {}) {
  const { createServer } = await import('node:http');
  const asked = [];
  const server = createServer((request, response) => {
    asked.push(request.url);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ data: models.map(id => ({ id })) }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`, provided = { [ref]: { plugin: ref.split('/')[0], title, api: 'anthropic-messages', url } };
  return { asked, url, ref, provided, env: chosen(provided) };
}
// The services Coda hands Claude's processes, all chosen in this order.
const chosen = provided => ({ CODA_PLUGIN_SETTINGS: JSON.stringify({ 'claude.modelProviders': Object.keys(provided) }), CODA_MODEL_PROVIDERS: JSON.stringify(provided) });

test('the chosen model service\'s models are listed beside Claude\'s own; a turn on one runs in a query of its own with the service as its API', async t => {
  const service = await modelService(t);
  const c = await setup(t, { env: service.env });
  const opened = await c.open(), first = queries.get(c.sessionId);
  // Grouped by where they come from: Claude's own, then the service's under its title, each named by the model alone.
  const groups = opened.configOptions.find(o => o.id === 'model').options;
  assert.deepEqual(groups.map(g => [g.group, g.name, g.options.at(-1)]), [['claude', 'Claude', { value: 'claude-custom-1', name: 'Custom (claude-custom-1)' }],
    ['magpie/anthropic', 'Magpie · Anthropic', { value: 'magpie/anthropic/fake/beta', name: 'fake/beta' }]]);
  assert.deepEqual(groups[1].options.map(o => o.value), ['magpie/anthropic/fake/alpha', 'magpie/anthropic/fake/beta']);
  assert.deepEqual(service.asked, ['/models?limit=1000']);
  const set = (configId, value) => c.request('session/set_config_option', { sessionId: c.sessionId, configId, value });
  await set('effort', 'high');
  // Chosen, it is the session's model at once; the query it runs in starts with the next turn, so that reading every
  // model's options (as Coda's catalog does) starts nothing.
  const chosen = (await set('model', 'magpie/anthropic/fake/alpha')).result.configOptions;
  assert.equal(chosen.find(o => o.id === 'model').currentValue, 'magpie/anthropic/fake/alpha');
  assert.equal(chosen.find(o => o.id === 'effort'), undefined, 'a service\'s model has no effort to choose');
  assert.deepEqual([queries.get(c.sessionId), first.effort], [first, null]);
  // What the session said so far goes on, the service as Claude Code's API, above the machine's settings.
  await c.prompt('hello');
  const second = queries.get(c.sessionId);
  assert.notEqual(second, first); assert.equal(first.closed, true);
  assert.deepEqual([second.options.resume, second.options.model, second.options.permissionMode], [c.sessionId, 'fake/alpha', 'default']);
  assert.deepEqual(second.options.settings, { crossSessionInbound: 'refuse', ...serviceSettings({ url: service.url }, 'fake/alpha') });
  assert.equal(c.said().at(-1), 'hello');
  // Its init names the model as the service does: the session's model stays the service's.
  const model = () => c.updates().findLast(u => u.sessionUpdate === 'config_option_update').configOptions.find(o => o.id === 'model').currentValue;
  assert.equal(model(), 'magpie/anthropic/fake/alpha');
  // Another of the service's models runs in another query; Claude's own again in one without the service, as chosen.
  await set('model', 'magpie/anthropic/fake/beta'); await c.prompt('again');
  const third = queries.get(c.sessionId);
  assert.deepEqual([third.options.model, third.options.settings.env.ANTHROPIC_MODEL], ['fake/beta', 'fake/beta']);
  await set('mode', 'plan'); await set('model', 'other-model'); await set('effort', 'high'); await c.prompt('history');
  const fourth = queries.get(c.sessionId);
  assert.deepEqual([fourth.options.model, fourth.options.permissionMode, fourth.options.settings], ['other-model', 'plan', { crossSessionInbound: 'refuse', effortLevel: 'high' }]);
  assert.equal(c.said().at(-1), 'hello|again|history', 'one conversation throughout');
  assert.equal(model(), 'other-model');
  // Between Claude's own models the query itself switches, as before.
  await set('model', 'fixture-model-v1');
  assert.deepEqual([queries.get(c.sessionId), fourth.model], [fourth, 'fixture-model-v1']);
});

test('a session with nothing said yet starts afresh on the service\'s model, and no model of another service is chosen while what Claude runs goes on', async t => {
  const service = await modelService(t);
  const c = await setup(t, { env: service.env });
  await c.open();
  const set = (configId, value) => c.request('session/set_config_option', { sessionId: c.sessionId, configId, value });
  // Claude Code keeps no transcript of a session until it is said something.
  await rm(join(c.cwd, `.sdk-${c.sessionId}.json`));
  await set('model', 'magpie/anthropic/fake/alpha'); await c.prompt('hello');
  assert.deepEqual([queries.get(c.sessionId).options.sessionId, queries.get(c.sessionId).options.resume], [c.sessionId, undefined]);
  await c.prompt('background');
  const running = queries.get(c.sessionId);
  const refused = await set('model', 'fixture-model-v1');
  assert.equal(refused.error.code, -32602); assert.match(refused.error.message, /后台任务/);
  assert.equal((await set('model', 'magpie/anthropic/fake/alpha')).error, undefined, 'the model it runs is no switch');
  await c.prompt('next'); assert.equal(queries.get(c.sessionId), running);
});

test('a turn stopped while the session moves to the service\'s query ends cancelled, its input not given', async t => {
  const service = await modelService(t);
  const sdk = fixtureSdk(), info = sdk.getSessionInfo;
  // The move waits on the session's transcript being read; held until the stop has come.
  let release, asked;
  const reading = new Promise(resolve => { asked = resolve; });
  sdk.getSessionInfo = (...args) => { asked(); return new Promise(resolve => { release = () => resolve(info(...args)); }); };
  const c = await setup(t, { env: service.env, sdk });
  await c.open();
  await c.request('session/set_config_option', { sessionId: c.sessionId, configId: 'model', value: 'magpie/anthropic/fake/alpha' });
  const stopped = c.prompt('hello');
  await reading;
  c.send({ method: 'session/cancel', params: { sessionId: c.sessionId } });
  await delay(50); release();
  assert.deepEqual((await stopped).result, { stopReason: 'cancelled' });
  assert.equal(c.said().includes('hello'), false, 'the input of a stopped turn is not given');
  // The next turn runs on the service's query, as chosen.
  assert.deepEqual((await c.prompt('again')).result, { stopReason: 'end_turn' });
  assert.equal(queries.get(c.sessionId).options.model, 'fake/alpha');
});

test('several model services chosen are a group each, in the order chosen; a turn on one\'s model runs with that service as the API', async t => {
  const magpie = await modelService(t), proxy = await modelService(t, { ref: 'proxy/anthropic', title: 'Proxy · Anthropic', models: ['fake/gamma'] });
  const c = await setup(t, { env: chosen({ ...proxy.provided, ...magpie.provided }) });
  const groups = (await c.open()).configOptions.find(o => o.id === 'model').options;
  assert.deepEqual(groups.map(g => [g.group, g.name, g.options.length]), [['claude', 'Claude', 4], ['proxy/anthropic', 'Proxy · Anthropic', 1], ['magpie/anthropic', 'Magpie · Anthropic', 2]]);
  const set = (configId, value) => c.request('session/set_config_option', { sessionId: c.sessionId, configId, value });
  await set('model', 'proxy/anthropic/fake/gamma'); await c.prompt('hello');
  assert.deepEqual([queries.get(c.sessionId).options.model, queries.get(c.sessionId).options.settings.env.ANTHROPIC_BASE_URL], ['fake/gamma', proxy.url]);
  await set('model', 'magpie/anthropic/fake/alpha'); await c.prompt('again');
  assert.deepEqual([queries.get(c.sessionId).options.model, queries.get(c.sessionId).options.settings.env.ANTHROPIC_BASE_URL], ['fake/alpha', magpie.url]);
});

test('without a model service chosen, or with one that cannot list its models, the session has Claude\'s own alone', async t => {
  const c = await setup(t, { env: chosen({ 'magpie/anthropic': { plugin: 'magpie', title: 'Magpie · Anthropic', api: 'anthropic-messages', url: 'http://127.0.0.1:1' } }) });
  const models = (await c.open()).configOptions.find(o => o.id === 'model').options.map(o => o.value);
  assert.deepEqual(models, ['fixture-model-v1', 'other-model', 'fixture-model-v1[1m]', 'claude-custom-1']);
  assert.deepEqual(queries.get(c.sessionId).options.settings, { crossSessionInbound: 'refuse' });
});

test('a query for the service\'s model that does not start ends the session: the turn fails, and the next is refused rather than left waiting', async t => {
  const service = await modelService(t);
  const sdk = fixtureSdk(), make = sdk.query;
  let started = 0, ended = 0;
  // The second query (the service's) never says it is ready, nor reads what it is given, until it is closed.
  let hung;
  sdk.query = options => {
    if (++started === 1) return make(options);
    return hung = { closed: false, initializationResult: () => new Promise(() => {}), close() { this.closed = true; this.wake?.(); },
      async *[Symbol.asyncIterator]() { await new Promise(resolve => { this.wake = resolve; }); } };
  };
  const c = await setup(t, { env: service.env, sdk, initializationTimeoutMs: 100, onEnded: () => { ended++; } });
  await c.open();
  await c.request('session/set_config_option', { sessionId: c.sessionId, configId: 'model', value: 'magpie/anthropic/fake/alpha' });
  const failed = await c.prompt('hello');
  assert.deepEqual([failed.error?.code, failed.error?.message], [-32001, 'Claude 初始化超时']);
  assert.deepEqual([ended, hung.closed], [1, true], 'the session ends, as one whose query ends of itself does');
  const refused = await c.prompt('again');
  assert.deepEqual([refused.error?.code, started], [-32001, 2], 'refused at once, no other query started');
});

test('a query for the service\'s model that cannot even be started ends the session, and the next turn is refused at once', async t => {
  const service = await modelService(t);
  const sdk = fixtureSdk(), make = sdk.query;
  let started = 0, ended = 0;
  // What the SDK throws as it builds the CLI's arguments from a model it cannot pass on.
  sdk.query = options => { if (++started === 1) return make(options); throw new TypeError('args must be a string without null bytes'); };
  const c = await setup(t, { env: service.env, sdk, onEnded: () => { ended++; } });
  await c.open();
  await c.request('session/set_config_option', { sessionId: c.sessionId, configId: 'model', value: 'magpie/anthropic/fake/alpha' });
  const failed = await c.prompt('hello');
  assert.deepEqual([failed.error?.code, failed.error?.message], [-32603, 'args must be a string without null bytes']);
  assert.equal(ended, 1);
  const refused = await c.prompt('again');
  assert.deepEqual([refused.error?.code, started], [-32001, 2]);
});

// A message into the turn going (docs/agent-protocol.md「插话」): sent to Claude Code marked `next`, which takes it at the turn's
// next tool round, or runs it right after a turn that ended first; either way the prompt is answered once it is taken.
const steer = (c, text) => c.request('_session/steering', { sessionId: c.sessionId, prompt: [{ type: 'text', text }], _meta: { steering: { idleBehavior: 'promptRequired' } } });

test('a message sent into the running turn is taken at its next tool round, and the turn goes on to its end', async t => {
  const c = await setup(t);
  await c.open();
  const answered = c.prompt('tool-round');
  await until(() => c.updates().some(u => u.sessionUpdate === 'tool_call' && u.toolCallId === 'tool-round'));
  assert.deepEqual((await steer(c, '只看实现')).result, { outcome: 'injected' });
  await until(() => c.query.received.length === 2);
  assert.deepEqual([c.query.received[1].priority, c.query.received[1].message.content], ['next', '只看实现']);
  await writeFile(join(c.cwd, '.finish-tool'), '');
  assert.deepEqual((await answered).result, { stopReason: 'end_turn' });
  assert.deepEqual(c.said().slice(-2), ['插话：只看实现', '工具之后的回答']);
  assert.equal(c.waits().filter(w => w.title === 'Claude 自主继续').length, 0, 'no turn of Claude\'s own');
});

test('a message the turn ended before taking runs right after as a turn of its own, which the prompt waits for', async t => {
  const c = await setup(t);
  await c.open();
  const answered = c.prompt('until-end');
  await until(() => c.said().includes('等着结束'));
  assert.deepEqual((await steer(c, '再补一句')).result, { outcome: 'injected' });
  await writeFile(join(c.cwd, '.end-turn'), '');
  assert.deepEqual((await answered).result, { stopReason: 'end_turn' });
  const said = c.out.findIndex(m => m.method === 'session/update' && m.params.update.content?.text === '再补一句');
  assert.ok(said >= 0 && said < c.out.findIndex(m => m.result?.stopReason === 'end_turn'), 'answered after the turn that took it');
  assert.equal(c.waits().filter(w => w.title === 'Claude 自主继续').length, 0, 'that turn is the prompt\'s, not Claude\'s own');
});

test('a message sent with no prompt of Coda\'s going is handed back for Coda to send', async t => {
  const c = await setup(t);
  await c.open();
  assert.deepEqual((await steer(c, '晚了')).result, { outcome: 'promptRequired', reason: 'noRunningTurn' });
  assert.equal(c.query.received.length, 0, 'nothing goes to Claude Code');
});

test('a message not taken yet when the turn is stopped goes with it, and the next prompt is answered as usual', async t => {
  const c = await setup(t);
  await c.open();
  const answered = c.prompt('hold');
  await until(() => c.said().includes('holding'));
  assert.deepEqual((await steer(c, '不用了')).result, { outcome: 'injected' });
  await until(() => c.query.received.length === 2);
  c.send({ method: 'session/cancel', params: { sessionId: c.sessionId } });
  assert.deepEqual((await answered).result, { stopReason: 'cancelled' });
  assert.deepEqual(c.query.interrupts, [{ cancelQueued: true }]);
  assert.deepEqual((await c.prompt('之后的一轮')).result, { stopReason: 'end_turn' });
  assert.ok(!c.said().includes('不用了'), 'it never ran');
  assert.equal(c.waits().filter(w => w.title === 'Claude 自主继续').length, 0);
});

// Its own turn over, the prompt waits for what was said into it (held): stopped then, or failed with some not taken yet, it
// ends once Claude Code has dropped those. `hold-idle:` keeps the native side between the turn and the next.
const resulted = c => until(() => c.updates().some(u => u.sessionUpdate === 'usage_update'));

test('a prompt stopped between its own turn and the one for what was said into it ends, and that never runs', async t => {
  const c = await setup(t);
  await c.open();
  const answered = c.prompt('hold-idle:until-end');
  await until(() => c.said().includes('等着结束'));
  assert.deepEqual((await steer(c, '再补一句')).result, { outcome: 'injected' });
  await writeFile(join(c.cwd, '.end-turn'), '');
  await resulted(c);
  c.send({ method: 'session/cancel', params: { sessionId: c.sessionId } });
  assert.deepEqual((await answered).result, { stopReason: 'cancelled' });
  assert.deepEqual(c.query.interrupts, [{ cancelQueued: true }]);
  await writeFile(join(c.cwd, '.release-idle'), '');
  assert.deepEqual((await c.prompt('之后的一轮')).result, { stopReason: 'end_turn' });
  assert.ok(!c.said().includes('再补一句'), 'it never ran');
  assert.equal(c.waits().filter(w => w.title === 'Claude 自主继续').length, 0);
});

test('a prompt whose own turn failed with something said into it not taken yet fails once that is dropped, and it never runs', async t => {
  const c = await setup(t);
  await c.open();
  const answered = c.prompt('hold-idle:fail-end');
  await until(() => c.said().includes('等着结束'));
  assert.deepEqual((await steer(c, '再补一句')).result, { outcome: 'injected' });
  await writeFile(join(c.cwd, '.end-turn'), '');
  assert.match((await answered).error.message, /原生这一轮失败了/);
  assert.deepEqual(c.query.interrupts, [{ cancelQueued: true }]);
  await writeFile(join(c.cwd, '.release-idle'), '');
  assert.deepEqual((await c.prompt('之后的一轮')).result, { stopReason: 'end_turn' });
  assert.ok(!c.said().includes('再补一句'), 'it never ran');
  assert.equal(c.waits().filter(w => w.title === 'Claude 自主继续').length, 0);
});

test('no more messages go into a turn at once than its result can name: one more is Coda\'s to send as the next turn', async t => {
  const c = await setup(t);
  await c.open();
  const answered = c.prompt('tool-round');
  await until(() => c.updates().some(u => u.sessionUpdate === 'tool_call' && u.toolCallId === 'tool-round'));
  const outcomes = [];
  for (let i = 1; i <= 65; i++) outcomes.push((await steer(c, `第 ${i} 条`)).result);
  assert.deepEqual(outcomes.slice(0, 32), Array(32).fill({ outcome: 'injected' }));
  assert.deepEqual(outcomes.slice(32), Array(33).fill({ outcome: 'promptRequired', reason: 'tooManyPending' }));
  await writeFile(join(c.cwd, '.finish-tool'), '');
  assert.deepEqual((await answered).result, { stopReason: 'end_turn' });
  assert.equal(c.said().filter(text => text.startsWith('插话：')).length, 32);
});

test('a prompt stopped while the turn for what was said into it is going ends with that turn, not before', async t => {
  const c = await setup(t);
  await c.open();
  const answered = c.prompt('until-end');
  await until(() => c.said().includes('等着结束'));
  // What is said into it holds its own turn until stopped.
  assert.deepEqual((await steer(c, 'hold')).result, { outcome: 'injected' });
  await writeFile(join(c.cwd, '.end-turn'), '');
  await until(() => c.said().includes('holding'));
  c.send({ method: 'session/cancel', params: { sessionId: c.sessionId } });
  assert.deepEqual((await answered).result, { stopReason: 'cancelled' });
  const usage = c.out.flatMap((m, i) => m.method === 'session/update' && m.params.update.sessionUpdate === 'usage_update' ? [i] : []);
  assert.equal(usage.length, 2, 'both turns ended');
  assert.ok(usage[1] < c.out.findIndex(m => m.result?.stopReason === 'cancelled'), 'answered as the turn going ended');
});
