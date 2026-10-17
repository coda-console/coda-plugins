// From Coda's backend/test/claude-limits.test.mjs at 9ffb9911, as plain node:test. Its case of Coda moving the limits kept
// before the update into the plugin's state stays in Coda.
// The claude plugin's limits (agent/limits.mjs): what the SDK's rate_limit_event says of each window, kept across restarts,
// and the「Claude」panel that shows them (scripts/quota.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { panelItems } from '../../../check/panel.mjs';
import { ClaudeSessionLimits, accountHash } from '../../../plugins/claude/agent/limits.mjs';
import { panel } from '../../../plugins/claude/scripts/quota.mjs';
import { declaredPanel } from '../command.mjs';

const NOW = Date.parse('2026-10-08T00:00:00Z');
const at = iso => Date.parse(iso) / 1000;
async function root(t) { const dir = await mkdtemp(join(tmpdir(), 'coda-limits-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
const event = { status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.91, resetsAt: at('2026-10-12T00:00:00Z'),
  unifiedWindows: { five_hour: { utilization: 0.11, resetsAt: at('2026-10-08T03:00:00Z') }, seven_day: { utilization: 0.91, resetsAt: at('2026-10-12T00:00:00Z') } } };

test('every window an event carries is the quota of the account, as what is left and when it resets', () => {
  const limits = new ClaudeSessionLimits({ now: () => NOW });
  assert.equal(limits.known(), false);
  limits.observe(event);
  assert.equal(limits.known(), true);
  assert.deepEqual(limits.quota(), [
    { id: 'five_hour', label: '5 小时', remainingPercent: 89, resetsAt: '2026-10-08T03:00:00.000Z' },
    { id: 'seven_day', label: '7 天', remainingPercent: 9, resetsAt: '2026-10-12T00:00:00.000Z' },
  ]);
});

test('a CLI that sends only the window that limits now still says where that one stands; the windows it does not repeat are kept', () => {
  const limits = new ClaudeSessionLimits({ now: () => NOW });
  limits.observe(event);
  limits.observe({ status: 'allowed_warning', rateLimitType: 'seven_day_sonnet', utilization: 0.4, resetsAt: at('2026-10-11T00:00:00Z') });
  limits.observe({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.2, resetsAt: at('2026-10-08T03:00:00Z') });
  assert.deepEqual(limits.quota().map(w => [w.id, w.label, w.remainingPercent]),
    [['five_hour', '5 小时', 80], ['seven_day', '7 天', 9], ['seven_day_sonnet', 'Sonnet · 7 天', 60]]);
  // Where both levels name a window, the one that carries every window is the one read.
  limits.observe({ status: 'allowed', rateLimitType: 'seven_day', utilization: 0.5, resetsAt: at('2026-10-12T00:00:00Z'),
    unifiedWindows: { seven_day: { utilization: 0.6, resetsAt: at('2026-10-12T00:00:00Z') } } });
  assert.equal(limits.quota().find(w => w.id === 'seven_day').remainingPercent, 40);
});

test('the windows come in a fixed order, and one used past its cap has nothing left', () => {
  const limits = new ClaudeSessionLimits({ now: () => NOW });
  const resetsAt = at('2026-10-12T00:00:00Z');
  limits.observe({ status: 'rejected', rateLimitType: 'seven_day_overage_included', utilization: 1, resetsAt,
    unifiedWindows: { seven_day: { utilization: 0.57, resetsAt }, five_hour: { utilization: 1.35, resetsAt: at('2026-10-08T03:00:00Z') } } });
  limits.observe({ status: 'allowed', rateLimitType: 'seven_day_opus', utilization: 0, resetsAt });
  assert.deepEqual(limits.quota().map(w => [w.label, w.remainingPercent]),
    [['5 小时', 0], ['7 天', 43], ['Opus · 7 天', 100], ['Fable · 7 天', 0]]);
});

test('what is not a window with a used fraction and an epoch reset is not taken', () => {
  const limits = new ClaudeSessionLimits({ now: () => NOW });
  const resetsAt = at('2026-10-12T00:00:00Z');
  for (const info of [undefined, null, 'seven_day', [], {}, { status: 'allowed' }, { rateLimitType: 'overage', utilization: 0.5, resetsAt },
    { rateLimitType: 'seven_day', utilization: '0.5', resetsAt }, { rateLimitType: 'seven_day', utilization: -0.1, resetsAt },
    { rateLimitType: 'seven_day', utilization: NaN, resetsAt }, { rateLimitType: 'seven_day', utilization: Infinity, resetsAt },
    { rateLimitType: 'seven_day', utilization: 0.5 }, { rateLimitType: 'seven_day', utilization: 0.5, resetsAt: 0 },
    { rateLimitType: 'seven_day', utilization: 0.5, resetsAt: 1.5 }, { rateLimitType: 'seven_day', utilization: 0.5, resetsAt: '1791784800' },
    { unifiedWindows: 'five_hour' }, { unifiedWindows: [{ utilization: 0.5, resetsAt }] }, { unifiedWindows: { five_hour: null, seven_day: 'x', weekly: { utilization: 0.5, resetsAt } } },
    { unifiedWindows: JSON.parse('{"__proto__": {"utilization": 0.5, "resetsAt": 1791784800}}') }]) {
    limits.observe(info);
    assert.equal(limits.known(), false, JSON.stringify(info));
  }
  assert.deepEqual(limits.quota(), []);
});

test('a window past its reset is no longer known, and all of them past it is said so', () => {
  let now = NOW;
  const limits = new ClaudeSessionLimits({ now: () => now });
  limits.observe(event);
  now = Date.parse('2026-10-08T03:00:00Z');
  assert.deepEqual(limits.quota().map(w => w.id), ['seven_day'], 'the reset moment itself is past');
  now = Date.parse('2026-10-12T00:00:01Z');
  assert.deepEqual(limits.quota(), [], 'all past: known, but none to show');
  assert.equal(limits.known(), true);
  limits.observe({ rateLimitType: 'five_hour', utilization: 0.02, resetsAt: at('2026-10-12T05:00:00Z') });
  assert.deepEqual(limits.quota().map(w => [w.id, w.remainingPercent]), [['five_hour', 98]]);
});

test('the windows are kept across a restart, written only as one moves, and a file that cannot be read starts empty', async t => {
  const dir = await root(t), path = join(dir, 'claude-session-limits.json');
  const limits = new ClaudeSessionLimits({ path, now: () => NOW });
  limits.observe(event);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(new ClaudeSessionLimits({ path, now: () => NOW }).quota(), limits.quota());
  // The same percentage and reset again is nothing new; a percentage or a reset that moved is.
  await rm(path);
  limits.observe({ ...event, unifiedWindows: { five_hour: { utilization: 0.114, resetsAt: at('2026-10-08T03:00:00Z') }, seven_day: event.unifiedWindows.seven_day } });
  await assert.rejects(stat(path), { code: 'ENOENT' });
  limits.observe({ ...event, unifiedWindows: { ...event.unifiedWindows, five_hour: { utilization: 0.12, resetsAt: at('2026-10-08T03:00:00Z') } } });
  assert.equal(JSON.parse(await readFile(path, 'utf8')).windows.five_hour.utilization, 0.12);
  limits.observe({ ...event, unifiedWindows: { ...event.unifiedWindows, five_hour: { utilization: 0.01, resetsAt: at('2026-10-08T08:00:00Z') } } });
  assert.equal(JSON.parse(await readFile(path, 'utf8')).windows.five_hour.resetsAt, at('2026-10-08T08:00:00Z'));
  for (const content of ['not json', '{}', '{"windows":null}', '[]', '{"windows":{"five_hour":null,"seven_day":{"utilization":"x","resetsAt":1},"weekly":{"utilization":0.5,"resetsAt":1791784800}}}']) {
    await writeFile(path, content);
    assert.equal(new ClaudeSessionLimits({ path, now: () => NOW }).known(), false, content);
  }
  // Without a place to keep them, or with none that can be written, what is observed is still shown.
  for (const unwritable of [null, join(dir, 'missing', 'limits.json')]) {
    const kept = new ClaudeSessionLimits({ path: unwritable, now: () => NOW }); kept.observe(event);
    assert.equal(kept.quota().length, 2);
  }
});

test('the「Claude」panel shows what the sessions reported, says when it all has passed, and nothing before anything was', async t => {
  const dir = await root(t), path = join(dir, 'limits.json'), declared = declaredPanel('claude');
  let now = NOW;
  const limits = () => new ClaudeSessionLimits({ path, now: () => now });
  assert.deepEqual(panel(limits()), { items: [] }, 'nothing reported: offered under「添加资源」 instead');
  limits().observe(event);
  const { items } = panel(limits());
  assert.deepEqual(items, [{ type: 'card', title: 'Claude SDK', items: [
    { type: 'meter', label: '5 小时', value: '剩余 89%', fraction: 0.89, time: '2026-10-08T03:00:00.000Z', timeLabel: '重置' },
    { type: 'meter', label: '7 天', value: '剩余 9%', fraction: 0.09, time: '2026-10-12T00:00:00.000Z', timeLabel: '重置' },
  ] }]);
  assert.deepEqual(panelItems(JSON.stringify({ items }), declared), ['card', 'meter', 'meter'], 'a reading Coda takes');
  now = Date.parse('2026-10-13T00:00:00Z');
  assert.deepEqual(panel(limits()).items[0].items, [{ type: 'error', text: '额度记录已过期，会话再运行后更新' }]);
});

test('the account the latest session starts as names the card, as a hash; what another account reports is not its', async t => {
  const dir = await root(t), path = join(dir, 'limits.json'), declared = declaredPanel('claude');
  const limits = () => new ClaudeSessionLimits({ path, now: () => NOW });
  const a = accountHash(' Me@Example.com '), b = accountHash('other@example.com');
  limits().observe(event);
  assert.equal(panel(limits()).items[0].identity, undefined, 'no session said who it is: the card is this machine\'s alone');
  limits().startedAs(a);
  assert.equal(limits().known(), false, 'what was reported before is not known to be this account\'s');
  limits().observe(event, a);
  const { items } = panel(limits());
  assert.equal(items[0].identity, `claude:${accountHash('me@example.com')}`);
  assert.ok(!(await readFile(path, 'utf8')).includes('example.com'), 'the email itself is not kept');
  assert.deepEqual(panelItems(JSON.stringify({ items }), declared), ['card', 'meter', 'meter'], 'a reading Coda takes');
  // Another account's session starts while one of the first is still running: what the older one reports is not B's.
  limits().startedAs(b);
  limits().observe(event, a);
  assert.equal(limits().known(), false);
  limits().observe({ rateLimitType: 'five_hour', utilization: 0.2, resetsAt: at('2026-10-08T03:00:00Z') }, b);
  assert.deepEqual(panel(limits()).items[0].items.map(i => i.value), ['剩余 80%']);
  assert.equal(panel(limits()).items[0].identity, `claude:${b}`);
  // A session that cannot say who it is names no one, and its windows are not filed under the account before.
  limits().startedAs(null);
  limits().observe(event);
  assert.equal(panel(limits()).items[0].identity, undefined);
  assert.equal(limits().quota().length, 2);
});
