// Token 消耗榜的纯逻辑：24 小时分片与截断二分、月块日归档与 48 小时曲线、person 切片、名片清洗、排行榜汇总与排序、当天曲线、跨记录无双计。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BUCKET_MS, DAY_MS, aggregateLeaderboard, aggregateTodayCurve, buildArchiveBodies, buildDailyUsageBodies, buildTodayBody, fetchUsageBuckets, filterBucketsByPerson,
  isWithdrawn, ownedBySource, rangeWindow, readArchiveRecord, readTodayRecord, sanitizeProfile, shortAuthor, summarizeBuckets, withdrawnBody,
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

test('名片清洗：只提取头像与颜色，头像去控制字符并截断', () => {
  assert.deepEqual(sanitizeProfile({ body: { name: '名片名', emoji: ' \u0000🦊\n ', color: '#FF8800' } }), { emoji: '🦊', color: '#ff8800' });
  assert.equal(Array.from(sanitizeProfile({ body: { emoji: '😀'.repeat(20) } }).emoji).length, 8);
  assert.deepEqual(sanitizeProfile({ body: { emoji: { a: 1 }, color: [] } }), { emoji: null, color: null });
  assert.equal(sanitizeProfile({ body: { emoji: '\u0000\u0001  ' } }).emoji, null);
  for (const bad of [null, undefined, {}, { body: null }, { body: 'x' }, 7]) assert.deepEqual(sanitizeProfile(bad), { emoji: null, color: null });
});

test('名片颜色：好友插件的命名色板和 #RRGGBB 通过，其他一律丢弃', () => {
  for (const color of ['blue', 'orange', 'green', 'purple', 'pink', 'teal', 'gray']) assert.equal(sanitizeProfile({ body: { color } }).color, color);
  assert.equal(sanitizeProfile({ body: { color: ' Blue ' } }).color, null, '命名色只认小写原样，大小写不对不当作色板');
  assert.equal(sanitizeProfile({ body: { color: '#ABCDEF' } }).color, '#abcdef');
  for (const color of ['javascript:alert(1)', 'red', 'blue; background:url(x)', 'var(--x)', '#fff', '__proto__', 'constructor', '']) assert.equal(sanitizeProfile({ body: { color } }).color, null, color);
});

