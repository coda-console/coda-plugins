const record = value => value && typeof value === 'object' && !Array.isArray(value);

// Kimi's own words for a quota used up, whatever status or error code carries them (a 403 provider.auth_error for the five-hour
// window, a 429 for the weekly one).
const QUOTA_TEXT = /^(?:\d{3} )?You've reached your (?:5-hour|weekly \(7-day\)) usage limit\.(?:\s|$)/;

// Kimi 2.1.1 maps the quota response to ACP -32000 (auth_required). Report it as the execution failure it is (-32603), with the
// category turnFailure gives that reason, so clients do not send the user to sign in again.
export function classifyKimiError(message) {
  const error = message.error;
  if (error?.code !== -32000 || typeof error.message !== 'string') return message;
  const reason = error.message.replace(/^Authentication required:\s*/, '');
  const { kind } = turnFailure('failed', { message: reason });
  if (!kind) return message;
  const data = record(error.data) ? error.data : error.data == null ? {} : { details: error.data };
  const meta = record(data._meta) ? data._meta : {};
  const coda = record(meta.coda) ? meta.coda : {};
  return { ...message, error: { ...error, code: -32603,
    message: reason,
    data: { ...data, _meta: { ...meta, coda: { ...coda, failure: { kind } } } } } };
}

// Kimi 2.1.1's ACP answers a prompt whose turn failed with `end_turn`, the error kept to the `turn.ended` of its main wire
// (observe.mjs). What failed so, read from that end: the provider's reason, and the category Kimi's own error says: its
// APIProviderQuotaExhaustedError (the provider's quota response), or a fault that clears by itself (an upstream overload or 5xx
// status, a connection failure or timeout, a 429 that is not quota), which Kimi already retried before ending the turn. Kimi's own
// words for a quota used up (QUOTA_TEXT) count whatever its name, status or code say, so they are judged before any of those.
// Null for a turn that did not fail, or whose filtered response Kimi answers as `refusal`. Other failures (authentication,
// context, invalid request) carry no category, except that Kimi's own `auth.login_required` (its OAuth provider's token could
// not be refreshed: OAuthUnauthorizedError) is a login gone, `auth_required` (docs/agent-protocol.md「需要重新登录」). Its
// `provider.auth_error` is the provider rejecting the credentials, a key or a permission as well, which logging in again does not mend.
export function turnFailure(reason, error) {
  if (reason !== 'failed' || error?.code === 'provider.filtered') return null;
  const message = typeof error?.message === 'string' && error.message.trim() ? error.message : 'Kimi 这一轮执行失败';
  const status = error?.details?.statusCode;
  if (error?.code === 'auth.login_required') return { message, kind: 'auth_required' };
  if (error?.name === 'APIProviderQuotaExhaustedError' || QUOTA_TEXT.test(message)) return { message, kind: 'quota_exhausted' };
  if (error?.name === 'APIProviderOverloadedError' || error?.code === 'provider.connection_error' || status === 429 ||
    (Number.isInteger(status) && status >= 500 && status <= 599))
    return { message, kind: 'service_unavailable' };
  return { message };
}
// The answer to a prompt whose turn failed so, as the execution failure it was (docs/agent-protocol.md「执行失败」).
export const failedAnswer = (answer, failure) => ({ jsonrpc: answer.jsonrpc ?? '2.0', id: answer.id, error: { code: -32603, message: failure.message,
  ...(failure.kind ? { data: { _meta: { coda: { failure: failure.kind === 'quota_exhausted' ? { kind: failure.kind } :
    failure.kind === 'auth_required' ? { kind: failure.kind, login: 'Kimi Code OAuth' } : { kind: failure.kind, input: 'accepted' } } } } } : {}) } });
