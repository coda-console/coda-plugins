import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyKimiError, failedAnswer, turnFailure } from '../../../plugins/kimi/agent/errors.mjs';

const reason = "403 You've reached your 5-hour usage limit. Your quota will reset when the current 5-hour window ends. To continue now, purchase extra usage or upgrade your plan: https://www.kimi.com/membership/subscription?tab=quota";

test('the known five-hour quota response is an execution failure with the full provider reason and a quota classification', () => {
  const reply = { jsonrpc: '2.0', id: 'quota', error: { code: -32000, message: `Authentication required: ${reason}`,
    data: { diagnostic: { statusCode: 403 }, _meta: { trace: 'kept', coda: { extra: true } } } } };
  const before = structuredClone(reply), classified = classifyKimiError(reply);
  assert.deepEqual(classified, { ...reply, error: { ...reply.error, code: -32603,
    message: reason,
    data: { diagnostic: { statusCode: 403 }, _meta: { trace: 'kept', coda: { extra: true, failure: { kind: 'quota_exhausted' } } } } } });
  assert.deepEqual(reply, before);
  assert.equal(classifyKimiError(classified), classified);
});

test('only the explicit five-hour quota message establishes quota exhaustion', () => {
  for (const error of [
    { code: -32000, message: 'Authentication required' },
    { code: -32000, message: 'Authentication required: 401 token expired' },
    { code: -32000, message: 'Authentication required: 403 permission denied' },
    { code: -32603, message: 'Internal error: 429 Too many requests' },
    { code: -32000, message: 'provider.auth_error' },
    { code: -32603, message: 'Internal error' },
    { code: -32000, message: { detail: reason } },
    { code: -32000, message: `Authentication required: quoted error: ${reason}` },
    { code: -32000, message: "Authentication required: 403 You've reached your 5-hour usage limit.example" },
  ]) {
    const reply = { jsonrpc: '2.0', id: 'unchanged', error };
    assert.equal(classifyKimiError(reply), reply);
  }
  const success = { id: 'ok', result: { stopReason: 'end_turn' } };
  assert.equal(classifyKimiError(success), success);
});

test('quota classification preserves a non-object error payload as details', () => {
  const error = classifyKimiError({ id: 'quota', error: { code: -32000, message: `Authentication required: ${reason}`, data: 'upstream details' } }).error;
  assert.equal(error.data.details, 'upstream details');
  assert.equal(error.data._meta.coda.failure.kind, 'quota_exhausted');
});

// Kimi's own turn.ended errors (agents/main/wire.jsonl of the quota-exhausted sessions); the 5xx and overload ones are built from the
// error classes of Kimi 2.1.1's binary (APIProviderOverloadedError, APIStatusError with a statusCode), which Kimi retries before failing the turn.
test('a failed turn is a failure with its reason, categorised only as Kimi\'s own error says; other ends are none', () => {
  const quota = "429 You've reached your weekly (7-day) usage limit. Your quota will reset when the current 7-day window ends.";
  const failed = (name, statusCode, code = 'provider.api_error', message = quota) => turnFailure('failed', { code, name, message, details: { statusCode } });
  assert.deepEqual(failed('APIProviderQuotaExhaustedError', 429), { message: quota, kind: 'quota_exhausted' });
  assert.deepEqual(failed('APIProviderOverloadedError', 529, 'provider.overloaded'), { message: quota, kind: 'service_unavailable' });
  for (const status of [500, 502, 503, 599]) assert.deepEqual(failed('APIStatusError', status), { message: quota, kind: 'service_unavailable' });
  for (const [name, status, code] of [['APIStatusError', 429], ['APIProviderRateLimitError', 429, 'provider.rate_limit'], ['APIStatusError', 403, 'provider.auth_error'],
    ['APIStatusError', 400], ['APIContextOverflowError', 413], ['APIStatusError', 600], ['APIStatusError', '503'], ['APIConnectionError', undefined, 'provider.connection_error']])
    assert.deepEqual(failed(name, status, code), { message: quota });
  assert.deepEqual(turnFailure('failed', { name: 'APIStatusError', message: 'overloaded' }), { message: 'overloaded' });
  assert.deepEqual(turnFailure('failed', undefined), { message: 'Kimi 这一轮执行失败' });
  assert.equal(turnFailure('failed', { code: 'provider.filtered', message: 'filtered', details: { statusCode: 500 } }), null);
  for (const reason of ['completed', 'cancelled', 'blocked']) assert.equal(turnFailure(reason, { name: 'APIProviderOverloadedError', message: quota }), null);
});

test('the answer to a failed prompt reports its category: quota only by kind, an upstream failure with the input accepted, any other none', () => {
  const answer = { jsonrpc: '2.0', id: 4, result: { stopReason: 'end_turn' } };
  assert.deepEqual(failedAnswer(answer, { message: 'm', kind: 'quota_exhausted' }),
    { jsonrpc: '2.0', id: 4, error: { code: -32603, message: 'm', data: { _meta: { coda: { failure: { kind: 'quota_exhausted' } } } } } });
  assert.deepEqual(failedAnswer(answer, { message: 'm', kind: 'service_unavailable' }),
    { jsonrpc: '2.0', id: 4, error: { code: -32603, message: 'm', data: { _meta: { coda: { failure: { kind: 'service_unavailable', input: 'accepted' } } } } } });
  assert.deepEqual(failedAnswer(answer, { message: 'm' }), { jsonrpc: '2.0', id: 4, error: { code: -32603, message: 'm' } });
});
