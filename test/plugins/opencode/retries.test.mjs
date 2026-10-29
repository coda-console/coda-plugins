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
const CAPACITY = 'Zen: OpenCode Go 2: Upstream request failed: [ttft_admission_refused] the cell is at capacity; retry shortly (after 5 s)';
const childStatus = (childSessionId = 'ses_child', parentSessionId = 'ses_a', status = 'created') => ({ method: CHILD_UPDATE,
  params: { rootSessionId: 'ses_a', childSessionId, parentSessionId, type: 'status', status } });
const childUpdate = (update, childSessionId = 'ses_child', parentSessionId = 'ses_a') => ({ method: CHILD_UPDATE,
  params: { rootSessionId: 'ses_a', childSessionId, parentSessionId, type: 'update', update } });
const childRetry = (child = 'ses_child', parent = 'ses_a') => childUpdate(retry(child, 900_000).params.update, child, parent);
const callUpdate = (toolCallId, fields, sessionId = 'ses_a') => {
  const update = { sessionUpdate: 'tool_call_update', toolCallId, ...fields };
  return sessionId === 'ses_a' ? { method: 'session/update', params: { sessionId, update } } : childUpdate(update, sessionId);
};
function call(waits, id = 'call', background = false, parent = 'ses_a') {
  waits.fromAgent(callUpdate(id, { sessionUpdate: 'tool_call', name: 'subagent', status: 'pending' }, parent));
  waits.fromAgent(callUpdate(id, { status: 'in_progress', rawInput: { agent: 'general', prompt: 'Task', background } }, parent));
}
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

for (const child of [false, true]) test(`capacity refusal in a ${child ? 'foreground child' : 'root'} settles only on the native answer, with its actual long wait`, () => {
  const { cancelled, waits } = retries();
  waits.toAgent(prompt(1));
  if (child) { call(waits); waits.fromAgent(childStatus()); }
  const update = retry('ses_a', 420_000, CAPACITY);
  const event = child ? childUpdate(update.params.update) : update;
  assert.equal(waits.fromAgent(event), event, 'a retry notification is not a terminal failure');
  assert.deepEqual(cancelled, ['ses_a']);
  assert.deepEqual(waits.fromAgent(answer(2)), answer(2), 'another request cannot settle this prompt');
  waits.fromAgent(retry('ses_a', 900_000, 'A later generic error'));
  const result = waits.fromAgent(answer(1));
  assert.deepEqual(result.error, { code: -32603,
    message: `服务容量暂满\n\n${CAPACITY}\n\nOpenCode 要等约 7 分钟才会重试，这一轮先结束。`,
    data: { _meta: { coda: { failure: { kind: 'service_unavailable', input: 'accepted', retryAfterMs: 420_000 } } } },
  });
  waits.toAgent(prompt(3));
  assert.deepEqual(waits.fromAgent(answer(3)), answer(3), 'classification belongs only to the failed prompt');
});

test('short capacity waits stay with OpenCode; generic rate limits, quota and authentication are not capacity failures', () => {
  const { cancelled, waits } = retries();
  waits.toAgent(prompt(1));
  waits.fromAgent(retry('ses_a', LONG_WAIT, CAPACITY));
  assert.deepEqual(cancelled, []);
  assert.deepEqual(waits.fromAgent(answer(1)), answer(1));
  for (const [message, status] of [['Too Many Requests', 429], ['用量已超出限制', 429],
    ['the cell is at capacity', 429], ['[ttft_admission_refused] another reason', 503], [CAPACITY, 401], [CAPACITY, 403]]) {
    waits.toAgent(prompt(2));
    const event = retry('ses_a', 420_000, message);
    event.params.update._meta['opencode/retry'].error.status = status;
    waits.fromAgent(event);
    assert.equal(waits.fromAgent(answer(2)).error.data, undefined);
  }
});

