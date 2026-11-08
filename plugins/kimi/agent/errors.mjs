const record = value => value && typeof value === 'object' && !Array.isArray(value);

// Kimi 2.1.1 maps this quota response to ACP auth_required. Keep the provider's reason, but report an execution failure
// so clients do not send the user to sign in again. A 403 or provider.auth_error alone does not establish quota exhaustion.
export function classifyKimiError(message) {
  const error = message.error;
  if (error?.code !== -32000 || typeof error.message !== 'string') return message;
  const reason = error.message.replace(/^Authentication required:\s*/, '');
  if (!/^403 You've reached your 5-hour usage limit\.(?:\s|$)/.test(reason)) return message;
  const data = record(error.data) ? error.data : error.data == null ? {} : { details: error.data };
  const meta = record(data._meta) ? data._meta : {};
  const coda = record(meta.coda) ? meta.coda : {};
  return { ...message, error: { ...error, code: -32603,
    message: reason,
    data: { ...data, _meta: { ...meta, coda: { ...coda, failure: { kind: 'quota_exhausted' } } } } } };
}

// Kimi 2.1.1's ACP answers a prompt whose turn failed with `end_turn`, the error kept to the `turn.ended` of its main wire
// (observe.mjs). What failed so, read from that end: the provider's reason, and whether Kimi itself classified it as quota
// exhaustion (APIProviderQuotaExhaustedError, from the provider's own quota response). Null for a turn that did not fail,
// or whose filtered response Kimi answers as `refusal`.
export function turnFailure(reason, error) {
  if (reason !== 'failed' || error?.code === 'provider.filtered') return null;
  const message = typeof error?.message === 'string' && error.message.trim() ? error.message : 'Kimi 这一轮执行失败';
  return { message, quota: error?.name === 'APIProviderQuotaExhaustedError' };
}
// The answer to a prompt whose turn failed so, as the execution failure it was (docs/agent-protocol.md「执行失败」).
export const failedAnswer = (answer, failure) => ({ jsonrpc: answer.jsonrpc ?? '2.0', id: answer.id, error: { code: -32603, message: failure.message,
  ...(failure.quota ? { data: { _meta: { coda: { failure: { kind: 'quota_exhausted' } } } } } : {}) } });
