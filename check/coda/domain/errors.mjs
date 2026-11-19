export class ContractError extends Error {
  // `effects`, when said: how much of what was asked was done — `none`, `some` or `unknown`; `retryAfterMs`, when said: how
  // long the caller had better wait before asking again (docs/plugins.md「调用」).
  constructor(code, message, { effects, retryAfterMs } = {}) {
    super(message);
    this.name = 'ContractError';
    this.code = code;
    if (effects) this.effects = effects;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

export function requireCondition(condition, code, message) {
  if (!condition) throw new ContractError(code, message);
}

// A remote request was conclusively refused. Other errors leave its outcome uncertain and can be retried.
export const REFUSED = new Set(['forbidden', 'not_holder', 'not_found', 'invalid_input', 'invalid_state', 'idempotency_conflict', 'call_ended']);