test('a subagent\'s wait, said in the session of the turn that waits on it, stops that turn', () => {
  const { cancelled, waits } = retries();
  waits.toAgent(prompt(3));
  call(waits);
  waits.fromAgent(childStatus());
  waits.fromAgent(retry('ses_a', 900_000, 'Child: 用量窗口已满', { 'opencode/child-session': { id: 'ses_child', parentID: 'ses_a', depth: 1 } }));
  assert.deepEqual(cancelled, ['ses_a']);
  assert.equal(waits.fromAgent(answer(3)).error.message, 'Child: 用量窗口已满\n\nOpenCode 要等约 15 分钟才会重试，这一轮先结束。');
});

test('a child retry on the negotiated extension still ends its root prompt with the service reason', () => {
  const { cancelled, waits } = retries();
  waits.toAgent(prompt(3));
  call(waits);
  waits.fromAgent(childStatus());
  const message = { method: CHILD_UPDATE, params: { rootSessionId: 'ses_a', childSessionId: 'ses_child',
    parentSessionId: 'ses_a', type: 'update', update: retry('ses_child', 900_000, 'Child service failed').params.update } };
  assert.equal(waits.fromAgent(message), message);
  assert.deepEqual(cancelled, ['ses_a']);
  assert.match(waits.fromAgent(answer(3)).error.message, /^Child service failed/);
});

test('background calls cannot stop their launching prompt, before or after the tool returns', () => {
  const { cancelled, waits } = retries();
  waits.toAgent(prompt(1));
  call(waits, 'background', true);
  waits.fromAgent(childStatus());
  waits.fromAgent(childRetry());
  waits.fromAgent(callUpdate('background', { status: 'completed' }));
  waits.fromAgent(childRetry());
  assert.deepEqual(cancelled, []);
  assert.deepEqual(waits.fromAgent(answer(1)), answer(1));
});

test('an old child cannot acquire the next prompt even if that prompt has a foreground subagent', () => {
  const { cancelled, waits } = retries();
  waits.toAgent(prompt(1));
  call(waits, 'old');
  waits.fromAgent(childStatus());
  waits.fromAgent(answer(1));
  waits.toAgent(prompt(2));
  call(waits, 'new');
  waits.fromAgent(childStatus('ses_new'));
  waits.fromAgent(childStatus('ses_child', 'ses_a', 'running'));
  waits.fromAgent(childRetry());
  assert.deepEqual(cancelled, []);
  waits.fromAgent(childRetry('ses_new'));
  assert.deepEqual(cancelled, ['ses_a']);
});

test('returning a foreground tool to the background removes its ability to cancel the root', () => {
  const { cancelled, waits } = retries();
  waits.toAgent(prompt(1));
  call(waits);
  waits.fromAgent(childStatus());
  waits.fromAgent(callUpdate('call', { status: 'completed', rawOutput: { metadata: { sessionID: 'ses_child', status: 'running' } } }));
  waits.fromAgent(childRetry());
  assert.deepEqual(cancelled, []);
});

for (const background of [false, true]) test(`a nested child retry ${background ? 'cannot cross a background ancestor' : 'ends the foreground chain that waits on it'}`, () => {
  const { cancelled, waits } = retries();
  waits.toAgent(prompt(1));
  call(waits, 'parent', background);
  waits.fromAgent(childStatus());
  call(waits, 'nested', false, 'ses_child');
  waits.fromAgent(childStatus('ses_nested', 'ses_child'));
  waits.fromAgent(childRetry('ses_nested', 'ses_child'));
  assert.deepEqual(cancelled, background ? [] : ['ses_a']);
});

test('ambiguous foreground/background launches cannot cancel a root, even after the background call returns', () => {
  const { cancelled, waits } = retries();
  waits.toAgent(prompt(1));
  call(waits, 'foreground');
  call(waits, 'background', true);
  waits.fromAgent(childStatus());
  waits.fromAgent(childRetry());
  waits.fromAgent(callUpdate('background', { status: 'completed' }));
  waits.fromAgent(childRetry());
  assert.deepEqual(cancelled, []);
});

test('unknown projected child retries do not masquerade as root retries', () => {
  const { cancelled, waits } = retries();
  waits.toAgent(prompt(1));
  call(waits);
  waits.fromAgent(retry('ses_a', 900_000, 'Unknown child', { 'opencode/child-session': { id: 'ses_old', parentID: 'ses_a' } }));
  assert.deepEqual(cancelled, []);
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
