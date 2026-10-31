import { agentValueProblem } from '@coda-console/protocol/agent';

// Only the shared protocol establishes a category; provider codes and error text stay with the plugin.
export function agentFailure(error) {
  const failure = error?.data?._meta?.coda?.failure;
  return agentValueProblem('failure.json', failure) === null ? failure : null;
}

export function agentErrorMessage(error) {
  const message = typeof error?.message === 'string' && error.message ? error.message : 'Agent 返回错误';
  const detail = typeof error?.data?.message === 'string' ? error.data.message.trim() : '';
  const text = detail && !message.includes(detail) ? `${message}\n\n${detail}` : message;
  return agentFailure(error)?.kind === 'quota_exhausted' && !text.startsWith('额度不足') ? `额度不足\n\n${text}` : text;
}
