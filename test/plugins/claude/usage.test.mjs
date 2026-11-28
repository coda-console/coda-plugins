// What a prompt used (agent/usage.mjs): `PromptResponse.usage` is this turn's increment, taken from the SDK's cumulative modelUsage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ClaudeSession } from '../../../plugins/claude/agent/session.mjs';
import { PromptUsage } from '../../../plugins/claude/agent/usage.mjs';
import { fixtureSdk, queries } from './fixture-sdk.mjs';

const model = (inputTokens, outputTokens, cacheReadInputTokens = 0, cacheCreationInputTokens = 0, more = {}) =>
  ({ inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, contextWindow: 1000, ...more });
const result = (modelUsage, more = {}) => ({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', usage: {}, modelUsage, total_cost_usd: 0, ...more });
const row = (name, inputTokens, outputTokens, cachedReadTokens = 0, cachedWriteTokens = 0, label = 'model') => ({ [label]: name, inputTokens, outputTokens, cachedReadTokens, cachedWriteTokens });
// The model the SDK says ran (its `canonicalModel`) is the row's `served`; the SDK's own name without one stays the unlayered `model` label.
const ran = (name, inputTokens, outputTokens, cachedReadTokens = 0, cachedWriteTokens = 0) => row(name, inputTokens, outputTokens, cachedReadTokens, cachedWriteTokens, 'served');
// What a prompt answered with, by the one result it took.
const told = (usage, m, asked, confirmed) => { usage.hold(usage.measure(m, asked, confirmed)); return usage.take(); };

test('a new session counts from nothing: each turn is the difference to the last result, cache reads and writes beside the uncached input', () => {
  const usage = new PromptUsage();
  usage.restarted(false);
  assert.deepEqual(told(usage, result({ m: model(100, 20, 5000, 300) })),
    { usage: { totalTokens: 5420, inputTokens: 100, outputTokens: 20, cachedReadTokens: 5000, cachedWriteTokens: 300, breakdown: [row('m', 100, 20, 5000, 300)] } });
  assert.deepEqual(told(usage, result({ m: model(130, 50, 9000, 300) })),
    { usage: { totalTokens: 4060, inputTokens: 30, outputTokens: 30, cachedReadTokens: 4000, cachedWriteTokens: 0, breakdown: [row('m', 30, 30, 4000, 0)] } });
});

test('the main model and the subagents it launches are a breakdown by model, summed at the top; the canonical name is the model\'s, and a model idle this turn is not in it', () => {
  const usage = new PromptUsage();
  usage.restarted(false);
  told(usage, result({ main: model(10, 10), sub: model(5, 5, 0, 0, { canonicalModel: 'claude-haiku-sub' }) }));
  assert.deepEqual(told(usage, result({ main: model(30, 20, 100, 0), sub: model(5, 5, 0, 0, { canonicalModel: 'claude-haiku-sub' }) })),
    { usage: { totalTokens: 130, inputTokens: 20, outputTokens: 10, cachedReadTokens: 100, cachedWriteTokens: 0, breakdown: [row('main', 20, 10, 100, 0)] } });
  assert.deepEqual(told(usage, result({ main: model(40, 25, 100, 0), sub: model(15, 12, 7, 0, { canonicalModel: 'claude-haiku-sub' }) })),
    { usage: { totalTokens: 10 + 5 + 10 + 7 + 7, inputTokens: 20, outputTokens: 12, cachedReadTokens: 7, cachedWriteTokens: 0,
      breakdown: [row('main', 10, 5), ran('claude-haiku-sub', 10, 7, 7)] } });
});

test('two names of one model are one row of the breakdown', () => {
  const usage = new PromptUsage();
  usage.restarted(false);
  assert.deepEqual(told(usage, result({ alias: model(1, 2, 0, 0, { canonicalModel: 'claude-x' }), 'claude-x[1m]': model(3, 4, 0, 0, { canonicalModel: 'claude-x' }) })).usage.breakdown,
    [ran('claude-x', 4, 6)]);
});

test('a counter that went down (/clear) is a reset: the model\'s turn is what it says now, and it counts on from there', () => {
  const usage = new PromptUsage();
  usage.restarted(false);
  told(usage, result({ a: model(1000, 500, 8000, 100), b: model(10, 10) }));
  // Only `a` says less: its turn is its counters; `b` is as it was.
  assert.deepEqual(told(usage, result({ a: model(40, 30, 0, 0), b: model(10, 10) })).usage.breakdown, [row('a', 40, 30)]);
  assert.deepEqual(told(usage, result({ a: model(60, 31, 0, 0), b: model(10, 10) })).usage.breakdown, [row('a', 20, 1)]);
  // Any one counter going down is the reset, the others of that model with it.
  assert.deepEqual(told(usage, result({ a: model(70, 5, 9, 9) })).usage.breakdown, [row('a', 70, 5, 9, 9)]);
});

test('a loaded or moved session\'s first result carries the transcript\'s totals: they are the base, the main loop\'s usage is that turn, and the differences hold from the next', () => {
  const usage = new PromptUsage();
  usage.restarted(true);
  assert.deepEqual(told(usage, result({ main: model(90000, 40000, 2000000, 80000), sub: model(500, 500) },
    { usage: { input_tokens: 12, output_tokens: 34, cache_read_input_tokens: 5600, cache_creation_input_tokens: 78 } })),
  { usage: { totalTokens: 12 + 34 + 5600 + 78, inputTokens: 12, outputTokens: 34, cachedReadTokens: 5600, cachedWriteTokens: 78 } });
  assert.deepEqual(told(usage, result({ main: model(90010, 40020, 2000100, 80000), sub: model(500, 500) })),
    { usage: { totalTokens: 10 + 20 + 100, inputTokens: 10, outputTokens: 20, cachedReadTokens: 100, cachedWriteTokens: 0, breakdown: [row('main', 10, 20, 100, 0)] } });
});

test('a loaded session\'s first turn with no usable main-loop usage says none, and the history is not counted', () => {
  for (const main of [undefined, {}, { input_tokens: -1, output_tokens: 1.5 }, { input_tokens: '3' }]) {
    const usage = new PromptUsage();
    usage.restarted(true);
    assert.deepEqual(told(usage, result({ m: model(500, 500, 500, 500) }, { usage: main })), {}, JSON.stringify(main));
    assert.deepEqual(told(usage, result({ m: model(501, 502, 500, 500) })).usage.breakdown, [row('m', 1, 2)]);
  }
});

test('a crash or a failed start says zeros without success: nothing is counted and the base stays what it was, the first result of a loaded session included', () => {
  const usage = new PromptUsage();
  usage.restarted(false);
  told(usage, result({ m: model(100, 100, 100, 100) }));
  for (const modelUsage of [{}, { m: model(0, 0) }]) {
    assert.deepEqual(told(usage, result(modelUsage, { subtype: 'error_during_execution', is_error: true })), {});
  }
  assert.deepEqual(told(usage, result({ m: model(101, 102, 100, 100) })).usage.breakdown, [row('m', 1, 2)], 'not the whole history over again');
  const loaded = new PromptUsage();
  loaded.restarted(true);
  assert.deepEqual(told(loaded, result({ m: model(0, 0) }, { subtype: 'error_during_execution', is_error: true, usage: { input_tokens: 9 } })), {});
  // The failed start did not use up the loaded session's first result.
  assert.deepEqual(told(loaded, result({ m: model(7000, 3000) }, { usage: { input_tokens: 7, output_tokens: 3 } })).usage,
    { totalTokens: 10, inputTokens: 7, outputTokens: 3 });
  // A failed turn that did use tokens is counted like any.
  assert.deepEqual(told(loaded, result({ m: model(7010, 3000) }, { subtype: 'error_max_turns', is_error: true })).usage.breakdown, [row('m', 10, 0)]);
});

test('no valid non-negative count is no usage at all, not zeros', () => {
  const usage = new PromptUsage();
  usage.restarted(false);
  for (const modelUsage of [undefined, {}, { m: { contextWindow: 1000 } }, { m: model(0, 0) }, { m: null }, { m: { inputTokens: -5, outputTokens: 'x', cacheReadInputTokens: null } }]) {
    assert.deepEqual(told(usage, result(modelUsage)), {}, JSON.stringify(modelUsage));
  }
  // A model with no change is not told as a row of zeros.
  told(usage, result({ m: model(5, 5) }));
  assert.deepEqual(told(usage, result({ m: model(5, 5) })), {});
});

test('what several results of one prompt used is told once, when it is answered; one that fails tells none, and a result no prompt owns is not told as any', () => {
  const usage = new PromptUsage();
  usage.restarted(false);
  usage.hold(usage.measure(result({ m: model(10, 10) })));
  usage.hold(usage.measure(result({ m: model(30, 15, 4), s: model(2, 2) })));
  assert.deepEqual(usage.take(), { usage: { totalTokens: 53, inputTokens: 32, outputTokens: 17, cachedReadTokens: 4, cachedWriteTokens: 0,
    breakdown: [row('m', 30, 15, 4), row('s', 2, 2)] } });
  assert.deepEqual(usage.take(), {}, 'told once');
  usage.hold(usage.measure(result({ m: model(40, 15, 4), s: model(2, 2) })));
  usage.drop();
  // An autonomous turn: measured (the base moves), never held.
  usage.measure(result({ m: model(1040, 1015, 4), s: model(2, 2) }));
  assert.deepEqual(told(usage, result({ m: model(1041, 1015, 4), s: model(2, 2) })).usage.breakdown, [row('m', 1, 0)]);
});

test('a restarted query begins again: nothing held from the last, and a resumed one rebases', () => {
  const usage = new PromptUsage();
  usage.restarted(false);
  usage.hold(usage.measure(result({ m: model(10, 10) })));
  usage.restarted(true);
  assert.deepEqual(usage.take(), {});
  assert.deepEqual(told(usage, result({ m: model(10, 10) }, { usage: { input_tokens: 1, output_tokens: 1 } })).usage.totalTokens, 2);
});

const service = { service: 'coda://anthropic-messages/6f1a7c52-0d3b-4e8a-9a41-2b7d5c0e9f13', asked: 'group/ds-flash' };

test('a turn on a model service tells the service and the model asked at the top level, and no model that ran: one model is no breakdown', () => {
  const usage = new PromptUsage();
  usage.restarted(false, service);
  assert.deepEqual(told(usage, result({ 'group/ds-flash': model(100, 20, 5000, 300, { canonicalModel: 'claude-sonnet-x' }) })),
    { usage: { totalTokens: 5420, inputTokens: 100, outputTokens: 20, cachedReadTokens: 5000, cachedWriteTokens: 300, ...service } });
  // A resumed query's first turn has the main loop's usage alone, and carries the service as well.
  usage.restarted(true, service);
  assert.deepEqual(told(usage, result({ m: model(9000, 9000) }, { usage: { input_tokens: 3, output_tokens: 4 } })),
    { usage: { totalTokens: 7, inputTokens: 3, outputTokens: 4, ...service } });
});

test('a turn on a model service that used several models tells the asked one with the service, the others by the name the SDK has them as', () => {
  const usage = new PromptUsage();
  usage.restarted(false, service);
  const named = { canonicalModel: 'claude-haiku-x' };
  assert.deepEqual(told(usage, result({ 'group/ds-flash': model(10, 5), 'other-model': model(3, 2, 0, 0, named) })),
    { usage: { totalTokens: 20, inputTokens: 13, outputTokens: 7, cachedReadTokens: 0, cachedWriteTokens: 0, ...service,
      breakdown: [{ ...service, inputTokens: 10, outputTokens: 5, cachedReadTokens: 0, cachedWriteTokens: 0 }, row('other-model', 3, 2)] } });
});

test('a turn on a model service whose address gives no reference tells neither, and still no model that ran', () => {
  const usage = new PromptUsage();
  usage.restarted(false, {});
  assert.deepEqual(told(usage, result({ m: model(4, 5, 0, 0, { canonicalModel: 'claude-sonnet-x' }) })), { usage: { totalTokens: 9, inputTokens: 4, outputTokens: 5, cachedReadTokens: 0, cachedWriteTokens: 0 } });
  assert.deepEqual(told(usage, result({ m: model(5, 7, 0, 0, { canonicalModel: 'claude-sonnet-x' }), n: model(1, 1) })).usage.breakdown, [row('m', 1, 2), row('n', 1, 1)]);
});

test('a turn on Claude\'s own models tells no service', () => {
  const usage = new PromptUsage();
  usage.restarted(false);
  const { usage: own } = told(usage, result({ m: model(1, 2) }));
  assert.deepEqual([own.service, own.asked], [undefined, undefined]);
  assert.deepEqual(own.breakdown, [row('m', 1, 2)], 'no canonical name: the SDK\'s own name, as the unlayered label');
});

const own = (name, asked, ...counts) => ({ asked, ...ran(name, ...counts) });

test('on Claude\'s own models the model asked for is told with the one that ran: a single model, whatever name it is asked as', () => {
  const usage = new PromptUsage();
  usage.restarted(false);
  // An alias is told as asked only where the main thread said which model ran; the others are named by key or canonical name.
  for (const [asked, key, confirmed] of [['claude-opus-x', 'claude-opus-x', []], ['opus', 'claude-opus-x', ['claude-opus-x']], ['claude-opus-x[1m]', 'claude-opus-x[1m]', []], ['opus', 'opus', []]]) {
    const { usage: said } = told(usage, result({ [key]: model(1, 2, 0, 0, { canonicalModel: 'claude-opus-x' }) }, { n: 1 }), asked, confirmed);
    assert.deepEqual(said.breakdown, [own('claude-opus-x', asked, 1, 2)], asked);
    usage.restarted(false);
  }
});

test('a lone active model that is not the one asked for is never taken for the main model: only a subagent grew, so it is told as served alone', () => {
  const usage = new PromptUsage();
  usage.restarted(false);
  const totals = (haiku) => result({ 'claude-opus-5-5': model(100, 100, 0, 0, { canonicalModel: 'claude-opus-5-5' }), 'claude-haiku-5-5': model(haiku, haiku, 0, 0, { canonicalModel: 'claude-haiku-5-5' }) });
  told(usage, totals(10), 'claude-opus-5-5');
  const { usage: said } = told(usage, totals(30), 'claude-opus-5-5', ['claude-opus-5-5']);
  assert.deepEqual(said.breakdown, [ran('claude-haiku-5-5', 20, 20)]);
  usage.restarted(false);
  told(usage, totals(10), 'opus', ['claude-opus-5-5']);
  assert.deepEqual(told(usage, totals(30), 'opus', ['claude-opus-5-5']).usage.breakdown, [ran('claude-haiku-5-5', 20, 20)]);
});

test('an alias asked is told as asked on the model the main thread said ran, with or without a subagent\'s model beside it', () => {
  const usage = new PromptUsage();
  usage.restarted(false);
  const sonnet = n => model(n, n, 0, 0, { canonicalModel: 'claude-sonnet-5-5' }), haiku = n => model(n, n, 0, 0, { canonicalModel: 'claude-haiku-5-5' });
  assert.deepEqual(told(usage, result({ 'claude-sonnet-5-5': sonnet(5) }), 'sonnet', ['claude-sonnet-5-5']).usage.breakdown, [own('claude-sonnet-5-5', 'sonnet', 5, 5)]);
  assert.deepEqual(told(usage, result({ 'claude-sonnet-5-5': sonnet(8), 'claude-haiku-5-5': haiku(40) }), 'sonnet', ['claude-sonnet-5-5']).usage.breakdown,
    [own('claude-sonnet-5-5', 'sonnet', 3, 3), ran('claude-haiku-5-5', 40, 40)]);
  // The main thread said nothing: a subagent alone in the turn is not the main model.
  assert.deepEqual(told(usage, result({ 'claude-sonnet-5-5': sonnet(8), 'claude-haiku-5-5': haiku(50) }), 'sonnet').usage.breakdown, [ran('claude-haiku-5-5', 10, 10)]);
});

test('with a subagent\'s model in the turn only the main model\'s row is told as asked, even where the subagent used more', () => {
  const usage = new PromptUsage();
  usage.restarted(false);
  const both = (main, sub) => result({ 'claude-opus-x': model(...main, 0, 0, { canonicalModel: 'claude-opus-x' }), 'claude-haiku-x': model(...sub, 0, 0, { canonicalModel: 'claude-haiku-x' }) });
  assert.deepEqual(told(usage, both([10, 10], [500, 500]), 'claude-opus-x').usage.breakdown, [own('claude-opus-x', 'claude-opus-x', 10, 10), ran('claude-haiku-x', 500, 500)]);
  // The main model asked for as its `[1m]` variant, and by the name it was keyed under.
  assert.deepEqual(told(usage, result({ 'claude-opus-x[1m]': model(30, 10, 0, 0, { canonicalModel: 'claude-opus-x' }), 'claude-haiku-x': model(501, 501, 0, 0, { canonicalModel: 'claude-haiku-x' }) }), 'claude-opus-x[1m]').usage.breakdown,
    [own('claude-opus-x', 'claude-opus-x[1m]', 30, 10), ran('claude-haiku-x', 1, 1)]);
  // An alias asked cannot be told from a subagent's model among several: none is told as asked.
  usage.restarted(false);
  assert.deepEqual(told(usage, both([1, 1], [2, 2]), 'opus').usage.breakdown, [ran('claude-opus-x', 1, 1), ran('claude-haiku-x', 2, 2)]);
});

test('two names of the main model are one asked row, and a model told by `model` never carries asked', () => {
  const usage = new PromptUsage();
  usage.restarted(false);
  assert.deepEqual(told(usage, result({ alias: model(1, 2, 0, 0, { canonicalModel: 'claude-x' }), 'claude-x[1m]': model(3, 4, 0, 0, { canonicalModel: 'claude-x' }) }), 'claude-x[1m]').usage.breakdown,
    [own('claude-x', 'claude-x[1m]', 4, 6)]);
  usage.restarted(false);
  const { usage: said } = told(usage, result({ m: model(1, 2), n: model(3, 4, 0, 0, { canonicalModel: 'claude-x' }) }), 'm');
  assert.deepEqual(said.breakdown, [row('m', 1, 2), ran('claude-x', 3, 4)]);
  assert.ok(said.breakdown.every(item => !('model' in item && ('asked' in item || 'served' in item))));
});

test('a model chosen between turns is the asked of the turns after, and several results of one prompt keep their own', () => {
  const usage = new PromptUsage();
  usage.restarted(false);
  usage.hold(usage.measure(result({ 'claude-opus-x': model(10, 0, 0, 0, { canonicalModel: 'claude-opus-x' }) }), 'opus', ['claude-opus-x']));
  // The results hold the query's totals: the model of the turn before is still in it, and says nothing new.
  usage.hold(usage.measure(result({ 'claude-opus-x': model(10, 0, 0, 0, { canonicalModel: 'claude-opus-x' }), 'claude-sonnet-x': model(5, 0, 0, 0, { canonicalModel: 'claude-sonnet-x' }) }), 'sonnet', ['claude-sonnet-x']));
  assert.deepEqual(usage.take().usage.breakdown, [own('claude-opus-x', 'opus', 10, 0), own('claude-sonnet-x', 'sonnet', 5, 0)]);
});

test('a model service\'s turn and a loaded first turn tell no asked of Claude\'s own', () => {
  const usage = new PromptUsage();
  usage.restarted(false, service);
  assert.deepEqual(told(usage, result({ a: model(1, 1, 0, 0, { canonicalModel: 'c' }), b: model(1, 1, 0, 0, { canonicalModel: 'd' }) }), 'a').usage.breakdown,
    [row('a', 1, 1), row('b', 1, 1)]);
  usage.restarted(true);
  assert.deepEqual(told(usage, result({ a: model(9, 9) }, { usage: { input_tokens: 1 } }), 'a').usage.breakdown, undefined);
});

// The session, with the SDK's results said as the test places them.
async function session(t, { sdk = fixtureSdk(), ...options } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'coda-claude-usage-'));
  const s = new ClaudeSession({ sdk, env: { ...process.env, CODA_PLUGIN_STATE: cwd }, environment: value => ({ ...value }), ...options });
  s.connect({ readable: new ReadableStream({ start() {} }), writable: new WritableStream({ write() {} }) });
  t.after(async () => { await s.close(); await rm(cwd, { recursive: true, force: true }); });
  return { s, cwd };
}
async function until(fn) { for (let i = 0; i < 1000; i++) { const value = await fn(); if (value) return value; await delay(5); } throw new Error('Timed out'); }
const ask = (s, text) => s.prompt({ prompt: [{ type: 'text', text }] });
// A prompt of the fixture's that waits for the test to say its result.
async function manual(s, text = 'manual') {
  const query = queries.get(s.sessionId), before = query.received.length, pending = ask(s, text);
  await until(() => query.received.length > before && query.inputId === query.received.at(-1).uuid);
  return { pending, id: query.inputId, query, emit: async message => { query.emit(message); await query.stop(undefined); } };
}

