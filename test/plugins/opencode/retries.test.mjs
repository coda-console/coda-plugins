// A model service's long wait, which the OpenCode entry ends the turn on (plugins/opencode/agent/retries.mjs), as OpenCode's
// ACP says it: a `session_info_update` with `_meta["opencode/retry"]`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LONG_WAIT, LongRetries } from '../../../plugins/opencode/agent/retries.mjs';
import { CHILD_UPDATE } from '../../../plugins/opencode/agent/children.mjs';

const NOW = Date.parse('2026-10-23T12:00:00Z');
const prompt = (id, sessionId = 'ses_a') => ({ jsonrpc: '2.0', id, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'hi' }] } });
const info = (sessionId, meta) => ({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'session_info_update', _meta: meta } } });
const retry = (sessionId, wait, message = 'WorkBuddy: 用量已超出限制，将在 2026-10-24 17:42:38 重置', more = {}) =>
  info(sessionId, { 'opencode/retry': { attempt: 1, nextRetryAt: new Date(NOW + wait).toISOString(), error: { type: 'rate_limit', message, status: 429 } }, ...more });
const answer = id => ({ jsonrpc: '2.0', id, result: { stopReason: 'cancelled', _meta: {} } });
const retries = () => {
  const cancelled = [];
  return { cancelled, waits: new LongRetries(sessionId => cancelled.push(sessionId), () => NOW) };
};

test('a wait past a minute stops OpenCode\'s turn, and its answer, whatever it is, is the reason; what OpenCode says goes on to Coda', () => {
  const { cancelled, waits } = retries();
  waits.toAgent(prompt(7));
  const said = retry('ses_a', 900_000);
  assert.equal(waits.fromAgent(said), said);
  assert.deepEqual(cancelled, ['ses_a']);
  // Told again as OpenCode goes on, it is stopped once.
  waits.fromAgent(retry('ses_a', 899_000));
  assert.deepEqual(cancelled, ['ses_a']);
  assert.deepEqual(waits.fromAgent(answer(7)), { jsonrpc: '2.0', id: 7, error: { code: -32603,
    message: 'WorkBuddy: 用量已超出限制，将在 2026-10-24 17:42:38 重置\n\nOpenCode 要等约 15 分钟才会重试，这一轮先结束。' } });
  // The next prompt is answered as OpenCode answers it.
  waits.toAgent(prompt(8));
  assert.deepEqual(waits.fromAgent(answer(8)), answer(8));
});

test('a subagent\'s wait, said in the session of the turn that waits on it, stops that turn', () => {
  const { cancelled, waits } = retries();
  waits.toAgent(prompt(3));
  waits.fromAgent(retry('ses_a', 900_000, 'Child: 用量窗口已满', { 'opencode/child-session': { id: 'ses_child', parentID: 'ses_a', depth: 1 } }));
  assert.deepEqual(cancelled, ['ses_a']);
  assert.equal(waits.fromAgent(answer(3)).error.message, 'Child: 用量窗口已满\n\nOpenCode 要等约 15 分钟才会重试，这一轮先结束。');
});

test('a child retry on the negotiated extension still ends its root prompt with the service reason', () => {
  const { cancelled, waits } = retries();
  waits.toAgent(prompt(3));
  const message = { method: CHILD_UPDATE, params: { rootSessionId: 'ses_a', childSessionId: 'ses_child',
    type: 'update', update: retry('ses_child', 900_000, 'Child service failed').params.update } };
  assert.equal(waits.fromAgent(message), message);
  assert.deepEqual(cancelled, ['ses_a']);
  assert.match(waits.fromAgent(answer(3)).error.message, /^Child service failed/);
});

test('a wait of a minute or less is OpenCode\'s; so are a session with no prompt under way, a retry begun, and any other update', () => {
  const { cancelled, waits } = retries();
  waits.toAgent(prompt(1));
  waits.fromAgent(retry('ses_a', LONG_WAIT));
  waits.fromAgent(retry('ses_b', 900_000));
  waits.fromAgent(info('ses_a', { 'opencode/retry': null }));
  waits.fromAgent(info('ses_a', { 'opencode/retry': { attempt: 2, nextRetryAt: 'soon' } }));
  waits.fromAgent({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'ses_a', update: { sessionUpdate: 'agent_message_chunk', _meta: { 'opencode/retry': {} } } } });
  assert.deepEqual(cancelled, []);
  assert.deepEqual(waits.fromAgent(answer(1)), answer(1));
  // Answered, the prompt is no longer under way.
  waits.fromAgent(retry('ses_a', 900_000));
  assert.deepEqual(cancelled, []);
});

test('the wait is said in hours from an hour, and a reason OpenCode gives none of is said for it', () => {
  const { waits } = retries();
  waits.toAgent(prompt(1));
  waits.fromAgent(retry('ses_a', LONG_WAIT + 1, ' '));
  assert.equal(waits.fromAgent(answer(1)).error.message, '模型服务要求稍后再试\n\nOpenCode 要等约 2 分钟才会重试，这一轮先结束。');
  waits.toAgent(prompt(2));
  waits.fromAgent(retry('ses_a', 3_599_500));
  assert.equal(waits.fromAgent(answer(2)).error.message.split('\n\n')[1], 'OpenCode 要等约 1 小时才会重试，这一轮先结束。');
});
