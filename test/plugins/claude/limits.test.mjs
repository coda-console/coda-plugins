// The claude plugin's limits (agent/limits.mjs): the windows a rate_limit_event carries, as `_coda/quota` tells them, and the
// account they are of; and the「Claude」resource record, which carries only the way to sign in (scripts/resource.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resourceRecordsProblem } from '@coda-console/protocol/validate';
import { accountHash, quotaWindows } from '../../../plugins/claude/agent/limits.mjs';

const at = iso => Date.parse(iso) / 1000;
const event = { status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.91, resetsAt: at('2026-10-12T00:00:00Z'),
  unifiedWindows: { five_hour: { utilization: 0.11, resetsAt: at('2026-10-08T03:00:00Z') }, seven_day: { utilization: 0.91, resetsAt: at('2026-10-12T00:00:00Z') } } };

test('every window an event carries is told with its label, the fraction used and its reset as a UTC time', () => {
  assert.deepEqual(quotaWindows(event), [
    { id: 'five_hour', label: '5 小时', usedFraction: 0.11, resetsAt: '2026-10-08T03:00:00.000Z' },
    { id: 'seven_day', label: '7 天', usedFraction: 0.91, resetsAt: '2026-10-12T00:00:00.000Z' },
  ]);
});

test('a CLI that sends only the window that limits now says only that one; where both levels name a window, the one that carries every window is read', () => {
  assert.deepEqual(quotaWindows({ status: 'allowed_warning', rateLimitType: 'seven_day_sonnet', utilization: 0.4, resetsAt: at('2026-10-11T00:00:00Z') }),
    [{ id: 'seven_day_sonnet', label: 'Sonnet · 7 天', usedFraction: 0.4, resetsAt: '2026-10-11T00:00:00.000Z' }]);
  const resetsAt = at('2026-10-12T00:00:00Z');
  assert.deepEqual(quotaWindows({ rateLimitType: 'seven_day', utilization: 0.5, resetsAt, unifiedWindows: { seven_day: { utilization: 0.6, resetsAt } } }).map(w => w.usedFraction), [0.6]);
});

test('a window used past its cap is told as used in full; the labels are the plugin\'s', () => {
  const resetsAt = at('2026-10-12T00:00:00Z');
  const windows = quotaWindows({ status: 'rejected', rateLimitType: 'seven_day_overage_included', utilization: 1, resetsAt,
    unifiedWindows: { five_hour: { utilization: 1.35, resetsAt }, seven_day_opus: { utilization: 0, resetsAt } } });
  assert.deepEqual(windows.map(w => [w.id, w.label, w.usedFraction]),
    [['five_hour', '5 小时', 1], ['seven_day_opus', 'Opus · 7 天', 0], ['seven_day_overage_included', 'Fable · 7 天', 1]]);
});

test('what is not a known window with a used fraction and an epoch reset is not told', () => {
  const resetsAt = at('2026-10-12T00:00:00Z');
  for (const info of [undefined, null, 'seven_day', [], {}, { status: 'allowed' }, { rateLimitType: 'overage', utilization: 0.5, resetsAt },
    { rateLimitType: 'seven_day', utilization: '0.5', resetsAt }, { rateLimitType: 'seven_day', utilization: -0.1, resetsAt },
    { rateLimitType: 'seven_day', utilization: NaN, resetsAt }, { rateLimitType: 'seven_day', utilization: Infinity, resetsAt },
    { rateLimitType: 'seven_day', utilization: 0.5 }, { rateLimitType: 'seven_day', utilization: 0.5, resetsAt: 0 },
    { rateLimitType: 'seven_day', utilization: 0.5, resetsAt: 1.5 }, { rateLimitType: 'seven_day', utilization: 0.5, resetsAt: '1791784800' },
    { unifiedWindows: 'five_hour' }, { unifiedWindows: [{ utilization: 0.5, resetsAt }] }, { unifiedWindows: { five_hour: null, seven_day: 'x', weekly: { utilization: 0.5, resetsAt } } },
    { unifiedWindows: JSON.parse('{"__proto__": {"utilization": 0.5, "resetsAt": 1791784800}}') }]) {
    assert.deepEqual(quotaWindows(info), [], JSON.stringify(info));
  }
  // The valid ones among invalid are kept.
  assert.deepEqual(quotaWindows({ unifiedWindows: { five_hour: { utilization: 0.2, resetsAt }, seven_day: null, weekly: { utilization: 0.5, resetsAt } } }).map(w => w.id), ['five_hour']);
});

test('the account is a hash of its normalized email, 32 hex digits, and not the email', () => {
  assert.match(accountHash(' Me@Example.com '), /^[0-9a-f]{32}$/);
  assert.equal(accountHash(' Me@Example.com '), accountHash('me@example.com'));
  assert.notEqual(accountHash('me@example.com'), accountHash('other@example.com'));
});

test('the「Claude」record carries only the way to sign in, which the host takes', () => {
  const record = JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL('../../../plugins/claude/scripts/resource.mjs', import.meta.url))], { encoding: 'utf8' }));
  assert.equal(record.length, 1);
  assert.deepEqual([record[0].key, record[0].spec.type, record[0].spec.title, record[0].spec.resources], ['limits', 'limits', 'Claude', []]);
  assert.equal(record[0].spec.signIn.input, 'authorizationCode');
  assert.equal(resourceRecordsProblem(record), null);
});
