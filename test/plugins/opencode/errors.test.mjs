import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyOpenCodeError } from '../../../plugins/opencode/agent/errors.mjs';

// OpenCode 2.1.4 answers a failed prompt with `Internal error: <safeMessage>` and `data: { service, errorName }`, errorName being its
// own classification of the provider's response. The messages are those of real turns of the preview instance that failed on them.
const reply = (errorName, text, data = {}) => ({ jsonrpc: '2.0', id: 9, error: { code: -32603, message: `Internal error: ${text}`, data: { service: 'session', errorName, ...data } } });
const failureOf = message => classifyOpenCodeError(message).error?.data?._meta?.coda?.failure;
const ZEN = 'macmini2 Zen: OpenCode Zen: Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go';
const WORKBUDDY = 'WorkBuddy AI: Credits exhausted. Please visit the link below to purchase add-on packs and get more credits: https://www.codebuddy.ai/profile/usage  — WorkBuddy requires an active credit package even for 0-rate free models; check your account package balance';
const WORKBUDDY_CN = 'rig Magpie: WorkBuddy: 额度已用尽，请访问以下链接，购买加量包以获取更多额度：https://www.codebuddy.cn/profile/usage';

test('a failed prompt whose quota is used up is quota exhaustion, by OpenCode\'s own type or by the service\'s wording on a rate limit', () => {
  const quota = { kind: 'quota_exhausted' };
  assert.deepEqual(failureOf(reply('provider.free-limit', 'Free usage limit reached. Connect a provider or subscribe to OpenCode Go to keep going, or switch models.')), quota);
  assert.deepEqual(failureOf(reply('provider.quota', 'Quota exceeded')), quota);
  for (const text of [ZEN, WORKBUDDY, WORKBUDDY_CN, 'WorkBuddy: 用量已超出限制，将在 2026-10-24 17:42:38 重置'])
    for (const type of ['provider.rate-limit', 'provider.internal']) assert.deepEqual(failureOf(reply(type, text)), quota);
  const classified = classifyOpenCodeError(reply('provider.free-limit', ZEN, { extra: 1, _meta: { trace: 'kept', coda: { other: true } } }));
  assert.deepEqual(classified.error.data, { service: 'session', errorName: 'provider.free-limit', extra: 1, _meta: { trace: 'kept', coda: { other: true, failure: quota } } });
  assert.equal(classified.error.message, `Internal error: ${ZEN}`);
});

test('an upstream fault OpenCode already retried is a service failure; other failures carry no category', () => {
  assert.deepEqual(failureOf(reply('provider.internal', 'Upstream request failed: Bad Gateway')), { kind: 'service_unavailable', input: 'accepted' });
  for (const [type, text] of [['provider.rate-limit', 'Too Many Requests'], ['provider.rate-limit', 'Rate limit reached'],
    ['provider.auth', ZEN], ['provider.content-filter', WORKBUDDY], ['provider.invalid-request', 'context_length_exceeded'],
    ['provider.invalid-request', WORKBUDDY], ['provider.transport', 'dial tcp 100.124.1.28:3425: connect: connection refused'],
    ['provider.timeout', 'Timeout'], ['provider.unknown', 'unknown provider for model gemini-pro-agent'], ['provider.no-route', ZEN], ['ServerUnavailable', ZEN],
    ['provider.invalid-output', 'Invalid coda-models.s-magpie-openai-4795cd5415/openai-compatible stream event']]) {
    const message = reply(type, text);
    assert.equal(classifyOpenCodeError(message), message, `${type}: ${text}`);
  }
});

test('only an error with an OpenCode type is read; answers, other codes and an already categorised failure pass unchanged', () => {
  const ok = { jsonrpc: '2.0', id: 1, result: { stopReason: 'end_turn' } };
  const failed = { jsonrpc: '2.0', id: 2, error: { code: -32603, message: 'Internal error: Free usage limit reached', data: { service: 'session' } } };
  const wrongCode = { jsonrpc: '2.0', id: 3, error: { code: -32602, message: 'Invalid params', data: { errorName: 'provider.quota' } } };
  const own = { jsonrpc: '2.0', id: 4, error: { code: -32603, message: 'x', data: { errorName: 'provider.quota', _meta: { coda: { failure: { kind: 'service_unavailable', input: 'accepted', retryAfterMs: 1 } } } } } };
  const bare = { jsonrpc: '2.0', id: 5, error: { code: -32603, message: 'Internal error' } };
  for (const message of [ok, failed, wrongCode, own, bare, { method: 'session/update' }, null]) assert.equal(classifyOpenCodeError(message), message);
});
