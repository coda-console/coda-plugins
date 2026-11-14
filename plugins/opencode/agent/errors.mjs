// What a failure of OpenCode's model service means to Coda (docs/agent-protocol.md「执行失败」). OpenCode ends a failed prompt with
// -32603 `Internal error: <message>` and `data: { service, errorName }`, where errorName is its own classification of the provider's
// response (`provider.quota`, `provider.free-limit` for exhausted quota, `provider.rate-limit` for any other 429, `provider.internal`
// for 5xx and other upstream faults, `provider.transport` for connection failures, `provider.timeout`). Providers behind a
// gateway (WorkBuddy, OpenCode Zen) report an exhausted quota as a plain 429, which OpenCode types as a rate limit, so their
// own wording decides there. The plugin only reports what failed; Coda decides whether to wait or try again.
const QUOTA_TYPES = new Set(['provider.quota', 'provider.free-limit']);
// Faults that clear by themselves; OpenCode has already retried them before it fails the prompt.
const TEMPORARY_TYPES = new Set(['provider.rate-limit', 'provider.internal', 'provider.transport', 'provider.timeout']);
const quotaWording = /Free usage limit reached|Credits exhausted|额度已用尽|用量已超出限制/i;
export const quotaText = text => typeof text === 'string' && quotaWording.test(text);
// These admission refusals establish capacity exhaustion, unlike a generic 429 or retryable error. Their
// short suggestion in the message does not override the retry time OpenCode actually scheduled.
export const capacityRefused = ({ status, message }) => ![401, 403].includes(status) && typeof message === 'string' &&
  /\[(?:ttft_admission|prefill_cap)_refused\] the cell is at capacity(?:[;.]|$)/.test(message);

// The one place a provider's failure is judged, for OpenCode's own answer to a prompt (`name`: its errorName) and for the
// wait it announces (`status`: the provider's HTTP status). Said quota wins whatever the status, a fault that clears by
// itself (408, 429, 5xx, a capacity refusal, a dropped connection, a timeout) is a service failure, and authentication,
// content filtering, invalid requests and an overlong context are neither.
export function classifyProviderFault({ status, message, name }) {
  if ([401, 403].includes(status)) return null;
  if (name !== undefined && !QUOTA_TYPES.has(name) && !TEMPORARY_TYPES.has(name)) return null;
  if (QUOTA_TYPES.has(name) || quotaText(message)) return 'quota_exhausted';
  return TEMPORARY_TYPES.has(name) || status === 408 || status === 429 || (status >= 500 && status <= 599) || capacityRefused({ status, message }) ?
    'service_unavailable' : null;
}

export function classifyOpenCodeError(message) {
  const error = message?.error;
  const type = error?.data?.errorName;
  if (error?.code !== -32603 || typeof type !== 'string' || error.data?._meta?.coda?.failure) return message;
  const kind = classifyProviderFault({ message: error.message, name: type });
  if (!kind) return message;
  const failure = kind === 'quota_exhausted' ? { kind } : { kind, input: 'accepted' };
  return { ...message, error: { ...error, data: { ...error.data, _meta: { ...error.data._meta, coda: { ...error.data._meta?.coda, failure } } } } };
}
