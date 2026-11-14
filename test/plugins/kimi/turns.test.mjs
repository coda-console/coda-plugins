// The main turns Kimi's ACP does not tell (plugins/kimi/agent/turns.mjs), read from its main wire: its goal is a timer whose
// turns are handled with what they say, and a Coda prompt Kimi queued behind one is answered once the turn that runs it ends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { kimiSession } from '../../../plugins/kimi/agent/observe.mjs';
import { KimiTurns } from '../../../plugins/kimi/agent/turns.mjs';
import { KimiRelay } from '../../../plugins/kimi/agent/relay.mjs';

const SESSION = 'session-turns';
async function layout(t) {
  const root = await mkdtemp(join(tmpdir(), 'coda-kimi-turns-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'kimi'), cwd = join(root, 'work'), session = join(home, 'sessions', 'workspace', SESSION);
  await mkdir(join(session, 'agents', 'main', 'tasks'), { recursive: true }); await mkdir(cwd, { recursive: true });
  await writeFile(join(home, 'session_index.jsonl'), JSON.stringify({ sessionId: SESSION, sessionDir: session, workDir: cwd }) + '\n');
  await writeFile(join(session, 'state.json'), JSON.stringify({ version: 2, id: SESSION, cwd, agents: { main: {} } }));
  const wire = join(session, 'agents/main/wire.jsonl');
  await writeFile(wire, JSON.stringify({ type: 'metadata', protocol_version: '1.5' }) + '\n');
  const write = (...events) => appendFile(wire, events.map(e => JSON.stringify({ agentId: 'main', ...e }) + '\n').join(''));
  return { home, cwd, write };
}
const GOAL = { kind: 'system_trigger', name: 'goal_continuation' };
const goal = (time, status) => ({ type: 'goal.create', goalId: 'g1', objective: '把对拍差异降到 0\n每轮真实对拍', time, ...(status ? { status } : {}) });
const begin = (turnId, time, origin = GOAL) => [{ type: 'agent.turn.started', turnId, time }, { type: 'turn.prompt', turnId, time, origin }];
const ended = (turnId, time, reason = 'completed') => ({ type: 'turn.ended', turnId, reason, time });
const loop = (turnId, time, event) => ({ type: 'context.append_loop_event', time, event: { turnId: String(turnId), ...event } });
const said = (turnId, time) => [
  loop(turnId, time, { type: 'content.part', uuid: `think-${turnId}`, part: { type: 'think', think: '先看对拍' } }),
  loop(turnId, time, { type: 'tool.call', uuid: `call-${turnId}`, toolCallId: 'tool_a', name: 'Bash', args: { command: 'make eval' } }),
  { type: 'context.append_loop_event', time, event: { type: 'tool.result', parentUuid: `call-${turnId}`, toolCallId: 'tool_a', result: { output: '40/51' } } },
  loop(turnId, time, { type: 'content.part', uuid: `text-${turnId}`, part: { type: 'text', text: `第 ${turnId} 轮完成` } }),
];
// What a message tells, in short: a wait's state, an update's kind and what it names, or an answer's stop.
const brief = m => m.method === '_coda/wait' ? ['wait', m.params.waitId, m.params.state]
  : m.method === 'session/update' ? ['update', m.params.update.sessionUpdate, m.params.update.toolCallId ?? m.params.update.content?.text]
  : 'id' in m ? ['answer', m.id, m.result?.stopReason] : [m.method];
function looker(f, { startedAt = 0 } = {}) {
  const session = kimiSession({ sessionId: SESSION, cwd: f.cwd, env: { KIMI_CODE_HOME: f.home }, version: '2.1.1', startedAt });
  const turns = new KimiTurns({ sessionId: SESSION, startedAt });
  const look = async () => {
    const facts = await session.observe({ signal: new AbortController().signal });
    return (facts ? turns.read(facts.main) : turns.lost());
  };
  return look;
}

test('a goal is a timer: each turn Kimi begins toward it is handled with what it says, until the goal is done', async t => {
  const f = await layout(t), look = looker(f);
  assert.deepEqual(await look(), []);
  await f.write(goal(10));
  const [registered] = await look();
  assert.deepEqual(registered.params, { sessionId: SESSION, waitId: 'g1', state: 'waiting', kind: 'timer', title: '把对拍差异降到 0',
    detail: '目标未完成前，每轮结束后自动继续', recurring: true, stoppable: false });
  await f.write(...begin(1, 11), ...said(1, 12));
  assert.deepEqual((await look()).map(brief), [['wait', 'g1', 'handling'], ['update', 'agent_thought_chunk', '先看对拍'],
    ['update', 'tool_call', '1:tool_a'], ['update', 'tool_call_update', '1:tool_a'], ['update', 'agent_message_chunk', '第 1 轮完成']]);
  // Kimi writes the next turn's start before the end of the one it follows: that end is no layout it does not know.
  await f.write(...begin(2, 20), ended(1, 20));
  assert.deepEqual((await look()).map(brief), [['wait', 'g1', 'waiting'], ['wait', 'g1', 'handling']]);
  await f.write({ type: 'goal.update', goalId: 'g1', status: 'complete', time: 21 });
  assert.deepEqual(await look(), []);
  await f.write(ended(2, 22));
  assert.deepEqual((await look()).map(brief), [['wait', 'g1', 'done']]);
});

test('the first look tells the goal and its turn going, not what was said before it; a turn from before this process is not told', async t => {
  const f = await layout(t);
  await f.write(goal(10), ...begin(1, 11), ...said(1, 12));
  assert.deepEqual((await looker(f)()).map(brief), [['wait', 'g1', 'waiting'], ['wait', 'g1', 'handling']]);
  assert.deepEqual((await looker(f, { startedAt: 15 })()).map(brief), [['wait', 'g1', 'waiting']]);
});

test('a goal paused and resumed is waited on afresh; one cleared or replaced ends, after the turn it is in', async t => {
  const f = await layout(t), look = looker(f);
  await look();
  await f.write(goal(10), { type: 'goal.update', goalId: 'g1', status: 'paused', time: 11 }, { type: 'goal.update', goalId: 'g1', status: 'active', time: 12 });
  assert.deepEqual((await look()).map(brief), [['wait', 'g1', 'waiting'], ['wait', 'g1', 'done'], ['wait', 'g1:2', 'waiting']]);
  await f.write(...begin(1, 13), { type: 'goal.clear', time: 14 }, { type: 'goal.create', goalId: 'g2', objective: '下一个目标', time: 15 });
  assert.deepEqual((await look()).map(brief), [['wait', 'g1:2', 'handling']]);
  await f.write(ended(1, 16));
  assert.deepEqual((await look()).map(brief), [['wait', 'g1:2', 'done'], ['wait', 'g2', 'waiting']]);
});

// The relay over real files, with Kimi's ACP stood in for.
async function relay(t, f) {
  const out = [], told = [];
  const r = new KimiRelay({ say: m => out.push(m), tell: m => told.push(m), env: { KIMI_CODE_HOME: f.home }, startedAt: 0, every: 20, hold: 200 });
  t.after(() => r.close());
  r.fromCoda({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} });
  r.fromAgent({ jsonrpc: '2.0', id: 0, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: 'Kimi Code CLI', version: '2.1.1' } } });
  r.fromCoda({ jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: f.cwd, mcpServers: [] } });
  r.fromAgent({ jsonrpc: '2.0', id: 1, result: { sessionId: SESSION } });
  await r.drained(); await r.look();
  const looked = async () => { await r.look({ fresh: true }); await r.drained(); };
  const prompt = id => r.fromCoda({ jsonrpc: '2.0', id, method: 'session/prompt', params: { sessionId: SESSION, prompt: [{ type: 'text', text: '审查' }] } });
  return { r, out, told, looked, prompt };
}