test('a prompt\'s response carries the turn\'s usage at the top level, turn by turn, and says only the stop reason when nothing was used', async t => {
  const { s, cwd } = await session(t);
  await s.open({ cwd, mcpServers: [] });
  const first = await manual(s);
  await first.emit(result({ 'fixture-model': model(100, 20, 5000, 300) }, { user_message_uuid: first.id, user_message_uuids: [first.id] }));
  assert.deepEqual(await first.pending, { stopReason: 'end_turn',
    usage: { totalTokens: 5420, inputTokens: 100, outputTokens: 20, cachedReadTokens: 5000, cachedWriteTokens: 300, breakdown: [row('fixture-model', 100, 20, 5000, 300)] } });
  const second = await manual(s);
  await second.emit(result({ 'fixture-model': model(160, 70, 5000, 900), 'task-model': model(7, 8, 9, 0, { canonicalModel: 'claude-task' }) }, { user_message_uuid: second.id, user_message_uuids: [second.id] }));
  assert.deepEqual(await second.pending, { stopReason: 'end_turn',
    usage: { totalTokens: 60 + 50 + 600 + 7 + 8 + 9, inputTokens: 67, outputTokens: 58, cachedReadTokens: 9, cachedWriteTokens: 600,
      breakdown: [row('fixture-model', 60, 50, 0, 600), ran('claude-task', 7, 8, 9, 0)] } });
  // Nothing used (as the fixture's own results say): no usage, as before.
  assert.deepEqual(await ask(s, 'hello'), { stopReason: 'end_turn' });
});

