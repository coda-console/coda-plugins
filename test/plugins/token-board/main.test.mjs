// Token 消耗榜的模块，用假 coda 和假好友网关（friends/social@1）跑：activate 不读任何记录也不抛错；每轮同步把本机用量、这台的状态、镜像来的好友记录整份写进目录
// （coda.replace，写出去的 spec 都按清单里的协议校验）；开启分享经网关发布月块日归档与 48 小时曲线（去重在网关）；
// 关闭分享按本机 sourceId 筛出自己的记录、逐条带 id 撤回，绝不按 kind 批量撤回、不动别的设备；没有好友插件时本机统计照常、状态 no_gateway；
// 网关状态（needs_cert、paused、no_identity、queued）如实透传；来源 ID 优先取机器 ID、读不到不抖动、换了以后不双计；全程不直接访问 coda/accord@1；deactivate 清理干净。
// 模块自己的定时器（首跳、每 10 分钟同步、每分钟曲线、好友变动的去抖）被截下来，由测试直接触发。
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { pointProblem } from '@coda-console/protocol/validate';
import { buildArchiveBodies, buildTodayBody, readTodayRecord } from '../../../plugins/token-board/lib/usage.mjs';
import { summarize } from '../../../plugins/token-board/lib/merge.mjs';
import { createGateway } from '../../../plugins/friends/lib/gateway.mjs';
import { CURVE_INTERVAL_MS, FIRST_SYNC_DELAY_MS, MIRROR_DEBOUNCE_MS, SYNC_INTERVAL_MS, activate, deactivate } from '../../../plugins/token-board/main.mjs';

const PROTOCOL = JSON.parse(readFileSync(new URL('../../../plugins/token-board/package.json', import.meta.url), 'utf8')).contributes.protocols[0];
const USAGE_PROTOCOL = PROTOCOL.name;
// 模块自己的定时器：截下来，测试直接触发；别的定时器照旧。
const held = {};
const hold = (ms, fn) => { held[ms] = fn; return { unref() {}, ref() {} }; };
const realSetTimeout = globalThis.setTimeout, realSetInterval = globalThis.setInterval;
globalThis.setTimeout = (fn, ms, ...rest) => (ms === FIRST_SYNC_DELAY_MS || ms === MIRROR_DEBOUNCE_MS ? hold(ms, fn) : realSetTimeout(fn, ms, ...rest));
globalThis.setInterval = (fn, ms, ...rest) => (ms === SYNC_INTERVAL_MS || ms === CURVE_INTERVAL_MS ? hold(ms, fn) : realSetInterval(fn, ms, ...rest));

const AUTHOR = `ed25519:${'a'.repeat(64)}`, FRIEND = `ed25519:${'b'.repeat(64)}`;
// 时钟与时区都固定：榜单的「今天」按本机日历日算，而记录里的日、时钟键是 UTC，用真实时间或本机时区的话，当地午夜附近（以及东八区早晨）这些用例会随跑的时刻变红。
process.env.TZ = 'UTC';
const now = Date.parse('2026-03-18T10:07:30Z');
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
const SOCIAL = 'friends/social@1', SAME = 'magpie/models@1';
const gone = code => Object.assign(new Error(`没有好友网关：${code}`), { code });
const retracts = host => host.retractCalls.map(call => [call.kind, call.id]);

