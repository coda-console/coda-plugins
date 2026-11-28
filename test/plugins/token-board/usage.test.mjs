// Token 消耗榜的纯逻辑：24 小时分片与截断二分、月块日归档与 48 小时曲线、person 切片、排行榜汇总与排序、当天曲线、跨记录无双计。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BUCKET_MS, DAY_MS, aggregateLeaderboard, aggregateTodayCurve, buildArchiveBodies, buildDailyUsageBodies, buildTodayBody, fetchUsageBuckets, filterBucketsByPerson,
  Tally, isWithdrawn, markSame, modelName, needsSame, ownBuckets, ownedBySource, rangeWindow, readArchiveRecord, readTodayRecord, serviceKind, settleTurns, summarizeBuckets, withdrawnBody,
} from '../../../plugins/token-board/lib/usage.mjs';

const bucket = (start, over = {}) => ({ start, agent: 'claude', model: 'opus', input: 10, output: 5, cacheRead: 100, cacheWrite: 1, turns: 2, reportedTurns: 2, ...over });
const DAY0 = Date.UTC(2026, 10, 1);
const A = `ed25519:${'a'.repeat(64)}`, B = `ed25519:${'b'.repeat(64)}`, C = `ed25519:${'c'.repeat(64)}`;

// 一个假的 usage 服务：按 limit 截断，和 coda/usage@1 一样最新的桶先给。
function service(all, { limit = 500 } = {}) {
  const calls = [];
  const query = async ({ from, to, limit: asked = 500 }) => {
    calls.push({ from, to, limit: asked });
    assert.ok(from <= to && to - from <= 90 * DAY_MS);
    assert.ok(asked >= 1 && asked <= 500);
    const rows = all.filter(b => b.start >= from && b.start < to).sort((x, y) => y.start - x.start);
    const cap = Math.min(asked, limit);
    return { buckets: rows.slice(0, cap), truncated: rows.length > cap };
  };
  return { query, calls };
}

test('7 天按 24 小时分片拉取，每次不超过 500 桶', async () => {
  const all = Array.from({ length: 7 * 24 }, (_, i) => bucket(DAY0 + i * 3_600_000));
  const { query, calls } = service(all);
  const { buckets, truncated } = await fetchUsageBuckets(query, { from: DAY0, to: DAY0 + 7 * DAY_MS });
  assert.equal(truncated, false);
  assert.equal(buckets.length, all.length);
  assert.equal(calls.length, 7);
  assert.deepEqual(calls.map(c => c.to - c.from), Array(7).fill(DAY_MS));
  assert.ok(buckets.every((b, i) => i === 0 || buckets[i - 1].start <= b.start));
});

test('最后一片不超出 to，空范围不查询', async () => {
  const { query, calls } = service([]);
  await fetchUsageBuckets(query, { from: DAY0, to: DAY0 + DAY_MS + 1000 });
  assert.deepEqual(calls.map(c => [c.from - DAY0, c.to - DAY0]), [[0, DAY_MS], [DAY_MS, DAY_MS + 1000]]);
  calls.length = 0;
  assert.deepEqual(await fetchUsageBuckets(query, { from: DAY0, to: DAY0 }), { buckets: [], truncated: false });
  assert.equal(calls.length, 0);
});

test('某片被截断就二分窗口，拉全且不重复', async () => {
  // 一天 144 个十分钟桶，每个 3 个 agent/model，服务一次最多给 100 条：必须二分。
  const all = [];
  for (let i = 0; i < 144; i++) for (const model of ['m1', 'm2', 'm3']) all.push(bucket(DAY0 + i * BUCKET_MS, { model }));
  const { query, calls } = service(all, { limit: 100 });
  const { buckets, truncated } = await fetchUsageBuckets(query, { from: DAY0, to: DAY0 + DAY_MS });
  assert.equal(truncated, false);
  assert.equal(buckets.length, all.length);
  assert.equal(new Set(buckets.map(b => `${b.start}/${b.model}`)).size, all.length);
  assert.ok(calls.length > 1);
});

test('二分到单桶 10 分钟仍被截断，标记 truncated 并保留拿到的', async () => {
  const all = Array.from({ length: 5 }, (_, i) => bucket(DAY0, { model: `m${i}` }));
  const { query, calls } = service(all, { limit: 2 });
  const { buckets, truncated } = await fetchUsageBuckets(query, { from: DAY0, to: DAY0 + DAY_MS });
  assert.equal(truncated, true);
  assert.equal(buckets.length, 2);
  assert.ok(calls.every(c => c.to - c.from >= BUCKET_MS || c.to === DAY0 + DAY_MS));
  assert.ok(calls.length < 40, '二分到下限就停，不无限递归');
});

test('服务给了重复的桶，按 (start, agent, model) 去重', async () => {
  const dup = bucket(DAY0);
  const query = async () => ({ buckets: [dup, { ...dup }, { ...dup, agent: 'codex' }], truncated: false });
  const { buckets } = await fetchUsageBuckets(query, { from: DAY0, to: DAY0 + 1000 });
  assert.equal(buckets.length, 2);
});

test('每日汇总按 UTC 日期分块，跳过空桶，不含多余字段', () => {
  const bodies = buildDailyUsageBodies([
    bucket(DAY0 + 3_600_000 + 10 * 60_000),
    bucket(DAY0 + 3_600_000 + 10 * 60_000, { model: 'sonnet', session: 'secret', cwd: '/home/x' }),
    bucket(DAY0 + 3_600_000 + 10 * 60_000, { agent: 'codex' }),
    bucket(DAY0 + 7_200_000, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, reportedTurns: 0 }),
    bucket(DAY0 + DAY_MS + 23 * 3_600_000 + 50 * 60_000),
  ]);
  assert.deepEqual(Object.keys(bodies), ['2026-11-01', '2026-11-02']);
  assert.deepEqual(Object.keys(bodies['2026-11-01'].blocks), ['01:10']);
  const block = bodies['2026-11-01'].blocks['01:10'];
  assert.deepEqual(Object.keys(block), ['claude', 'codex']);
  assert.deepEqual(block.claude.opus, { input: 10, output: 5, cacheRead: 100, cacheWrite: 1, turns: 2, reportedTurns: 2 });
  assert.deepEqual(Object.keys(block.claude.sonnet).sort(), ['cacheRead', 'cacheWrite', 'input', 'output', 'reportedTurns', 'turns']);
  assert.deepEqual(Object.keys(bodies['2026-11-02'].blocks), ['23:50']);
  assert.deepEqual(buildDailyUsageBodies([]), {});
});

test('同一块同一模型的多条桶相加；模型名 __proto__ 也只是普通键', () => {
  const bodies = buildDailyUsageBodies([bucket(DAY0, { model: '__proto__' }), bucket(DAY0, { model: '__proto__' })]);
  const models = bodies['2026-11-01'].blocks['00:00'].claude;
  assert.equal(Object.getPrototypeOf(models), Object.prototype);
  assert.equal(Object.hasOwn(models, '__proto__'), true);
  assert.equal(Object.getOwnPropertyDescriptor(models, '__proto__').value.input, 20);
});

test('一天太大时合并成按小时，再不行合并成整天一块，且低于 64 KiB', () => {
  const buckets = [];
  for (let i = 0; i < 144; i++) for (let m = 0; m < 400; m++) buckets.push(bucket(DAY0 + i * BUCKET_MS, { model: `model-${m}-${'x'.repeat(30)}` }));
  const body = buildDailyUsageBodies(buckets)['2026-11-01'];
  assert.ok(Buffer.byteLength(JSON.stringify(body)) < 64 * 1024);
  assert.ok(Object.keys(body.blocks).length <= 24);
});

const usageRecord = (author, id, blocks, version = 1) => ({ author, kind: 'coda/token-usage', id, version, body: { blocks }, local: false });
const counts = (input, output = 0, extra = {}) => ({ input, output, cacheRead: 0, cacheWrite: 0, turns: 1, reportedTurns: 1, ...extra });
const FROM = DAY0, TO = DAY0 + 2 * DAY_MS;

test('好友按作者汇总所有 sourceId 在 [from, to) 内的用量，并按总量排序', () => {
  const { entries } = aggregateLeaderboard({
    selfAuthor: A, selfSourceId: 'me', from: FROM, to: TO, friends: [{ author: B }, { author: C }],
    localBuckets: [bucket(DAY0 + 3_600_000, { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 })],
    legacyUsageRecords: [
      usageRecord(B, '2026-11-01/dev1', { '00:00': { claude: { opus: counts(1000, 500) } } }),
      usageRecord(B, '2026-11-01/dev2', { '12:30': { codex: { gpt: counts(200) } }, '23:59': { codex: { gpt: counts(1) } } }),
      usageRecord(B, '2026-11-02/dev1', { '00:00': { claude: { opus: counts(50) } } }),
      usageRecord(B, '2026-10-31/dev1', { '23:50': { claude: { opus: counts(99999) } } }),
    ],
  });
  assert.deepEqual(entries.map(e => [e.rank, e.author]), [[1, B], [2, A], [3, C]]);
  const b = entries[0];
  assert.equal(b.input, 1251);
  assert.equal(b.output, 500);
  assert.equal(b.totalTokens, 1751);
  assert.equal(b.turns, 4);
  assert.deepEqual(b.models.map(m => [m.model, m.totalTokens]), [['opus', 1550], ['gpt', 201]]);
  assert.equal(entries[2].shared, false);
  assert.equal(entries[2].totalTokens, 0);
});

test('同一条记录只取最新版本', () => {
  const { entries } = aggregateLeaderboard({
    selfAuthor: A, selfSourceId: 'me', from: FROM, to: TO, friends: [{ author: B }],
    legacyUsageRecords: [
      usageRecord(B, '2026-11-01/d', { '00:00': { claude: { opus: counts(5) } } }, 1),
      usageRecord(B, '2026-11-01/d', { '00:00': { claude: { opus: counts(7) } } }, 3),
      usageRecord(B, '2026-11-01/d', { '00:00': { claude: { opus: counts(9) } } }, 2),
    ],
  });
  assert.equal(entries.find(e => e.author === B).input, 7);
});

test('本机用最新桶，不重复计入自己发布过的记录，但并上同作者的其他 sourceId', () => {
  const { entries } = aggregateLeaderboard({
    selfAuthor: A, selfSourceId: 'me', from: FROM, to: TO, friends: [],
    localBuckets: [bucket(DAY0, { input: 300, output: 0, cacheRead: 0, cacheWrite: 0, turns: 1 })],
    legacyUsageRecords: [
      usageRecord(A, '2026-11-01/me', { '00:00': { claude: { opus: counts(250) } } }),   // 自己发布的旧快照：不再计
      usageRecord(A, '2026-11-01/other-device', { '00:00': { claude: { opus: counts(40) } } }),
    ],
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].self, true);
  assert.equal(entries[0].input, 340);
});