test('a loaded session\'s first turn does not count its history, and says what its main loop used; the turn after counts the differences', async t => {
  const { s, cwd } = await session(t);
  const opened = await s.open({ cwd, mcpServers: [] });
  await ask(s, 'one');
  const again = (await session(t, { sdk: s.sdk })).s;
  await again.open({ cwd, mcpServers: [] }, s.sessionId);
  assert.ok(opened.sessionId);
  const first = await manual(again);
  await first.emit(result({ 'fixture-model': model(900000, 400000, 20000000, 800000) },
    { user_message_uuid: first.id, user_message_uuids: [first.id], usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 5, cache_creation_input_tokens: 6 } }));
  assert.deepEqual(await first.pending, { stopReason: 'end_turn', usage: { totalTokens: 18, inputTokens: 3, outputTokens: 4, cachedReadTokens: 5, cachedWriteTokens: 6 } });
  const next = await manual(again);
  await next.emit(result({ 'fixture-model': model(900010, 400020, 20000100, 800000) }, { user_message_uuid: next.id, user_message_uuids: [next.id] }));
  assert.deepEqual(await next.pending, { stopReason: 'end_turn',
    usage: { totalTokens: 130, inputTokens: 10, outputTokens: 20, cachedReadTokens: 100, cachedWriteTokens: 0, breakdown: [row('fixture-model', 10, 20, 100, 0)] } });
});

