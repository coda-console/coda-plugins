// The usage a prompt answers with (plugins/codex/agent/usage.mjs): the increase of the threads' counts over the turn, from event sequences as
// Codex's app-server says them, and the patch held against the locked codex-acp.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { servedCodexModels } from '../../../plugins/codex/agent/providers.mjs';
import { SessionUsage, countedCodexUsage, usage as sessions } from '../../../plugins/codex/agent/usage.mjs';
import { resolveFrom } from '../plugin.mjs';

const bundle = await readFile(resolveFrom('codex', '@agentclientprotocol/codex-acp'), 'utf8');
// One model response's count as Codex says it: `input` includes what was read from and written to the cache, `output` the thinking.
const response = ({ input, cached = 0, write = 0, output, thought = 0 }) => ({ totalTokens: input + output, inputTokens: input, cachedInputTokens: cached, cacheWriteInputTokens: write, outputTokens: output, reasoningOutputTokens: thought });
const add = (a, b) => Object.fromEntries(Object.keys(a).map(key => [key, a[key] + b[key]]));
const started = (threadId, turn) => ({ method: 'turn/started', params: { threadId, turn: { id: turn } } });
// A thread of Codex's: each response it makes is told with the thread's count so far.
const thread = (id, history = response({ input: 0, output: 0 })) => {
  let total = history;
  return { id, started: turn => started(id, turn), call(turn, used) { total = add(total, used); return { method: 'thread/tokenUsage/updated', params: { threadId: id, turnId: turn, tokenUsage: { total, last: used, modelContextWindow: 1000 } } }; },
    // The count falls: Codex told its count of the context as it was refilled.
    reset(turn, to, used) { total = to; return { method: 'thread/tokenUsage/updated', params: { threadId: id, turnId: turn, tokenUsage: { total, last: used, modelContextWindow: 1000 } } }; } };
};
const feed = (usage, ...events) => events.forEach(event => usage.notice(event));
const own = { model: 'gpt-5.5' };
const four = ({ inputTokens, outputTokens, cachedReadTokens, cachedWriteTokens }) => ({ inputTokens, outputTokens, cachedReadTokens, cachedWriteTokens });

test('a turn of several model calls says the increase of the thread\'s count, not the last call', () => {
  const usage = new SessionUsage(), root = thread('root');
  feed(usage, root.started('t1'), root.call('t1', response({ input: 1000, cached: 100, output: 50, thought: 10 })), root.call('t1', response({ input: 1200, cached: 1000, output: 70, thought: 20 })),
    root.call('t1', response({ input: 1500, cached: 1200, output: 30 })));
  assert.deepEqual(usage.take('root', own), { totalTokens: 3700 + 150, inputTokens: 1000 - 100 + 1200 - 1000 + 1500 - 1200, outputTokens: 150, cachedReadTokens: 2300, cachedWriteTokens: 0, thoughtTokens: 30 });
});

test('turns after one say their own increase each', () => {
  const usage = new SessionUsage(), root = thread('root');
  feed(usage, root.started('t1'), root.call('t1', response({ input: 100, cached: 40, output: 10 })), root.call('t1', response({ input: 200, cached: 100, output: 20 })));
  assert.deepEqual(four(usage.take('root', own)), { inputTokens: 160, outputTokens: 30, cachedReadTokens: 140, cachedWriteTokens: 0 });
  feed(usage, root.started('t2'), root.call('t2', response({ input: 300, cached: 250, output: 5 })));
  assert.deepEqual(four(usage.take('root', own)), { inputTokens: 50, outputTokens: 5, cachedReadTokens: 250, cachedWriteTokens: 0 });
});

test('a stopped turn says the increase up to the stop, and what comes after is the next answer\'s', () => {
  const usage = new SessionUsage(), root = thread('root');
  feed(usage, root.started('t1'), root.call('t1', response({ input: 100, output: 10 })), root.call('t1', response({ input: 150, output: 5 })));
  assert.equal(usage.take('root', own).totalTokens, 265);
  feed(usage, root.call('t1', response({ input: 20, output: 1 })), root.started('t2'), root.call('t2', response({ input: 30, output: 2 })));
  assert.equal(usage.take('root', own).totalTokens, 53, 'a response told after the answer is the next one\'s, once');
});

test('a prompt that sent no model request has no usage, as one that has nothing new', () => {
  const usage = new SessionUsage(), root = thread('root');
  assert.equal(usage.take('root', own), null, 'nothing yet');
  feed(usage, root.started('t1'), root.call('t1', response({ input: 100, output: 10 })));
  assert.notEqual(usage.take('root', own), null);
  // `/status`: no turn, or a turn that told the count it had.
  assert.equal(usage.take('root', own), null);
  feed(usage, root.started('t2'), { method: 'thread/tokenUsage/updated', params: { threadId: 'root', turnId: 't2', tokenUsage: { total: response({ input: 100, output: 10 }), last: response({ input: 100, output: 10 }), modelContextWindow: 1000 } } });
  assert.equal(usage.take('root', own), null);
});

