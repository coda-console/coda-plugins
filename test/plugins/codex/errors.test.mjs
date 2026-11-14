import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentProcess } from '../../../check/process.mjs';
import { pluginDir, resolveFrom } from '../plugin.mjs';
import { explainCodexError, codexFailureData, reportedCodexFailures } from '../../../plugins/codex/agent/errors.mjs';

const fixture = fileURLToPath(new URL('./app-server-fixture.mjs', import.meta.url));
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

test('native service failures expose facts; quota, authentication and bad requests never inherit Internal error retryability', () => {
  const classify = (info, message = 'Internal error') => codexFailureData({ code: -32603, message: 'Internal error',
    data: { codexErrorInfo: info, message } }, 'accepted')._meta?.coda?.failure;
  for (const info of ['internalServerError', 'serverOverloaded', { responseStreamDisconnected: { httpStatusCode: 502 } },
    { responseTooManyFailedAttempts: { httpStatusCode: null } }]) assert.deepEqual(classify(info), { kind: 'service_unavailable', input: 'accepted' });
  assert.deepEqual(classify('usageLimitExceeded'), { kind: 'quota_exhausted' });
  for (const info of ['unauthorized', 'contextWindowExceeded', 'sessionBudgetExceeded', 'badRequest',
    'sandboxError', 'threadRollbackFailed', 'cyberPolicy', { httpConnectionFailed: { httpStatusCode: 401 } }]) assert.equal(classify(info), undefined);
  assert.equal(codexFailureData({ code: -32603, message: 'Internal error', data: 'Usage limit reached' }, 'not_accepted')._meta, undefined);
  assert.deepEqual(codexFailureData({ code: -32603, message: 'Internal error' }, 'not_accepted')._meta.coda.failure,
    { kind: 'service_unavailable', input: 'not_accepted' });
});

// Codex's refresh failures, from the strings of its binary (RefreshTokenFailedReason). Protocol 6.2.0 is not published, so the installed
// validation rejects auth_required: the shape is asserted here. After 6.2.0 is published and check/coda/contract.json synced, check it
// with agentValueProblem('failure.json', failure) as the other kinds are.
test('a ChatGPT login whose token cannot be refreshed is auth_required; a bad key, a bare 401 or 403 and Cloudflare are not', () => {
  const classify = (message, info = 'unauthorized', where = 'message') => codexFailureData({ code: -32603, message: 'Internal error',
    data: { codexErrorInfo: info, [where]: message } }, 'accepted');
  for (const message of ['Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.',
    'Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.',
    'Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.',
    'Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again.',
    'Your access token could not be refreshed. Please log out and sign in again.']) {
    for (const where of ['message', 'details']) {
      const data = classify(message, 'unauthorized', where);
      assert.deepEqual(data._meta.coda.failure, { kind: 'auth_required', login: 'ChatGPT 账号' }, message);
      assert.equal(data[where], message);
    }
  }
  const opaque = codexFailureData({ code: -32603, message: 'Internal error', data: 'Your access token could not be refreshed. Please log out and sign in again.' }, 'accepted');
  assert.equal(opaque._meta.coda.failure.kind, 'auth_required');
  for (const [message, info] of [['Incorrect API key provided: sk-xxxx', 'unauthorized'], ['unexpected status 401 Unauthorized: Missing bearer or basic authentication in header', 'unauthorized'],
    ['unexpected status 403 Forbidden: You do not have access to this model', 'unauthorized'], ['Unauthorized', 'unauthorized'],
    ['unexpected status 403 Forbidden: <html><title>Just a moment...</title>cf-ray: 8f1a2b3c4d5e6f7a-SIN</html>', { httpConnectionFailed: { httpStatusCode: 403 } }],
    ['{"status":401,"error":{"message":"Invalid API key"}}', { httpConnectionFailed: { httpStatusCode: 401 } }],
    ['Failed to refresh token: connection reset', 'other']])
    assert.equal(classify(message, info)._meta?.coda?.failure, undefined, message);
});

