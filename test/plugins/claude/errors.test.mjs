import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeFailure } from '../../../plugins/claude/agent/errors.mjs';
import { agentValueProblem } from '@coda-console/protocol/agent';

test('explicit Claude usage or credit exhaustion is quota; authentication, billing problems and generic rate limits are not', () => {
  for (const message of ["You've hit your session limit · resets 1am (Asia/Singapore)", "You've reached your weekly limit",
    'Your credit balance is too low to access the Anthropic API.', "You're out of usage credits", "You're out of extra usage",
    'Your org is out of usage · contact your admin']) {
    const error = claudeFailure(message);
    assert.equal(error.message, message);
    assert.deepEqual(error.data._meta.coda.failure, { kind: 'quota_exhausted' });
  }
  for (const [message, facts] of [
    ['HTTP 429 Too Many Requests', { error: 'rate_limit' }],
    ['HTTP 403 Forbidden', {}],
    ['Payment method declined', { error: 'billing_error' }],
    ['Invalid API key', { error: 'authentication_failed', limits: { status: 'rejected' } }],
    ['Account on hold', { error: 'account_on_hold', limits: { status: 'rejected' } }],
    ['Connection closed', { limits: { status: 'rejected' } }],
    ['Payment method declined', { error: 'billing_error', limits: { status: 'rejected' } }],
    ['Rate limit reached', { limits: { status: 'allowed_warning', utilization: 1 } }],
  ]) assert.equal(claudeFailure(message, facts).data, undefined, message);
});

test('Claude exposes only an exact rejected window reset, even when the reason has no time to rewrite', () => {
  for (const window of [
    { status: 'rejected', resetsAt: Date.parse('2026-11-11T19:00:00Z') / 1000 },
    { status: 'allowed', resetsAt: 1794423600 },
    { status: 'rejected' }, { status: 'rejected', resetsAt: 0 }, { status: 'rejected', resetsAt: Number.MAX_SAFE_INTEGER },
  ]) {
    const failure = claudeFailure("You've reached your weekly limit", { window }).data._meta.coda.failure;
    assert.equal(agentValueProblem('failure.json', failure), null);
    assert.deepEqual(failure, window.status === 'rejected' && window.resetsAt === Date.parse('2026-11-11T19:00:00Z') / 1000 ?
      { kind: 'quota_exhausted', resetAt: '2026-11-11T19:00:00.000Z' } : { kind: 'quota_exhausted' });
  }
});

test('a quota reason says the reset of the window that limits now as a time mark, not in the machine\'s time zone', () => {
  const window = { status: 'rejected', rateLimitType: 'five_hour', resetsAt: Date.UTC(2026, 9, 24, 18, 10) / 1000 }, mark = '<t:2026-10-24T18:10:00.000Z>';
  for (const [message, facts, said] of [
    ["You've hit your session limit · resets 5:10am (Australia/Sydney)", { window }, `You've hit your session limit · resets ${mark}`],
    ["You've hit your weekly limit · resets Oct 5 at 2pm (Asia/Singapore) · progress saved", { window },
      `You've hit your weekly limit · resets ${mark} · progress saved`],
    ["You've reached your Opus limit · resets 2am (UTC) · /upgrade to keep using Claude Code", { error: 'rate_limit', limits: window, window },
      `You've reached your Opus limit · resets ${mark} · /upgrade to keep using Claude Code`],
    // Without the window's reset, or with none limiting now, the reason stays as Claude Code said it.
    ["You've hit your session limit · resets 5:10am (Australia/Sydney)", {}, null],
    ["You've hit your session limit · resets 5:10am (Australia/Sydney)", { window: { ...window, status: 'allowed' } }, null],
    ["You've hit your session limit · resets 5:10am (Australia/Sydney)", { window: { ...window, resetsAt: undefined } }, null],
    ["You're out of usage credits · resets 5:10am (Australia/Sydney)", { window }, null],
    // Not a quota failure: not rewritten.
    ["Rate limited · resets 5:10am (Australia/Sydney)", { error: 'rate_limit', window }, null],
  ]) assert.equal(claudeFailure(message, facts).message, said ?? message, message);
});