function fake({ settings = {}, usage = [], records = [], friends, state, previous = [] } = {}) {
  const calls = [], published = [], attempts = [], retractCalls = [], queued = [], touched = new Set(), views = new Map(), listeners = [], own = new Map(), handlers = new Map();
  let current = { ...settings }, version = 0, booted = false;
  for (const key of Object.keys(held)) delete held[key];
  const host = {
    calls, published, attempts, retractCalls, queued, touched, views, records,
    usage,
    written: structuredClone(previous),   // 目录里本插件的记录：上次 coda.replace 交出的全集 [{ key, spec }]（重启后留在目录里）
    replaces: 0,               // replace 调了几次
    replaceError: null,        // 非空就让 replace 抛它
    watches: [],               // 模块对好友网关的订阅回调
    friends: friends ?? [{ node: 'n1', author: FRIEND, status: 'bound' }],
    sameNames: undefined,      // 本机 Magpie 插件给的映射 { [asked]: 名字 }；undefined 是没装 Magpie 插件，Error 是 names 查询失败
    sameServices: ['coda://openai-responses/11111111-2222-3333-4444-555555555555'],   // 本机 Magpie 插件提供的服务（用量行里 tagged 用的那个）
    sameReads: 0,              // names 查询读了几次
    machine: undefined,        // 本机的机器 ID；Error 表示读不到
    gateway: true,             // 好友插件在不在
    listError: null,           // 非空就让列出好友网关抛它
    friendsTruncated: false,   // 网关的 friends 查询带不带（已不再使用的）truncated
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
      watch: async (kind, fn, filter) => {
        touched.add(kind);
        assert.equal(kind, SOCIAL, '模块只订阅好友网关');
        assert.deepEqual(filter, { scope: 'local' });
        host.watches.push(fn);
        fn({ type: 'ADDED', id: 'local', entry: {} });   // 现有的先给完，之后才是变化
        return { dispose() { host.watches.splice(host.watches.indexOf(fn), 1); } };
      },
      handle: (kind, operation, fn) => { assert.equal(kind, USAGE_PROTOCOL); handlers.set(operation, fn); return { dispose() { handlers.delete(operation); } }; },
      // 全有或全无：每条 spec 合协议、整条（含外壳）不超过 64 KiB、key 不重复，才写。
      replace: async (kind, items) => {
        assert.equal(kind, USAGE_PROTOCOL);
        if (host.replaceError) throw host.replaceError;
        assert.equal(new Set(items.map(item => item.key)).size, items.length, 'replace 的 key 重复');
        for (const { key, spec } of items) {
          assert.equal(pointProblem(PROTOCOL.spec, spec, 'spec'), null, key);
          assert.ok(Buffer.byteLength(JSON.stringify({ key, spec })) < 64 * 1024 - 1024, `${key} 超限`);
        }
        host.written = structuredClone(items);
        host.replaces += 1;
        return items;
      },
      list: async (kind, filter) => {
        if (kind === USAGE_PROTOCOL) {
          assert.deepEqual(filter, { scope: 'local' });
          return host.written.map(({ key, spec }) => ({ key, spec: structuredClone(spec), local: true }));
        }
        touched.add(kind);
        assert.deepEqual(filter, { scope: 'local' });
        if (kind === SAME) {
          if (host.sameNames === undefined) throw gone('not_found');
          return [{ id: 'magpie-1' }];
        }
        if (kind === 'coda/machine@1') {
          if (host.machine instanceof Error) throw host.machine;
          return host.machine ? [{ id: 'other-machine', local: false }, { id: host.machine, local: true }] : [];
        }
        assert.equal(kind, SOCIAL);
        if (host.listError) throw host.listError;
        const status = { author: host.author, certState: host.author ? host.certState : 'no_identity', friendCount: host.friends.length, pendingCount: queued.length, pausedKinds: host.pausedKinds };
        return host.gateway ? [{ id: 'local', status }] : [];
      },
      query: async (ref, operation, input, options) => {
        touched.add(ref.kind);
        calls.push([ref.kind, operation, input]);
        if (ref.kind === SAME) {
          assert.deepEqual([ref, operation, input], [{ kind: SAME, id: 'magpie-1' }, 'names', {}]);
          assert.ok(options.timeout > 0, '读映射要有期限');
          host.sameReads += 1;
          if (host.sameNames instanceof Error) throw host.sameNames;
          return { names: host.sameNames, services: host.sameServices };
        }
        if (ref.kind === 'coda/usage@1') return { buckets: host.usage.filter(b => b.start >= input.from && b.start < input.to), truncated: false };
        assert.deepEqual(ref, { kind: SOCIAL, id: 'local' });
        if (operation === 'friends') {
          if (host.friendsError) throw host.friendsError;
          return { selfAuthor: host.author, certState: host.author ? host.certState : 'no_identity', friends: host.friends, ...(host.friendsTruncated ? { truncated: true } : {}) };
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
    // 首跳、每 10 分钟同步、每分钟曲线：触发模块自己的定时器，等它做完。
    async boot() { booted = true; held[FIRST_SYNC_DELAY_MS]?.(); await host.settle(); },
    async sync() { held[SYNC_INTERVAL_MS]?.(); await host.settle(); },
    async curve() { held[CURVE_INTERVAL_MS]?.(); await host.settle(); },
    async friendsChanged() { for (const fn of [...host.watches]) fn({ type: 'MODIFIED', id: 'local', entry: {} }); },
    async debounced() { held[MIRROR_DEBOUNCE_MS]?.(); await host.settle(); },
    // 页面（资源页里的）对这台状态记录调 set-share。
    async setShare(on) { const result = await handlers.get('set-share')({ on }, { record: { kind: USAGE_PROTOCOL, id: 'state' } }); await host.settle(); return result; },
    state: () => host.written.find(item => item.key === 'state')?.spec,
    usageRecords: () => host.written.filter(item => item.spec.record === 'usage').map(item => item.spec),
    mirrored: () => host.written.filter(item => item.spec.record === 'mirror').map(item => item.spec),
    // 把写出去的记录当成目录里的条目交给页面的合并函数。
    summary: (from, to) => summarize(host.written.map(({ key, spec }) => ({ owner: 'me', location: 'Mac', local: true, id: key, version: '1', spec })), { from, to }),
    // 旧页面消息的替身：只留这几个，让下面的发布、撤回用例照旧读状态、触发同步。
    open() {
      const page = { got: [] };
      page.tell = async message => {
        if (message?.type === 'hello' && !booted) await host.boot();
        else if (message?.type === 'sync') await host.sync();
        else if (message?.type === 'set-share') await host.setShare(message.on === true);
        else if (message?.type === 'withdraw') await host.setShare(false);
      };
      page.last = type => (type === 'status' ? host.status() : undefined);
      page.waitFor = async () => { for (let i = 0; i < 200 && !host.state(); i++) await new Promise(r => setTimeout(r, 5)); return host.status(); };
      return page;
    },
    status() { const state = host.state(); return state && { share: state.share, syncState: state.syncState, lastSyncAt: state.lastSyncAt, lastError: state.error }; },
    async change(next) { current = { ...current, ...next }; for (const fn of [...listeners]) await fn(structuredClone(current)); },
    settle: () => new Promise(r => setTimeout(r, 40)),
  };
  return host;
}
const indexOf = state => JSON.parse(readFileSync(join(state, 'published.json'), 'utf8'));
// 首跳：读设置、同步一次。
async function openAndSync(host) {
  const page = host.open();
  await host.boot();
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
  assert.deepEqual(day.body.days[new Date(at).toISOString().slice(0, 10)].claude.find(row => row.m === 'opus').n, [10, 5, 100, 1, 2, 2]);
  assert.equal(today.id, sourceId);
  assert.equal(today.body.slotMs, 1_800_000);
  assert.deepEqual(today.body.slots[Math.floor(at / 1_800_000) * 1_800_000].claude.find(row => row.m === 'opus').n, [10, 5, 100, 1, 2, 2]);
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
  const host = fake({ state, settings: { 'token-board.share': false }, usage: [bucket(at)], records: others });
  activate(host.coda);
  const page = await openAndSync(host);
  assert.equal(host.published.length, 0);
  assert.equal(page.last('status').syncState, 'disabled');
  assert.equal(host.usageRecords().length, 2, '没分享也照常写本机用量记录');

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
});

test('设置里把分享打开 / 关掉，模块跟着发布 / 撤回；别的设置变了不动记录', async t => {
  freeze(t);
  const state = mkdir(t);
  const host = fake({ state, settings: { 'token-board.share': false }, usage: [bucket(startOfBucket(now))] });
  activate(host.coda);
  const page = host.open();
  page.tell({ type: 'hello' });
  await page.waitFor('status');
  assert.equal(page.last('status').share, false);
  await host.change({ 'token-board.share': true });
  await host.settle();
  assert.equal(host.published.length, 2);
  await host.change({ 'token-board.share': false });
  await host.settle();
  assert.equal(host.retractCalls.length, 2);
  await host.change({ 'token-board.other': 1 });
  await host.settle();
  assert.equal(host.published.length, 2);
  assert.equal(host.retractCalls.length, 2);
  assert.equal(host.state().share, false);
});

test('页面上临时切的分享开关，被设置里的改动盖过', async t => {
  const state = mkdir(t);
  const host = fake({ state, settings: { 'token-board.share': false }, usage: [bucket(startOfBucket(now))] });
  activate(host.coda);
  const page = host.open();
  page.tell({ type: 'hello' });
  await page.waitFor('status');
  page.tell({ type: 'set-share', on: true });
  await host.settle();
  assert.equal(page.last('status').share, true);
  assert.equal(JSON.parse(readFileSync(join(state, 'prefs.json'), 'utf8')).share, true);
  await host.change({ 'token-board.share': true });
  await host.settle();
  assert.equal(page.last('status').share, true);
  assert.equal(existsSync(join(state, 'prefs.json')) && 'share' in JSON.parse(readFileSync(join(state, 'prefs.json'), 'utf8')), false, '设置里改了，以设置为准，页面存的选择作废');
});

test('默认开启后，重启仍尊重页面保存的关闭选择；别的设置变了不恢复分享', async t => {
  const state = mkdir(t);
  writeFileSync(join(state, 'prefs.json'), JSON.stringify({ share: false }));
  const host = fake({ state });
  activate(host.coda);
  await host.boot();
  assert.equal(host.state().share, false);
  await host.change({ 'token-board.other': 1 });
  await host.sync();
  assert.equal(host.state().share, false);
  assert.equal(host.attempts.length, 0);
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
    await host.boot();
    await host.sync();
    assert.equal(host.state().syncState, 'no_gateway');
    assert.equal(host.state().error, null);
    assert.equal(host.state().lastSyncAt, null, '不覆盖上次同步时间');
    assert.equal(host.attempts.length, 0);
    assert.equal(host.state().author, null);
    assert.deepEqual(host.state().friends, []);
    assert.deepEqual(host.mirrored(), []);
    const { mine, board } = host.summary(startOfBucket(now) - 86_400_000, now + 1);
    assert.equal(mine.totalTokens, 116);
    assert.deepEqual(board.entries, []);
    assert.deepEqual(host.usageRecords().map(spec => [spec.kind, spec.author]), [[dayKind, null], [todayKind, null]], '没有身份：本机用量照写，作者为 null');
    assert.deepEqual(host.calls.filter(([kind]) => kind === SOCIAL), []);
    // 关着分享：disabled。
    await host.change({ 'token-board.share': false });
    await host.settle();
    assert.equal(host.state().syncState, 'disabled');
    assert.equal(host.state().error, null, '关着分享不报同步错');
  });
}