test('the native error patch is tied to the locked adapter', async () => {
  const source = await readFile(resolveFrom('codex', '@agentclientprotocol/codex-acp'), 'utf8');
  assert.match(reportedCodexFailures(source), /codexFailureData/);
  assert.throws(() => reportedCodexFailures(source.replace('  async handleFailedTurn(turn) {', 'changed() {')), /no longer matches/);
});

test('error adaptation preserves the response identity, code and data and only uses textual explanations once', () => {
  const reply = { jsonrpc: '2.0', id: 'prompt-1', error: { code: -32603, message: 'Internal error',
    data: { message: '  请求失败  ', details: '请求失败', context: { diagnostic: 'not user-facing' } } } };
  const explained = explainCodexError(reply);
  assert.deepEqual(explained, { ...reply, error: { ...reply.error, message: 'Internal error\n\n请求失败' } });
  assert.equal(explainCodexError(explained), explained);
  assert.equal(reply.error.message, 'Internal error');
  for (const unchanged of [
    { jsonrpc: '2.0', id: 'ok', result: { stopReason: 'end_turn' } },
    { jsonrpc: '2.0', method: 'session/update', params: { text: 'Internal error' } },
    { jsonrpc: '2.0', id: 'bad', error: { code: -32602, message: 'Invalid params', data: { message: {}, details: ['diagnostic'], field: 'test' } } },
  ]) assert.equal(explainCodexError(unchanged), unchanged);
});

