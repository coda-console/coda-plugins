import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyKimiError, turnFailure } from '../../../plugins/kimi/agent/errors.mjs';

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

test('a failed turn is a failure with its reason, a quota one only as Kimi classified it; other ends are none', () => {
  const quota = "429 You've reached your 5-hour usage limit.";
  assert.deepEqual(turnFailure('failed', { code: 'provider.api_error', name: 'APIProviderQuotaExhaustedError', message: quota }), { message: quota, quota: true });
  assert.deepEqual(turnFailure('failed', { code: 'provider.api_error', name: 'APIStatusError', message: quota }), { message: quota, quota: false });
  assert.deepEqual(turnFailure('failed', undefined), { message: 'Kimi 这一轮执行失败', quota: false });
  assert.equal(turnFailure('failed', { code: 'provider.filtered', message: 'filtered' }), null);
  for (const reason of ['completed', 'cancelled', 'blocked']) assert.equal(turnFailure(reason, { message: quota }), null);
});
