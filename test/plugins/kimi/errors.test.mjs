import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyKimiError, failedKimiTurn } from '../../../plugins/kimi/agent/errors.mjs';

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

test('a status code or an unrelated message does not establish quota exhaustion', () => {
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

test('the weekly quota response is classified whether ACP reports authentication or execution failure', () => {
  const reason = "429 You've reached your weekly (7-day) usage limit. Your quota will reset when the current 7-day window ends.";
  for (const code of [-32000, -32603]) {
    const classified = classifyKimiError({ id: 'weekly', error: { code, message: reason } });
    assert.equal(classified.error.code, -32603);
    assert.equal(classified.error.message, reason);
    assert.equal(classified.error.data._meta.coda.failure.kind, 'quota_exhausted');
  }
});

test('native failures keep their reason, but only explicit quota exhaustion receives the quota category', () => {
  const reply = { jsonrpc: '2.0', id: 'native', result: { stopReason: 'end_turn' } };
  for (const error of [
    { name: 'APIProviderQuotaExhaustedError', message: 'Quota exhausted', details: { statusCode: 429 } },
    { name: 'APIError', message: '429 Too many requests' },
    { name: 'AuthenticationError', message: '401 token expired' },
  ]) {
    const classified = failedKimiTurn(reply, { reason: 'failed', error });
    assert.equal(classified.id, reply.id);
    assert.equal('result' in classified, false);
    assert.equal(classified.error.message, error.message);
    assert.deepEqual(classified.error.data.providerError, error);
    assert.equal(classified.error.data._meta?.coda?.failure?.kind,
      error.name === 'APIProviderQuotaExhaustedError' ? 'quota_exhausted' : undefined);
  }
  for (const native of [{ reason: 'completed' }, { reason: 'cancelled' }, { reason: 'failed' }]) {
    assert.equal(failedKimiTurn(reply, native), reply);
  }
  const failure = { id: 'existing', error: { code: -32603, message: 'existing reason' } };
  assert.equal(failedKimiTurn(failure, { reason: 'failed', error: { message: 'another reason' } }), failure);
});

test('quota classification preserves a non-object error payload as details', () => {
  const error = classifyKimiError({ id: 'quota', error: { code: -32000, message: `Authentication required: ${reason}`, data: 'upstream details' } }).error;
  assert.equal(error.data.details, 'upstream details');
  assert.equal(error.data._meta.coda.failure.kind, 'quota_exhausted');
});