test('a prompt Kimi queued behind a goal turn is answered once the turn that runs it ends, after what that turn said', async t => {
  const f = await layout(t);
  const { r, out, looked, prompt } = await relay(t, f);
  const now = Date.now();
  await f.write(goal(now - 10), ...begin(1, now - 5));
  await looked();
  prompt(2);
  r.fromAgent({ jsonrpc: '2.0', id: 2, result: { stopReason: 'end_turn' } });
  await r.drained();
  assert.equal(out.some(m => m.id === 2), false);
  const ran = Date.now() + 1;
  await f.write(...begin(2, ran, { kind: 'user' }), ended(1, ran), loop(2, ran, { type: 'content.part', uuid: 'reply', part: { type: 'text', text: '审查通过' } }),
    ended(2, ran + 1), ...begin(3, ran + 1));
  await looked();
  const since = out.findIndex(m => m.method === '_coda/wait' && m.params.state === 'handling') + 1;
  assert.deepEqual(out.slice(since).map(brief), [['wait', 'g1', 'waiting'], ['update', 'agent_message_chunk', '审查通过'], ['answer', 2, 'end_turn'],
    ['wait', 'g1', 'handling']]);
});

test('a prompt Kimi spoke in, or one it answered with nothing going, is passed on at once; stopping a held one answers it', async t => {
  const f = await layout(t);
  const { r, out, told, looked, prompt } = await relay(t, f);
  prompt(2);
  r.fromAgent({ jsonrpc: '2.0', id: 2, result: { stopReason: 'end_turn' } });
  await r.drained();
  assert.deepEqual(brief(out.at(-1)), ['answer', 2, 'end_turn']);
  await f.write(goal(Date.now()), ...begin(1, Date.now()));
  await looked();
  prompt(3);
  r.fromAgent({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: SESSION, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '好' } } } });
  r.fromAgent({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn' } });
  await r.drained();
  assert.deepEqual(brief(out.at(-1)), ['answer', 3, 'end_turn']);
  prompt(4);
  r.fromAgent({ jsonrpc: '2.0', id: 4, result: { stopReason: 'end_turn' } });
  await r.drained();
  assert.equal(out.some(m => m.id === 4), false);
  r.fromCoda({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: SESSION } });
  await r.drained();
  assert.deepEqual([told.at(-1).method, brief(out.at(-1))], ['session/cancel', ['answer', 4, 'cancelled']]);
});

