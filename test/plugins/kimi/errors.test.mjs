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
  const other = '529 something went wrong upstream';
  const failed = (name, statusCode, code = 'provider.api_error', message = other) => turnFailure('failed', { code, name, message, details: { statusCode } });
  assert.deepEqual(failed('APIProviderQuotaExhaustedError', 429), { message: other, kind: 'quota_exhausted' });
  assert.deepEqual(failed('APIProviderOverloadedError', 529, 'provider.overloaded'), { message: other, kind: 'service_unavailable' });
  for (const status of [500, 502, 503, 599]) assert.deepEqual(failed('APIStatusError', status), { message: other, kind: 'service_unavailable' });
  // A connection failure or timeout (both code provider.connection_error), and a 429 that is not quota: faults that clear by themselves.
  for (const [name, status, code] of [['APIConnectionError', undefined, 'provider.connection_error'], ['APITimeoutError', undefined, 'provider.connection_error'],
    ['APIProviderRateLimitError', 429, 'provider.rate_limit'], ['APIStatusError', 429, 'provider.rate_limit']])
    assert.deepEqual(failed(name, status, code), { message: other, kind: 'service_unavailable' }, name);
  for (const [name, status, code] of [['APIStatusError', 403, 'provider.auth_error'], ['APIStatusError', 401, 'provider.auth_error'],
    ['APIStatusError', 400], ['APIContextOverflowError', 413, 'context.overflow'], ['APIStatusError', 600], ['APIStatusError', '503'], ['APIStatusError', '429'],
    ['APIEmptyResponseError', undefined]])
    assert.deepEqual(failed(name, status, code), { message: other }, name);
  assert.deepEqual(turnFailure('failed', { name: 'APIStatusError', message: 'overloaded' }), { message: 'overloaded' });
  assert.deepEqual(turnFailure('failed', undefined), { message: 'Kimi 这一轮执行失败' });
  assert.equal(turnFailure('failed', { code: 'provider.filtered', message: 'filtered', details: { statusCode: 500 } }), null);
  for (const reason of ['completed', 'cancelled', 'blocked']) assert.equal(turnFailure(reason, { name: 'APIProviderOverloadedError', message: other }), null);
});

// The real turn.ended error of the five-hour quota (a wire.jsonl sample): a 403 provider.auth_error, not the quota error name.
test('Kimi\'s own quota words are quota whatever name, status or code carry them, and the -32000 path agrees with the turn path', () => {
  const real = { code: 'provider.auth_error', name: 'APIStatusError', details: { statusCode: 403 }, message: reason };
  assert.deepEqual(turnFailure('failed', real), { message: reason, kind: 'quota_exhausted' });
  const weekly = "You've reached your weekly (7-day) usage limit. Your quota will reset when the current 7-day window ends.";
  assert.deepEqual(turnFailure('failed', { code: 'provider.rate_limit', name: 'APIStatusError', details: { statusCode: 429 }, message: weekly }),
    { message: weekly, kind: 'quota_exhausted' });
  for (const text of [reason, weekly]) {
    const kind = turnFailure('failed', { message: text }).kind;
    const reply = classifyKimiError({ id: 1, error: { code: -32000, message: `Authentication required: ${text}` } });
    assert.equal(reply.error.data._meta.coda.failure.kind, kind);
  }
  // A login gone stays auth_required; only the words, not a 403 or provider.auth_error, make quota.
  assert.equal(turnFailure('failed', { code: 'auth.login_required', message: reason }).kind, 'auth_required');
  assert.equal(turnFailure('failed', { ...real, message: '403 permission denied' }).kind, undefined);
  assert.equal(turnFailure('failed', { ...real, message: `quoted: ${reason}` }).kind, undefined);
});

test('the answer to a failed prompt reports its category: quota only by kind, an upstream failure with the input accepted, any other none', () => {
  const answer = { jsonrpc: '2.0', id: 4, result: { stopReason: 'end_turn' } };
  assert.deepEqual(failedAnswer(answer, { message: 'm', kind: 'quota_exhausted' }),
    { jsonrpc: '2.0', id: 4, error: { code: -32603, message: 'm', data: { _meta: { coda: { failure: { kind: 'quota_exhausted' } } } } } });
  assert.deepEqual(failedAnswer(answer, { message: 'm', kind: 'service_unavailable' }),
    { jsonrpc: '2.0', id: 4, error: { code: -32603, message: 'm', data: { _meta: { coda: { failure: { kind: 'service_unavailable', input: 'accepted' } } } } } });
  assert.deepEqual(failedAnswer(answer, { message: 'm' }), { jsonrpc: '2.0', id: 4, error: { code: -32603, message: 'm' } });
});

// Kimi's own error code for an OAuth provider whose token cannot be refreshed (OAuthUnauthorizedError -> `auth.login_required`, from its
// binary). Protocol 6.2.0 is not published, so the installed validation rejects auth_required: the shape is asserted here. After 6.2.0 is
// published and check/coda/contract.json synced, check it with agentValueProblem('failure.json', failure) as the other kinds are.
test('a Kimi OAuth login that is gone is auth_required; a provider auth error, a 401 or 403 and a quota are not', () => {
  const message = 'OAuth provider "kimi-code" requires login before it can be used.';
  const lost = turnFailure('failed', { code: 'auth.login_required', name: 'KimiError', message });
  assert.deepEqual(lost, { message, kind: 'auth_required' });
  const answer = { jsonrpc: '2.0', id: 5, result: { stopReason: 'end_turn' } };
  assert.deepEqual(failedAnswer(answer, lost), { jsonrpc: '2.0', id: 5, error: { code: -32603, message,
    data: { _meta: { coda: { failure: { kind: 'auth_required', login: 'Kimi Code OAuth' } } } } } });
  for (const error of [{ code: 'provider.auth_error', name: 'APIStatusError', message: 'Invalid API key', details: { statusCode: 401 } },
    { code: 'provider.auth_error', name: 'APIStatusError', message: '403 permission denied', details: { statusCode: 403 } },
    { code: 'auth.token_missing', message: 'Provider credential missing' },
    { code: 'provider.api_error', name: 'APIStatusError', message: '401 Unauthorized', details: { statusCode: 401 } }])
    assert.deepEqual(turnFailure('failed', error), { message: error.message }, error.message);
  // A login code on a turn that did not fail says nothing.
  assert.equal(turnFailure('cancelled', { code: 'auth.login_required', message }), null);
});
