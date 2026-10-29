const record = value => value && typeof value === 'object' && !Array.isArray(value);

// Only the shared protocol establishes a category; provider codes and error text stay with the plugin.
export function agentFailure(error) {
  const failure = error?.data?._meta?.coda?.failure;
  if (!record(failure)) return null;
  return failure.kind === 'quota_exhausted' ||
    (failure.kind === 'service_unavailable' && ['accepted', 'not_accepted'].includes(failure.input) &&
      (failure.retryAfterMs === undefined || (Number.isFinite(failure.retryAfterMs) && failure.retryAfterMs >= 0))) ? failure : null;
}

export function agentErrorMessage(error) {
  const message = typeof error?.message === 'string' && error.message ? error.message : 'Agent 返回错误';
  const detail = typeof error?.data?.message === 'string' ? error.data.message.trim() : '';
  const text = detail && !message.includes(detail) ? `${message}\n\n${detail}` : message;
  return agentFailure(error)?.kind === 'quota_exhausted' && !text.startsWith('额度不足') ? `额度不足\n\n${text}` : text;
}