// Kimi's ACP answers a prompt whose turn failed with `end_turn`; the failure is in the turn's end on its wire.
const QUOTA = { code: 'provider.api_error', name: 'APIProviderQuotaExhaustedError', retryable: false,
  message: "429 You've reached your 5-hour usage limit. Your quota will reset when the current 5-hour window ends." };
const failed = (turnId, time, error) => ({ type: 'turn.ended', turnId, reason: 'failed', error, time });

test('a prompt whose turn failed is answered with that failure, quota exhaustion classified; one that completed is not', async t => {
  const f = await layout(t);
  const { r, out, prompt } = await relay(t, f);
  const answer = async (id, end) => {
    prompt(id);
    const ran = Date.now();
    await f.write(...begin(id, ran, { kind: 'user' }), end(id, ran));
    r.fromAgent({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
    await r.drained();
    return out.at(-1);
  };
  assert.deepEqual(await answer(2, (id, time) => failed(id, time, QUOTA)), { jsonrpc: '2.0', id: 2,
    error: { code: -32603, message: QUOTA.message, data: { _meta: { coda: { failure: { kind: 'quota_exhausted' } } } } } });
  assert.deepEqual(await answer(3, (id, time) => failed(id, time, { code: 'provider.api_error', message: '500 internal error' })),
    { jsonrpc: '2.0', id: 3, error: { code: -32603, message: '500 internal error' } });
  assert.deepEqual(await answer(6, (id, time) => failed(id, time, { code: 'provider.overloaded', name: 'APIProviderOverloadedError', message: '529 overloaded', details: { statusCode: 529 } })),
    { jsonrpc: '2.0', id: 6, error: { code: -32603, message: '529 overloaded', data: { _meta: { coda: { failure: { kind: 'service_unavailable', input: 'accepted' } } } } } });
  assert.deepEqual(await answer(4, (id, time) => ended(id, time)), { jsonrpc: '2.0', id: 4, result: { stopReason: 'end_turn' } });
  // Kimi answers a filtered response as `refusal` itself.
  assert.deepEqual(await answer(5, (id, time) => failed(id, time, { code: 'provider.filtered', message: 'filtered' })),
    { jsonrpc: '2.0', id: 5, result: { stopReason: 'end_turn' } });
});

test('a prompt held behind a goal turn is answered with the failure of the turn that ran it', async t => {
  const f = await layout(t);
  const { r, out, looked, prompt } = await relay(t, f);
  const now = Date.now();
  await f.write(goal(now - 10), ...begin(1, now - 5));
  await looked();
  prompt(2);
  r.fromAgent({ jsonrpc: '2.0', id: 2, result: { stopReason: 'end_turn' } });
  await r.drained();
  assert.equal(out.some(m => m.id === 2), false);
  const ran = Date.now() + 1;
  await f.write(...begin(2, ran, { kind: 'user' }), ended(1, ran), failed(2, ran + 1, QUOTA));
  await looked();
  assert.deepEqual(out.at(-1), { jsonrpc: '2.0', id: 2,
    error: { code: -32603, message: QUOTA.message, data: { _meta: { coda: { failure: { kind: 'quota_exhausted' } } } } } });
});

test('a goal Kimi paused after a turn failed ends failed with the reason; one whose next turn completed ends done', async t => {
  const f = await layout(t), look = looker(f);
  await look();
  await f.write(goal(10), ...begin(1, 11), failed(1, 12, QUOTA),
    { type: 'goal.update', goalId: 'g1', status: 'paused', reason: `Paused after provider API error: ${QUOTA.message}`, time: 13 });
  const told = await look();
  assert.deepEqual(told.map(brief), [['wait', 'g1', 'waiting'], ['wait', 'g1', 'handling'], ['wait', 'g1', 'waiting'], ['wait', 'g1', 'failed']]);
  assert.deepEqual(told.at(-1).params, { sessionId: SESSION, waitId: 'g1', state: 'failed', title: '额度不足', detail: QUOTA.message });
  await f.write({ type: 'goal.update', goalId: 'g1', status: 'active', time: 20 }, ...begin(2, 21), ...begin(3, 22),
    failed(2, 22, { message: '500 internal error' }), ended(3, 24), { type: 'goal.update', goalId: 'g1', status: 'complete', time: 25 });
  assert.deepEqual((await look()).map(brief), [['wait', 'g1:2', 'waiting'], ['wait', 'g1:2', 'handling'], ['wait', 'g1:2', 'waiting'],
    ['wait', 'g1:2', 'handling'], ['wait', 'g1:2', 'waiting'], ['wait', 'g1:2', 'done']]);
  // A Coda prompt's turn that failed while the goal waited pauses it too.
  await f.write({ type: 'goal.create', goalId: 'g2', objective: '下一个目标', time: 30 }, ...begin(4, 31, { kind: 'user' }), failed(4, 32, QUOTA),
    { type: 'goal.update', goalId: 'g2', status: 'paused', time: 33 });
  const paused = await look();
  assert.deepEqual(paused.map(brief), [['wait', 'g2', 'waiting'], ['wait', 'g2', 'failed']]);
  assert.deepEqual(paused.at(-1).params, { sessionId: SESSION, waitId: 'g2', state: 'failed', title: '额度不足', detail: QUOTA.message });
});