// A plain ACP client only needs error.message. Exercise the locked adapter's actual data.message, data.details and
// string data failures through the plugin entry, including the failure before a session exists.
for (const [method, reason, env] of [
  ['session/prompt', "model 'gpt-6.1-sol' is not enabled in rustponsesapi", { FAKE_CODEX_MODEL_ERROR: 'usageLimitExceeded' }],
  ['session/prompt', 'Account source unavailable before starting the turn', { FAKE_CODEX_RPC_ERROR_METHOD: 'turn/start' }],
  ['session/new', 'Failed to load config: invalid test configuration', { FAKE_CODEX_RPC_ERROR_METHOD: 'thread/start' }],
]) test(`Codex entry puts ${env.FAKE_CODEX_RPC_ERROR_METHOD ?? 'model-service'} failures in ACP error.message`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'codex-errors-')), codex = join(root, 'codex');
  await writeFile(codex, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} "$@"\n`);
  await chmod(codex, 0o700);
  const peer = new AgentProcess({ command: `exec ${quote(process.execPath)} ${quote(join(pluginDir('codex'), 'agent/entry.mjs'))}`, cwd: root,
    env: { ...process.env, ...env, FAKE_CODEX_RPC_ERROR: reason, FAKE_CODEX_STATE: root, CODEX_PATH: codex, CODEX_HOME: join(root, 'home') } });
  t.after(async () => { await peer.terminate(2000); peer.kill(); await rm(root, { recursive: true, force: true }); });
  const request = (method, params) => peer.request(method, params, { timeout: 10_000 });
  const init = await request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  assert.equal(init.error, undefined);
  const session = await request('session/new', { cwd: root, mcpServers: [] });
  if (method === 'session/prompt') assert.equal(session.error, undefined);
  const reply = method === 'session/new' ? session : await request(method, { sessionId: session.result.sessionId, prompt: [{ type: 'text', text: 'original task' }] });
  assert.equal(reply.error?.code, -32603);
  assert.ok(reply.error.message.includes(reason), reply.error.message);
  if (method === 'session/new') assert.ok(reply.error.message.includes('Check '), reply.error.message);
  if (env.FAKE_CODEX_RPC_ERROR_METHOD === 'turn/start') {
    const again = await request(method, { sessionId: session.result.sessionId, prompt: [{ type: 'text', text: 'continue' }] });
    assert.equal(again.result?.stopReason, 'end_turn', JSON.stringify(again));
  }
});

for (const [name, env, input] of [
  ['native internal server error', { FAKE_CODEX_MODEL_ERROR: 'internalServerError', FAKE_CODEX_MODEL_MESSAGE: 'Internal error' }, 'accepted'],
  ['native stream failure', { FAKE_CODEX_MODEL_ERROR: JSON.stringify({ responseStreamDisconnected: { httpStatusCode: 500 } }), FAKE_CODEX_MODEL_MESSAGE: 'stream disconnected before completion' }, 'accepted'],
  ['model unavailable', { FAKE_CODEX_MODEL_ERROR: 'badRequest' }, 'accepted'],
  ['failed completion without an error notification', { FAKE_CODEX_MODEL_ERROR: 'internalServerError', FAKE_CODEX_MODEL_MESSAGE: 'Internal error', FAKE_CODEX_TERMINAL_ONLY: '1' }, 'accepted'],
  ['rejected turn start', { FAKE_CODEX_RPC_ERROR_METHOD: 'turn/start', FAKE_CODEX_RPC_ERROR: 'Internal error' }, 'not_accepted'],
  ['quota exhausted', { FAKE_CODEX_MODEL_ERROR: 'usageLimitExceeded' }, 'quota'],
  ['quota without an error notification', { FAKE_CODEX_MODEL_ERROR: 'usageLimitExceeded', FAKE_CODEX_TERMINAL_ONLY: '1' }, 'quota'],
  ['quota with reset', { FAKE_CODEX_MODEL_ERROR: 'usageLimitExceeded', FAKE_CODEX_MODEL_MESSAGE: 'Usage limit reached; try again at 2026-11-11T19:00:00Z' }, 'quota'],
  ['authentication failed', { FAKE_CODEX_MODEL_ERROR: 'unauthorized' }, null],
  ['login expired', { FAKE_CODEX_MODEL_ERROR: 'unauthorized', FAKE_CODEX_MODEL_MESSAGE: 'Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.' }, 'login'],
  ['invalid arguments', { FAKE_CODEX_MODEL_ERROR: 'badRequest', FAKE_CODEX_MODEL_MESSAGE: 'Invalid tool arguments' }, null],
]) test(`Codex reports ${name} for Coda to classify without retrying in the plugin`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'codex-service-')), codex = join(root, 'codex');
  await writeFile(codex, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} "$@"\n`); await chmod(codex, 0o700);
  const peer = new AgentProcess({ command: `exec ${quote(process.execPath)} ${quote(join(pluginDir('codex'), 'agent/entry.mjs'))}`, cwd: root,
    env: { ...process.env, ...env, FAKE_CODEX_STATE: root, CODEX_PATH: codex, CODEX_HOME: join(root, 'home') } });
  t.after(async () => { await peer.terminate(2000); peer.kill(); await rm(root, { recursive: true, force: true }); });
  const request = (method, params) => peer.request(method, params, { timeout: 10_000 });
  await request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  const session = await request('session/new', { cwd: root, mcpServers: [] });
  assert.equal(session.error, undefined);
  const reply = await request('session/prompt', { sessionId: session.result.sessionId, prompt: [{ type: 'text', text: 'original task' }] });
  assert.ok(reply.error, JSON.stringify(reply));
  const resetAt = env.FAKE_CODEX_MODEL_MESSAGE?.includes('2026-11-11') ? '2026-11-11T19:00:00.000Z' : null;
  assert.deepEqual(reply.error.data?._meta?.coda?.failure, input === 'quota' ?
    { kind: 'quota_exhausted', ...(resetAt ? { resetAt } : {}) } : input === 'login' ? { kind: 'auth_required', login: 'ChatGPT 账号' } : input ? { kind: 'service_unavailable', input } : undefined);
  if (resetAt) assert.match(reply.error.message, /try again at <t:2026-11-11T19:00:00Z>/);
  assert.equal((await readFile(join(root, 'prompts.ndjson'), 'utf8')).trim().split('\n').length, 1);
});

