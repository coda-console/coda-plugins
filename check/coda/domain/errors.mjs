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