test('不认识的作者、非用量记录、范围外的本机桶都不计', () => {
  const { entries } = aggregateLeaderboard({
    selfAuthor: A, selfSourceId: 'me', from: FROM, to: TO, friends: [{ author: B }],
    localBuckets: [bucket(FROM - 1), bucket(TO)],
    legacyUsageRecords: [
      usageRecord(C, '2026-11-01/x', { '00:00': { claude: { opus: counts(1e9) } } }),
      { ...usageRecord(B, '2026-11-01/x', { '00:00': { claude: { opus: counts(1e9) } } }), kind: 'profile' },
    ],
  });
  assert.deepEqual(entries.map(e => e.author).sort(), [A, B]);
  assert.ok(entries.every(e => e.totalTokens === 0));
});

test('恶意记录体：坏键、负数、小数、超大数、非对象都被丢弃或归零', () => {
  const evil = {
    author: B, kind: 'coda/token-usage', id: '2026-11-01/x', version: 1, local: false,
    body: { blocks: {
      '25:00': { claude: { opus: counts(1e6) } },
      'zz': { claude: { opus: counts(1e6) } },
      '00:00': { claude: { opus: { input: -5, output: 1.5, cacheRead: Number.MAX_SAFE_INTEGER + 10, cacheWrite: '9', turns: 3, reportedTurns: null }, bad: 5, nested: null }, 'x\u0000y': 'nope', list: [1] },
      '00:10': 'text',
    } },
  };
  const { entries } = aggregateLeaderboard({ selfAuthor: A, selfSourceId: 'me', from: FROM, to: TO, friends: [{ author: B }],
    legacyUsageRecords: [evil, { author: B, kind: 'coda/token-usage', id: 'bad-id', version: 1, body: null }, { author: B, kind: 'coda/token-usage', id: '2026-13-45/x', version: 1, body: { blocks: {} } }] });
  const b = entries.find(e => e.author === B);
  assert.equal(b.totalTokens, 0);
  assert.equal(b.turns, 3);
  assert.ok(b.models.every(m => typeof m.model === 'string' && !/[\u0000-\u001f]/.test(m.model)));
});

test('排序：总 Token 降序，平局按回合数降序，再按 author 升序', () => {
  const { entries } = aggregateLeaderboard({
    selfAuthor: A, selfSourceId: 'me', from: FROM, to: TO, friends: [{ author: B }, { author: C }],
    legacyUsageRecords: [
      usageRecord(B, '2026-11-01/x', { '00:00': { claude: { opus: counts(100, 0, { turns: 1 }) } } }),
      usageRecord(C, '2026-11-01/x', { '00:00': { claude: { opus: counts(100, 0, { turns: 5 }) } } }),
    ],
    localBuckets: [bucket(DAY0, { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, turns: 5 })],
  });
  assert.deepEqual(entries.map(e => e.author), [A, C, B]);
  assert.deepEqual(entries.map(e => e.rank), [1, 2, 3]);
});

test('空数据：只有自己，全是零', () => {
  assert.deepEqual(aggregateLeaderboard({ selfAuthor: A, selfSourceId: 'me', from: FROM, to: TO }).entries.map(e => [e.author, e.totalTokens, e.models.length]), [[A, 0, 0]]);
  assert.deepEqual(aggregateLeaderboard({ from: FROM, to: TO }).entries, []);
});

test('本机汇总与时间范围', () => {
  const sum = summarizeBuckets([bucket(DAY0), bucket(DAY0 + BUCKET_MS, { model: 'sonnet' }), bucket(TO)], { from: FROM, to: TO });
  assert.equal(sum.totalTokens, 2 * 116);
  assert.equal(sum.turns, 4);
  assert.equal(sum.models.length, 2);
  const now = new Date(2026, 10, 20, 15, 30).getTime();
  assert.equal(rangeWindow('today', now).from, new Date(2026, 10, 20).getTime());
  assert.equal(rangeWindow('7d', now).from, new Date(2026, 10, 14).getTime());
  assert.equal(rangeWindow('30d', now).from, new Date(2026, 9, 22).getTime());
  assert.equal(rangeWindow('7d', now).to, now + 1);
});

// ——— 月块日归档 ———

const ROW = [10, 5, 100, 1, 2, 2];
const sumRows = bodies => Object.values(bodies).reduce((total, body) => {
  for (const agents of Object.values(body.days)) for (const rows of Object.values(agents)) for (const row of rows) row.n.forEach((v, i) => { total[i] += v; });
  return total;
}, [0, 0, 0, 0, 0, 0]);
// 一个 Agent 名下按旧标签 m 找一行的计数。
const labelled = (rows, model) => rows.find(row => row.m === model).n;
const bytes = body => Buffer.byteLength(JSON.stringify(body));

test('月块日归档：按 UTC 日、每个计数 6 元数组，id 键是 YYYY-MM，空桶与多余字段不进', () => {
  const bodies = buildArchiveBodies([
    bucket(DAY0 + 3_600_000),
    bucket(DAY0 + 3_600_000 + BUCKET_MS),                         // 同日同模型相加
    bucket(DAY0 + DAY_MS - 1, { agent: 'codex', model: 'gpt', session: 'secret' }),
    bucket(DAY0 + DAY_MS),
    bucket(DAY0 + 2 * DAY_MS, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, reportedTurns: 0 }),
    bucket(Date.UTC(2026, 11, 1)),
  ]);
  assert.deepEqual(Object.keys(bodies), ['2026-11', '2026-12']);
  assert.equal(bodies['2026-11'].v, 3);
  assert.deepEqual(Object.keys(bodies['2026-11'].days), ['2026-11-01', '2026-11-02']);
  assert.deepEqual(labelled(bodies['2026-11'].days['2026-11-01'].claude, 'opus'), [20, 10, 200, 2, 4, 4]);
  assert.deepEqual(labelled(bodies['2026-11'].days['2026-11-01'].codex, 'gpt'), ROW);
  assert.deepEqual(buildArchiveBodies([]), {});
  assert.equal(labelled(buildArchiveBodies([bucket(DAY0, { model: '__proto__' })])['2026-11'].days['2026-11-01'].claude, '__proto__').length, 6);
});

test('月块超 60 KiB 先拆半月（-1：1–15 日，-2：16–31 日），总量不变', () => {
  const buckets = [];
  for (let d = 0; d < 30; d++) for (let m = 0; m < 55; m++) buckets.push(bucket(DAY0 + d * DAY_MS, { model: `model-${m}-${'x'.repeat(30)}` }));
  assert.ok(bytes(buildArchiveBodies(buckets, { maxBytes: 1e9 })['2026-11']) > 60 * 1024);
  const bodies = buildArchiveBodies(buckets);
  assert.deepEqual(Object.keys(bodies), ['2026-11-1', '2026-11-2']);
  assert.ok(Object.values(bodies).every(body => bytes(body) <= 60 * 1024));
  assert.deepEqual(Object.keys(bodies['2026-11-1'].days).map(date => Number(date.slice(8))), Array.from({ length: 15 }, (_, i) => i + 1));
  assert.equal(Object.keys(bodies['2026-11-2'].days).length, 15);
  assert.deepEqual(sumRows(bodies), ROW.map(v => v * 30 * 55));
});

test('半月还超限就按周（-w1…-w5），再不行合并小模型，每块都不超限且总量不变', () => {
  const buckets = [];
  for (let d = 0; d < 30; d++) for (let m = 0; m < 400; m++) buckets.push(bucket(DAY0 + d * DAY_MS, { model: `model-${m}-${'x'.repeat(30)}`, input: m + 1 }));
  const bodies = buildArchiveBodies(buckets);
  assert.ok(Object.keys(bodies).every(key => /^2026-11-w[1-5]$/.test(key)));
  assert.ok(Object.values(bodies).every(body => bytes(body) <= 60 * 1024));
  assert.ok(Object.values(bodies).some(body => JSON.stringify(body).includes('"other"')), '周块还放不下，小模型并进 other');
  assert.deepEqual(sumRows(bodies), [buckets.reduce((n, b) => n + b.input, 0), 5 * 12000, 100 * 12000, 12000, 2 * 12000, 2 * 12000]);
  const small = buildArchiveBodies([bucket(DAY0), bucket(DAY0 + 20 * DAY_MS)], { maxBytes: 100 });
  assert.deepEqual(Object.keys(small), ['2026-11-1', '2026-11-2'], 'maxBytes 可调：两天各一块');
});

test('readArchiveRecord：id 与 v 要对，日期要在 id 的月份与分块内，计数只认 6 个非负安全整数', () => {
  const record = (id, body) => ({ author: A, kind: 'coda/token-day', id, version: 1, body });
  const good = { v: 2, days: { '2026-11-03': { claude: { opus: ROW, bad1: [1, 2, 3], bad2: [1, 2, 3, 4, 5, -1], bad3: [1, 2, 3, 4, 5, 1.5], bad4: [1, 2, 3, 4, 5, Number.MAX_SAFE_INTEGER + 2], bad5: 'x' }, ghost: null }, '2026-12-03': { claude: { opus: ROW } }, '2026-11-31': { claude: { opus: ROW } } } };
  const read = readArchiveRecord(record('dev-1/2026-11', good));
  assert.equal(read.sourceId, 'dev-1');
  assert.deepEqual(read.days.map(d => [d.date, d.start, d.rows.length]), [['2026-11-03', Date.UTC(2026, 10, 3), 1]]);
  assert.deepEqual(read.days[0].rows[0], { agent: 'claude', api: null, asked: null, served: null, same: null, model: 'opus', input: 10, output: 5, cacheRead: 100, cacheWrite: 1, turns: 2, reportedTurns: 2 }, 'v2 的行按旧标签读');
  assert.deepEqual(readArchiveRecord(record('dev-1/2026-11-2', good)).days, [], '16–31 日的块里不收 3 日');
  assert.equal(readArchiveRecord(record('dev-1/2026-11-w1', good)).days.length, 1);
  assert.equal(readArchiveRecord(record('dev-1/2026-11-w5', { v: 2, days: { '2026-11-30': { a: { b: ROW } } } })).days.length, 1);
  for (const id of ['dev-1/2026-11-3', 'dev-1/2026-11-w6', 'dev 1/2026-11', '2026-11', 'a/b/2026-11', `${'x'.repeat(101)}/2026-11`, 'dev/2026-1']) assert.equal(readArchiveRecord(record(id, good)), null, id);
  for (const v of [1, 4]) assert.equal(readArchiveRecord(record('dev-1/2026-11', { ...good, v })), null);
  assert.equal(readArchiveRecord(record('dev-1/2026-11', { v: 2, days: null })), null);
  assert.equal(readArchiveRecord(null), null);
});