test('密钥短码取 ed25519: 后 8 位', () => {
  assert.equal(shortAuthor(`ed25519:${'0123456789abcdef'.repeat(4)}`), '01234567');
  assert.equal(shortAuthor(null), '未知');
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

test('名片：仅使用已知作者的最新版本，缺名片时头像与颜色为空', () => {
  const stranger = 'ed25519:' + 'd'.repeat(64);
  const { entries } = aggregateLeaderboard({
    selfAuthor: A, selfSourceId: 'me', from: FROM, to: TO, friends: [{ author: B }, { author: C }],
    profileRecords: [
      { author: B, kind: 'profile', id: 'self', version: 1, body: { emoji: '🐶', color: 'blue' } },
      { author: B, kind: 'profile', id: 'self', version: 5, body: { emoji: '🐼', color: 'teal' } },
      { author: stranger, kind: 'profile', id: 'self', version: 9, body: { emoji: '🐈' } },
    ],
  });
  assert.deepEqual(entries.map(({ author, emoji, color }) => [author, emoji, color]), [
    [A, null, null], [B, '🐼', 'teal'], [C, null, null],
  ]);
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
  for (const agents of Object.values(body.days)) for (const models of Object.values(agents)) for (const row of Object.values(models)) row.forEach((v, i) => { total[i] += v; });
  return total;
}, [0, 0, 0, 0, 0, 0]);
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
  assert.equal(bodies['2026-11'].v, 2);
  assert.deepEqual(Object.keys(bodies['2026-11'].days), ['2026-11-01', '2026-11-02']);
  assert.deepEqual(bodies['2026-11'].days['2026-11-01'].claude.opus, [20, 10, 200, 2, 4, 4]);
  assert.deepEqual(bodies['2026-11'].days['2026-11-01'].codex.gpt, ROW);
  assert.deepEqual(buildArchiveBodies([]), {});
  assert.equal(Object.getOwnPropertyDescriptor(buildArchiveBodies([bucket(DAY0, { model: '__proto__' })])['2026-11'].days['2026-11-01'].claude, '__proto__').value.length, 6);
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
  assert.deepEqual(read.days[0].rows[0], { agent: 'claude', model: 'opus', input: 10, output: 5, cacheRead: 100, cacheWrite: 1, turns: 2, reportedTurns: 2 });
  assert.deepEqual(readArchiveRecord(record('dev-1/2026-11-2', good)).days, [], '16–31 日的块里不收 3 日');
  assert.equal(readArchiveRecord(record('dev-1/2026-11-w1', good)).days.length, 1);
  assert.equal(readArchiveRecord(record('dev-1/2026-11-w5', { v: 2, days: { '2026-11-30': { a: { b: ROW } } } })).days.length, 1);
  for (const id of ['dev-1/2026-11-3', 'dev-1/2026-11-w6', 'dev 1/2026-11', '2026-11', 'a/b/2026-11', `${'x'.repeat(101)}/2026-11`, 'dev/2026-1']) assert.equal(readArchiveRecord(record(id, good)), null, id);
  assert.equal(readArchiveRecord(record('dev-1/2026-11', { ...good, v: 1 })), null);
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
  assert.equal(body.v, 2);
  assert.equal(body.slotMs, 1_800_000);
  assert.equal(body.windowEnd, Date.UTC(2026, 10, 20, 10, 30));
  assert.equal(body.windowStart, body.windowEnd - 48 * 3_600_000);
  assert.deepEqual(Object.keys(body.slots), [String(body.windowStart), String(Date.UTC(2026, 10, 20, 10, 0))]);
  assert.deepEqual(body.slots[Date.UTC(2026, 10, 20, 10, 0)].claude.opus, [20, 10, 200, 2, 4, 4]);
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
  const total = body => Object.values(body.slots).flatMap(a => Object.values(a)).flatMap(m => Object.values(m)).reduce((n, r) => n + r[0], 0);
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
  const messy = readTodayRecord(record('dev-1', { slots: { [start]: { a: { b: ROW } }, [start + 1]: { a: { b: ROW } }, [start - 1_800_000]: { a: { b: ROW } }, [body.windowEnd]: { a: { b: ROW } }, x: { a: { b: ROW } }, [start + 1_800_000]: { a: { b: [1, 2] } } } }));
  assert.deepEqual(messy.slots.map(slot => [slot.start, slot.rows.length]), [[start, 1], [start + 1_800_000, 0]]);
  for (const id of ['a/b', 'a b', '']) assert.equal(readTodayRecord(record(id)), null, id);
  for (const over of [{ v: 1 }, { slotMs: 600_000 }, { slotMs: 'x' }, { windowStart: start + 1 }, { windowEnd: start }, { slots: null }, { windowEnd: 'x' }]) assert.equal(readTodayRecord(record('dev-1', over)), null, JSON.stringify(over));
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
  assert.ok(Object.values(bodies).some(body => JSON.stringify(body).includes('"_":{"_":[')));
  assert.deepEqual(sumRows(bodies), ROW.map(v => v * 28 * 400));
  const today = [];
  for (let i = 0; i < 288; i++) for (let a = 0; a < 400; a++) today.push(bucket(NOW - 47 * 3_600_000 + i * BUCKET_MS + 1, { agent: `agent-${a}-${'x'.repeat(20)}`, model: 'm' }));
  const body = buildTodayBody(today, { now: NOW });
  assert.ok(bytes(body) <= 60 * 1024);
  assert.equal(body.slotMs, 3_600_000);
  assert.ok(Object.values(body.slots).every(agents => Object.keys(agents).join() === '_'));
  assert.equal(Object.values(body.slots).flatMap(a => Object.values(a._)).reduce((n, row) => n + row[0], 0), 10 * today.length);
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

test('榜单：名片缺少头像或颜色时，使用好友行的对应字段', () => {
  const friends = [
    { author: B, emoji: ' \u0007🐶 ', color: 'blue' },
    { author: C, emoji: '', color: 'javascript:alert(1)' },
  ];
  const profile = (author, body) => ({ author, kind: 'profile', id: 'self', version: 1, body });
  const { entries } = aggregateLeaderboard({
    selfAuthor: A, selfSourceId: 'me', friends, from: DAY0, to: DAY0 + DAY_MS,
    profileRecords: [profile(A, { emoji: '🧑' }), profile(B, { color: 'teal' })],
  });
  assert.deepEqual(entries.map(({ author, emoji, color }) => [author, emoji, color]), [
    [A, '🧑', null], [B, '🐶', 'teal'], [C, null, null],
  ]);

  const fallback = aggregateLeaderboard({
    selfAuthor: A, selfSourceId: 'me', friends, from: DAY0, to: DAY0 + DAY_MS,
    profileRecords: [profile(B, { emoji: '🐼' })],
  }).entries.find(e => e.author === B);
  assert.equal(fallback.emoji, '🐼');
  assert.equal(fallback.color, 'blue');
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
