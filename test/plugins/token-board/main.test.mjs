// Token 消耗榜的模块，用假 coda 跑：activate 不读记录也不抛错；开启分享按内容 hash 去重发布月块日归档与 48 小时曲线；关闭分享以 audience [] 撤回；
// 页面消息触发同步、取榜单；证书过期、没身份时统计照常、续签后补发；来源 ID 优先取机器 ID、读不到不抖动、换了以后不双计；deactivate 清理干净。
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { buildArchiveBodies, buildTodayBody } from '../../../plugins/token-board/lib/usage.mjs';
import { activate, deactivate } from '../../../plugins/token-board/main.mjs';

const AUTHOR = `ed25519:${'a'.repeat(64)}`, FRIEND = `ed25519:${'b'.repeat(64)}`;
const now = Date.now();
const startOfBucket = at => Math.floor(at / 600_000) * 600_000;
const counts = { input: 10, output: 5, cacheRead: 100, cacheWrite: 1, turns: 2, reportedTurns: 2 };
const bucket = (start, over = {}) => ({ start, agent: 'claude', model: 'opus', ...counts, ...over });
const mkdir = t => { const dir = mkdtempSync(join(tmpdir(), 'token-board-')); t.after(() => { deactivate(); rmSync(dir, { recursive: true, force: true }); }); return dir; };
const sourceFile = state => JSON.parse(readFileSync(join(state, 'source.json'), 'utf8'));
const sourceIdOf = state => sourceFile(state).sourceId;
const monthOf = at => new Date(at).toISOString().slice(0, 7);
const dayKind = 'coda/token-day', todayKind = 'coda/token-today', usageKind = 'coda/token-usage';
const kindsOf = list => list.map(p => p.kind);
// 把时钟固定在 now：同一个用例里连续同步，曲线窗口不会因为真实时间跨过 :00 / :30 而滚动。
const freeze = t => { mock.timers.enable({ apis: ['Date'], now }); t.after(() => mock.timers.reset()); };
const certExpired = () => Object.assign(new Error('代签证书已过期'), { code: 'invalid_state' });

