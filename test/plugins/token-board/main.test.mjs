// Token 消耗榜的模块，用假 coda 跑：activate 不读记录也不抛错；开启分享按内容 hash 去重发布；关闭分享以 audience [] 撤回；
// 页面消息触发同步、取榜单；deactivate 清理干净。
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { activate, deactivate } from '../../../plugins/token-board/main.mjs';

const AUTHOR = `ed25519:${'a'.repeat(64)}`, FRIEND = `ed25519:${'b'.repeat(64)}`;
const now = Date.now();
const startOfBucket = at => Math.floor(at / 600_000) * 600_000;
const counts = { input: 10, output: 5, cacheRead: 100, cacheWrite: 1, turns: 2, reportedTurns: 2 };
const bucket = (start, over = {}) => ({ start, agent: 'claude', model: 'opus', ...counts, ...over });
const mkdir = t => { const dir = mkdtempSync(join(tmpdir(), 'token-board-')); t.after(() => { deactivate(); rmSync(dir, { recursive: true, force: true }); }); return dir; };
const sourceIdOf = state => JSON.parse(readFileSync(join(state, 'source.json'), 'utf8')).sourceId;

function fake({ settings = {}, usage = [], records = [], friends = [{ node: 'n1', mode: 'x', scope: 's', author: FRIEND, bound: true, createdAt: 1, updatedAt: 1 }], accord = true, state } = {}) {
  const calls = [], published = [], views = new Map(), listeners = [];
  let current = { 'token-board.share': false, 'token-board.range': '7d', ...settings };
  const host = {
    calls, published, views,
    usage,
    coda: {
      plugin: { id: 'token-board', path: '/plugin', state },
      views: { register: (id, provider) => { views.set(id, provider); return { dispose() { views.delete(id); } }; } },
      settings: { get: async () => structuredClone(current), onChange: fn => { listeners.push(fn); return { dispose() { listeners.splice(listeners.indexOf(fn), 1); } }; } },
      get: async ref => {
        assert.equal(ref.kind, 'coda/accord@1');
        return accord ? { spec: { author: AUTHOR }, status: { friends } } : null;
      },
      query: async (ref, operation, input) => {
        calls.push([ref.kind, operation, input]);
        if (ref.kind === 'coda/usage@1') return { buckets: host.usage.filter(b => b.start >= input.from && b.start < input.to), truncated: false };
        // 自己发布过的记录，每个 id 取最新的，和 Coda 读本机记录一样。
        const mine = [...published.filter(p => p.kind === input.kind).reduce((m, p) => m.set(p.id, p), new Map()).values()]
          .map((p, i) => ({ author: AUTHOR, kind: p.kind, id: p.id, version: i + 1, body: p.body, local: true }));
        return { records: [...records, ...mine].filter(r => r.kind === input.kind && (!input.author || r.author === input.author)), truncated: false };
      },
      call: async (ref, operation, input) => {
        assert.deepEqual(ref, { kind: 'coda/accord@1', id: 'local' });
        assert.equal(operation, 'publish');
        published.push(structuredClone(input));
        return { author: AUTHOR, kind: input.kind, id: input.id, version: published.length, audience: input.audience };
      },
    },
    open() {
      const page = { got: [], tell: null };
      views.get('board').open({ postMessage: m => { page.got.push(m); return true; }, onMessage: fn => { page.tell = fn; return { dispose() {} }; }, onClose() {} });
      page.last = type => page.got.findLast(m => m.type === type);
      page.waitFor = async (type, after = 0) => {
        for (let i = 0; i < 200; i++) { const m = page.got.slice(after).findLast(x => x.type === type); if (m) return m; await new Promise(r => setTimeout(r, 5)); }
        throw new Error(`没等到 ${type}`);
      };
      return page;
    },
    async change(next) { current = { ...current, ...next }; for (const fn of [...listeners]) await fn(structuredClone(current)); },
    settle: () => new Promise(r => setTimeout(r, 40)),
  };
  return host;
}

test('activate 不读任何记录、不抛错，登记页面；deactivate 清干净', async t => {
  const state = mkdir(t), host = fake({ state });
  assert.equal(activate(host.coda), undefined, 'activate 不返回要等的东西');
  assert.deepEqual([...host.views.keys()], ['board']);
  assert.deepEqual(host.calls, [], 'activate 里没有查询');
  assert.equal(host.published.length, 0);
  assert.match(sourceIdOf(state), /^[0-9a-f-]{36}$/);
  deactivate();
  assert.equal(host.views.size, 0);
  deactivate();
});

