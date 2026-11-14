// What a failure of OpenCode's model service means to Coda (docs/agent-protocol.md「执行失败」). OpenCode ends a failed prompt with
// -32603 `Internal error: <message>` and `data: { service, errorName }`, where errorName is its own classification of the provider's
// response (`provider.quota`, `provider.free-limit` for exhausted quota, `provider.rate-limit` for any other 429, `provider.internal`
// for 5xx and other upstream faults, `provider.transport` for connection failures, `provider.timeout`). Providers behind a
// gateway (WorkBuddy, OpenCode Zen) report an exhausted quota as a plain 429, which OpenCode types as a rate limit, so their
// own wording decides there. The plugin only reports what failed; Coda decides whether to wait or try again.
const QUOTA_TYPES = new Set(['provider.quota', 'provider.free-limit']);
// Faults that clear by themselves; OpenCode has already retried them before it fails the prompt.
const TEMPORARY_TYPES = ['provider.rate-limit', 'provider.internal', 'provider.transport', 'provider.timeout'];
const quotaWording = /Free usage limit reached|Credits exhausted|额度已用尽|用量已超出限制/i;
export const quotaText = text => typeof text === 'string' && quotaWording.test(text);

export function classifyOpenCodeError(message) {
  const error = message?.error;
  const type = error?.data?.errorName;
  if (error?.code !== -32603 || typeof type !== 'string' || error.data?._meta?.coda?.failure) return message;
  const failure = QUOTA_TYPES.has(type) || (['provider.rate-limit', 'provider.internal'].includes(type) && quotaText(error.message)) ?
    { kind: 'quota_exhausted' } : TEMPORARY_TYPES.includes(type) ? { kind: 'service_unavailable', input: 'accepted' } : null;
  if (!failure) return message;
  return { ...message, error: { ...error, data: { ...error.data, _meta: { ...error.data._meta, coda: { ...error.data._meta?.coda, failure } } } } };
}