function fake({ settings = {}, usage = [], records = [], friends = [{ node: 'n1', mode: 'x', scope: 's', author: FRIEND, bound: true, createdAt: 1, updatedAt: 1 }], accord = true, state } = {}) {
  const calls = [], published = [], attempts = [], views = new Map(), listeners = [];
  let current = { 'token-board.share': false, 'token-board.range': '7d', ...settings };
  const host = {
    calls, published, attempts, views,
    usage,
    machine: undefined,        // 本机的机器 ID；Error 表示读不到
    publishError: null,        // 非空就让 publish 抛它
    failWithdraw: false,       // 撤回（audience []）的 publish 抛错
    recordsError: null,        // 非空就让 Accord 的记录查询抛它
    accordError: null,         // 非空就让读 Accord 抛它
    truncate: false,           // Accord 的记录查询都报 truncated
    author: AUTHOR,            // 本机的 Accord 作者
    coda: {
      plugin: { id: 'token-board', path: '/plugin', state },
      views: { register: (id, provider) => { views.set(id, provider); return { dispose() { views.delete(id); } }; } },
      settings: { get: async () => structuredClone(current), onChange: fn => { listeners.push(fn); return { dispose() { listeners.splice(listeners.indexOf(fn), 1); } }; } },
      list: async (kind, filter) => {
        assert.equal(kind, 'coda/machine@1');
        assert.deepEqual(filter, { scope: 'local' });
        if (host.machine instanceof Error) throw host.machine;
        return host.machine ? [{ id: 'other-machine', local: false }, { id: host.machine, local: true }] : [];
      },
      get: async ref => {
        assert.equal(ref.kind, 'coda/accord@1');
        if (host.accordError) throw host.accordError;
        return accord ? { spec: { author: host.author }, status: { friends } } : null;
      },
      query: async (ref, operation, input) => {
        calls.push([ref.kind, operation, input]);
        if (ref.kind === 'coda/usage@1') return { buckets: host.usage.filter(b => b.start >= input.from && b.start < input.to), truncated: false };
        if (host.recordsError) throw host.recordsError;
        // 自己发布过的记录，每个 id 取最新的，和 Coda 读本机记录一样。
        const mine = [...published.filter(p => p.kind === input.kind).reduce((m, p) => m.set(p.id, p), new Map()).values()]
          .map((p, i) => ({ author: host.author, kind: p.kind, id: p.id, version: i + 1, body: p.body, local: true }));
        return { records: [...records, ...mine].filter(r => r.kind === input.kind && (!input.author || r.author === input.author)), truncated: host.truncate };
      },
      call: async (ref, operation, input) => {
        assert.deepEqual(ref, { kind: 'coda/accord@1', id: 'local' });
        assert.equal(operation, 'publish');
        attempts.push(structuredClone(input));
        if (host.publishError) throw host.publishError;
        if (host.failWithdraw && input.audience.length === 0) throw new Error('撤回失败');
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

test('分享开着：同步发布月块日归档与 48 小时曲线（public），内容没变不重发，变了才重发，不再发旧版 coda/token-usage', async t => {
  freeze(t);
  const state = mkdir(t), at = startOfBucket(now);
  const host = fake({ state, settings: { 'token-board.share': true }, usage: [bucket(at)] });
  activate(host.coda);
  const page = host.open();
  page.tell({ type: 'hello' });
  await page.waitFor('status');
  page.tell({ type: 'sync' });
  await host.settle();
  const sourceId = sourceIdOf(state);
  assert.deepEqual(kindsOf(host.published), [dayKind, todayKind]);
  const [day, today] = host.published;
  assert.equal(day.id, `${sourceId}/${monthOf(at)}`);
  assert.deepEqual(day.audience, ['public']);
  assert.deepEqual(day.body, buildArchiveBodies([bucket(at)])[monthOf(at)]);
  assert.deepEqual(day.body.days[new Date(at).toISOString().slice(0, 10)].claude.opus, [10, 5, 100, 1, 2, 2]);
  assert.equal(today.id, sourceId);
  assert.deepEqual(today.audience, ['public']);
  assert.equal(today.body.slotMs, 1_800_000);
  assert.deepEqual(today.body.slots[Math.floor(at / 1_800_000) * 1_800_000].claude.opus, [10, 5, 100, 1, 2, 2]);
  // 再同步：没变，不发。
  page.tell({ type: 'sync' });
  await host.settle();
  assert.equal(host.published.length, 2);
  // 用量变了：两条都重发。
  host.usage = [bucket(at, { input: 11 })];
  page.tell({ type: 'sync' });
  await host.settle();
  assert.deepEqual(kindsOf(host.published.slice(2)), [dayKind, todayKind]);
  assert.equal(page.last('status').lastError, null);
  assert.equal(page.last('status').syncState, 'synced');
  assert.ok(page.last('status').lastSyncAt > 0);
  assert.ok(existsSync(join(state, 'published.json')));
});

test('分享没开：同步不发布；开启后发布，关闭后以 audience [] 撤回本机的记录，别台设备的不动', async t => {
  freeze(t);
  const state = mkdir(t), at = startOfBucket(now);
  const others = [
    { author: AUTHOR, kind: usageKind, id: '2026-01-01/other-device', version: 1, local: false, body: { blocks: { '00:00': { claude: { opus: counts } } } } },
    { author: AUTHOR, kind: dayKind, id: 'other-device/2026-01', version: 1, local: false, body: buildArchiveBodies([bucket(Date.UTC(2026, 0, 1))])['2026-01'] },
    { author: AUTHOR, kind: todayKind, id: 'other-device', version: 1, local: false, body: buildTodayBody([bucket(at)], { now }) },
  ];
  const host = fake({ state, usage: [bucket(at)], records: others });
  activate(host.coda);
  const page = host.open();
  page.tell({ type: 'hello' });
  await page.waitFor('status');
  page.tell({ type: 'sync' });
  await host.settle();
  assert.equal(host.published.length, 0);
  assert.match(page.last('status').notice, /还没开启/);
  assert.equal(page.last('status').syncState, 'disabled');

  page.tell({ type: 'set-share', on: true });
  await host.settle();
  assert.equal(host.published.length, 2);
  assert.ok(host.published.every(p => p.audience[0] === 'public'));
  assert.equal(page.last('status').share, true);

  page.tell({ type: 'set-share', on: false });
  await host.settle();
  assert.equal(host.published.length, 4);
  const withdrawn = host.published.slice(2);
  assert.deepEqual(withdrawn.map(p => [p.kind, p.id]).sort(), host.published.slice(0, 2).map(p => [p.kind, p.id]).sort());
  assert.ok(withdrawn.every(p => p.audience.length === 0));
  assert.deepEqual(withdrawn.find(p => p.kind === dayKind).body, { v: 2, days: {} });
  assert.deepEqual(withdrawn.find(p => p.kind === todayKind).body, { v: 2, slotMs: 1_800_000, windowStart: 0, windowEnd: 0, slots: {} });
  assert.equal(page.last('status').share, false);
  // 手动再撤回一次：已经是空的不重发，别台设备的记录也不动。
  page.tell({ type: 'withdraw' });
  await host.settle();
  assert.equal(host.published.length, 4);
  assert.ok(!host.published.some(p => p.id.includes('other-device')));
});

test('设置里把分享打开 / 关掉，模块跟着发布 / 撤回；只改范围不动记录', async t => {
  freeze(t);
  const state = mkdir(t);
  const host = fake({ state, usage: [bucket(startOfBucket(now))] });
  activate(host.coda);
  const page = host.open();
  page.tell({ type: 'hello' });
  await page.waitFor('status');
  await host.change({ 'token-board.share': true });
  await host.settle();
  assert.equal(host.published.length, 2);
  await host.change({ 'token-board.share': false });
  await host.settle();
  assert.equal(host.published.length, 4);
  assert.deepEqual(host.published[3].audience, []);
  await host.change({ 'token-board.range': '30d' });
  await host.settle();
  assert.equal(host.published.length, 4);
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

test('没有 Accord 身份：同步不报错，syncState 是 no_identity；榜单没有好友但本机统计与曲线照常', async t => {
  const state = mkdir(t);
  const host = fake({ state, accord: false, usage: [bucket(startOfBucket(now))] });
  activate(host.coda);
  const page = host.open();
  page.tell({ type: 'set-share', on: true });
  await host.settle();
  assert.equal(page.last('status').lastError, null);
  assert.equal(page.last('status').syncState, 'no_identity');
  assert.match(page.last('status').notice, /Accord/);
  page.tell({ type: 'board', range: 'today', id: 1 });
  const board = await page.waitFor('board');
  assert.equal(board.accord, false);
  assert.equal(board.syncState, 'no_identity');
  assert.equal(board.local.totalTokens, 116);
  assert.equal(board.curve.reduce((n, slot) => n + slot.totalTokens, 0), 116);
  assert.deepEqual(board.errors, []);
  assert.equal(host.published.length, 0);
});

test('证书过期（invalid_state）：统计与曲线照常，同步安静停下不记 hash；续签后下一次同步补发全部月块与曲线', async t => {
  const state = mkdir(t), at = Date.UTC(2026, 10, 20, 10, 5);
  mock.timers.enable({ apis: ['Date'], now: at });
  t.after(() => mock.timers.reset());
  // 上个月与本月各有用量：两个月块 + 一条曲线要补发。
  const host = fake({ state, settings: { 'token-board.share': true }, usage: [bucket(Date.UTC(2026, 9, 25, 3, 0)), bucket(Date.UTC(2026, 10, 20, 10, 0))] });
  host.publishError = certExpired();
  activate(host.coda);
  const page = host.open();
  page.tell({ type: 'hello' });
  await page.waitFor('status');
  page.tell({ type: 'sync' });
  await host.settle();
  assert.equal(host.attempts.length, 1, '第一条就失败，本轮停下，等续签');
  assert.equal(host.published.length, 0);
  assert.equal(page.last('status').syncState, 'needs_cert');
  assert.equal(page.last('status').lastError, null);
  assert.equal(page.last('status').lastSyncAt, null);
  assert.deepEqual(JSON.parse(readFileSync(join(state, 'published.json'), 'utf8')), {});

  page.tell({ type: 'board', range: '30d', id: 2 });
  const board = await page.waitFor('board');
  assert.equal(board.syncState, 'needs_cert');
  assert.equal(board.local.totalTokens, 232);
  assert.equal(board.curve.reduce((n, slot) => n + slot.totalTokens, 0), 116);
  assert.equal(board.selfAuthor, AUTHOR);
  assert.deepEqual(board.errors, []);

  host.publishError = null;
  page.tell({ type: 'sync' });
  await host.settle();
  assert.deepEqual(host.published.map(p => [p.kind, p.id.slice(-7)]), [[dayKind, '2026-10'], [dayKind, '2026-11'], [todayKind, sourceIdOf(state).slice(-7)]]);
  assert.equal(page.last('status').syncState, 'synced');
  assert.ok(page.last('status').lastSyncAt > 0);
  page.tell({ type: 'board', range: 'today', id: 3 });
  assert.equal((await page.waitFor('board', page.got.length - 1)).syncState, 'synced');
});

test('来源 ID：优先取 coda/machine@1 的本机 ID，读不到时沿用旧的不抖动，旧随机 UUID 记进 legacy', async t => {
  const state = mkdir(t);
  const host = fake({ state, usage: [bucket(startOfBucket(now))] });
  host.machine = new Error('machine 还没就绪');
  activate(host.coda);
  const first = sourceIdOf(state);
  assert.equal(sourceFile(state).source, 'random');
  const page = host.open();
  const board = async () => { const after = page.got.length; page.tell({ type: 'board', range: 'today', id: after + 1 }); await page.waitFor('board', after); };
  await board();
  await board();
  assert.deepEqual(sourceFile(state), { source: 'random', sourceId: first, legacy: [] }, '临时失败不重新生成');
  host.machine = '';
  await board();
  assert.equal(sourceIdOf(state), first, '没有本机条目也沿用');
  host.machine = 'machine-1';
  await board();
  assert.deepEqual(sourceFile(state), { source: 'machine', sourceId: 'machine-1', legacy: [first] });
  host.machine = new Error('又读不到了');
  await board();
  assert.deepEqual(sourceFile(state), { source: 'machine', sourceId: 'machine-1', legacy: [first] });
  // 重启后还是它；旧版只有 { sourceId } 的文件也能读。
  deactivate();
  activate(fake({ state }).coda);
  assert.equal(sourceIdOf(state), 'machine-1');
  deactivate();
  writeFileSync(join(state, 'source.json'), JSON.stringify({ sourceId: first }));
  activate(fake({ state }).coda);
  assert.deepEqual(sourceFile(state), { sourceId: first }, '读旧文件不改写它');
});

test('从随机 UUID 换成机器 ID：同一台机器的旧记录不被当成第二台，同根兄弟机器照常并入，同步时撤回旧记录', async t => {
  freeze(t);
  const state = mkdir(t), at = startOfBucket(now), old = '11111111-2222-3333-4444-555555555555';
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, 'source.json'), JSON.stringify({ sourceId: old }));
  const mine = bucket(at), tablet = bucket(at, { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0, turns: 5, reportedTurns: 5 });
  const records = [
    { author: AUTHOR, kind: usageKind, id: `${new Date(at).toISOString().slice(0, 10)}/${old}`, version: 1, local: false, body: { blocks: { [new Date(at).toISOString().slice(11, 16)]: { claude: { opus: counts } } } } },
    { author: AUTHOR, kind: dayKind, id: `${old}/${monthOf(at)}`, version: 1, local: false, body: buildArchiveBodies([mine])[monthOf(at)] },
    { author: AUTHOR, kind: todayKind, id: old, version: 1, local: false, body: buildTodayBody([mine], { now }) },
    { author: AUTHOR, kind: dayKind, id: `tablet/${monthOf(at)}`, version: 1, local: false, body: buildArchiveBodies([tablet])[monthOf(at)] },
    { author: AUTHOR, kind: todayKind, id: 'tablet', version: 1, local: false, body: buildTodayBody([tablet], { now }) },
  ];
  const host = fake({ state, settings: { 'token-board.share': true }, usage: [mine], records });
  host.machine = 'machine-1';
  activate(host.coda);
  const page = host.open();
  page.tell({ type: 'hello' });
  await page.waitFor('status');
  page.tell({ type: 'board', range: 'today', id: 1 });
  const board = await page.waitFor('board');
  assert.deepEqual(sourceFile(state), { source: 'machine', sourceId: 'machine-1', legacy: [old] });
  const self = board.entries.find(e => e.self);
  assert.equal(self.totalTokens, 116 + 1000, '本机一次 + 兄弟机器，不含旧 UUID 的三种旧记录');
  assert.equal(board.curve.reduce((n, slot) => n + slot.totalTokens, 0), 116 + 1000);
  assert.equal(host.published.length, 0, '没同步就不发');

  page.tell({ type: 'sync' });
  await host.settle();
  const [dayPub, todayPub, ...retired] = host.published;
  assert.deepEqual([dayPub.id, todayPub.id], [`machine-1/${monthOf(at)}`, 'machine-1']);
  assert.deepEqual(retired.map(p => [p.kind, p.id, p.audience]).sort(), [[dayKind, `${old}/${monthOf(at)}`, []], [todayKind, old, []], [usageKind, records[0].id, []]].sort());
  assert.ok(!host.published.some(p => p.id.includes('tablet')));
  assert.equal(page.last('status').syncState, 'synced');
  // 撤回过的不再重发。
  const count = host.published.length;
  page.tell({ type: 'sync' });
  await host.settle();
  assert.equal(host.published.length, count);
});

test('分享时月块拆法变了，同月不再用的旧块被撤回', async t => {
  const state = mkdir(t), at = Date.UTC(2026, 10, 20, 10, 5);
  mock.timers.enable({ apis: ['Date'], now: at });
  t.after(() => mock.timers.reset());
  const big = [];
  for (let d = 1; d <= 20; d++) for (let m = 0; m < 60; m++) big.push(bucket(Date.UTC(2026, 10, d, 1), { model: `model-${m}-${'x'.repeat(30)}` }));
  const host = fake({ state, settings: { 'token-board.share': true }, usage: [bucket(Date.UTC(2026, 10, 1, 1))] });
  activate(host.coda);
  const page = host.open();
  page.tell({ type: 'hello' });
  await page.waitFor('status');
  page.tell({ type: 'sync' });
  await host.settle();
  const sourceId = sourceIdOf(state);
  assert.deepEqual(host.published.map(p => p.id), [`${sourceId}/2026-11`, sourceId]);
  host.usage = big;
  page.tell({ type: 'sync' });
  await host.settle();
  const after = host.published.slice(2);
  assert.deepEqual(after.filter(p => p.kind === dayKind && p.audience[0] === 'public').map(p => p.id), [`${sourceId}/2026-11-1`, `${sourceId}/2026-11-2`]);
  const gone = after.find(p => p.audience.length === 0);
  assert.deepEqual([gone.kind, gone.id, gone.body], [dayKind, `${sourceId}/2026-11`, { v: 2, days: {} }]);
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
  for (const kind of [usageKind, dayKind, todayKind]) assert.ok(accordQueries.some(([, , input]) => input.kind === kind && input.author === FRIEND), kind);
  assert.equal(board.syncState, 'disabled');
  assert.equal(board.curve.at(-1).totalTokens + board.curve.at(-2).totalTokens, 116);
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

// 定时器和时钟都用假的，从 10:01 起；每次 tick 后等异步工作做完。
const timed = t => {
  const start = Date.UTC(2026, 10, 20, 10, 1);
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: start });
  t.after(() => mock.timers.reset());
  return { start, drain: async () => { for (let i = 0; i < 40; i++) await new Promise(r => setImmediate(r)); } };
};

test('分享开着：首跳 5 秒后发布，之后每 10 分钟查一次；内容没变不重发，跨过 30 分钟边界曲线才合法重发', async t => {
  const state = mkdir(t), { start, drain } = timed(t), at = Date.UTC(2026, 10, 20, 10, 0);
  const host = fake({ state, settings: { 'token-board.share': true }, usage: [bucket(at)] });
  activate(host.coda);
  await drain();
  assert.equal(host.published.length, 0, '首跳之前什么都没发生');
  mock.timers.tick(5_000);
  await drain();
  assert.deepEqual(kindsOf(host.published), [dayKind, todayKind]);
  const queries = host.calls.length;
  mock.timers.tick(10 * 60_000);          // 10:11
  await drain();
  assert.ok(host.calls.length > queries, '定时器又查了一次用量');
  assert.equal(host.published.length, 2, '内容没变，不重发');
  host.usage = [bucket(at, { output: 6 })];
  mock.timers.tick(10 * 60_000);          // 10:21
  await drain();
  assert.deepEqual(kindsOf(host.published.slice(2)), [dayKind, todayKind]);
  mock.timers.tick(10 * 60_000);          // 10:31：当前槽从 10:00 换到 10:30，曲线窗口滚动，月块没变
  await drain();
  assert.deepEqual(kindsOf(host.published.slice(4)), [todayKind]);
  assert.equal(host.published[4].body.windowEnd - host.published[3].body.windowEnd, 1_800_000);
  assert.ok(start < Date.now());
});

test('定时同步让状态变了（证书过期、续签），已经打开的页面收到推送，不用等刷新', async t => {
  const state = mkdir(t), { drain } = timed(t);
  const host = fake({ state, settings: { 'token-board.share': true }, usage: [bucket(Date.UTC(2026, 10, 20, 10, 0))] });
  activate(host.coda);
  const page = host.open();
  mock.timers.tick(5_000);
  await drain();
  assert.equal(page.last('status').syncState, 'synced');
  host.usage = [bucket(Date.UTC(2026, 10, 20, 10, 0), { output: 6 })];
  host.publishError = certExpired();
  const before = page.got.length;
  mock.timers.tick(10 * 60_000);
  await drain();
  assert.equal(page.got.length - before, 1, '只推了一次状态');
  assert.equal(page.last('status').syncState, 'needs_cert');
  host.publishError = null;
  mock.timers.tick(10 * 60_000);
  await drain();
  assert.equal(page.last('status').syncState, 'synced');
  const settled = page.got.length;
  mock.timers.tick(10 * 60_000);
  await drain();
  assert.equal(page.got.length, settled, '状态没变就不推');
});

test('syncState 统一：读 Accord 抛错与没有身份都是 no_identity；开着分享但还没发布完成不报 synced；好友查询失败时统计与曲线照常', async t => {
  freeze(t);
  const state = mkdir(t), host = fake({ state, settings: { 'token-board.share': true }, usage: [bucket(startOfBucket(now))] });
  activate(host.coda);
  const page = host.open();
  page.tell({ type: 'hello' });
  await page.waitFor('status');
  const ask = async id => { const n = page.got.length; page.tell({ type: 'board', range: 'today', id }); return page.waitFor('board', n); };
  assert.equal((await ask(1)).syncState, 'pending', '还没发布过：既不是 synced 也不是 no_identity');
  host.accordError = new Error('accord 不可用');
  page.tell({ type: 'sync' });
  await host.settle();
  assert.equal(page.last('status').syncState, 'no_identity');
  assert.equal(page.last('status').lastError, null);
  const board = await ask(2);
  assert.equal(board.syncState, 'no_identity');
  assert.equal(board.local.totalTokens, 116);
  assert.equal(board.curve.reduce((n, slot) => n + slot.totalTokens, 0), 116);
  host.accordError = null;
  host.recordsError = new Error('记录读不出');
  const second = await ask(3);
  assert.equal(second.local.totalTokens, 116);
  assert.equal(second.curve.reduce((n, slot) => n + slot.totalTokens, 0), 116);
  assert.ok(second.errors.some(e => e.includes('好友')));
  assert.equal(second.entries.find(e => e.self).totalTokens, 116);
  host.recordsError = null;
  page.tell({ type: 'sync' });
  await host.settle();
  assert.equal(page.last('status').syncState, 'synced');
});

test('published.json 的去重键带作者：24 小时证书换了根作者，新作者的记录会全量重发', async t => {
  freeze(t);
  const state = mkdir(t), other = `ed25519:${'c'.repeat(64)}`;
  const host = fake({ state, settings: { 'token-board.share': true }, usage: [bucket(startOfBucket(now))] });
  activate(host.coda);
  const page = host.open();
  page.tell({ type: 'hello' });
  await page.waitFor('status');
  page.tell({ type: 'sync' });
  await host.settle();
  assert.equal(host.published.length, 2);
  page.tell({ type: 'sync' });
  await host.settle();
  assert.equal(host.published.length, 2, '同一作者没变不重发');
  host.author = other;
  page.tell({ type: 'sync' });
  await host.settle();
  assert.equal(host.published.length, 4, '换了作者，同样的内容也要重发');
  const keys = Object.keys(JSON.parse(readFileSync(join(state, 'published.json'), 'utf8')));
  assert.deepEqual(keys.map(key => key.slice(0, AUTHOR.length)).sort(), [AUTHOR, AUTHOR, other, other]);
});

test('旧 UUID 撤回：本机记着发过但远端没查到的也撤；查询被截断或撤回失败不报成功，留着下次再清', async t => {
  freeze(t);
  const state = mkdir(t), old = '11111111-2222-3333-4444-555555555555', month = monthOf(now);
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, 'source.json'), JSON.stringify({ sourceId: old }));
  writeFileSync(join(state, 'published.json'), JSON.stringify({ [`${AUTHOR}:${dayKind}:${old}/${month}`]: 'x', [`${AUTHOR}:${todayKind}:${old}`]: 'x' }));
  const records = [];
  const host = fake({ state, settings: { 'token-board.share': true }, usage: [bucket(startOfBucket(now))], records });
  host.machine = 'machine-1';
  host.truncate = true;
  activate(host.coda);
  const page = host.open();
  page.tell({ type: 'hello' });
  await page.waitFor('status');
  page.tell({ type: 'sync' });
  await host.settle();
  const withdrawn = () => host.published.filter(p => p.audience.length === 0).map(p => [p.kind, p.id]).sort();
  assert.deepEqual(withdrawn(), [[dayKind, `${old}/${month}`], [todayKind, old]].sort(), '远端一条都没查到，也按本机记录撤回');
  assert.match(page.last('status').lastError, /没能查全/);
  assert.equal(page.last('status').syncState, 'error');
  // 查全了，但这回撤回失败：仍不报成功。
  host.truncate = false;
  host.failWithdraw = true;
  host.published.length = 0;
  records.push({ author: AUTHOR, kind: dayKind, id: `${old}/${month}`, version: 1, local: false, body: buildArchiveBodies([bucket(startOfBucket(now))])[month] });
  page.tell({ type: 'sync' });
  await host.settle();
  assert.match(page.last('status').lastError, /撤回 .* 失败/);
  assert.equal(page.last('status').syncState, 'error');
  // 恢复后下一次同步补清，报成功。
  host.failWithdraw = false;
  page.tell({ type: 'sync' });
  await host.settle();
  assert.equal(page.last('status').lastError, null);
  assert.equal(page.last('status').syncState, 'synced');
  assert.ok(withdrawn().some(([kind]) => kind === dayKind));
  // 手动撤回遇到截断：报错，不说已撤回。
  host.truncate = true;
  page.tell({ type: 'withdraw' });
  await host.settle();
  assert.match(page.last('status').lastError, /没能查全/);
  assert.equal(page.last('status').notice, null, '没查全不报「已撤回」');
});

test('board() 与 status() 共用同一套 syncState：已同步后读 Accord 失败、切换作者、关闭再开启分享，两边始终一致', async t => {
  freeze(t);
  const state = mkdir(t), other = `ed25519:${'c'.repeat(64)}`;
  const host = fake({ state, settings: { 'token-board.share': true }, usage: [bucket(startOfBucket(now))] });
  activate(host.coda);
  const page = host.open();
  const both = async () => {
    const n = page.got.length;
    page.tell({ type: 'hello' });
    const status = await page.waitFor('status', n);
    page.tell({ type: 'board', range: 'today', id: n + 1 });
    const board = await page.waitFor('board', n);
    assert.equal(status.syncState, board.syncState);
    return board.syncState;
  };
  assert.equal(await both(), 'pending');
  page.tell({ type: 'sync' });
  await host.settle();
  assert.equal(await both(), 'synced');
  host.accordError = new Error('accord 暂时读不出');
  assert.equal(await both(), 'no_identity');
  host.accordError = null;
  assert.equal(await both(), 'pending', '从没身份恢复，要重新发布一次才算同步');
  page.tell({ type: 'sync' });
  await host.settle();
  assert.equal(await both(), 'synced');
  host.author = other;
  assert.equal(await both(), 'pending', '切了作者：不沿用旧作者的 synced');
  page.tell({ type: 'sync' });
  await host.settle();
  assert.equal(await both(), 'synced');
  // 关掉再开：旧的 synced 作废，开启后这次没发布成功就不是 synced。
  page.tell({ type: 'set-share', on: false });
  await host.settle();
  assert.equal(await both(), 'disabled');
  host.publishError = certExpired();
  page.tell({ type: 'set-share', on: true });
  await host.settle();
  assert.equal(await both(), 'needs_cert');
  host.publishError = null;
  page.tell({ type: 'sync' });
  await host.settle();
  assert.equal(await both(), 'synced');
});

test('撤回时读 Accord 抛错：不清 published.json，不发撤回，分享保持关闭，页面报失败；恢复后重试能撤回', async t => {
  freeze(t);
  const state = mkdir(t), host = fake({ state, settings: { 'token-board.share': true }, usage: [bucket(startOfBucket(now))] });
  activate(host.coda);
  const page = host.open();
  page.tell({ type: 'hello' });
  await page.waitFor('status');
  page.tell({ type: 'sync' });
  await host.settle();
  assert.equal(host.published.length, 2);
  const keys = Object.keys(JSON.parse(readFileSync(join(state, 'published.json'), 'utf8')));
  assert.equal(keys.length, 2);
  host.accordError = new Error('accord 读不出');
  page.tell({ type: 'withdraw' });
  await host.settle();
  assert.equal(host.published.length, 2, '没有发出撤回');
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(state, 'published.json'), 'utf8'))), keys);
  assert.match(page.last('status').lastError, /accord 读不出/);
  assert.equal(page.last('status').notice, null, '不报撤回成功');
  assert.equal(page.last('status').share, false);
  host.accordError = null;
  page.tell({ type: 'withdraw' });
  await host.settle();
  assert.equal(host.published.length, 4);
  assert.ok(host.published.slice(2).every(p => p.audience.length === 0));
  assert.equal(page.last('status').lastError, null);
  assert.deepEqual(JSON.parse(readFileSync(join(state, 'published.json'), 'utf8')), {});
});