test('Codex quota reset comes only from the failed request, with no machine-time-zone guesses', () => {
  const seconds = Date.parse('2026-11-11T19:00:00Z') / 1000;
  for (const data of [
    { message: JSON.stringify({ error: { type: 'usage_limit_reached', resets_at: seconds } }) },
    { message: 'Quota exhausted', additionalDetails: JSON.stringify({ error: { resets_at: seconds } }) },
    { message: 'Usage limit reached; try again at 2026-11-11T19:00:00Z' },
  ]) {
    const error = { message: 'Internal error', data: { ...data, codexErrorInfo: 'usageLimitExceeded' } };
    const result = codexFailureData(error, 'accepted');
    assert.deepEqual(result._meta.coda.failure, { kind: 'quota_exhausted', resetAt: '2026-11-11T19:00:00.000Z' });
    assert.deepEqual(error.data, { ...data, codexErrorInfo: 'usageLimitExceeded' });
    const reply = { id: 1, error: { ...error, data: result } };
    const explained = explainCodexError(reply);
    assert.equal(explainCodexError(explained), explained);
  }
  for (const message of ['Quota exhausted', 'try again at 7pm', 'try again in 5 minutes', 'try again at 2026-13-11T19:00:00Z',
    'try again at 2026-02-30T19:00:00Z',
    JSON.stringify({ error: { resets_at: null } }), JSON.stringify({ error: { resets_at: -1 } })]) {
    const result = codexFailureData({ message: 'Internal error', data: { message, codexErrorInfo: 'usageLimitExceeded' } });
    assert.deepEqual(result._meta.coda.failure, { kind: 'quota_exhausted' });
  }
});

// Codex's HTTP failure message is `unexpected status <status>: <response body>, url: …` (its binary's format string); the bodies are
// OpenAI API's documented 429 responses: `insufficient_quota` ("You exceeded your current quota…") and `rate_limit_exceeded`.
test('a 429 Codex reports as an HTTP failure is quota only on the provider\'s own quota wording, otherwise a rate limit with its suggested wait', () => {
  const http = (status, body, extra = {}) => ({ code: -32603, message: 'Internal error', data: { codexErrorInfo: { httpConnectionFailed: { httpStatusCode: status } },
    message: `unexpected status ${status}: ${JSON.stringify(body)}, url: https://api.openai.com/v1/responses, request id: req_1`, ...extra } });
  const failure = (error, input = 'accepted') => codexFailureData(error, input)._meta?.coda?.failure;
  const quota = { error: { message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota', code: 'insufficient_quota' } };
  assert.deepEqual(failure(http(429, quota)), { kind: 'quota_exhausted' });
  assert.deepEqual(failure(http(429, { error: { type: 'usage_limit_reached', message: 'The usage limit has been reached', resets_at: Date.parse('2026-11-11T19:00:00Z') / 1000 } })),
    { kind: 'quota_exhausted', resetAt: '2026-11-11T19:00:00.000Z' });
  const limited = message => ({ error: { message, type: 'tokens', code: 'rate_limit_exceeded' } });
  assert.deepEqual(failure(http(429, limited('Rate limit reached for gpt-5 in organization org-x on tokens per min (TPM): Limit 30000. Please try again in 1m30.5s.'))),
    { kind: 'service_unavailable', input: 'accepted', retryAfterMs: 90_500 });
  assert.deepEqual(failure(http(429, limited('Rate limit reached. Please try again in 20ms.')), 'not_accepted'),
    { kind: 'service_unavailable', input: 'not_accepted', retryAfterMs: 20 });
  assert.deepEqual(failure(http(429, limited('Rate limit reached.'))), { kind: 'service_unavailable', input: 'accepted' });
  // The failure is also found in the other places the adapter puts its text, and the original error stays readable.
  const details = http(429, quota); details.data = { codexErrorInfo: details.data.codexErrorInfo, details: details.data.message };
  assert.deepEqual(failure(details), { kind: 'quota_exhausted' });
  const bare = http(429, limited('Rate limit reached.')); delete bare.data.message;
  assert.equal(codexFailureData(bare, 'accepted').details, 'Internal error');
  // Not a 429, not an HTTP failure, or an authentication error: unchanged.
  assert.equal(failure(http(400, quota)), undefined);
  assert.equal(failure(http(401, limited('Rate limit reached.'))), undefined);
  assert.equal(failure(http(403, quota)), undefined);
  assert.equal(failure(http(429, quota, { codexErrorInfo: 'badRequest' })), undefined);
});
