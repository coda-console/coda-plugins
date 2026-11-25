import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RequestedModels, foldThoughtIntoOutput } from '../../../plugins/opencode/agent/usage.mjs';

// OpenCode 2.1.4 (~/.opencode/bin/opencode, the CLI the plugin runs): outputTokens = tokens.output, totalTokens = input + output +
// reasoning + cache read + cache write, thoughtTokens only when reasoning > 0.
const reply = (usage, id = 3) => ({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn', usage } });

test('a turn with thinking counts it in outputTokens and keeps thoughtTokens as the breakdown', () => {
  const usage = { inputTokens: 100, outputTokens: 40, thoughtTokens: 25, cachedReadTokens: 10, cachedWriteTokens: 5, totalTokens: 180 };
  const folded = foldThoughtIntoOutput(reply(usage));
  assert.deepEqual(folded.result.usage, { ...usage, outputTokens: 65 });
  const { inputTokens, outputTokens, cachedReadTokens, cachedWriteTokens, totalTokens } = folded.result.usage;
  assert.equal(inputTokens + outputTokens + cachedReadTokens + cachedWriteTokens, totalTokens);
  assert.equal(usage.outputTokens, 40);
});

test('a turn without thinking is unchanged and gains no field', () => {
  const message = reply({ inputTokens: 100, outputTokens: 40, totalTokens: 140 });
  assert.equal(foldThoughtIntoOutput(message), message);
  assert.equal(foldThoughtIntoOutput(reply({ inputTokens: 1, outputTokens: 2, thoughtTokens: 0, totalTokens: 3 })).result.usage.outputTokens, 2);
});

test('missing or invalid fields, and messages without usage, pass unchanged', () => {
  for (const usage of [{ inputTokens: 1, thoughtTokens: 5, totalTokens: 6 }, { outputTokens: '2', thoughtTokens: 5 }, { outputTokens: 2, thoughtTokens: -5 },
    { outputTokens: 2, thoughtTokens: NaN }, { outputTokens: -3, thoughtTokens: 5 }, { outputTokens: 2, thoughtTokens: 1.5 }, { outputTokens: 2.5, thoughtTokens: 5 },
    { outputTokens: Number.MAX_SAFE_INTEGER, thoughtTokens: 1 }, { outputTokens: 2, thoughtTokens: Infinity }, { outputTokens: 2, thoughtTokens: '5' }, { outputTokens: 2, thoughtTokens: null }]) {
    const message = reply(usage);
    assert.equal(foldThoughtIntoOutput(message), message, JSON.stringify(usage));
  }
  for (const message of [{ jsonrpc: '2.0', id: 4, result: { stopReason: 'end_turn' } }, { jsonrpc: '2.0', id: 5, error: { code: -32603, message: 'x' } },
    { jsonrpc: '2.0', method: 'session/update', params: {} }]) assert.equal(foldThoughtIntoOutput(message), message);
});

const id = '6f1a7c52-0d3b-4e8a-9a41-2b7d5c0e9f13', other = '0b3c8d1e-5a77-4c20-8f64-91d2a7e4b6c8';
const services = [{ ref: 'magpie/responses', url: `http://127.0.0.1:3425/resources/openai-responses/${id}/v1` }, { ref: 'space/s-proxy', url: `http://127.0.0.1:3425/resources/anthropic-messages/${other}` },
  { ref: 'odd/service', url: 'http://127.0.0.1:4000/v1' }];
const usage = { inputTokens: 100, outputTokens: 40, totalTokens: 140 };
const options = value => [{ id: 'model', category: 'model', currentValue: value, options: [] }, { id: 'mode', category: 'mode', currentValue: 'build', options: [] }];
let next = 100;
// A request of Coda's, and what OpenCode answers it with (an error when `result` is not given).
const request = (requested, method, params, result) => {
  const id = ++next;
  requested.fromCoda({ jsonrpc: '2.0', id, method, params });
  return requested.fromAgent(result ? { jsonrpc: '2.0', id, result } : { jsonrpc: '2.0', id, error: { code: -32602, message: 'model not found' } });
};
const open = (requested, sessionId, value) => request(requested, 'session/load', { sessionId, cwd: '/', mcpServers: [] }, { configOptions: options(value) });
const choose = (requested, sessionId, value, accepted = true) => request(requested, 'session/set_config_option', { sessionId, configId: 'model', value }, accepted ? { configOptions: options(value) } : undefined);
// A prompt, sent and answered: the usage it was told with.
const turn = (requested, sessionId) => {
  const id = ++next;
  requested.fromCoda({ jsonrpc: '2.0', id, method: 'session/prompt', params: { sessionId, prompt: [] } });
  return requested.fromAgent(reply(usage, id)).result.usage;
};
const on = (service, asked) => ({ ...usage, service, asked });

test('a session opened on a service\'s model, with no request to set it, says the service its injected address gives and the model asked, bare of the provider ID', () => {
  const requested = new RequestedModels(services);
  open(requested, 's1', 'coda-magpie.responses/group/ds-flash');
  assert.deepEqual(turn(requested, 's1'), on(`coda://openai-responses/${id}`, 'group/ds-flash'));
  // A new session says its id in its answer, not in its request.
  const created = ++next;
  requested.fromCoda({ jsonrpc: '2.0', id: created, method: 'session/new', params: { cwd: '/', mcpServers: [] } });
  requested.fromAgent({ jsonrpc: '2.0', id: created, result: { sessionId: 's2', configOptions: options('coda-space.s-proxy/claude-x') } });
  assert.deepEqual(turn(requested, 's2'), on(`coda://anthropic-messages/${other}`, 'claude-x'));
  const prompted = ++next;
  requested.fromCoda({ jsonrpc: '2.0', id: prompted, method: 'session/prompt', params: { sessionId: 's1', prompt: [] } });
  requested.fromAgent(reply(usage, prompted));
  assert.equal(requested.fromAgent(reply(usage, prompted)).result.usage.service, undefined, 'a prompt is answered once');
});

test('a switch OpenCode accepts is the model of the next turn, a refused one leaves the model as it was, and a session\'s model is its own', () => {
  const requested = new RequestedModels(services);
  open(requested, 's1', 'coda-magpie.responses/a'); open(requested, 's2', 'coda-space.s-proxy/b/c');
  choose(requested, 's1', 'coda-space.s-proxy/claude-x', false);
  assert.deepEqual(turn(requested, 's1'), on(`coda://openai-responses/${id}`, 'a'), 'refused: as it was');
  choose(requested, 's1', 'coda-space.s-proxy/claude-x');
  assert.deepEqual(turn(requested, 's1'), on(`coda://anthropic-messages/${other}`, 'claude-x'));
  assert.deepEqual(turn(requested, 's2'), on(`coda://anthropic-messages/${other}`, 'b/c'));
  // What OpenCode tells of its own accord counts as well.
  requested.fromAgent({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's2', update: { sessionUpdate: 'config_option_update', configOptions: options('coda-magpie.responses/d') } } });
  assert.deepEqual(turn(requested, 's2'), on(`coda://openai-responses/${id}`, 'd'));
  choose(requested, 's1', 'opencode-go/free');
  assert.deepEqual(turn(requested, 's1'), usage, 'OpenCode\'s own model: neither');
  assert.deepEqual(turn(requested, 's3'), usage, 'a session not told of: neither');
});

test('a turn is told with the model it was sent on, not the one the session has when it is answered', () => {
  const requested = new RequestedModels(services);
  open(requested, 's1', 'coda-magpie.responses/a');
  const sent = ++next;
  requested.fromCoda({ jsonrpc: '2.0', id: sent, method: 'session/prompt', params: { sessionId: 's1', prompt: [] } });
  choose(requested, 's1', 'coda-space.s-proxy/b');
  assert.deepEqual(requested.fromAgent(reply(usage, sent)).result.usage, on(`coda://openai-responses/${id}`, 'a'));
  assert.deepEqual(turn(requested, 's1'), on(`coda://anthropic-messages/${other}`, 'b'));
});

test('a service whose address is of another shape says neither; the requests that end a session clear it; what is not a usage is as it was', () => {
  const requested = new RequestedModels(services);
  open(requested, 's1', 'coda-odd.service/m');
  assert.deepEqual(turn(requested, 's1'), usage);
  for (const method of ['session/close', 'session/delete']) {
    open(requested, 's1', 'coda-magpie.responses/m');
    requested.fromCoda({ jsonrpc: '2.0', id: ++next, method, params: { sessionId: 's1' } });
    assert.deepEqual(turn(requested, 's1'), usage, method);
  }
  open(requested, 's1', 'coda-magpie.responses/m');
  const send = () => { const id = ++next; requested.fromCoda({ jsonrpc: '2.0', id, method: 'session/prompt', params: { sessionId: 's1', prompt: [] } }); return id; };
  const bare = { jsonrpc: '2.0', id: send(), result: { stopReason: 'cancelled' } }, failed = { jsonrpc: '2.0', id: send(), error: { code: -32603, message: 'x' } };
  assert.equal(requested.fromAgent(bare), bare);
  assert.equal(requested.fromAgent(failed), failed);
  const update = { jsonrpc: '2.0', method: 'session/update', params: {} };
  assert.equal(requested.fromAgent(update), update);
  // The thinking folded into the output goes on beside it.
  const thinking = send();
  assert.deepEqual(requested.fromAgent(foldThoughtIntoOutput(reply({ ...usage, thoughtTokens: 5 }, thinking))).result.usage,
    { ...usage, thoughtTokens: 5, outputTokens: 45, service: `coda://openai-responses/${id}`, asked: 'm' });
});