test('sourceId 重启后不变；没有状态目录也能激活', async t => {
  const state = mkdir(t);
  activate(fake({ state }).coda);
  const first = sourceIdOf(state);
  deactivate();
  activate(fake({ state }).coda);
  assert.equal(sourceIdOf(state), first);
  deactivate();
  activate(fake({ state: null }).coda);
  deactivate();
});

test('分享开着：同步发布最近的每日记录（public），内容没变不重发，变了才重发', async t => {
  const state = mkdir(t), at = startOfBucket(now);
  const host = fake({ state, settings: { 'token-board.share': true }, usage: [bucket(at)] });
  activate(host.coda);
  const page = host.open();
  page.tell({ type: 'hello' });
  await page.waitFor('status');
  page.tell({ type: 'sync' });
  await host.settle();
  assert.equal(host.published.length, 1);
  const [one] = host.published;
  assert.equal(one.kind, 'coda/token-usage');
  assert.equal(one.id, `${new Date(at).toISOString().slice(0, 10)}/${sourceIdOf(state)}`);
  assert.deepEqual(one.audience, ['public']);
  assert.deepEqual(Object.keys(one.body), ['blocks']);
  assert.deepEqual(one.body.blocks[new Date(at).toISOString().slice(11, 16)].claude.opus, counts);
  // 再同步：没变，不发。
  page.tell({ type: 'sync' });
  await host.settle();
  assert.equal(host.published.length, 1);
  // 用量变了：只重发变化的那天。
  host.usage = [bucket(at, { input: 11 })];
  page.tell({ type: 'sync' });
  await host.settle();
  assert.equal(host.published.length, 2);
  assert.equal(host.published[1].id, one.id);
  assert.equal(page.last('status').lastError, null);
  assert.ok(page.last('status').lastSyncAt > 0);
  assert.ok(existsSync(join(state, 'published.json')));
});

test('分享没开：同步不发布；开启后发布，关闭后以 audience [] 撤回本机的记录，别台设备的不动', async t => {
  const state = mkdir(t), at = startOfBucket(now);
  const otherDevice = { author: AUTHOR, kind: 'coda/token-usage', id: '2026-01-01/other-device', version: 1, local: false, body: { blocks: { '00:00': { claude: { opus: counts } } } } };
  const host = fake({ state, usage: [bucket(at)], records: [otherDevice] });
  activate(host.coda);
  const page = host.open();
  page.tell({ type: 'hello' });
  await page.waitFor('status');
  page.tell({ type: 'sync' });
  await host.settle();
  assert.equal(host.published.length, 0);
  assert.match(page.last('status').notice, /还没开启/);

  page.tell({ type: 'set-share', on: true });
  await host.settle();
  assert.equal(host.published.length, 1);
  assert.deepEqual(host.published[0].audience, ['public']);
  assert.equal(page.last('status').share, true);

  page.tell({ type: 'set-share', on: false });
  await host.settle();
  assert.equal(host.published.length, 2);
  const withdrawn = host.published[1];
  assert.equal(withdrawn.id, host.published[0].id);
  assert.deepEqual(withdrawn.audience, []);
  assert.deepEqual(withdrawn.body, { blocks: {} });
  assert.equal(page.last('status').share, false);
  // 手动再撤回一次：已经是空的不重发，别台设备的记录也不动。
  page.tell({ type: 'withdraw' });
  await host.settle();
  assert.equal(host.published.length, 2);
  assert.ok(!host.published.some(p => p.id.endsWith('other-device')));
});

test('设置里把分享打开 / 关掉，模块跟着发布 / 撤回；只改范围不动记录', async t => {
  const state = mkdir(t);
  const host = fake({ state, usage: [bucket(startOfBucket(now))] });
  activate(host.coda);
  const page = host.open();
  page.tell({ type: 'hello' });
  await page.waitFor('status');
  await host.change({ 'token-board.share': true });
  await host.settle();
  assert.equal(host.published.length, 1);
  await host.change({ 'token-board.share': false });
  await host.settle();
  assert.equal(host.published.length, 2);
  assert.deepEqual(host.published[1].audience, []);
  await host.change({ 'token-board.range': '30d' });
  await host.settle();
  assert.equal(host.published.length, 2);
  assert.equal(page.last('status').range, '30d');
});

test('页面上临时切的分享开关，被设置里的改动盖过', async t => {
  const state = mkdir(t);
  const host = fake({ state, usage: [bucket(startOfBucket(now))] });
  activate(host.coda);
  const page = host.open();
  page.tell({ type: 'set-share', on: true });
  await host.settle();
  assert.equal(page.last('status').share, true);
  assert.equal(page.last('status').fromSettings, false);
  await host.change({ 'token-board.share': true, 'token-board.range': '30d' });
  await host.settle();
  assert.equal(page.last('status').share, true);
  assert.equal(page.last('status').fromSettings, true);
});