test('the first turn of a resumed thread does not carry the thread\'s history', () => {
  const history = response({ input: 900000, cached: 800000, output: 2000 }), last = response({ input: 80000, cached: 70000, output: 600 });
  // Codex tells the count of the thread again when it is resumed: of a turn this process saw no start of.
  const replayed = new SessionUsage(), root = thread('root', history);
  feed(replayed, { method: 'thread/tokenUsage/updated', params: { threadId: 'root', turnId: 'before', tokenUsage: { total: history, last, modelContextWindow: 1000 } } });
  assert.equal(replayed.take('root', own), null, 'the replay says nothing of this process\'s turns');
  feed(replayed, root.started('t1'), root.call('t1', response({ input: 100, cached: 50, output: 10 })), root.call('t1', response({ input: 200, cached: 150, output: 20 })));
  assert.deepEqual(four(replayed.take('root', own)), { inputTokens: 100, outputTokens: 30, cachedReadTokens: 200, cachedWriteTokens: 0 });
  // Not told: the first count of the turn is taken from before its first response (`total` less `last`).
  const silent = new SessionUsage(), other = thread('root', history);
  feed(silent, other.started('t1'), other.call('t1', response({ input: 100, cached: 50, output: 10 })), other.call('t1', response({ input: 200, cached: 150, output: 20 })));
  assert.deepEqual(four(silent.take('root', own)), { inputTokens: 100, outputTokens: 30, cachedReadTokens: 200, cachedWriteTokens: 0 });
});

test('a count that falls is a reset: the response\'s own count is told, never a negative', () => {
  const usage = new SessionUsage(), root = thread('root');
  feed(usage, root.started('t1'), root.call('t1', response({ input: 5000, cached: 1000, output: 100 })));
  usage.take('root', own);
  feed(usage, root.started('t2'), root.reset('t2', response({ input: 400, cached: 100, output: 20 }), response({ input: 300, cached: 100, output: 20 })), root.call('t2', response({ input: 50, cached: 10, output: 5 })));
  assert.deepEqual(four(usage.take('root', own)), { inputTokens: 200 + 40, outputTokens: 25, cachedReadTokens: 110, cachedWriteTokens: 0 });
});

test('cache writes are told, and are left out of the uncached input as the cache reads are', () => {
  const usage = new SessionUsage(), root = thread('root');
  feed(usage, root.started('t1'), root.call('t1', response({ input: 1000, cached: 300, write: 200, output: 50 })));
  assert.deepEqual(usage.take('root', own), { totalTokens: 1050, inputTokens: 500, outputTokens: 50, cachedReadTokens: 300, cachedWriteTokens: 200, thoughtTokens: 0 });
});

test('a subagent\'s usage is the parent turn\'s that it came in, once', () => {
  const usage = new SessionUsage(), root = thread('root'), child = thread('child');
  feed(usage, root.started('t1'), root.call('t1', response({ input: 100, output: 10 })));
  const spawn = { method: 'item/started', params: { threadId: 'root', item: { type: 'subAgentActivity', id: 'a', agentThreadId: 'child', agentPath: '/root/x', kind: 'started', model: null } } };
  const first = child.call('c1', response({ input: 400, cached: 100, output: 40 }));
  feed(usage, spawn, child.started('c1'), first, first, child.call('c1', response({ input: 600, cached: 400, output: 60 })), root.call('t1', response({ input: 150, output: 15 })));
  assert.deepEqual(four(usage.take('root', own)), { inputTokens: 100 + 150 + 300 + 200, outputTokens: 10 + 15 + 100, cachedReadTokens: 500, cachedWriteTokens: 0 });
  assert.equal(usage.take('root', own), null, 'what was told is not told again');
  // The child's later turn, once its parent's was answered, is in the answer of the turn it comes in.
  feed(usage, root.started('t2'), child.started('c2'), child.call('c2', response({ input: 10, output: 1 })), root.call('t2', response({ input: 20, output: 2 })));
  assert.deepEqual(four(usage.take('root', own)), { inputTokens: 30, outputTokens: 3, cachedReadTokens: 0, cachedWriteTokens: 0 });
});

test('a subagent\'s turn that begins before its parent tells of it is counted when it does, once; a thread never told of is not', () => {
  const root = thread('early-root'), child = thread('early-child'), stranger = thread('early-stranger');
  // The turn starts and counts twice with no handler for the thread (kept), the parent tells of it, and it counts once more (handled).
  for (const event of [child.started('c1'), child.call('c1', response({ input: 400, cached: 100, output: 40 })), stranger.started('s1'), stranger.call('s1', response({ input: 9000, output: 900 })),
    child.call('c1', response({ input: 600, cached: 400, output: 60 }))]) sessions.held(event);
  sessions.notice('early-root', root.started('t1'));
  sessions.notice('early-root', root.call('t1', response({ input: 100, output: 10 })));
  sessions.claim('early-root', 'early-child');
  sessions.notice('early-root', child.call('c1', response({ input: 50, output: 5 })));
  sessions.claim('early-root', 'early-child');
  assert.deepEqual(four(sessions.take({ sessionId: 'early-root', currentModelId: 'gpt-5.5[high]', codaRequested: null })),
    { inputTokens: 100 + 300 + 200 + 50, outputTokens: 10 + 40 + 60 + 5, cachedReadTokens: 500, cachedWriteTokens: 0 }, 'the stranger\'s 9900 is not counted, nor the child twice');
});

