// codex-acp puts model-service errors in data.message, SDK-wrapped exceptions in data.details, and some configuration
// errors in a string data payload. Explain them in ACP's standard message so clients need not know those private shapes.
export function explainCodexError(message) {
  if (!message || typeof message !== 'object' || !('id' in message) || 'method' in message) return message;
  const error = message.error;
  if (!error || typeof error.message !== 'string') return message;
  const resetAt = error.data?._meta?.coda?.failure?.resetAt;
  const readable = text => resetAt ? text.replace(resetText, (_, prefix, time) => `${prefix}<t:${time}>`) : text;
  const parts = [readable(error.message)];
  for (const value of [error.data?.message, error.data?.details, error.data]) {
    const detail = typeof value === 'string' ? readable(value.trim()) : '';
    if (detail && !parts.some(part => part.includes(detail))) parts.push(detail);
  }
  const explained = parts.join('\n\n');
  return explained === error.message ? message : { ...message, error: { ...error, message: explained } };
}

// Only absolute reset times from the failed request are evidence. The account-wide rateLimits/read can contain several
// model pools, without identifying which one blocked this turn; do not schedule a retry from an unrelated window.
const resetText = /\b(try again at |resets (?:at )?)(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z)\b/gi;
function quotaReset(error, data) {
  for (const text of [data.additionalDetails, data.message, data.details, error.message]) {
    if (typeof text !== 'string') continue;
    let body; try { body = JSON.parse(text); } catch {}
    // An HTTP failure quotes the response body inside its own sentence: `unexpected status 429 Too Many Requests: {…}, url: …`.
    const seconds = body ? body.error?.resets_at : Number(text.match(/"resets_at"\s*:\s*(\d{1,12})\b/)?.[1]);
    if (Number.isSafeInteger(seconds) && seconds > 0 && seconds <= 253402300799)
      return new Date(seconds * 1000).toISOString();
    const time = [...text.matchAll(resetText)][0]?.[2];
    if (time && Number.isFinite(Date.parse(time)) && new Date(time).toISOString().slice(0, 19) === time.slice(0, 19))
      return new Date(time).toISOString();
  }
}

// A 429 that Codex reports as a plain HTTP failure carries the provider's response body in its message. Only the provider's
// own quota codes and wording establish exhaustion; any other 429 is a rate limit, whose "try again in 1.5s" is the wait.
const providerQuota = /\b(?:insufficient_quota|quota_exceeded|usage_limit_reached)\b|exceeded your current quota|hit your usage limit/i;
function suggestedWait(text) {
  const spoken = text.match(/try again in ((?:\d+(?:\.\d+)?(?:ms|h|m|s))+)/i)?.[1];
  if (!spoken) return;
  const unit = { h: 3_600_000, m: 60_000, s: 1000, ms: 1 };
  return Math.round([...spoken.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)].reduce((sum, [, n, u]) => sum + n * unit[u], 0));
}