// ——— 48 小时曲线 ———

const NOW = Date.UTC(2026, 10, 20, 10, 5);   // 10:05 UTC
test('48 小时曲线：30 分钟槽位，窗口对齐并含 now 所在的槽，窗口外的桶不要', () => {
  const body = buildTodayBody([
    bucket(NOW - 5 * 60_000),                                 // 10:00 桶，落 10:00 槽
    bucket(NOW - 5 * 60_000 + BUCKET_MS * 2),                 // 10:20，同槽
    bucket(Date.UTC(2026, 10, 20, 10, 30)),                   // 未来槽之外（窗口到 10:30 止，不含）
    bucket(NOW - 48 * 3_600_000 + 25 * 60_000),               // 窗口第一槽
    bucket(NOW - 49 * 3_600_000),                             // 窗口外
  ], { now: NOW });
  assert.equal(body.v, 3);
  assert.equal(body.slotMs, 1_800_000);
  assert.equal(body.windowEnd, Date.UTC(2026, 10, 20, 10, 30));
  assert.equal(body.windowStart, body.windowEnd - 48 * 3_600_000);
  assert.deepEqual(Object.keys(body.slots), [String(body.windowStart), String(Date.UTC(2026, 10, 20, 10, 0))]);
  assert.deepEqual(labelled(body.slots[Date.UTC(2026, 10, 20, 10, 0)].claude, 'opus'), [20, 10, 200, 2, 4, 4]);
  assert.ok(Object.keys(body.slots).length <= 96);
});

test('48 小时曲线超限先降成 60 分钟槽，再合并小模型', () => {
  const buckets = [];
  for (let i = 0; i < 282; i++) for (let m = 0; m < 12; m++) buckets.push(bucket(NOW - 47 * 3_600_000 + i * BUCKET_MS + 1, { model: `model-${m}-${'x'.repeat(40)}` }));
  const small = buildTodayBody(buckets, { now: NOW, maxBytes: 24_000 });
  assert.equal(small.slotMs, 3_600_000);
  assert.equal(small.windowEnd % 3_600_000, 0);
  assert.ok(Object.keys(small.slots).length <= 48);
  assert.ok(bytes(small) <= 24_000);
  const tiny = buildTodayBody(buckets, { now: NOW, maxBytes: 6_000 });
  assert.ok(bytes(tiny) <= 6_000 && JSON.stringify(tiny).includes('"other"'));
  const total = body => Object.values(body.slots).flatMap(a => Object.values(a)).flat().reduce((n, r) => n + r.n[0], 0);
  assert.equal(total(tiny), total(small));
  assert.equal(total(small), 10 * buckets.length);
});

test('readTodayRecord：窗口与槽位必须对齐，坏槽位和坏计数丢掉', () => {
  const body = buildTodayBody([bucket(NOW - 5 * 60_000)], { now: NOW });
  const record = (id, over = {}) => ({ author: A, kind: 'coda/token-today', id, version: 1, body: { ...body, ...over } });
  const read = readTodayRecord(record('dev-1'));
  assert.equal(read.sourceId, 'dev-1');
  assert.equal(read.slotMs, 1_800_000);
  assert.deepEqual(read.slots.map(slot => [slot.start, slot.rows.length]), [[Date.UTC(2026, 10, 20, 10, 0), 1]]);
  const start = body.windowStart;
  const one = n => ({ a: [{ m: 'b', n }] });
  const messy = readTodayRecord(record('dev-1', { slots: { [start]: one(ROW), [start + 1]: one(ROW), [start - 1_800_000]: one(ROW), [body.windowEnd]: one(ROW), x: one(ROW), [start + 1_800_000]: one([1, 2]) } }));
  assert.deepEqual(messy.slots.map(slot => [slot.start, slot.rows.length]), [[start, 1], [start + 1_800_000, 0]]);
  for (const id of ['a/b', 'a b', '']) assert.equal(readTodayRecord(record(id)), null, id);
  for (const over of [{ v: 1 }, { v: 4 }, { slotMs: 600_000 }, { slotMs: 'x' }, { windowStart: start + 1 }, { windowEnd: start }, { slots: null }, { windowEnd: 'x' }]) assert.equal(readTodayRecord(record('dev-1', over)), null, JSON.stringify(over));
  assert.equal(readTodayRecord({ id: 'dev-1', body: { ...body, slotMs: 3_600_000 } }), null, '60 分钟槽的窗口得对齐到整点');
  assert.equal(readTodayRecord(null), null);
});

test('撤回用的空记录体与归属判断', () => {
  for (const kind of ['coda/token-usage', 'coda/token-day', 'coda/token-today']) {
    assert.equal(isWithdrawn(kind, withdrawnBody(kind)), true);
    assert.equal(isWithdrawn(kind, { v: 2, days: { x: 1 } }), false);
  }
  assert.equal(readTodayRecord({ id: 'dev', body: withdrawnBody('coda/token-today') }), null);
  assert.deepEqual(readArchiveRecord({ id: 'dev/2026-11', body: withdrawnBody('coda/token-day') }).days, []);
  assert.deepEqual([ownedBySource('coda/token-usage', '2026-11-01/me', 'me'), ownedBySource('coda/token-usage', '2026-11-01/me2', 'me'), ownedBySource('coda/token-day', 'me/2026-11', 'me'),
    ownedBySource('coda/token-day', 'me2/2026-11', 'me'), ownedBySource('coda/token-today', 'me', 'me'), ownedBySource('coda/token-today', 'me/x', 'me'), ownedBySource('coda/token-today', 5, 'me')],
  [true, false, true, false, true, false, false]);
});

// ——— person 切片 ———

test('person 切片：指定 person 只留他的桶，未打标的历史桶可选并入，不指定保持全量', () => {
  const list = [bucket(DAY0, { person: 'mom' }), bucket(DAY0 + BUCKET_MS, { person: 'dad' }), bucket(DAY0 + 2 * BUCKET_MS), bucket(DAY0 + 3 * BUCKET_MS, { person: '' })];
  assert.equal(filterBucketsByPerson(list, undefined), list);
  assert.equal(filterBucketsByPerson(list, ''), list);
  assert.deepEqual(filterBucketsByPerson(list, 'mom').map(b => b.start - DAY0), [0, 2 * BUCKET_MS, 3 * BUCKET_MS]);
  assert.deepEqual(filterBucketsByPerson(list, 'mom', { includeUntagged: false }).map(b => b.start - DAY0), [0]);
  assert.deepEqual(filterBucketsByPerson(list, 'dad', { includeUntagged: false }).map(b => b.start - DAY0), [BUCKET_MS]);
  const args = { selfAuthor: A, selfSourceId: 'me', from: FROM, to: TO, friends: [], localBuckets: list };
  assert.equal(aggregateLeaderboard(args).entries[0].turns, 8);
  assert.equal(aggregateLeaderboard({ ...args, person: 'mom' }).entries[0].turns, 6);
  const curve = person => aggregateTodayCurve({ selfAuthor: A, selfSourceId: 'me', localBuckets: list, range: { from: DAY0, to: DAY0 + 3_600_000 }, person }).curve;
  assert.deepEqual(curve().map(slot => slot.turns), [6, 2]);
  assert.deepEqual(curve('dad').map(slot => slot.turns), [4, 2], 'dad 自己的加上未打标的');
  assert.deepEqual(curve('mom').map(slot => slot.turns), [4, 2]);
});

// ——— 跨记录聚合：当天曲线 ———

const todayRec = (author, sourceId, buckets, now, version = 1) => ({ author, kind: 'coda/token-today', id: sourceId, version, body: buildTodayBody(buckets, { now }), local: false });
const dayRec = (author, sourceId, buckets, month = '2026-11', version = 1) => ({ author, kind: 'coda/token-day', id: `${sourceId}/${month}`, version, body: buildArchiveBodies(buckets)[month], local: false });
const one = (start, input, over = {}) => bucket(start, { input, output: 0, cacheRead: 0, cacheWrite: 0, turns: 1, reportedTurns: 1, ...over });
const withTZ = async (tz, run) => {
  const before = process.env.TZ;
  process.env.TZ = tz;
  try { await run(); } finally { if (before === undefined) delete process.env.TZ; else process.env.TZ = before; }
};

test('当天曲线：本地零点起的完整槽位（空槽补零），合并本机最新桶与同根兄弟机器，排除本机与 legacy', () => {
  const day = Date.UTC(2026, 10, 20), at = now => ({ from: day, to: now });
  const local = [one(day + 3_600_000, 100), one(day + 3_600_000 + 20 * 60_000, 50), one(day - 1, 999)];   // 最后一个是昨天
  const { curve, byAuthor } = aggregateTodayCurve({
    selfAuthor: A, selfSourceId: 'me', excludedSourceIds: ['old'], localBuckets: local, friends: [{ author: B }], range: at(day + 4 * 3_600_000 + 1),
    todayRecords: [
      todayRec(A, 'me', [one(day + 3_600_000, 5000)], day + 4 * 3_600_000),        // 本机自己发布过的快照：不计
      todayRec(A, 'old', [one(day + 3_600_000, 7000)], day + 4 * 3_600_000),       // 换成机器 ID 之前的 UUID：不计
      todayRec(A, 'tablet', [one(day + 3_600_000, 7), one(day + 2 * 3_600_000 + 10 * 60_000, 3), one(day - 600_000, 8000)], day + 4 * 3_600_000),
      todayRec(B, 'phone', [one(day + 3_600_000, 11)], day + 4 * 3_600_000),
      todayRec(C, 'x', [one(day + 3_600_000, 99999)], day + 4 * 3_600_000),        // 不认识的作者
    ],
  });
  assert.equal(curve.length, 9);
  assert.ok(curve.every((slot, i) => slot.start === day + i * 1_800_000));
  assert.deepEqual(curve.map(slot => slot.input), [0, 0, 157, 0, 3, 0, 0, 0, 0].map((v, i) => (i === 2 ? 150 + 7 : v)));
  assert.deepEqual(Object.keys(curve[0]).sort(), ['cacheRead', 'cacheWrite', 'input', 'output', 'reportedTurns', 'start', 'totalTokens', 'turns']);
  assert.equal(curve[2].totalTokens, 157);
  assert.equal(curve[2].turns, 3);
  assert.deepEqual(Object.keys(byAuthor).sort(), [A, B].sort());
  assert.equal(byAuthor[B][2].input, 11);
  assert.equal(byAuthor[A][2].input, 157);
  assert.deepEqual(aggregateTodayCurve({ range: { from: day, to: day + 3_600_000 } }).curve.map(slot => slot.totalTokens), [0, 0]);
});

