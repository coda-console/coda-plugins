// 好友签名网关的调用方（lib/rpc-caller.mjs），与真实的持有方（lib/rpc-holder.mjs）在测试宿主里互通：两边各是一个好友插件实例（真实的网关与 store），
// 由一个共享的签名目录替身转交签名记录：每台的 Accord（coda/accord@1）是替身，认 `signer: "machine"` 与 `expectAuthor`，好友表每项给 `machine`、`certified`，
// 发布了就告诉所有机器（同网关的 Accord 变化通知）；目录里谁的记录都看得到，由插件自己按作者、受众核对（测拒绝时也直接往里放别人的记录）。
// 持有方本机的 remote-exec 是替身（完成、失败、挂起、被中止）；调用方空间里的代理记录（remote-exec/machine@1）是一份几台共享的替身，按机器 ID 区分本机的。
// 时钟与定时器是假的：75 秒回执、15 秒兜底由测试拨动。
import { TEST_OWNER, createMockCoda } from '../../helpers/mock-coda.mjs';
import { pointProblem } from '@coda-console/protocol/validate';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createGateway } from '../../../plugins/friends/lib/gateway.mjs';
import { ACK_MS, LOST, RESUME_MS, UNSUPPORTED, createCaller, proxyKey } from '../../../plugins/friends/lib/rpc-caller.mjs';
import { createHolder } from '../../../plugins/friends/lib/rpc-holder.mjs';
import { answerId, answerRecord, grantRecord, requestDigest, requestId } from '../../../plugins/friends/lib/rpc-format.mjs';
import { createRpcStore } from '../../../plugins/friends/lib/rpc-store.mjs';
import { tailOf } from '@coda-console/protocol/accord';

const friendsManifest = JSON.parse(await readFile(new URL('../../../plugins/friends/package.json', import.meta.url), 'utf8'));
const remoteExec = JSON.parse(await readFile(new URL('../../../plugins/remote-exec/package.json', import.meta.url), 'utf8'))
  .contributes.protocols.find(protocol => protocol.name === 'remote-exec/machine@1');
const ACCORD = 'coda/accord@1', MACHINE = 'remote-exec/machine@1', CALL = 'friends/rpc-call', ANSWER = 'friends/rpc-answer', GRANT = 'friends/rpc-grant';
const key = c => `ed25519:${c.repeat(64)}`;
// 持有方：HM 是它的机器钥匙（持有方始终以它出现），HR 是它绑了个人身份时的根。
// 调用方：ROOT 是个人作者的根，MC、MC2 是我两台机器的机器钥匙，NEW_ROOT 是换过的根；FB 是另一位好友（机器作者）。
const HM = key('c'), HR = key('d'), ROOT = key('a'), MC = key('b'), MC2 = key('e'), NEW_ROOT = key('f'), FB = key('1'), STRANGER = key('9');
// 公钥昵称与尾号（coda#3040）：HM 的昵称是 zzy、尾号末 4 位 1948，HR 是 hh、1277。XS 是测试向量里昵称为 xs 的公钥（末 6 位 604084），
// XS_NEXT 比它大 1（604085），XS_FAR 大 10000（614084，末 4 位相同）；ZYV 的昵称是 zyv（末 4 位 4103）；NONAME 解不出昵称（末 4 位 5311）。
const XS = 'ed25519:2e4b9cc2428beb7bff6a56c14d7304e472a23e890e91ef0a6b0b0380e89f9734', XS_NEXT = `${XS.slice(0, -1)}5`, XS_FAR = `${XS.slice(0, -4)}be44`;
const ZYV = 'ed25519:66c8aec217cac5fa9829e4e314c2dfe6f3b3710cbf2c4b4df462c333565b4e27', NONAME = `ed25519:01${'f'.repeat(62)}`, HM2 = key('3');
const fullTail = tailOf;
const ACTIVE = { active: true, until: 1_900_000_000 }, EXPIRED = { active: false };
const START = Date.UTC(2026, 10, 24, 12, 0, 0), MINUTE = 60_000;
const SPEC = { name: 'box', os: 'linux', user: 'u', cwd: '/home/u' };
// 持有方好友表：我（个人作者，通道背后是 MC）、FB（机器作者）。
const HOLDER_FRIENDS = [{ node: 'n-a', author: ROOT, bound: true, machine: MC, certified: true }, { node: 'n-b', author: FB, bound: true, machine: FB, certified: false }];
// 调用方好友表：持有方那条通道（机器作者，机器钥匙就是作者）。
const channel = ({ author = HM, bound = true, conflict = false } = {}) => ({ node: 'n-h', author, bound, machine: HM, certified: author !== HM, ...(conflict ? { conflict } : {}) });

const pause = (ms = 15) => new Promise(resolve => setTimeout(resolve, ms));
const until = async (check, what = '条件') => {
  for (let i = 0; i < 600; i++) { if (await check()) return; await pause(5); }
  throw new Error(`等不到：${what}`);
};
const fail = (code, message, effects = 'none') => Object.assign(new Error(message), { code, effects });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
// 一个 promise 是否还没了结。
const pending = async promise => { let done = false; promise.then(() => { done = true; }, () => { done = true; }); await pause(); return !done; };

