import { RequestError } from '@agentclientprotocol/sdk';

// Only failed turns come here. Claude Code's synthetic assistant error and the subscription's rejected window are
// evidence, ordinary assistant text and a bare HTTP 429 are not. Keep the provider's recovery advice intact (its reset time
// said as a time mark: `marked`).
const exhausted = message => /^(?:You've (?:hit|reached) your (?:session|weekly|5-hour|7-day|usage) limit\b|(?:Your )?[Cc]redit balance is too low\b|You're out of (?:usage credits|extra usage)\b|Your org is out of usage\b)/.test(message);

// Claude Code says when the window that limits now resets in the time zone of the machine it runs on ("resets 5:10am
// (Australia/Sydney)"), not of whoever reads it. With that window's reset known (`window`: the latest rate_limit_info,
// which the CLI sends only as a window moves), the reason says it as a time mark instead, which each client writes in
// its own time zone (Coda's docs/agent-protocol.md「文字里的时刻」).
const windowReset = /^(You've (?:hit|reached) your [^·]+ · resets )[^·()]+ \([^()]+\)/;
const resetTime = window => window?.status === 'rejected' && Number.isSafeInteger(window.resetsAt) && window.resetsAt > 0 &&
  window.resetsAt <= 253402300799 ? new Date(window.resetsAt * 1000).toISOString() : undefined;

// The service or the way to it failing, which can pass (docs/agent-protocol.md「服务暂不可用」): the network (a connection reset,
// refused or timed out, DNS, a TLS handshake, a transfer cut off) and the service itself (5xx, overloaded, 529, a request that
// timed out). The retry policy is Coda's. A certificate that is wrong ("Unable to connect to API: SSL certificate has expired") is
// not one, and neither is a bare "Connection closed", which an MCP server says as well.
const network = /\b(?:ECONN(?:RESET|REFUSED|ABORTED)|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|EHOSTUNREACH|ENETUNREACH|EPROTO)\b|\bUND_ERR_[A-Z_]+|\bERR_SSL_[A-Z_]+|socket hang up|fetch failed|other side closed|premature close|unexpected EOF|Request timed out|Unable to connect to API(?!: SSL certificate)|\b(?:TLS|SSL)\b[^\n]{0,40}\bhandshake|\bhandshake (?:failed|timed out)|\bnetwork (?:error|connection (?:lost|error))/i;
const upstream = /\b(?:API Error:|HTTP|status(?: code)?)\s*:?\s*(?:408|5\d\d)\b|\boverloaded_error\b|\bapi_error\b|Repeated 529|\b(?:Bad Gateway|Service Unavailable|Gateway Time-?out|Internal Server Error)\b/i;
// A page of Cloudflare's in place of the API's answer, whatever the status: its 403 is no authentication failure.
const cloudflare = message => /\b[45]\d\d\b/.test(message) && /cloudflare|cf-ray|Just a moment|Attention Required/i.test(message);
// The login itself gone (docs/agent-protocol.md「需要重新登录」): Claude Code's own "Failed to authenticate: OAuth session expired and
// could not be refreshed". A bad or missing API key, a missing permission and a bare 401 or 403 are configuration, which logging in
// again does not mend.
const loginLost = /\bOAuth session expired and could not be refreshed\b/;
// The wait the service asked for, in ms: `Retry-After: 30` is seconds, `retry-after-ms: 1500` or `retry after 1500 ms` milliseconds.
const waited = message => {
  const [, ms, number, unit] = message.match(/\bretry[-_ ]after(-ms)?\b[":=\s]*(\d+(?:\.\d+)?)\s*(ms|milliseconds?)?/i) ?? [];
  return number === undefined ? undefined : Math.round(Number(number) * (ms || unit ? 1 : 1000));
};

export function claudeFailure(message, { error, limits, window } = {}) {
  const quota = (!error || ['rate_limit', 'billing_error'].includes(error)) &&
    (exhausted(message) || (error === 'rate_limit' && limits?.status === 'rejected'));
  const resetAt = quota ? resetTime(window) : undefined;
  // This is the final error: Claude Code's own retries (system/api_retry) are over before a turn's result comes, and the native
  // session has the input by then, so it is always `accepted`. Of the categories Claude Code names, overloaded and server_error
  // are the service's; the words tell for the unnamed (rate_limit, unknown). The rest (authentication, billing, invalid
  // request, ...) are never this, except a Cloudflare page, which Claude Code takes for an authentication failure.
  const unavailable = !quota && (cloudflare(message) || ['overloaded', 'server_error'].includes(error) ||
    (!error || ['rate_limit', 'unknown'].includes(error)) && (network.test(message) || upstream.test(message)));
  const retryAfterMs = unavailable ? waited(message) : undefined;
  const reauth = !quota && !unavailable && (!error || error === 'authentication_failed') && loginLost.test(message);
  const failure = quota ? { kind: 'quota_exhausted', ...(resetAt ? { resetAt } : {}) } :
    reauth ? { kind: 'auth_required', login: 'Anthropic OAuth' } :
    unavailable ? { kind: 'service_unavailable', input: 'accepted', ...(retryAfterMs === undefined ? {} : { retryAfterMs }) } : undefined;
  return new RequestError(-32603, resetAt ? message.replace(windowReset, (_, said) => `${said}<t:${resetAt}>`) : message,
    failure && { _meta: { coda: { failure } } });
}