test('升级自 0.1.0：published.json 里没有作者前缀的旧键，也能在远端查询被截断时按本机记着的 ID 撤回', async t => {
  freeze(t);
  const state = mkdir(t), old = '11111111-2222-3333-4444-555555555555', day = new Date(now).toISOString().slice(0, 10);
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, 'source.json'), JSON.stringify({ sourceId: old }));
  // 0.1.0 落盘的键就是记录 ID `<UTC 日期>/<uuid>`；再带一条别的机器的，不该被撤。
  writeFileSync(join(state, 'published.json'), JSON.stringify({ [`${day}/${old}`]: 'x', [`${day}/someone-else`]: 'x' }));
  const host = fake({ state, settings: { 'token-board.share': true }, usage: [bucket(startOfBucket(now))] });
  host.machine = 'machine-1';
  host.truncate = true;
  activate(host.coda);
  const page = host.open();
  page.tell({ type: 'hello' });
  await page.waitFor('status');
  page.tell({ type: 'sync' });
  await host.settle();
  const legacy = host.published.filter(p => p.kind === usageKind);
  assert.deepEqual(legacy.map(p => [p.id, p.audience, p.body]), [[`${day}/${old}`, [], { blocks: {} }]]);
  const left = Object.keys(JSON.parse(readFileSync(join(state, 'published.json'), 'utf8')));
  assert.ok(!left.includes(`${day}/${old}`), '撤回成功后才移除');
  assert.ok(left.includes(`${day}/someone-else`));
  // 撤回失败时旧键留着，下次再撤。
  writeFileSync(join(state, 'published.json'), JSON.stringify({ [`${day}/${old}`]: 'x' }));
  deactivate();
  const again = fake({ state, settings: { 'token-board.share': true }, usage: [bucket(startOfBucket(now))] });
  again.truncate = true;
  again.failWithdraw = true;
  activate(again.coda);
  const second = again.open();
  second.tell({ type: 'hello' });
  await second.waitFor('status');
  second.tell({ type: 'withdraw' });
  await again.settle();
  assert.match(second.last('status').lastError, /失败/);
  assert.ok(Object.keys(JSON.parse(readFileSync(join(state, 'published.json'), 'utf8'))).includes(`${day}/${old}`));
});