// 假的时钟与定时器：只有 advance 才会走。
function fakeTimers(clock) {
  const due = new Map();
  let seq = 0;
  return {
    setTimeout(fn, ms) { const id = ++seq; due.set(id, { at: clock.now + ms, fn }); return id; },
    clearTimeout(id) { due.delete(id); },
    async advance(ms) {
      const end = clock.now + ms;
      for (;;) {
        const [next] = [...due].filter(([, one]) => one.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
        if (!next) break;
        due.delete(next[0]);
        clock.now = Math.max(clock.now, next[1].at);
        next[1].fn();
        await pause();
      }
      clock.now = end;
      await pause();
    },
  };
}

// 共享的签名目录：记录按 (作者, kind, id) 存最新版本；受众为空是撤回（记录随之不见）；null 是没写受众（测拒绝用）。
function worldFake() {
  const world = { records: [], nodes: [], pageSize: 3, clock: { now: START } };
  world.timers = fakeTimers(world.clock);
  world.tell = () => { for (const node of world.nodes) if (!node.deaf) node.tell(); };
  world.upsert = (author, kind, id, body, audience) => {
    const at = world.records.findIndex(r => r.author === author && r.kind === kind && r.id === id);
    const version = (at < 0 ? 0 : world.records[at].version) + 1;
    if (at >= 0) world.records.splice(at, 1);
    if (audience === null || audience.length) world.records.push({ author, kind, id, version, body: structuredClone(body), ...(audience === null ? {} : { audience: [...audience] }) });
    world.tell();
    return version;
  };
  // 别人签的记录直接放进目录（受众可以写成任意样子）。
  world.inject = ({ author, kind, id, body, audience }) => world.upsert(author, kind, id, body, audience);
  return world;
}

// 一台机器的 Accord：certificate 为 null 是没绑个人身份（作者就是机器钥匙），绑了时机器钥匙在 certificate.key。`deaf` 时听不到目录的变化。
// `hold(match)`：下一次符合的查询挂住，直到放行；`failNext(match)`：下一次符合的查询失败（`always` 时此后每次都失败）；`holdGet()`：下一次读本机 Accord 记录挂住，直到放行。
function nodeOf(world, { author, certificate = null, machine = author, friends = [] }) {
  const node = { author, certificate, machine, friends, listeners: new Set(), calls: [], queries: [], deaf: false };
  node.machineKey = () => node.certificate === null ? node.author : node.machine;
  const entry = () => ({ kind: ACCORD, id: 'local', local: true, spec: { author: node.author },
    status: { friends: structuredClone(node.friends), certificate: node.certificate === null ? null : { ...node.certificate, key: node.machine } } });
  const mine = record => record.author === node.author || record.author === node.machineKey();
  Object.assign(node, {
    tell() { for (const listener of [...node.listeners]) Promise.resolve().then(() => listener({ type: 'MODIFIED', id: 'local', entry: structuredClone(entry()) })).catch(() => {}); },
    async get() {
      if (node.getGate && !node.getGate.waiting) { node.getGate.waiting = true; await node.getGate.promise; }
      return structuredClone(entry());
    },
    holdGet() {
      let release;
      node.getGate = { promise: new Promise(resolve => { release = resolve; }), waiting: false };
      return () => { node.getGate = null; release(); };
    },
    getHeld: () => node.getGate?.waiting === true,
    hold(match) {
      let release;
      node.gate = { match, promise: new Promise(resolve => { release = resolve; }), waiting: false };
      return () => { node.gate = null; release(); };
    },
    held: () => node.gate?.waiting === true,
    failNext(match, { always = false } = {}) { node.failing = match; node.failingAlways = always; },
    async change(next) { Object.assign(node, next); node.tell(); await pause(30); },
    query: async (ref, operation, input) => {
      assert.deepEqual([ref.kind, operation], [ACCORD, 'records']);
      node.queries.push(structuredClone(input));
      if (node.failing?.(input)) { if (!node.failingAlways) node.failing = null; throw fail('internal', '目录读不出'); }
      if (node.gate?.match(input) && !node.gate.waiting) { node.gate.waiting = true; await node.gate.promise; }
      const rows = world.records.filter(r => r.kind === input.kind && (input.author === undefined || r.author === input.author) && (input.id === undefined || r.id === input.id))
        .map(({ audience, ...rest }) => ({ ...rest, local: mine(rest), ...(input.includeAudience && audience !== undefined ? { audience } : {}) }));
      const size = Math.min(world.pageSize, input.limit ?? Infinity), from = Number(input.cursor ?? 0), more = from + size < rows.length;
      return { records: structuredClone(rows.slice(from, from + size)), truncated: more, ...(more ? { nextCursor: String(from + size) } : {}) };
    },
    call: async (ref, operation, input) => {
      assert.deepEqual([ref.kind, ref.id, operation], [ACCORD, 'local', 'publish']);
      const byMachine = input.signer === 'machine', signer = byMachine ? node.machineKey() : node.author;
      if (byMachine && !input.kind.startsWith('friends/')) throw fail('forbidden', '只能签自己命名空间的种类');
      if (input.expectAuthor !== signer) throw fail('forbidden', '预期作者与此刻署名的作者不符');
      if (!byMachine && node.certificate !== null && node.certificate?.active !== true) throw fail('invalid_state', '代签证书已过期');
      node.calls.push(structuredClone(input));
      const version = world.upsert(signer, input.kind, input.id, input.body, input.audience);
      return { author: signer, kind: input.kind, id: input.id, version, audience: input.audience };
    },
    watch: async (kind, listener) => {
      node.listeners.add(listener);
      await listener({ type: 'ADDED', id: 'local', entry: structuredClone(entry()) });
      return { dispose: () => node.listeners.delete(listener) };
    },
  });
  world.nodes.push(node);
  return node;
}

// 持有方本机的 remote-exec：每个幂等键执行一次；`plan(input)` 给结果就完成、给 Error 就失败、给 'hang' 就挂着；中止时以 interrupted、unknown 失败。
function execFake() {
  const ok = command => ({ exitCode: 0, signal: null, stdout: `ran ${command}`, stderr: '', timedOut: false, truncated: false, outputDir: null, ms: 7 });
  const fake = { jobs: new Map(), runs: 0, plan: input => ok(input.command) };
  fake.call = async (ref, operation, input, options = {}) => {
    assert.equal(operation, 'exec');
    let job = fake.jobs.get(options.id);
    if (!job) {
      fake.runs++;
      job = { input };
      job.done = new Promise((resolve, reject) => {
        job.resolve = value => { job.settled = true; resolve(value); };
        job.reject = error => { job.settled = true; reject(error); };
      });
      fake.jobs.set(options.id, job);
      const planned = fake.plan(input);
      if (planned instanceof Error) job.reject(planned); else if (planned !== 'hang') job.resolve(planned);
    }
    const abort = () => job.reject(fail('interrupted', '命令被中止', 'unknown'));
    if (options.signal?.aborted) abort(); else options.signal?.addEventListener('abort', abort, { once: true });
    return job.done;
  };
  fake.pending = () => [...fake.jobs.values()].filter(job => !job.settled).length;
  fake.releaseAll = () => { for (const job of fake.jobs.values()) if (!job.settled) job.resolve(ok(job.input.command)); };
  return fake;
}

// 持有方本机的目标记录 rx-1（remote-exec 提供）。
function targetsFake() {
  const row = { kind: MACHINE, id: 'rx-1', owner: TEST_OWNER, location: 'local', plugin: 'remote-exec', local: true, spec: { ...SPEC }, status: { available: true }, version: '1' };
  const listeners = new Set();
  return {
    get: async id => { if (id !== row.id) throw fail('not_found', `没有记录 ${id}`); return structuredClone(row); },
    watch: async listener => { listeners.add(listener); listener({ type: 'ADDED', id: row.id, entry: structuredClone(row) }); return { dispose: () => listeners.delete(listener) }; },
    // 改目标记录的 spec 并通知监听方（持有方机器改名）。
    rename(name) { row.spec = { ...row.spec, name }; for (const listener of listeners) listener({ type: 'MODIFIED', id: row.id, entry: structuredClone(row) }); },
  };
}

// 调用方空间里的代理记录：几台机器共享一份，按机器 ID（owner）区分本机的；spec、status 按 remote-exec 的协议校验。
function proxiesFake() {
  const fake = { rows: [] };
  const matches = (row, labels) => !labels || Object.entries(labels).every(([name, value]) => row.labels?.[name] === value);
  fake.of = owner => ({
    async put({ key: recordKey }, value) {
      for (const where of ['spec', 'status']) { const problem = pointProblem(remoteExec[where], value[where], where); if (problem) throw fail('invalid_input', problem); }
      const row = { owner, id: `${owner}/${recordKey}`, key: recordKey, plugin: 'friends', spec: structuredClone(value.spec), status: structuredClone(value.status), labels: structuredClone(value.labels) };
      const at = fake.rows.findIndex(r => r.owner === owner && r.key === recordKey);
      if (at < 0) fake.rows.push(row); else fake.rows[at] = row;
      return { ...structuredClone(row), local: true };
    },
    async delete({ key: recordKey }) { fake.rows = fake.rows.filter(r => !(r.owner === owner && r.key === recordKey)); },
    async list(kind, { scope = 'available', labels } = {}) {
      return fake.rows.filter(r => (scope === 'available' || r.owner === owner) && matches(r, labels))
        .map(({ key: recordKey, ...rest }) => structuredClone({ ...rest, ...(rest.owner === owner ? { key: recordKey } : {}), local: rest.owner === owner }));
    },
  });
  return fake;
}

// 一个插件实例的公共部分：测试宿主、状态目录、真实的网关与 store；`route` 改写 coda 的几项。
async function instance(t, world, node, { dir: shared, route = () => ({}) } = {}) {
  const dir = shared ?? await mkdtemp(join(tmpdir(), 'friends-caller-'));
  if (!shared) t.after(async () => { await pause(20); await rm(dir, { recursive: true, force: true, maxRetries: 10 }); });
  const host = createMockCoda({ plugin: { id: 'friends', state: dir, protocols: friendsManifest.contributes.protocols }, protocols: [remoteExec] });
  const coda = { ...host.coda, get: ref => ref.kind === ACCORD ? node.get() : host.coda.get(ref), query: node.query,
    watch: (kind, listener, selector) => kind === ACCORD ? node.watch(kind, listener) : host.coda.watch(kind, listener, selector) };
  Object.assign(coda, route({ ...coda }));
  const gateway = createGateway(coda, dir);
  await gateway.start();
  const store = createRpcStore(dir, { now: () => world.clock.now });
  return { dir, host, coda, gateway, store };
}

// 持有方（真实的 rpc-holder）：节拍由目录变化推动，`deaf` 时只在测试手动 tick 时动。
async function holderOf(t, world, { author = HM, certificate = null, machine = HM, friends = HOLDER_FRIENDS, wrapStore = store => store } = {}) {
  const node = nodeOf(world, { author, certificate, machine, friends }), exec = execFake(), targets = targetsFake();
  const base = await instance(t, world, node, { route: coda => ({
    get: ref => ref.kind === MACHINE ? targets.get(ref.id) : coda.get(ref),
    call: (ref, operation, input, options) => ref.kind === ACCORD ? node.call(ref, operation, input) : exec.call(ref, operation, input, options),
    watch: (kind, listener, selector) => kind === MACHINE ? targets.watch(listener) : coda.watch(kind, listener, selector),
  }) });
  const { coda, gateway, store } = base;
  const holder = createHolder(coda, { store: wrapStore(store), signRpc: gateway.signRpc, retractRpc: gateway.retractRpc, onAccord: gateway.onAccord, pages: gateway.pages,
    now: () => world.clock.now, timers: { setTimeout: () => null, clearTimeout() {} } });
  await holder.start();
  t.after(() => { holder.stop(); gateway.stop(); base.host.close(); });
  return { ...base, node, exec, targets, holder,
    grant: async friend => (await holder.self['grants.grant']({ friend, target: { kind: MACHINE, id: 'rx-1' } })).grant,
    answers: (caller, request) => node.calls.filter(call => call.kind === ANSWER && call.id === answerId(caller, request)).map(call => call.body.state ?? 'retracted'),
    lastAnswer: (caller, request) => node.calls.filter(call => call.kind === ANSWER && call.id === answerId(caller, request)).at(-1)?.body };
}

// 调用方（被测的 rpc-caller）。`node`、`dir` 给了就是同一台机器重启后的新一代。exec 的 run、resume 与 pull、push 的处理函数截下来由测试直接调。
let counter = 0;
async function callerOf(t, world, { author = ROOT, certificate = ACTIVE, machine = MC, friends = [channel()], owner = 'm-1', proxies = proxiesFake(), node: sharedNode, dir,
  wrapStore = store => store } = {}) {
  const node = sharedNode ?? nodeOf(world, { author, certificate, machine, friends });
  const records = proxies.of(owner), handlers = new Map(), streams = new Map();
  const base = await instance(t, world, node, { dir, route: coda => ({
    call: (ref, operation, input) => node.call(ref, operation, input),
    handle: (kind, operation, fn) => kind === MACHINE ? (handlers.set(operation, fn), { dispose: () => handlers.delete(operation) }) : coda.handle(kind, operation, fn),
    stream: async (kind, name, fn) => kind === MACHINE ? (streams.set(name, fn), { dispose: () => streams.delete(name) }) : coda.stream(kind, name, fn),
    put: (ref, value) => ref.kind === MACHINE ? records.put(ref, value) : coda.put(ref, value),
    delete: ref => ref.kind === MACHINE ? records.delete(ref) : coda.delete(ref),
    list: (kind, filter) => kind === MACHINE ? records.list(kind, filter) : coda.list(kind, filter),
  }) });
  const { coda, gateway, store } = base;
  const caller = createCaller(coda, { store: wrapStore(store), signRpc: gateway.signRpc, retractRpc: gateway.retractRpc, onAccord: gateway.onAccord, pages: gateway.pages,
    now: () => world.clock.now, timers: world.timers });
  const c = { ...base, node, proxies, owner, caller, handlers, streams, stopped: false };
  c.stop = () => { if (c.stopped) return; c.stopped = true; caller.stop(); gateway.stop(); base.host.close(); };
  t.after(c.stop);
  await caller.start();
  const ctxOf = (id, recordKey, signal, deadline) => ({ id, record: { kind: MACHINE, id: 'proxy', key: recordKey }, signal, deadline, caller: { machine: TEST_OWNER, parent: { kind: 'thread', id: 't-1' } } });
  return Object.assign(c, {
    mine: () => proxies.rows.filter(row => row.owner === owner),
    // 调一次代理记录的 exec：给回 { promise, controller, request }。
    exec({ grant, holder = HM, id = `call-${++counter}`, input = { command: `echo ${counter}` }, deadline = world.clock.now + 5 * MINUTE } = {}) {
      const controller = new AbortController();
      const promise = handlers.get('exec').run(input, ctxOf(id, proxyKey(holder, grant), controller.signal, deadline));
      promise.catch(() => {});
      return { promise, controller, request: requestId(id), id };
    },
    resume: ({ grant, holder = HM, id, canceled = false }) =>
      handlers.get('exec').resume({ id, record: { kind: MACHINE, id: 'proxy', key: proxyKey(holder, grant) }, op: 'exec', input: {}, progress: null, canceled },
        ctxOf(id, proxyKey(holder, grant), new AbortController().signal, null)),
    requests: () => node.calls.filter(call => call.kind === CALL && Object.keys(call.body).length && call.body.cancel !== true),
    cancels: request => node.calls.filter(call => call.kind === CALL && call.id === request && call.body.cancel === true),
    retracted: request => node.calls.some(call => call.kind === CALL && call.id === request && !Object.keys(call.body).length),
    answerReads: () => node.queries.filter(query => query.kind === ANSWER).length,
  });
}

// 持有方授权给 `to`，等调用方登记出代理记录。
async function granted(h, c, to = ROOT) {
  const grant = await h.grant(to);
  await until(() => c.mine().some(row => row.key === proxyKey(HM, grant) && row.status.available), '代理记录登记');
  return grant;
}
const rejectsWith = (promise, code, effects, text) => assert.rejects(promise, error => {
  assert.deepEqual([error.code, error.effects], [code, effects], error.message);
  if (text) for (const part of [].concat(text)) assert.ok(error.message.includes(part), `${error.message} 应含 ${part}`);
  return true;
});

// ---- 授予与发现 ----

test('a grant becomes a proxy record named machine@nickname#tail with the holder machine key, grant and full tail labels; revoking deletes it', async t => {
  const world = worldFake(), h = await holderOf(t, world), c = await callerOf(t, world);
  const grant = await granted(h, c);
  const [row] = c.mine();
  assert.equal(row.key, `friend:${'c'.repeat(16)}:${grant}`);
  assert.deepEqual(row.spec, { ...SPEC, name: 'box@zzy#1948' });
  assert.deepEqual(row.status, { available: true });
  assert.deepEqual(row.labels, { 'friends-holder': HM, 'friends-grant': grant, tail: fullTail(HM) });
  assert.match(row.labels.tail, /^\d{78}$/);
  assert.ok(row.labels.tail.endsWith('1948'));

  await h.holder.self['grants.revoke']({ grant });
  await until(() => c.mine().length === 0, '撤回后删掉代理记录');
});

test('a holder machine renamed after the grant: the grant record is published again under the same id and the caller\'s proxy name follows', async t => {
  const world = worldFake(), h = await holderOf(t, world), c = await callerOf(t, world);
  const grant = await granted(h, c);
  assert.equal(c.mine()[0].spec.name, 'box@zzy#1948');
  h.targets.rename('renamed');
  await until(() => c.mine()[0].spec.name === 'renamed@zzy#1948', '代理名跟着改名');
  assert.deepEqual(c.mine().map(row => row.key), [proxyKey(HM, grant)], 'same grant, same proxy');
});

test('a second rename while the first rename\'s grant record is still being published is not lost: the caller ends up with the second name', async t => {
  const world = worldFake(), h = await holderOf(t, world), c = await callerOf(t, world);
  await granted(h, c);
  const release = h.node.hold(input => input.kind === 'friends/rpc-grant');
  h.targets.rename('first');
  await until(() => h.node.held(), '第一次改名的发布还在路上');
  h.targets.rename('second');
  release();
  await until(() => c.mine()[0].spec.name === 'second@zzy#1948', '代理名是第二个名字');
});

// 两位好友各授出一台叫 box 的机器：通道背后的作者是 first、second，持有方机器钥匙是 HM、HM2。
for (const [what, first, second, names] of [
  ['another friend granting a machine of the same name gets a record named after its own key', XS, ZYV, ['box@xs#4084', 'box@zyv#4103']],
  ['two keys with the same nickname keep their own last 4 digits', XS, XS_NEXT, ['box@xs#4084', 'box@xs#4085']],
  ['two keys with the same nickname and the same last 4 digits are both written to the shortest distinguishing length', XS, XS_FAR, ['box@xs#04084', 'box@xs#14084']],
]) {
  test(`naming: ${what}`, async t => {
    const world = worldFake(), h = await holderOf(t, world), h2 = await holderOf(t, world, { author: HM2, machine: HM2 });
    const c = await callerOf(t, world, { friends: [channel({ author: first }), { node: 'n-h2', author: second, bound: true, machine: HM2, certified: true }] });
    const grant = await granted(h, c), grant2 = await h2.grant(ROOT);
    await until(() => c.mine().length === 2, '第二条代理记录登记');
    await c.caller.tick();
    const rows = [proxyKey(HM, grant), proxyKey(HM2, grant2)].map(recordKey => c.mine().find(row => row.key === recordKey));
    assert.deepEqual(rows.map(row => row.spec.name), names);
    assert.deepEqual(rows.map(row => row.labels.tail), [fullTail(first), fullTail(second)]);
    for (const row of rows) assert.ok(row.labels.tail.endsWith(row.spec.name.split('#')[1]));
    // 另一条撤回了，留下的这条回到 4 位。
    await h2.holder.self['grants.revoke']({ grant: grant2 });
    await until(() => c.mine().length === 1, '撤回后删掉');
    await c.caller.tick();
    assert.equal(c.mine()[0].spec.name, `${names[0].split('#')[0]}#${fullTail(first).slice(-4)}`);
  });
}

test('naming: a key without a nickname uses its first 8 hex digits; a friend whose certificate expired (unbound, the stored author kept) keeps the title', async t => {
  const world = worldFake(), h = await holderOf(t, world), c = await callerOf(t, world, { friends: [channel({ author: NONAME })] });
  await granted(h, c);
  assert.equal(c.mine()[0].spec.name, 'box@01ffffff#5311');
  await c.node.change({ friends: [channel({ author: HR })] });
  await c.caller.tick();
  const [row] = c.mine();
  assert.equal(row.spec.name, 'box@hh#1277');
  await c.node.change({ friends: [channel({ author: HR, bound: false })] });
  await c.caller.tick();
  assert.deepEqual(c.mine().map(one => [one.id, one.spec.name, one.labels.tail]), [[row.id, 'box@hh#1277', fullTail(HR)]]);
});

test('naming: a machine name with control characters, line breaks, bidi controls or edge whitespace registers no proxy; @, #, CJK and inner spaces do', async t => {
  const world = worldFake(), c = await callerOf(t, world);
  const inject = name => {
    const one = grantRecord({ holder: HM, grantee: ROOT, grant: randomUUID(), spec: SPEC, available: true, grantedAt: START });
    world.inject({ author: HM, kind: GRANT, id: one.id, body: { ...one.body, spec: { ...SPEC, name } }, audience: one.audience });
    return one.body.grant;
  };
  for (const name of ['a\nb', 'a\r\nb', 'a\u0007b', 'a\u007fb', 'a\u0085b', 'a b', 'a‮b', 'a‏b', 'a⁧b', ' box', 'box ', '\tbox', 'box\n']) inject(name);
  await c.caller.tick();
  assert.deepEqual(c.mine(), []);
  const fine = ['a@b', 'a#b', '机器 一号', 'my box', 'Ünï'].map(name => [inject(name), name]);
  await until(() => c.mine().length === fine.length, '合格的名字登记');
  for (const [grant, name] of fine) assert.ok(c.mine().some(row => row.key === proxyKey(HM, grant) && row.spec.name === `${name}@zzy#1948`), name);
});

test('naming: the tail length counts only the records this machine keeps after dedup, and list shows the title of the record that is registered', async t => {
  const world = worldFake(), h = await holderOf(t, world), h2 = await holderOf(t, world, { author: HM2, machine: HM2 });
  const second = { node: 'n-h2', author: XS_FAR, bound: true, machine: HM2, certified: true };
  const c = await callerOf(t, world, { friends: [channel({ author: XS }), second] });
  const grant = await granted(h, c), grant2 = await h2.grant(ROOT);
  await until(() => c.mine().length === 2, '第二条代理记录登记');
  await c.caller.tick();
  assert.deepEqual(c.mine().map(row => row.spec.name).sort(), ['box@xs#04084', 'box@xs#14084']);
  // 我的另一台机器（ID 更小）也有与第二位好友的通道：这一授权归它登记，本机留下的那条回到 4 位。
  const other = await callerOf(t, world, { owner: 'm-0', machine: MC2, friends: [second], proxies: c.proxies });
  await until(() => other.mine().length === 1, '另一台登记');
  await c.caller.tick();
  assert.deepEqual(c.mine().map(row => [row.key, row.spec.name]), [[proxyKey(HM, grant), 'box@xs#4084']]);
  assert.deepEqual(other.mine().map(row => [row.key, row.spec.name]), [[proxyKey(HM2, grant2), 'box@xs#4084']]);
  assert.deepEqual((await c.caller.list({ friend: XS })).map(proxy => proxy.name), ['box@xs#4084']);
  assert.deepEqual((await c.caller.list({ friend: XS_FAR })).map(proxy => proxy.name), ['box@xs#4084'], '取另一台登记的那条的名字');
});

test('list gives the proxies a friend granted to me, read only: filtered by the friend\'s bound channel, with the status I would meet now', async t => {
  const world = worldFake(), h = await holderOf(t, world), c = await callerOf(t, world, { friends: [channel(), { node: 'n-b', author: FB, bound: true, machine: FB, certified: false }] });
  assert.deepEqual(await c.caller.list(), []);
  const grant = await granted(h, c);
  const proxy = { key: proxyKey(HM, grant), grant, holder: HM, name: 'box@zzy#1948', os: 'linux', user: 'u', status: 'available' };
  assert.deepEqual(await c.caller.list(), [proxy]);
  assert.deepEqual(await c.caller.list({ friend: HM }), [proxy]);
  assert.deepEqual(await c.caller.list({ friend: FB }), [], 'another friend\'s channel has a different machine key');
  await assert.rejects(c.caller.list({ friend: 'someone' }), error => error.code === 'invalid_input');
  // 本机没有可用的签名证书时，好友授的东西这一刻用不了。
  await c.node.change({ certificate: EXPIRED });
  assert.equal((await c.caller.list({ friend: HM }))[0].status, 'sign');
  assert.equal(c.mine().length, 1, 'listing writes nothing');
});

test('the same grant seen by two of my bound machines keeps one proxy record on the smaller machine id; a machine whose channel breaks drops out', async t => {
  const world = worldFake(), proxies = proxiesFake(), h = await holderOf(t, world);
  const big = await callerOf(t, world, { owner: 'm-2', proxies });
  const small = await callerOf(t, world, { owner: 'm-1', machine: MC2, proxies });
  const grant = await h.grant(ROOT);
  await until(() => proxies.rows.some(row => row.owner === 'm-1' && row.status.available), '小的那台登记');
  // 先登记的大的那台，下一拍（兜底查询）看到小的那台就删掉自己这条。
  await big.caller.tick();
  await small.caller.tick();
  assert.deepEqual(proxies.rows.map(row => [row.owner, row.status.available]), [['m-1', true]]);
  // 小的那台与持有方的通道断了（冲突）：它不再是候选，删掉自己这条，大的那台接过去。
  await small.node.change({ friends: [channel({ conflict: true })] });
  await small.caller.tick();
  await big.caller.tick();
  await small.caller.tick();
  assert.deepEqual(proxies.rows.map(row => [row.owner, row.key, row.status.available]), [['m-2', proxyKey(HM, grant), true]]);
});

// ---- 执行 ----

test('exec sends the request to the holder machine key, signed as my author, and hands back the result; the request is then retracted', async t => {
  const world = worldFake(), h = await holderOf(t, world), c = await callerOf(t, world);
  const grant = await granted(h, c);
  const call = c.exec({ grant, input: { command: 'uname -a', cwd: '/tmp', extra: 'dropped' } });
  assert.deepEqual(await call.promise, { exitCode: 0, signal: null, stdout: 'ran uname -a', stderr: '', timedOut: false, truncated: false, outputDir: null, ms: 7 });
  const [sent] = c.requests();
  assert.deepEqual([sent.id, sent.audience, sent.expectAuthor, 'signer' in sent], [call.request, [HM], ROOT, false]);
  assert.deepEqual(sent.body, { v: 1, caller: ROOT, holder: HM, grant, request: call.request, op: 'exec', input: { command: 'uname -a', cwd: '/tmp' }, createdAt: START, expiresAt: START + 5 * MINUTE });
  assert.deepEqual(h.answers(ROOT, call.request), ['running', 'completed']);
  await until(async () => c.retracted(call.request) && !(await c.store.getOutgoing(call.request)), '拿到结局后撤回请求');
});

test('a failed answer is thrown with its code, message and effects', async t => {
  const world = worldFake(), h = await holderOf(t, world), c = await callerOf(t, world);
  const grant = await granted(h, c);
  h.exec.plan = () => fail('disk_full', '磁盘满了', 'some');
  await rejectsWith(c.exec({ grant }).promise, 'disk_full', 'some', '磁盘满了');
});

// 不拨定时器、只等真实的几毫秒：等的是持有方自己答的终态。
const settles = promise => { let done = false; promise.then(() => { done = true; }, () => { done = true; }); return until(() => done, '调用结束'); };

test('a failed answer whose message is too long to fit is cut on the holder and still thrown with its code and effects', async t => {
  const world = worldFake(), h = await holderOf(t, world), c = await callerOf(t, world);
  const grant = await granted(h, c);
  h.exec.plan = () => fail('ENAMETOOLONG', `ENAMETOOLONG: ${'/d'.repeat(40_000)}`, 'none');
  const call = c.exec({ grant });
  await settles(call.promise);
  await rejectsWith(call.promise, 'ENAMETOOLONG', 'none', '省略了');
  assert.equal(h.lastAnswer(ROOT, call.request).cut, true);
});

test('a request the holder refuses before admitting it (revoked, the proxy not yet gone here) ends at once with the holder\'s reason and no effects, not after 75 seconds as offline', async t => {
  const world = worldFake(), h = await holderOf(t, world), c = await callerOf(t, world);
  const grant = await granted(h, c);
  await h.holder.self['grants.revoke']({ grant });
  // 调用方这边的代理记录还没跟上撤销：请求照常发出，持有方准入前拒绝，签回失败终态。
  const call = c.exec({ grant });
  await settles(call.promise);
  await rejectsWith(call.promise, 'revoked', 'none', '授权已撤销，命令没有启动');
  assert.deepEqual(h.answers(ROOT, call.request), ['failed']);
  assert.equal(h.exec.runs, 0);
});

test('a running receipt keeps the call waiting past 75 seconds until the final answer; the outgoing table records the call meanwhile', async t => {
  const world = worldFake(), h = await holderOf(t, world), c = await callerOf(t, world);
  const grant = await granted(h, c);
  h.exec.plan = () => 'hang';
  const call = c.exec({ grant, id: 'call-long', input: { command: 'sleep 1' }, deadline: START + 30 * MINUTE });
  await until(() => h.exec.pending() === 1 && h.answers(ROOT, call.request).includes('running'), '回执 running');
  const body = c.requests()[0].body;
  assert.deepEqual(await c.store.getOutgoing(call.request), { request: call.request, call: 'call-long', key: proxyKey(HM, grant), machine: TEST_OWNER, parent: 'thread:t-1',
    expiresAt: START + 11 * MINUTE, author: ROOT, holder: HM, grant, digest: requestDigest(body), body, state: 'sent' });
  await world.timers.advance(ACK_MS + 5_000);
  assert.ok(await pending(call.promise));
  assert.deepEqual(c.cancels(call.request), []);
  h.exec.releaseAll();
  assert.equal((await call.promise).stdout, 'ran sleep 1');
});

test('two callers using the same request number each get their own answer', async t => {
  const world = worldFake(), h = await holderOf(t, world);
  const a = await callerOf(t, world), b = await callerOf(t, world, { author: FB, certificate: null, machine: FB });
  const [ga, gb] = [await granted(h, a, ROOT), await granted(h, b, FB)];
  const one = a.exec({ grant: ga, id: 'same', input: { command: 'echo a' } }), two = b.exec({ grant: gb, id: 'same', input: { command: 'echo b' } });
  assert.equal(one.request, two.request);
  assert.deepEqual([(await one.promise).stdout, (await two.promise).stdout], ['ran echo a', 'ran echo b']);
  assert.notEqual(answerId(ROOT, one.request), answerId(FB, two.request));
  assert.deepEqual([h.answers(ROOT, one.request), h.answers(FB, two.request)], [['running', 'completed'], ['running', 'completed']]);
});

// ---- 取消 ----

test('a cancel that reaches the holder before the request: the holder only sees the cancel and answers canceled without running', async t => {
  const world = worldFake(), h = await holderOf(t, world), c = await callerOf(t, world);
  const grant = await granted(h, c);
  h.node.deaf = true;
  await h.holder.tick();
  const call = c.exec({ grant });
  await until(() => c.requests().length === 1, '请求发出');
  call.controller.abort();
  await assert.rejects(call.promise, error => error.name === 'AbortError');
  const [cancel] = c.cancels(call.request);
  assert.deepEqual([cancel.audience, cancel.body.cancel, cancel.body.request, cancel.body.grant], [[HM], true, call.request, grant]);
  h.node.deaf = false;
  await h.holder.tick();
  await until(() => h.lastAnswer(ROOT, call.request)?.state === 'canceled', '持有方答 canceled');
  assert.equal(h.exec.runs, 0);
});

test('a cancel that arrives after admission but before the command starts: nothing runs and the holder answers canceled', async t => {
  const world = worldFake(), gate = deferred();
  const h = await holderOf(t, world, { wrapStore: store => ({ ...store, markSubmitted: async (...args) => { await gate.promise; return store.markSubmitted(...args); } }) });
  const c = await callerOf(t, world);
  const grant = await granted(h, c);
  const call = c.exec({ grant });
  await until(() => h.answers(ROOT, call.request).includes('running'), '准入并回执');
  call.controller.abort();
  await assert.rejects(call.promise, error => error.name === 'AbortError');
  await until(async () => (await h.store.get(ROOT, call.request))?.canceled, '持有方记下取消');
  gate.resolve();
  await until(() => h.lastAnswer(ROOT, call.request)?.state === 'canceled', '持有方答 canceled');
  assert.equal(h.exec.runs, 0);
});

test('a cancel after the command started aborts it on the holder machine', async t => {
  const world = worldFake(), h = await holderOf(t, world), c = await callerOf(t, world);
  const grant = await granted(h, c);
  h.exec.plan = () => 'hang';
  const call = c.exec({ grant });
  await until(() => h.exec.pending() === 1, '命令开始');
  call.controller.abort();
  await assert.rejects(call.promise, error => error.name === 'AbortError');
  await until(() => h.lastAnswer(ROOT, call.request)?.state === 'failed', '持有方中止后答失败');
  assert.deepEqual([h.lastAnswer(ROOT, call.request).error.code, h.exec.pending()], ['interrupted', 0]);
  assert.equal((await c.store.getOutgoing(call.request)).state, 'canceled');
  // 拿不到结局的请求，过了 expiresAt 才撤回。
  assert.equal(c.retracted(call.request), false);
  await world.timers.advance(6 * MINUTE);
  await until(() => c.retracted(call.request), '过期后撤回请求');
});

// ---- 没有回执、到期、重启 ----

test('no running receipt within 75 seconds: a cancel is sent and the call fails peer_offline with unknown effects', async t => {
  const world = worldFake(), h = await holderOf(t, world), c = await callerOf(t, world);
  const grant = await granted(h, c);
  h.node.deaf = true;
  await h.holder.tick();
  const call = c.exec({ grant });
  await until(() => c.requests().length === 1, '请求发出');
  await world.timers.advance(ACK_MS - 1_000);
  assert.ok(await pending(call.promise));
  await world.timers.advance(1_000);
  await rejectsWith(call.promise, 'peer_offline', 'unknown', [LOST, call.request]);
  assert.equal(c.cancels(call.request).length, 1);
});

test('a call that runs out of time sends a cancel and ends as timeout, unknown, naming the request', async t => {
  const world = worldFake(), h = await holderOf(t, world), c = await callerOf(t, world);
  const grant = await granted(h, c);
  h.exec.plan = () => 'hang';
  const call = c.exec({ grant });
  await until(() => h.exec.pending() === 1, '命令开始');
  call.controller.abort(new DOMException('到期了', 'TimeoutError'));
  await rejectsWith(call.promise, 'timeout', 'unknown', [LOST, call.request]);
  assert.equal(c.cancels(call.request).length, 1);
});

test('resume after a restart reads the answer once: a final answer is handed back, none ends as interrupted without sending the request again', async t => {
  const world = worldFake(), h = await holderOf(t, world), first = await callerOf(t, world);
  const grant = await granted(h, first);
  h.node.deaf = true;
  await h.holder.tick();
  const done = first.exec({ grant, id: 'call-done', input: { command: 'echo done' } }), lost = first.exec({ grant, id: 'call-lost' });
  const gone = first.exec({ grant, id: 'call-gone' });
  await until(() => first.requests().length === 3, '请求发出');
  first.stop();
  // 持有方只答了第一条。
  h.node.deaf = false;
  h.exec.plan = input => input.command === 'echo done' ? { exitCode: 0, signal: null, stdout: 'ran echo done', stderr: '', timedOut: false, truncated: false, outputDir: null, ms: 1 } : 'hang';
  await h.holder.tick();
  await until(() => h.lastAnswer(ROOT, done.request)?.state === 'completed', '持有方答完');
  h.node.deaf = true;
  await h.holder.tick();
  const next = await callerOf(t, world, { node: first.node, dir: first.dir, proxies: first.proxies });
  const sentBefore = next.requests().length;
  assert.equal((await next.resume({ grant, id: 'call-done' })).stdout, 'ran echo done');
  await rejectsWith(next.resume({ grant, id: 'call-lost' }), 'interrupted', 'unknown', [LOST, lost.request]);
  // 已被要求取消的，先发取消。
  await rejectsWith(next.resume({ grant, id: 'call-gone', canceled: true }), 'interrupted', 'unknown', gone.request);
  assert.equal(next.cancels(gone.request).length, 1);
  assert.equal(next.requests().length, sentBefore, 'resume 不重发请求');
  await until(() => next.retracted(done.request), '拿到结局后撤回');
});

// ---- 受众与作者 ----

test('answers with a public, shared, missing or reversed audience, the wrong author, or a grant, request or digest that does not match are ignored', async t => {
  const world = worldFake(), h = await holderOf(t, world), c = await callerOf(t, world);
  const grant = await granted(h, c);
  h.node.deaf = true;
  await h.holder.tick();
  const call = c.exec({ grant });
  await until(() => c.requests().length === 1, '请求发出');
  const sent = c.requests()[0].body, digest = requestDigest(sent);
  const result = { exitCode: 0, signal: null, stdout: 'forged', stderr: '', timedOut: false, truncated: false, outputDir: null, ms: 1 };
  const answer = (more = {}) => answerRecord({ holder: HM, caller: ROOT, grant, request: call.request, digest, state: 'completed', acceptedAt: START, finishedAt: START, result, ...more });
  const good = answer();
  const bad = [
    { ...good, audience: ['public'] }, { ...good, audience: [ROOT, STRANGER] }, { ...good, audience: null }, { ...good, audience: [HM] },
    { ...good, author: STRANGER }, { ...good, author: ROOT },
    { ...answer({ grant: randomUUID() }) },
    { ...answer({ request: requestId('other') }), id: good.id },
    { ...answer({ digest: '0'.repeat(64) }) },
  ];
  for (const one of bad) {
    const before = c.answerReads();
    world.inject({ author: one.author ?? HM, kind: ANSWER, id: one.id, body: one.body, audience: one.audience });
    await until(() => c.answerReads() > before, '调用方读过回答');
    assert.ok(await pending(call.promise), JSON.stringify(one.audience ?? null));
  }
  world.inject({ author: HM, kind: ANSWER, id: good.id, body: good.body, audience: good.audience });
  assert.equal((await call.promise).stdout, 'forged');
});

test('grant records with a public, shared, missing or reversed audience, an author that is not the channel machine key, or another grantee register nothing', async t => {
  const world = worldFake();
  const c = await callerOf(t, world, { friends: [channel({ author: HR })] });
  const record = (more = {}) => grantRecord({ holder: HM, grantee: ROOT, grant: randomUUID(), spec: SPEC, available: true, grantedAt: START, ...more });
  const bad = [
    { ...record(), audience: ['public'] }, { ...record(), audience: [ROOT, STRANGER] }, { ...record(), audience: null }, { ...record(), audience: [HM] },
    // 作者是这位好友的根而不是通道背后的机器钥匙；或是陌生人；或作者是机器钥匙而正文写的持有方不是它。
    { ...record({ holder: HR }), author: HR }, { ...record({ holder: STRANGER }), author: STRANGER }, { ...record({ holder: STRANGER }), author: HM },
    { ...record({ grantee: FB }), audience: [ROOT] },
  ];
  for (const one of bad) world.inject({ author: one.author ?? HM, kind: GRANT, id: one.id, body: one.body, audience: one.audience });
  await c.caller.tick();
  assert.deepEqual(c.mine(), []);
  const good = record();
  world.inject({ author: HM, kind: GRANT, id: good.id, body: good.body, audience: good.audience });
  await until(() => c.mine().length === 1, '合格的授权登记');
  assert.equal(c.mine()[0].labels['friends-grant'], good.body.grant);
});

test('a holder that is a person with an expired certificate still grants and answers with its machine key; a caller whose certificate expired fails on the spot', async t => {
  const world = worldFake(), h = await holderOf(t, world, { author: HR, certificate: EXPIRED, machine: HM });
  // 持有方个人证书过期时，我这边好友表里真实的样子：未绑定、机器钥匙仍在、没有冲突。
  const c = await callerOf(t, world, { friends: [channel({ author: HR, bound: false })] });
  const grant = await granted(h, c);
  assert.equal((await c.exec({ grant, input: { command: 'id' } }).promise).stdout, 'ran id');
  await c.caller.tick();
  assert.deepEqual(c.mine().map(row => [row.key, row.status.available]), [[proxyKey(HM, grant), true]], '下一轮代理记录还在、可用');
  assert.equal((await c.exec({ grant, input: { command: 'id' } }).promise).stdout, 'ran id');
  await c.node.change({ certificate: EXPIRED });
  const sent = c.requests().length;
  await rejectsWith(c.exec({ grant }).promise, 'invalid_state', 'none');
  assert.equal(c.requests().length, sent);
  await c.caller.tick();
  assert.equal(c.mine()[0].status.available, false);
});

// ---- 作者变了 ----

for (const [what, from, to] of [
  ['binds a personal identity', { author: MC, certificate: null }, { author: ROOT, certificate: ACTIVE }],
  ['unbinds it', { author: ROOT, certificate: ACTIVE }, { author: MC, certificate: null }],
  ['changes root', { author: ROOT, certificate: ACTIVE }, { author: NEW_ROOT }],
]) {
  test(`when the caller ${what}, the proxy record is disabled and the call in flight is no longer handled`, async t => {
    const world = worldFake();
    const h = await holderOf(t, world, { friends: [{ node: 'n-a', author: from.author, bound: true, machine: MC, certified: from.certificate !== null }] });
    const c = await callerOf(t, world, { ...from, machine: MC });
    const grant = await granted(h, c, from.author);
    h.exec.plan = () => 'hang';
    const call = c.exec({ grant });
    await until(() => h.exec.pending() === 1, '命令开始');
    await c.node.change(to);
    await rejectsWith(call.promise, 'invalid_state', 'unknown', [LOST, call.request]);
    await until(() => c.mine()[0]?.status.available === false, '代理记录停用');
    await rejectsWith(c.exec({ grant }).promise, 'invalid_state', 'none');
  });
}

// ---- 审查修正 ----

// 调用方 store 的一个写盘方法：arm 之后的调用挂住，直到 release。
function holdWrites(name) {
  const gate = deferred(), state = { armed: false, waiting: 0 };
  return {
    wrap: store => ({ ...store, [name]: async (...args) => { if (state.armed) { state.waiting++; await gate.promise; } return store[name](...args); } }),
    arm() { state.armed = true; },
    waiting: () => state.waiting > 0,
    release() { state.armed = false; gate.resolve(); },
  };
}

const answerQuery = request => input => input.kind === ANSWER && input.id === answerId(ROOT, request);

test('#1 a call that expires while an answer query hangs stops at once as timeout and sends the cancel', async t => {
  const world = worldFake(), h = await holderOf(t, world), c = await callerOf(t, world);
  const grant = await granted(h, c);
  h.exec.plan = () => 'hang';
  const call = c.exec({ grant });
  await until(() => h.answers(ROOT, call.request).includes('running') && h.exec.pending() === 1, '回执 running');
  const release = c.node.hold(answerQuery(call.request));
  c.node.tell();
  await until(() => c.node.held(), '读回答挂住');
  call.controller.abort(new DOMException('到期了', 'TimeoutError'));
  await until(async () => !(await pending(call.promise)), '不等查询返回就结束');
  await rejectsWith(call.promise, 'timeout', 'unknown', [LOST, call.request, '已请好友的机器取消']);
  assert.equal(c.node.held(), true, '查询还挂着，调用已经结束');
  assert.equal(c.cancels(call.request).length, 1);
  release();
});

test('#1 when my author changes while an answer is being read, the final answer is not handed back', async t => {
  const world = worldFake(), h = await holderOf(t, world), c = await callerOf(t, world);
  const grant = await granted(h, c);
  h.exec.plan = () => 'hang';
  const call = c.exec({ grant });
  await until(() => h.answers(ROOT, call.request).includes('running') && h.exec.pending() === 1, '回执 running');
  const release = c.node.hold(answerQuery(call.request));
  c.node.tell();
  await until(() => c.node.held(), '读回答挂住');
  h.exec.releaseAll();
  await until(() => h.lastAnswer(ROOT, call.request)?.state === 'completed', '持有方签出终态');
  await c.node.change({ author: NEW_ROOT });
  release();
  await rejectsWith(call.promise, 'invalid_state', 'unknown', [LOST, call.request]);
});

test('#1 a call that expires while the outgoing table is being written does not hand back the final answer it already read', async t => {
  const world = worldFake(), h = await holderOf(t, world), writes = holdWrites('settleOutgoing');
  const c = await callerOf(t, world, { wrapStore: writes.wrap });
  const grant = await granted(h, c);
  writes.arm();
  const call = c.exec({ grant });
  await until(() => writes.waiting(), '写盘挂住');
  assert.equal(h.lastAnswer(ROOT, call.request)?.state, 'completed');
  call.controller.abort(new DOMException('到期了', 'TimeoutError'));
  writes.release();
  await rejectsWith(call.promise, 'timeout', 'unknown', call.request);
});

test('#1 a call that expires while the last read of my author hangs ends as timeout without waiting for it', async t => {
  const world = worldFake(), h = await holderOf(t, world), writes = holdWrites('settleOutgoing');
  const c = await callerOf(t, world, { wrapStore: writes.wrap });
  const grant = await granted(h, c);
  writes.arm();
  const call = c.exec({ grant });
  await until(() => writes.waiting(), '写盘挂住');
  const release = c.node.holdGet();
  writes.release();
  await until(() => c.node.getHeld(), '最后一次读作者挂住');
  call.controller.abort(new DOMException('到期了', 'TimeoutError'));
  await until(async () => !(await pending(call.promise)), '不等读作者返回就结束');
  await rejectsWith(call.promise, 'timeout', 'unknown', call.request);
  release();
});

test('#1 an author change seen after the final answer arrived but before it is handed back is not lost, even if the author is back by then', async t => {
  const world = worldFake(), h = await holderOf(t, world), writes = holdWrites('settleOutgoing');
  const c = await callerOf(t, world, { wrapStore: writes.wrap });
  const grant = await granted(h, c);
  writes.arm();
  const call = c.exec({ grant });
  await until(() => writes.waiting(), '拿到结局、写盘挂住');
  await c.node.change({ author: NEW_ROOT });
  await c.node.change({ author: ROOT });
  writes.release();
  await rejectsWith(call.promise, 'invalid_state', 'unknown', call.request);
});

// 第一代发出请求后停机，返回请求号与旧实例。
async function sentThenStopped(t, world, h) {
  const first = await callerOf(t, world);
  const grant = await granted(h, first);
  h.node.deaf = true;
  await h.holder.tick();
  const call = first.exec({ grant, input: { command: 'echo late' } });
  await until(() => first.requests().length === 1, '请求发出');
  first.stop();
  return { first, grant, call };
}
const restarted = (t, world, first, more = {}) => callerOf(t, world, { node: first.node, dir: first.dir, proxies: first.proxies, ...more });

test('#2 a final answer signed while I was down is handed back by resume even when I start after expiresAt and the request is gone from the directory', async t => {
  const world = worldFake(), h = await holderOf(t, world);
  const { first, grant, call } = await sentThenStopped(t, world, h);
  h.node.deaf = false;
  await h.holder.tick();
  await until(() => h.lastAnswer(ROOT, call.request)?.state === 'completed', '持有方答完');
  h.node.deaf = true;
  await h.holder.tick();
  world.records = world.records.filter(record => !(record.kind === CALL && record.id === call.request));
  world.clock.now = START + 12 * MINUTE;
  const next = await restarted(t, world, first);
  await next.caller.tick();
  assert.ok(await next.store.getOutgoing(call.request), '启动清扫不抢在 resume 之前删掉发出项');
  assert.equal((await next.resume({ grant, id: call.id })).stdout, 'ran echo late');
});

test('#3 resume has its own 30 seconds: a hanging query ends as interrupted exactly then, a failing one at once, neither leaking the error', async t => {
  const world = worldFake(), h = await holderOf(t, world);
  const { first, grant, call } = await sentThenStopped(t, world, h);
  const next = await restarted(t, world, first);
  const release = next.node.hold(answerQuery(call.request));
  const hung = next.resume({ grant, id: call.id });
  hung.catch(() => {});
  await until(() => next.node.held(), '读回答挂住');
  await world.timers.advance(RESUME_MS - 1);
  assert.ok(await pending(hung));
  await world.timers.advance(1);
  await until(async () => !(await pending(hung)), '30 秒一到就结束');
  await rejectsWith(hung, 'interrupted', 'unknown', [LOST, call.request]);
  release();
  next.node.failNext(answerQuery(call.request));
  await rejectsWith(next.resume({ grant, id: call.id }), 'interrupted', 'unknown', [LOST, call.request]);
});

test('#3 the 30 seconds cover the writes too: a hanging write ends resume as interrupted exactly at 30 seconds', async t => {
  const world = worldFake(), h = await holderOf(t, world);
  const { first, grant, call } = await sentThenStopped(t, world, h);
  h.node.deaf = false;
  await h.holder.tick();
  await until(() => h.lastAnswer(ROOT, call.request)?.state === 'completed', '持有方答完');
  h.node.deaf = true;
  await h.holder.tick();
  const writes = holdWrites('settleOutgoing'), next = await restarted(t, world, first, { wrapStore: writes.wrap });
  writes.arm();
  const hung = next.resume({ grant, id: call.id });
  hung.catch(() => {});
  await until(() => writes.waiting(), '写盘挂住');
  await world.timers.advance(RESUME_MS - 1);
  assert.ok(await pending(hung));
  await world.timers.advance(1);
  await until(async () => !(await pending(hung)), '30 秒一到就结束');
  await rejectsWith(hung, 'interrupted', 'unknown', [LOST, call.request]);
  writes.release();
});

test('#3 once resume has timed out, the lookup still running stops: it sends and reads nothing more', async t => {
  const world = worldFake(), h = await holderOf(t, world);
  const { first, grant, call } = await sentThenStopped(t, world, h);
  const writes = holdWrites('setOutgoingState'), next = await restarted(t, world, first, { wrapStore: writes.wrap });
  writes.arm();
  // 已被要求取消：取消发出后记状态时挂住。
  const hung = next.resume({ grant, id: call.id, canceled: true });
  hung.catch(() => {});
  await until(() => writes.waiting(), '写盘挂住');
  assert.equal(next.cancels(call.request).length, 1);
  const sent = next.node.calls.length, reads = next.answerReads();
  await world.timers.advance(RESUME_MS);
  await until(async () => !(await pending(hung)), '30 秒一到就结束');
  await rejectsWith(hung, 'interrupted', 'unknown', call.request);
  writes.release();
  await pause(50);
  assert.deepEqual([next.node.calls.length, next.answerReads()], [sent, reads]);
});

test('#8 resume hands back a checked final answer even when writing the outgoing table fails', async t => {
  const world = worldFake(), h = await holderOf(t, world);
  const { first, grant, call } = await sentThenStopped(t, world, h);
  h.node.deaf = false;
  await h.holder.tick();
  await until(() => h.lastAnswer(ROOT, call.request)?.state === 'completed', '持有方答完');
  const next = await restarted(t, world, first, { wrapStore: store => ({ ...store, setOutgoingState: async () => { throw new Error('磁盘满了'); } }) });
  assert.equal((await next.resume({ grant, id: call.id })).stdout, 'ran echo late');
});

test('#4 a request sent as A is retracted as A: deferred while I am B, done once I am A again', async t => {
  const world = worldFake(), h = await holderOf(t, world), c = await callerOf(t, world);
  const grant = await granted(h, c);
  h.node.deaf = true;
  await h.holder.tick();
  const call = c.exec({ grant });
  await until(() => c.requests().length === 1, '请求发出');
  await c.node.change({ author: NEW_ROOT });
  await rejectsWith(call.promise, 'invalid_state', 'unknown');
  await world.timers.advance(6 * MINUTE);
  await c.caller.tick();
  assert.equal(c.retracted(call.request), false);
  assert.ok(await c.store.getOutgoing(call.request), '作者不符时不删待办');
  await c.node.change({ author: ROOT });
  await until(async () => c.retracted(call.request) && !(await c.store.getOutgoing(call.request)), '切回 A 后撤回');
});

test('#5 a cancel that cannot be published stays pending, the message says so, and it is sent once signing works again', async t => {
  const world = worldFake(), h = await holderOf(t, world), c = await callerOf(t, world);
  const grant = await granted(h, c);
  h.node.deaf = true;
  await h.holder.tick();
  const call = c.exec({ grant });
  await until(() => c.requests().length === 1, '请求发出');
  await c.node.change({ certificate: EXPIRED });
  await world.timers.advance(ACK_MS);
  await rejectsWith(call.promise, 'peer_offline', 'unknown', ['取消没能发出', call.request]);
  await assert.rejects(call.promise, error => !error.message.includes('已请'));
  assert.deepEqual([c.cancels(call.request).length, (await c.store.getOutgoing(call.request)).state], [0, 'cancel_pending']);
  await c.node.change({ certificate: ACTIVE });
  await until(async () => c.cancels(call.request).length === 1 && (await c.store.getOutgoing(call.request)).state === 'canceled', '补发取消');
});

test('#6 with two bound machines the proxy stays on the smaller id even when it cannot sign, marked unavailable, and the other deletes its own', async t => {
  const world = worldFake(), proxies = proxiesFake(), h = await holderOf(t, world);
  const big = await callerOf(t, world, { owner: 'm-2', proxies });
  const small = await callerOf(t, world, { owner: 'm-1', machine: MC2, certificate: EXPIRED, proxies });
  await h.grant(ROOT);
  await until(() => proxies.rows.some(row => row.owner === 'm-1'), '小的那台登记');
  await big.caller.tick();
  await small.caller.tick();
  assert.deepEqual(proxies.rows.map(row => [row.owner, row.status.available]), [['m-1', false]]);
});

// ---- 核对与整体评审的修正 ----

for (const [what, friends] of [['changes its machine key', [{ ...channel(), machine: STRANGER }]], ['is removed', []]]) {
  test(`a friend who ${what} before the final answer arrives: the old machine's answer is not handed back`, async t => {
    const world = worldFake(), h = await holderOf(t, world), c = await callerOf(t, world);
    const grant = await granted(h, c);
    h.exec.plan = () => 'hang';
    const call = c.exec({ grant });
    await until(() => h.answers(ROOT, call.request).includes('running') && h.exec.pending() === 1, '回执 running');
    await c.node.change({ friends });
    h.exec.releaseAll();
    await until(() => h.lastAnswer(ROOT, call.request)?.state === 'completed', '旧机器签出终态');
    await rejectsWith(call.promise, 'interrupted', 'unknown', [LOST, call.request]);
  });
}

test('resume does not hand back the final answer of a friend removed meanwhile', async t => {
  const world = worldFake(), h = await holderOf(t, world);
  const { first, grant, call } = await sentThenStopped(t, world, h);
  h.node.deaf = false;
  await h.holder.tick();
  await until(() => h.lastAnswer(ROOT, call.request)?.state === 'completed', '持有方答完');
  first.node.friends = [];
  const next = await restarted(t, world, first);
  await rejectsWith(next.resume({ grant, id: call.id }), 'interrupted', 'unknown', [LOST, call.request]);
});

test('after the request is signed, reads of the answer that keep failing end as unknown with the request number, never as none', async t => {
  const world = worldFake(), h = await holderOf(t, world), c = await callerOf(t, world);
  const grant = await granted(h, c);
  h.node.deaf = true;
  await h.holder.tick();
  const call = c.exec({ grant });
  c.node.failNext(answerQuery(call.request), { always: true });
  await until(() => c.requests().length === 1, '请求发出');
  await until(() => c.answerReads() > 0, '读过回答');
  assert.ok(await pending(call.promise), '读失败不当结局');
  await world.timers.advance(ACK_MS);
  await rejectsWith(call.promise, 'peer_offline', 'unknown', [LOST, call.request]);
  assert.equal(c.cancels(call.request).length, 1);
});

// 让调用方下一次发布请求（不含取消）出错：`published` 为真时先真的发出去，再报错（回执丢了）。
function failPublish(c, error, { published }) {
  const call = c.node.call;
  c.node.call = async (ref, operation, input) => {
    if (input.kind !== CALL || input.body.cancel === true || !Object.keys(input.body).length) return call(ref, operation, input);
    c.node.call = call;
    if (published) await call(ref, operation, input);
    throw error;
  };
}

test('a publish whose receipt times out after the holder already got the request: the call still hands back the holder\'s final answer', async t => {
  const world = worldFake(), h = await holderOf(t, world), c = await callerOf(t, world);
  const grant = await granted(h, c);
  failPublish(c, fail('timeout', '发布回执超时', 'unknown'), { published: true });
  const call = c.exec({ grant, input: { command: 'echo lost-receipt' } });
  assert.equal((await call.promise).stdout, 'ran echo lost-receipt');
  assert.deepEqual(h.answers(ROOT, call.request), ['running', 'completed']);
  await until(async () => c.retracted(call.request) && !(await c.store.getOutgoing(call.request)), '拿到结局后撤回请求');
});

test('a publish that fails with unknown effects and never reaches the holder keeps the request: after 75 seconds it ends as peer_offline, unknown, with the request number', async t => {
  const world = worldFake(), h = await holderOf(t, world), c = await callerOf(t, world);
  const grant = await granted(h, c);
  failPublish(c, fail('internal', '发布层出错', 'unknown'), { published: false });
  const call = c.exec({ grant });
  await until(() => c.answerReads() > 0, '照发出了读回答');
  assert.ok(await pending(call.promise), '发布的错误不当结局');
  assert.equal((await c.store.getOutgoing(call.request)).state, 'sent');
  await world.timers.advance(ACK_MS);
  await rejectsWith(call.promise, 'peer_offline', 'unknown', [LOST, call.request]);
});

test('a publish that says effects: none ends the call as not sent: nothing is waited for and the outgoing entry is finished', async t => {
  const world = worldFake(), h = await holderOf(t, world), c = await callerOf(t, world);
  const grant = await granted(h, c);
  failPublish(c, fail('unavailable', '签名目录不可用', 'none'), { published: false });
  const call = c.exec({ grant });
  await rejectsWith(call.promise, 'unavailable', 'none', '签名目录不可用');
  assert.equal(c.answerReads(), 0);
  await until(async () => !(await c.store.getOutgoing(call.request)), '发出项了结后清掉');
  assert.deepEqual([c.requests(), h.exec.runs], [[], 0]);
});

test('the 75-second receipt deadline wins over a first answer query that never returns: a cancel is sent and the call fails peer_offline, unknown', async t => {
  const world = worldFake(), h = await holderOf(t, world), c = await callerOf(t, world);
  const grant = await granted(h, c);
  h.node.deaf = true;
  await h.holder.tick();
  const call = c.exec({ id: 'call-hang', grant });
  const release = c.node.hold(answerQuery(call.request));
  await until(() => c.node.held(), '首次读回答挂住');
  await world.timers.advance(ACK_MS);
  await until(async () => !(await pending(call.promise)), '期限一到就结束');
  await rejectsWith(call.promise, 'peer_offline', 'unknown', [LOST, call.request]);
  assert.equal(c.node.held(), true, '查询还挂着，调用已经结束');
  assert.equal(c.cancels(call.request).length, 1);
  release();
});

test('when my author changes while resume is reading the answer, resume hands back no stdout and ends as interrupted, unknown', async t => {
  const world = worldFake(), h = await holderOf(t, world);
  const { first, grant, call } = await sentThenStopped(t, world, h);
  h.node.deaf = false;
  await h.holder.tick();
  await until(() => h.lastAnswer(ROOT, call.request)?.state === 'completed', '持有方答完');
  h.node.deaf = true;
  await h.holder.tick();
  const next = await restarted(t, world, first);
  const release = next.node.hold(answerQuery(call.request));
  const resumed = next.resume({ grant, id: call.id });
  resumed.catch(() => {});
  await until(() => next.node.held(), '读回答挂住');
  await next.node.change({ author: NEW_ROOT });
  release();
  await rejectsWith(resumed, 'interrupted', 'unknown', [LOST, call.request]);
});

test('when my author changes A→B→A while resume is reading the answer, resume still hands back no stdout and ends as interrupted, unknown', async t => {
  const world = worldFake(), h = await holderOf(t, world);
  const { first, grant, call } = await sentThenStopped(t, world, h);
  h.node.deaf = false;
  await h.holder.tick();
  await until(() => h.lastAnswer(ROOT, call.request)?.state === 'completed', '持有方答完');
  h.node.deaf = true;
  await h.holder.tick();
  const next = await restarted(t, world, first);
  const release = next.node.hold(answerQuery(call.request));
  const resumed = next.resume({ grant, id: call.id });
  resumed.catch(() => {});
  await until(() => next.node.held(), '读回答挂住');
  await next.node.change({ author: NEW_ROOT });
  await next.node.change({ author: ROOT });
  release();
  await rejectsWith(resumed, 'interrupted', 'unknown', [LOST, call.request]);
});

test('when my author changes A→B→A while resume is reading the outgoing entry, resume hands back no stdout and ends as interrupted, unknown', async t => {
  const world = worldFake(), h = await holderOf(t, world);
  const { first, grant, call } = await sentThenStopped(t, world, h);
  h.node.deaf = false;
  await h.holder.tick();
  await until(() => h.lastAnswer(ROOT, call.request)?.state === 'completed', '持有方答完');
  h.node.deaf = true;
  await h.holder.tick();
  const reads = holdWrites('getOutgoing'), next = await restarted(t, world, first, { wrapStore: reads.wrap });
  reads.arm();
  const resumed = next.resume({ grant, id: call.id });
  resumed.catch(() => {});
  await until(() => reads.waiting(), '读发出项挂住');
  await next.node.change({ author: NEW_ROOT });
  await next.node.change({ author: ROOT });
  reads.release();
  await rejectsWith(resumed, 'interrupted', 'unknown', [LOST, call.request]);
});

// ---- 恢复索引与没发出的调用 ----

test('a final answer read but not yet handed back when I restart: the request is retracted, the outgoing entry is kept, and resume hands back the real outcome', async t => {
  const world = worldFake(), h = await holderOf(t, world), writes = holdWrites('settleOutgoing');
  const first = await callerOf(t, world, { wrapStore: writes.wrap });
  const grant = await granted(h, first);
  writes.arm();
  const call = first.exec({ grant, input: { command: 'echo kept' } });
  await until(() => writes.waiting(), '拿到结局、写盘挂住');
  const release = first.node.holdGet();
  writes.release();
  await until(() => first.node.getHeld(), '交回之前读作者挂住');
  await until(() => first.retracted(call.request), '拿到结局就撤回请求');
  await first.caller.tick();
  assert.ok(await first.store.getOutgoing(call.request), '结局还没交回宿主，发出项留着');
  first.stop();
  const next = await restarted(t, world, first);
  await next.caller.tick();
  assert.ok(await next.store.getOutgoing(call.request), '重启后的清扫不删恢复期内的发出项');
  assert.equal((await next.resume({ grant, id: call.id })).stdout, 'ran echo kept');
  await until(async () => !(await next.store.getOutgoing(call.request)), '交回之后清掉发出项');
  release();
});

for (const canceled of [false, true]) test(`a request expired 24 hours and more when I restart keeps its outgoing entry through the resume window, and resume${canceled ? ' (canceled)' : ''} hands back the holder's signed final answer${canceled ? ' without signing a cancel' : ''}`, async t => {
  const world = worldFake(), h = await holderOf(t, world);
  const { first, grant, call } = await sentThenStopped(t, world, h);
  h.node.deaf = false;
  await h.holder.tick();
  await until(() => h.lastAnswer(ROOT, call.request)?.state === 'completed', '持有方答完');
  h.node.deaf = true;
  await h.holder.tick();
  world.clock.now = START + 5 * MINUTE + 24 * 60 * MINUTE + MINUTE;
  const next = await restarted(t, world, first);
  await next.caller.tick();
  assert.ok(next.retracted(call.request), '撤回请求照旧');
  assert.ok(await next.store.getOutgoing(call.request), '过期满 24 小时的发出项在恢复期内也不删');
  assert.equal((await next.resume({ grant, id: call.id, canceled })).stdout, 'ran echo late');
  await next.caller.tick();
  // 已撤回的请求不补签取消：目录里仍没有这条请求，撤回之后没有再签过它，发出项已删。
  const signed = next.node.calls.filter(one => one.kind === CALL && one.id === call.request);
  assert.deepEqual([world.records.some(record => record.kind === CALL && record.id === call.request), Object.keys(signed.at(-1).body).length, next.cancels(call.request),
    await next.store.getOutgoing(call.request)], [false, 0, [], null]);
});

test('a request I already withdrew is not canceled by resume even when the clock goes back before expiresAt: no cancel is signed and the command does not come back to the directory', async t => {
  const world = worldFake(), h = await holderOf(t, world);
  const { first, grant, call } = await sentThenStopped(t, world, h);
  world.clock.now = START + 5 * MINUTE + 24 * 60 * MINUTE + MINUTE;
  const next = await restarted(t, world, first);
  await next.caller.tick();
  assert.ok(next.retracted(call.request), '启动清扫撤回请求');
  world.clock.now = START + MINUTE;
  await rejectsWith(next.resume({ grant, id: call.id, canceled: true }), 'interrupted', 'unknown', call.request);
  assert.deepEqual([next.cancels(call.request), world.records.some(record => record.kind === CALL && record.id === call.request)], [[], false]);
});

for (const [why, code, act] of [
  ['canceled', 'canceled', call => call.controller.abort()],
  ['timed out', 'timeout', call => call.controller.abort(new DOMException('到期了', 'TimeoutError'))],
  ['past its deadline', 'timeout', (call, world) => { world.clock.now += 6 * MINUTE; }],
]) {
  test(`a call ${why} while the outgoing table is being written ends as ${code}, none without signing the request: the holder never sees it`, async t => {
    const world = worldFake(), h = await holderOf(t, world), writes = holdWrites('addOutgoing');
    const c = await callerOf(t, world, { wrapStore: writes.wrap });
    const grant = await granted(h, c);
    writes.arm();
    const call = c.exec({ grant });
    await until(() => writes.waiting(), '写发出表挂住');
    act(call, world);
    writes.release();
    await until(async () => !(await pending(call.promise)), '不签请求就结束');
    await rejectsWith(call.promise, code, 'none');
    await h.holder.tick();
    assert.deepEqual([c.requests(), c.cancels(call.request), h.exec.runs, h.lastAnswer(ROOT, call.request)], [[], [], 0, undefined]);
  });
}

test('a call canceled while the gateway reads my signing identity ends as canceled, none: the holder never sees the request', async t => {
  const world = worldFake(), h = await holderOf(t, world), writes = holdWrites('addOutgoing');
  const c = await callerOf(t, world, { wrapStore: writes.wrap });
  const grant = await granted(h, c);
  writes.arm();
  const call = c.exec({ grant });
  await until(() => writes.waiting(), '写发出表挂住');
  // 调用方自己读身份在写发出表之前：此后的下一次读本机 Accord 是网关签名前读签名身份。
  const release = c.node.holdGet();
  writes.release();
  await until(() => c.node.getHeld(), '网关读签名身份挂住');
  call.controller.abort();
  release();
  await rejectsWith(call.promise, 'canceled', 'none');
  await h.holder.tick();
  assert.deepEqual([c.requests(), c.cancels(call.request), h.exec.runs, h.lastAnswer(ROOT, call.request)], [[], [], 0, undefined]);
});

// ---- 大小 ----

test('a completed answer whose result has a field this version does not know is handed back without that field', async t => {
  const world = worldFake(), h = await holderOf(t, world), c = await callerOf(t, world);
  const grant = await granted(h, c);
  h.exec.plan = () => ({ exitCode: 0, signal: null, stdout: 'new\n', stderr: '', timedOut: false, truncated: false, outputDir: null, ms: 3, cpuMs: 2 });
  const call = c.exec({ grant });
  await until(async () => !(await pending(call.promise)), '交出结局');
  assert.deepEqual(await call.promise, { exitCode: 0, signal: null, stdout: 'new\n', stderr: '', timedOut: false, truncated: false, outputDir: null, ms: 3 });
  assert.equal(h.lastAnswer(ROOT, call.request).result.cpuMs, 2, 'the holder did sign the extra field');
});

test('a request over 56 KiB is refused on the spot; a truncated answer is handed back with truncated set', async t => {
  const world = worldFake(), h = await holderOf(t, world), c = await callerOf(t, world);
  const grant = await granted(h, c);
  await rejectsWith(c.exec({ grant, input: { command: 'x'.repeat(57 * 1024) } }).promise, 'invalid_input', 'none');
  assert.deepEqual([c.requests(), await c.store.listOutgoing()], [[], []]);
  h.exec.plan = () => ({ exitCode: 0, signal: null, stdout: 'y'.repeat(100 * 1024), stderr: '', timedOut: false, truncated: false, outputDir: null, ms: 3 });
  const result = await c.exec({ grant }).promise;
  assert.equal(result.truncated, true);
  assert.match(result.stdout, /省略了 \d+ 字节/);
});

// ---- pull、push ----

test('pull and push on a proxy record are unsupported before the first byte', async t => {
  const world = worldFake(), c = await callerOf(t, world);
  for (const name of ['pull', 'push']) {
    await rejectsWith((async () => c.streams.get(name)(new Request('http://x/?path=/tmp/a'), { record: { kind: MACHINE, id: 'proxy' } }))(), 'unsupported', 'none', UNSUPPORTED);
  }
});

// ---- 授权的范围 ----

const DIRS = { dirs: [{ path: '/srv/work', access: 'rw' }, { path: '/srv/data', access: 'ro' }] };
const DIRS_2 = { dirs: [{ path: '/srv/other', access: 'rw' }] };
const grantDirs = (h, restrict = DIRS) => h.holder.self['grants.grant']({ friend: ROOT, target: { kind: MACHINE, id: 'rx-1' }, restrict }).then(row => row.grant);
const registered = (c, grant) => until(() => c.mine().some(row => row.key === proxyKey(HM, grant) && row.status.available), '代理记录登记');

test('a directories grant is a proxy record whose spec keeps its four fields and whose default directory is the first rw one; list carries the scope for display, and follows a change of scope', async t => {
  const world = worldFake(), h = await holderOf(t, world), c = await callerOf(t, world);
  const grant = await grantDirs(h);
  await registered(c, grant);
  const [row] = c.mine();
  assert.deepEqual(Object.keys(row.spec).sort(), ['cwd', 'name', 'os', 'user'], 'the spec of a record under remote-exec/machine@1 gains no field');
  assert.deepEqual(row.spec, { ...SPEC, name: 'box@zzy#1948', cwd: '/srv/work' });
  assert.deepEqual(row.status, { available: true });
  assert.deepEqual(row.labels, { 'friends-holder': HM, 'friends-grant': grant, tail: fullTail(HM) });
  const proxy = { key: proxyKey(HM, grant), grant, holder: HM, name: 'box@zzy#1948', os: 'linux', user: 'u', status: 'available' };
  assert.deepEqual(await c.caller.list(), [{ ...proxy, restrict: DIRS }]);
  assert.deepEqual(await c.caller.list({ friend: HM }), [{ ...proxy, restrict: DIRS }]);

  // 持有方改范围：同一授权号、更高版本，调用方这边的展示跟着变，代理记录还是同一条。
  await h.holder.self['grants.restrict']({ grant, restrict: DIRS_2 });
  await until(() => c.mine()[0].spec.cwd === '/srv/other', '默认目录跟着改');
  assert.deepEqual(await c.caller.list(), [{ ...proxy, restrict: DIRS_2 }]);
  assert.deepEqual(c.mine().map(one => one.key), [proxyKey(HM, grant)]);
  // 改回整台机器：默认目录是机器自己的，列表里没有范围。
  await h.holder.self['grants.restrict']({ grant });
  await until(() => c.mine()[0].spec.cwd === '/home/u', '默认目录回到机器的');
  assert.deepEqual(await c.caller.list(), [proxy]);
});

test('calling a proxy sends the friend\'s command alone: the caller refuses a restrict of its own, and under a directories grant the holder runs it with the restrict of the grant', async t => {
  const world = worldFake(), h = await holderOf(t, world), c = await callerOf(t, world);
  const grant = await grantDirs(h);
  await registered(c, grant);
  await rejectsWith(c.exec({ grant, input: { command: 'ls', restrict: { dirs: [{ path: '/', access: 'rw' }] } } }).promise, 'invalid_input', 'none', '范围');
  assert.deepEqual(c.requests(), [], 'nothing was signed');
  const call = c.exec({ grant, input: { command: 'ls /srv/work' } });
  await settles(call.promise);
  assert.equal((await call.promise).stdout, 'ran ls /srv/work');
  assert.deepEqual([...h.exec.jobs.values()].filter(job => job.input.command === 'ls /srv/work').map(job => job.input), [{ command: 'ls /srv/work', restrict: DIRS }]);
  assert.deepEqual(c.requests().map(request => request.body.input), [{ command: 'ls /srv/work' }], 'the scope never travels in the friend\'s request');
});

test('a grant record this side cannot verify (how an older version meets a directories grant) leaves an already registered proxy in place but unusable, with a channel status, and nothing is sent', async t => {
  const world = worldFake(), h = await holderOf(t, world), c = await callerOf(t, world);
  const grant = await granted(h, c);
  // 旧版收到仅限目录的授权记录时的处境：记录在目录里、正文非空，却过不了它的校验（v 不是 1、多出一项）。这里用同样过不了校验的正文替代，走的是同一条路。
  world.inject({ author: HM, kind: GRANT, id: grant, body: { ...grantRecord({ holder: HM, grantee: ROOT, grant, spec: SPEC, available: true, grantedAt: START }).body, v: 3 }, audience: [ROOT] });
  await c.caller.tick();
  assert.equal(c.mine().length, 1, 'not deleted: the grant is not retracted');
  assert.equal((await c.caller.list())[0].status, 'channel');
  await until(() => !c.mine()[0].status.available, '代理记录标成不可用');
  await rejectsWith(c.exec({ grant }).promise, 'unavailable', 'none', '授权记录不在了');
  assert.deepEqual(c.requests(), []);
});
