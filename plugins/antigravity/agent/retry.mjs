// agy retries a failed model request inside the turn and says so with an agent_message_chunk, "\n⚠ API error (attempt N): <why>\n"
// (agy 1.5.9: the ACP layer writes "\n⚠ %s\n" around the Go format "API error (attempt %d): %v"). Coda would keep it as the
// reply's text, which then looks like an answer that broke off, while the turn goes on. Only a chunk that is exactly that one line
// is the notice; text with anything else in it (more lines, or around other text) is the answer's and goes on.
const NOTICE = /^⚠ API error \(attempt [1-9]\d*\): [^\r\n\u2028\u2029]+$/;

// The text of an agent message that is agy's retry notice, or null for any other message.
export function retryNotice(message) {
  const update = message?.params?.update;
  if (message?.method !== 'session/update' || update?.sessionUpdate !== 'agent_message_chunk' || update.content?.type !== 'text') return null;
  const text = update.content.text;
  return typeof text === 'string' && NOTICE.test(text.trim()) ? text : null;
}