test('本机用量记录盖住最近 32 天：页面按自己的窗口取，当地午夜之前的用量落在「今天」之外、近 7 天之内', async t => {
  freeze(t);
  const midnight = new Date(new Date(now).getFullYear(), new Date(now).getMonth(), new Date(now).getDate()).getTime();
  const state = mkdir(t), host = fake({ state, usage: [bucket(startOfBucket(midnight - 3_600_000))] });
  activate(host.coda);
  await host.boot();
  assert.equal(host.summary(midnight, now + 1).mine.totalTokens, 0, '「今天」从看页面这台的当地午夜起算，不含这条');
  assert.equal(host.summary(midnight - 7_200_000, now + 1).mine.totalTokens, 116);
  assert.equal(host.summary(midnight - 6 * 86_400_000, now + 1).mine.totalTokens, 116);
});

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
  assert.deepEqual(Object.keys(indexOf(state)), keys);
  host.gateway = true;
  page.tell({ type: 'withdraw' });
  await host.settle();
  assert.equal(host.retractCalls.length, 2);
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
  assert.equal(page.last('status').share, false);
  host.listError = null;
  page.tell({ type: 'withdraw' });
  await host.settle();
  assert.equal(host.retractCalls.length, 2);
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
  assert.equal(host.published.length, 0);
  assert.equal(host.queued.length, 2, '交给网关排队');
  assert.equal(host.state().author, null);
  assert.equal(host.summary(startOfBucket(now) - 86_400_000, now + 1).mine.totalTokens, 116);
  assert.deepEqual(host.usageRecords().map(spec => spec.author), [null, null], '没有身份：只含无身份的行，作者为 null');
  writeFileSync(join(state, 'published.json'), JSON.stringify({ [`${AUTHOR}:${dayKind}:x/2026-11`]: true }));
  const sourceId = sourceIdOf(state);
  page.tell({ type: 'withdraw' });
  await host.settle();
  assert.deepEqual(retracts(host).map(([, id]) => id).sort(), [`${sourceId}/${monthOf(now)}`, sourceId].sort(), '按网关待发队列里本机的项逐条撤，带 id');
  assert.equal(host.queued.length, 0, '待发项取消了，恢复身份后不会泄露');
  assert.deepEqual(indexOf(state), {});
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
  assert.equal(host.summary(at - 30 * 86_400_000, at + 1).mine.totalTokens, 232, '统计照常');
  assert.equal(host.summary(at - 86_400_000, at + 1).mine.totalTokens, 116);
  assert.equal(host.state().author, AUTHOR);

  host.certState = 'active';
  page.tell({ type: 'sync' });
  await host.settle();
  assert.deepEqual(host.published.map(p => [p.kind, p.id.slice(-7)]), [[dayKind, '2026-10'], [dayKind, '2026-11'], [todayKind, sourceIdOf(state).slice(-7)]]);
  assert.equal(page.last('status').syncState, 'synced');
  assert.ok(page.last('status').lastSyncAt > 0);
});

test('网关状态透传：error > no_identity > needs_cert > paused > queued > synced；paused 来自网关的 pausedKinds', async t => {
  freeze(t);
  const state = mkdir(t), host = fake({ state, settings: { 'token-board.share': true }, usage: [bucket(startOfBucket(now))] });
  activate(host.coda);
  let first = true;
  const sync = async () => { if (first) { first = false; await host.boot(); } else await host.sync(); return host.status(); };
  // 暂停了日归档：曲线照发，整体是 paused，不报错，页面照样有榜。
  host.pausedKinds = [dayKind];
  let status = await sync();
  assert.equal(status.syncState, 'paused');
  assert.equal(status.lastError, null);
  assert.deepEqual(kindsOf(host.published), [todayKind]);
  assert.equal(host.usageRecords().length, 2, '状态不影响本机用量记录');
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
  let started = false;
  const board = async () => { if (started) await host.sync(); else { started = true; await host.boot(); } };
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
  const page = await openAndSync(host);
  assert.deepEqual(sourceFile(state), { source: 'machine', sourceId: 'machine-1', legacy: [old] });
  assert.deepEqual(host.mirrored().map(spec => [spec.kind, spec.id]).sort(), [[dayKind, `tablet/${monthOf(at)}`], [todayKind, 'tablet']].sort(), '镜像里没有本机的，也没有旧 UUID 的三种旧记录，只有兄弟机器的');
  const me = host.summary(startOfBucket(now) - 86_400_000, now + 1).board.entries.find(entry => entry.self);
  assert.equal(me.totalTokens, 116 + 1000, '本机一次 + 兄弟机器，不含旧 UUID 的三种旧记录');
  assert.deepEqual(host.usageRecords().map(spec => spec.sourceId), ['machine-1', 'machine-1']);
  assert.deepEqual(host.usageRecords()[0].legacy, [old], '本机用量记录带着弃用的旧来源 ID');
  assert.deepEqual(host.published.map(p => p.id), [`machine-1/${monthOf(at)}`, 'machine-1']);
  assert.deepEqual(retracts(host).sort(), [[dayKind, `${old}/${monthOf(at)}`], [todayKind, old], [usageKind, records[0].id]].sort());
  assert.ok(!retracts(host).some(([, id]) => id.includes('tablet')));
  assert.equal(page.last('status').syncState, 'synced');
  // 撤回过的不再撤。
  const count = host.retractCalls.length;
  await host.sync();
  assert.equal(host.retractCalls.length, count);
  assert.equal(host.published.length, 2);
});

test('分享时月块拆法变了，同月不再用的旧块被逐条撤回', async t => {
  const state = mkdir(t), at = Date.UTC(2026, 10, 20, 10, 5);
  mock.timers.enable({ apis: ['Date'], now: at });
  t.after(() => mock.timers.reset());
  const big = [];
  for (let d = 1; d <= 20; d++) for (let m = 0; m < 50; m++) big.push(bucket(Date.UTC(2026, 10, d, 1), { model: `model-${m}-${'x'.repeat(30)}` }));
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
  const page = await openAndSync(host);
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
  assert.equal(page.last('status').share, false);
  assert.ok(Object.keys(indexOf(state)).length > 0, '没查全：索引留着，不当作已撤回');
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
  const page = await openAndSync(host);
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
  host.retractState = 'queued';
  page.tell({ type: 'withdraw' });
  await host.settle();
  assert.deepEqual(Object.keys(indexOf(state)), keys);
  host.retractState = 'error';
  page.tell({ type: 'withdraw' });
  await host.settle();
  assert.deepEqual(Object.keys(indexOf(state)), keys);
  host.retractState = null;
  page.tell({ type: 'withdraw' });
  await host.settle();
  assert.deepEqual(indexOf(state), {});
});

// ——— 榜单 ———

