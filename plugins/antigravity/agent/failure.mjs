// agy can end a prompt with `end_turn` after a model request failed for good (the transcript then ends with the error: background.mjs
// `finish`). That is told as the error of the prompt (docs/agent-protocol.md「执行失败」): the text is agy's, and only a
// server error agy words as "STATUS (code 5xx): message" (agy 1.5.15: "UNAVAILABLE (code 503): No capacity available for model ...")
// is marked a service failure, which Coda retries on its own schedule; the input was accepted, the model had read it. Any other error
// (a timeout, a reset connection, a quota) stays a plain error: nothing in it says the service is the cause.
const SERVER_ERROR = /\b[A-Z_]+ \(code 5\d\d\):/;

export const failedError = text => ({ code: -32603, message: text,
  ...(SERVER_ERROR.test(text) && { data: { _meta: { coda: { failure: { kind: 'service_unavailable', input: 'accepted' } } } } }) });