test('a message steered into a prompt whose own turn ended first is answered with both results\' usage in one response', async t => {
  const { s, cwd } = await session(t);
  await s.open({ cwd, mcpServers: [] });
  const turn = await manual(s);
  // What is said into the turn waits for the test to name it in a result, as the fixture would else answer it itself.
  turn.query.pause();
  assert.equal(s.steer({ prompt: [{ type: 'text', text: '再补一句' }] }).outcome, 'injected');
  const [taken] = s.steering;
  await turn.emit(result({ 'fixture-model': model(10, 10) }, { user_message_uuid: turn.id, user_message_uuids: [turn.id] }));
  let answered = false;
  turn.pending.then(() => { answered = true; });
  await delay(50);
  assert.equal(answered, false, 'the prompt waits for what was said into it');
  await turn.emit(result({ 'fixture-model': model(25, 12, 3) }, { user_message_uuid: taken, user_message_uuids: [taken] }));
  assert.deepEqual(await turn.pending, { stopReason: 'end_turn',
    usage: { totalTokens: 25 + 12 + 3, inputTokens: 25, outputTokens: 12, cachedReadTokens: 3, cachedWriteTokens: 0, breakdown: [row('fixture-model', 25, 12, 3, 0)] } });
});

test('a turn Claude began on its own moves the base and is told as no prompt\'s; a failed prompt tells none and leaves the next one its own', async t => {
  const { s, cwd } = await session(t);
  await s.open({ cwd, mcpServers: [] });
  const own = queries.get(s.sessionId);
  own.emit(result({ 'fixture-model': model(5000, 5000, 5000, 5000) }));
  await own.stop(undefined);
  const failing = await manual(s);
  await failing.emit(result({ 'fixture-model': model(5100, 5100, 5000, 5000) }, { subtype: 'error_during_execution', is_error: true, errors: ['这一轮失败了'], user_message_uuid: failing.id, user_message_uuids: [failing.id] }));
  await assert.rejects(failing.pending, /这一轮失败了/);
  const next = await manual(s);
  await next.emit(result({ 'fixture-model': model(5110, 5120, 5000, 5000) }, { user_message_uuid: next.id, user_message_uuids: [next.id] }));
  assert.deepEqual((await next.pending).usage.breakdown, [row('fixture-model', 10, 20)]);
});

