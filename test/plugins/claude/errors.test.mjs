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