test('当天曲线按本地零点切「今天」：正、负、半小时 UTC 偏移都精确', async () => {
  const instant = Date.UTC(2026, 10, 20, 12, 5);
  for (const tz of ['Asia/Shanghai', 'America/Los_Angeles', 'Asia/Kolkata', 'Pacific/Kiritimati']) {
    await withTZ(tz, () => {
      const range = rangeWindow('today', instant), midnight = range.from;
      assert.equal(new Date(midnight).getHours(), 0, tz);
      const local = [one(midnight - BUCKET_MS, 1000), one(midnight, 1), one(midnight + 30 * 60_000, 2), one(instant - 5 * 60_000, 4)];
      const sibling = todayRec(A, 'tablet', [one(midnight - 1_800_000, 5000), one(midnight, 10), one(midnight + 1_800_000, 20)], instant);
      const { curve } = aggregateTodayCurve({ selfAuthor: A, selfSourceId: 'me', localBuckets: local, todayRecords: [sibling], range });
      assert.equal(curve[0].start, midnight, tz);
      assert.equal(curve[0].input, 11, tz);
      assert.equal(curve[1].input, 22, tz);
      assert.equal(curve.reduce((n, slot) => n + slot.input, 0), 37, `${tz}：零点前的 1000 与 5000 都不算`);
      assert.ok(curve.at(-1).start < range.to && curve.at(-1).start + 1_800_000 >= range.to);
    });
  }
});

// ——— 跨记录聚合：榜单无双计 ———

test('榜单：今天窗口只取 48 小时曲线里落在 [from, to) 的槽位，不碰 UTC 月块', async () => {
  const instant = Date.UTC(2026, 10, 20, 12, 5);
  for (const tz of ['Asia/Shanghai', 'America/Los_Angeles']) {
    await withTZ(tz, () => {
      const { from, to } = rangeWindow('today', instant);
      const buckets = [one(from - 600_000, 1000), one(from, 1), one(from + 3_600_000, 2), one(instant - BUCKET_MS, 4)];
      const { entries } = aggregateLeaderboard({
        selfAuthor: A, selfSourceId: 'me', friends: [{ author: B }], from, to,
        dayRecords: [dayRec(B, 'phone', buckets), dayRec(B, 'phone', buckets, '2026-11', 0)],
        todayRecords: [todayRec(B, 'phone', buckets, instant)],
      });
      assert.equal(entries.find(e => e.author === B).input, 7, tz);
    });
  }
});

test('榜单：多天窗口里 48 小时曲线完整覆盖的 UTC 日取曲线，更早的 UTC 日取日归档，边界日不重复', async () => {
  await withTZ('UTC', () => {
    const instant = Date.UTC(2026, 10, 20, 10, 5), day = n => Date.UTC(2026, 10, n);
    // 曲线窗口 11-18 10:30 → 11-20 10:30，完整覆盖的 UTC 日从 11-19 起。
    const everything = [one(day(10) + 1000, 1), one(day(17) + 1000, 10), one(day(18) + 1000, 100), one(day(18) + 20 * 3_600_000, 1000), one(day(19) + 1000, 10_000), one(day(20) + 1000, 100_000)];
    const args = { selfAuthor: A, selfSourceId: 'me', friends: [{ author: B }], dayRecords: [dayRec(B, 'phone', everything)], todayRecords: [todayRec(B, 'phone', everything, instant)] };
    const sum = range => aggregateLeaderboard({ ...args, ...rangeWindow(range, instant) }).entries.find(e => e.author === B).input;
    // 7d 窗口从 11-14：日归档取 11-17、11-18（整日，含 11-18 的 20:00 那条），曲线取 11-19 起；11-10 在窗口外。
    assert.equal(sum('7d'), 10 + 100 + 1000 + 10_000 + 100_000);
    // 30d 窗口从 10-22：多了 11-10。
    assert.equal(sum('30d'), 1 + 10 + 100 + 1000 + 10_000 + 100_000);
    assert.equal(sum('today'), 100_000);
    // 只有日归档、没有曲线（旧一点的版本）：整日都取日归档，包括今天这个 UTC 日。
    const daysOnly = aggregateLeaderboard({ ...args, todayRecords: [], ...rangeWindow('7d', instant) }).entries.find(e => e.author === B).input;
    assert.equal(daysOnly, 10 + 100 + 1000 + 10_000 + 100_000);
    // 只有曲线、没有日归档：曲线窗口里能看到的都算。
    const todayOnly = aggregateLeaderboard({ ...args, dayRecords: [], ...rangeWindow('7d', instant) }).entries.find(e => e.author === B).input;
    assert.equal(todayOnly, 1000 + 10_000 + 100_000);
  });
});

test('榜单：同根兄弟机器并入「我」，本机 sourceId 与 legacy 的记录不重复计', () => {
  const day = Date.UTC(2026, 10, 20), instant = day + 4 * 3_600_000;
  const mine = [one(day + 3_600_000, 100)];
  const { entries } = aggregateLeaderboard({
    selfAuthor: A, selfSourceId: 'machine-1', excludedSourceIds: ['old-uuid'], friends: [], from: day, to: instant, localBuckets: mine,
    dayRecords: [dayRec(A, 'machine-1', mine), dayRec(A, 'old-uuid', mine), dayRec(A, 'tablet', [one(day + 1000, 7)])],
    todayRecords: [todayRec(A, 'machine-1', mine, instant), todayRec(A, 'old-uuid', mine, instant), todayRec(A, 'tablet', [one(day + 1000, 7)], instant)],
    legacyUsageRecords: [usageRecord(A, '2026-11-20/old-uuid', { '01:00': { claude: { opus: counts(100) } } }), usageRecord(A, '2026-11-20/machine-1', { '01:00': { claude: { opus: counts(100) } } })],
  });
  assert.equal(entries[0].input, 107);
  assert.equal(entries[0].turns, 2);
});

test('榜单：旧版好友只发了 coda/token-usage 时回退读旧记录，新旧共存时只认新版，不双计', () => {
  const day = Date.UTC(2026, 10, 20), instant = day + 4 * 3_600_000;
  const legacy = id => usageRecord(B, `2026-11-20/${id}`, { '01:00': { claude: { opus: counts(1000) } } });
  const args = { selfAuthor: A, selfSourceId: 'me', friends: [{ author: B }], from: day, to: instant };
  const only = aggregateLeaderboard({ ...args, legacyUsageRecords: [legacy('old-dev')] }).entries.find(e => e.author === B);
  assert.equal(only.input, 1000);
  assert.equal(only.shared, true);
  const buckets = [one(day + 3_600_000, 300)];
  const both = aggregateLeaderboard({ ...args, legacyUsageRecords: [legacy('new-dev'), legacy('old-dev')], dayRecords: [dayRec(B, 'new-dev', buckets)], todayRecords: [] }).entries.find(e => e.author === B);
  assert.equal(both.input, 1300, '新版好友的机器 new-dev 只算 300；另一台只发旧版的 old-dev 仍算 1000');
  const withToday = aggregateLeaderboard({ ...args, legacyUsageRecords: [legacy('new-dev')], todayRecords: [todayRec(B, 'new-dev', buckets, instant)] }).entries.find(e => e.author === B);
  assert.equal(withToday.input, 300);
  const withdrawn = aggregateLeaderboard({ ...args, legacyUsageRecords: [legacy('new-dev')], dayRecords: [{ author: B, kind: 'coda/token-day', id: 'new-dev/2026-11', version: 2, body: withdrawnBody('coda/token-day') }] }).entries.find(e => e.author === B);
  assert.equal(withdrawn.input, 0, '新版记录被撤回成空，旧版残留也不再算');
});

test('榜单：新版记录同一 (author, id) 只取最新版本；格式不对的记录被丢弃', () => {
  const day = Date.UTC(2026, 10, 20);
  const old = dayRec(B, 'd', [one(day + 1000, 5)], '2026-11', 1), latest = dayRec(B, 'd', [one(day + 1000, 7)], '2026-11', 3), stale = dayRec(B, 'd', [one(day + 1000, 9)], '2026-11', 2);
  const junk = { author: B, kind: 'coda/token-day', id: 'd/2026-11-x', version: 9, body: { v: 2, days: { '2026-11-20': { claude: { opus: ROW } } } } };
  const { entries } = aggregateLeaderboard({ selfAuthor: A, selfSourceId: 'me', friends: [{ author: B }], from: day, to: day + DAY_MS, dayRecords: [old, latest, stale, junk] });
  assert.equal(entries.find(e => e.author === B).input, 7);
});

// ——— 评审补回归 ———

test('月块换拆法时新旧块同时被读到：同一 UTC 日只采用版本最大的那条记录里的，不双计', () => {
  const day = n => Date.UTC(2026, 10, n);
  const old = [one(day(5), 100), one(day(20), 7)], renewed = [one(day(5), 200)];
  const whole = (version, buckets = old) => dayRec(B, 'phone', buckets, '2026-11', version);
  const half = (version, buckets = renewed) => ({ author: B, kind: 'coda/token-day', id: 'phone/2026-11-1', version, body: buildArchiveBodies(buckets)['2026-11'], local: false });
  const input = records => aggregateLeaderboard({ selfAuthor: A, selfSourceId: 'me', friends: [{ author: B }], from: day(1), to: day(25), dayRecords: records }).entries.find(e => e.author === B).input;
  assert.equal(input([whole(1)]), 107);
  assert.equal(input([whole(1), half(2)]), 207, '新的半月块盖住整月块里同一日（5 日），整月块里别的日子（20 日）照旧');
  assert.equal(input([half(2), whole(1)]), 207, '与记录的先后无关');
  assert.equal(input([whole(3), half(2)]), 107, '版本大的是整月块，就以它为准，5 日只算一次');
  assert.equal(input([whole(1, [one(day(5), 100)]), half(2, [one(day(5), 100)])]), 100);
});

