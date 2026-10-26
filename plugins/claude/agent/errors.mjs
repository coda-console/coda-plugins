import { RequestError } from '@agentclientprotocol/sdk';

// Only failed turns come here. Claude Code's synthetic assistant error and the subscription's rejected window are
// evidence, ordinary assistant text and a bare HTTP 429 are not. Keep the provider's reset time/recovery advice intact.
const exhausted = message => /^(?:You've (?:hit|reached) your (?:session|weekly|5-hour|7-day|usage) limit\b|(?:Your )?[Cc]redit balance is too low\b|You're out of (?:usage credits|extra usage)\b|Your org is out of usage\b)/.test(message);

export function claudeFailure(message, { error, limits } = {}) {
  const quota = (!error || ['rate_limit', 'billing_error'].includes(error)) &&
    (exhausted(message) || (error === 'rate_limit' && limits?.status === 'rejected'));
  return new RequestError(-32603, message, quota ? { _meta: { coda: { failure: { kind: 'quota_exhausted' } } } } : undefined);
}