test('a subagent on another model than its parent\'s is told apart in the breakdown, on the parent\'s service when the parent has one', () => {
  const run = (model, parent) => {
    const usage = new SessionUsage(), root = thread('root'), child = thread('child'), other = thread('other');
    const spawn = (id, spawned) => ({ method: 'item/completed', params: { threadId: 'root', item: { type: 'collabAgentToolCall', tool: 'spawnAgent', id, senderThreadId: 'root', receiverThreadIds: [spawned], model, agentsStates: {} } } });
    feed(usage, root.started('t1'), root.call('t1', response({ input: 100, output: 10 })), spawn('a', 'child'), child.started('c1'), child.call('c1', response({ input: 400, cached: 100, output: 40 })),
      { ...spawn('b', 'other'), params: { threadId: 'root', item: { ...spawn('b', 'other').params.item, model: null } } }, other.started('o1'), other.call('o1', response({ input: 7, output: 3 })));
    return usage.take('root', parent);
  };
  const flat = { inputTokens: 100 + 300 + 7, outputTokens: 10 + 40 + 3, cachedReadTokens: 100, cachedWriteTokens: 0 };
  // A child spawned with no model runs on its parent's; one on the same model is not another.
  assert.equal(run(null, own).breakdown, undefined);
  assert.equal(run('gpt-5.5', own).breakdown, undefined);
  const mixed = run('gpt-5.4-mini', own);
  assert.deepEqual(four(mixed), flat);
  assert.deepEqual(mixed.breakdown, [{ model: 'gpt-5.5', inputTokens: 107, outputTokens: 13, cachedReadTokens: 0, cachedWriteTokens: 0 },
    { model: 'gpt-5.4-mini', inputTokens: 300, outputTokens: 40, cachedReadTokens: 100, cachedWriteTokens: 0 }]);
  const service = { service: 'coda://openai-responses/6f1a7c52-0d3b-4e8a-9a41-2b7d5c0e9f13', asked: 'group/ds-flash' };
  assert.deepEqual(run('group/ds-pro', service).breakdown.map(({ inputTokens, outputTokens, cachedReadTokens, cachedWriteTokens, ...identity }) => identity),
    [service, { service: service.service, asked: 'group/ds-pro' }]);
  // The parent's own model not known (a service's model whose address gives no reference): no part is named wrong, none is told.
  assert.equal(run('gpt-5.4-mini', null).breakdown, undefined);
});

test('the patch applies to the locked codex-acp as the entry applies it, on the model service patch, and fails loudly once it changes', () => {
  const counted = countedCodexUsage(servedCodexModels(bundle));
  assert.ok(counted.startsWith('import { usage as codaUsage } from '));
  assert.equal(counted.split('codaUsage.notice(subscription.rootSessionId, event);\n      this.discover(session, event);').length, 2, 'the session\'s own thread');
  assert.equal(counted.split('codaUsage.notice(session.current.rootSessionId, childEvent);\n        this.discover(session, childEvent);').length, 2, 'each subagent\'s, with its own thread ID');
  assert.equal(counted.split('codaUsage.held(notification);\n      }\n      return;').length, 2, 'a thread with no handler yet');
  assert.equal(counted.split('codaUsage.claim(session.current.rootSessionId, childSessionId);').length, 2, 'until the parent tells of it');
  assert.equal(counted.includes('codaUsage.notice(this.sessionState'), false, 'not where codex-acp handles a notification, which it does again for what it held back');
  assert.equal(counted.split('codaServices.usage(sessionState, codaUsage.take(sessionState))').length, 5, 'every answer of a prompt: a command, a turn, a stop, a failure; the model service says its own on each');
  assert.equal(counted.includes('this.buildPromptUsage(sessionState.lastTokenUsage)'), false);
  const checked = spawnSync(process.execPath, ['--check', '--input-type=module'], { input: counted, encoding: 'utf8' });
  assert.equal(checked.status, 0, checked.stderr);
  assert.throws(() => countedCodexUsage(bundle.replace('      this.discover(session, event);\n      session.current.dispatch(event);', '      session.current.dispatch(event);')), /no longer matches/);
  assert.throws(() => countedCodexUsage(bundle.replace('      if (handler) {\n        handler(notification);\n      }\n      return;', '      handler?.(notification);\n      return;')), /no longer matches/);
  assert.throws(() => countedCodexUsage(bundle.replace('      session.children.add(childSessionId);\n', '      session.children.add(childSessionId);\n      session.children.size;\n      ')), /no longer matches/);
  assert.throws(() => countedCodexUsage(bundle.replace('        if (eventThreadId !== childSessionId) return;\n        this.discover(session, childEvent);', '        this.discover(session, childEvent);')), /no longer matches/);
  assert.throws(() => countedCodexUsage(bundle.replace('usage: this.buildPromptUsage(sessionState.lastTokenUsage),\n          _meta', 'usage: null,\n          _meta')), /no longer matches/);
});