test('旧曲线不遮住 windowEnd 之后的新归档：窗口起点之后、windowEnd 之前取曲线，之后的 UTC 日回退取日归档', async () => {
  await withTZ('UTC', () => {
    const day = (n, h = 1) => Date.UTC(2026, 10, n, h), instant = Date.UTC(2026, 10, 20, 10, 5);
    const everything = [one(day(14), 1), one(day(15), 10), one(day(16), 1000), one(day(18), 10_000), one(day(20), 100_000)];
    // 归档是新的（到 11-20），曲线停在 11-15 10:05：窗口 11-13 10:30 → 11-15 10:30。
    const stale = todayRec(B, 'phone', everything, Date.UTC(2026, 10, 15, 10, 5));
    assert.equal(stale.body.windowEnd, Date.UTC(2026, 10, 15, 10, 30));
    const args = { selfAuthor: A, selfSourceId: 'me', friends: [{ author: B }], dayRecords: [dayRec(B, 'phone', everything)], todayRecords: [stale] };
    const sum = range => aggregateLeaderboard({ ...args, ...rangeWindow(range, instant) }).entries.find(e => e.author === B).input;
    assert.equal(sum('7d'), 1 + 10 + 1000 + 10_000 + 100_000, '11-14、11-15 取曲线，11-16 起取归档，一天不丢不重');
    assert.equal(sum('today'), 100_000, '今天落在曲线之后，回退取归档，不是 0');
    // 曲线是新的：照旧，归档里曲线覆盖的日子不再取。
    const fresh = aggregateLeaderboard({ ...args, todayRecords: [todayRec(B, 'phone', everything, instant)], ...rangeWindow('7d', instant) }).entries.find(e => e.author === B).input;
    assert.equal(fresh, 1 + 10 + 1000 + 10_000 + 100_000);
  });
});

test('体积兜底：多 Agent 多槽位合并小模型也放不下时，每格合成一条合计，总量不变；小得离谱的预算抛错', () => {
  const buckets = [];
  for (let d = 0; d < 28; d++) for (let a = 0; a < 400; a++) buckets.push(bucket(DAY0 + d * DAY_MS, { agent: `agent-${a}-${'x'.repeat(20)}`, model: 'm' }));
  const bodies = buildArchiveBodies(buckets);
  assert.ok(Object.values(bodies).every(body => bytes(body) <= 60 * 1024));
  assert.ok(Object.values(bodies).some(body => JSON.stringify(body).includes('"_":[{"m":"_"')));
  assert.deepEqual(sumRows(bodies), ROW.map(v => v * 28 * 400));
  const today = [];
  for (let i = 0; i < 288; i++) for (let a = 0; a < 400; a++) today.push(bucket(NOW - 47 * 3_600_000 + i * BUCKET_MS + 1, { agent: `agent-${a}-${'x'.repeat(20)}`, model: 'm' }));
  const body = buildTodayBody(today, { now: NOW });
  assert.ok(bytes(body) <= 60 * 1024);
  assert.equal(body.slotMs, 3_600_000);
  assert.ok(Object.values(body.slots).every(agents => Object.keys(agents).join() === '_'));
  assert.equal(Object.values(body.slots).flatMap(a => a._).reduce((n, row) => n + row.n[0], 0), 10 * today.length);
  assert.throws(() => buildArchiveBodies([bucket(DAY0)], { maxBytes: 30 }), /预算/);
  assert.throws(() => buildTodayBody([bucket(NOW)], { now: NOW, maxBytes: 30 }), /预算/);
  assert.deepEqual(buildArchiveBodies([], { maxBytes: 30 }), {});
});

test('同一 UTC 日上午旧曲线（10）+ 同日全天归档（30）：该日取整日归档，不被旧曲线遮成 10，也不双计', async () => {
  await withTZ('UTC', () => {
    const day = Date.UTC(2026, 10, 20), instant = day + 20 * 3_600_000;
    const all = [one(day + 3_600_000, 10), one(day + 15 * 3_600_000, 20)];
    const stale = todayRec(B, 'phone', all, day + 10 * 3_600_000 + 5 * 60_000);      // 曲线只到 10:30，含上午的 10
    assert.equal(stale.body.windowEnd, day + 10 * 3_600_000 + 1_800_000);
    const total = ({ todayRecords, dayRecords }) => aggregateLeaderboard({ selfAuthor: A, selfSourceId: 'me', friends: [{ author: B }], from: day, to: instant, todayRecords, dayRecords })
      .entries.find(e => e.author === B).input;
    assert.equal(total({ todayRecords: [stale], dayRecords: [dayRec(B, 'phone', all)] }), 30);
    assert.equal(total({ todayRecords: [stale], dayRecords: [] }), 10, '没有归档就只能看曲线');
    assert.equal(total({ todayRecords: [todayRec(B, 'phone', all, instant - 600_000)], dayRecords: [dayRec(B, 'phone', all)] }), 30, '曲线是新的：取曲线，同样 30，不双计');
    // 查询窗口在曲线结束前就结束时，曲线完整覆盖那一段，取曲线（精确到窗口边界）。
    const early = aggregateLeaderboard({ selfAuthor: A, selfSourceId: 'me', friends: [{ author: B }], from: day, to: day + 9 * 3_600_000, todayRecords: [stale], dayRecords: [dayRec(B, 'phone', all)] });
    assert.equal(early.entries.find(e => e.author === B).input, 10);
  });
});

test('UTC+8 本地零点（前一 UTC 日 16:00 起）：归档因过半不在窗口内而不计时，当日旧曲线槽位照常取，17:00 的用量不丢', async () => {
  await withTZ('Asia/Shanghai', () => {
    const prev = Date.UTC(2026, 10, 19), instant = prev + 20 * 3_600_000 + 5 * 60_000;
    const from = prev + 16 * 3_600_000, to = prev + 25 * 3_600_000;      // 本地 11-20 00:00 到次日 01:00（UTC）
    assert.equal(new Date(from).getHours(), 0);
    const all = [one(prev + 5 * 3_600_000, 100), one(prev + 17 * 3_600_000, 5)];
    const stale = todayRec(B, 'phone', all, instant);                      // 曲线停在 20:30
    assert.equal(stale.body.windowEnd, prev + 20 * 3_600_000 + 1_800_000);
    const { entries } = aggregateLeaderboard({ selfAuthor: A, selfSourceId: 'me', friends: [{ author: B }], from, to, todayRecords: [stale], dayRecords: [dayRec(B, 'phone', all)] });
    assert.equal(entries.find(e => e.author === B).input, 5);
  });
});

test('榜单 sources：每个（作者, 来源）一份合计，本机的标 local，其余没有 local；本机用量没读到或没有身份就没有本机来源', () => {
  const day = Date.UTC(2026, 10, 20), instant = day + 4 * 3_600_000;
  const { entries, sources } = aggregateLeaderboard({
    selfAuthor: A, selfSourceId: 'machine-1', friends: [{ author: B }], from: day, to: instant, localBuckets: [one(day + 1000, 100)],
    dayRecords: [dayRec(B, 'phone', [one(day + 1000, 10)], '2026-11', 4), dayRec(A, 'machine-1', [one(day + 1000, 100)]), dayRec(A, 'tablet', [one(day + 1000, 7)], '2026-11', 2)],
    todayRecords: [todayRec(B, 'phone', [one(day + 1000, 10)], instant, 6)],
  });
  const view = sources.map(s => [s.author, s.sourceId, s.local, s.input]).sort();
  assert.deepEqual(view, [[A, 'machine-1', true, 100], [A, 'tablet', false, 7], [B, 'phone', false, 10]].sort());
  assert.deepEqual(sources.find(s => s.sourceId === 'tablet').models.map(m => [m.model, m.totalTokens]), [['opus', 7]]);
  assert.equal(entries.find(e => e.author === A).input, 107, '作者的合计就是它名下各来源之和');
  assert.deepEqual(aggregateLeaderboard({ from: day, to: instant, localBuckets: [one(day + 1000, 100)] }).sources, []);
  const failed = aggregateLeaderboard({ selfAuthor: A, selfSourceId: 'machine-1', from: day, to: instant, localBuckets: null, dayRecords: [dayRec(A, 'machine-1', [one(day + 1000, 100)])] });
  assert.deepEqual(failed.sources.map(s => [s.sourceId, s.local, s.input]), [['machine-1', false, 100]], '本机用量没读到：不交出本机来源，自己发布过的副本照常算');
});

// ——— 分层的用量行：service、asked、served ———

const SERVICE = 'coda://openai-responses/11111111-2222-3333-4444-555555555555', OTHER_SERVICE = 'coda://anthropic-messages/66666666-7777-8888-9999-000000000000';
const counts0 = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, reportedTurns: 0 };
// 分层的桶：没有旧标签；Token 在带 served 的行上，轮数在请求行（served 为 null）上。
const layered = (start, over = {}) => ({ start, person: '', agent: 'codex', service: SERVICE, asked: 'gpt-5', served: null, ...counts0, ...over });
const tokensOf = input => ({ input, output: 0, cacheRead: 0, cacheWrite: 0 });
const turnsOf = n => ({ turns: n, reportedTurns: n });

test('拉桶：同桶内 service、asked、served、person 不同的行各自保留，不互相覆盖', async () => {
  const rows = [
    layered(DAY0, { ...turnsOf(1) }),
    layered(DAY0, { served: 'gpt-5-2025', ...tokensOf(10) }),
    layered(DAY0, { service: OTHER_SERVICE, ...turnsOf(1) }),
    layered(DAY0, { asked: 'gpt-5-mini', served: 'gpt-5-mini', ...tokensOf(3) }),
    layered(DAY0, { person: A, served: 'gpt-5-2025', ...tokensOf(7) }),
    layered(DAY0, { agent: 'claude', ...turnsOf(1) }),
    bucket(DAY0, { person: '' }),
  ];
  const { query } = service(rows);
  const { buckets } = await fetchUsageBuckets(query, { from: DAY0, to: DAY0 + BUCKET_MS });
  assert.equal(buckets.length, rows.length);
  const again = await fetchUsageBuckets(service([...rows].reverse()).query, { from: DAY0, to: DAY0 + BUCKET_MS });
  assert.deepEqual(again.buckets, buckets, '返回顺序与来源的先后无关');
});

test('本机行按身份归属：person 是当前根身份或空字符串的算，别的身份的不算', () => {
  const list = [layered(DAY0, { person: A }), layered(DAY0, { person: '' }), layered(DAY0, { person: B }), bucket(DAY0 + BUCKET_MS), layered(DAY0 + 2 * BUCKET_MS, { person: A, served: 'x' })];
  assert.deepEqual(ownBuckets(list, A).map(row => [row.person ?? null, row.start - DAY0]), [[A, 0], ['', 0], [null, BUCKET_MS], [A, 2 * BUCKET_MS]]);
  assert.deepEqual(ownBuckets(list, null).map(row => row.person ?? ''), ['', '']);
});

