import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeFailure } from '../../../plugins/claude/agent/errors.mjs';

test('explicit Claude usage or credit exhaustion is quota; authentication, billing problems and generic rate limits are not', () => {
  for (const message of ["You've hit your session limit · resets 1am (Asia/Singapore)", "You've reached your weekly limit",
    'Your credit balance is too low to access the Anthropic API.', "You're out of usage credits", "You're out of extra usage",
    'Your org is out of usage · contact your admin']) {
    const error = claudeFailure(message);
    assert.equal(error.message, message);
    assert.equal(error.data._meta.coda.failure.kind, 'quota_exhausted');
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