test('没有 Accord 身份：同步报错而不是抛出；榜单只有本机', async t => {
  const state = mkdir(t);
  const host = fake({ state, accord: false, usage: [bucket(startOfBucket(now))] });
  activate(host.coda);
  const page = host.open();
  page.tell({ type: 'set-share', on: true });
  await host.settle();
  assert.match(page.last('status').lastError, /Accord/);
  page.tell({ type: 'board', range: 'today', id: 1 });
  const board = await page.waitFor('board');
  assert.equal(board.accord, false);
  assert.equal(board.local.totalTokens, 116);
  assert.equal(host.published.length, 0);
});

test('页面取榜单：本机用量、按好友作者查询、名片、截断标记', async t => {
  const state = mkdir(t), at = startOfBucket(now), clock = new Date(at).toISOString().slice(11, 16), day = new Date(at).toISOString().slice(0, 10);
  const host = fake({ state, usage: [bucket(at)], records: [
    { author: FRIEND, kind: 'coda/token-usage', id: `${day}/dev`, version: 1, local: false, body: { blocks: { [clock]: { codex: { gpt: { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0, turns: 4, reportedTurns: 4 } } } } } },
    { author: FRIEND, kind: 'profile', id: 'self', version: 2, local: false, body: { name: '小<b>明</b>\u0000', emoji: '🦊' } },
  ] });
  activate(host.coda);
  const page = host.open();
  page.tell({ type: 'board', range: 'today', id: 7 });
  const board = await page.waitFor('board');
  assert.equal(board.id, 7);
  assert.equal(board.accord, true);
  assert.equal(board.selfAuthor, AUTHOR);
  assert.equal(board.friendCount, 1);
  assert.deepEqual(board.entries.map(e => [e.rank, e.author, e.self]), [[1, FRIEND, false], [2, AUTHOR, true]]);
  assert.equal(board.entries[0].name, '小<b>明</b>');
  assert.equal(board.entries[0].emoji, '🦊');
  assert.equal(board.entries[1].totalTokens, 116);
  assert.deepEqual(board.truncated, { usage: false, friends: false, profiles: false });
  const usageQuery = host.calls.find(([kind]) => kind === 'coda/usage@1');
  assert.equal(usageQuery[1], 'buckets');
  assert.ok(usageQuery[2].limit <= 500);
  const accordQueries = host.calls.filter(([kind]) => kind === 'coda/accord@1');
  assert.ok(accordQueries.some(([, , input]) => input.kind === 'coda/token-usage' && input.author === FRIEND));
  assert.ok(accordQueries.every(([, op, input]) => op === 'records' && (input.limit ?? 200) <= 200));
});

test('读用量失败不拖垮页面；未知范围按设置里的；坏消息被忽略', async t => {
  const host = fake({ state: mkdir(t) });
  host.coda.query = async () => { throw new Error('boom'); };
  activate(host.coda);
  const page = host.open();
  page.tell({ type: 'board', range: 'nonsense', id: 1 });
  const board = await page.waitFor('board');
  assert.equal(board.range, '7d');
  assert.ok(board.errors.some(e => e.includes('boom')));
  for (const bad of [null, 5, 'x', {}, { type: 'unknown' }]) page.tell(bad);
  await host.settle();
  assert.equal(page.got.filter(m => m.type === 'error').length, 0);
});

test('deactivate 后首跳和定时器不再运行', async t => {
  const state = mkdir(t);
  const host = fake({ state, settings: { 'token-board.share': true }, usage: [bucket(startOfBucket(now))] });
  activate(host.coda);
  deactivate();
  await new Promise(r => setTimeout(r, 50));
  assert.equal(host.published.length, 0);
  assert.deepEqual(host.calls, []);
});

test('分享开着：首跳 5 秒后发布，之后每 10 分钟查一次（没变不重发）', async t => {
  const state = mkdir(t);
  const host = fake({ state, settings: { 'token-board.share': true }, usage: [bucket(startOfBucket(now))] });
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  t.after(() => mock.timers.reset());
  const drain = async () => { for (let i = 0; i < 40; i++) await new Promise(r => setImmediate(r)); };
  activate(host.coda);
  await drain();
  assert.equal(host.published.length, 0, '首跳之前什么都没发生');
  mock.timers.tick(5_000);
  await drain();
  assert.equal(host.published.length, 1);
  const queries = host.calls.length;
  mock.timers.tick(10 * 60_000);
  await drain();
  assert.ok(host.calls.length > queries, '定时器又查了一次用量');
  assert.equal(host.published.length, 1, '内容没变，不重发');
  host.usage = [bucket(startOfBucket(now), { output: 6 })];
  mock.timers.tick(10 * 60_000);
  await drain();
  assert.equal(host.published.length, 2);
});