test('型号名：served，没有取归并名 same，再没有取 asked，再没有取旧标签', () => {
  assert.equal(modelName({ asked: 'a', served: 's', model: null }), 's');
  assert.equal(modelName({ asked: 'a', served: null, model: null }), 'a');
  assert.equal(modelName({ asked: null, served: null, model: 'label' }), 'label');
  assert.equal(modelName({ asked: 'a', served: 's', same: 'u' }), 's', '实际型号优先');
  assert.equal(modelName({ asked: 'a', served: null, same: 'u' }), 'u');
  assert.equal(modelName({ asked: null, served: null, model: null, api: 'openai-responses' }), 'openai-responses');
  assert.equal(serviceKind(SERVICE), 'openai-responses');
  assert.equal(serviceKind(null), null);
});

test('型号行：同一型号名经两个请求项合成一行，展开得到两项；旧标签与分层行同名也合；服务的 UUID 不出现', () => {
  const rows = [
    layered(DAY0, { served: 'gpt-5-2025', ...tokensOf(10) }),
    layered(DAY0, { asked: 'gpt-5-latest', served: 'gpt-5-2025', ...tokensOf(5) }),
    layered(DAY0, { service: OTHER_SERVICE, asked: 'gpt-5-2025', ...tokensOf(2) }),   // 没有 served：型号名取 asked，同名合并
    bucket(DAY0, { model: 'gpt-5-2025', input: 1, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, reportedTurns: 0 }),
  ];
  const { models, totalTokens } = summarizeBuckets(rows, { from: DAY0, to: DAY0 + BUCKET_MS });
  assert.equal(totalTokens, 18);
  assert.deepEqual(models.map(m => [m.model, m.totalTokens]), [['gpt-5-2025', 18]]);
  assert.deepEqual(models[0].items.map(item => [item.asked, item.api, item.totalTokens]),
    [['gpt-5', 'openai-responses', 10], ['gpt-5-latest', 'openai-responses', 5], ['gpt-5-2025', 'anthropic-messages', 2], ['gpt-5-2025', null, 1]]);
  assert.ok(!JSON.stringify(models).includes('11111111'));
});

test('轮数：请求行的轮数记到同一请求项下 Token 最多的型号行，同一轮不在两行各算一次', () => {
  const rows = [
    layered(DAY0, { ...turnsOf(3) }),
    layered(DAY0, { served: 'gpt-5-2025', ...tokensOf(10) }),
    layered(DAY0, { served: 'gpt-5-mini', ...tokensOf(4) }),
    layered(DAY0, { asked: 'o3', ...turnsOf(2), ...tokensOf(6) }),   // 请求行自己带 Token：轮数留在它自己身上
  ];
  const sum = summarizeBuckets(rows, { from: DAY0, to: DAY0 + BUCKET_MS });
  assert.equal(sum.turns, 5);
  assert.deepEqual(sum.models.map(m => [m.model, m.totalTokens, m.turns]), [['gpt-5-2025', 10, 3], ['o3', 6, 2], ['gpt-5-mini', 4, 0]]);
  assert.deepEqual(sum.models[0].items.map(item => [item.asked, item.turns]), [['gpt-5', 3]]);
  assert.equal(sum.models.reduce((n, m) => n + m.turns, 0), sum.turns);
  assert.deepEqual(summarizeBuckets([layered(DAY0, { ...turnsOf(2) })], { from: DAY0, to: DAY0 + BUCKET_MS }).models.map(m => [m.model, m.turns]), [['gpt-5', 2]], '请求项下没有型号行：轮数留在请求行');
  const settled = settleTurns([{ agent: 'a', api: null, asked: 'x', served: null, model: null, ...counts0, ...turnsOf(1) }, { agent: 'a', api: null, asked: 'x', served: 's', model: null, ...counts0, input: 1 }]);
  assert.deepEqual(settleTurns(settled), settled, '已落定的行再落定不变');
});

test('新版签名记录：生成后读回得到同样的聚合；不带服务的 UUID；旧标签行照原样', () => {
  const at = DAY0 + 3_600_000;
  const list = [
    layered(at, { ...turnsOf(3) }), layered(at, { served: 'gpt-5-2025', ...tokensOf(10), output: 4 }), layered(at + BUCKET_MS, { served: 'gpt-5-mini', ...tokensOf(3) }),
    layered(at, { service: OTHER_SERVICE, asked: 'gpt-5-2025', ...tokensOf(2), ...turnsOf(1) }),
    bucket(at, { agent: 'claude' }), layered(at, { agent: 'claude', model: undefined, asked: 'opus', ...turnsOf(1) }),
  ];
  const body = buildArchiveBodies(list)['2026-11'], today = buildTodayBody(list, { now: at + 5 * 60_000 });
  const text = JSON.stringify([body, today]);
  assert.ok(!text.includes('11111111') && !text.includes('coda://'), '服务引用不出这台机器，只留接口种类');
  assert.ok(text.includes('"i":"openai-responses"'));
  const expected = summarizeBuckets(list, { from: DAY0, to: DAY0 + DAY_MS });
  const fromRecords = read => { const tally = new Tally(); for (const row of read) tally.add(row); return tally.result(); };
  const day = readArchiveRecord({ id: 'dev/2026-11', body });
  assert.deepEqual(fromRecords(day.days.flatMap(d => d.rows)), expected);
  const slots = readTodayRecord({ id: 'dev', body: today });
  assert.deepEqual(fromRecords(slots.slots.flatMap(slot => slot.rows)), expected);
  assert.ok(expected.models.some(m => m.model === 'opus' && m.items[0].api === null), '旧标签行还是旧标签');
});

test('v2 与旧版 coda/token-usage 仍可读：旧记录按旧标签显示', () => {
  const day = Date.UTC(2026, 10, 20), at = day + 3_600_000, args = { selfAuthor: A, selfSourceId: 'me', friends: [{ author: B }], from: day, to: day + DAY_MS };
  const v2 = { author: B, kind: 'coda/token-day', id: 'old-dev/2026-11', version: 1, body: { v: 2, days: { '2026-11-20': { claude: { opus: [10, 5, 100, 1, 2, 2], haiku: [1, 0, 0, 0, 1, 1] } } } } };
  const v2today = { author: B, kind: 'coda/token-today', id: 'old-dev', version: 1, body: { v: 2, slotMs: 1_800_000, windowStart: day, windowEnd: day + DAY_MS, slots: { [at]: { claude: { opus: [20, 0, 0, 0, 1, 1] } } } } };
  const usage = { author: B, kind: 'coda/token-usage', id: '2026-11-20/legacy-dev', version: 1, body: { blocks: { '01:00': { claude: { sonnet: { input: 7, output: 0, cacheRead: 0, cacheWrite: 0, turns: 1, reportedTurns: 1 } } } } } };
  const entry = records => aggregateLeaderboard({ ...args, ...records }).entries.find(e => e.author === B);
  assert.deepEqual(entry({ dayRecords: [v2] }).models.map(m => [m.model, m.input, m.items.map(item => [item.asked, item.api])]), [['opus', 10, [['opus', null]]], ['haiku', 1, [['haiku', null]]]]);
  assert.equal(entry({ todayRecords: [v2today] }).input, 20);
  assert.deepEqual(entry({ legacyUsageRecords: [usage] }).models.map(m => [m.model, m.input]), [['sonnet', 7]]);
});

test('新版记录读取：坏行丢掉（旧标签与 asked/served 同用、没有任何名字、计数不合格、接口种类乱写、名字类型或长度不对）；只带服务的行保留', () => {
  const good = { a: 'gpt-5', s: 'gpt-5-2025', i: 'openai-responses', n: ROW };
  const bad = [{ a: 'x', m: 'label', n: ROW }, { n: ROW }, { a: 'x', n: [1, 2] }, { a: 'x', i: 'Bad Kind!', n: ROW }, { a: '', n: ROW }, { a: 'x\u0000y', n: ROW }, { a: 'x'.repeat(201), n: ROW }, { a: 5, n: ROW }, null, 'x'];
  const body = { v: 3, days: { '2026-11-03': { codex: [good, { m: 'label', n: ROW }, { s: 'only-served', n: ROW }, { i: 'openai-responses', n: ROW }, ...bad], claude: { opus: ROW } } } };
  const read = readArchiveRecord({ id: 'dev/2026-11', body });
  assert.deepEqual(read.days[0].rows.map(row => [row.agent, row.asked, row.served, row.api, row.model]),
    [['codex', 'gpt-5', 'gpt-5-2025', 'openai-responses', null], ['codex', null, null, null, 'label'], ['codex', null, 'only-served', null, null], ['codex', null, null, 'openai-responses', null]]);
});

test('超过预算：新结构逐级折叠到 other 再只留总量，结果确定、不超限、总量（含轮数）不变', () => {
  const list = [];
  for (let d = 0; d < 3; d++) for (let m = 0; m < 700; m++) list.push(layered(DAY0 + d * DAY_MS, { asked: `req-${m}-${'x'.repeat(24)}`, served: `model-${m}-${'y'.repeat(24)}`, ...tokensOf(m + 1) }),
    layered(DAY0 + d * DAY_MS, { asked: `req-${m}-${'x'.repeat(24)}`, ...turnsOf(1) }));
  const bodies = buildArchiveBodies(list, { maxBytes: 20_000 });
  assert.ok(Object.values(bodies).every(body => bytes(body) <= 20_000));
  assert.deepEqual(buildArchiveBodies([...list].reverse(), { maxBytes: 20_000 }), bodies, '折叠与输入顺序无关');
  assert.deepEqual(buildArchiveBodies(list, { maxBytes: 20_000 }), bodies);
  const rows = Object.values(bodies).flatMap(body => Object.values(body.days)).flatMap(agents => Object.values(agents)).flat();
  assert.ok(rows.some(row => row.m === 'other'), '小型号并进 other');
  assert.deepEqual(sumRows(bodies), [3 * 700 * 701 / 2, 0, 0, 0, 3 * 700, 3 * 700]);
  const total = buildArchiveBodies(list, { maxBytes: 2_000 });
  assert.ok(Object.values(total).every(body => bytes(body) <= 2_000));
  assert.deepEqual(sumRows(total), sumRows(bodies));
});

