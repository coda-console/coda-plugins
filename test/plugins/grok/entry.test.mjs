import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { agentValueProblem } from '@coda-console/protocol/agent';
import { AgentProcess } from '../../../check/process.mjs';
import { pluginDir } from '../plugin.mjs';
import { MINIMUM, needed, older } from '../../../plugins/grok/scripts/install.mjs';
import { deleteSession } from '../../../plugins/grok/agent/delete.mjs';
import { OTHER } from '../../../plugins/grok/agent/questions.mjs';
import { promptUsage } from '../../../plugins/grok/agent/usage.mjs';
import { relaysInstructions } from '../relay.mjs';

const manifest = JSON.parse(readFileSync(join(pluginDir('grok'), 'package.json')));
const quote = s => `'${s.replaceAll("'", "'\\''")}'`;

// The entry on the fixture Grok, as Coda starts it.
function start(t) {
  const dir = mkdtempSync(join(tmpdir(), 'grok-entry-')), messages = [], waiting = [];
  mkdirSync(join(dir, '.grok/bin'), { recursive: true });
  writeFileSync(join(dir, '.grok/bin/grok'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fileURLToPath(new URL('./fixture.mjs', import.meta.url)))} "$@"\n`, { mode: 0o755 });
  const p = new AgentProcess({ command: manifest.contributes.agents[0].command, cwd: dir, env: { ...process.env, HOME: dir,
    CODA_NODE: process.execPath, CODA_PLUGIN_PATH: pluginDir('grok') }, onMessage: m => {
    messages.push(m);
    const i = waiting.findIndex(w => w.method === m.method); if (i >= 0) waiting.splice(i, 1)[0].resolve(m);
  } });
  t.after(async () => { await p.terminate(1500); p.kill(); rmSync(dir, { recursive: true, force: true }); });
  const request = async (method, params) => {
    const r = await p.request(method, params, { timeout: 5000 }); assert.equal(r.error, undefined, JSON.stringify(r.error)); return r.result;
  };
  const prompt = text => request('session/prompt', { sessionId: 'native', prompt: [{ type: 'text', text }] });
  const said = () => messages.filter(m => m.params?.update?.content).at(-1).params.update.content.text;
  // The next message of `method` the entry sends: asked for before what brings it about.
  const next = method => new Promise(resolve => waiting.push({ method, resolve }));
  return { dir, p, messages, request, prompt, said, next };
}

for (const [text, how] of [['crash', /退出码 3[\s\S]*fake grok: Operation not permitted/], ['quit', /退出码 0/], ['kill', /被信号 SIGKILL 终止/], ['speak and kill', /被信号 SIGKILL 终止/]])
  test(`the prompt error and the plugin's stderr say how Grok ended on its own: ${text}`, async t => {
    const { p, request } = start(t);
    await request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    await request('session/new', { cwd: '/', mcpServers: [] });
    const reply = await p.request('session/prompt', { sessionId: 'native', prompt: [{ type: 'text', text }] }, { timeout: 5000 });
    assert.equal(reply.error?.code, -32603, JSON.stringify(reply));
    assert.match(reply.error.message, how);
    const failure = reply.error.data?._meta?.coda?.failure;
    assert.equal(agentValueProblem('failure.json', failure, 'failure'), null);
    assert.deepEqual(failure, { kind: 'session_ended' });
    await p.exited;
    assert.match(p.stderr, how);
  });

