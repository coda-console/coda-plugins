const record = value => value && typeof value === 'object' && !Array.isArray(value);

const quotaReason = reason => /^(?:403|429) You've reached your (?:5-hour|weekly \(7-day\)) usage limit\.(?:\s|$)/.test(reason);

// Kimi 2.1.1 can map quota exhaustion to ACP auth_required. A status code alone does not establish quota exhaustion.
export function classifyKimiError(message) {
  const error = message.error;
  if (![-32000, -32603].includes(error?.code) || typeof error.message !== 'string' ||
    error.data?._meta?.coda?.failure?.kind === 'quota_exhausted') return message;
  const reason = error.message.replace(/^Authentication required:\s*/, '');
  if (!quotaReason(reason)) return message;
  const data = record(error.data) ? error.data : error.data == null ? {} : { details: error.data };
  const meta = record(data._meta) ? data._meta : {};
  const coda = record(meta.coda) ? meta.coda : {};
  return { ...message, error: { ...error, code: -32603,
    message: reason,
    data: { ...data, _meta: { ...meta, coda: { ...coda, failure: { kind: 'quota_exhausted' } } } } } };
}

// Kimi also answers failed turns with end_turn. The matching native turn supplies the error ACP omitted.
export function failedKimiTurn(answer, { reason, error } = {}) {
  if (answer.result?.stopReason !== 'end_turn' || reason !== 'failed' || typeof error?.message !== 'string') return answer;
  const { result, ...reply } = answer;
  const failure = error.name === 'APIProviderQuotaExhaustedError' || quotaReason(error.message)
    ? { _meta: { coda: { failure: { kind: 'quota_exhausted' } } } } : {};
  return { ...reply, error: { code: -32603, message: error.message, data: { ...failure, providerError: error } } };
}