const unavailable = (message, facts, rest = {}) => {
  const failure = claudeFailure(message, facts).data?._meta.coda.failure;
  assert.equal(agentValueProblem('failure.json', failure), null, message);
  assert.deepEqual(failure, { kind: 'service_unavailable', input: 'accepted', ...rest }, message);
};

test('network failures and the upstream failing are service_unavailable, the input taken by the native session', () => {
  // Real: the synthetic assistant message of a dropped connection (category server_error, rate_limit or none), from Claude Code's transcripts.
  const dropped = 'API Error: Connection dropped (ECONNRESET). A VPN, firewall, or security software can cause this. Check those or switch networks, then try again.';
  for (const facts of [{ error: 'server_error' }, { error: 'rate_limit' }, {}]) unavailable(dropped, facts);
  // The network, by its codes and by what Claude Code and Node say.
  for (const message of ['API Error: Unable to connect to API (ECONNREFUSED)', 'Unable to connect to API. Check your internet connection',
    'API Error: ETIMEDOUT', 'getaddrinfo ENOTFOUND api.anthropic.com', 'getaddrinfo EAI_AGAIN api.anthropic.com', 'request to https://api.anthropic.com failed, reason: socket hang up',
    'TypeError: fetch failed', 'Client network socket disconnected before secure TLS connection was established; TLS handshake failed',
    'write EPROTO ssl/tls handshake failure', 'terminated: other side closed', 'Premature close', 'Request timed out', 'API Error: Request timed out.'])
    unavailable(message, {});
  // The service: 5xx, overloaded, 529 (Claude Code says it so when its retries ended on it).
  for (const message of ['API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}', 'API Error: 502 Bad Gateway',
    'API Error: 503 Service Unavailable', 'API Error: 504 Gateway Timeout', 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    'Repeated 529 Overloaded errors', 'HTTP 503', 'API Error: 408 Request Timeout'])
    unavailable(message, {});
  unavailable('Overloaded', { error: 'overloaded' });
  unavailable('The server hit an error', { error: 'server_error' });
});

test('a Cloudflare page is service_unavailable whatever the status and category, not an authentication failure', () => {
  // Real: Claude Code took the 403 page of Cloudflare for an authentication failure (11-13).
  unavailable('Failed to authenticate. API Error: 403 Attention Required! | Cloudflare', { error: 'authentication_failed' });
  unavailable('API Error: 403 <!DOCTYPE html><html><head><title>Just a moment...</title></head><body>cf-ray: 8f1a2b3c4d5e6f7a-SIN</body></html>', {});
  unavailable('API Error: 503 <html><title>Attention Required! | Cloudflare</title>', { error: 'invalid_request' });
  unavailable('HTTP 403 Forbidden: Sorry, you have been blocked. Cloudflare Ray ID: 8f1a2b3c4d5e6f7a', {});
});

test('the wait the service asked for is retryAfterMs, in ms', () => {
  unavailable('API Error: 503 Service Unavailable. Retry-After: 30', {}, { retryAfterMs: 30000 });
  unavailable('API Error: 529 overloaded_error, retry after 12 seconds', {}, { retryAfterMs: 12000 });
  unavailable('API Error: 503 retry-after-ms: 1500', {}, { retryAfterMs: 1500 });
  unavailable('API Error: 503 retry after 250 ms', {}, { retryAfterMs: 250 });
  unavailable('API Error: 503 Service Unavailable', {});
});