test('on Claude\'s own models each turn tells the model chosen for it as asked, one chosen between turns included, and not a subagent\'s', async t => {
  const { s, cwd } = await session(t);
  await s.open({ cwd, mcpServers: [] });
  const turn = async (modelUsage) => {
    const next = await manual(s);
    await next.emit(result(modelUsage, { user_message_uuid: next.id, user_message_uuids: [next.id] }));
    return (await next.pending).usage.breakdown;
  };
  assert.deepEqual(await turn({ 'fixture-model': model(10, 1, 0, 0, { canonicalModel: 'fixture-model-v1' }), sub: model(5, 5, 0, 0, { canonicalModel: 'claude-sub' }) }),
    [own('fixture-model-v1', 'fixture-model-v1', 10, 1), ran('claude-sub', 5, 5)]);
  await s.configure('model', 'other-model');
  // The query's totals still hold the first turn's models, which used nothing in this one.
  assert.deepEqual(await turn({ 'fixture-model': model(10, 1, 0, 0, { canonicalModel: 'fixture-model-v1' }), sub: model(5, 5, 0, 0, { canonicalModel: 'claude-sub' }),
    'other-model': model(7, 2, 0, 0, { canonicalModel: 'claude-other' }) }), [own('claude-other', 'other-model', 7, 2)]);
});