// 本机桶按 person（这台后端的根身份）归属：当前身份与无身份（空字符串）的行算当前作者的，别的身份的行不算，也不进以它签名的记录。
const OTHER = `ed25519:${'c'.repeat(64)}`;
const tagged = (at, person, over = {}) => bucket(at, { person, service: 'coda://openai-responses/11111111-2222-3333-4444-555555555555', asked: 'gpt-5', served: null, model: undefined, input: 1000, output: 0, cacheRead: 0, cacheWrite: 0, ...over });

const win = () => [startOfBucket(now) - 86_400_000, now + 1];
const slotsTotal = spec => readTodayRecord({ id: spec.id, body: spec.body }).slots.reduce((n, slot) => n + slot.rows.reduce((m, row) => m + row.input + row.output + row.cacheRead + row.cacheWrite, 0), 0);

test('目录里的记录：状态、本机用量（月块日归档与 48 小时曲线）、镜像，合起来是一份全集，每条都合协议', async t => {
  freeze(t);
  const state = mkdir(t), at = startOfBucket(now);
  const host = fake({ state, usage: [bucket(at), bucket(Date.UTC(2026, 1, 3, 4))], records: [{ author: FRIEND, kind: todayKind, id: 'phone', version: 4, local: false, body: buildTodayBody([bucket(at)], { now }) }] });
  activate(host.coda);
  assert.equal(host.replaces, 0, '启动时不写，等首跳读完设置和好友');
  await host.boot();
  const sourceId = sourceIdOf(state);
  assert.equal(host.replaces >= 1, true);
  assert.deepEqual(host.written.map(item => item.key).filter(key => !key.startsWith('mirror/')).sort(), ['state', `usage/${dayKind}/${sourceId}/2026-02`, `usage/${dayKind}/${sourceId}/2026-03`, `usage/${todayKind}/${sourceId}`].sort());
  assert.deepEqual(host.state(), { record: 'state', share: true, syncState: 'synced', lastSyncAt: now, error: null, withdrawal: null, author: AUTHOR, friends: [FRIEND] });
  const [archive] = host.usageRecords().filter(spec => spec.id === `${sourceId}/${monthOf(at)}`);
  assert.deepEqual(archive, { record: 'usage', kind: dayKind, id: `${sourceId}/${monthOf(at)}`, author: AUTHOR, sourceId, legacy: [], body: buildArchiveBodies([bucket(at)])[monthOf(at)] });
  assert.deepEqual(host.usageRecords().find(spec => spec.kind === todayKind).body, buildTodayBody([bucket(at)], { now }));
  assert.deepEqual(host.mirrored(), [{ record: 'mirror', author: FRIEND, kind: todayKind, id: 'phone', version: 4, body: buildTodayBody([bucket(at)], { now }) }]);
  // 记录是投影：重启后（新的模块实例）同样的状态给出同样的全集。
  const before = host.written;
  deactivate();
  const again = fake({ state, usage: [bucket(at), bucket(Date.UTC(2026, 1, 3, 4))], records: host.records });
  activate(again.coda);
  await again.boot();
  assert.deepEqual(again.written.map(item => item.key).sort(), before.map(item => item.key).sort());
});

test('只写当前作者与无身份的行：别的 person 的行不进本机用量记录，状态里的作者就是网关的', async t => {
  freeze(t);
  const state = mkdir(t), at = startOfBucket(now);
  const host = fake({ state, usage: [tagged(at, AUTHOR), tagged(at, ''), tagged(at, OTHER, { input: 50_000 }), tagged(at, AUTHOR, { served: 'gpt-5-2025', input: 20 })] });
  activate(host.coda);
  await host.boot();
  const { mine } = host.summary(...win());
  assert.equal(mine.input, 2020, '自己的、无身份的算，别人的 50000 不算');
  assert.deepEqual(mine.models.map(m => [m.model, m.input]), [['gpt-5', 2000], ['gpt-5-2025', 20]]);
  assert.equal(slotsTotal(host.usageRecords().find(spec => spec.kind === todayKind)), 2020, '曲线也一样');
});

test('读不到身份（没装好友插件）：没有作者可归属，本机用量不按身份切，作者为 null', async t => {
  freeze(t);
  const state = mkdir(t), at = startOfBucket(now);
  const host = fake({ state, usage: [tagged(at, AUTHOR), tagged(at, OTHER)] });
  host.gateway = false;
  activate(host.coda);
  await host.boot();
  assert.equal(host.summary(...win()).mine.input, 2000);
  assert.deepEqual(host.usageRecords().map(spec => spec.author), [null, null]);
});

test('镜像：好友与自己别的设备的记录经网关按作者、按种类翻页读（沿 cursor），不发名片查询；本机自己的不镜像', async t => {
  freeze(t);
  const state = mkdir(t), at = startOfBucket(now), clock = new Date(at).toISOString().slice(11, 16), day = new Date(at).toISOString().slice(0, 10);
  const block = { blocks: { [clock]: { codex: { gpt: { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0, turns: 4, reportedTurns: 4 } } } } };
  const host = fake({ state, usage: [bucket(at)], records: [
    ...['dev1', 'dev2', 'dev3'].map((dev, i) => ({ author: FRIEND, kind: usageKind, id: `${day}/${dev}`, version: i + 1, local: false, body: block })),
    { author: AUTHOR, kind: dayKind, id: `tablet/${monthOf(at)}`, version: 1, local: false, body: buildArchiveBodies([bucket(at)])[monthOf(at)] },
  ] });
  host.friends = [{ node: 'n1', author: FRIEND, status: 'bound', note: '  备注 小明  ', profileName: '名片里的小明', title: '备注 小明' }];
  host.pageSize = 1;
  activate(host.coda);
  await host.boot();
  const sourceId = sourceIdOf(state);
  assert.deepEqual(host.mirrored().map(spec => [spec.author === FRIEND ? 'friend' : 'me', spec.kind, spec.id, spec.version]).sort(),
    [['friend', usageKind, `${day}/dev1`, 1], ['friend', usageKind, `${day}/dev2`, 2], ['friend', usageKind, `${day}/dev3`, 3], ['me', dayKind, `tablet/${monthOf(at)}`, 1]].sort());
  assert.ok(host.mirrored().every(spec => spec.record === 'mirror' && !spec.id.includes(sourceId)));
  const { mine, board } = host.summary(...win());
  assert.equal(mine.totalTokens, 116, '我：只有本机的用量记录');
  assert.equal(board.entries.find(entry => !entry.self).totalTokens, 3000, '三页都读到了');
  assert.equal(board.entries.find(entry => entry.self).totalTokens, 116 + 116, '本机 + 另一台');
  const usageQuery = host.calls.find(([kind]) => kind === 'coda/usage@1');
  assert.equal(usageQuery[1], 'buckets');
  assert.ok(usageQuery[2].limit <= 500);
  const social = host.calls.filter(([kind]) => kind === SOCIAL);
  assert.deepEqual(social.find(([, op]) => op === 'friends')[2], { includePending: false });
  assert.ok(social.every(([, op, input]) => op !== 'records' || input.kind !== 'profile'), '不再查名片');
  const pages = social.filter(([, op, input]) => op === 'records' && input.kind === usageKind && input.author === FRIEND).map(([, , input]) => input);
  assert.deepEqual(pages.map(input => input.cursor), [undefined, '1', '2'], '沿 nextCursor 翻页');
  assert.ok(social.every(([, op, input]) => op !== 'records' || input.limit === 200));
  for (const kind of [dayKind, todayKind]) assert.ok(social.some(([, , input]) => input.kind === kind && input.author === FRIEND), kind);
  assert.ok(social.some(([, , input]) => input.kind === dayKind && input.author === AUTHOR), '自己的也读');
});