// Coda's session host stops the entry with SIGTERM to its whole process group, so Grok gets the signal too: that is not Grok ending on its own.
test('stopping Grok on purpose, as Coda\'s session host does with SIGTERM to the process group, is not an unexpected end', async t => {
  const { p, messages, request } = start(t);
  await request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  await request('session/new', { cwd: '/', mcpServers: [] });
  const held = p.request('session/prompt', { sessionId: 'native', prompt: [{ type: 'text', text: 'hold' }] }, { timeout: 10_000 }).then(() => 'answered', () => 'unanswered');
  for (let i = 0; i < 500 && messages.at(-1)?.params?.update?.content?.text !== 'holding'; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(messages.at(-1)?.params?.update?.content?.text, 'holding');
  assert.notEqual(await p.terminate(3000), null, 'the entry ends with the signal');
  assert.equal(await held, 'unanswered', p.stderr);
  assert.doesNotMatch(p.stderr, /意外退出/);
});

test('Grok declares session/delete and answers it with `grok sessions delete`, never passing it to the agent', async t => {
  const { dir, p, request } = start(t);
  const calls = () => { try { return readFileSync(join(dir, 'sessions-calls.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)); } catch { return []; } };
  const init = await request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  assert.deepEqual(init.agentCapabilities, { loadSession: true, sessionCapabilities: { delete: {} } });
  await request('session/new', { cwd: dir, mcpServers: [] });
  assert.deepEqual(await request('session/delete', { sessionId: 'abc' }), {});
  assert.deepEqual(calls(), [['sessions', 'delete', '--', 'abc']]);
  for (const [sessionId, code, message] of [['gone', -32002, 'No session found with id gone.'], ['odd', -32603, '没有确认删除：something else'],
    ['mute', -32603, '没有确认删除：没有输出'], ['broken', -32603, 'storage is locked'], ['quiet', -32603, '退出码 3'], ['killed', -32603, '被信号 SIGKILL 结束']]) {
    const r = await p.request('session/delete', { sessionId }, { timeout: 5000 });
    assert.equal(r.result, undefined);
    assert.equal(r.error.code, code);
    assert.ok(r.error.message.endsWith(message), r.error.message);
  }
  assert.equal((await p.request('session/delete', {}, { timeout: 5000 })).error.code, -32602);
  assert.equal(calls().length, 7, 'the invalid request never starts the command');
  // A close that comes while a delete is still running waits for it: the agent hears of it after the session is gone.
  const order = () => readFileSync(join(dir, 'order.log'), 'utf8').trim().split('\n');
  const [deleted, closed] = await Promise.all([p.request('session/delete', { sessionId: 'slow' }, { timeout: 5000 }),
    p.request('session/close', { sessionId: 'slow' }, { timeout: 5000 })]);
  assert.deepEqual([deleted.result, closed.result], [{}, {}]);
  assert.deepEqual(order(), ['delete-done', 'close']);
  // A CLI that never answers, stood in for by one that only sleeps.
  const slow = join(dir, 'slow-grok');
  writeFileSync(slow, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
  const started = Date.now();
  assert.deepEqual(await deleteSession(slow, 'abc', 300), { code: -32603, message: '删除 Grok 会话超时' });
  assert.ok(Date.now() - started < 3000);
  // The native fixture answers session/delete with Method not found: none of those errors came from it, and the rest passes through.
  assert.equal((await p.request('session/nope', {}, { timeout: 5000 })).error.message, 'Method not found');
  assert.equal((await request('session/set_config_option', { sessionId: 'native', configId: 'reasoning_effort', value: 'high' })).configOptions[0].id, 'model');
});

test('Grok mode selection takes effect in the same process, preserving options; active turns cannot change mode', async t => {
  const { dir, p, messages, request, prompt, said } = start(t);
  const report = async () => { await prompt('report'); return JSON.parse(said()); };
  await request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  for (const method of ['session/new', 'session/load']) {
    const r = await request(method, { cwd: dir, mcpServers: [], ...(method === 'session/load' ? { sessionId: 'native' } : {}) });
    assert.deepEqual(r.modes.availableModes.map(m => m.id), ['auto', 'always-approve']);
    assert.equal(r.modes.currentModeId, '', 'no explicit mode overrides the machine configuration');
  }
  const before = await report(); assert.equal(before.mode, 'machine');
  await request('session/set_config_option', { sessionId: 'native', configId: 'reasoning_effort', value: 'high' });
  for (const modeId of ['auto', 'always-approve', 'auto']) {
    await request('session/set_mode', { sessionId: 'native', modeId });
    assert.equal(messages.at(-1).params.update.currentModeId, modeId);
    assert.deepEqual(await report(), { mode: modeId, effort: 'high', pid: before.pid });
  }
  const held = prompt('hold');
  for (let i = 0; i < 100 && messages.at(-1)?.params?.update?.content?.text !== 'holding'; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(messages.at(-1).params.update.content.text, 'holding');
  const refused = await p.request('session/set_mode', { sessionId: 'native', modeId: 'always-approve' }, { timeout: 5000 });
  assert.match(refused.error.message, /当前轮次/);
  p.notify('session/cancel', { sessionId: 'native' }); assert.equal((await held).stopReason, 'cancelled');
  assert.equal((await report()).mode, 'auto');
  for (const params of [{ sessionId: 'native', modeId: 'missing' }, { sessionId: 'missing', modeId: 'auto' }]) {
    assert.equal((await p.request('session/set_mode', params, { timeout: 5000 })).error.code, -32602);
  }
});

test('Grok\'s questions are a plain form, answered as Grok takes them, and withdrawn once Grok gives up on them', async t => {
  const { dir, p, request, prompt, said, next } = start(t);
  await request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  await request('session/new', { cwd: dir, mcpServers: [] });
  const form = next('elicitation/create'), answered = prompt('ask'), { id, params: { toolCallId, ...params } } = await form;
  assert.match(toolCallId, /^ask-/);
  assert.deepEqual(params, { sessionId: 'native', mode: 'form', message: 'Grok 需要你的回答', requestedSchema: { type: 'object', properties: {
    q0: { title: '选一个', type: 'string', oneOf: [{ const: 'A', title: 'A — 第一种' }, { const: 'B', title: 'B' }, { const: OTHER, title: '其他（写在下面）' }] },
    q0_other: { type: 'string', title: '其他' },
    q1: { title: '选多个', type: 'array', items: { anyOf: [{ const: 'X', title: 'X' }, { const: 'Y', title: 'Y' }, { const: OTHER, title: '其他（写在下面）' }] }, minItems: 1 },
    q1_other: { type: 'string', title: '其他' } }, required: ['q0', 'q1'] } });
  p.respond(id, { action: 'accept', content: { q0: OTHER, q0_other: 'C', q1: ['X', OTHER], q1_other: 'Z' } });
  await answered;
  assert.deepEqual(JSON.parse(said()), { outcome: 'accepted', answers: { 选一个: 'C', 选多个: ['X', 'Z'] } });
  // Declined, or not asked at all (Coda answers an error), the questions are cancelled.
  for (const reply of [r => p.respond(r, { action: 'decline' }), r => p.respondError(r, -32603, '请求已失效')]) {
    const asked = next('elicitation/create'), done = prompt('ask');
    reply((await asked).id); await done;
    assert.deepEqual(JSON.parse(said()), { outcome: 'cancelled' });
  }
  // Grok stops waiting (its timeout, a cancelled turn) and only ends the tool call: Coda is told to stop asking.
  const asked = next('elicitation/create'), withdrawn = next('$/cancel_request');
  await prompt('give up');
  assert.deepEqual((await withdrawn).params, { requestId: (await asked).id });
});

test('the entry forwards Coda instructions to Grok unchanged', t =>
  relaysInstructions(t, 'grok', '.grok/bin/grok', ['agent', '--no-leader', 'stdio'], { list: {}, delete: {} }));

test('setup installs a missing or broken Grok CLI, upgrades one older than the entry was checked against, and keeps a newer one', () => {
  const run = (status, stdout = '') => () => ({ status, stdout, stderr: '' });
  assert.equal(MINIMUM, '1.0.52');
  assert.equal(needed(null).action, 'install');
  assert.equal(needed('/bin/grok', run(1)).action, 'install');
  assert.deepEqual(needed('/bin/grok', run(0, 'grok 1.0.51\n')), { action: 'upgrade', reason: 'Grok CLI 1.0.51 低于所需的 1.0.52' });
  assert.deepEqual(needed('/bin/grok', run(0, 'grok 1.0.52\n')), { action: 'none', version: '1.0.52' });
  assert.deepEqual(needed('/bin/grok', run(0, 'grok 1.1.0 (abc)\n')), { action: 'none', version: '1.1.0' });
  assert.ok(older('1.0.9', '1.0.52') && !older('1.0.52', '1.0.52') && !older('2.0.0', '1.9.99'));
});

test('Grok\'s compactions of the main session are told as compaction updates, one id from start to end, a user\'s /compact by its end alone', async t => {
  const { dir, messages, request, prompt } = start(t);
  await request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  await request('session/new', { cwd: dir, mcpServers: [] });
  await prompt('compact');
  const told = messages.filter(m => m.params?.update?.sessionUpdate === 'compaction_update').map(m => m.params.update);
  assert.deepEqual(told.map(u => u.status), ['in_progress', 'completed', 'completed', 'in_progress', 'failed']);
  assert.ok(told.every(u => u.error === null));
  assert.equal(told[0].compactionId, told[1].compactionId);
  assert.equal(told[3].compactionId, told[4].compactionId);
  assert.equal(new Set(told.map(u => u.compactionId)).size, 3);
  assert.equal(messages.filter(m => m.method === '_x.ai/session_notification').length, 7, 'what Grok said is passed on as it was');
});

// What a turn used (usage.mjs): Grok tells it in `_meta.usage`, its input counting the cached tokens; Coda reads the response's `usage`.
test('the prompt response gets the turn\'s usage at its top level, the cached tokens out of the input, and Grok\'s `_meta` as it was', async t => {
  const { dir, request, prompt } = start(t);
  await request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  await request('session/new', { cwd: dir, mcpServers: [] });
  const answer = (result) => prompt(`result:${JSON.stringify(result)}`);
  for (const [name, written] of [['cachedWriteTokens', { cachedWriteTokens: 40 }], ['cacheCreationTokens', { cacheCreationTokens: 40 }]]) {
    const meta = { usage: { inputTokens: 1000, outputTokens: 70, cachedReadTokens: 600, ...written }, other: 'kept' };
    assert.deepEqual(await answer({ stopReason: 'end_turn', _meta: meta }), { stopReason: 'end_turn', _meta: meta,
      usage: { totalTokens: 360 + 70 + 600 + 40, inputTokens: 360, outputTokens: 70, cachedReadTokens: 600, cachedWriteTokens: 40 } }, name);
  }
  // Without cache fields nothing is taken out and none is told.
  assert.deepEqual((await answer({ stopReason: 'end_turn', _meta: { usage: { inputTokens: 12, outputTokens: 3 } } })).usage, { totalTokens: 15, inputTokens: 12, outputTokens: 3 });
  // More cached than input is no negative input.
  assert.deepEqual((await answer({ stopReason: 'end_turn', _meta: { usage: { inputTokens: 100, outputTokens: 5, cachedReadTokens: 150, cachedWriteTokens: 10 } } })).usage,
    { totalTokens: 165, inputTokens: 0, outputTokens: 5, cachedReadTokens: 150, cachedWriteTokens: 10 });
  // Nothing used, or nothing valid in it: the response is as Grok sent it.
  for (const result of [{ stopReason: 'end_turn' }, { stopReason: 'end_turn', _meta: {} }, { stopReason: 'end_turn', _meta: { usage: {} } },
    { stopReason: 'end_turn', _meta: { usage: { inputTokens: -1, outputTokens: '3', cachedReadTokens: 1.5, cachedWriteTokens: null } } },
    { stopReason: 'cancelled', _meta: { usage: 'a lot' } }])
    assert.deepEqual(await answer(result), result);
  // A usage of Grok's own at the top level is passed on, whatever `_meta` says.
  const own = { stopReason: 'end_turn', usage: { totalTokens: 9, inputTokens: 4, outputTokens: 5 }, _meta: { usage: { inputTokens: 1000, outputTokens: 70 } } };
  assert.deepEqual(await answer(own), own);
  // The fixture's own turns say nothing of usage.
  assert.deepEqual(await prompt('hello'), { stopReason: 'end_turn' });
});

test('only a count that is a non-negative safe integer is told: a missing or invalid field is left out, not made zero', () => {
  assert.deepEqual(promptUsage({ _meta: { usage: { outputTokens: 7 } } }), { outputTokens: 7 });
  assert.deepEqual(promptUsage({ _meta: { usage: { inputTokens: 50, outputTokens: 'x', cachedReadTokens: 20 } } }), { inputTokens: 30, cachedReadTokens: 20 });
  assert.deepEqual(promptUsage({ _meta: { usage: { inputTokens: 50, outputTokens: 7, cachedReadTokens: -1, cachedWriteTokens: Number.MAX_SAFE_INTEGER + 1 } } }),
    { totalTokens: 57, inputTokens: 50, outputTokens: 7 });
  assert.deepEqual(promptUsage({ _meta: { usage: { inputTokens: 5, outputTokens: 1, cachedWriteTokens: 'x', cacheCreationTokens: 2 } } }),
    { totalTokens: 6, inputTokens: 3, outputTokens: 1, cachedWriteTokens: 2 });
  assert.deepEqual(promptUsage({ usage: null, _meta: { usage: { outputTokens: 0 } } }), { outputTokens: 0 }, 'a null usage is none');
  for (const result of [undefined, null, 'x', [], {}, { _meta: null }, { _meta: { usage: [] } }, { _meta: { usage: { inputTokens: NaN } } }]) assert.equal(promptUsage(result), null, JSON.stringify(result));
});