test('what is not the service failing stays unmarked: keys, permission, context, billing, parameters, certificates, quota', () => {
  for (const [message, facts] of [
    ['API Error: 401 Invalid API key · Please run /login', { error: 'authentication_failed' }],
    ['API Error: 403 {"type":"error","error":{"type":"permission_error","message":"Your API key does not have permission to use the specified resource."}}', {}],
    ['API Error: 403 Forbidden', { error: 'authentication_failed' }],
    ['Prompt is too long', { error: 'invalid_request' }],
    ['API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 213000 tokens > 200000 maximum"}}', { error: 'invalid_request' }],
    ['API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: 99999 > 64000"}}', {}],
    ['API Error: 404 model: claude-nope', { error: 'model_not_found' }],
    ['Claude\'s response exceeded the 32000 output token maximum', { error: 'max_output_tokens' }],
    ['Payment method declined', { error: 'billing_error' }],
    ['API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}', { error: 'rate_limit' }],
    ['API Error: Output blocked by content filtering policy', { error: 'unknown' }],
    ['API Error: Request was aborted.', {}],
    ['Unable to connect to API: SSL certificate has expired', {}],
    ['Unable to connect to API: SSL certificate hostname mismatch', {}],
    ['MCP error -32000: Connection closed', {}],
    // A failure the category says is not the service's, even with network words in its text.
    ['Invalid API key (fetch failed to reach the key helper)', { error: 'authentication_failed' }],
  ]) assert.equal(claudeFailure(message, facts).data, undefined, message);
  // Usage and credit exhaustion stay quota, never the service's.
  for (const [message, facts] of [["You've hit your session limit · resets 1am (Asia/Singapore)", { error: 'rate_limit' }],
    ['Your credit balance is too low to access the Anthropic API', { error: 'billing_error' }]])
    assert.deepEqual(claudeFailure(message, facts).data._meta.coda.failure, { kind: 'quota_exhausted' }, message);
});

test('an OAuth login that is gone is auth_required; a bad key, missing permission or a bare 401 or 403 is not', () => {
  // Protocol 6.2.0 is not published, so the installed validation rejects auth_required: the shape is asserted here. After 6.2.0 is
  // published and check/coda/contract.json synced, check it with agentValueProblem('failure.json', failure) as the other kinds are.
  // Real: the final error of a Claude Code turn whose OAuth session ended (11-13).
  for (const [message, facts] of [
    ['Failed to authenticate: OAuth session expired and could not be refreshed', { error: 'authentication_failed' }],
    ['Failed to authenticate: OAuth session expired and could not be refreshed', {}],
  ]) {
    const error = claudeFailure(message, facts);
    assert.equal(error.code, -32603);
    assert.equal(error.message, message);
    assert.deepEqual(error.data._meta.coda.failure, { kind: 'auth_required', login: 'Anthropic OAuth' }, message);
  }
  for (const [message, facts] of [
    ['API Error: 401 Invalid API key · Please run /login', { error: 'authentication_failed' }],
    ['Invalid API key', { error: 'authentication_failed' }],
    ['API Error: 403 {"type":"error","error":{"type":"permission_error","message":"Your API key does not have permission to use the specified resource."}}', { error: 'authentication_failed' }],
    ['API Error: 401 Unauthorized', { error: 'authentication_failed' }],
    ['API Error: 403 Forbidden', { error: 'authentication_failed' }],
    ['Failed to authenticate. API Error: 403 Attention Required! | Cloudflare', { error: 'authentication_failed' }],
    ['API Error: 403 <html><title>Just a moment...</title>cf-ray: 8f1a2b3c4d5e6f7a-SIN</html>', {}],
    ['OAuth session expired and could not be refreshed', { error: 'billing_error' }],
    ['API Error: 401 OAuth token has expired. Please obtain a new token or refresh your existing token.', { error: 'authentication_failed' }],
  ]) assert.notEqual(claudeFailure(message, facts).data?._meta.coda.failure.kind, 'auth_required', message);
  // The Cloudflare page stays service_unavailable.
  assert.equal(claudeFailure('Failed to authenticate. API Error: 403 Attention Required! | Cloudflare', { error: 'authentication_failed' }).data._meta.coda.failure.kind, 'service_unavailable');
});