// Native service facts, not a retry policy: Coda decides when/how often to try again. Explicit permanent kinds win over
// generic messages (in particular, quota failures also arrive as JSON-RPC Internal error).
export function codexFailureData(error, input) {
  const data = error.data && typeof error.data === 'object' && !Array.isArray(error.data) ? error.data : {};
  const info = data.codexErrorInfo;
  const reported = failure => ({ ...data, _meta: { ...data._meta, coda: { ...data._meta?.coda, failure } } });
  const quota = () => { const resetAt = quotaReset(error, data); return reported({ kind: 'quota_exhausted', ...(resetAt ? { resetAt } : {}) }); };
  if (info === 'usageLimitExceeded') return quota();
  const message = typeof data.message === 'string' ? data.message : typeof data.details === 'string' ? data.details : typeof error.data === 'string' ? error.data : error.message;
  let provider; try { provider = JSON.parse(message); } catch {}
  const status = provider?.status ?? (info && typeof info === 'object' ? Object.values(info)[0]?.httpStatusCode : null);
  const accepted = data._meta?.coda?.failure?.input === 'accepted' ? 'accepted' : input;
  if (status === 429 && info && typeof info === 'object' && 'httpConnectionFailed' in info) {
    const text = [data.additionalDetails, message].filter(value => typeof value === 'string').join('\n');
    if (providerQuota.test(text)) return quota();
    const retryAfterMs = suggestedWait(text);
    return { ...reported({ kind: 'service_unavailable', input: accepted, ...(retryAfterMs == null ? {} : { retryAfterMs }) }),
      ...(data.message || data.details ? {} : { details: error.message }) };
  }
  const permanent = ['usageLimitExceeded', 'unauthorized', 'contextWindowExceeded', 'sessionBudgetExceeded',
    'cyberPolicy', 'misalignmentPolicyViolation', 'sandboxError', 'threadRollbackFailed'].includes(info) || [401, 403].includes(status);
  const unavailableModel = provider?.type === 'error' && status === 400 && provider.error?.type === 'invalid_request_error' &&
    /^model ['"][^'"\r\n]+['"] is not enabled in rustponsesapi\.?$/.test(provider.error.message ?? '');
  const transport = info && typeof info === 'object' && ['httpConnectionFailed', 'responseStreamConnectionFailed',
    'responseStreamDisconnected', 'responseTooManyFailedAttempts'].some(kind => kind in info);
  const temporary = !permanent && (unavailableModel || (status >= 500 && status <= 599) ||
    ['internalServerError', 'serverOverloaded'].includes(info) ||
    (transport && (status == null || status >= 500)) ||
    (info === 'other' && message === 'Selected model is at capacity. Please try a different model.') ||
    (info == null && error.code === -32603 && message?.trim() === 'Internal error'));
  if (!temporary) return data;
  return { ...reported({ kind: 'service_unavailable', input: accepted }), ...(data.message || data.details ? {} : { details: error.message }) };
}

// codex-acp 1.12 only throws quota/auth failures for plain ACP clients; other failed native turns look successful.
// Keep native failure data at the ACP boundary, even when the terminal notification has no preceding error event.
export function reportedCodexFailures(source) {
  const replacements = [
    ['  async handleFailedTurn(turn) {\n    const activeFailure', `  async handleFailedTurn(turn) {
    if (!this.supportsTypedSessionFailures && turn.status === "failed" && this.failure === null) {
      this.failure = RequestError.internalError(this.createTurnErrorData(turn.error ?? {
        message: "Turn failed", codexErrorInfo: null, additionalDetails: null
      }));
      return;
    }
    const activeFailure`],
    ['    if (error51 === "usageLimitExceeded") {\n      this.failure = RequestError.internalError(',
      '    if (!this.isAuthenticationRequiredError(error51)) {\n      this.failure = RequestError.internalError('],
    ['    return createAgentTextMessageChunk(`${params.error.message}\n\n`);', '    return null;'],
    ['    return data;\n  }\n  handleTokenUsageUpdated(params) {',
      '    return codexFailureData({ code: -32603, message: error51.message, data }, "accepted");\n  }\n  handleTokenUsageUpdated(params) {'],
    ['      throw err;\n    } finally {\n      promptNotificationsActive = false;', `      const codaData = codexFailureData(err, sessionState.currentTurnId === null ? "not_accepted" : "accepted");
      if (codaData._meta?.coda?.failure) throw new RequestError(err.code ?? -32603, err.message, codaData);
      throw err;
    } finally {
      promptNotificationsActive = false;`],
  ];
  for (const [before, after] of replacements) {
    if (source.split(before).length !== 2) throw new Error('codex-acp error reporting patch no longer matches the locked adapter');
    source = source.replace(before, after);
  }
  return `import { codexFailureData } from ${JSON.stringify(import.meta.url)};\n${source.replace(/^#![^\n]*\n/, '')}`;
}
