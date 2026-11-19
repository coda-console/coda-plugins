import { agentFailure } from '../../kernel/agent-failures.mjs';

// The rules of a service failure, and only them: the plugin contract check reads this file, so nothing of the runtime
// (recovery.mjs) is imported here.
// Plugins report facts about a failed request; Coda owns the policy. No provider names or error-text matching here.
export function serviceFailure(error) {
  const failure = agentFailure(error);
  return failure?.kind === 'service_unavailable' ? failure : null;
}
// The former capacity/model-unavailable policy, shared by every agent that reports a service failure.
export const RETRY_DELAYS = [15_000, 30_000, 60_000];
