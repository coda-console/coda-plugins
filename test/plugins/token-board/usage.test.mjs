// Token 消耗榜的纯逻辑：24 小时分片与截断二分、每日汇总、名片清洗、排行榜汇总与排序。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BUCKET_MS, DAY_MS, aggregateLeaderboard, buildDailyUsageBodies, fetchUsageBuckets, rangeWindow, sanitizeProfile, shortAuthor, summarizeBuckets,
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

test('名片清洗：去控制字符、截断、颜色只认 #RRGGBB、缺字段回退', () => {
  assert.deepEqual(sanitizeProfile({ body: { name: '  小\u0000明\n\t同学‮ ', emoji: '🦊', color: '#FF8800' } }), { name: '小 明 同学', emoji: '🦊', color: '#ff8800' });
  assert.equal(sanitizeProfile({ body: { name: 'x'.repeat(100) } }).name.length, 40);
  assert.equal(Array.from(sanitizeProfile({ body: { name: '😀'.repeat(60) } }).name).length, 40);
  assert.equal(Array.from(sanitizeProfile({ body: { emoji: '😀'.repeat(20) } }).emoji).length, 8);
  assert.equal(sanitizeProfile({ body: { color: 'red; background:url(x)' } }).color, null);
  assert.equal(sanitizeProfile({ body: { name: '<img src=x onerror=alert(1)>' } }).name, '<img src=x onerror=alert(1)>', '当文本留着，由页面用 textContent 渲染');
  assert.deepEqual(sanitizeProfile({ body: { name: 42, emoji: { a: 1 }, color: [] } }), { name: null, emoji: null, color: null });
  assert.deepEqual(sanitizeProfile({ body: { name: '\u0000\u0001  ' } }), { name: null, emoji: null, color: null });
  for (const bad of [null, undefined, {}, { body: null }, { body: 'x' }, 7]) assert.deepEqual(sanitizeProfile(bad), { name: null, emoji: null, color: null });
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
    friendUsageRecords: [
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
    friendUsageRecords: [
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
    friendUsageRecords: [
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
    friendUsageRecords: [
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
    friendUsageRecords: [evil, { author: B, kind: 'coda/token-usage', id: 'bad-id', version: 1, body: null }, { author: B, kind: 'coda/token-usage', id: '2026-13-45/x', version: 1, body: { blocks: {} } }] });
  const b = entries.find(e => e.author === B);
  assert.equal(b.totalTokens, 0);
  assert.equal(b.turns, 3);
  assert.ok(b.models.every(m => typeof m.model === 'string' && !/[\u0000-\u001f]/.test(m.model)));
});

test('名片：同一作者取最新版本；缺名片时没有名字（页面回退短码）', () => {
  const { entries } = aggregateLeaderboard({
    selfAuthor: A, selfSourceId: 'me', from: FROM, to: TO, friends: [{ author: B }, { author: C }],
    profileRecords: [
      { author: B, kind: 'profile', id: 'self', version: 1, body: { name: '旧名' } },
      { author: B, kind: 'profile', id: 'self', version: 5, body: { name: '新\u0007名', emoji: '🐼' } },
      { author: 'ed25519:' + 'd'.repeat(64), kind: 'profile', id: 'self', version: 9, body: { name: '陌生人' } },
    ],
  });
  const b = entries.find(e => e.author === B), c = entries.find(e => e.author === C);
  assert.equal(b.name, '新 名');
  assert.equal(b.emoji, '🐼');
  assert.equal(c.name, null);
  assert.equal(c.shortId, 'cccccccc');
  assert.ok(!entries.some(e => e.name === '陌生人'));
});

test('排序：总 Token 降序，平局按回合数降序，再按 author 升序', () => {
  const { entries } = aggregateLeaderboard({
    selfAuthor: A, selfSourceId: 'me', from: FROM, to: TO, friends: [{ author: B }, { author: C }],
    friendUsageRecords: [
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