test('镜像：好友网关有变化时（去抖后）重算；订阅时先给的现有记录不触发；没有网关就清空', async t => {
  freeze(t);
  const state = mkdir(t), at = startOfBucket(now);
  const host = fake({ state, usage: [bucket(at)], records: [{ author: FRIEND, kind: todayKind, id: 'phone', version: 1, local: false, body: buildTodayBody([bucket(at)], { now }) }] });
  activate(host.coda);
  await host.boot();
  assert.equal(host.watches.length, 1, '订阅了好友网关');
  assert.equal(held[MIRROR_DEBOUNCE_MS], undefined, '订阅时先给的 ADDED 不触发重算');
  assert.equal(host.mirrored().length, 1);
  host.records.push({ author: FRIEND, kind: todayKind, id: 'laptop', version: 1, local: false, body: buildTodayBody([bucket(at)], { now }) });
  host.friends.push({ node: 'n2', author: OTHER, status: 'bound' });
  await host.friendsChanged();
  await host.friendsChanged();
  assert.equal(host.mirrored().length, 1, '去抖：还没到时候');
  await host.debounced();
  assert.deepEqual(host.mirrored().map(spec => spec.id).sort(), ['laptop', 'phone']);
  assert.deepEqual(host.state().friends, [FRIEND, OTHER]);
  host.gateway = false;
  await host.friendsChanged();
  await host.debounced();
  assert.deepEqual(host.mirrored(), []);
  assert.deepEqual(host.state().friends, []);
  assert.equal(host.state().syncState, 'no_gateway');
});

test('镜像：某个作者的某一种读失败，留着上一份；好友读失败，沿用上次的好友', async t => {
  freeze(t);
  const state = mkdir(t), at = startOfBucket(now);
  const host = fake({ state, usage: [bucket(at)], records: [{ author: FRIEND, kind: todayKind, id: 'phone', version: 1, local: false, body: buildTodayBody([bucket(at)], { now }) }] });
  activate(host.coda);
  await host.boot();
  host.recordsError = new Error('记录读不出');
  host.friendsError = new Error('好友读不出');
  await host.sync();
  assert.equal(host.mirrored().length, 1, '读失败不让镜像从目录里消失');
  assert.deepEqual(host.state().friends, [FRIEND]);
  assert.equal(host.usageRecords().length, 2, '本机用量照常');
  assert.equal(host.state().syncState, 'synced');
});

test('镜像：每条写进目录后不超过 64 KiB，超限的好友记录跳过，别的照写（replace 是全有或全无）', async t => {
  freeze(t);
  const state = mkdir(t), at = startOfBucket(now);
  const row = (n, i) => ({ a: `model-${i}-${'x'.repeat(100)}`, i: 'openai-responses', n: [n, 0, 0, 0, 1, 1] });
  const days = count => ({ v: 3, days: { '2026-03-01': { codex: Array.from({ length: count }, (_, i) => row(i + 1, i)) } } });
  const fits = days(380), huge = days(900);
  assert.ok(Buffer.byteLength(JSON.stringify(fits)) < 60 * 1024 && Buffer.byteLength(JSON.stringify(fits)) > 40 * 1024, '一条接近记录体预算的好友记录');
  assert.ok(Buffer.byteLength(JSON.stringify(huge)) > 64 * 1024);
  const host = fake({ state, usage: [bucket(at)], records: [
    { author: FRIEND, kind: dayKind, id: 'big/2026-03', version: 1, local: false, body: fits },
    { author: FRIEND, kind: dayKind, id: 'huge/2026-03', version: 1, local: false, body: huge },
    { author: FRIEND, kind: todayKind, id: 'phone', version: 1, local: false, body: buildTodayBody([bucket(at)], { now }) },
  ] });
  activate(host.coda);
  await host.boot();
  assert.deepEqual(host.mirrored().map(spec => spec.id).sort(), ['big/2026-03', 'phone']);
  assert.equal(host.replaces >= 1, true, '没有因为一条超限而整份写不进去');
});

test('本机曲线每分钟重算一次，只查最近 48 小时的桶；日归档不动', async t => {
  freeze(t);
  const state = mkdir(t), at = startOfBucket(now);
  const host = fake({ state, usage: [bucket(at)] });
  activate(host.coda);
  await host.boot();
  const archive = host.usageRecords().find(spec => spec.kind === dayKind);
  host.usage = [bucket(at, { input: 50 })];
  host.calls.length = 0;
  await host.curve();
  const queries = host.calls.filter(([kind]) => kind === 'coda/usage@1');
  assert.ok(queries.length >= 1 && queries.every(([, , input]) => input.from >= now - 48 * 3_600_000 && input.to <= now + 1), '只查最近 48 小时');
  assert.equal(slotsTotal(host.usageRecords().find(spec => spec.kind === todayKind)), 156);
  assert.deepEqual(host.usageRecords().find(spec => spec.kind === dayKind), archive, '日归档要等 10 分钟的同步');
  await host.sync();
  assert.equal(host.usageRecords().find(spec => spec.kind === dayKind).body.days[new Date(at).toISOString().slice(0, 10)].claude.reduce((n, row) => n + row.n[0], 0), 50);
});

test('set-share：开就同步，关就撤回；写进这台的状态；设置里再改以设置为准', async t => {
  freeze(t);
  const state = mkdir(t), at = startOfBucket(now);
  const host = fake({ state, settings: { 'token-board.share': false }, usage: [bucket(at)] });
  activate(host.coda);
  await host.boot();
  assert.deepEqual([host.state().share, host.state().syncState, host.published.length], [false, 'disabled', 0]);
  assert.deepEqual(await host.setShare(true), { share: true });
  assert.deepEqual([host.state().share, host.state().syncState, host.published.length], [true, 'synced', 2]);
  assert.ok(host.state().lastSyncAt > 0);
  assert.deepEqual(await host.setShare(false), { share: false });
  assert.deepEqual([host.state().share, host.state().syncState, host.retractCalls.length], [false, 'disabled', 2]);
  assert.equal(host.usageRecords().length, 2, '关了分享本机用量记录还在');
});

test('分享：以当前作者签名发布的记录只含它自己与无身份的行，别的 person 的行不进，记录里也没有服务引用', async t => {
  freeze(t);
  const state = mkdir(t), at = startOfBucket(now);
  const host = fake({ state, settings: { 'token-board.share': true }, usage: [tagged(at, AUTHOR), tagged(at, ''), tagged(at, OTHER, { asked: 'secret-model', input: 50_000 })] });
  activate(host.coda);
  await openAndSync(host);
  const [day, today] = host.published;
  assert.deepEqual(day.body, buildArchiveBodies([tagged(at, AUTHOR), tagged(at, '')])[monthOf(at)]);
  assert.deepEqual(today.body, buildTodayBody([tagged(at, AUTHOR), tagged(at, '')], { now }));
  const text = JSON.stringify(host.published);
  assert.ok(!text.includes('secret-model') && !text.includes('11111111') && !text.includes('coda://'));
  assert.ok(text.includes('"i":"openai-responses"') && text.includes('"a":"gpt-5"'));
  assert.equal(day.body.days[new Date(at).toISOString().slice(0, 10)].claude[0].n[0], 2000);
});