test('作者 A → B → A：中间没同步过就不恢复旧的 synced', async t => {
  freeze(t);
  const state = mkdir(t), other = `ed25519:${'c'.repeat(64)}`;
  const host = fake({ state, settings: { 'token-board.share': true }, usage: [bucket(startOfBucket(now))] });
  activate(host.coda);
  const page = host.open();
  const ask = async () => { const n = page.got.length; page.tell({ type: 'hello' }); const status = await page.waitFor('status', n); page.tell({ type: 'board', range: 'today', id: n + 1 }); return [status.syncState, (await page.waitFor('board', n)).syncState]; };
  await ask();
  page.tell({ type: 'sync' });
  await host.settle();
  assert.deepEqual(await ask(), ['synced', 'synced']);
  host.author = other;
  assert.deepEqual(await ask(), ['pending', 'pending']);
  host.author = AUTHOR;
  assert.deepEqual(await ask(), ['pending', 'pending'], '回到 A 也要重新同步一次');
  page.tell({ type: 'sync' });
  await host.settle();
  assert.deepEqual(await ask(), ['synced', 'synced']);
});

test('榜单读到状态变了（Accord 读不出）会把最新状态推给页面，不用等 hello', async t => {
  freeze(t);
  const state = mkdir(t), host = fake({ state, settings: { 'token-board.share': true }, usage: [bucket(startOfBucket(now))] });
  activate(host.coda);
  const page = host.open();
  page.tell({ type: 'hello' });
  await page.waitFor('status');
  page.tell({ type: 'sync' });
  await host.settle();
  assert.equal(page.last('status').syncState, 'synced');
  host.accordError = new Error('accord 读不出');
  const n = page.got.length;
  page.tell({ type: 'board', range: 'today', id: 1 });
  const board = await page.waitFor('board', n);
  assert.equal(board.syncState, 'no_identity');
  assert.equal(page.last('status').syncState, 'no_identity', '页面上的 status 已跟着更新');
  const pushed = page.got.length;
  page.tell({ type: 'board', range: 'today', id: 2 });
  await page.waitFor('board', pushed);
  assert.deepEqual(page.got.slice(pushed).map(m => m.type), ['board'], '状态没变就不重复推');
});
