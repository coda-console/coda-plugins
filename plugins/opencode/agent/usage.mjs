// OpenCode's answer to a prompt carries `result.usage` from its ACP usage conversion, where `outputTokens` is `tokens.output`
// alone and the reasoning is only in `thoughtTokens` (and in its `totalTokens`). Coda's four counts treat thinking as
// part of the output (docs/agent-protocol.md「每轮的用量」), so the reasoning is folded into `outputTokens`; `thoughtTokens` stays
// as the breakdown. Only a non-negative safe-integer `outputTokens`, a positive safe-integer `thoughtTokens` and a sum that is still
// a safe integer are folded; any other receipt is forwarded as it is.
export function foldThoughtIntoOutput(message) {
  const usage = message?.result?.usage;
  const { outputTokens, thoughtTokens } = usage ?? {};
  if (!Number.isSafeInteger(outputTokens) || outputTokens < 0 || !Number.isSafeInteger(thoughtTokens) || thoughtTokens <= 0 ||
    !Number.isSafeInteger(outputTokens + thoughtTokens)) return message;
  return { ...message, result: { ...message.result, usage: { ...usage, outputTokens: outputTokens + thoughtTokens } } };
}
