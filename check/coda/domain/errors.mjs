export class ContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ContractError';
    this.code = code;
  }
}

export function requireCondition(condition, code, message) {
  if (!condition) throw new ContractError(code, message);
}

// A remote request was conclusively refused. Other errors leave its outcome uncertain and can be retried.
export const REFUSED = new Set(['forbidden', 'not_found', 'invalid_input', 'invalid_state', 'idempotency_conflict', 'call_ended']);