// ——— 同型号映射：本机 Magpie 插件（magpie/models@1，可选）的 names，只套本机行 ———

const NAMES = { 'group/ds-flash': 'deepseek-v4.1-flash', 'opencode-go/deepseek-v4.1-flash': 'deepseek-v4.1-flash' };
const viaMagpie = (at, asked, over = {}) => tagged(at, AUTHOR, { asked, input: 100, ...over });
const modelsOf = list => list.models.map(m => [m.model, m.totalTokens, m.items.map(item => item.asked)]);

test('同型号映射：命中的本机行并入目标型号行，展开得到原请求项；有 served 的行不套；映射只读一次', async t => {
  freeze(t);
  const at = startOfBucket(now);
  const host = fake({ state: mkdir(t), usage: [viaMagpie(at, 'group/ds-flash'), viaMagpie(at, 'opencode-go/deepseek-v4.1-flash', { input: 30 }), viaMagpie(at, 'group/ds-flash', { served: 'real', input: 7 }),
    viaMagpie(at, 'unlisted/model', { input: 1 })] });
  host.sameNames = NAMES;
  activate(host.coda);
  await host.boot();
  assert.deepEqual(modelsOf(host.summary(...win()).mine), [['deepseek-v4.1-flash', 130, ['group/ds-flash', 'opencode-go/deepseek-v4.1-flash']], ['real', 7, ['group/ds-flash']], ['unlisted/model', 1, ['unlisted/model']]]);
  assert.equal(host.sameReads, 1, '一次取数读一次，不是每行一次');
});

test('同型号映射：服务不是本机 Magpie 插件提供的（别台的 Magpie、别的插件），asked 命中也不套，也不进发布的记录', async t => {
  freeze(t);
  const at = startOfBucket(now), foreign = 'coda://openai-responses/99999999-8888-7777-6666-555555555555';
  const host = fake({ state: mkdir(t), settings: { 'token-board.share': true }, usage: [viaMagpie(at, 'group/ds-flash'), viaMagpie(at, 'group/ds-flash', { service: foreign, input: 30 })] });
  host.sameNames = NAMES;
  activate(host.coda);
  await openAndSync(host);
  assert.deepEqual(modelsOf(host.summary(...win()).mine), [['group/ds-flash', 30, ['group/ds-flash']], ['deepseek-v4.1-flash', 100, ['group/ds-flash']]].sort((a, b) => b[1] - a[1]));
  const rows = host.published[0].body.days[new Date(at).toISOString().slice(0, 10)].claude;
  assert.deepEqual(rows.map(row => [row.n[0], row.u ?? null]).sort(), [[100, 'deepseek-v4.1-flash'], [30, null]]);
  host.sameServices = [];
  await host.sync();
  assert.deepEqual(modelsOf(host.summary(...win()).mine), [['group/ds-flash', 130, ['group/ds-flash']]], '没有本机 Magpie 的服务：一个都不套');
});

test('同型号映射：没装 Magpie 插件、映射为空、读映射失败，结果都和不映射相同；没有用得上的行时不去读', async t => {
  freeze(t);
  const at = startOfBucket(now), usage = [viaMagpie(at, 'group/ds-flash'), viaMagpie(at, 'opencode-go/deepseek-v4.1-flash', { input: 30 })];
  const read = async setup => {
    const host = fake({ state: mkdir(t), usage });
    setup(host);
    activate(host.coda);
    await host.boot();
    const mine = host.summary(...win()).mine;
    deactivate();
    return { mine, host };
  };
  const plain = (await read(() => {})).mine;
  assert.deepEqual(modelsOf(plain), [['group/ds-flash', 100, ['group/ds-flash']], ['opencode-go/deepseek-v4.1-flash', 30, ['opencode-go/deepseek-v4.1-flash']]]);
  for (const names of [{}, new Error('timeout'), { 'nothing/here': 'x' }]) {
    const { mine, host } = await read(h => { h.sameNames = names; });
    assert.deepEqual(mine, { ...plain, machines: mine.machines });
    assert.equal(host.sameReads, 1);
    assert.equal(host.state().error, null);
  }
  const host = fake({ state: mkdir(t), usage: [bucket(at), tagged(at, AUTHOR, { served: 'real' })] });
  host.sameNames = NAMES;
  activate(host.coda);
  await host.boot();
  assert.equal(host.sameReads, 0);
  assert.ok(!host.touched.has(SAME), '没有带服务又没有 served 的行，不去找 Magpie 插件');
});

test('同型号映射：发布的记录各行带归并名 u，asked 与接口种类照旧；没有归并的行不带；别台读到后直接用', async t => {
  freeze(t);
  const at = startOfBucket(now), state = mkdir(t);
  const host = fake({ state, settings: { 'token-board.share': true }, usage: [viaMagpie(at, 'group/ds-flash'), viaMagpie(at, 'opencode-go/deepseek-v4.1-flash', { input: 30 }), viaMagpie(at, 'group/ds-flash', { served: 'real', input: 7 }), viaMagpie(at, 'plain', { input: 1 })] });
  host.sameNames = NAMES;
  activate(host.coda);
  await openAndSync(host);
  const [day, today] = host.published;
  for (const rows of [day.body.days[new Date(at).toISOString().slice(0, 10)].claude, today.body.slots[Math.floor(at / 1_800_000) * 1_800_000].claude]) {
    assert.deepEqual(rows.map(row => [row.a, row.s ?? null, row.u ?? null]).sort(), [['group/ds-flash', null, 'deepseek-v4.1-flash'], ['group/ds-flash', 'real', null], ['opencode-go/deepseek-v4.1-flash', null, 'deepseek-v4.1-flash'], ['plain', null, null]]);
  }
  assert.ok(!JSON.stringify(host.published).includes('coda://'));
  assert.deepEqual(host.usageRecords().map(spec => spec.body), [day.body, today.body], '本机用量记录的记录体就是发出去的那份');
  // 另一台读到这份记录：不装 Magpie 插件也直接用 u，并入同一个型号行，展开仍是原请求项。
  deactivate();
  const reader = fake({ state: mkdir(t), records: [{ author: AUTHOR, kind: dayKind, id: day.id, version: 1, local: false, body: day.body }, { author: AUTHOR, kind: todayKind, id: today.id, version: 1, local: false, body: today.body }] });
  activate(reader.coda);
  await reader.boot();
  const theirs = reader.summary(...win()).board.entries.find(entry => entry.self);
  assert.deepEqual(modelsOf(theirs), [['deepseek-v4.1-flash', 130, ['group/ds-flash', 'opencode-go/deepseek-v4.1-flash']], ['real', 7, ['group/ds-flash']], ['plain', 1, ['plain']]]);
  assert.equal(reader.sameReads, 0);
});