// 本机聚合与两种签名记录读回后的聚合：型号明细（含 Token 与轮数）要一致。
const viaRecords = (list, from, to, now) => {
  const fromRows = rows => { const tally = new Tally(); for (const row of rows) tally.add(row); return tally.result(); };
  const archive = Object.entries(buildArchiveBodies(list)).flatMap(([month, body]) => readArchiveRecord({ id: `dev/${month}`, body }).days.flatMap(day => day.rows.map(row => ({ ...row, start: day.start }))));
  const slots = readTodayRecord({ id: 'dev', body: buildTodayBody(list, { now }) }).slots.flatMap(slot => slot.rows);
  return { archive: fromRows(archive), today: fromRows(slots), local: summarizeBuckets(list, { from, to }) };
};

test('轮数只在读取端的聚合里分配：同一请求项跨两个曲线槽、两个日块，各槽型号不同，本机与两种记录读回的型号明细一致，记录里保留只有轮数的请求行', () => {
  const t1 = DAY0 + 3_600_000, t2 = DAY0 + DAY_MS + 3_600_000;   // 两个 UTC 日、两个 30 分钟槽，都在 now 前 48 小时内
  const list = [
    layered(t1, turnsOf(2)), layered(t1, { served: 'model-a', ...tokensOf(10) }),
    layered(t2, turnsOf(3)), layered(t2, { served: 'model-b', ...tokensOf(20) }),
  ];
  const now = t2 + 5 * 60_000, body = buildArchiveBodies(list)['2026-11'], today = buildTodayBody(list, { now });
  const requestRows = rows => rows.filter(row => row.a === 'gpt-5' && row.s === undefined);
  assert.deepEqual(Object.values(body.days).flatMap(agents => requestRows(agents.codex)).map(row => row.n[4]), [2, 3], '日块里请求行的轮数原样保留');
  assert.deepEqual(Object.values(today.slots).flatMap(agents => requestRows(agents.codex)).map(row => row.n[4]), [2, 3], '曲线槽里也是');
  const { archive, today: fromToday, local } = viaRecords(list, DAY0, DAY0 + 3 * DAY_MS, now);
  assert.deepEqual(local.models.map(m => [m.model, m.totalTokens, m.turns]), [['model-b', 20, 5], ['model-a', 10, 0]], '窗口内 Token 最多的型号拿全部轮数');
  assert.deepEqual(archive.models, local.models);
  assert.deepEqual(fromToday.models, local.models);
  assert.equal(local.turns, 5);
});

test('asked、served、旧标签是身份：只有内部空白不同的两个 asked 往返后仍是两项，记录里原样保存', () => {
  const list = [layered(DAY0, { asked: 'gpt  5', ...tokensOf(1) }), layered(DAY0, { asked: 'gpt 5', ...tokensOf(2) }), layered(DAY0, { agent: 'claude', model: ' pad  ded ', asked: null, service: null, ...tokensOf(4) })];
  const now = DAY0 + 5 * 60_000, { archive, today, local } = viaRecords(list, DAY0, DAY0 + DAY_MS, now);
  assert.deepEqual(local.models.map(m => [m.model, m.totalTokens]), [[' pad  ded ', 4], ['gpt 5', 2], ['gpt  5', 1]]);
  assert.deepEqual(archive.models, local.models);
  assert.deepEqual(today.models, local.models);
});

test('只带 service 的行：两种记录都保留（Token 不丢），明细里显示接口种类名，往返一致', () => {
  const list = [layered(DAY0, { asked: null, ...tokensOf(50), ...turnsOf(1) }), layered(DAY0, { asked: 'gpt-5', served: 'gpt-5-2025', ...tokensOf(5) })];
  const now = DAY0 + 5 * 60_000, { archive, today, local } = viaRecords(list, DAY0, DAY0 + DAY_MS, now);
  assert.equal(local.totalTokens, 55);
  assert.deepEqual(local.models.map(m => [m.model, m.totalTokens, m.turns, m.items.map(item => [item.asked, item.api])]),
    [['openai-responses', 50, 1, [[null, 'openai-responses']]], ['gpt-5-2025', 5, 0, [['gpt-5', 'openai-responses']]]]);
  assert.deepEqual(archive.models, local.models);
  assert.deepEqual(today.models, local.models);
  assert.equal(archive.totalTokens, 55);
});

// ——— 同型号映射（Magpie）：只套本机行，展开仍是原请求项 ———

const SERVICES = [SERVICE, OTHER_SERVICE], FOREIGN = 'coda://openai-responses/99999999-8888-7777-6666-555555555555';   // 本机 Magpie 插件提供的服务；另一台的 Magpie 的服务
const NAMES = { 'group/ds-flash': 'deepseek-v4.1-flash', 'opencode-go/deepseek-v4.1-flash': 'deepseek-v4.1-flash', 'auto/gpt-5': 'gpt-5' };
const viaMagpie = (start, asked, over = {}) => layered(start, { asked, ...tokensOf(10), ...turnsOf(1), ...over });

test('markSame：只套带服务、没有 served、asked 在映射里的本机行；有 served、旧标签、没有服务、不在映射里的原样；不改原桶', () => {
  const rows = [viaMagpie(DAY0, 'group/ds-flash'), viaMagpie(DAY0, 'group/ds-flash', { served: 'real' }), viaMagpie(DAY0, 'group/ds-flash', { service: null }),
    bucket(DAY0, { model: 'group/ds-flash' }), viaMagpie(DAY0, 'other/model'), viaMagpie(DAY0, 'constructor'), viaMagpie(DAY0, '__proto__'), viaMagpie(DAY0, 'group/ds-flash', { service: FOREIGN })];
  const marked = markSame(rows, NAMES, SERVICES);
  assert.deepEqual(marked.map(row => row.same), ['deepseek-v4.1-flash', undefined, undefined, undefined, undefined, undefined, undefined, undefined], '别台的 Magpie 的服务，asked 命中也不套');
  assert.deepEqual(markSame(rows, NAMES, []), rows, '不知道哪些是本机 Magpie 的服务：一个都不套');
  assert.equal(rows[0].same, undefined);
  assert.deepEqual(markSame(rows, {}, SERVICES), rows);
  assert.deepEqual([needsSame(rows), needsSame(rows.slice(1, 4)), needsSame([])], [true, false, false]);
});

test('本机行套映射：同型号的请求项并成一个型号行，展开得到原来的 asked 与接口种类；有 served 的行不套', () => {
  const rows = markSame([viaMagpie(DAY0, 'group/ds-flash'), viaMagpie(DAY0, 'opencode-go/deepseek-v4.1-flash', { service: OTHER_SERVICE, ...tokensOf(20) }), viaMagpie(DAY0, 'auto/gpt-5'),
    viaMagpie(DAY0, 'group/ds-flash', { served: 'real-model', ...tokensOf(3) }), layered(DAY0, { asked: 'deepseek-v4.1-flash', ...tokensOf(5) })], NAMES, SERVICES);
  const { models } = summarizeBuckets(rows, { from: DAY0, to: DAY0 + BUCKET_MS });
  assert.deepEqual(models.map(m => [m.model, m.totalTokens]), [['deepseek-v4.1-flash', 35], ['gpt-5', 10], ['real-model', 3]]);
  assert.deepEqual(models[0].items.map(item => [item.asked, item.api, item.totalTokens]),
    [['opencode-go/deepseek-v4.1-flash', 'anthropic-messages', 20], ['group/ds-flash', 'openai-responses', 10], ['deepseek-v4.1-flash', 'openai-responses', 5]]);
  assert.deepEqual(models[2].items.map(item => item.asked), ['group/ds-flash'], '有 served 的行不套，请求项还是 asked');
  assert.ok(!JSON.stringify(models).includes('11111111'));
});

test('映射为空或不命中：结果与不映射完全相同', () => {
  const rows = [viaMagpie(DAY0, 'group/ds-flash'), viaMagpie(DAY0, 'x/y', { served: 'z' }), bucket(DAY0)];
  const plain = summarizeBuckets(rows, { from: DAY0, to: DAY0 + BUCKET_MS });
  assert.deepEqual(summarizeBuckets(markSame(rows, {}, SERVICES), { from: DAY0, to: DAY0 + BUCKET_MS }), plain);
  assert.deepEqual(summarizeBuckets(markSame(rows, { 'nothing/here': 'q' }, SERVICES), { from: DAY0, to: DAY0 + BUCKET_MS }), plain);
});

test('签名记录带归并名 u：asked、接口种类照旧，不混进 a 或 s；写出再读回，聚合与本机一样；没有归并的行不带 u', () => {
  const at = DAY0 + 3_600_000;
  const list = markSame([viaMagpie(at, 'group/ds-flash'), viaMagpie(at, 'opencode-go/deepseek-v4.1-flash', { service: OTHER_SERVICE }), viaMagpie(at, 'plain-model'),
    viaMagpie(at, 'group/ds-flash', { served: 'real-model' })], NAMES, SERVICES);
  const body = buildArchiveBodies(list)['2026-11'], today = buildTodayBody(list, { now: at + 5 * 60_000 });
  const rows = body.days['2026-11-01'].codex;
  assert.deepEqual(rows.map(row => [row.a, row.s ?? null, row.u ?? null, row.i]).sort((a, b) => (a[0] + a[1] < b[0] + b[1] ? -1 : 1)),
    [['group/ds-flash', null, 'deepseek-v4.1-flash', 'openai-responses'], ['group/ds-flash', 'real-model', null, 'openai-responses'],
      ['opencode-go/deepseek-v4.1-flash', null, 'deepseek-v4.1-flash', 'anthropic-messages'], ['plain-model', null, null, 'openai-responses']]);
  const expected = summarizeBuckets(list, { from: DAY0, to: DAY0 + DAY_MS });
  const fromRecords = read => { const tally = new Tally(); for (const row of read) tally.add(row); return tally.result(); };
  assert.deepEqual(fromRecords(readArchiveRecord({ id: 'dev/2026-11', body }).days.flatMap(d => d.rows)), expected);
  assert.deepEqual(fromRecords(readTodayRecord({ id: 'dev', body: today }).slots.flatMap(slot => slot.rows)), expected);
  assert.deepEqual(expected.models.find(m => m.model === 'deepseek-v4.1-flash').items.map(item => item.asked).sort(), ['group/ds-flash', 'opencode-go/deepseek-v4.1-flash']);
});

