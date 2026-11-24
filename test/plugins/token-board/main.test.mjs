// Token 消耗榜的模块，用假 coda 和假好友网关（friends/social@1）跑：activate 不读记录也不抛错；开启分享经网关发布月块日归档与 48 小时曲线（去重在网关）；
// 关闭分享按本机 sourceId 筛出自己的记录、逐条带 id 撤回，绝不按 kind 批量撤回、不动别的设备；没有好友插件时本机统计照常、状态 no_gateway；
// 网关状态（needs_cert、paused、no_identity、queued）如实透传；来源 ID 优先取机器 ID、读不到不抖动、换了以后不双计；全程不直接访问 coda/accord@1；deactivate 清理干净。
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { buildArchiveBodies, buildTodayBody } from '../../../plugins/token-board/lib/usage.mjs';
import { createGateway } from '../../../plugins/friends/lib/gateway.mjs';
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
const SOCIAL = 'friends/social@1';
const gone = code => Object.assign(new Error(`没有好友网关：${code}`), { code });
const retracts = host => host.retractCalls.map(call => [call.kind, call.id]);

function fake({ settings = {}, usage = [], records = [], friends, state } = {}) {
  const calls = [], published = [], attempts = [], retractCalls = [], queued = [], touched = new Set(), views = new Map(), listeners = [], own = new Map();
  let current = { 'token-board.share': false, 'token-board.range': '7d', ...settings }, version = 0;
  const host = {
    calls, published, attempts, retractCalls, queued, touched, views, records,
    usage,
    friends: friends ?? [{ node: 'n1', author: FRIEND, status: 'bound', note: '', profileName: '', title: `好友 ${'b'.repeat(8)}`, emoji: '', color: 'gray' }],
    machine: undefined,        // 本机的机器 ID；Error 表示读不到
    gateway: true,             // 好友插件在不在
    listError: null,           // 非空就让列出好友网关抛它
    friendsError: null,        // 非空就让网关的 friends 查询抛它
    recordsError: null,        // 非空就让网关的 records 查询抛它
    publishError: null,        // 非空就让 publish 抛它
    publishStates: {},         // { [kind]: 网关对这一类发布给的状态 }，没写的就是 synced
    retractState: null,        // 非空就让 retract 返回这个状态（error 带 error 字样）
    retractStates: {},         // { [记录 id]: 状态 }：只让这一条 retract 返回这个状态
    signedAs: null,            // 非空就让 publish 以这个作者签名（模拟列出之后身份换了）
    failWithdraw: false,       // retract 返回 error
    truncate: false,           // 网关的记录查询都报 truncated，且没有 nextCursor
    pageSize: 200,             // 网关一页最多给几条
    author: AUTHOR,            // 网关当前的作者；null 就是没有身份
    certState: 'active',       // 有身份时的证书状态
    pausedKinds: [],
    coda: {
      plugin: { id: 'token-board', path: '/plugin', state },
      views: { register: (id, provider) => { views.set(id, provider); return { dispose() { views.delete(id); } }; } },
      settings: { get: async () => structuredClone(current), onChange: fn => { listeners.push(fn); return { dispose() { listeners.splice(listeners.indexOf(fn), 1); } }; } },
      get: async ref => { touched.add(ref.kind); throw new Error(`token-board 不该直接 get ${ref.kind}`); },
      watch: async ref => { touched.add(ref); throw new Error(`token-board 模块不该 watch ${ref}`); },
      list: async (kind, filter) => {
        touched.add(kind);
        assert.deepEqual(filter, { scope: 'local' });
        if (kind === 'coda/machine@1') {
          if (host.machine instanceof Error) throw host.machine;
          return host.machine ? [{ id: 'other-machine', local: false }, { id: host.machine, local: true }] : [];
        }
        assert.equal(kind, SOCIAL);
        if (host.listError) throw host.listError;
        const status = { author: host.author, certState: host.author ? host.certState : 'no_identity', friendCount: host.friends.length, pendingCount: queued.length, pausedKinds: host.pausedKinds };
        return host.gateway ? [{ id: 'local', status }] : [];
      },
      query: async (ref, operation, input) => {
        touched.add(ref.kind);
        calls.push([ref.kind, operation, input]);
        if (ref.kind === 'coda/usage@1') return { buckets: host.usage.filter(b => b.start >= input.from && b.start < input.to), truncated: false };
        assert.deepEqual(ref, { kind: SOCIAL, id: 'local' });
        if (operation === 'friends') {
          if (host.friendsError) throw host.friendsError;
          return { selfAuthor: host.author, certState: host.author ? host.certState : 'no_identity', friends: host.friends, truncated: false };
        }
        if (operation === 'outbox') return { author: host.author, certState: host.author ? host.certState : 'no_identity', pausedKinds: host.pausedKinds, pendingCount: queued.length, items: queued.filter(item => item.kind === input.kind).map(item => ({ kind: item.kind, id: item.id, desired: 'publish', state: 'queued' })) };
        assert.equal(operation, 'records');
        if (host.recordsError) throw host.recordsError;
        // 自己经网关发布的记录，每个 (kind, id) 取最新的。
        const all = [...host.records, ...own.values()].filter(r => r.kind === input.kind && (!input.author || r.author === input.author) && (input.id === undefined || r.id === input.id));
        if (host.truncate) return { records: all.slice(0, host.pageSize), truncated: true };
        const from = input.cursor ? Number(input.cursor) : 0, size = Math.min(input.limit ?? 200, host.pageSize), end = from + size;
        return { records: all.slice(from, end), truncated: end < all.length, ...(end < all.length ? { nextCursor: String(end) } : {}) };
      },
      call: async (ref, operation, input) => {
        touched.add(ref.kind);
        assert.deepEqual(ref, { kind: SOCIAL, id: 'local' });
        const certState = host.author ? host.certState : 'no_identity', author = host.author;
        if (operation === 'publish') {
          attempts.push(structuredClone(input));
          assert.deepEqual(Object.keys(input).sort(), ['body', 'id', 'kind'], '不带 audience，由网关按默认发给好友');
          if (host.publishError) throw host.publishError;
          const key = `${input.kind}\0${input.id}`, prev = own.get(key);
          if (author && prev?.author === author && JSON.stringify(prev.body) === JSON.stringify(input.body)) return { state: 'synced', skipped: true, author };
          const state = !author ? 'no_identity' : host.pausedKinds.includes(input.kind) ? 'paused' : certState !== 'active' ? certState : host.publishStates[input.kind] ?? 'synced';
          if (state !== 'synced') {
            const at = queued.findIndex(item => item.kind === input.kind && item.id === input.id);
            if (at >= 0) queued.splice(at, 1);
            queued.push(structuredClone(input));
            return { state, ...(author ? { author } : {}), ...(state === 'error' ? { error: '网关拒绝了这条' } : {}) };
          }
          const signer = host.signedAs ?? author;
          own.set(key, { author: signer, kind: input.kind, id: input.id, version: ++version, body: structuredClone(input.body), local: true });
          published.push(structuredClone(input));
          return { state: 'synced', author: signer, version };
        }
        assert.equal(operation, 'retract');
        retractCalls.push(structuredClone(input));
        // 真网关省略 id 会按 kind 把同作者的记录全撤了，包括别的设备的：这里直接当事故。
        assert.equal(typeof input.id, 'string', '不许省略 id 按 kind 批量撤回');
        // 网关会取消本机还没发出去的待发项（有没有身份都一样）。
        const waiting = queued.findIndex(item => item.kind === input.kind && item.id === input.id);
        if (waiting >= 0 && !host.failWithdraw && !host.retractState && !host.retractStates[input.id]) queued.splice(waiting, 1);
        if (host.failWithdraw) return { state: 'error', count: 0, error: '撤回失败' };
        const each = host.retractStates[input.id];
        if (each) return { state: each, count: 0, ...(each === 'error' ? { error: '网关拒绝了撤回' } : {}) };
        if (host.retractState) return { state: host.retractState, count: 0, ...(host.retractState === 'error' ? { error: '网关拒绝了撤回' } : {}) };
        if (!author) return { state: 'no_identity', count: 0 };
        if (certState !== 'active') return { state: certState, count: 0, queued: 1 };
        const key = `${input.kind}\0${input.id}`, mine = own.get(key), seeded = host.records.findIndex(r => r.kind === input.kind && r.id === input.id && r.author === author);
        if (mine) own.set(key, { ...mine, version: ++version, body: {} });
        if (seeded >= 0) host.records[seeded] = { ...host.records[seeded], version: ++version, body: {} };
        return { state: 'retracted', count: mine || seeded >= 0 ? 1 : 0 };
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
const indexOf = state => JSON.parse(readFileSync(join(state, 'published.json'), 'utf8'));
// 打开页面、hello 一次，再同步一次。
async function openAndSync(host) {
  const page = host.open();
  page.tell({ type: 'hello' });
  await page.waitFor('status');
  page.tell({ type: 'sync' });
  await host.settle();
  return page;
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

test('分享开着：经网关发布月块日归档与 48 小时曲线（只给 kind、id、body），去重在网关，内容变了才有新写入，不再发旧版 coda/token-usage', async t => {
  freeze(t);
  const state = mkdir(t), at = startOfBucket(now);
  const host = fake({ state, settings: { 'token-board.share': true }, usage: [bucket(at)] });
  activate(host.coda);
  const page = await openAndSync(host);
  const sourceId = sourceIdOf(state);
  assert.deepEqual(kindsOf(host.published), [dayKind, todayKind]);
  const [day, today] = host.published;
  assert.equal(day.id, `${sourceId}/${monthOf(at)}`);
  assert.deepEqual(day.body, buildArchiveBodies([bucket(at)])[monthOf(at)]);
  assert.deepEqual(day.body.days[new Date(at).toISOString().slice(0, 10)].claude.opus, [10, 5, 100, 1, 2, 2]);
  assert.equal(today.id, sourceId);
  assert.equal(today.body.slotMs, 1_800_000);
  assert.deepEqual(today.body.slots[Math.floor(at / 1_800_000) * 1_800_000].claude.opus, [10, 5, 100, 1, 2, 2]);
  assert.equal(page.last('status').syncState, 'synced');
  // 再同步：网关报已同步过（skipped），没有新写入。
  page.tell({ type: 'sync' });
  await host.settle();
  assert.equal(host.published.length, 2);
  assert.equal(host.attempts.length, 4);
  // 用量变了：两条都有新写入。
  host.usage = [bucket(at, { input: 11 })];
  page.tell({ type: 'sync' });
  await host.settle();
  assert.deepEqual(kindsOf(host.published.slice(2)), [dayKind, todayKind]);
  assert.equal(page.last('status').lastError, null);
  assert.equal(page.last('status').syncState, 'synced');
  assert.ok(page.last('status').lastSyncAt > 0);
  assert.ok(existsSync(join(state, 'published.json')));
  assert.deepEqual(Object.keys(indexOf(state)).map(key => key.slice(AUTHOR.length + 1)).sort(), [`${dayKind}:${sourceId}/${monthOf(at)}`, `${todayKind}:${sourceId}`]);
});

test('分享没开：同步不发布；开启后发布，关闭后只撤回本机 sourceId 名下的记录（逐条带 id），别台设备和好友的不动', async t => {
  freeze(t);
  const state = mkdir(t), at = startOfBucket(now);
  const others = [
    { author: AUTHOR, kind: usageKind, id: '2026-01-01/other-machine', version: 1, local: false, body: { blocks: { '00:00': { claude: { opus: counts } } } } },
    { author: AUTHOR, kind: dayKind, id: 'other-machine/2026-01', version: 1, local: false, body: buildArchiveBodies([bucket(Date.UTC(2026, 0, 1))])['2026-01'] },
    { author: AUTHOR, kind: todayKind, id: 'other-machine', version: 1, local: false, body: buildTodayBody([bucket(at)], { now }) },
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
  assert.equal(page.last('status').share, true);

  page.tell({ type: 'set-share', on: false });
  await host.settle();
  assert.deepEqual(retracts(host).sort(), host.published.map(p => [p.kind, p.id]).sort());
  assert.ok(retracts(host).every(([, id]) => !id.includes('other-machine')));
  assert.equal(page.last('status').share, false);
  assert.deepEqual(indexOf(state), {});
  for (const record of others) assert.ok(Object.keys(host.records.find(r => r.kind === record.kind && r.id === record.id).body).length > 0, `${record.id} 没被撤`);
  // 手动再撤回一次：已经撤过的不再调，别台设备的记录也不动。
  page.tell({ type: 'withdraw' });
  await host.settle();
  assert.equal(host.retractCalls.length, 2);
  assert.match(page.last('status').notice, /已撤回/);
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
  assert.equal(host.retractCalls.length, 2);
  await host.change({ 'token-board.range': '30d' });
  await host.settle();
  assert.equal(host.published.length, 2);
  assert.equal(host.retractCalls.length, 2);
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

// ——— 没有好友插件 ———

for (const [name, setup] of [
  ['list 报 not_found', host => { host.listError = gone('not_found'); }],
  ['list 报 forbidden', host => { host.listError = gone('forbidden'); }],
  ['list 报 service_unavailable', host => { host.listError = gone('service_unavailable'); }],
  ['list 返回 []', host => { host.gateway = false; }],
]) {
  test(`没有好友插件（${name}）：本机统计与 48 小时曲线照常、零报错；分享开着报 no_gateway，关着报 disabled，不伪造 synced`, async t => {
    freeze(t);
    const state = mkdir(t), host = fake({ state, settings: { 'token-board.share': true }, usage: [bucket(startOfBucket(now))] });
    setup(host);
    activate(host.coda);
    const page = host.open();
    page.tell({ type: 'hello' });
    await page.waitFor('status');
    page.tell({ type: 'sync' });
    await host.settle();
    assert.equal(page.last('status').syncState, 'no_gateway');
    assert.equal(page.last('status').lastError, null);
    assert.equal(page.last('status').lastSyncAt, null, '不覆盖上次同步时间');
    assert.equal(host.attempts.length, 0);
    page.tell({ type: 'board', range: 'today', id: 1 });
    const board = await page.waitFor('board');
    assert.equal(board.accord, false);
    assert.equal(board.selfAuthor, null);
    assert.equal(board.friendCount, 0);
    assert.deepEqual(board.people, []);
    assert.deepEqual(board.sources, []);
    assert.equal(board.syncState, 'no_gateway');
    assert.equal(board.local.totalTokens, 116);
    assert.equal(board.curve.reduce((n, slot) => n + slot.totalTokens, 0), 116);
    assert.deepEqual(board.errors, []);
    assert.deepEqual(host.calls.filter(([kind]) => kind === SOCIAL), []);
    // 关着分享：disabled。
    await host.change({ 'token-board.share': false });
    await host.settle();
    const seen = page.got.length;
    page.tell({ type: 'board', range: 'today', id: 2 });
    const off = await page.waitFor('board', seen);
    assert.equal(off.syncState, 'disabled');
    assert.deepEqual(off.errors, []);
  });
}

test('没有好友插件：手动撤回不假装成功，保留本机已知发布 ID 索引，提示清晰；装回来之后能撤', async t => {
  freeze(t);
  const state = mkdir(t), host = fake({ state, settings: { 'token-board.share': true }, usage: [bucket(startOfBucket(now))] });
  activate(host.coda);
  const page = await openAndSync(host);
  assert.equal(host.published.length, 2);
  const keys = Object.keys(indexOf(state));
  host.gateway = false;
  page.tell({ type: 'withdraw' });
  await host.settle();
  assert.equal(host.retractCalls.length, 0);
  assert.equal(page.last('status').lastError, '未安装或未启用好友插件，无法撤回好友可见记录');
  assert.equal(page.last('status').notice, null);
  assert.deepEqual(Object.keys(indexOf(state)), keys);
  host.gateway = true;
  page.tell({ type: 'withdraw' });
  await host.settle();
  assert.equal(host.retractCalls.length, 2);
  assert.equal(page.last('status').lastError, null);
  assert.deepEqual(indexOf(state), {});
});

test('读网关抛了不是「没有网关」的错：不清索引、不撤回，页面报失败；恢复后重试能撤回', async t => {
  freeze(t);
  const state = mkdir(t), host = fake({ state, settings: { 'token-board.share': true }, usage: [bucket(startOfBucket(now))] });
  activate(host.coda);
  const page = await openAndSync(host);
  const keys = Object.keys(indexOf(state));
  assert.equal(keys.length, 2);
  host.listError = Object.assign(new Error('网关读不出'), { code: 'internal' });
  page.tell({ type: 'withdraw' });
  await host.settle();
  assert.equal(host.retractCalls.length, 0, '没有发出撤回');
  assert.deepEqual(Object.keys(indexOf(state)), keys);
  assert.match(page.last('status').lastError, /网关读不出/);
  assert.equal(page.last('status').notice, null, '不报撤回成功');
  assert.equal(page.last('status').share, false);
  host.listError = null;
  page.tell({ type: 'withdraw' });
  await host.settle();
  assert.equal(host.retractCalls.length, 2);
  assert.equal(page.last('status').lastError, null);
  assert.deepEqual(indexOf(state), {});
});

// ——— 网关状态透传 ———

test('没有身份：发布得到 no_identity，同步不报错；榜单没有好友但本机统计与曲线照常；撤回也要取消网关里排着的本机待发项，再清空索引', async t => {
  freeze(t);
  const state = mkdir(t), host = fake({ state, usage: [bucket(startOfBucket(now))] });
  host.author = null;
  host.friends = [];
  activate(host.coda);
  const page = host.open();
  page.tell({ type: 'set-share', on: true });
  await host.settle();
  assert.equal(page.last('status').lastError, null);
  assert.equal(page.last('status').syncState, 'no_identity');
  assert.match(page.last('status').notice, /好友身份/);
  assert.equal(host.published.length, 0);
  assert.equal(host.queued.length, 2, '交给网关排队');
  page.tell({ type: 'board', range: 'today', id: 1 });
  const board = await page.waitFor('board');
  assert.equal(board.accord, true);
  assert.equal(board.selfAuthor, null);
  assert.equal(board.syncState, 'no_identity');
  assert.equal(board.local.totalTokens, 116);
  assert.equal(board.curve.reduce((n, slot) => n + slot.totalTokens, 0), 116);
  assert.deepEqual(board.errors, []);
  writeFileSync(join(state, 'published.json'), JSON.stringify({ [`${AUTHOR}:${dayKind}:x/2026-11`]: true }));
  const sourceId = sourceIdOf(state);
  page.tell({ type: 'withdraw' });
  await host.settle();
  assert.deepEqual(retracts(host).map(([, id]) => id).sort(), [`${sourceId}/${monthOf(now)}`, sourceId].sort(), '按网关待发队列里本机的项逐条撤，带 id');
  assert.equal(host.queued.length, 0, '待发项取消了，恢复身份后不会泄露');
  assert.deepEqual(indexOf(state), {});
  assert.equal(page.last('status').lastError, null);
});

test('证书过期：统计与曲线照常，网关排队，同步状态 needs_cert、不记同步时间；续签后下一次同步报 synced', async t => {
  const state = mkdir(t), at = Date.UTC(2026, 10, 20, 10, 5);
  mock.timers.enable({ apis: ['Date'], now: at });
  t.after(() => mock.timers.reset());
  // 上个月与本月各有用量：两个月块 + 一条曲线。
  const host = fake({ state, settings: { 'token-board.share': true }, usage: [bucket(Date.UTC(2026, 9, 25, 3, 0)), bucket(Date.UTC(2026, 10, 20, 10, 0))] });
  host.certState = 'needs_cert';
  activate(host.coda);
  const page = await openAndSync(host);
  assert.equal(host.attempts.length, 3, '三条都交给网关，由它排队');
  assert.equal(host.published.length, 0);
  assert.equal(host.queued.length, 3);
  assert.equal(page.last('status').syncState, 'needs_cert');
  assert.equal(page.last('status').lastError, null);
  assert.equal(page.last('status').lastSyncAt, null);
  page.tell({ type: 'board', range: '30d', id: 2 });
  const board = await page.waitFor('board');
  assert.equal(board.syncState, 'needs_cert');
  assert.equal(board.local.totalTokens, 232);
  assert.equal(board.curve.reduce((n, slot) => n + slot.totalTokens, 0), 116);
  assert.equal(board.selfAuthor, AUTHOR);
  assert.deepEqual(board.errors, []);

  host.certState = 'active';
  page.tell({ type: 'sync' });
  await host.settle();
  assert.deepEqual(host.published.map(p => [p.kind, p.id.slice(-7)]), [[dayKind, '2026-10'], [dayKind, '2026-11'], [todayKind, sourceIdOf(state).slice(-7)]]);
  assert.equal(page.last('status').syncState, 'synced');
  assert.ok(page.last('status').lastSyncAt > 0);
  page.tell({ type: 'board', range: 'today', id: 3 });
  assert.equal((await page.waitFor('board', page.got.length - 1)).syncState, 'synced');
});

test('网关状态透传：error > no_identity > needs_cert > paused > queued > synced；paused 来自网关的 pausedKinds', async t => {
  freeze(t);
  const state = mkdir(t), host = fake({ state, settings: { 'token-board.share': true }, usage: [bucket(startOfBucket(now))] });
  activate(host.coda);
  const page = host.open();
  page.tell({ type: 'hello' });
  await page.waitFor('status');
  const sync = async () => { page.tell({ type: 'sync' }); await host.settle(); return page.last('status'); };
  const board = async () => { const n = page.got.length; page.tell({ type: 'board', range: 'today', id: n + 1 }); return (await page.waitFor('board', n)).syncState; };
  // 暂停了日归档：曲线照发，整体是 paused，不报错，页面照样有榜。
  host.pausedKinds = [dayKind];
  let status = await sync();
  assert.equal(status.syncState, 'paused');
  assert.equal(status.lastError, null);
  assert.deepEqual(kindsOf(host.published), [todayKind]);
  assert.equal(await board(), 'paused');
  host.pausedKinds = [];
  // queued：网关接收但没发出。
  host.publishStates = { [dayKind]: 'queued' };
  status = await sync();
  assert.equal(status.syncState, 'queued');
  assert.equal(status.lastSyncAt, null);
  // queued 与 paused 并存：paused 更要紧。
  host.pausedKinds = [todayKind];
  host.usage = [bucket(startOfBucket(now), { input: 12 })];
  status = await sync();
  assert.equal(status.syncState, 'paused');
  host.pausedKinds = [];
  // 一条 error 压过其他。
  host.publishStates = { [dayKind]: 'error', [todayKind]: 'queued' };
  host.usage = [bucket(startOfBucket(now), { input: 13 })];
  status = await sync();
  assert.equal(status.syncState, 'error');
  assert.match(status.lastError, /发布 .* 失败：网关拒绝了这条/);
  assert.equal(await board(), 'error');
  // publish 抛错也是 error，不拖垮同步。
  host.publishStates = {};
  host.publishError = new Error('网关挂了');
  status = await sync();
  assert.equal(status.syncState, 'error');
  assert.match(status.lastError, /网关挂了/);
  host.publishError = null;
  status = await sync();
  assert.equal(status.syncState, 'synced');
  assert.equal(status.lastError, null);
  assert.ok(status.lastSyncAt > 0);
  // 没有新记录可发（网关全部 skipped）：依网关的 certState / pausedKinds 判定。
  host.certState = 'needs_cert';
  assert.equal((await sync()).syncState, 'needs_cert');
  host.certState = 'active';
  host.pausedKinds = [todayKind];
  assert.equal((await sync()).syncState, 'paused');
  host.pausedKinds = [];
  assert.equal((await sync()).syncState, 'synced');
});

// ——— 来源 ID 与旧记录 ———

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

test('从随机 UUID 换成机器 ID：同一台机器的旧记录不被当成第二台，同根兄弟机器照常并入，同步时逐条（带 id）撤回旧记录', async t => {
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
  const owned = author => board.sources.filter(source => source.author === author).reduce((n, source) => n + source.totalTokens, 0);
  assert.equal(owned(board.selfAuthor), 116 + 1000, '本机一次 + 兄弟机器，不含旧 UUID 的三种旧记录');
  assert.deepEqual(board.sources.map(source => [source.sourceId, source.local]).sort(), [['machine-1', true], ['tablet', false]], '回包带每个来源的合计，旧 UUID 不在里面');
  assert.equal(board.sources.find(source => source.local).totalTokens, 116);
  assert.equal(board.curve.reduce((n, slot) => n + slot.totalTokens, 0), 116 + 1000);
  assert.equal(host.published.length, 0, '没同步就不发');

  page.tell({ type: 'sync' });
  await host.settle();
  assert.deepEqual(host.published.map(p => p.id), [`machine-1/${monthOf(at)}`, 'machine-1']);
  assert.deepEqual(retracts(host).sort(), [[dayKind, `${old}/${monthOf(at)}`], [todayKind, old], [usageKind, records[0].id]].sort());
  assert.ok(!retracts(host).some(([, id]) => id.includes('tablet')));
  assert.equal(page.last('status').syncState, 'synced');
  // 撤回过的不再撤。
  const count = host.retractCalls.length;
  page.tell({ type: 'sync' });
  await host.settle();
  assert.equal(host.retractCalls.length, count);
  assert.equal(host.published.length, 2);
});

test('分享时月块拆法变了，同月不再用的旧块被逐条撤回', async t => {
  const state = mkdir(t), at = Date.UTC(2026, 10, 20, 10, 5);
  mock.timers.enable({ apis: ['Date'], now: at });
  t.after(() => mock.timers.reset());
  const big = [];
  for (let d = 1; d <= 20; d++) for (let m = 0; m < 60; m++) big.push(bucket(Date.UTC(2026, 10, d, 1), { model: `model-${m}-${'x'.repeat(30)}` }));
  const host = fake({ state, settings: { 'token-board.share': true }, usage: [bucket(Date.UTC(2026, 10, 1, 1))] });
  activate(host.coda);
  const page = await openAndSync(host);
  const sourceId = sourceIdOf(state);
  assert.deepEqual(host.published.map(p => p.id), [`${sourceId}/2026-11`, sourceId]);
  host.usage = big;
  page.tell({ type: 'sync' });
  await host.settle();
  assert.deepEqual(host.published.slice(2).filter(p => p.kind === dayKind).map(p => p.id), [`${sourceId}/2026-11-1`, `${sourceId}/2026-11-2`]);
  assert.deepEqual(retracts(host), [[dayKind, `${sourceId}/2026-11`]]);
  assert.ok(!Object.keys(indexOf(state)).some(key => key.endsWith(`${sourceId}/2026-11`)));
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
  assert.deepEqual(retracts(host).sort(), [[dayKind, `${old}/${month}`], [todayKind, old]].sort(), '远端一条都没查到，也按本机记录撤回');
  assert.match(page.last('status').lastError, /没能查全/);
  assert.equal(page.last('status').syncState, 'error');
  // 查全了，但这回撤回失败：仍不报成功。
  host.truncate = false;
  host.failWithdraw = true;
  host.retractCalls.length = 0;
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
  assert.ok(retracts(host).some(([kind]) => kind === dayKind));
  // 手动撤回遇到截断：报错，不说已撤回。
  host.truncate = true;
  page.tell({ type: 'withdraw' });
  await host.settle();
  assert.match(page.last('status').lastError, /没能查全/);
  assert.equal(page.last('status').notice, null, '没查全不报「已撤回」');
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
  assert.deepEqual(retracts(host), [[usageKind, `${day}/${old}`]]);
  const left = Object.keys(indexOf(state));
  assert.ok(left.includes(`${day}/${old}`), '查询被截断，整轮没完成：索引原样留着');
  assert.ok(left.includes(`${day}/someone-else`));
  // 查全了，整轮完成：才移除。
  host.truncate = false;
  page.tell({ type: 'sync' });
  await host.settle();
  assert.ok(!Object.keys(indexOf(state)).includes(`${day}/${old}`), '整轮撤回确认后才移除');
  assert.ok(Object.keys(indexOf(state)).includes(`${day}/someone-else`));
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
  assert.ok(Object.keys(indexOf(state)).includes(`${day}/${old}`));
});

test('兼容 0.2.0 的 published.json（键带作者、值是内容 hash）：只撤回当前作者、本机 sourceId 名下的 ID，别的作者与别的设备不动', async t => {
  freeze(t);
  const state = mkdir(t), other = `ed25519:${'c'.repeat(64)}`;
  mkdirSync(state, { recursive: true });
  const id = 'machine-1';
  writeFileSync(join(state, 'source.json'), JSON.stringify({ source: 'machine', sourceId: id, legacy: [] }));
  writeFileSync(join(state, 'published.json'), JSON.stringify({
    [`${AUTHOR}:${dayKind}:${id}/2026-11`]: 'a'.repeat(64), [`${AUTHOR}:${todayKind}:${id}`]: 'b'.repeat(64),
    [`${other}:${todayKind}:${id}`]: 'c'.repeat(64), [`${AUTHOR}:${todayKind}:other-machine`]: 'd'.repeat(64),
  }));
  const host = fake({ state, usage: [bucket(startOfBucket(now))] });
  host.truncate = true;
  activate(host.coda);
  const page = host.open();
  page.tell({ type: 'withdraw' });
  await host.settle();
  assert.deepEqual(retracts(host).sort(), [[dayKind, `${id}/2026-11`], [todayKind, id]].sort());
  assert.equal(page.last('status').notice, null, '没查全：不报已撤回');
  assert.equal(host.retractCalls.every(call => Object.keys(call).sort().join() === 'id,kind'), true);
});

// ——— 多机隔离撤回 ———

test('多机隔离：同一作者名下本机、other-machine、legacy UUID 的记录并存，撤回只对本机 sourceId 与 legacy 带 id 逐条调用，绝不省略 id，绝不撤 other-machine', async t => {
  freeze(t);
  const state = mkdir(t), at = startOfBucket(now), old = '11111111-2222-3333-4444-555555555555', month = monthOf(at), day = new Date(at).toISOString().slice(0, 10);
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, 'source.json'), JSON.stringify({ sourceId: old }));
  const body = buildArchiveBodies([bucket(at)])[month], curve = buildTodayBody([bucket(at)], { now });
  const records = [
    { author: AUTHOR, kind: dayKind, id: `${old}/${month}`, version: 1, local: true, body },
    { author: AUTHOR, kind: todayKind, id: old, version: 1, local: true, body: curve },
    { author: AUTHOR, kind: usageKind, id: `${day}/${old}`, version: 1, local: true, body: { blocks: { '00:00': { claude: { opus: counts } } } } },
    { author: AUTHOR, kind: dayKind, id: `other-machine/${month}`, version: 1, local: false, body },
    { author: AUTHOR, kind: todayKind, id: 'other-machine', version: 1, local: false, body: curve },
    { author: AUTHOR, kind: usageKind, id: `${day}/other-machine`, version: 1, local: false, body: { blocks: { '00:00': { claude: { opus: counts } } } } },
    { author: AUTHOR, kind: todayKind, id: 'machine-1x', version: 1, local: false, body: curve },     // 前缀像本机但不是
    { author: FRIEND, kind: todayKind, id: 'machine-1', version: 1, local: false, body: curve },        // 好友的同名 ID 也不是
  ];
  const host = fake({ state, settings: { 'token-board.share': true }, usage: [bucket(at)], records });
  host.machine = 'machine-1';
  activate(host.coda);
  const page = await openAndSync(host);
  const sync = retracts(host).length;
  assert.equal(sync, 3, 'legacy 三条在同步里撤了');
  // 手动撤回：本机新发的两条也撤。
  page.tell({ type: 'withdraw' });
  await host.settle();
  const calls = host.retractCalls;
  assert.ok(calls.every(call => typeof call.id === 'string' && call.id && Object.keys(call).sort().join() === 'id,kind'), '每次都带 id，只有 kind 和 id');
  assert.deepEqual(retracts(host).map(([, id]) => id).sort(), [`${day}/${old}`, `${old}/${month}`, `machine-1/${month}`, 'machine-1', old].sort());
  assert.ok(!retracts(host).some(([, id]) => id.includes('other-machine') || id === 'machine-1x'));
  const untouched = ['other-machine', 'machine-1x'];
  for (const record of host.records.filter(r => untouched.some(name => r.id.includes(name)) || r.author === FRIEND)) assert.ok(Object.keys(record.body).length > 0, `${record.author.slice(8, 12)} ${record.id} 被误撤`);
  assert.deepEqual(indexOf(state), {});
  assert.equal(page.last('status').lastError, null);
});

test('撤回没完成（排队、证书过期、出错）：保留本机索引，如实提示；之后能撤成', async t => {
  freeze(t);
  const state = mkdir(t), host = fake({ state, settings: { 'token-board.share': true }, usage: [bucket(startOfBucket(now))] });
  activate(host.coda);
  const page = await openAndSync(host);
  const keys = Object.keys(indexOf(state));
  assert.equal(keys.length, 2);
  host.retractState = 'needs_cert';
  page.tell({ type: 'withdraw' });
  await host.settle();
  assert.deepEqual(Object.keys(indexOf(state)), keys);
  assert.match(page.last('status').notice, /证书已过期.*排队/);
  assert.equal(page.last('status').lastError, null);
  host.retractState = 'queued';
  page.tell({ type: 'withdraw' });
  await host.settle();
  assert.deepEqual(Object.keys(indexOf(state)), keys);
  assert.match(page.last('status').notice, /已排队/);
  host.retractState = 'error';
  page.tell({ type: 'withdraw' });
  await host.settle();
  assert.deepEqual(Object.keys(indexOf(state)), keys);
  assert.match(page.last('status').lastError, /撤回 .* 失败：网关拒绝了撤回/);
  assert.equal(page.last('status').notice, null);
  host.retractState = null;
  page.tell({ type: 'withdraw' });
  await host.settle();
  assert.deepEqual(indexOf(state), {});
  assert.equal(page.last('status').lastError, null);
  assert.match(page.last('status').notice, /已撤回/);
});

// ——— 榜单 ———

test('页面取榜单：本机用量、经网关按作者翻页读记录（沿 cursor）、好友备注与自己名片、截断标记', async t => {
  const state = mkdir(t), at = startOfBucket(now), clock = new Date(at).toISOString().slice(11, 16), day = new Date(at).toISOString().slice(0, 10);
  const block = { blocks: { [clock]: { codex: { gpt: { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0, turns: 4, reportedTurns: 4 } } } } };
  const host = fake({ state, usage: [bucket(at)], records: [
    ...['dev1', 'dev2', 'dev3'].map((dev, i) => ({ author: FRIEND, kind: usageKind, id: `${day}/${dev}`, version: i + 1, local: false, body: block })),
    { author: AUTHOR, kind: 'profile', id: 'self', version: 3, local: true, body: { name: '我<i>自己</i>\u0000', emoji: '🧑', color: 'teal' } },
    { author: FRIEND, kind: 'profile', id: 'self', version: 2, local: false, body: { name: '名片里的小明', emoji: '🦊' } },
  ] });
  host.friends = [{ node: 'n1', author: FRIEND, status: 'bound', note: '  备注 小明  ', profileName: '名片里的小明', title: '备注 小明', emoji: '🦊', color: 'orange' }];
  host.pageSize = 1;
  activate(host.coda);
  const page = host.open();
  page.tell({ type: 'board', range: 'today', id: 7 });
  const board = await page.waitFor('board');
  assert.equal(board.id, 7);
  assert.equal(board.accord, true);
  assert.equal(board.selfAuthor, AUTHOR);
  assert.equal(board.friendCount, 1);
  assert.deepEqual(board.people.map(e => [e.author, e.self]), [[FRIEND, false], [AUTHOR, true]]);
  assert.equal(board.sources.filter(source => source.author === FRIEND).reduce((n, source) => n + source.totalTokens, 0), 3000, '三页都读到了');
  assert.equal(board.people[0].name, '备注 小明', '备注优先于名片');
  assert.equal(board.people[0].emoji, '🦊');
  assert.equal(board.people[0].color, 'orange');
  assert.equal(board.people[1].name, '我<i>自己</i>');
  assert.equal(board.people[1].emoji, '🧑');
  assert.equal(board.people[1].color, 'teal');
  assert.equal(board.sources.find(source => source.local).totalTokens, 116);
  assert.ok(!('entries' in board), '不再另发一份按作者聚合的统计');
  assert.deepEqual(board.truncated, { usage: false, friends: false, profiles: false });
  assert.equal(board.syncState, 'disabled');
  assert.equal(board.curve.at(-1).totalTokens + board.curve.at(-2).totalTokens, 116);
  const usageQuery = host.calls.find(([kind]) => kind === 'coda/usage@1');
  assert.equal(usageQuery[1], 'buckets');
  assert.ok(usageQuery[2].limit <= 500);
  const social = host.calls.filter(([kind]) => kind === SOCIAL);
  assert.deepEqual(social.find(([, op]) => op === 'friends')[2], { includePending: false });
  assert.deepEqual(social.filter(([, op, input]) => op === 'records' && input.kind === 'profile').map(([, , input]) => input), [{ kind: 'profile', author: AUTHOR, id: 'self', limit: 1 }]);
  const pages = social.filter(([, op, input]) => op === 'records' && input.kind === usageKind && input.author === FRIEND).map(([, , input]) => input);
  assert.deepEqual(pages.map(input => input.cursor), [undefined, '1', '2'], '沿 nextCursor 翻页');
  assert.ok(social.every(([, op, input]) => op !== 'records' || input.kind === 'profile' || input.limit === 200));
  for (const kind of [dayKind, todayKind]) assert.ok(social.some(([, , input]) => input.kind === kind && input.author === FRIEND), kind);
  assert.ok(social.some(([, , input]) => input.kind === dayKind && input.author === AUTHOR), '自己的也读');
});

test('翻页保护：cursor 重复不死循环，页数封顶，标记 truncated；只记一条提示，不拖垮榜单', async t => {
  const state = mkdir(t), at = startOfBucket(now), day = new Date(at).toISOString().slice(0, 10);
  const host = fake({ state, usage: [bucket(at)], records: [{ author: FRIEND, kind: usageKind, id: `${day}/dev1`, version: 1, local: false, body: { blocks: {} } }] });
  activate(host.coda);
  const base = host.coda.query;
  let loops = 0;
  host.coda.query = async (ref, operation, input) => {
    if (ref.kind === SOCIAL && operation === 'records' && input.kind === todayKind && input.author === FRIEND) { loops += 1; return { records: [], truncated: true, nextCursor: 'same' }; }
    if (ref.kind === SOCIAL && operation === 'records' && input.kind === dayKind && input.author === FRIEND) { loops += 1; return { records: [], truncated: true, nextCursor: `c${loops}` }; }
    return base(ref, operation, input);
  };
  const page = host.open();
  page.tell({ type: 'board', range: 'today', id: 1 });
  const board = await page.waitFor('board');
  assert.equal(board.truncated.friends, true);
  assert.ok(loops <= 3 + 50, `翻页有上限，实际 ${loops}`);
  assert.equal(board.local.totalTokens, 116);
  assert.deepEqual(board.errors, []);
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
  assert.equal(board.local, null, '没读到本机用量不能当成没有用量');
  assert.deepEqual(board.sources, [], '也不交出一份零值的本机来源');
  for (const bad of [null, 5, 'x', {}, { type: 'unknown' }]) page.tell(bad);
  await host.settle();
  assert.equal(page.got.filter(m => m.type === 'error').length, 0);
});

test('榜单回包超过宿主消息上限：回一个送得到的失败（带请求标识），不发 board', async t => {
  freeze(t);
  const at = startOfBucket(now), host = fake({ state: mkdir(t), usage: Array.from({ length: 1500 }, (_, i) => bucket(at, { model: `model-${i}-${'x'.repeat(40)}` })) });
  activate(host.coda);
  const page = host.open();
  page.tell({ type: 'board', range: 'today', id: 9 });
  const failure = await page.waitFor('error');
  assert.deepEqual([failure.request, failure.id], ['board', 9]);
  assert.ok(failure.message.includes('超过宿主'));
  assert.equal(page.last('board'), undefined);
  page.tell({ type: 'board', range: 'today', id: 10 });
  assert.equal((await page.waitFor('error', page.got.length)).id, 10);
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

test('分享开着：首跳 5 秒后发布，之后每 10 分钟查一次；内容没变没有新写入，跨过 30 分钟边界曲线才有新写入', async t => {
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
  assert.equal(host.published.length, 2, '内容没变，网关不重发');
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
  host.certState = 'needs_cert';
  const before = page.got.length;
  mock.timers.tick(10 * 60_000);
  await drain();
  assert.equal(page.got.length - before, 1, '只推了一次状态');
  assert.equal(page.last('status').syncState, 'needs_cert');
  host.certState = 'active';
  mock.timers.tick(10 * 60_000);
  await drain();
  assert.equal(page.last('status').syncState, 'synced');
  const settled = page.got.length;
  mock.timers.tick(10 * 60_000);
  await drain();
  assert.equal(page.got.length, settled, '状态没变就不推');
});

test('好友查询失败时统计与曲线照常，只记一条提示；记录读不出时自己的统计还在', async t => {
  freeze(t);
  const state = mkdir(t), host = fake({ state, settings: { 'token-board.share': true }, usage: [bucket(startOfBucket(now))] });
  activate(host.coda);
  const page = host.open();
  page.tell({ type: 'hello' });
  await page.waitFor('status');
  const ask = async id => { const n = page.got.length; page.tell({ type: 'board', range: 'today', id }); return page.waitFor('board', n); };
  assert.equal((await ask(1)).syncState, 'pending', '还没发布过：既不是 synced 也不是 no_identity');
  host.friendsError = new Error('好友读不出');
  const first = await ask(2);
  assert.equal(first.local.totalTokens, 116);
  assert.equal(first.curve.reduce((n, slot) => n + slot.totalTokens, 0), 116);
  assert.ok(first.errors.some(e => e.includes('好友读不出')));
  host.friendsError = null;
  host.recordsError = new Error('记录读不出');
  const second = await ask(3);
  assert.equal(second.local.totalTokens, 116);
  assert.equal(second.curve.reduce((n, slot) => n + slot.totalTokens, 0), 116);
  assert.ok(second.errors.some(e => e.includes('好友')));
  assert.equal(second.sources.find(source => source.local).totalTokens, 116);
  host.recordsError = null;
  page.tell({ type: 'sync' });
  await host.settle();
  assert.equal(page.last('status').syncState, 'synced');
});

test('已发布索引的键带作者：24 小时证书换了根作者，新作者的记录会全量重发', async t => {
  freeze(t);
  const state = mkdir(t), other = `ed25519:${'c'.repeat(64)}`;
  const host = fake({ state, settings: { 'token-board.share': true }, usage: [bucket(startOfBucket(now))] });
  activate(host.coda);
  const page = await openAndSync(host);
  assert.equal(host.published.length, 2);
  page.tell({ type: 'sync' });
  await host.settle();
  assert.equal(host.published.length, 2, '同一作者没变没有新写入');
  host.author = other;
  page.tell({ type: 'sync' });
  await host.settle();
  assert.equal(host.published.length, 4, '换了作者，同样的内容也要重发');
  const keys = Object.keys(indexOf(state));
  assert.deepEqual(keys.map(key => key.slice(0, AUTHOR.length)).sort(), [AUTHOR, AUTHOR, other, other]);
});

test('board() 与 status() 共用同一套 syncState：已同步后网关消失、切换作者、关闭再开启分享，两边始终一致', async t => {
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
  host.gateway = false;
  assert.equal(await both(), 'no_gateway');
  host.gateway = true;
  assert.equal(await both(), 'pending', '网关回来，要重新发布一次才算同步');
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
  host.certState = 'needs_cert';
  page.tell({ type: 'set-share', on: true });
  await host.settle();
  assert.equal(await both(), 'needs_cert');
  host.certState = 'active';
  page.tell({ type: 'sync' });
  await host.settle();
  assert.equal(await both(), 'synced');
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

test('榜单读到状态变了（好友网关没了）会把最新状态推给页面，不用等 hello', async t => {
  freeze(t);
  const state = mkdir(t), host = fake({ state, settings: { 'token-board.share': true }, usage: [bucket(startOfBucket(now))] });
  activate(host.coda);
  const page = host.open();
  page.tell({ type: 'hello' });
  await page.waitFor('status');
  page.tell({ type: 'sync' });
  await host.settle();
  assert.equal(page.last('status').syncState, 'synced');
  host.gateway = false;
  const n = page.got.length;
  page.tell({ type: 'board', range: 'today', id: 1 });
  const board = await page.waitFor('board', n);
  assert.equal(board.syncState, 'no_gateway');
  assert.equal(page.last('status').syncState, 'no_gateway', '页面上的 status 已跟着更新');
  const pushed = page.got.length;
  page.tell({ type: 'board', range: 'today', id: 2 });
  await page.waitFor('board', pushed);
  assert.deepEqual(page.got.slice(pushed).map(m => m.type), ['board'], '状态没变就不重复推');
});

// ——— 不直接访问 coda/accord@1 ———

test('零直接访问 coda/accord@1：整套发布、榜单、撤回流程只碰 coda/usage@1、coda/machine@1 与 friends/social@1；源码里也没有', async t => {
  freeze(t);
  const state = mkdir(t), host = fake({ state, settings: { 'token-board.share': true }, usage: [bucket(startOfBucket(now))] });
  host.machine = 'machine-1';
  activate(host.coda);
  const page = await openAndSync(host);
  page.tell({ type: 'board', range: '7d', id: 1 });
  await page.waitFor('board');
  page.tell({ type: 'withdraw' });
  await host.settle();
  assert.deepEqual([...host.touched].sort(), ['coda/machine@1', 'coda/usage@1', SOCIAL]);
  const dir = new URL('../../../plugins/token-board/', import.meta.url);
  for (const file of ['main.mjs', 'lib/usage.mjs', 'view/app.mjs', 'package.json']) assert.ok(!readFileSync(new URL(file, dir), 'utf8').includes('coda/accord@1'), file);
  const manifest = JSON.parse(readFileSync(new URL('package.json', dir), 'utf8'));
  assert.deepEqual(manifest.uses, { 'coda/usage@1': ['read'], 'coda/machine@1': ['read'] });
  assert.deepEqual(manifest.optionalUses, { [SOCIAL]: ['read', 'publish'] });
  assert.equal(manifest.extensionDependencies, undefined);
});

// ——— 统一汇总、部分撤回、作者切换、真网关集成 ———

test('统一汇总：旧块 / legacy 的撤回返回 queued、needs_cert 时整体不是 synced、不刷新 lastSyncAt，提示说明排队；确认完成后才 synced', async t => {
  const state = mkdir(t), at = Date.UTC(2026, 10, 20, 10, 5), old = '11111111-2222-3333-4444-555555555555';
  mock.timers.enable({ apis: ['Date'], now: at });
  t.after(() => mock.timers.reset());
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, 'source.json'), JSON.stringify({ source: 'machine', sourceId: 'machine-1', legacy: [old] }));
  // 本机上一轮记着一个整月块；这一轮月块拆成半月，整月块是要撤的旧块。
  writeFileSync(join(state, 'published.json'), JSON.stringify({ [`${AUTHOR}:${dayKind}:machine-1/2026-11`]: true }));
  const big = [];
  for (let d = 1; d <= 20; d++) for (let m = 0; m < 60; m++) big.push(bucket(Date.UTC(2026, 10, d, 1), { model: `model-${m}-${'x'.repeat(30)}` }));
  const host = fake({ state, settings: { 'token-board.share': true }, usage: big });
  activate(host.coda);
  const page = host.open();
  page.tell({ type: 'hello' });
  await page.waitFor('status');
  const sync = async () => { mock.timers.tick(60_000); page.tell({ type: 'sync' }); await host.settle(); return page.last('status'); };
  for (const retractState of ['queued', 'needs_cert']) {
    host.retractState = retractState;
    const status = await sync();
    assert.equal(status.syncState, retractState, '旧块没撤成，不报 synced');
    assert.equal(status.lastSyncAt, null);
    if (retractState === 'queued') assert.match(status.notice, /好友网关排队/);
    assert.ok(Object.keys(indexOf(state)).some(key => key.endsWith('machine-1/2026-11')), '旧块的键留着');
  }
  host.retractState = null;
  let status = await sync();
  assert.equal(status.syncState, 'synced');
  const doneAt = status.lastSyncAt;
  assert.ok(doneAt > 0);
  // legacy 旧 UUID 的撤回没确认完成：同样不报 synced，不刷新 lastSyncAt。
  writeFileSync(join(state, 'source.json'), JSON.stringify({ source: 'machine', sourceId: 'machine-1', legacy: [old] }));
  deactivate();
  const second = fake({ state, settings: { 'token-board.share': true }, usage: big, records: [{ author: AUTHOR, kind: todayKind, id: old, version: 1, local: true, body: buildTodayBody(big, { now: at }) }] });
  second.retractState = 'queued';
  activate(second.coda);
  const again = second.open();
  again.tell({ type: 'hello' });
  await again.waitFor('status');
  mock.timers.tick(60_000);
  again.tell({ type: 'sync' });
  await second.settle();
  assert.equal(again.last('status').syncState, 'queued');
  assert.equal(again.last('status').lastSyncAt, null, '新实例还没同步成功过');
  second.retractState = null;
  mock.timers.tick(60_000);
  again.tell({ type: 'sync' });
  await second.settle();
  assert.equal(again.last('status').syncState, 'synced');
  assert.ok(again.last('status').lastSyncAt > 0);
});

test('统一汇总：发布返回 queued 时 lastSyncAt 不被刷新', async t => {
  freeze(t);
  const state = mkdir(t), host = fake({ state, settings: { 'token-board.share': true }, usage: [bucket(startOfBucket(now))] });
  activate(host.coda);
  const page = await openAndSync(host);
  const first = page.last('status').lastSyncAt;
  assert.ok(first > 0);
  mock.timers.tick(60_000);
  host.publishStates = { [todayKind]: 'queued' };
  host.usage = [bucket(startOfBucket(now), { input: 99 })];
  page.tell({ type: 'sync' });
  await host.settle();
  assert.equal(page.last('status').syncState, 'queued');
  assert.equal(page.last('status').lastSyncAt, first);
  assert.match(page.last('status').notice, /好友网关排队/);
});

test('部分撤回：两条目标，一条 retracted、另一条 needs_cert / error，本机索引两条键都保留；全部完成后才清', async t => {
  freeze(t);
  for (const bad of ['needs_cert', 'error']) {
    const state = mkdir(t), month = monthOf(now);
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, 'source.json'), JSON.stringify({ source: 'machine', sourceId: 'machine-1', legacy: [] }));
    const keys = [`${AUTHOR}:${dayKind}:machine-1/${month}`, `${AUTHOR}:${todayKind}:machine-1`];
    writeFileSync(join(state, 'published.json'), JSON.stringify(Object.fromEntries(keys.map(key => [key, true]))));
    const host = fake({ state });
    host.retractStates = { 'machine-1': bad };
    activate(host.coda);
    const page = host.open();
    page.tell({ type: 'withdraw' });
    await host.settle();
    assert.deepEqual(retracts(host).sort(), [[dayKind, `machine-1/${month}`], [todayKind, 'machine-1']].sort());
    assert.deepEqual(Object.keys(indexOf(state)).sort(), keys.sort(), `${bad}：已撤成的那条也不提前从索引删`);
    host.retractStates = {};
    page.tell({ type: 'withdraw' });
    await host.settle();
    assert.deepEqual(indexOf(state), {});
    deactivate();
  }
});

test('作者切换：列表读到 A、发布时网关以 B 签名：记录登记在 B 名下，不以 A 清理旧块和 legacy，也不把 A 记为 synced', async t => {
  freeze(t);
  const state = mkdir(t), other = `ed25519:${'c'.repeat(64)}`, old = '11111111-2222-3333-4444-555555555555', month = monthOf(now);
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, 'source.json'), JSON.stringify({ source: 'machine', sourceId: 'machine-1', legacy: [old] }));
  writeFileSync(join(state, 'published.json'), JSON.stringify({ [`${AUTHOR}:${dayKind}:machine-1/${month}-1`]: true, [`${AUTHOR}:${todayKind}:${old}`]: true }));
  const host = fake({ state, settings: { 'token-board.share': true }, usage: [bucket(startOfBucket(now))] });
  host.signedAs = other;
  activate(host.coda);
  const page = await openAndSync(host);
  assert.equal(host.retractCalls.length, 0, '没有基于旧作者的清理');
  const keys = Object.keys(indexOf(state));
  assert.ok(keys.includes(`${other}:${dayKind}:machine-1/${month}`) && keys.includes(`${other}:${todayKind}:machine-1`), '登记在 B 名下');
  assert.ok(!keys.includes(`${AUTHOR}:${dayKind}:machine-1/${month}`) && !keys.includes(`${AUTHOR}:${todayKind}:machine-1`), '没有登记在 A 名下');
  assert.notEqual(page.last('status').syncState, 'synced');
  assert.equal(page.last('status').lastSyncAt, null);
  assert.equal(page.last('status').notice, '身份已切换，本轮同步尚未确认', '不显示「已同步」');
  host.author = other;
  host.signedAs = null;
  page.tell({ type: 'hello' });
  await page.waitFor('status', page.got.length - 1);
  assert.equal(page.last('status').syncState, 'pending', '新作者要重新同步一次才算 synced');
});

test('集成（真 gateway.mjs）：无身份开启分享同步 → 手动撤回 → 恢复身份并冲洗：网关待发为 0，Accord 收到 0 次发布', async t => {
  freeze(t);
  const state = mkdir(t), gwDir = mkdtempSync(join(tmpdir(), 'token-board-gw-'));
  t.after(() => rmSync(gwDir, { recursive: true, force: true }));
  const accord = { author: null, publishes: [] };
  const accordEntry = () => ({ spec: { author: accord.author }, status: { friends: [], certificate: accord.author ? { active: true, until: now + 86_400_000 } : null } });
  const handlers = {};
  let status = null, onChange = null;
  const gatewayCoda = {
    get: async () => accordEntry(),
    call: async (ref, operation, input) => { assert.equal(operation, 'publish'); accord.publishes.push(structuredClone(input)); return { author: accord.author, version: accord.publishes.length }; },
    query: async () => ({ records: [], truncated: false }),
    put: async (ref, value) => { status = value.status; },
    handle: (kind, name, fn) => { handlers[name] = fn; return { dispose() {} }; },
    stream: async () => ({ dispose() {} }),
    watch: async (kind, fn) => { onChange = fn; return { dispose() {} }; },
  };
  const gateway = createGateway(gatewayCoda, gwDir);
  t.after(() => gateway.stop());
  await gateway.start();
  const host = fake({ state, settings: { 'token-board.share': true }, usage: [bucket(startOfBucket(now))] });
  const base = { list: host.coda.list, query: host.coda.query };
  host.coda.list = (kind, filter) => (kind === SOCIAL ? Promise.resolve([{ id: 'local', status }]) : base.list(kind, filter));
  host.coda.query = (ref, operation, input) => (ref.kind === SOCIAL ? handlers[operation](input) : base.query(ref, operation, input));
  host.coda.call = (ref, operation, input) => handlers[operation](input);
  activate(host.coda);
  const page = await openAndSync(host);
  assert.equal(page.last('status').syncState, 'no_identity');
  assert.equal((await handlers.outbox({})).pendingCount, 2, '无身份：两条交给网关排队');
  assert.equal(accord.publishes.length, 0);

  page.tell({ type: 'withdraw' });
  await host.settle();
  assert.equal(page.last('status').lastError, null);
  assert.equal((await handlers.outbox({})).pendingCount, 0, '撤回取消了网关里本机的待发项');
  assert.deepEqual(indexOf(state), {});

  accord.author = AUTHOR;
  onChange({ type: 'MODIFIED', entry: accordEntry() });
  await host.settle();
  await host.settle();
  assert.equal((await handlers.outbox({})).pendingCount, 0);
  assert.equal(accord.publishes.length, 0, '恢复身份冲洗后，已撤回的用量没有泄露出去');
});
