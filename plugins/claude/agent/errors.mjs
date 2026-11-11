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

export function claudeFailure(message, { error, limits, window } = {}) {
  const quota = (!error || ['rate_limit', 'billing_error'].includes(error)) &&
    (exhausted(message) || (error === 'rate_limit' && limits?.status === 'rejected'));
  const resetAt = quota ? resetTime(window) : undefined;
  const data = quota ? { _meta: { coda: { failure: { kind: 'quota_exhausted', ...(resetAt ? { resetAt } : {}) } } } } : undefined;
  return new RequestError(-32603, resetAt ? message.replace(windowReset, (_, said) => `${said}<t:${resetAt}>`) : message, data);
}