test('读到别人记录里的 u 就用它；没有 u 的行不拿本机映射去套（映射只在 markSame 里套本机桶）', () => {
  const at = DAY0 + 3_600_000, day = DAY0;
  const line = (extra, n = [10, 0, 0, 0, 1, 1]) => ({ a: 'group/ds-flash', i: 'openai-responses', ...extra, n });
  const record = rows => ({ author: B, kind: 'coda/token-day', id: 'dev-b/2026-11', version: 1, body: { v: 3, days: { '2026-11-01': { codex: rows } } } });
  const board = aggregateLeaderboard({ selfAuthor: A, selfSourceId: 'me', friends: [{ author: B }], from: day, to: day + DAY_MS, localBuckets: markSame([viaMagpie(at, 'group/ds-flash')], NAMES, SERVICES),
    dayRecords: [record([line({ u: 'their-name' }), line({}, [5, 0, 0, 0, 0, 0]), line({ s: 'real', u: 'ignored' }, [7, 0, 0, 0, 0, 0])])] });
  assert.deepEqual(board.entries.find(entry => entry.author === A).models.map(m => m.model), ['deepseek-v4.1-flash']);
  assert.deepEqual(board.entries.find(entry => entry.author === B).models.map(m => [m.model, m.totalTokens]).sort(), [['group/ds-flash', 5], ['real', 7], ['their-name', 10]].sort());
  assert.deepEqual(board.entries.find(entry => entry.author === B).models.find(m => m.model === 'their-name').items.map(item => [item.asked, item.api]), [['group/ds-flash', 'openai-responses']]);
  for (const bad of [{ u: '' }, { u: 5 }, { u: 'x'.repeat(201) }, { u: 'a\0b' }]) assert.equal(readArchiveRecord(record([line(bad)])).days[0].rows.length, 0, JSON.stringify(bad));
  assert.equal(readArchiveRecord(record([{ m: 'label', u: 'x', n: [1, 0, 0, 0, 0, 0] }])).days[0].rows.length, 0, '旧标签行不带 u');
});

test('超出预算折叠小型号时按归并后的型号名算', () => {
  const at = DAY0 + 3_600_000;
  const list = markSame([viaMagpie(at, 'group/ds-flash', tokensOf(100)), viaMagpie(at, 'opencode-go/deepseek-v4.1-flash', tokensOf(100)), viaMagpie(at, 'tiny/model', tokensOf(1))], NAMES, SERVICES);
  const small = buildTodayBody(list, { now: at, maxBytes: JSON.stringify(buildTodayBody(list, { now: at })).length - 10 });
  const rows = Object.values(small.slots).flatMap(agents => Object.values(agents).flat());
  assert.deepEqual(rows.map(row => row.u ?? row.m ?? row.a).sort(), ['deepseek-v4.1-flash', 'deepseek-v4.1-flash', 'other']);
});

test('不属于本机 Magpie 的服务的行：asked 命中映射也不归并，不进签名记录的归并名', () => {
  const at = DAY0 + 3_600_000;
  const list = markSame([viaMagpie(at, 'group/ds-flash'), viaMagpie(at, 'group/ds-flash', { service: FOREIGN, ...tokensOf(5) })], NAMES, SERVICES);
  const { models } = summarizeBuckets(list, { from: DAY0, to: DAY0 + DAY_MS });
  assert.deepEqual(models.map(m => [m.model, m.totalTokens, m.items.map(item => item.asked)]), [['deepseek-v4.1-flash', 10, ['group/ds-flash']], ['group/ds-flash', 5, ['group/ds-flash']]]);
  const rows = buildArchiveBodies(list)['2026-11'].days['2026-11-01'].codex;
  assert.deepEqual(rows.map(row => [row.a, row.u ?? null, row.n[0]]).sort((a, b) => a[2] - b[2]), [['group/ds-flash', null, 5], ['group/ds-flash', 'deepseek-v4.1-flash', 10]]);
});

// ——— Claude 官方直连：历史上 served 单独成行、asked 单独成行，不能拆成两条同名子项 ———
const OPUS = 'claude-opus-5-5';
const direct = (over = {}) => ({ agent: 'claude', api: null, asked: null, served: null, same: null, model: null, ...counts0, ...over });
const sumOf = list => { const tally = new Tally(); for (const row of list) tally.add(row); return tally.result(); };

test('settleTurns：历史上只有 served 的行接住同名请求行的回合；同 (agent, api, asked) 组内精确匹配始终优先', () => {
  const settled = settleTurns([direct({ served: OPUS, ...tokensOf(100) }), direct({ asked: OPUS, ...turnsOf(3) })]);
  assert.deepEqual(settled.map(row => [row.asked, row.served, row.input, row.turns, row.reportedTurns]), [[null, OPUS, 100, 3, 3]]);
  const exact = settleTurns([direct({ served: OPUS, ...tokensOf(100) }), direct({ asked: OPUS, served: OPUS, ...tokensOf(1) }), direct({ asked: OPUS, ...turnsOf(2) })]);
  assert.deepEqual(exact.map(row => [row.asked, row.input, row.turns]), [[null, 100, 0], [OPUS, 1, 2]], '组内有带 Token 的型号行：回合记在它上面，不去找 served-only 行');
});

test('settleTurns：不跨 Agent、不跨接口，served 必须等于请求行的 asked；Opus 的回合不会记给 Haiku', () => {
  const rows = [
    direct({ agent: 'main', served: OPUS, ...tokensOf(100) }), direct({ agent: 'sub', served: 'claude-haiku-5-5', ...tokensOf(900) }),
    direct({ agent: 'main', asked: OPUS, ...turnsOf(2) }), direct({ agent: 'sub', asked: OPUS, ...turnsOf(5) }),
    direct({ agent: 'main', api: 'anthropic-messages', asked: OPUS, ...turnsOf(7) }),
  ];
  const settled = settleTurns(rows);
  const turnsAt = (agent, served, asked, api = null) => settled.filter(row => row.agent === agent && row.api === api && row.served === served && row.asked === asked).reduce((n, row) => n + row.turns, 0);
  assert.equal(turnsAt('main', OPUS, null), 2);
  assert.equal(turnsAt('sub', 'claude-haiku-5-5', null), 0, 'Haiku 行分不到 Opus 的回合');
  assert.equal(turnsAt('sub', null, OPUS), 5, 'sub 下没有 served 为 Opus 的行：回合留在请求行');
  assert.equal(turnsAt('main', null, OPUS, 'anthropic-messages'), 7, '另一个接口的行不接');
  assert.equal(settled.reduce((n, row) => n + row.turns, 0), 14);
});

test('Tally：served-only 行与同名请求行（含恢复首轮带的少量 loose Token）合成一条子项，Token 与回合守恒', () => {
  const rows = [direct({ served: OPUS, input: 1000, output: 10, cacheRead: 5000, cacheWrite: 40 }), direct({ asked: OPUS, ...turnsOf(149) }), direct({ asked: OPUS, input: 3, ...turnsOf(1) })];
  const { models, totalTokens, turns } = sumOf(rows);
  assert.equal(models.length, 1);
  assert.deepEqual(models[0].items.map(item => [item.asked, item.api, item.totalTokens, item.turns]), [[OPUS, null, 6053, 150]]);
  assert.deepEqual([totalTokens, turns, models[0].totalTokens, models[0].turns], [6053, 150, 6053, 150]);
  assert.deepEqual(models[0].agents.map(a => [a.agent, a.totalTokens, a.turns]), [['claude', 6053, 150]]);
  const { models: only } = sumOf([direct({ served: OPUS, ...tokensOf(5) }), direct({ asked: OPUS, ...tokensOf(1) })]);
  assert.deepEqual(only[0].items.map(item => [item.asked, item.totalTokens]), [[OPUS, 6]], '请求行带 Token、没有回合也合并');
});

test('Tally：不同别名、不同接口仍是独立子项；只带服务的行请求名保持空', () => {
  const rows = [direct({ served: OPUS, ...tokensOf(10) }), direct({ asked: 'opus', served: OPUS, ...tokensOf(5) }), direct({ api: 'anthropic-messages', asked: OPUS, served: OPUS, ...tokensOf(2) }), direct({ api: 'openai-responses', ...tokensOf(1) })];
  const { models } = sumOf(rows);
  assert.deepEqual(models.find(m => m.model === OPUS).items.map(item => [item.asked, item.api, item.totalTokens]), [[OPUS, null, 10], ['opus', null, 5], [OPUS, 'anthropic-messages', 2]]);
  assert.deepEqual(models.find(m => m.model === 'openai-responses').items.map(item => [item.asked, item.api]), [[null, 'openai-responses']]);
});

test('Tally：agents 按（型号, Agent）汇总四项与回合，按 Token、回合、Agent 名排序，与型号行守恒', () => {
  const rows = [
    direct({ agent: 'b', served: OPUS, input: 10, output: 1, cacheRead: 2, cacheWrite: 3, ...turnsOf(1) }), direct({ agent: 'a', served: OPUS, input: 10, output: 1, cacheRead: 2, cacheWrite: 3, ...turnsOf(1) }),
    direct({ agent: 'b', served: OPUS, input: 4 }), direct({ agent: 'c', served: OPUS, ...tokensOf(100) }), direct({ agent: 'a', asked: OPUS, ...turnsOf(2) }),
  ];
  const [model] = sumOf(rows).models;
  assert.deepEqual(model.agents, [
    { agent: 'c', input: 100, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, reportedTurns: 0, totalTokens: 100 },
    { agent: 'a', input: 10, output: 1, cacheRead: 2, cacheWrite: 3, turns: 3, reportedTurns: 3, totalTokens: 16 },
    { agent: 'b', input: 14, output: 1, cacheRead: 2, cacheWrite: 3, turns: 1, reportedTurns: 1, totalTokens: 20 },
  ].sort((x, y) => y.totalTokens - x.totalTokens || y.turns - x.turns || (x.agent < y.agent ? -1 : 1)));
  for (const field of ['input', 'output', 'cacheRead', 'cacheWrite', 'turns', 'reportedTurns', 'totalTokens']) assert.equal(model.agents.reduce((n, a) => n + a[field], 0), model[field], field);
});

test('Tally.addModel：合并另一份结果时 items 与 agents 同口径相加，合并后与一次性汇总相同', () => {
  const left = [direct({ agent: 'a', served: OPUS, ...tokensOf(10) }), direct({ agent: 'a', asked: OPUS, ...turnsOf(2) })];
  const right = [direct({ agent: 'b', served: OPUS, ...tokensOf(5) }), direct({ agent: 'b', asked: OPUS, ...turnsOf(1) }), direct({ agent: 'a', served: OPUS, ...tokensOf(1) })];
  const merged = new Tally();
  for (const result of [sumOf(left), sumOf(right)]) for (const model of result.models) merged.addModel(model);
  const once = sumOf([...left, ...right]);
  assert.deepEqual(merged.result().models, once.models);
  assert.deepEqual(once.models[0].items.map(item => [item.asked, item.totalTokens, item.turns]), [[OPUS, 16, 3]]);
});