test('同型号映射：好友记录里的行用好友自己的归并名，不拿本机映射去套：同一个 asked 在好友那没有 u 就保持原名', async t => {
  freeze(t);
  const at = startOfBucket(now), day = new Date(at).toISOString().slice(0, 10), month = monthOf(at);
  const line = (extra, input) => ({ a: 'group/ds-flash', i: 'openai-responses', ...extra, n: [input, 0, 0, 0, 1, 1] });
  const record = (source, rows) => ({ author: FRIEND, kind: dayKind, id: `${source}/${month}`, version: 1, local: false, body: { v: 3, days: { [day]: { codex: rows } } } });
  const host = fake({ state: mkdir(t), usage: [viaMagpie(at, 'group/ds-flash')], records: [record('friend-a', [line({ u: 'their-ds' }, 10), line({}, 5)]), record('friend-b', [line({}, 3)])] });
  host.sameNames = NAMES;
  activate(host.coda);
  await host.boot();
  const { mine, board } = host.summary(...win());
  assert.deepEqual(modelsOf(mine), [['deepseek-v4.1-flash', 100, ['group/ds-flash']]]);
  assert.deepEqual(modelsOf(board.entries.find(entry => !entry.self)), [['group/ds-flash', 8, ['group/ds-flash']], ['their-ds', 10, ['group/ds-flash']]].sort((a, b) => b[1] - a[1]));
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

test('默认开启分享：首跳 5 秒后发布，之后每 10 分钟查一次；内容没变没有新写入，跨过 30 分钟边界曲线才有新写入', async t => {
  const state = mkdir(t), { start, drain } = timed(t), at = Date.UTC(2026, 10, 20, 10, 0);
  const host = fake({ state, usage: [bucket(at)] });
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

test('定时同步让状态变了（证书过期、续签），状态记录跟着变，不用等页面来问', async t => {
  const state = mkdir(t), { drain } = timed(t);
  const host = fake({ state, settings: { 'token-board.share': true }, usage: [bucket(Date.UTC(2026, 10, 20, 10, 0))] });
  activate(host.coda);
  mock.timers.tick(5_000);
  await drain();
  assert.equal(host.state().syncState, 'synced');
  host.usage = [bucket(Date.UTC(2026, 10, 20, 10, 0), { output: 6 })];
  host.certState = 'needs_cert';
  mock.timers.tick(10 * 60_000);
  await drain();
  assert.equal(host.state().syncState, 'needs_cert');
  host.certState = 'active';
  mock.timers.tick(10 * 60_000);
  await drain();
  assert.equal(host.state().syncState, 'synced');
  assert.ok(host.state().lastSyncAt > 0);
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

test('状态记录的 syncState：已同步后网关消失、切换作者、关闭再开启分享，都如实跟着变；换了作者要重新同步一次才算 synced', async t => {
  freeze(t);
  const state = mkdir(t), other = `ed25519:${'c'.repeat(64)}`;
  const host = fake({ state, settings: { 'token-board.share': true }, usage: [bucket(startOfBucket(now))] });
  activate(host.coda);
  const seen = () => [host.state().syncState, host.state().author];
  const reread = async () => { await host.friendsChanged(); await host.debounced(); };
  await host.boot();
  assert.deepEqual(seen(), ['synced', AUTHOR]);
  host.gateway = false;
  await host.sync();
  assert.deepEqual(seen(), ['no_gateway', null]);
  host.gateway = true;
  await reread();
  assert.deepEqual(seen(), ['pending', AUTHOR], '网关回来，要重新发布一次才算同步');
  await host.sync();
  assert.deepEqual(seen(), ['synced', AUTHOR]);
  host.author = other;
  await reread();
  assert.deepEqual(seen(), ['pending', other], '切了作者：不沿用旧作者的 synced');
  await host.sync();
  assert.deepEqual(seen(), ['synced', other]);
  // 关掉再开：旧的 synced 作废，开启后这次没发布成功就不是 synced。
  await host.setShare(false);
  assert.equal(host.state().syncState, 'disabled');
  host.certState = 'needs_cert';
  await host.setShare(true);
  assert.equal(host.state().syncState, 'needs_cert');
  host.certState = 'active';
  await host.sync();
  assert.equal(host.state().syncState, 'synced');
});

test('作者 A → B → A：中间没同步过就不恢复旧的 synced', async t => {
  freeze(t);
  const state = mkdir(t), other = `ed25519:${'c'.repeat(64)}`;
  const host = fake({ state, settings: { 'token-board.share': true }, usage: [bucket(startOfBucket(now))] });
  activate(host.coda);
  const reread = async () => { await host.friendsChanged(); await host.debounced(); return host.state().syncState; };
  await host.boot();
  assert.equal(host.state().syncState, 'synced');
  host.author = other;
  assert.equal(await reread(), 'pending');
  host.author = AUTHOR;
  assert.equal(await reread(), 'pending', '回到 A 也要重新同步一次');
  await host.sync();
  assert.equal(host.state().syncState, 'synced');
});

// ——— 不直接访问 coda/accord@1 ———

test('零直接访问 coda/accord@1：整套发布、榜单、撤回流程只碰 coda/usage@1、coda/machine@1 与 friends/social@1；源码里也没有', async t => {
  freeze(t);
  const state = mkdir(t), host = fake({ state, settings: { 'token-board.share': true }, usage: [bucket(startOfBucket(now))] });
  host.machine = 'machine-1';
  activate(host.coda);
  await openAndSync(host);
  await host.friendsChanged();
  await host.debounced();
  await host.setShare(false);
  assert.deepEqual([...host.touched].sort(), ['coda/machine@1', 'coda/usage@1', SOCIAL]);
  const dir = new URL('../../../plugins/token-board/', import.meta.url);
  for (const file of ['main.mjs', 'lib/usage.mjs', 'view/app.mjs', 'package.json']) assert.ok(!readFileSync(new URL(file, dir), 'utf8').includes('coda/accord@1'), file);
  const manifest = JSON.parse(readFileSync(new URL('package.json', dir), 'utf8'));
  assert.deepEqual(manifest.uses, { 'coda/usage@1': ['read'], 'coda/machine@1': ['read'], [USAGE_PROTOCOL]: ['read', 'share'] });
  assert.deepEqual(manifest.optionalUses, { [SOCIAL]: ['read', 'publish'], [SAME]: ['read'] });
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
  for (let d = 1; d <= 20; d++) for (let m = 0; m < 50; m++) big.push(bucket(Date.UTC(2026, 10, d, 1), { model: `model-${m}-${'x'.repeat(30)}` }));
  const host = fake({ state, settings: { 'token-board.share': true }, usage: big });
  activate(host.coda);
  let first = true;
  const sync = async () => { mock.timers.tick(60_000); if (first) { first = false; await host.boot(); } else await host.sync(); return host.status(); };
  for (const retractState of ['queued', 'needs_cert']) {
    host.retractState = retractState;
    const status = await sync();
    assert.equal(status.syncState, retractState, '旧块没撤成，不报 synced');
    assert.equal(status.lastSyncAt, null);
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
  mock.timers.tick(60_000);
  await second.boot();
  assert.equal(second.status().syncState, 'queued');
  assert.equal(second.status().lastSyncAt, null, '新实例还没同步成功过');
  second.retractState = null;
  mock.timers.tick(60_000);
  await second.sync();
  assert.equal(second.status().syncState, 'synced');
  assert.ok(second.status().lastSyncAt > 0);
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
  host.author = other;
  host.signedAs = null;
  await host.friendsChanged();
  await host.debounced();
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

// ——— 关分享后撤回没完成：写进状态记录，分享关着也留着 ———

test('关分享时撤回没完成：状态记录写明原因（网关不可用、撤回出错、等续签），分享关着也留着；撤完了才清；再开分享也清', async t => {
  freeze(t);
  const state = mkdir(t), host = fake({ state, settings: { 'token-board.share': true }, usage: [bucket(startOfBucket(now))] });
  activate(host.coda);
  await host.boot();
  assert.equal(host.state().withdrawal, null);
  // 网关不可用：撤不了，索引留着。
  host.gateway = false;
  await host.setShare(false);
  assert.deepEqual([host.state().share, host.state().error], [false, null]);
  assert.deepEqual(host.state().withdrawal, { state: 'error', error: '未安装或未启用好友插件，无法撤回好友可见记录' });
  await host.sync();
  assert.equal(host.state().withdrawal.state, 'error', '定时同步再撤一次，还是撤不了，仍写着');
  // 网关回来，但撤回出错。
  host.gateway = true;
  host.retractState = 'error';
  await host.sync();
  assert.equal(host.state().withdrawal.state, 'error');
  assert.match(host.state().withdrawal.error, /撤回 .* 失败：网关拒绝了撤回/);
  // 代签证书过期：网关把撤回排了队。
  host.retractState = 'needs_cert';
  await host.sync();
  assert.deepEqual(host.state().withdrawal, { state: 'needs_cert', error: null });
  assert.equal(host.state().syncState, 'disabled');
  // 续签后下一次同步撤完，清掉。
  host.retractState = null;
  await host.sync();
  assert.equal(host.state().withdrawal, null);
  assert.deepEqual(indexOf(state), {});
  // 撤没完成时又打开分享：不再是「没撤完」。
  host.retractState = 'queued';
  await host.setShare(true);
  host.publishStates = {};
  await host.setShare(false);
  assert.deepEqual(host.state().withdrawal, { state: 'queued', error: null });
  host.retractState = null;
  await host.setShare(true);
  assert.equal(host.state().withdrawal, null);
});

test('关分享时没有发布过什么、又没有好友网关：没有要撤的，不写撤回没完成', async t => {
  freeze(t);
  const host = fake({ state: mkdir(t), settings: { 'token-board.share': true }, usage: [bucket(startOfBucket(now))] });
  host.gateway = false;
  activate(host.coda);
  await host.boot();
  await host.setShare(false);
  assert.equal(host.state().withdrawal, null);
});

// ——— 读失败不拿空集合覆盖目录里的上一份 ———

// 先跑一轮，得到目录里留着的记录（本机用量、状态、镜像），再停掉当作重启。
async function previousRun(t, { usage = [bucket(startOfBucket(now))] } = {}) {
  const state = mkdir(t), records = [{ author: FRIEND, kind: todayKind, id: 'phone', version: 4, local: false, body: buildTodayBody([bucket(startOfBucket(now))], { now }) }];
  const first = fake({ state, usage, records });
  activate(first.coda);
  await first.boot();
  const previous = first.written;
  assert.equal(first.mirrored().length, 1);
  deactivate();
  return { state, records, previous };
}
const failUsage = host => { const base = host.coda.query; host.coda.query = async (ref, ...rest) => { if (ref.kind === 'coda/usage@1' && host.usageFails) throw new Error('boom'); return base(ref, ...rest); }; };

test('重启后首次读用量失败：目录里旧的本机用量记录留着，镜像与好友照常；下一次成功后正常替换', async t => {
  freeze(t);
  const { state, records, previous } = await previousRun(t);
  const host = fake({ state, records, previous, usage: [bucket(startOfBucket(now), { input: 77 })] });
  host.usageFails = true;
  failUsage(host);
  activate(host.coda);
  await host.boot();
  assert.deepEqual(host.usageRecords(), previous.map(item => item.spec).filter(spec => spec.record === 'usage'), '没有拿空集合覆盖');
  assert.equal(host.mirrored().length, 1);
  assert.equal(host.state().syncState, 'error');
  host.usageFails = false;
  await host.sync();
  assert.notDeepEqual(host.usageRecords(), previous.map(item => item.spec).filter(spec => spec.record === 'usage'));
  assert.equal(host.summary(...win()).mine.input, 77, '成功的这次换成新的');
  assert.equal(host.state().syncState, 'synced');
});

test('重启后曲线这一分钟读用量失败：留着旧曲线，日归档也不动', async t => {
  freeze(t);
  const { state, records, previous } = await previousRun(t);
  const host = fake({ state, records, previous, usage: [bucket(startOfBucket(now), { input: 77 })] });
  host.usageFails = true;
  failUsage(host);
  activate(host.coda);
  await host.boot();
  await host.curve();
  assert.deepEqual(host.usageRecords(), previous.map(item => item.spec).filter(spec => spec.record === 'usage'));
  host.usageFails = false;
  await host.curve();
  assert.equal(slotsTotal(host.usageRecords().find(spec => spec.kind === todayKind)), 183);
});

test('重启后首次读好友失败（friends 与 records 查询都抛错）：旧镜像和好友列表留着；下一次成功后正常替换', async t => {
  freeze(t);
  const { state, records, previous } = await previousRun(t);
  const host = fake({ state, records, previous, usage: [bucket(startOfBucket(now))] });
  host.friendsError = new Error('好友读不出');
  host.recordsError = new Error('记录读不出');
  activate(host.coda);
  await host.boot();
  assert.deepEqual(host.mirrored(), previous.map(item => item.spec).filter(spec => spec.record === 'mirror'));
  assert.deepEqual(host.state().friends, [FRIEND]);
  host.friendsError = null;
  host.recordsError = null;
  records.length = 0;
  host.friends = [{ node: 'n2', author: OTHER, status: 'bound' }];
  await host.sync();
  assert.deepEqual(host.mirrored(), [], '成功读到的换成新的：好友那边已经没有记录了');
  assert.deepEqual(host.state().friends, [OTHER]);
});

test('重启后好友插件还没就绪（service_unavailable）：旧镜像和好友列表留着；只有确认没有好友网关（not_found、forbidden）才清掉', async t => {
  freeze(t);
  const { state, records, previous } = await previousRun(t);
  const host = fake({ state, records, previous, usage: [bucket(startOfBucket(now))] });
  host.listError = gone('service_unavailable');
  activate(host.coda);
  await host.boot();
  assert.deepEqual(host.mirrored(), previous.map(item => item.spec).filter(spec => spec.record === 'mirror'));
  assert.deepEqual(host.state().friends, [FRIEND]);
  assert.equal(host.state().syncState, 'no_gateway');
  await host.friendsChanged();
  await host.debounced();
  assert.equal(host.mirrored().length, 1, '好友变动重算时也一样');
  host.listError = null;
  await host.sync();
  assert.equal(host.mirrored().length, 1);
  assert.equal(host.state().syncState, 'synced');
  for (const code of ['not_found', 'forbidden']) {
    host.listError = gone(code);
    await host.sync();
    assert.deepEqual(host.mirrored(), [], code);
    assert.deepEqual(host.state().friends, [], code);
    host.listError = null;
    await host.sync();
    assert.equal(host.mirrored().length, 1, '回来后重新读到');
  }
});