test('only the main thread\'s models confirm the main row, and none of one turn is left for the next', async t => {
  const { s, cwd } = await session(t);
  await s.open({ cwd, mcpServers: [] });
  const sonnet = n => model(n, n, 0, 0, { canonicalModel: 'claude-sonnet-5-5' }), haiku = n => model(n, n, 0, 0, { canonicalModel: 'claude-haiku-5-5' });
  const said = (turn, model, parent) => turn.query.emit({ type: 'assistant', parent_tool_use_id: parent, message: { id: `m-${model}-${parent}`, model, content: [{ type: 'text', text: '好' }] } });
  const end = (turn, modelUsage) => turn.emit(result(modelUsage, { user_message_uuid: turn.id, user_message_uuids: [turn.id] }));
  // The main thread ran on Sonnet, asked for as the session's model: it is told as asked with a Haiku subagent beside it.
  const first = await manual(s);
  said(first, 'claude-sonnet-5-5', null); said(first, 'claude-haiku-5-5', 'tool-sub');
  await end(first, { 'claude-sonnet-5-5': sonnet(10), 'claude-haiku-5-5': haiku(40) });
  assert.deepEqual((await first.pending).usage.breakdown, [own('claude-sonnet-5-5', 'fixture-model-v1', 10, 10), ran('claude-haiku-5-5', 40, 40)]);
  // The next turn's main thread said nothing of Sonnet: only a subagent grew, Sonnet's, and it is told as served alone.
  const second = await manual(s);
  said(second, 'claude-haiku-5-5', 'tool-sub');
  await end(second, { 'claude-sonnet-5-5': sonnet(30), 'claude-haiku-5-5': haiku(40) });
  assert.deepEqual((await second.pending).usage.breakdown, [ran('claude-sonnet-5-5', 20, 20)]);
  // A subagent's Haiku alone in the turn, beside a main model whose counts did not move.
  const third = await manual(s);
  await end(third, { 'claude-sonnet-5-5': sonnet(30), 'claude-haiku-5-5': haiku(45) });
  assert.deepEqual((await third.pending).usage.breakdown, [ran('claude-haiku-5-5', 5, 5)]);
});
