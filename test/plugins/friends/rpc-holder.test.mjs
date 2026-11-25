// 好友签名网关的持有方（lib/rpc-holder.mjs），在测试宿主里整段跑：签名与撤回经真实的网关内部入口；本机 Accord（coda/accord@1）是替身，
// 能换作者、证书与机器钥匙（certificate 为 null 是没绑个人身份、作者就是机器钥匙；绑了时机器钥匙在 certificate.key）、注入别人的签名记录、
// 记下本机的发布与撤回、认 expectAuthor 与 signer: "machine"；好友表每项给出 machine 与 certified；本机 remote-exec 的 exec 也是替身，能控制完成、失败、
// 挂起、被中止，并按内核幂等键接上同一个调用、记下收到的键；目标记录（remote-exec/machine@1）由测试直接摆放。
import { TEST_OWNER, createMockCoda } from '../../helpers/mock-coda.mjs';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { activate, deactivate } from '../../../plugins/friends/main.mjs';
import { createGateway } from '../../../plugins/friends/lib/gateway.mjs';
import { ANSWER_KEEP_MS, POLL_MS, createHolder } from '../../../plugins/friends/lib/rpc-holder.mjs';
import { answerId, callRecord, cancelRecord, idempotencyKey, requestId } from '../../../plugins/friends/lib/rpc-format.mjs';
import { LIMITS, commandInfo, createRpcStore } from '../../../plugins/friends/lib/rpc-store.mjs';

const friendsManifest = JSON.parse(await readFile(new URL('../../../plugins/friends/package.json', import.meta.url), 'utf8'));
const remoteExec = JSON.parse(await readFile(new URL('../../../plugins/remote-exec/package.json', import.meta.url), 'utf8'))
  .contributes.protocols.find(protocol => protocol.name === 'remote-exec/machine@1');
const ACCORD = 'coda/accord@1', MACHINE = 'remote-exec/machine@1';
const key = c => `ed25519:${c.repeat(64)}`;
// ME 是本机绑了个人身份时的根，MK（= MACHINE_KEY）是本机的机器钥匙，NEW_MK 是换过的机器钥匙。
const ME = key('a'), NEW_ROOT = key('b'), MACHINE_KEY = key('c'), MK = MACHINE_KEY, NEW_MK = key('d'), F1 = key('1'), F2 = key('2'), F3 = key('3'), STRANGER = key('9');
// 好友各自通道背后的机器钥匙：F1、F3 是个人作者（根），F2 是机器作者（机器钥匙就是作者）。
const F1_MACHINE = key('4'), F3_MACHINE = key('6');
const ACTIVE = { active: true, until: 1_900_000_000 }, EXPIRED = { active: false };
const START = Date.UTC(2026, 10, 24, 12, 0, 0), MINUTE = 60_000;
const SPEC = { name: 'box', os: 'linux', user: 'u', cwd: '/home/u' };

const until = async (check, what = '条件') => {
  for (let i = 0; i < 600; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error(`等不到：${what}`);
};
const fail = (code, message, effects = 'none') => Object.assign(new Error(message), { code, effects });

// 本机 Accord：记录按 (作者, kind, id) 存最新版本；本机的发布与撤回（正文为空、受众为空）记在 calls；别人的签名记录用 inject 放进来。
const FRIENDS = [{ node: 'n1', author: F1, bound: true, machine: F1_MACHINE, certified: true }, { node: 'n2', author: F2, bound: true, machine: F2, certified: false },
  { node: 'n3', author: F3, bound: false, machine: F3_MACHINE, certified: true }];
function accordFake({ author = ME, certificate = ACTIVE, machine = MK, friends = FRIENDS } = {}) {
  const fake = { author, certificate, machine, friends, records: [], calls: [], queries: [], listeners: new Set(), pageSize: 3 };
  // 机器钥匙读不出（machine 为 null）时证书项里不写 key。
  const certificateOf = () => fake.certificate === null ? null : { ...fake.certificate, ...(fake.machine ? { key: fake.machine } : {}) };
  const entry = () => ({ kind: ACCORD, id: 'local', owner: TEST_OWNER, local: true, spec: { author: fake.author }, status: { friends: structuredClone(fake.friends), certificate: certificateOf() } });
  const upsert = (by, kind, id, body, audience, local) => {
    const at = fake.records.findIndex(r => r.author === by && r.kind === kind && r.id === id);
    const version = (at < 0 ? 0 : fake.records[at].version) + 1;
    if (at >= 0) fake.records.splice(at, 1);
    // 受众为空是撤回；null 是没写受众的记录（测拒绝用）。
    if (audience === null || audience.length) fake.records.push({ author: by, kind, id, version, body: structuredClone(body), ...(audience === null ? {} : { audience: [...audience] }), local });
    return version;
  };
  Object.assign(fake, {
    // 本机此刻的机器钥匙：没绑个人身份时就是作者。
    machineKey: () => fake.certificate === null ? fake.author : fake.machine,
    get: async () => structuredClone(entry()),
    async change(next) {
      Object.assign(fake, next);
      for (const listener of [...fake.listeners]) await listener({ type: 'MODIFIED', id: 'local', entry: structuredClone(entry()) });
    },
    // 别人签给我的记录（audience 可以写成任意样子，测拒绝用）。
    inject: ({ author: by, kind, id, body, audience }) => upsert(by, kind, id, body, audience, false),
    // 下一次符合 `match` 的查询挂住，直到放行（只挂一次）；`held()` 说有没有查询正挂着。
    hold(match) {
      let release;
      fake.gate = { match, promise: new Promise(resolve => { release = resolve; }), waiting: false };
      return () => { fake.gate = null; release(); };
    },
    held: () => fake.gate?.waiting === true,
    query: async (ref, operation, input) => {
      assert.deepEqual([ref.kind, operation], [ACCORD, 'records']);
      fake.queries.push(structuredClone(input));
      if (fake.gate?.match(input) && !fake.gate.waiting) { fake.gate.waiting = true; await fake.gate.promise; }
      const rows = fake.records.filter(r => r.kind === input.kind && (input.author === undefined || r.author === input.author) && (input.id === undefined || r.id === input.id))
        .map(({ audience, ...rest }) => input.includeAudience ? { ...rest, audience } : rest);
      const from = Number(input.cursor ?? 0), page = rows.slice(from, from + fake.pageSize), more = from + fake.pageSize < rows.length;
      return { records: structuredClone(page), truncated: more, ...(more ? { nextCursor: String(from + fake.pageSize) } : {}) };
    },
    call: async (ref, operation, input) => {
      assert.deepEqual([ref.kind, ref.id, operation], [ACCORD, 'local', 'publish']);
      // signer: "machine"：用机器钥匙签、不看证书，只许签自己命名空间的种类。
      const byMachine = input.signer === 'machine', signer = byMachine ? fake.machineKey() : fake.author;
      if (byMachine && !input.kind.startsWith('friends/')) throw fail('forbidden', '只能签自己命名空间的种类');
      if (input.expectAuthor !== signer) throw fail('forbidden', '预期作者与此刻署名的作者不符');
      // 不带 signer 时署此刻的作者：没绑个人身份（certificate 为 null）用机器钥匙签，没有有效期；绑了的要证书有效。
      if (!byMachine && fake.certificate !== null && fake.certificate?.active !== true) throw fail('invalid_state', '代签证书已过期');
      fake.calls.push(structuredClone(input));
      const version = upsert(signer, input.kind, input.id, input.body, input.audience, true);
      return { author: signer, kind: input.kind, id: input.id, version, audience: input.audience };
    },
    watch: async (name, listener) => {
      fake.listeners.add(listener);
      await listener({ type: 'ADDED', id: 'local', entry: structuredClone(entry()) });
      return { dispose: () => fake.listeners.delete(listener) };
    },
  });
  return fake;
}

// remote-exec 的 exec：每个新的幂等键执行一次（runs 计数），同一个键再调接上原来那次。`plan(input)` 决定这一次怎么结束：
// 给结果对象就完成，给 Error 就失败，给 'hang' 就挂着等 release。
// 与真实的 coda.call 一样：signal 一中止，这次 call 立刻以 signal 的中止原因失败（effects 记 unknown），并把取消交给内核（挂着的命令以 interrupted 结束），
// 内核那边之后怎么结束不再交回。`holdRouting()` 让下一次调用挂在路由上、还没登记幂等键，返回放行的函数；路由期间中止的不登记、不执行。
function execFake() {
  const ok = command => ({ exitCode: 0, signal: null, stdout: `ran ${command}`, stderr: '', timedOut: false, truncated: false, outputDir: null, ms: 7 });
  const fake = { calls: [], jobs: new Map(), runs: 0, routing: null, plan: input => ok(input.command) };
  const givenUp = signal => Object.assign(signal.reason, { effects: 'unknown' });
  const onAbort = (signal, abort) => { if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true }); };
  fake.holdRouting = () => {
    let open;
    fake.routing = new Promise(resolve => { open = resolve; });
    return open;
  };
  fake.call = async (ref, operation, input, options = {}) => {
    assert.equal(operation, 'exec');
    fake.calls.push({ ref: structuredClone(ref), input: structuredClone(input), id: options.id, timeout: options.timeout, signaled: options.signal !== undefined });
    if (fake.routing) {
      const gate = fake.routing;
      fake.routing = null;
      await new Promise((resolve, reject) => { gate.then(resolve); if (options.signal) onAbort(options.signal, () => reject(givenUp(options.signal))); });
    }
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
    if (!options.signal) return job.done;
    const local = new Promise((resolve, reject) => onAbort(options.signal, () => {
      reject(givenUp(options.signal));
      if (!job.settled) job.reject(fail('interrupted', '命令被中止', 'unknown'));
    }));
    return Promise.race([job.done, local]);
  };
  fake.release = (id, result = ok(fake.jobs.get(id).input.command)) => fake.jobs.get(id).resolve(result);
  // 到了调用给的时限内核放弃（同 coda.call 的 timeout：放弃并发取消），以 timeout、unknown 失败。
  fake.expire = id => fake.jobs.get(id).reject(fail('timeout', '调用超过了期限，已放弃', 'unknown'));
  fake.pending = () => [...fake.jobs.values()].filter(job => !job.settled).length;
  // 内核过了保留期，忘掉所有幂等键：之后同一个键再调就是新调用。
  fake.forget = () => fake.jobs.clear();
  // 把还挂着的都放掉，等持有方接着做完；挂着的会再挂起，所以按轮放。
  fake.releaseAll = async settle => { for (let round = 0; round < 4 && fake.pending(); round++) { for (const [id, job] of fake.jobs) if (!job.settled) fake.release(id); await settle(); } };
  return fake;
}

// 目标记录（本机的，与 owner 写成别台、local: false 的别台副本）：get 找不到给 null（同 coda.get）；`absent` 时本机没有这个协议，get 报 not_found。
// 改动告诉 watch（quiet 时不告诉，测「准入时才发现」）。`machines` 是空间里此刻读得到的机器记录（coda/machine@1，按后端 ID），`offline` 里的机器连不上。
function targetsFake() {
  const fake = { rows: new Map(), listeners: new Set(), absent: false, machines: new Map([[TEST_OWNER, { offline: false }]]), offline: new Set() };
  Object.assign(fake, {
    set(id, more = {}, { quiet = false } = {}) {
      const row = { kind: MACHINE, id, owner: TEST_OWNER, location: 'local', plugin: 'remote-exec', local: true, spec: { ...SPEC }, status: { available: true }, version: '1', ...fake.rows.get(id), ...more };
      const type = fake.rows.has(id) ? 'MODIFIED' : 'ADDED';
      fake.rows.set(id, row);
      if (!quiet) for (const listener of fake.listeners) listener({ type, id, entry: structuredClone(row) });
    },
    remove(id, { quiet = false } = {}) {
      const row = fake.rows.get(id);
      fake.rows.delete(id);
      if (!quiet) for (const listener of fake.listeners) listener({ type: 'DELETED', id, entry: structuredClone(row) });
    },
    // 放过接下来的 `pass` 次查询，之后的都挂住，直到放行；`waiting()` 说有没有查询正挂着。
    hold(pass) {
      let release;
      fake.gate = { pass, promise: new Promise(resolve => { release = resolve; }), waiting: 0 };
      return () => { fake.gate = null; release(); };
    },
    waiting: () => (fake.gate?.waiting ?? 0) > 0,
    get: async id => {
      const gate = fake.gate;
      if (gate && gate.pass-- <= 0) { gate.waiting++; await gate.promise; }
      if (fake.absent) throw fail('not_found', '没有协议：remote-exec/machine@1');
      return fake.rows.has(id) ? structuredClone(fake.rows.get(id)) : null;
    },
    machine: async id => fake.machines.has(id) ? { kind: 'coda/machine@1', id, owner: id, local: id === TEST_OWNER, spec: { name: id }, status: { offline: fake.machines.get(id).offline } } : null,
    watch: async listener => {
      fake.listeners.add(listener);
      for (const row of fake.rows.values()) listener({ type: 'ADDED', id: row.id, entry: structuredClone(row) });
      return { dispose: () => fake.listeners.delete(listener) };
    },
  });
  fake.set('rx-1');
  return fake;
}

// 测试宿主上的 coda：Accord、remote-exec、目标记录走替身，其余（自用查询、错误、状态目录）走测试宿主。
function routed(host, { accord, exec, targets }) {
  return { ...host.coda,
    get: ref => ref.kind === ACCORD ? accord.get() : ref.kind === MACHINE ? targets.get(ref.id) : ref.kind === 'coda/machine@1' ? targets.machine(ref.id) : host.coda.get(ref),
    query: accord.query,
    // 调用内核按目标记录路由：目标不在了，调用到不了执行端，以 not_found、none 失败。
    // 目标所在的机器连不上：以 peer_offline、none 失败（同 Coda 对已知离线的持有方）。
    call: (ref, operation, input, options) => ref.kind === ACCORD ? accord.call(ref, operation, input)
      : !targets.rows.has(ref.id) ? Promise.reject(fail('not_found', `没有记录 ${ref.id}`))
        : targets.offline.has(targets.rows.get(ref.id).owner) ? Promise.reject(fail('peer_offline', '持有方此刻连不上'))
          : exec.call(ref, operation, input, options),
    watch: (kind, listener, selector) => kind === ACCORD ? accord.watch(kind, listener, selector) : kind === MACHINE ? targets.watch(listener) : host.coda.watch(kind, listener, selector) };
}

// 一个持有方：真实的网关与 store，节拍由测试手动推（定时器不走）。`shared` 给另一个实例的替身与目录，模拟重启。
async function holderOf(t, shared = {}) {
  const dir = shared.dir ?? await mkdtemp(join(tmpdir(), 'friends-holder-'));
  // 同一目录上先后起的实例（模拟重启）都停了，才删目录。
  const instances = shared.instances ?? [];
  if (!shared.dir) t.after(async () => { for (const one of instances) one.stop(); await new Promise(resolve => setTimeout(resolve, 20)); await rm(dir, { recursive: true, force: true }); });
  const clock = shared.clock ?? { now: START }, accord = shared.accord ?? accordFake(shared.accordOptions), exec = shared.exec ?? execFake(), targets = shared.targets ?? targetsFake();
  const host = createMockCoda({ plugin: { id: 'friends', state: dir, protocols: friendsManifest.contributes.protocols }, protocols: [remoteExec] });
  const coda = routed(host, { accord, exec, targets });
  const gateway = createGateway(coda, dir);
  await gateway.start();
  const store = createRpcStore(dir, { now: () => clock.now });
  const holder = createHolder(coda, { store: shared.wrapStore?.(store) ?? store, signRpc: gateway.signRpc, retractRpc: gateway.retractRpc, onAccord: gateway.onAccord, pages: gateway.pages, now: () => clock.now,
    timers: shared.timers ?? { setTimeout: () => null, clearTimeout() {} }, onMaintenanceError: shared.onMaintenanceError });
  const h = { dir, instances, clock, accord, exec, targets, host, gateway, store, holder, stopped: false };
  h.stop = () => { if (h.stopped) return; h.stopped = true; holder.stop(); gateway.stop(); host.close(); };
  instances.push(h);
  await holder.start();
  const quiet = () => until(() => holder.busy() <= exec.pending(), '在途项停下');
  return Object.assign(h, {
    // 推一拍，等所有在途项走到停得住的地方（挂在 exec 上的除外）。
    async settle() { await holder.tick(); await quiet(); await holder.tick(); await quiet(); await new Promise(resolve => setTimeout(resolve, 10)); },
    grant: (friend = F1, target = { kind: MACHINE, id: 'rx-1' }) => holder.self['grants.grant']({ friend, target }),
    published: kind => accord.calls.filter(call => call.kind === kind),
    answers: (caller, request) => accord.calls.filter(call => call.kind === 'friends/rpc-answer' && call.id === answerId(caller, request)).map(call => call.body.state ?? 'retracted'),
    lastAnswer: (caller, request) => accord.calls.filter(call => call.kind === 'friends/rpc-answer' && call.id === answerId(caller, request)).at(-1),
    ledger: more => store.readLedger({ limit: 100, ...more }),
  });
}

// 一条好友签给持有方的调用请求，放进 Accord。返回请求正文。
let counter = 0;
function send(h, { from = F1, grant, holder = h.accord.machineKey(), ctx = `call-${++counter}`, request = requestId(ctx), input = { command: `echo ${counter}` },
  createdAt = h.clock.now, expiresAt = createdAt + 5 * MINUTE, audience = [holder], cancel } = {}) {
  const record = callRecord({ caller: from, holder, grant, request, input, createdAt, expiresAt });
  const body = cancel ? cancelRecord(record.body, cancel).body : record.body;
  h.accord.inject({ author: from, kind: 'friends/rpc-call', id: request, body, audience });
  return body;
}
const cancelOf = (h, body, at = h.clock.now) => {
  h.accord.inject({ author: body.caller, kind: 'friends/rpc-call', id: body.request, body: cancelRecord(body, at).body, audience: [body.holder] });
};
const rejections = async (h, code) => (await h.ledger({ outcome: 'rejected' })).filter(row => code === undefined || row.code === code);
// 准入前就拒、又签回了失败终态的（授权在、请求方是被授权人且仍是好友）：回答只有一条 failed，effects none，操作记录记 failed 与原因。
const refusedWith = (h, body) => {
  const all = h.answers(body.caller, body.request), last = h.lastAnswer(body.caller, body.request)?.body;
  return all.length === 1 && last?.state === 'failed' && last.error.effects === 'none' ? last.error.code : `answers ${JSON.stringify(all)}`;
};
const refusals = async (h, code) => (await h.ledger({ outcome: 'failed' })).filter(row => row.code === code);

// ---- 授予与撤销 ----

test('granting checks the target, the friend and the machine key, pins the target and the machine key, and publishes the grant to that friend alone, signed by the machine key', async t => {
  const h = await holderOf(t);
  // 好友分享来的代理记录（本机的、空间里别的机器上的）、别的插件提供的同种记录：都不能授出。
  h.targets.set('other-proxy', { owner: 'someone-else', location: 'x', local: false, plugin: 'friends' });
  h.targets.set('own-proxy', { plugin: 'friends' });
  h.targets.set('other-plugin', { owner: 'someone-else', location: 'x', local: false, plugin: 'other' });
  const refused = async (input, code = 'invalid_input') => assert.rejects(h.holder.self['grants.grant'](input), error => error.code === code);
  await refused({ friend: F1, target: { kind: MACHINE, id: 'other-proxy' } });
  await refused({ friend: F1, target: { kind: MACHINE, id: 'own-proxy' } });
  await refused({ friend: F1, target: { kind: MACHINE, id: 'other-plugin' } });
  await refused({ friend: F1, target: { kind: MACHINE, id: 'nope' } }, 'not_found');
  await refused({ friend: F1, target: { kind: 'other/kind@1', id: 'rx-1' } });
  await refused({ friend: F3, target: { kind: MACHINE, id: 'rx-1' } }, 'invalid_input');
  await refused({ friend: STRANGER, target: { kind: MACHINE, id: 'rx-1' } });
  await refused({ friend: 'someone', target: { kind: MACHINE, id: 'rx-1' } });
  // 机器名含控制字符、换行、双向控制符或首尾有空白：当场失败，什么也不留。
  for (const name of ['a\nb', 'a\u0007b', 'a\u0085b', 'a\u202eb', ' box', 'box ']) {
    h.targets.set('rx-1', { spec: { ...SPEC, name } });
    await refused({ friend: F1, target: { kind: MACHINE, id: 'rx-1' } });
  }
  assert.deepEqual(await h.store.listGrants(), []);
  assert.deepEqual(h.published('friends/rpc-grant'), []);
  h.targets.set('rx-1', { spec: { ...SPEC } });
  // 读不出本机的机器钥匙：不能授权。
  await h.accord.change({ machine: null });
  await refused({ friend: F1, target: { kind: MACHINE, id: 'rx-1' } }, 'invalid_state');
  assert.deepEqual(await h.store.listGrants(), []);
  assert.deepEqual(h.published('friends/rpc-grant'), []);

  // 本机的证书过期不影响授权：持有方用机器钥匙签。
  await h.accord.change({ machine: MK, certificate: EXPIRED });
  const granted = await h.grant();
  assert.equal(granted.status, 'available');
  const [row] = await h.store.listGrants();
  assert.match(row.id, /^[0-9a-f-]{36}$/);
  // 被授权者是不是个人作者取好友表的 certified。
  assert.equal(row.granteePerson, true);
  assert.deepEqual([row.grantee, row.holder, row.target, row.createdAt], [F1, { machine: MK }, { owner: TEST_OWNER, provider: 'remote-exec', kind: MACHINE, id: 'rx-1' }, START]);
  assert.deepEqual(h.published('friends/rpc-grant'), [{ kind: 'friends/rpc-grant', id: row.id, audience: [F1], signer: 'machine', expectAuthor: MK,
    body: { v: 1, holder: MK, grantee: F1, grant: row.id, protocol: MACHINE, ops: ['exec'], spec: SPEC, available: true, grantedAt: START } }]);
});

test('granting the same friend the same target twice gives back the one live grant; once revoked it is refused, and granting again is a new grant; another friend or another target is its own grant', async t => {
  const h = await holderOf(t);
  h.targets.set('rx-2');
  const live = async () => (await h.store.listGrants()).filter(row => row.revokedAt === undefined);
  const first = await h.grant();
  // 命中已有授权：不另生成授权号、不写盘，也不再查目录、不再签发。
  const file = join(h.dir, 'rpc', 'grants.json'), written = await readFile(file, 'utf8'), calls = h.accord.calls.length, queries = h.accord.queries.length;
  const again = await h.grant();
  assert.equal(again.grant, first.grant);
  assert.deepEqual([await readFile(file, 'utf8'), h.accord.calls.length, h.accord.queries.length], [written, calls, queries]);
  assert.deepEqual((await live()).map(row => row.id), [first.grant]);
  assert.deepEqual(h.published('friends/rpc-grant').map(call => call.id), [first.grant], 'one grant record sent');

  await h.holder.self['grants.revoke']({ grant: first.grant });
  await h.settle();
  assert.deepEqual(await live(), []);
  const body = send(h, { grant: first.grant });
  await h.settle();
  assert.equal(refusedWith(h, body), 'revoked');
  assert.equal(h.exec.runs, 0);
  assert.equal((await refusals(h, 'revoked')).length, 1);

  const renewed = await h.grant();
  assert.notEqual(renewed.grant, first.grant);
  const other = await h.grant(F2), elsewhere = await h.grant(F1, { kind: MACHINE, id: 'rx-2' });
  assert.equal(new Set([renewed.grant, other.grant, elsewhere.grant]).size, 3);
  assert.deepEqual((await live()).map(row => row.id).sort(), [renewed.grant, other.grant, elsewhere.grant].sort());
});

test('when the target\'s availability or a published spec field (the machine name) changes the grant record is published again under the same id; nothing published changes, nothing is sent', async t => {
  const h = await holderOf(t);
  const { grant } = await h.grant();
  h.targets.set('rx-1', { spec: { ...SPEC, name: 'renamed' } });
  await h.settle();
  let grants = h.published('friends/rpc-grant');
  assert.equal(grants.length, 2, 'a rename is published');
  assert.deepEqual([grants[1].id, grants[1].body.available, grants[1].body.spec.name], [grant, true, 'renamed']);
  // 公开内容没变（只是记录又触发了一次）：不发。
  h.targets.set('rx-1', { spec: { ...SPEC, name: 'renamed' } });
  await h.settle();
  assert.equal(h.published('friends/rpc-grant').length, 2);
  h.targets.set('rx-1', { status: { available: false } });
  await h.settle();
  grants = h.published('friends/rpc-grant');
  assert.equal(grants.length, 3);
  assert.deepEqual([grants[2].id, grants[2].body.available, grants[2].body.spec.name], [grant, false, 'renamed']);
  await h.settle();
  assert.equal(h.published('friends/rpc-grant').length, 3);
});

test('revoking is written to disk first and takes effect even when the retraction cannot be sent; it is sent once the machine key can be read, whatever the certificate', async t => {
  const h = await holderOf(t);
  const { grant } = await h.grant();
  await h.accord.change({ machine: null });
  const revoked = await h.holder.self['grants.revoke']({ grant });
  assert.equal(revoked.status, 'revoked');
  const onDisk = JSON.parse(await readFile(join(h.dir, 'rpc', 'grants.json'), 'utf8')).grants[grant];
  assert.equal(onDisk.revokedAt, START);
  assert.equal(h.accord.calls.length, 1, 'nothing sent while the machine key cannot be read');
  // 机器钥匙读得出了：证书过期也照撤。撤了的授权不再准入，之后来的请求被拒。
  await h.accord.change({ machine: MK, certificate: EXPIRED });
  await h.settle();
  assert.deepEqual(h.accord.calls.at(-1), { kind: 'friends/rpc-grant', id: grant, body: {}, audience: [], signer: 'machine', expectAuthor: MK });
  const body = send(h, { grant });
  await h.settle();
  assert.equal(refusedWith(h, body), 'revoked');
  assert.equal(h.exec.runs, 0);
  assert.equal((await refusals(h, 'revoked')).length, 1);
  await assert.rejects(h.holder.self['grants.revoke']({ grant: 'no-such-grant' }), error => error.code === 'not_found');
});

test('a grant whose target is gone ends for good: it is no longer admitted, its record is withdrawn and it stays ended when the target returns', async t => {
  const h = await holderOf(t);
  const { grant } = await h.grant();
  const gate = h.accord.hold(() => true);
  h.targets.remove('rx-1');
  await until(() => h.accord.held(), '撤回卡在目录查询');
  assert.equal((await h.store.getGrant(grant)).retractedAt, undefined, 'not retracted yet');
  gate();
  await until(async () => (await h.store.getGrant(grant)).retractedAt !== undefined, '撤回签出');
  assert.deepEqual(h.accord.calls.at(-1), { kind: 'friends/rpc-grant', id: grant, body: {}, audience: [], signer: 'machine', expectAuthor: MK });
  const calls = h.accord.calls.length;
  h.targets.set('rx-1');
  await h.settle();
  assert.equal(h.accord.calls.length, calls, 'the target coming back publishes nothing');
  const { grants } = await h.holder.self['grants.list']();
  assert.deepEqual(grants.map(row => [row.grant, row.status]), [[grant, 'target_missing']]);
  const body = send(h, { grant });
  await h.settle();
  assert.equal(h.exec.runs, 0);
  assert.equal(refusedWith(h, body), 'target_missing');
});

// ---- 执行 ----

test('a request runs once: running is answered first, then the outcome; the answer id comes from the caller and the request, so two friends do not collide', async t => {
  const h = await holderOf(t);
  const g1 = (await h.grant(F1)).grant, g2 = (await h.grant(F2)).grant;
  const request = requestId('same-ctx');
  const one = send(h, { from: F1, grant: g1, request, input: { command: 'echo one', cwd: '/tmp', timeout: 30, stdin: 'x' } });
  const two = send(h, { from: F2, grant: g2, request, input: { command: 'echo two', extra: 'dropped' } });
  await h.settle();
  assert.equal(h.exec.runs, 2);
  assert.deepEqual(h.exec.calls.map(call => [call.ref, call.input, call.id]), [
    [{ kind: MACHINE, id: 'rx-1' }, { command: 'echo one', cwd: '/tmp', timeout: 30, stdin: 'x' }, idempotencyKey(F1, request)],
    [{ kind: MACHINE, id: 'rx-1' }, { command: 'echo two' }, idempotencyKey(F2, request)]]);
  // 跨机调用的时限是命令时限加 60 秒（remote-exec 自己的 30 秒收尾，再留 30 秒送回结局），与最晚启动时刻无关：排着没送出的到点就放弃。
  assert.equal(h.exec.calls[0].timeout, 30_000 + 60_000);
  assert.equal(h.exec.calls[1].timeout, 120_000 + 60_000);
  assert.notEqual(answerId(F1, request), answerId(F2, request));
  for (const [caller, body, text] of [[F1, one, 'ran echo one'], [F2, two, 'ran echo two']]) {
    assert.deepEqual(h.answers(caller, request), ['running', 'completed']);
    const last = h.lastAnswer(caller, request);
    assert.deepEqual([last.audience, last.signer, last.expectAuthor, last.body.holder, last.body.caller, last.body.grant, last.body.result.stdout],
      [[caller], 'machine', MK, MK, caller, body.grant, text]);
    assert.equal(last.body.acceptedAt, START);
  }
  // 同号同摘要再看到（下一拍、或别处又发了一遍）：不再执行。
  h.accord.inject({ author: F1, kind: 'friends/rpc-call', id: request, body: one, audience: [MK] });
  await h.settle();
  assert.equal(h.exec.runs, 2);
  assert.deepEqual(h.answers(F1, request), ['running', 'completed']);
});

test('a failing exec is answered failed with its code, message and effects', async t => {
  const h = await holderOf(t);
  const { grant } = await h.grant();
  h.exec.plan = () => fail('too_many_running', '同时执行太多', 'none');
  const body = send(h, { grant });
  await h.settle();
  assert.deepEqual(h.answers(F1, body.request), ['running', 'failed']);
  assert.deepEqual(h.lastAnswer(F1, body.request).body.error, { code: 'too_many_running', message: '同时执行太多', effects: 'none' });
  // remote-exec 死在中途：照实签出 interrupted、unknown。
  h.exec.plan = () => fail('interrupted', '执行进程退出了', 'unknown');
  const second = send(h, { grant });
  await h.settle();
  assert.deepEqual(h.lastAnswer(F1, second.request).body.error, { code: 'interrupted', message: '执行进程退出了', effects: 'unknown' });
});

test('a large output is cut to fit the answer, cut is set on the answer, and the result stays a valid exec result', async t => {
  const h = await holderOf(t);
  const { grant } = await h.grant();
  h.exec.plan = () => ({ exitCode: 0, signal: null, stdout: 'o'.repeat(50_000), stderr: 'e'.repeat(50_000), timedOut: false, truncated: true, outputDir: '/tmp/out', ms: 1 });
  const body = send(h, { grant });
  await h.settle();
  const last = h.lastAnswer(F1, body.request);
  assert.equal(last.body.cut, true);
  assert.deepEqual([last.body.result.truncated, last.body.result.outputDir], [true, '/tmp/out']);
  assert.ok(Buffer.byteLength(JSON.stringify(last.body)) <= 60 * 1024);
});

// ---- 撤销的分界 ----

test('revoking: what was submitted is aborted and recorded as interrupted with unknown effects, the kernel called once for each; what was admitted but not yet submitted never starts', async t => {
  const h = await holderOf(t);
  const { grant } = await h.grant();
  h.exec.plan = () => 'hang';
  // 同时执行每人 4 个：前 4 个提交，第 5 个准入了在等名额。
  const bodies = Array.from({ length: LIMITS.executing.author }, () => send(h, { grant }));
  await h.settle();
  const waiting = send(h, { grant });
  bodies.push(waiting);
  await h.settle();
  assert.equal(h.exec.runs, 4);
  assert.deepEqual(h.answers(F1, waiting.request), ['running']);
  assert.equal((await h.store.get(F1, waiting.request)).state, 'admitted');
  await h.holder.self['grants.revoke']({ grant });
  await h.settle();
  for (const one of bodies.slice(0, 4)) {
    assert.deepEqual(h.answers(F1, one.request), ['running', 'failed']);
    assert.deepEqual(h.lastAnswer(F1, one.request).body.error, { code: 'interrupted', message: '对方撤销了授权，已中止这次调用；命令可能已经执行，结果不明', effects: 'unknown' });
    assert.equal((await h.store.get(F1, one.request)).state, 'failed');
    // 取消之后不再用同一个幂等键调内核。
    assert.equal(h.exec.calls.filter(call => call.id === idempotencyKey(F1, one.request)).length, 1);
  }
  assert.equal(h.exec.pending(), 0);
  assert.equal(h.exec.runs, 4, 'the waiting one was never started');
  assert.deepEqual(h.answers(F1, waiting.request), ['running', 'failed']);
  assert.deepEqual(h.lastAnswer(F1, waiting.request).body.error.code, 'revoked');
  assert.equal(h.lastAnswer(F1, waiting.request).body.error.effects, 'none');
  assert.deepEqual((await h.ledger({ outcome: 'failed' })).map(row => row.code).sort(), ['interrupted', 'interrupted', 'interrupted', 'interrupted', 'revoked']);
});

test('revoking after the command has finished leaves its outcome as it was', async t => {
  const h = await holderOf(t);
  const { grant } = await h.grant();
  const body = send(h, { grant });
  await h.settle();
  assert.deepEqual(h.answers(F1, body.request), ['running', 'completed']);
  const answered = h.lastAnswer(F1, body.request);
  await h.holder.self['grants.revoke']({ grant });
  await h.settle();
  assert.deepEqual(h.answers(F1, body.request), ['running', 'completed']);
  assert.deepEqual(h.lastAnswer(F1, body.request), answered);
});

test('revoking returns at once with the grant revoking; the cancel follows and the kernel is not called again', async t => {
  const h = await holderOf(t);
  const { grant } = await h.grant();
  h.exec.plan = () => 'hang';
  const body = send(h, { grant });
  await h.settle();
  assert.equal(h.exec.pending(), 1);
  const revoked = await h.holder.self['grants.revoke']({ grant });
  // 已撤、还有已提交的调用没落到终态：撤销中。
  assert.equal(revoked.status, 'revoking');
  await h.settle();
  assert.equal((await h.store.get(F1, body.request)).canceled, true);
  assert.deepEqual(h.answers(F1, body.request), ['running', 'failed']);
  // 取消路径上对这条请求只调过一次内核，没有不带 signal 的重调。
  assert.deepEqual(h.exec.calls.map(call => [call.id, call.signaled]), [[idempotencyKey(F1, body.request), true]]);
  // 调用都落到终态了：已撤销。
  assert.equal((await h.holder.self['grants.list']()).grants[0].status, 'revoked');
});

test('revoking: the cancel is not queued behind the grant record sync: with the Accord query hung, revoke still returns and the submitted call is canceled', async t => {
  const h = await holderOf(t);
  const { grant } = await h.grant();
  h.exec.plan = () => 'hang';
  const body = send(h, { grant });
  await h.settle();
  assert.equal(h.exec.pending(), 1);
  // 之后的 Accord 查询（撤回记录的同步、扫请求）都挂住。
  const release = h.accord.hold(() => true);
  let done = false;
  h.holder.self['grants.revoke']({ grant }).then(() => { done = true; });
  await until(() => done, 'revoke 返回');
  await until(() => h.answers(F1, body.request).join() === 'running,failed', '已提交的调用收到取消');
  assert.equal(h.accord.held(), true, 'the query is hung');
  release();
  await h.settle();
});

test('revoking a submitted call that may have run: interrupted with unknown effects, saying the command may have run here', async t => {
  const h = await holderOf(t);
  const { grant } = await h.grant();
  h.exec.plan = () => 'hang';
  const body = send(h, { grant });
  await h.settle();
  await h.holder.self['grants.revoke']({ grant });
  await h.settle();
  assert.deepEqual(h.answers(F1, body.request), ['running', 'failed']);
  assert.deepEqual(h.lastAnswer(F1, body.request).body.error, { code: 'interrupted', message: '对方撤销了授权，已中止这次调用；命令可能已经执行，结果不明', effects: 'unknown' });
});

test('an ending found by the re-check cancels the submitted call at once, with the Accord query hung', async t => {
  const h = await holderOf(t);
  const { grant } = await h.grant();
  h.exec.plan = () => 'hang';
  const body = send(h, { grant });
  await h.settle();
  assert.equal(h.exec.pending(), 1);
  // 目标悄悄没了（没有事件），好友表变一下让授权记录全部过一遍：补查发现失效、落盘，撤回卡在目录查询。
  h.targets.remove('rx-1', { quiet: true });
  const release = h.accord.hold(() => true);
  await h.accord.change({ friends: [...FRIENDS, { node: 'n9', author: key('8'), bound: true, machine: key('8'), certified: false }] });
  await until(async () => (await h.store.getGrant(grant)).endedBy === 'target_missing', '补查把失效落盘');
  await until(() => h.accord.held(), '撤回卡在目录查询');
  await until(() => h.exec.pending() === 0, '已提交的调用收到取消');
  assert.equal((await h.store.get(F1, body.request)).canceledBy, 'target_missing');
  release();
  await h.settle();
  // 已发出的调用被中止，拿不到它的结局：记 interrupted、unknown。
  assert.deepEqual(h.answers(F1, body.request), ['running', 'failed']);
  assert.deepEqual([h.lastAnswer(F1, body.request).body.error.code, h.lastAnswer(F1, body.request).body.error.effects], ['interrupted', 'unknown']);
});

test('revoking returns from local state: with the identity read hung, revoke still returns and the submitted call is canceled', async t => {
  const h = await holderOf(t);
  const { grant } = await h.grant();
  h.exec.plan = () => 'hang';
  const body = send(h, { grant });
  await h.settle();
  let open;
  const gate = new Promise(resolve => { open = resolve; }), get = h.accord.get;
  h.accord.get = async () => { await gate; return get(); };
  let returned = null;
  h.holder.self['grants.revoke']({ grant }).then(row => { returned = row; });
  await until(() => returned, 'revoke 返回');
  assert.deepEqual([returned.grant, returned.friend, returned.status], [grant, F1, 'revoking']);
  await until(async () => (await h.store.get(F1, body.request)).canceled === true, '已提交的调用收到取消');
  assert.deepEqual(h.exec.calls.map(call => call.signaled), [true]);
  open();
  await h.settle();
});

test('a cancel that cannot be written is recorded for that call only: the others are still canceled and the rest of the sweep carries on', async t => {
  const disk = { failFor: null, wrapStore: store => ({ ...store, cancel: (caller, request, by) => request === disk.failFor ? Promise.reject(new Error('写不进去')) : store.cancel(caller, request, by) }) };
  const h = await holderOf(t, disk);
  const { grant } = await h.grant();
  h.exec.plan = () => 'hang';
  const [first, second, third] = [send(h, { grant }), send(h, { grant }), send(h, { grant })];
  await h.settle();
  assert.equal(h.exec.pending(), 3);
  disk.failFor = first.request;
  // 机器钥匙读不出：第三条跑完后答不出去，留着等补签。
  await h.accord.change({ machine: null });
  h.exec.release(idempotencyKey(F1, third.request));
  await h.settle();
  assert.equal((await h.store.get(F1, third.request)).state, 'completed');
  await h.holder.self['grants.revoke']({ grant });
  await h.settle();
  assert.equal((await h.store.get(F1, first.request)).canceled, undefined, 'the failing one is left for later');
  assert.equal(h.exec.pending(), 1);
  assert.equal((await h.store.get(F1, second.request)).state, 'failed');
  // 机器钥匙读得出了：这一轮 sweep 里第一条的取消照样写不进去，也不挡着第二、三条的补签。
  await h.accord.change({ machine: MK });
  await h.settle();
  assert.deepEqual(h.answers(F1, third.request), ['running', 'completed']);
  assert.deepEqual(h.answers(F1, second.request), ['running', 'failed']);
  assert.deepEqual(h.answers(F1, first.request), ['running']);
  // 写得进去了：下一轮补上第一条的取消。
  disk.failFor = null;
  await h.settle();
  assert.deepEqual(h.answers(F1, first.request), ['running', 'failed']);
});

// markSubmitted 落盘之后、首次调用之前的空档：`gap.hook` 在那里跑一次。
function submitGap() {
  const gap = { hook: null, wrapStore: store => ({ ...store, markSubmitted: async (...args) => {
    const marked = await store.markSubmitted(...args), hook = gap.hook;
    gap.hook = null;
    await hook?.();
    return marked;
  } }) };
  return gap;
}

// 在 markSubmitted 之后、首次调用之前取消：撤销、授权失效（目标没了）、调用方取消。
const cancelInGap = (h, what, grant, body) => {
  if (what === 'revoked') return h.holder.self['grants.revoke']({ grant });
  if (what === 'ended') { h.targets.remove('rx-1'); return; }
  cancelOf(h, body);
  return h.holder.tick();
};
const GAP_MESSAGE = { revoked: '对方撤销了授权，命令没有启动', ended: '授权的目标记录已不在了，命令没有启动', caller: '调用方取消了这次调用，命令没有启动' };

test('a cancel that lands after the submit is on disk and before the first call: the command never runs, whether the grant was revoked, ended or the caller canceled', async t => {
  for (const what of ['revoked', 'ended', 'caller']) {
    const gap = submitGap();
    const h = await holderOf(t, gap);
    const { grant } = await h.grant();
    let body;
    gap.hook = async () => {
      await cancelInGap(h, what, grant, body);
      await until(async () => (await h.store.get(F1, body.request)).canceled === true, `${what}: 取消落盘`);
    };
    body = send(h, { grant });
    await h.settle();
    assert.equal(h.exec.calls.length, 0, `${what}: the kernel was never called`);
    assert.equal(h.exec.runs, 0, what);
    assert.deepEqual(h.answers(F1, body.request), ['running', 'canceled'], what);
    assert.deepEqual(h.lastAnswer(F1, body.request).body.error, { code: 'canceled', effects: 'none', message: GAP_MESSAGE[what] }, what);
  }
});

test('a cancel before the first call whose terminal state fails to reach the disk is still canceled with no effects when retried', async t => {
  for (const what of ['ended', 'caller']) {
    const gap = submitGap(), disk = { failures: 1 };
    const wrap = gap.wrapStore;
    gap.wrapStore = store => ({ ...wrap(store), finish: (...args) => disk.failures-- > 0 ? Promise.reject(new Error('写不进去')) : store.finish(...args) });
    const h = await holderOf(t, gap);
    const { grant } = await h.grant();
    let body;
    gap.hook = async () => {
      await cancelInGap(h, what, grant, body);
      await until(async () => (await h.store.get(F1, body.request)).canceled === true, `${what}: 取消落盘`);
    };
    body = send(h, { grant });
    await h.settle();
    await h.settle();
    assert.ok(disk.failures < 0, `${what}: the first finish failed and was retried`);
    assert.equal(h.exec.calls.length, 0, `${what}: the kernel was never called`);
    assert.deepEqual(h.answers(F1, body.request), ['running', 'canceled'], what);
    assert.deepEqual(h.lastAnswer(F1, body.request).body.error, { code: 'canceled', effects: 'none', message: GAP_MESSAGE[what] }, what);
  }
});

test('a call that already completed, canceled with the mark on disk before its first finish fails: the retry signs completed and the kernel is called once', async t => {
  const disk = { hook: null, wrapStore: store => ({ ...store, finish: async (...args) => {
    const hook = disk.hook;
    disk.hook = null;
    if (!hook) return store.finish(...args);
    await hook();
    throw new Error('写不进去');
  } }) };
  const h = await holderOf(t, disk);
  const { grant } = await h.grant();
  let body;
  disk.hook = async () => {
    await h.holder.self['grants.revoke']({ grant });
    await until(async () => (await h.store.get(F1, body.request)).canceled === true, '取消落盘');
  };
  body = send(h, { grant });
  await h.settle();
  await h.settle();
  assert.equal(disk.hook, null, 'the first finish failed');
  assert.equal(h.exec.calls.length, 1);
  assert.equal((await h.store.get(F1, body.request)).state, 'completed');
  assert.deepEqual(h.answers(F1, body.request), ['running', 'completed']);
  assert.equal(h.lastAnswer(F1, body.request).body.result.stdout, `ran ${body.input.command}`);
});

test('a cancel while the first call is still being routed, before the kernel has its idempotency key: the kernel is not called again and the command never runs', async t => {
  for (const what of ['revoked', 'caller']) {
    const h = await holderOf(t);
    const { grant } = await h.grant();
    const open = h.exec.holdRouting();
    const body = send(h, { grant });
    await h.holder.tick();
    await until(() => h.exec.calls.length === 1, `${what}: 首次调用在路由`);
    if (what === 'revoked') await h.holder.self['grants.revoke']({ grant }); else cancelOf(h, body);
    await h.settle();
    open();
    await h.settle();
    assert.equal(h.exec.calls.length, 1, `${what}: one call to the kernel on the whole cancel path`);
    assert.equal(h.exec.runs, 0, `${what}: the command never ran`);
    assert.deepEqual(h.answers(F1, body.request), ['running', 'failed'], what);
    const error = h.lastAnswer(F1, body.request).body.error;
    assert.deepEqual([error.code, error.effects], ['interrupted', 'unknown'], what);
    assert.match(error.message, /命令可能已经执行，结果不明/, what);
  }
});

test('after a restart a call that is canceled is not called again, since whether it went out before is unknown: it ends as interrupted with unknown effects', async t => {
  const h = await holderOf(t);
  const { grant } = await h.grant();
  h.exec.plan = () => 'hang';
  const body = send(h, { grant });
  await h.settle();
  assert.equal(h.exec.calls.length, 1);
  h.stop();
  await h.store.revokeGrant(grant);
  await h.store.cancel(F1, body.request, 'revoked');
  const again = await holderOf(t, h);
  await again.settle();
  assert.equal(h.exec.calls.length, 1, 'no second call');
  assert.deepEqual(again.answers(F1, body.request), ['running', 'failed']);
  assert.equal(again.lastAnswer(F1, body.request).body.error.code, 'interrupted');
  assert.equal(again.lastAnswer(F1, body.request).body.error.effects, 'unknown');
});

test('a target deleted under a submitted call and back at once: the call is aborted and ends interrupted with unknown effects, never not_found with none', async t => {
  const h = await holderOf(t);
  const { grant } = await h.grant();
  h.exec.plan = () => 'hang';
  const body = send(h, { grant });
  await h.settle();
  h.targets.remove('rx-1');
  h.targets.set('rx-1');
  await h.settle();
  assert.deepEqual(h.exec.calls.map(call => call.signaled), [true]);
  assert.equal((await h.store.get(F1, body.request)).canceledBy, 'target_missing');
  assert.deepEqual(h.answers(F1, body.request), ['running', 'failed']);
  const error = h.lastAnswer(F1, body.request).body.error;
  assert.deepEqual([error.code, error.effects], ['interrupted', 'unknown']);
  assert.equal(error.message, '授权的目标记录已不在了，已中止这次调用；命令可能已经执行，结果不明');
});

test('an ending that has not reached the disk only blocks new admissions and submissions; the submitted call is canceled once the ending is written', async t => {
  const disk = failingDisk(() => ({}));
  const h = await holderOf(t, disk);
  const { grant } = await h.grant();
  h.exec.plan = () => 'hang';
  const body = send(h, { grant });
  await h.settle();
  assert.equal(h.exec.pending(), 1);
  h.targets.remove('rx-1');
  await h.settle();
  assert.equal(h.holder.pendingEnds(), 1);
  assert.equal((await h.store.getGrant(grant)).revokedAt, undefined, 'not on disk yet');
  assert.equal(h.exec.pending(), 1, 'still running');
  assert.equal((await h.store.get(F1, body.request)).canceled, undefined);
  assert.deepEqual(h.answers(F1, body.request), ['running']);
  disk.failing = false;
  for (const retry of disk.retries.splice(0)) retry();
  await until(async () => (await h.store.getGrant(grant)).revokedAt !== undefined, '失效落盘');
  await h.settle();
  assert.equal((await h.store.get(F1, body.request)).canceledBy, 'target_missing');
  assert.deepEqual(h.answers(F1, body.request), ['running', 'failed']);
  assert.deepEqual([h.lastAnswer(F1, body.request).body.error.code, h.lastAnswer(F1, body.request).body.error.effects], ['interrupted', 'unknown']);
});

test('revoking: a call that ends in its own way before the abort takes effect is recorded as it ended', async t => {
  const hook = { run: null, wrapStore: store => ({ ...store, cancel: async (...args) => { hook.run?.(); hook.run = null; return store.cancel(...args); } }) };
  const h = await holderOf(t, hook);
  const { grant } = await h.grant();
  h.exec.plan = () => 'hang';
  const body = send(h, { grant });
  await h.settle();
  // 取消落盘、中止之前，命令自己失败了：这是这次调用的结局，不是中止。
  hook.run = () => h.exec.jobs.get(idempotencyKey(F1, body.request)).reject(fail('too_many_running', '同时执行太多', 'none'));
  await h.holder.self['grants.revoke']({ grant });
  await h.settle();
  assert.equal(hook.run, null);
  assert.equal(h.exec.calls.length, 1);
  assert.deepEqual(h.answers(F1, body.request), ['running', 'failed']);
  assert.deepEqual(h.lastAnswer(F1, body.request).body.error, { code: 'too_many_running', message: '同时执行太多', effects: 'none' });
});

// ---- 准入的各项拒绝 ----

test('requests are refused when the author is not the grantee, or the audience is public, several or missing; refusals merge by author, reason and minute', async t => {
  const h = await holderOf(t);
  const g1 = (await h.grant(F1)).grant;
  await h.grant(F2);
  const cases = [
    ['F2 uses F1\'s grant', () => send(h, { from: F2, grant: g1 }), 'no_grant', F2],
    ['a stranger', () => send(h, { from: STRANGER, grant: g1 }), 'bad_author', STRANGER],
    ['public', () => send(h, { grant: g1, audience: ['public'] }), 'bad_audience', F1],
    ['several', () => send(h, { grant: g1, audience: [MK, F2] }), 'bad_audience', F1],
    ['missing', () => send(h, { grant: g1, audience: null }), 'bad_audience', F1],
    ['to someone else', () => send(h, { grant: g1, audience: [F2], holder: F2 }), 'bad_audience', F1],
    // 受众须恰好是本机的机器钥匙：写成本机的根也不行。
    ['to my root', () => send(h, { grant: g1, audience: [ME], holder: ME }), 'bad_audience', F1],
    ['to my machine key, written to my root', () => send(h, { grant: g1, audience: [MK], holder: ME }), 'bad_recipient', F1],
  ];
  for (const [what, make, code, friend] of cases) {
    const body = make();
    await h.settle();
    assert.deepEqual(h.answers(body.caller, body.request), [], what);
    if (code) assert.ok((await rejections(h, code)).some(row => row.friend === friend), what);
  }
  assert.equal(h.exec.runs, 0);
  // 同一作者、同一原因、同一分钟合成一行计数。
  send(h, { grant: g1, audience: ['public'] });
  await h.settle();
  const merged = (await rejections(h, 'bad_audience')).filter(row => row.friend === F1);
  assert.deepEqual(merged.map(row => row.count), [6]);
});

test('requests are refused after the machine key changed, when the friend is unbound, and when the target is no longer remote-exec\'s or no longer there', async t => {
  const h = await holderOf(t);
  const old = (await h.grant(F1)).grant;
  // 换了机器钥匙：旧钥匙下的授权停用；新钥匙下给 F1 一条授权，F1 拿旧授权号来请求被拒。
  await h.accord.change({ machine: NEW_MK });
  await h.settle();
  const fresh = (await h.grant(F1)).grant;
  const stale = send(h, { grant: old });
  await h.settle();
  assert.deepEqual(h.answers(F1, stale.request), []);
  assert.equal((await rejections(h, 'machine_changed')).length, 1);
  assert.deepEqual((await h.holder.self['grants.list']()).grants.find(row => row.grant === old).status, 'machine_changed');

  // 好友绑定没了。
  await h.accord.change({ friends: [{ ...FRIENDS[0], bound: false }, FRIENDS[1], FRIENDS[2]] });
  const unbound = send(h, { grant: fresh });
  await h.settle();
  assert.deepEqual(h.answers(F1, unbound.request), []);
  assert.equal((await rejections(h, 'not_friend')).length, 1);
  await h.accord.change({ friends: FRIENDS });

  // 目标的 provider 变了、目标不在了（准入时才发现）。
  h.targets.set('rx-1', { plugin: 'friends' }, { quiet: true });
  // 授权在、请求方是被授权人且仍是好友：签回失败终态，effects none。换了钥匙的旧授权、解了绑的好友照旧不回话（上面）。
  const proxied = send(h, { grant: fresh });
  await h.settle();
  assert.equal(refusedWith(h, proxied), 'target_changed');
  h.targets.remove('rx-1', { quiet: true });
  const missing = send(h, { grant: fresh });
  await h.settle();
  assert.equal(refusedWith(h, missing), 'target_missing');
  assert.deepEqual(await rejections(h, 'target_changed'), [], 'answered, not only recorded');
  assert.equal(h.exec.runs, 0);
});

test('the replay window: its span, how far ahead it may start and its expiry, each at the edge', async t => {
  const h = await holderOf(t);
  const { grant } = await h.grant();
  const now = h.clock.now;
  const cases = [
    [{ createdAt: now, expiresAt: now }, 'window_span'],
    [{ createdAt: now - MINUTE, expiresAt: now + 10 * MINUTE + 1 }, 'window_span'],
    [{ createdAt: now - MINUTE, expiresAt: now + 10 * MINUTE }, null],
    [{ createdAt: now + 2 * MINUTE, expiresAt: now + 3 * MINUTE }, null],
    [{ createdAt: now + 2 * MINUTE + 1, expiresAt: now + 3 * MINUTE }, 'window_future'],
    [{ createdAt: now - 5 * MINUTE, expiresAt: now }, 'window_expired'],
    [{ createdAt: now - 5 * MINUTE, expiresAt: now + 1 }, null],
  ];
  for (const [times, code] of cases) {
    const body = send(h, { grant, ...times });
    await h.settle();
    assert.deepEqual(h.answers(F1, body.request), code ? [] : ['running', 'completed'], JSON.stringify(times));
  }
  assert.deepEqual((await rejections(h)).map(row => [row.code, row.count]).sort(), [['window_expired', 1], ['window_future', 1], ['window_span', 2]]);
});

test('the same request id with another digest is refused and the existing outcome is left as it is', async t => {
  const h = await holderOf(t);
  const { grant } = await h.grant();
  const body = send(h, { grant, input: { command: 'echo first' } });
  await h.settle();
  assert.deepEqual(h.answers(F1, body.request), ['running', 'completed']);
  const outcome = h.lastAnswer(F1, body.request);
  send(h, { grant, request: body.request, input: { command: 'rm -rf /' } });
  await h.settle();
  assert.deepEqual(h.answers(F1, body.request), ['running', 'completed']);
  assert.deepEqual(h.lastAnswer(F1, body.request), outcome);
  assert.equal(h.exec.runs, 1);
  assert.equal((await rejections(h, 'digest_conflict')).length, 1);
});

test('admission pauses while the clock has gone back by five minutes or more, and resumes when it catches up; the largest time seen is kept on disk', async t => {
  const h = await holderOf(t);
  const { grant } = await h.grant();
  await h.settle();
  assert.equal(JSON.parse(await readFile(join(h.dir, 'rpc', 'clock.json'), 'utf8')).maxSeen, START);
  h.clock.now = START - 5 * MINUTE;
  const body = send(h, { grant, createdAt: h.clock.now, expiresAt: START + MINUTE });
  await h.settle();
  assert.deepEqual(h.answers(F1, body.request), []);
  assert.equal((await h.holder.self['grants.list']()).admitting, false);
  // 重启后照样记得：见过的最大时刻在盘上。
  h.stop();
  const again = await holderOf(t, h);
  await again.settle();
  assert.deepEqual(again.answers(F1, body.request), []);
  again.clock.now = START + 1;
  await again.settle();
  assert.deepEqual(again.answers(F1, body.request), ['running', 'completed']);
  assert.equal(h.exec.runs, 1);
});

test('an I/O error reading clock.json is not taken as no baseline: no new request is admitted until the old baseline is read', async t => {
  const h = await holderOf(t);
  const { grant } = await h.grant();
  await h.settle();
  h.stop();
  // 时钟在停机期间回拨了，重启时读 clock.json 又出 I/O 错误。
  h.clock.now = START - 5 * MINUTE;
  const disk = { failing: true };
  const again = await holderOf(t, { ...h, wrapStore: store => ({ ...store,
    readClock: () => disk.failing ? Promise.reject(Object.assign(new Error('读不出'), { code: 'EIO' })) : store.readClock() }) });
  const body = send(again, { grant, createdAt: again.clock.now, expiresAt: START + MINUTE });
  await again.settle();
  assert.deepEqual(again.answers(F1, body.request), []);
  assert.equal((await again.holder.self['grants.list']()).admitting, false);
  assert.equal(JSON.parse(await readFile(join(h.dir, 'rpc', 'clock.json'), 'utf8')).maxSeen, START);
  // 读得出了：读到旧基准，回拨照样暂停；时钟赶上后准入。
  disk.failing = false;
  await again.settle();
  assert.deepEqual(again.answers(F1, body.request), []);
  again.clock.now = START + 1;
  await again.settle();
  assert.deepEqual(again.answers(F1, body.request), ['running', 'completed']);
});

test('while clock.json cannot be read on restart, an old admitted request is not started and an old submitted one is not called again; once it can be read the admitted one carries on and the ended one stays ended', async t => {
  const h = await holderOf(t);
  const { grant } = await h.grant();
  h.exec.plan = () => 'hang';
  const busy = Array.from({ length: LIMITS.executing.author }, () => send(h, { grant }));
  await h.settle();
  const waiting = send(h, { grant });
  await h.settle();
  assert.equal((await h.store.get(F1, waiting.request)).state, 'admitted');
  assert.equal((await h.store.get(F1, busy[0].request)).state, 'submitted');
  h.stop();
  // 内核忘了原来的幂等键：再调就会当新调用执行。
  h.exec.forget();
  h.exec.plan = input => ({ exitCode: 0, signal: null, stdout: `ran ${input.command}`, stderr: '', timedOut: false, truncated: false, outputDir: null, ms: 7 });
  const calls = h.exec.calls.length, runs = h.exec.runs;
  const disk = { failing: true };
  const again = await holderOf(t, { ...h, wrapStore: store => ({ ...store,
    readClock: () => disk.failing ? Promise.reject(Object.assign(new Error('读不出'), { code: 'EIO' })) : store.readClock() }) });
  await again.settle();
  assert.deepEqual([h.exec.calls.length - calls, h.exec.runs - runs], [0, 0]);
  assert.equal((await again.store.get(F1, waiting.request)).state, 'admitted');
  for (const one of busy) {
    assert.deepEqual(again.answers(F1, one.request), ['running', 'failed']);
    assert.deepEqual([again.lastAnswer(F1, one.request).body.error.code, again.lastAnswer(F1, one.request).body.error.effects], ['interrupted', 'unknown']);
  }
  disk.failing = false;
  await again.settle();
  assert.deepEqual(h.exec.calls.slice(calls).map(call => call.id), [idempotencyKey(F1, waiting.request)]);
  assert.equal(again.lastAnswer(F1, waiting.request).body.state, 'completed');
  for (const one of busy) assert.deepEqual(again.answers(F1, one.request), ['running', 'failed']);
});

test('while the clock high-water mark cannot be written, a cancel of a running call still aborts it and its outcome goes out; new requests wait until the write succeeds', async t => {
  const disk = { failing: false }, errors = [];
  const h = await holderOf(t, { onMaintenanceError: e => errors.push(e.code), wrapStore: store => ({ ...store,
    writeClock: at => disk.failing ? Promise.reject(new Error('写不进去')) : store.writeClock(at) }) });
  const { grant } = await h.grant();
  h.exec.plan = () => 'hang';
  const body = send(h, { grant });
  await h.settle();
  assert.equal(h.exec.pending(), 1);
  disk.failing = true;
  h.clock.now = START + MINUTE;
  const fresh = send(h, { grant, expiresAt: START + 10 * MINUTE });
  await h.settle();
  assert.ok(errors.length > 0 && errors.every(code => code === 'clock_maintenance'));
  assert.equal((await h.holder.self['grants.list']()).admitting, false);
  assert.deepEqual(h.answers(F1, fresh.request), []);
  cancelOf(h, body);
  await h.settle();
  assert.equal(h.exec.pending(), 0, 'aborted');
  assert.deepEqual(h.answers(F1, body.request), ['running', 'failed']);
  assert.equal(h.lastAnswer(F1, body.request).body.error.code, 'interrupted');
  assert.deepEqual(h.answers(F1, fresh.request), []);
  disk.failing = false;
  h.exec.plan = input => ({ exitCode: 0, signal: null, stdout: `ran ${input.command}`, stderr: '', timedOut: false, truncated: false, outputDir: null, ms: 7 });
  await h.settle();
  assert.equal((await h.holder.self['grants.list']()).admitting, true);
  assert.deepEqual(h.answers(F1, fresh.request), ['running', 'completed']);
});

test('a failed write of the clock high-water mark is written again on the next round', async t => {
  const disk = { failures: 1, writes: 0 };
  const h = await holderOf(t, { wrapStore: store => ({ ...store,
    writeClock: at => { disk.writes++; return disk.failures-- > 0 ? Promise.reject(new Error('写不进去')) : store.writeClock(at); } }) });
  await h.grant();
  await h.holder.tick();
  assert.equal(disk.writes, 1);
  await h.holder.tick();
  assert.equal(disk.writes, 2);
  assert.equal(JSON.parse(await readFile(join(h.dir, 'rpc', 'clock.json'), 'utf8')).maxSeen, START);
});

test('an invalid clock.json only pauses admission and is read again every round: once it is fixed, the next round answers a valid request', async t => {
  const h = await holderOf(t);
  const { grant } = await h.grant();
  await h.settle();
  h.stop();
  const file = join(h.dir, 'rpc', 'clock.json');
  await writeFile(file, '{ broken');
  const again = await holderOf(t, h);
  const body = send(again, { grant });
  await again.settle();
  assert.deepEqual(again.answers(F1, body.request), []);
  assert.deepEqual([(await again.holder.self['grants.list']()).admitting, (await again.holder.self['grants.list']()).corrupt], [false, null]);
  await writeFile(file, `${JSON.stringify({ v: 1, maxSeen: START })}\n`);
  await again.settle();
  assert.deepEqual(again.answers(F1, body.request), ['running', 'completed']);
});

test('after a failed write of the clock high-water mark, the next round writes it again even when the wall clock stepped back a little', async t => {
  const disk = { failing: false };
  const h = await holderOf(t, { wrapStore: store => ({ ...store,
    writeClock: at => disk.failing ? Promise.reject(new Error('写不进去')) : store.writeClock(at) }) });
  await h.grant();
  await h.settle();
  const stored = async () => JSON.parse(await readFile(join(h.dir, 'rpc', 'clock.json'), 'utf8')).maxSeen;
  assert.equal(await stored(), START);
  h.clock.now = START + MINUTE;
  disk.failing = true;
  await h.holder.tick();
  disk.failing = false;
  h.clock.now = START + MINUTE - 1_000;
  await h.holder.tick();
  assert.equal(await stored(), START + MINUTE);
});

test('over the in-flight quota a request is refused as busy and the refusals are counted', async t => {
  const h = await holderOf(t);
  const { grant } = await h.grant();
  h.exec.plan = () => 'hang';
  const bodies = Array.from({ length: LIMITS.inflight.author }, () => send(h, { grant }));
  await h.settle();
  const over = [send(h, { grant }), send(h, { grant })];
  await h.settle();
  for (const one of over) assert.deepEqual(h.answers(F1, one.request), []);
  assert.deepEqual((await rejections(h, 'busy')).map(row => row.count), [2]);
  assert.equal(h.exec.runs, LIMITS.executing.author);
  await h.exec.releaseAll(h.settle);
  for (const one of bodies) assert.deepEqual(h.answers(F1, one.request), ['running', 'completed']);
});

// ---- 取消 ----

test('cancel: before the request arrives, after it was admitted but not started, and after it started', async t => {
  const h = await holderOf(t);
  const { grant } = await h.grant();
  // 取消先到：只见到取消版本，留下标记，答 canceled、效果 none，不执行。
  const first = send(h, { grant, cancel: h.clock.now });
  await h.settle();
  assert.deepEqual(h.answers(F1, first.request), ['canceled']);
  assert.deepEqual(h.lastAnswer(F1, first.request).body.error, { code: 'canceled', message: '调用方取消了这次调用，命令没有启动', effects: 'none' });
  assert.equal((await h.store.get(F1, first.request)).canceled, true);
  assert.equal(h.exec.runs, 0);

  // 已准入、还没启动（同时执行的名额满了）。
  h.exec.plan = () => 'hang';
  const busy = Array.from({ length: LIMITS.executing.author }, () => send(h, { grant }));
  await h.settle();
  const waiting = send(h, { grant });
  await h.settle();
  assert.equal(h.exec.runs, 4);
  assert.equal((await h.store.get(F1, waiting.request)).state, 'admitted');
  cancelOf(h, waiting);
  await h.settle();
  assert.deepEqual(h.answers(F1, waiting.request), ['running', 'canceled']);
  assert.equal(h.lastAnswer(F1, waiting.request).body.error.effects, 'none');

  // 已启动：中止那次调用，拿不到它的结局，记 interrupted、unknown。
  cancelOf(h, busy[0]);
  await h.settle();
  assert.deepEqual(h.answers(F1, busy[0].request), ['running', 'failed']);
  assert.deepEqual(h.lastAnswer(F1, busy[0].request).body.error, { code: 'interrupted', message: '调用方取消了这次调用，已中止；命令可能已经执行，结果不明', effects: 'unknown' });
  // 名额空出来以后，标了取消的那个也不再启动。
  for (const one of busy.slice(1)) h.exec.release(idempotencyKey(F1, one.request));
  await h.settle();
  assert.equal(h.exec.runs, 4);
  // 请求从目录里不见了不算取消。
  h.exec.plan = () => 'hang';
  const gone = send(h, { grant });
  await h.settle();
  h.accord.records = h.accord.records.filter(record => record.id !== gone.request);
  await h.settle();
  h.exec.release(idempotencyKey(F1, gone.request));
  await h.settle();
  assert.deepEqual(h.answers(F1, gone.request), ['running', 'completed']);
});

// ---- 恢复 ----

test('a crash after submitting and before answering: on restart the same idempotency key fetches the outcome, it is signed, and the command ran once', async t => {
  const h = await holderOf(t);
  const { grant } = await h.grant();
  h.exec.plan = () => 'hang';
  const body = send(h, { grant });
  await h.settle();
  assert.equal((await h.store.get(F1, body.request)).state, 'submitted');
  // 崩了：这个实例不再落盘、不再签；命令在内核那边照样跑完。
  h.stop();
  h.exec.release(idempotencyKey(F1, body.request));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(h.answers(F1, body.request), ['running']);
  const again = await holderOf(t, h);
  await again.settle();
  assert.deepEqual(again.answers(F1, body.request), ['running', 'completed']);
  assert.equal(h.exec.runs, 1, 'executed once');
  assert.deepEqual(h.exec.calls.map(call => call.id), [idempotencyKey(F1, body.request), idempotencyKey(F1, body.request)]);
  // 终态不回退：之后再看到这条请求、再重启，都不会再签 running、也不再执行。
  h.accord.inject({ author: F1, kind: 'friends/rpc-call', id: body.request, body, audience: [MK] });
  await again.settle();
  again.stop();
  const third = await holderOf(t, h);
  await third.settle();
  assert.deepEqual(third.answers(F1, body.request), ['running', 'completed']);
  assert.equal(h.exec.runs, 1);
});

test('on restart an admitted request that is past its latest start is answered failed and never started', async t => {
  const h = await holderOf(t);
  const { grant } = await h.grant();
  h.exec.plan = () => 'hang';
  const busy = Array.from({ length: LIMITS.executing.author }, () => send(h, { grant }));
  await h.settle();
  const waiting = send(h, { grant, expiresAt: h.clock.now + MINUTE });
  await h.settle();
  assert.equal((await h.store.get(F1, waiting.request)).state, 'admitted');
  h.stop();
  h.clock.now += 2 * MINUTE;
  for (const one of busy) h.exec.release(idempotencyKey(F1, one.request));
  const again = await holderOf(t, h);
  await again.settle();
  assert.deepEqual(again.answers(F1, waiting.request), ['running', 'failed']);
  assert.deepEqual([again.lastAnswer(F1, waiting.request).body.error.code, again.lastAnswer(F1, waiting.request).body.error.effects], ['expired', 'none']);
  assert.equal(h.exec.runs, 4);
});

test('a corrupt in-flight table stops admission instead of carrying on with an empty table, and grants.list says so', async t => {
  const h = await holderOf(t);
  const { grant } = await h.grant();
  h.stop();
  await mkdir(join(h.dir, 'rpc'), { recursive: true });
  await writeFile(join(h.dir, 'rpc', 'inflight.json'), '{ not json');
  const again = await holderOf(t, h);
  const body = send(again, { grant });
  await again.settle();
  assert.deepEqual(again.answers(F1, body.request), []);
  assert.equal(h.exec.runs, 0);
  assert.equal(await readFile(join(h.dir, 'rpc', 'inflight.json'), 'utf8'), '{ not json', 'left as it was');
  const listed = await again.holder.self['grants.list']();
  assert.deepEqual([listed.admitting, listed.corrupt], [false, 'inflight.json']);
});

// ---- 清理 ----

test('an outcome answer is withdrawn 24 hours after the terminal state, not before', async t => {
  const h = await holderOf(t);
  const { grant } = await h.grant();
  const body = send(h, { grant });
  await h.settle();
  assert.deepEqual(h.answers(F1, body.request), ['running', 'completed']);
  h.clock.now = START + ANSWER_KEEP_MS - 1;
  await h.settle();
  assert.deepEqual(h.answers(F1, body.request), ['running', 'completed']);
  h.clock.now = START + ANSWER_KEEP_MS;
  await h.settle();
  assert.deepEqual(h.answers(F1, body.request), ['running', 'completed', 'retracted']);
  assert.deepEqual(h.accord.calls.at(-1), { kind: 'friends/rpc-answer', id: answerId(F1, body.request), body: {}, audience: [], signer: 'machine', expectAuthor: MK });
  assert.equal((await h.store.get(F1, body.request)).retracted, true);
  await h.settle();
  assert.equal(h.answers(F1, body.request).length, 3);
  // 再过一天清出在途表。
  h.clock.now += ANSWER_KEEP_MS;
  await h.settle();
  assert.equal(await h.store.get(F1, body.request), null);
});

test('a full table whose only clearable row is an answer still to withdraw refuses the new request without running it; after the sweep withdraws that answer the next request runs', async t => {
  const h = await holderOf(t);
  const { grant } = await h.grant();
  const body = send(h, { grant });
  await h.settle();
  // 其余的行都还没过期（仍承担去重），只有这条到了撤回时刻、还没撤的能腾出位置。
  const file = join(h.dir, 'rpc', 'inflight.json'), table = JSON.parse(await readFile(file, 'utf8')), [real] = Object.values(table.entries);
  for (let i = 0; i < LIMITS.table - 1; i++) {
    const request = `filler-${i}`;
    table.entries[`${F2}/${request}`] = { ...real, caller: F2, request, key: `friend:${request}`, notAfter: START + 2 * ANSWER_KEEP_MS, retracted: true };
  }
  await writeFile(file, JSON.stringify(table));
  assert.equal(Object.keys(JSON.parse(await readFile(file, 'utf8')).entries).length, LIMITS.table);
  h.clock.now = START + ANSWER_KEEP_MS;
  // 同一拍里先扫新请求、再扫待撤的回答：新请求被拒，命令不执行，那条回答随后撤回。
  const refused = send(h, { grant });
  await h.settle();
  assert.deepEqual(h.answers(F1, refused.request), []);
  assert.equal(h.exec.runs, 1);
  assert.equal((await rejections(h, 'table_full'))[0].count, 1);
  assert.deepEqual(h.answers(F1, body.request), ['running', 'completed', 'retracted']);
  assert.equal((await h.store.get(F1, body.request)).retracted, true, 'the row stayed until the answer was withdrawn');
  const next = send(h, { grant });
  await h.settle();
  assert.deepEqual(h.answers(F1, next.request), ['running', 'completed']);
  assert.equal(h.exec.runs, 2);
  assert.equal(await h.store.get(F1, body.request), null, 'the withdrawn row made room');
});

test('an answer due for withdrawal while the machine key cannot be read stays pending, and is withdrawn exactly once when the key is back', async t => {
  const h = await holderOf(t);
  const { grant } = await h.grant();
  const body = send(h, { grant });
  await h.settle();
  const retractions = () => h.accord.calls.filter(call => call.kind === 'friends/rpc-answer' && call.id === answerId(F1, body.request) && !call.audience.length).length;
  await h.accord.change({ machine: null });
  h.clock.now = START + ANSWER_KEEP_MS;
  await h.settle();
  await h.settle();
  assert.equal(retractions(), 0);
  assert.equal((await h.store.get(F1, body.request)).retracted, undefined);
  await h.accord.change({ machine: MK });
  await h.settle();
  await h.settle();
  assert.equal(retractions(), 1);
  assert.equal((await h.store.get(F1, body.request)).retracted, true);
});

// ---- 证书 ----

test('while the machine key cannot be read nothing is sent; once it can, the outcome already reached is sent, not running again', async t => {
  const h = await holderOf(t);
  const { grant } = await h.grant();
  const sent = h.accord.calls.length;
  await h.accord.change({ machine: null });
  const late = send(h, { grant, holder: MK, audience: [MK] });
  await h.settle();
  assert.equal(h.accord.calls.length, sent);
  assert.equal(h.exec.runs, 0, 'not admitted without the machine key');
  await h.accord.change({ machine: MK });
  await h.settle();
  assert.deepEqual(h.answers(F1, late.request), ['running', 'completed']);

  h.exec.plan = () => 'hang';
  const body = send(h, { grant });
  await h.settle();
  await h.accord.change({ machine: null });
  h.exec.release(idempotencyKey(F1, body.request));
  await h.settle();
  assert.deepEqual(h.answers(F1, body.request), ['running']);
  assert.equal((await h.store.get(F1, body.request)).state, 'completed');
  await h.accord.change({ machine: MK });
  await h.settle();
  assert.deepEqual(h.answers(F1, body.request), ['running', 'completed']);
});

test('a holder bound to a personal identity whose certificate has expired still takes requests, runs them, answers and withdraws its answers, all signed with its machine key', async t => {
  const h = await holderOf(t, { accordOptions: { certificate: EXPIRED } });
  const { grant } = await h.grant();
  assert.equal((await h.holder.self['grants.list']()).grants[0].status, 'available');
  const body = send(h, { grant });
  assert.equal(body.holder, MK);
  await h.settle();
  assert.equal(h.exec.runs, 1);
  assert.deepEqual(h.answers(F1, body.request), ['running', 'completed']);
  for (const call of h.accord.calls) assert.deepEqual([call.signer, call.expectAuthor], ['machine', MK], call.kind);
  const answer = h.lastAnswer(F1, body.request);
  assert.deepEqual([answer.body.holder, answer.audience, answer.body.result.stdout], [MK, [F1], `ran ${body.input.command}`]);
  assert.equal(h.accord.records.find(record => record.id === answer.id).author, MK, 'the answer\'s author is the machine key');
  // 24 小时后照撤回答，证书仍过期。
  h.clock.now = START + ANSWER_KEEP_MS;
  await h.settle();
  assert.deepEqual(h.answers(F1, body.request), ['running', 'completed', 'retracted']);
  assert.deepEqual(await rejections(h), []);
});

// ---- 操作记录 ----

test('the ledger has one row per outcome with a summary and a hash of the command, and one counted row per merged refusal', async t => {
  const h = await holderOf(t);
  const { grant } = await h.grant();
  const long = `echo ${'x'.repeat(200)}`;
  const done = send(h, { grant, input: { command: long, cwd: '/secret', stdin: 'password' } });
  await h.settle();
  h.exec.plan = () => fail('too_many_running', '满了', 'none');
  const failed = send(h, { grant });
  await h.settle();
  const canceled = send(h, { grant, cancel: h.clock.now });
  send(h, { grant, audience: ['public'] });
  send(h, { grant, audience: ['public'] });
  await h.settle();
  const rows = await h.ledger();
  const byRequest = request => rows.filter(row => row.request === request);
  assert.equal(byRequest(done.request).length, 1);
  const [row] = byRequest(done.request);
  assert.ok(Number.isSafeInteger(row.ms) && row.ms >= 0);
  assert.deepEqual(row, { v: 1, at: START, request: done.request, friend: F1, grant, target: { kind: MACHINE, id: 'rx-1', name: 'box' }, op: 'exec',
    command: commandInfo(long), outcome: 'completed', exitCode: 0, ms: row.ms });
  assert.deepEqual([byRequest(failed.request)[0].outcome, byRequest(failed.request)[0].code], ['failed', 'too_many_running']);
  assert.deepEqual([byRequest(canceled.request)[0].outcome, byRequest(canceled.request)[0].code], ['canceled', 'canceled']);
  const text = await readFile(join(h.dir, 'rpc', 'ledger-2026-11.jsonl'), 'utf8');
  assert.equal(text.includes('/secret') || text.includes('password'), false);
  assert.deepEqual((await rejections(h)).map(row => [row.friend, row.code, row.count]), [[F1, 'bad_audience', 2]]);
});

// ---- 撤回入口 ----

test('the internal retraction only withdraws this machine\'s own grant record, with the machine key whatever the certificate; a request needs the author and its certificate', async t => {
  const h = await holderOf(t);
  const { grant } = await h.grant();
  const refused = (input, code) => assert.rejects(h.gateway.retractRpc(input), error => error.code === code && error.effects === 'none');
  await refused({ kind: 'friends/dm', id: grant, author: MK }, 'invalid_input');
  await refused({ kind: 'friends/rpc-grant', id: grant, author: 'me' }, 'invalid_input');
  await refused({ kind: 'friends/rpc-grant', id: grant, author: NEW_ROOT }, 'invalid_state');
  // 授权记录只署机器钥匙：写成本机的根也不撤。
  await refused({ kind: 'friends/rpc-grant', id: grant, author: ME }, 'invalid_state');
  const calls = h.accord.calls.length;
  // 本机没署过的：不生成墓碑。
  h.accord.inject({ author: F1, kind: 'friends/rpc-grant', id: 'theirs', body: { x: 1 }, audience: [MK] });
  assert.deepEqual(await h.gateway.retractRpc({ kind: 'friends/rpc-grant', id: 'theirs', author: MK }), { state: 'absent' });
  assert.equal(h.accord.calls.length, calls);
  // 证书过期：请求撤不了，授权记录照撤。
  await h.accord.change({ certificate: EXPIRED });
  await refused({ kind: 'friends/rpc-call', id: 'c1', author: ME }, 'invalid_state');
  assert.equal((await h.gateway.retractRpc({ kind: 'friends/rpc-grant', id: grant, author: MK })).state, 'retracted');
  assert.deepEqual(h.accord.calls.at(-1), { kind: 'friends/rpc-grant', id: grant, body: {}, audience: [], signer: 'machine', expectAuthor: MK });
});

// ---- 评审的几种交错 ----

test('the check before submitting reads the latest grant and the clock in the same store step: a revoke during a slow target lookup, or a lookup past the latest start, never starts the command', async t => {
  const h = await holderOf(t);
  const { grant } = await h.grant();
  // 准入时查一次目标（放过），提交前那一次挂住；挂着的时候撤权。
  const release = h.targets.hold(1);
  const body = send(h, { grant });
  await h.holder.tick();
  await until(() => h.targets.waiting(), '提交前的目标查询挂住');
  const revoking = h.holder.self['grants.revoke']({ grant });
  await until(async () => (await h.store.getGrant(grant)).revokedAt !== undefined, '撤权落盘');
  release();
  await revoking;
  await h.settle();
  assert.equal(h.exec.runs, 0);
  assert.deepEqual(h.answers(F1, body.request), ['running', 'failed']);
  assert.deepEqual([h.lastAnswer(F1, body.request).body.error.code, h.lastAnswer(F1, body.request).body.error.effects], ['revoked', 'none']);

  // 目标查询慢到跨过最晚启动时刻。
  const second = (await h.grant()).grant, slow = h.targets.hold(1);
  const late = send(h, { grant: second, expiresAt: h.clock.now + MINUTE });
  await h.holder.tick();
  await until(() => h.targets.waiting(), '提交前的目标查询挂住');
  h.clock.now += MINUTE;
  slow();
  await h.settle();
  assert.equal(h.exec.runs, 0);
  // 过了最晚启动时刻的不再签 running，直接答失败。
  assert.deepEqual(h.answers(F1, late.request), ['failed']);
  assert.equal(h.lastAnswer(F1, late.request).body.error.code, 'expired');
});

test('a grant record\'s publishes and retractions share one queue that reads the latest row: revoking while the first publish waits on the directory never publishes it, and a later availability change does not undo the retraction', async t => {
  const h = await holderOf(t);
  const release = h.accord.hold(input => input.kind === 'friends/rpc-grant');
  const granting = h.grant();
  await until(() => h.accord.held(), '初次发布卡在目录查询');
  const [row] = await h.store.listGrants();
  const revoking = h.holder.self['grants.revoke']({ grant: row.id });
  await until(async () => (await h.store.getGrant(row.id)).revokedAt !== undefined, '撤权落盘');
  release();
  await Promise.all([granting, revoking]);
  await h.settle();
  assert.deepEqual(h.published('friends/rpc-grant').filter(call => call.audience.length), [], 'the revoked grant was never published');
  assert.notEqual((await h.store.getGrant(row.id)).retractedAt, undefined);

  // 发出去以后撤了的：available 再变，也不会盖掉撤回。
  const { grant } = await h.grant();
  // 撤回在后台同步：用查询闸门把顺序固定下来，撤回签出之后才断言它的内容。
  const gate = h.accord.hold(() => true);
  await h.holder.self['grants.revoke']({ grant });
  await until(() => h.accord.held(), '撤回卡在目录查询');
  assert.equal((await h.store.getGrant(grant)).retractedAt, undefined, 'not retracted yet');
  gate();
  await until(async () => (await h.store.getGrant(grant)).retractedAt !== undefined, '撤回签出');
  assert.deepEqual(h.accord.calls.at(-1), { kind: 'friends/rpc-grant', id: grant, body: {}, audience: [], signer: 'machine', expectAuthor: MK });
  // 可用性变化前先记下发布次数。
  const calls = h.accord.calls.length;
  h.targets.set('rx-1', { status: { available: false } });
  await h.settle();
  assert.equal(h.accord.calls.length, calls);
});

test('a machine key change ends a grant for good, written at once; the retraction waits for the original key: A to B and back to A, the grant stays ended', async t => {
  const h = await holderOf(t);
  const { grant } = await h.grant();
  await h.accord.change({ machine: NEW_MK });
  await h.settle();
  const ended = await h.store.getGrant(grant);
  assert.deepEqual([ended.endedBy, ended.retractedAt], ['machine_changed', undefined]);
  assert.equal(h.accord.calls.filter(call => call.id === grant).length, 1, 'the new key does not sign for the old one');
  await h.accord.change({ machine: MK });
  await h.settle();
  assert.deepEqual(h.accord.calls.at(-1), { kind: 'friends/rpc-grant', id: grant, body: {}, audience: [], signer: 'machine', expectAuthor: MK });
  assert.notEqual((await h.store.getGrant(grant)).retractedAt, undefined);
  assert.equal((await h.holder.self['grants.list']()).grants[0].status, 'machine_changed');
  // 回到授权时那把钥匙：授权已停用，签回失败终态。
  const body = send(h, { grant });
  await h.settle();
  assert.equal(refusedWith(h, body), 'machine_changed');
  assert.equal(h.exec.runs, 0);
});

test('a target deleted while the machine key cannot be read ends the grant at once; rebuilt under the same id it does not revive it', async t => {
  const h = await holderOf(t);
  const { grant } = await h.grant();
  await h.accord.change({ machine: null });
  h.targets.remove('rx-1');
  await h.settle();
  h.targets.set('rx-1');
  await h.settle();
  const ended = await h.store.getGrant(grant);
  assert.deepEqual([ended.endedBy, ended.retractedAt], ['target_missing', undefined]);
  await h.accord.change({ machine: MK });
  await h.settle();
  assert.deepEqual(h.accord.calls.at(-1), { kind: 'friends/rpc-grant', id: grant, body: {}, audience: [], signer: 'machine', expectAuthor: MK });
  const body = send(h, { grant });
  await h.settle();
  assert.equal(h.exec.runs, 0);
  assert.equal(refusedWith(h, body), 'target_missing');
});

test('while admission is paused for the clock, a newer cancel of a known request still aborts the running call', async t => {
  const h = await holderOf(t);
  const { grant } = await h.grant();
  h.exec.plan = () => 'hang';
  const body = send(h, { grant });
  await h.settle();
  // 同一版本再看到、或同号的旧内容：不算取消。
  h.accord.inject({ author: F1, kind: 'friends/rpc-call', id: body.request, body, audience: [MK] });
  h.clock.now = START - 5 * MINUTE;
  await h.settle();
  assert.equal((await h.holder.self['grants.list']()).admitting, false);
  assert.equal(h.exec.pending(), 1, 'still running');
  cancelOf(h, body);
  await h.settle();
  assert.equal(h.exec.pending(), 0, 'aborted');
  assert.equal((await h.store.get(F1, body.request)).state, 'failed');
  assert.deepEqual(h.answers(F1, body.request), ['running', 'failed']);
  assert.equal(h.lastAnswer(F1, body.request).body.error.code, 'interrupted');
});

test('an outcome that could not be signed is kept past its expiry plus 24 hours and signed when the machine key can be read again', async t => {
  const h = await holderOf(t);
  const { grant } = await h.grant();
  h.exec.plan = () => 'hang';
  const body = send(h, { grant });
  await h.settle();
  await h.accord.change({ machine: null });
  h.exec.release(idempotencyKey(F1, body.request));
  await h.settle();
  h.clock.now = body.expiresAt + ANSWER_KEEP_MS + 60 * MINUTE;
  await h.settle();
  assert.equal((await h.store.get(F1, body.request))?.state, 'completed');
  await h.accord.change({ machine: MK });
  await h.settle();
  // 补签出结局；这时已过终态 24 小时，随后照规则撤回。
  assert.deepEqual(h.answers(F1, body.request), ['running', 'completed', 'retracted']);
});

test('after a shutdown across the expiry plus 24 hours a submitted request is still there on restart and ends interrupted without calling the kernel again', async t => {
  const h = await holderOf(t);
  const { grant } = await h.grant();
  h.exec.plan = () => 'hang';
  const body = send(h, { grant });
  await h.settle();
  h.stop();
  h.clock.now = body.expiresAt + 2 * ANSWER_KEEP_MS;
  h.exec.release(idempotencyKey(F1, body.request));
  const again = await holderOf(t, h);
  await again.settle();
  assert.deepEqual(again.answers(F1, body.request), ['running', 'failed']);
  assert.deepEqual([again.lastAnswer(F1, body.request).body.error.code, again.lastAnswer(F1, body.request).body.error.effects], ['interrupted', 'unknown']);
  assert.equal(h.exec.calls.length, 1);
});

test('a stop after submitted is on disk and before the first call: past the latest start the restart never calls the kernel and ends interrupted with unknown effects; within it the same key carries on', async t => {
  for (const late of [true, false]) {
    // 首次调用之前停住：markSubmitted 落了盘，之后一直挂着，命令没发到内核。
    const gap = submitGap();
    const h = await holderOf(t, gap);
    const { grant } = await h.grant();
    gap.hook = () => new Promise(() => {});
    const body = send(h, { grant });
    await h.holder.tick();
    await until(async () => (await h.store.get(F1, body.request))?.state === 'submitted', 'submitted 落盘');
    h.stop();
    if (late) h.clock.now = body.expiresAt;
    const again = await holderOf(t, h);
    await again.settle();
    if (late) {
      assert.equal(h.exec.calls.length, 0, 'the kernel was never called');
      assert.deepEqual(again.answers(F1, body.request), ['running', 'failed']);
      assert.deepEqual([again.lastAnswer(F1, body.request).body.error.code, again.lastAnswer(F1, body.request).body.error.effects], ['interrupted', 'unknown']);
    } else {
      assert.deepEqual(h.exec.calls.map(call => call.id), [idempotencyKey(F1, body.request)]);
      assert.deepEqual(again.answers(F1, body.request), ['running', 'completed']);
    }
  }
});

test('a submitted call whose key the kernel has forgotten (disabled past its retention) is not run again on restart: it ends interrupted with unknown effects', async t => {
  const h = await holderOf(t);
  const { grant } = await h.grant();
  h.exec.plan = () => 'hang';
  const body = send(h, { grant });
  await h.settle();
  h.stop();
  h.exec.release(idempotencyKey(F1, body.request));
  h.exec.forget();
  h.clock.now += 8 * 24 * 60 * MINUTE;
  const again = await holderOf(t, h);
  await again.settle();
  assert.equal(h.exec.runs, 1, 'not run again');
  assert.equal(h.exec.calls.length, 1);
  assert.deepEqual(again.answers(F1, body.request), ['running', 'failed']);
  assert.deepEqual([again.lastAnswer(F1, body.request).body.error.code, again.lastAnswer(F1, body.request).body.error.effects], ['interrupted', 'unknown']);
});

test('a known request whose caller is no longer bound is not driven into the kernel on restart, even within its window: it ends interrupted with unknown effects', async t => {
  const h = await holderOf(t);
  const { grant } = await h.grant();
  h.exec.plan = () => 'hang';
  const body = send(h, { grant });
  await h.settle();
  h.stop();
  h.accord.friends = FRIENDS.map(friend => friend.author === F1 ? { ...friend, bound: false } : friend);
  const again = await holderOf(t, h);
  await again.settle();
  assert.equal(h.exec.calls.length, 1, 'the kernel is not called again');
  assert.deepEqual(again.answers(F1, body.request), ['running', 'failed']);
  assert.deepEqual([again.lastAnswer(F1, body.request).body.error.code, again.lastAnswer(F1, body.request).body.error.effects], ['interrupted', 'unknown']);
  // 终态不回退：绑定恢复后也不再调内核。
  await h.accord.change({ friends: FRIENDS });
  await again.settle();
  assert.equal(h.exec.calls.length, 1);
  assert.deepEqual(again.answers(F1, body.request), ['running', 'failed']);
});

test('the clock passing the latest start while the grant is read on restart: the kernel is not called and the call ends interrupted with unknown effects', async t => {
  const h = await holderOf(t);
  const { grant } = await h.grant();
  h.exec.plan = () => 'hang';
  const body = send(h, { grant });
  await h.settle();
  h.stop();
  const calls = h.exec.calls.length;
  // 恢复检查里那次授权读取挂住（按调用栈认出是 mayStartNow 发的）。
  let open, held = false;
  const gate = new Promise(resolve => { open = resolve; });
  const again = await holderOf(t, { ...h, wrapStore: store => ({ ...store, getGrant: async id => {
    if (!held && new Error().stack.includes('mayStartNow')) { held = true; await gate; }
    return store.getGrant(id);
  } }) });
  again.holder.tick();
  await until(() => held, '恢复检查的授权读取挂住');
  h.clock.now = body.expiresAt;
  open();
  await again.settle();
  assert.equal(h.exec.calls.length, calls, 'the kernel is not called on restart');
  assert.deepEqual(again.answers(F1, body.request), ['running', 'failed']);
  assert.deepEqual([again.lastAnswer(F1, body.request).body.error.code, again.lastAnswer(F1, body.request).body.error.effects], ['interrupted', 'unknown']);
});

test('an admitted request found past its latest start is answered expired without submitting, even if the clock steps back before the submit', async t => {
  let h, target = null, submits = 0;
  h = await holderOf(t, { wrapStore: store => ({ ...store, markSubmitted: async (caller, request, ...rest) => {
    // 走到提交时钟往回拨了一点（不到 5 分钟），又回到最晚启动时刻之前。
    if (request === target?.request) { submits++; h.clock.now = target.expiresAt - 1_000; }
    return store.markSubmitted(caller, request, ...rest);
  } }) });
  const { grant } = await h.grant();
  h.exec.plan = () => 'hang';
  const busy = Array.from({ length: LIMITS.executing.author }, () => send(h, { grant }));
  await h.settle();
  const waiting = send(h, { grant, expiresAt: h.clock.now + MINUTE });
  await h.settle();
  assert.equal((await h.store.get(F1, waiting.request)).state, 'admitted');
  submits = 0;
  target = waiting;
  h.clock.now = waiting.expiresAt + 30_000;
  for (const one of busy) h.exec.release(idempotencyKey(F1, one.request));
  await h.settle();
  assert.equal(submits, 0, 'never submitted');
  assert.equal(h.exec.runs, LIMITS.executing.author);
  assert.deepEqual(h.answers(F1, waiting.request), ['running', 'failed']);
  assert.equal(h.lastAnswer(F1, waiting.request).body.error.code, 'expired');
});

test('a stop while running is being signed: once the signature returns the request is not submitted and the command never runs', async t => {
  const h = await holderOf(t);
  const { grant } = await h.grant();
  const publish = h.accord.call;
  let open, signing = false;
  const gate = new Promise(resolve => { open = resolve; });
  h.accord.call = async (ref, operation, input) => {
    if (input.kind === 'friends/rpc-answer' && input.body.state === 'running') { signing = true; await gate; }
    return publish(ref, operation, input);
  };
  const body = send(h, { grant });
  h.holder.tick();
  await until(() => signing, 'running 签名挂住');
  h.stop();
  open();
  await until(() => h.holder.busy() === 0, '在途项停下');
  assert.equal((await h.store.get(F1, body.request)).state, 'admitted');
  assert.equal(h.exec.calls.length, 0);
});

test('the command does not start until running is signed: a failing first signature leaves it admitted, and it starts once running goes out; on restart an admitted request signs running first', async t => {
  const h = await holderOf(t);
  const { grant } = await h.grant();
  const publish = h.accord.call;
  let refuse = true;
  h.accord.call = async (ref, operation, input) => {
    if (refuse && input.kind === 'friends/rpc-answer') throw fail('unavailable', '目录暂时不可用');
    return publish(ref, operation, input);
  };
  const body = send(h, { grant });
  await h.settle();
  await h.settle();
  assert.equal(h.exec.calls.length, 0);
  assert.equal((await h.store.get(F1, body.request)).state, 'admitted');
  refuse = false;
  await h.settle();
  assert.equal(h.exec.runs, 1);
  assert.deepEqual(h.answers(F1, body.request), ['running', 'completed']);

  // 重启后接手的 admitted 项：先补签 running，才提交。
  refuse = true;
  const later = send(h, { grant });
  await h.settle();
  assert.equal((await h.store.get(F1, later.request)).state, 'admitted');
  h.stop();
  refuse = false;
  const again = await holderOf(t, h);
  await again.settle();
  assert.equal(h.exec.runs, 2);
  assert.deepEqual(again.answers(F1, later.request), ['running', 'completed']);
});

test('the ledger row is kept with the terminal state: a stop before it is written is made up exactly once on restart, also when the row was written but not yet marked', async t => {
  for (const [what, broken] of [['the append failed', store => ({ ...store, appendLedgerRow: async () => { throw new Error('写不进去'); } })],
    ['written, not marked', store => ({ ...store, markLogged: async () => { throw new Error('来不及标记'); } })]]) {
    const h = await holderOf(t, { wrapStore: broken });
    const { grant } = await h.grant();
    const body = send(h, { grant });
    await h.settle();
    assert.deepEqual(h.answers(F1, body.request), ['running', 'completed'], what);
    assert.notEqual((await h.store.get(F1, body.request)).ledger, undefined, what);
    h.stop();
    const again = await holderOf(t, h);
    await again.settle();
    assert.equal((await again.ledger({ request: body.request })).length, 1, what);
    assert.equal((await again.store.get(F1, body.request)).ledger, undefined, what);
    await again.settle();
    assert.equal((await again.ledger({ request: body.request })).length, 1, what);
  }
});

test('the wall clock going back during a run does not keep its ledger row out: the duration comes from a monotonic clock', async t => {
  const h = await holderOf(t);
  const { grant } = await h.grant();
  h.exec.plan = () => 'hang';
  const body = send(h, { grant });
  await h.settle();
  h.clock.now -= 10 * MINUTE;
  h.exec.release(idempotencyKey(F1, body.request));
  await h.settle();
  const rows = await h.ledger({ request: body.request });
  assert.equal(rows.length, 1);
  assert.ok(rows[0].ms >= 0);
  assert.deepEqual(h.answers(F1, body.request), ['running', 'completed']);
});

test('requests are scanned across more than 50 pages: a round resumes where the last stopped, later requests and cancels are seen, and seen records are forgotten only after a whole pass', async t => {
  const h = await holderOf(t);
  const { grant } = await h.grant();
  send(h, { grant, audience: ['public'] });
  // 本机自己的请求（作者是本机、local）也是这一类的记录，占满 50 多页。
  for (let i = 0; i < 160; i++) h.accord.records.push({ author: ME, kind: 'friends/rpc-call', id: `mine-${i}`, version: 1, body: {}, audience: [F1], local: true });
  h.exec.plan = () => 'hang';
  const body = send(h, { grant });
  for (let i = 0; i < 4 && !h.answers(F1, body.request).length; i++) await h.settle();
  assert.deepEqual(h.answers(F1, body.request), ['running']);
  cancelOf(h, body);
  for (let i = 0; i < 6 && h.answers(F1, body.request).length < 2; i++) await h.settle();
  assert.deepEqual(h.answers(F1, body.request), ['running', 'failed']);
  assert.ok(h.accord.queries.filter(query => query.kind === 'friends/rpc-call').length > 100);
  // 第一页上那条坏请求只拒绝过一次：中途的轮次没读到它，不算它不见了。
  assert.deepEqual((await rejections(h, 'bad_audience')).map(row => row.count), [1]);
});

test('the events themselves end the grants: machine key A to B and back to A, or a delete followed at once by a rebuild under the same id, before anything is looked up again', async t => {
  const h = await holderOf(t);
  const { grant } = await h.grant();
  // 不等任何一拍：换到 B 的那个事件里就把 A 授出的授权写成失效，马上又换回 A。
  h.accord.change({ machine: NEW_MK });
  await h.accord.change({ machine: MK });
  const body = send(h, { grant });
  await h.settle();
  assert.equal(h.exec.runs, 0);
  assert.equal(refusedWith(h, body), 'machine_changed');
  assert.equal((await h.store.getGrant(grant)).endedBy, 'machine_changed');
  // 之后的补查只补撤回：A 能签，撤回发了。
  assert.deepEqual(h.published('friends/rpc-grant').at(-1), { kind: 'friends/rpc-grant', id: grant, body: {}, audience: [], signer: 'machine', expectAuthor: MK });

  // 删除的事件里就让指向它的授权失效；同 id、同 owner、同 provider 马上重建出来也不再生效。
  const second = (await h.grant()).grant;
  h.targets.remove('rx-1');
  h.targets.set('rx-1');
  const late = send(h, { grant: second });
  await h.settle();
  assert.equal(h.exec.runs, 0);
  assert.equal(refusedWith(h, late), 'target_missing');
  assert.equal((await h.store.getGrant(second)).endedBy, 'target_missing');
  assert.deepEqual(h.published('friends/rpc-grant').at(-1), { kind: 'friends/rpc-grant', id: second, body: {}, audience: [], signer: 'machine', expectAuthor: MK });
});

test('an answer is withdrawn 24 hours after its terminal state even while its ledger row cannot be written; the entry stays until the row is in', async t => {
  for (const [what, broken] of [['a corrupt month file', undefined], ['an append that keeps failing', store => ({ ...store, appendLedgerRow: async () => { throw new Error('写不进去'); } })]]) {
    const h = await holderOf(t, { wrapStore: broken });
    const { grant } = await h.grant();
    const month = join(h.dir, 'rpc', 'ledger-2026-11.jsonl');
    if (!broken) await writeFile(month, 'not json\n');
    const body = send(h, { grant });
    await h.settle();
    assert.deepEqual(h.answers(F1, body.request), ['running', 'completed'], what);
    h.clock.now = START + 2 * ANSWER_KEEP_MS;
    await h.settle();
    assert.deepEqual(h.answers(F1, body.request), ['running', 'completed', 'retracted'], what);
    const kept = await h.store.get(F1, body.request);
    assert.deepEqual([kept?.retracted, kept?.ledger?.request], [true, body.request], what);
    if (broken) continue;
    // 月份文件修好了：补写那一行，之后才清掉这一项。
    await rm(month);
    await h.settle();
    await h.settle();
    assert.equal((await h.ledger({ request: body.request })).length, 1, what);
    assert.equal(await h.store.get(F1, body.request), null, what);
  }
});

test('an ending that fails to reach the disk is kept in memory: back on the old machine key its grant is refused, and once the disk recovers the ending is written and dropped from memory', async t => {
  // 定时器替身：兜底查询（15 秒）不走，别的（失效落盘的重试）由测试放行。
  const retries = [];
  const timers = { setTimeout: (fn, ms) => { if (ms !== POLL_MS) retries.push(fn); return null; }, clearTimeout() {} };
  const disk = { failing: true };
  const failing = write => (...args) => disk.failing ? Promise.reject(new Error('写不进去')) : write(...args);
  const h = await holderOf(t, { timers, wrapStore: store => ({ ...store, endGrants: failing(store.endGrants), revokeGrant: failing(store.revokeGrant) }) });
  const { grant } = await h.grant();
  h.accord.change({ machine: NEW_MK });
  await h.accord.change({ machine: MK });
  const body = send(h, { grant });
  await h.settle();
  assert.equal(h.exec.runs, 0);
  // 还没落盘的失效同样挡住准入；失效写不进去，这条请求留到下一轮再看，先不回话。
  assert.deepEqual(h.answers(F1, body.request), []);
  assert.equal((await h.store.getGrant(grant)).revokedAt, undefined, 'not on disk yet');
  // A→B 记下旧钥匙 A 的一笔，B→A 记下旧钥匙 B 的一笔（没有授权，同样等落盘）。
  assert.equal(h.holder.pendingEnds(), 2);
  assert.equal(h.published('friends/rpc-grant').length, 1, 'neither published again nor withdrawn while the ending is not on disk');
  assert.ok(retries.length >= 1, 'a retry is scheduled');
  // 事件之后才授出的授权不归这笔失效管。
  const later = (await h.grant()).grant;

  disk.failing = false;
  for (const retry of retries.splice(0)) retry();
  await until(async () => (await h.store.getGrant(grant)).endedBy === 'machine_changed', '失效落盘');
  await h.settle();
  assert.equal(h.holder.pendingEnds(), 0);
  assert.deepEqual(h.published('friends/rpc-grant').at(-1), { kind: 'friends/rpc-grant', id: grant, body: {}, audience: [], signer: 'machine', expectAuthor: MK });
  assert.equal((await h.store.getGrant(later)).revokedAt, undefined);
  // 落盘之后，挡下的那条与新来的都签回失败终态。
  const again = send(h, { grant });
  await h.settle();
  assert.equal(refusedWith(h, body), 'machine_changed');
  assert.equal(refusedWith(h, again), 'machine_changed');
  assert.equal(h.exec.runs, 0);
});

// 失效落盘失败时的几处交错：`endGrants`、`revokeGrant` 写不进去，直到 `disk.failing` 改回 false；失效落盘的重试记在 `retries`，由测试放行。
function failingDisk(more = {}) {
  const disk = { failing: true, retries: [] };
  const failing = write => (...args) => disk.failing ? Promise.reject(new Error('写不进去')) : write(...args);
  disk.timers = { setTimeout: (fn, ms) => { if (ms !== POLL_MS) disk.retries.push(fn); return null; }, clearTimeout() {} };
  disk.wrapStore = store => ({ ...store, endGrants: failing(store.endGrants), revokeGrant: failing(store.revokeGrant), ...more(store) });
  return disk;
}

test('an ending seen while the submit waits in the store queue is checked in that same store step: the command does not start, also when the ending cannot reach the disk', async t => {
  for (const [what, code] of [['target', 'target_missing'], ['machine', 'machine_changed']]) {
    let fire = null;
    // markSubmitted 进了 store 的队、还没轮到时，来一个删除再重建（或 A→B→A）的事件。
    const disk = failingDisk(store => ({ markSubmitted: (...args) => { const run = store.markSubmitted(...args); fire?.(); fire = null; return run; } }));
    disk.failing = false;
    const h = await holderOf(t, disk);
    const { grant } = await h.grant();
    disk.failing = true;
    fire = what === 'target' ? () => { h.targets.remove('rx-1'); h.targets.set('rx-1'); } : () => { h.accord.change({ machine: NEW_MK }); h.accord.change({ machine: MK }); };
    const body = send(h, { grant });
    await h.settle();
    assert.equal(fire, null, `${what}: the event fired`);
    assert.equal(h.exec.runs, 0, what);
    assert.deepEqual(h.answers(F1, body.request), ['running', 'failed'], what);
    assert.equal(h.lastAnswer(F1, body.request).body.error.code, code, what);
    assert.equal((await h.store.getGrant(grant)).revokedAt, undefined, `${what}: not on disk yet`);
  }
});

test('the same ending key seen twice keeps one retry: delete, rebuild, delete, rebuild (or machine key A to B and back, twice) with both writes failing; once the disk recovers the old grants end and the newest stays', async t => {
  for (const what of ['target', 'machine']) {
    const disk = failingDisk(() => ({}));
    const h = await holderOf(t, disk);
    const flip = what === 'target' ? async () => { h.targets.remove('rx-1'); h.targets.set('rx-1'); }
      : async () => { h.accord.change({ machine: NEW_MK }); await h.accord.change({ machine: MK }); };
    const first = (await h.grant()).grant;
    await flip();
    const second = (await h.grant()).grant;
    await until(() => disk.retries.length >= 1, '第一次失效的重试排上');
    await flip();
    const newest = (await h.grant()).grant;
    await h.settle();
    disk.failing = false;
    // 先放旧事件的重试，再放新的。
    for (const retry of disk.retries.splice(0)) retry();
    await until(async () => (await h.store.getGrant(second)).revokedAt !== undefined, `${what}: 失效落盘`);
    await h.settle();
    assert.equal(h.holder.pendingEnds(), 0, what);
    const ended = Object.fromEntries((await h.store.listGrants()).map(row => [row.id, row.revokedAt !== undefined]));
    assert.deepEqual([ended[first], ended[second], ended[newest]], [true, true, false], what);
    const { grants } = await h.holder.self['grants.list']();
    assert.equal(grants.find(row => row.grant === newest).status, 'available', what);
  }
});

test('an ending not yet on disk keeps a grant record from being published and shows in grants.list: a delete during the directory lookup, a rebuild under the same id, a return to the old machine key', async t => {
  const disk = failingDisk(() => ({}));
  const h = await holderOf(t, disk);
  const release = h.accord.hold(input => input.kind === 'friends/rpc-grant');
  const granting = h.grant();
  await until(() => h.accord.held(), '初次发布卡在目录查询');
  h.targets.remove('rx-1');
  release();
  const { grant } = await granting;
  await h.settle();
  h.targets.set('rx-1');
  await h.settle();
  assert.deepEqual(h.published('friends/rpc-grant').filter(call => call.audience.length), [], 'no grant record with a body was signed');
  assert.equal((await h.store.getGrant(grant)).revokedAt, undefined, 'not on disk yet');
  const status = async id => (await h.holder.self['grants.list']()).grants.find(row => row.grant === id).status;
  assert.equal(await status(grant), 'target_missing');

  const second = (await h.grant()).grant;
  assert.equal(await status(second), 'available');
  h.accord.change({ machine: NEW_MK });
  await h.accord.change({ machine: MK });
  await h.settle();
  assert.equal((await h.store.getGrant(second)).revokedAt, undefined, 'not on disk yet');
  assert.equal(await status(second), 'machine_changed');
});

// ---- 作者：机器钥匙与个人身份 ----

// F1 是个人作者（绑了个人身份、证书有效），F2 是机器作者；`machine`、`certified` 是好友表里说的（coda#3018）。
const PERSON_AND_MACHINE = FRIENDS.slice(0, 2);

test('a holder with no personal identity grants, takes requests, runs them and answers with its machine key, to a personal caller and a machine caller alike', async t => {
  const h = await holderOf(t, { accordOptions: { author: MACHINE_KEY, certificate: null, friends: PERSON_AND_MACHINE } });
  const person = await h.grant(F1), machine = await h.grant(F2);
  assert.deepEqual([person.status, machine.status], ['available', 'available']);
  const rows = Object.fromEntries((await h.store.listGrants()).map(row => [row.grantee, row]));
  assert.deepEqual([rows[F1].holder, rows[F1].granteePerson, rows[F2].granteePerson], [{ machine: MACHINE_KEY }, true, false]);
  assert.deepEqual(h.published('friends/rpc-grant').map(call => [call.audience[0], call.expectAuthor, call.body.holder]), [[F1, MACHINE_KEY, MACHINE_KEY], [F2, MACHINE_KEY, MACHINE_KEY]]);
  // 个人作者（证书有效、好友绑定在）与机器作者的请求都被接受、执行、回答。
  const fromPerson = send(h, { from: F1, grant: person.grant }), fromMachine = send(h, { from: F2, grant: machine.grant });
  await h.settle();
  assert.equal(h.exec.runs, 2);
  for (const [caller, body] of [[F1, fromPerson], [F2, fromMachine]]) {
    assert.deepEqual(h.answers(caller, body.request), ['running', 'completed']);
    const answer = h.lastAnswer(caller, body.request);
    assert.deepEqual([answer.expectAuthor, answer.body.holder, answer.body.caller, answer.audience], [MACHINE_KEY, MACHINE_KEY, caller, [caller]]);
    assert.equal(answer.body.result.stdout, `ran ${body.input.command}`);
  }
  assert.equal((await h.ledger({ outcome: 'completed' })).length, 2);
  assert.deepEqual(await rejections(h), []);
});

test('a personal caller whose certificate expired is no longer bound: its request is refused, and the grant stays for when the certificate is renewed', async t => {
  const h = await holderOf(t, { accordOptions: { author: MACHINE_KEY, certificate: null, friends: PERSON_AND_MACHINE } });
  const { grant } = await h.grant(F1);
  // 替身照基座的做法：调用方的证书过期，它的好友绑定判为未绑定，好友表里仍以原作者列着。
  await h.accord.change({ friends: [{ ...PERSON_AND_MACHINE[0], bound: false }, PERSON_AND_MACHINE[1]] });
  const body = send(h, { from: F1, grant });
  await h.settle();
  assert.equal(h.exec.runs, 0);
  assert.deepEqual(h.answers(F1, body.request), []);
  assert.equal((await rejections(h, 'not_friend')).length, 1);
  assert.equal((await h.store.getGrant(grant)).revokedAt, undefined);
  // 续了证书：同一条授权照常能用。
  await h.accord.change({ friends: PERSON_AND_MACHINE });
  const renewed = send(h, { from: F1, grant });
  await h.settle();
  assert.deepEqual(h.answers(F1, renewed.request), ['running', 'completed']);
});

test('a grantee that changed its author (bound a personal identity, unbound, or a new root) no longer matches the friends table: its grants end at once and are withdrawn', async t => {
  const h = await holderOf(t);
  const toPerson = (await h.grant(F1)).grant, toMachine = (await h.grant(F2)).grant;
  // F2 那台绑了个人身份：同一通道、同一机器钥匙，作者变成了新根。F1 照旧。
  await h.accord.change({ friends: [FRIENDS[0], { ...FRIENDS[1], author: NEW_ROOT, certified: true }, FRIENDS[2]] });
  await until(async () => (await h.store.getGrant(toMachine)).endedBy === 'grantee_changed', '好友换了作者后失效落盘');
  await h.settle();
  assert.equal((await h.store.getGrant(toPerson)).revokedAt, undefined);
  assert.deepEqual(h.accord.calls.filter(call => call.id === toMachine).at(-1), { kind: 'friends/rpc-grant', id: toMachine, body: {}, audience: [], signer: 'machine', expectAuthor: MK });
  assert.equal((await h.holder.self['grants.list']()).grants.find(row => row.grant === toMachine).status, 'grantee_changed');
  // 旧作者签的请求（例如换作者之前已发出的）不再执行。
  const stale = send(h, { from: F2, grant: toMachine });
  await h.settle();
  assert.equal(h.exec.runs, 0);
  assert.deepEqual(h.answers(F2, stale.request), []);
});

test('binding a personal identity (machine key to root) and unbinding it again leaves the grants as they were: the machine key stays, requests keep running and answers keep its signature', async t => {
  const h = await holderOf(t, { accordOptions: { author: MACHINE_KEY, certificate: null } });
  const { grant } = await h.grant(F1);
  const runs = [];
  const run = async () => {
    const body = send(h, { grant });
    assert.equal(body.holder, MK);
    await h.settle();
    assert.deepEqual(h.answers(F1, body.request), ['running', 'completed'], `run ${runs.length + 1}`);
    runs.push(h.lastAnswer(F1, body.request));
  };
  await run();
  // 绑了个人身份：作者变成根，机器钥匙（证书里的 key）不变。
  await h.accord.change({ author: ME, certificate: ACTIVE });
  await h.settle();
  await run();
  // 换了根，证书又过期了：也一样。
  await h.accord.change({ author: NEW_ROOT, certificate: EXPIRED });
  await h.settle();
  await run();
  // 解绑：作者变回机器钥匙。
  await h.accord.change({ author: MACHINE_KEY, certificate: null });
  await h.settle();
  await run();
  assert.deepEqual(runs.map(answer => [answer.signer, answer.expectAuthor, answer.body.holder]), Array(4).fill(['machine', MK, MK]));
  assert.equal(h.exec.runs, 4);
  const row = await h.store.getGrant(grant);
  assert.deepEqual([row.revokedAt, row.holder], [undefined, { machine: MK }]);
  assert.equal((await h.holder.self['grants.list']()).grants[0].status, 'available');
  assert.equal(h.holder.pendingEnds(), 0);
  // 授权记录没被撤过。
  assert.deepEqual(h.published('friends/rpc-grant').filter(call => !call.audience.length), []);
  assert.deepEqual(await rejections(h), []);
});

// ---- 目录里留下的旧请求（基座的目录同步不看插件状态，停用、卸载期间它们还在） ----

test('after a stop and start on the same data directory the first read of the directory does not run a request past its replay window nor answer it running, and does not run a handled one again', async t => {
  const h = await holderOf(t);
  const { grant } = await h.grant();
  const handled = send(h, { grant, expiresAt: START + 10 * MINUTE });
  await h.settle();
  assert.deepEqual(h.answers(F1, handled.request), ['running', 'completed']);
  assert.equal(h.exec.runs, 1);
  // 停用期间目录里又来了一条，没人处理；再启用时它已过了重放窗口，处理过的那条还在窗口里（去重表在盘上）。
  h.stop();
  const stale = send(h, { grant, createdAt: START, expiresAt: START + 5 * MINUTE });
  h.clock.now = START + 7 * MINUTE;
  const again = await holderOf(t, h);
  await again.settle();
  assert.equal(h.exec.runs, 1, 'the command ran once, in all');
  assert.deepEqual(again.answers(F1, stale.request), [], 'not even running');
  assert.deepEqual(again.answers(F1, handled.request), ['running', 'completed']);
  assert.deepEqual((await rejections(again, 'window_expired')).map(row => row.friend), [F1]);
});

test('after the state directory is cleared (no grants, no handled table) the requests left in the directory are refused for want of a grant and no command runs', async t => {
  const h = await holderOf(t);
  const { grant } = await h.grant();
  const handled = send(h, { grant, expiresAt: START + 10 * MINUTE });
  await h.settle();
  assert.equal(h.exec.runs, 1);
  h.stop();
  // 卸载期间又来了一条，还在窗口里；装回来的是空的数据目录和一个新的执行端替身。
  const waiting = send(h, { grant, expiresAt: START + 10 * MINUTE });
  const fresh = await holderOf(t, { accord: h.accord, targets: h.targets, clock: h.clock });
  await fresh.settle();
  assert.deepEqual((await fresh.holder.self['grants.list']()).grants, []);
  assert.equal(fresh.exec.runs, 0);
  assert.deepEqual(fresh.exec.calls, []);
  for (const request of [handled.request, waiting.request]) assert.deepEqual(fresh.answers(F1, request), h.answers(F1, request), 'no new answer');
  assert.deepEqual(fresh.answers(F1, waiting.request), []);
  // 没有任何授权时目录根本不读；授了别人之后读到的旧请求，作者不是任何被授权者，一概拒绝。
  assert.deepEqual(await rejections(fresh), []);
  await fresh.grant(F2);
  await fresh.settle();
  assert.equal(fresh.exec.runs, 0);
  assert.deepEqual((await rejections(fresh, 'bad_author')).map(row => [row.friend, row.count]), [[F1, 2]]);
  assert.deepEqual(fresh.answers(F1, waiting.request), []);
});

// 目录里本机机器钥匙签给 `friend`、还没撤回的授权记录的授权号：调用方照这个登记代理。
const liveGrantRecords = (h, friend = F1) => h.accord.records.filter(r => r.kind === 'friends/rpc-grant' && r.author === MK && r.local && r.audience?.includes(friend)).map(r => r.id);

test('after the state directory is cleared the grant records left in the directory are withdrawn at start, so the caller drops its proxy; granting again leaves the caller one', async t => {
  const h = await holderOf(t);
  const { grant: old } = await h.grant();
  const { grant: other } = await h.grant(F2);
  assert.deepEqual(liveGrantRecords(h), [old]);
  h.stop();
  // 卸载并清数据，再装回：空的状态目录，同一个 Accord。
  const fresh = await holderOf(t, { accord: h.accord, targets: h.targets, clock: h.clock });
  // 孤儿清理在后台，不随节拍结束：等目录里这两条撤掉再看。
  await until(() => !liveGrantRecords(fresh).length && !liveGrantRecords(fresh, F2).length, '旧授权记录撤回');
  assert.deepEqual(fresh.published('friends/rpc-grant').filter(call => !call.audience.length).map(call => [call.id, call.expectAuthor, call.signer]).sort(),
    [[old, MK, 'machine'], [other, MK, 'machine']].sort());
  const { grant: renewed } = await fresh.grant();
  await fresh.settle();
  assert.deepEqual(liveGrantRecords(fresh), [renewed]);
  assert.notEqual(renewed, old);
});

test('while an orphan grant record\'s retraction hangs, requests under a live grant are still scanned and run; the directory is read once and the retraction goes through when let go', async t => {
  const h = await holderOf(t);
  const { grant: old } = await h.grant();
  h.stop();
  // 撤回前按授权号查那一条的查询挂住。
  const release = h.accord.hold(input => input.kind === 'friends/rpc-grant' && input.id === old);
  const fresh = await holderOf(t, { accord: h.accord, targets: h.targets, clock: h.clock });
  await until(() => h.accord.held(), '孤儿撤回挂住');
  const { grant } = await fresh.grant();
  const body = send(fresh, { grant });
  await fresh.settle();
  assert.deepEqual(fresh.answers(F1, body.request), ['running', 'completed']);
  assert.equal(fresh.exec.runs, 1);
  assert.deepEqual(liveGrantRecords(fresh).sort(), [old, grant].sort());
  release();
  await until(() => !liveGrantRecords(fresh).includes(old), '孤儿撤回');
  await fresh.settle();
  assert.deepEqual(liveGrantRecords(fresh), [grant]);
  const listings = h.accord.queries.filter(input => input.kind === 'friends/rpc-grant' && input.id === undefined);
  assert.equal(listings.length, 2, 'one directory read per start');
});

test('with a corrupt grants table at start no grant record is withdrawn', async t => {
  const h = await holderOf(t);
  const { grant } = await h.grant();
  h.stop();
  await writeFile(join(h.dir, 'rpc', 'grants.json'), '{ not json');
  const calls = h.accord.calls.length;
  const again = await holderOf(t, h);
  await again.settle();
  assert.deepEqual(liveGrantRecords(again), [grant]);
  assert.equal(h.accord.calls.length, calls, 'nothing sent');
  assert.equal((await again.holder.self['grants.list']()).corrupt, 'grants.json');
});

test('at start a grant record with a live grant in the table is left alone; one whose grant was revoked is withdrawn as usual', async t => {
  const h = await holderOf(t);
  const { grant: kept } = await h.grant();
  const { grant: gone } = await h.grant(F2);
  await h.accord.change({ machine: null });
  await h.holder.self['grants.revoke']({ grant: gone });
  await h.settle();
  h.stop();
  await h.accord.change({ machine: MK });
  const calls = h.accord.calls.length;
  const again = await holderOf(t, h);
  await again.settle();
  assert.deepEqual([liveGrantRecords(again), liveGrantRecords(again, F2)], [[kept], []]);
  assert.deepEqual(h.accord.calls.slice(calls).map(call => [call.id, call.audience]), [[gone, []]]);
});

// ---- coda self ----

test('coda self grants.list, grants.grant, grants.revoke and ledger.list go through the activated module', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'friends-holder-main-'));
  const accord = accordFake(), exec = execFake(), targets = targetsFake();
  const host = createMockCoda({ plugin: { id: 'friends', state: dir, protocols: friendsManifest.contributes.protocols }, protocols: [remoteExec] });
  t.after(async () => { deactivate(); host.close(); await rm(dir, { recursive: true, force: true }); });
  await activate(routed(host, { accord, exec, targets }));
  const self = (name, input) => host.self(name, input);
  assert.deepEqual(await self('grants.list'), { certState: 'active', admitting: true, corrupt: null, grants: [] });
  const granted = await self('grants.grant', { friend: F1, target: { kind: MACHINE, id: 'rx-1' } });
  assert.deepEqual(granted, { grant: granted.grant, friend: F1, target: { kind: MACHINE, id: 'rx-1', name: 'box' }, createdAt: granted.createdAt, status: 'available' });
  await self('grants.grant', { friend: F2, target: { kind: MACHINE, id: 'rx-1' } });
  const status = async () => (await self('grants.list')).grants.map(row => [row.friend, row.status]).sort();
  assert.deepEqual(await status(), [[F1, 'available'], [F2, 'available']]);
  targets.set('rx-1', { status: { available: false } });
  assert.deepEqual(await status(), [[F1, 'target_off'], [F2, 'target_off']]);
  // 本机证书过期不影响授权；读不出机器钥匙才没法用。
  await accord.change({ certificate: EXPIRED });
  assert.deepEqual(await status(), [[F1, 'target_off'], [F2, 'target_off']]);
  await accord.change({ machine: null });
  assert.deepEqual(await status(), [[F1, 'no_identity'], [F2, 'no_identity']]);
  await accord.change({ certificate: ACTIVE, machine: MK });
  targets.set('rx-1', { status: { available: true } });
  const revoked = await self('grants.revoke', { grant: granted.grant });
  assert.equal(revoked.status, 'revoked');
  assert.deepEqual(await status(), [[F1, 'revoked'], [F2, 'available']]);
  await assert.rejects(self('grants.grant', { friend: F3, target: { kind: MACHINE, id: 'rx-1' } }), error => error.code === 'invalid_input');
  await assert.rejects(self('ledger.list', { limit: 0 }), error => error.code === 'invalid_input');
  // 操作记录：最近若干行，可按好友筛。
  const store = createRpcStore(dir);
  await store.recordRejection({ friend: F1, code: 'bad_audience' });
  await store.recordRejection({ friend: F2, code: 'busy' });
  assert.deepEqual((await self('ledger.list')).map(row => row.friend).sort(), [F1, F2]);
  assert.deepEqual((await self('ledger.list', { friend: F2 })).map(row => row.code), ['busy']);
  assert.equal((await self('ledger.list', { limit: 1 })).length, 1);
});

// ---- 经本机（网关）授出空间里别的机器的记录 ----

// 空间里另一台机器 B：它自己的 remote-exec 记录 rx-b，副本在本机读得到（local: false、owner 是 B）。
const B = 'backend-b', B_SPEC = { name: 'garage', os: 'linux', user: 'b', cwd: '/home/b' };
function addMachineB(h, { id = 'rx-b', quiet = false } = {}) {
  h.targets.machines.set(B, { offline: false });
  h.targets.set(id, { owner: B, location: 'garage', local: false, spec: { ...B_SPEC } }, { quiet });
}
const grantB = h => h.grant(F1, { kind: MACHINE, id: 'rx-b' });
const statusOf = async (h, grant) => (await h.holder.self['grants.list']()).grants.find(row => row.grant === grant).status;

test('another machine\'s own remote-exec record in the space can be granted: the grant pins its machine, the grant record carries its name, calls go to it; a proxy or another plugin\'s record there cannot', async t => {
  const h = await holderOf(t);
  addMachineB(h);
  h.targets.set('px-b', { owner: B, location: 'garage', local: false, plugin: 'friends' });
  h.targets.set('ot-b', { owner: B, location: 'garage', local: false, plugin: 'other' });
  for (const id of ['px-b', 'ot-b']) await assert.rejects(h.grant(F1, { kind: MACHINE, id }), error => error.code === 'invalid_input', id);
  await assert.rejects(h.grant(F1, { kind: MACHINE, id: 'nowhere' }), error => error.code === 'not_found');
  // 本机没有 remote-exec 协议（读记录报 not_found）：授不出。
  h.targets.absent = true;
  await assert.rejects(grantB(h), error => error.code === 'not_found');
  h.targets.absent = false;
  assert.deepEqual(await h.store.listGrants(), []);

  const granted = await grantB(h);
  assert.deepEqual([granted.status, granted.target.name], ['available', 'garage']);
  const [row] = await h.store.listGrants();
  assert.deepEqual(row.target, { owner: B, provider: 'remote-exec', kind: MACHINE, id: 'rx-b' });
  // 授权记录照旧由本机的机器钥匙签，名字是 B 的。
  assert.deepEqual(h.published('friends/rpc-grant').map(call => [call.id, call.expectAuthor, call.body.holder, call.body.spec]), [[row.id, MK, MK, B_SPEC]]);
  // 本机自己的授权照旧。
  const local = await h.grant();
  assert.equal(local.status, 'available');

  const body = send(h, { grant: granted.grant });
  await h.settle();
  assert.deepEqual(h.exec.calls.map(call => call.ref), [{ kind: MACHINE, id: 'rx-b' }]);
  assert.deepEqual(h.answers(F1, body.request), ['running', 'completed']);
});

test('every admission and submission checks the other machine\'s record again: one that reads as another machine\'s or another plugin\'s is refused without ending the grant, and works again once it is that record again', async t => {
  const h = await holderOf(t);
  addMachineB(h);
  const { grant } = await grantB(h);
  for (const more of [{ owner: 'backend-c', location: 'c' }, { plugin: 'friends' }]) {
    h.targets.set('rx-b', more, { quiet: true });
    const body = send(h, { grant });
    await h.settle();
    assert.equal(refusedWith(h, body), 'target_unreachable', JSON.stringify(more));
    h.targets.set('rx-b', { owner: B, location: 'garage', plugin: 'remote-exec' }, { quiet: true });
  }
  assert.equal((await refusals(h, 'target_unreachable')).length, 2);
  assert.equal((await h.store.getGrant(grant)).revokedAt, undefined, 'the grant stays');
  assert.equal(h.exec.runs, 0);
  // 提交前那一刻读不到（排队期间那台被移出空间）：答失败，不提交，授权还在。
  h.targets.machines.delete(B);
  h.targets.remove('rx-b', { quiet: true });
  const late = send(h, { grant });
  await h.settle();
  assert.equal(refusedWith(h, late), 'target_unreachable');
  addMachineB(h, { quiet: true });
  const back = send(h, { grant });
  await h.settle();
  assert.deepEqual(h.answers(F1, back.request), ['running', 'completed']);
  assert.equal(h.exec.runs, 1);
});

test('while the other machine is known to be offline the grant stays and a call is refused before anything is sent, with a terminal answer of no effects; once it is back calls work again', async t => {
  const h = await holderOf(t);
  addMachineB(h);
  const { grant } = await grantB(h);
  const records = h.published('friends/rpc-grant').length;
  // 离线：目录库留着它的副本（照样读得到），机器记录说离线，没有变化事件。
  h.targets.machines.set(B, { offline: true });
  assert.equal(await statusOf(h, grant), 'target_offline');
  const body = send(h, { grant });
  await h.settle();
  assert.equal(refusedWith(h, body), 'target_offline');
  assert.deepEqual(h.lastAnswer(F1, body.request).body.error, { code: 'target_offline', message: '授权的目标机器此刻离线，命令没有启动', effects: 'none' });
  assert.equal(h.exec.calls.length, 0, 'nothing handed to the kernel');
  assert.equal((await h.store.getGrant(grant)).revokedAt, undefined);
  assert.equal(h.published('friends/rpc-grant').length, records, 'the grant record is left as it was');
  h.targets.machines.set(B, { offline: false });
  assert.equal(await statusOf(h, grant), 'available');
  const again = send(h, { grant });
  await h.settle();
  assert.deepEqual(h.answers(F1, again.request), ['running', 'completed']);
});

test('admitted, then known offline before it is submitted: refused at submission, nothing sent', async t => {
  const h = await holderOf(t);
  addMachineB(h);
  const { grant } = await grantB(h);
  // 名额占满，第 5 条准入后等着；这时 B 被读出离线，轮到它提交时拒绝。
  h.exec.plan = () => 'hang';
  for (let i = 0; i < LIMITS.executing.author; i++) send(h, { grant });
  await h.settle();
  const waiting = send(h, { grant });
  await h.settle();
  assert.equal((await h.store.get(F1, waiting.request)).state, 'admitted');
  h.targets.machines.set(B, { offline: true });
  h.exec.release(h.exec.calls[0].id);
  await h.settle();
  assert.deepEqual(h.answers(F1, waiting.request), ['running', 'failed']);
  assert.deepEqual(h.lastAnswer(F1, waiting.request).body.error, { code: 'target_offline', message: '授权的目标机器此刻离线，命令没有启动', effects: 'none' });
  assert.ok(!h.exec.calls.some(call => call.id === idempotencyKey(F1, waiting.request)));
});

test('offline but not yet known so: the call is bounded by the command\'s own time limit plus a fixed margin, and when the kernel gives it up there the friend gets a terminal answer; the grant stays', async t => {
  const h = await holderOf(t);
  addMachineB(h);
  const { grant } = await grantB(h);
  // B 停了，机器记录还没读出离线：调用照常交给内核，排着送不出去。
  h.exec.plan = () => 'hang';
  const body = send(h, { grant, input: { command: 'printf queued', timeout: 8 } });
  await h.settle();
  const [call] = h.exec.calls;
  assert.equal(call.timeout, 8_000 + 60_000, 'the command\'s 8 seconds plus 60, not the request window');
  assert.ok(call.signaled);
  h.exec.expire(call.id);
  await h.settle();
  assert.deepEqual(h.answers(F1, body.request), ['running', 'failed']);
  const { error } = h.lastAnswer(F1, body.request).body;
  assert.deepEqual([error.code, error.effects], ['timeout', 'unknown']);
  assert.match(error.message, /已放弃这次调用/);
  assert.ok(!error.message.includes('本机'));
  assert.equal(h.exec.calls.length, 1, 'not called again');
  assert.equal((await h.store.getGrant(grant)).revokedAt, undefined);
});

test('the other machine removed from the space (its record and its machine record gone together) does not end the grant: calls are refused, and it works again once the machine is back', async t => {
  const h = await holderOf(t);
  addMachineB(h);
  const { grant } = await grantB(h);
  const records = h.accord.calls.length;
  // 移出空间：目录库不再跟随 B，它的副本连同机器记录一起没了，记录以 DELETED 交来。
  h.targets.machines.delete(B);
  h.targets.remove('rx-b');
  await h.settle();
  assert.equal(h.holder.pendingEnds(), 0);
  assert.equal((await h.store.getGrant(grant)).revokedAt, undefined, 'the grant stays');
  assert.equal(h.accord.calls.length, records, 'nothing retracted');
  assert.equal(await statusOf(h, grant), 'target_unreachable');
  const body = send(h, { grant });
  await h.settle();
  assert.equal(refusedWith(h, body), 'target_unreachable');
  assert.equal(h.lastAnswer(F1, body.request).body.error.message, '此刻读不到授权的目标机器上的这条记录（那台不在空间里），命令没有启动');
  assert.equal(h.exec.calls.length, 0);
  // 本机此刻没有 remote-exec 协议（远程执行插件不在）：同样只拒不失效。
  h.targets.absent = true;
  const absent = send(h, { grant });
  await h.settle();
  assert.equal(refusedWith(h, absent), 'target_unreachable');
  assert.equal((await h.store.getGrant(grant)).revokedAt, undefined);
  h.targets.absent = false;
  addMachineB(h);
  await h.settle();
  assert.equal(await statusOf(h, grant), 'available');
  const back = send(h, { grant });
  await h.settle();
  assert.deepEqual(h.answers(F1, back.request), ['running', 'completed']);
});

test('the other machine\'s record really gone (the machine still in the space) ends the grant for good, seen as it happens or only at admission', async t => {
  for (const quiet of [false, true]) {
    const h = await holderOf(t);
    addMachineB(h);
    const { grant } = await grantB(h);
    h.exec.plan = () => 'hang';
    const running = send(h, { grant });
    await h.settle();
    assert.equal(h.exec.pending(), 1, `${quiet}: running on B`);
    h.targets.remove('rx-b', { quiet });
    if (quiet) {
      const body = send(h, { grant });
      await h.settle();
      assert.equal(refusedWith(h, body), 'target_missing', 'refused at admission');
    }
    await until(async () => (await h.store.getGrant(grant)).endedBy === 'target_missing', `${quiet}: 失效落盘`);
    await h.settle();
    assert.notEqual((await h.store.getGrant(grant)).retractedAt, undefined, `${quiet}: the grant record is withdrawn`);
    // 已在 B 上跑的被中止。
    assert.equal(h.exec.pending(), 0, `${quiet}: aborted`);
    assert.equal((await h.store.get(F1, running.request)).canceledBy, 'target_missing');
    assert.equal(await statusOf(h, grant), 'target_missing');
    // 同 id 回来了也不恢复。
    addMachineB(h);
    await h.settle();
    const after = send(h, { grant });
    await h.settle();
    assert.equal(refusedWith(h, after), 'target_missing');
    assert.equal(await statusOf(h, grant), 'target_missing');
  }
});

test('a record of the other machine that is gone and back before it is checked does not end the grant', async t => {
  const h = await holderOf(t);
  addMachineB(h);
  const { grant } = await grantB(h);
  // 收到 DELETED 后再读的那一次挂住，读之前它已回来。
  const release = h.targets.hold(0);
  h.targets.remove('rx-b');
  await until(() => h.targets.waiting(), '复查挂住');
  addMachineB(h);
  release();
  await h.settle();
  assert.equal((await h.store.getGrant(grant)).revokedAt, undefined);
  assert.equal(await statusOf(h, grant), 'available');
});

test('revoking a grant of the other machine refuses new calls at once and aborts the one running there through the call\'s cancel', async t => {
  const h = await holderOf(t);
  addMachineB(h);
  const { grant } = await grantB(h);
  h.exec.plan = () => 'hang';
  const body = send(h, { grant });
  await h.settle();
  assert.deepEqual(h.exec.calls.map(call => [call.ref.id, call.signaled]), [['rx-b', true]]);
  await h.holder.self['grants.revoke']({ grant });
  await h.settle();
  assert.equal(h.exec.pending(), 0);
  assert.deepEqual(h.answers(F1, body.request), ['running', 'failed']);
  assert.deepEqual(h.lastAnswer(F1, body.request).body.error.code, 'interrupted');
  const after = send(h, { grant });
  await h.settle();
  assert.equal(refusedWith(h, after), 'revoked');
  assert.equal(h.lastAnswer(F1, after.request).body.error.message, '授权已撤销，命令没有启动');
  assert.equal(h.exec.calls.length, 1);
});

test('a refusal is answered only within the friend\'s quota and only to the grantee who is still a bound friend: over the quota, for another friend\'s grant, or to an unbound friend it stays silent', async t => {
  const h = await holderOf(t);
  const { grant } = await h.grant();
  const other = (await h.grant(F2)).grant;
  await h.holder.self['grants.revoke']({ grant });
  await h.settle();
  // 每分钟新请求的名额照算：名额内的签回失败终态，超出的只记账。
  const bodies = Array.from({ length: LIMITS.perMinute.author + 1 }, () => send(h, { grant }));
  await h.settle();
  const answered = bodies.filter(body => refusedWith(h, body) === 'revoked');
  assert.equal(answered.length, LIMITS.perMinute.author);
  assert.deepEqual(h.answers(F1, bodies.at(-1).request), [], 'over the quota: silent');
  assert.equal((await rejections(h, 'revoked'))[0].count, 1);
  // 拿别人的授权号：没有给它的授权，不回话。
  h.clock.now += 2 * MINUTE;
  const foreign = send(h, { grant: other });
  // 解绑了的好友：不回话。
  await h.accord.change({ friends: [FRIENDS[0], { ...FRIENDS[1], bound: false }, FRIENDS[2]] });
  const unbound = send(h, { from: F2, grant: other });
  await h.holder.self['grants.revoke']({ grant: other });
  await h.settle();
  assert.deepEqual(h.answers(F1, foreign.request), []);
  assert.deepEqual(h.answers(F2, unbound.request), []);
  assert.equal(h.exec.runs, 0);
});

test('a refusal is written as a terminal entry in the one admitting write: stopped before its answer is signed, the restart signs the refusal and never runs the command, even with the target back', async t => {
  const box = { stopAfterRefusal: true, h: null };
  const wrapStore = store => ({ ...store, admit: async input => {
    const admitted = await store.admit(input);
    // 拒绝登记之后、签回答之前就停了（同进程退出）。
    if (input.refusal && box.stopAfterRefusal) { box.stopAfterRefusal = false; box.h.stop(); }
    return admitted;
  } });
  const h = box.h = await holderOf(t, { wrapStore });
  addMachineB(h);
  const { grant } = await grantB(h);
  h.targets.machines.set(B, { offline: true });
  const body = send(h, { grant });
  await h.holder.tick();
  await until(() => h.stopped, '拒绝登记后停下');
  const entry = await h.store.get(F1, body.request);
  assert.deepEqual([entry.state, entry.outcome.error.code, entry.call], ['failed', 'target_offline', undefined], 'never an executable entry on disk');
  assert.deepEqual(h.answers(F1, body.request), []);
  // B 回来了，重启：只补签那条拒绝，不提交。
  h.targets.machines.set(B, { offline: false });
  const again = await holderOf(t, { ...h, wrapStore: undefined });
  await again.settle();
  assert.equal(refusedWith(again, body), 'target_offline');
  assert.equal(h.exec.calls.length, 0);
  assert.equal((await refusals(again, 'target_offline')).length, 1);
});

test('a refusal whose admitting write fails leaves nothing on disk and signs nothing; the request is looked at again on the next round', async t => {
  const disk = { failures: 1 };
  const h = await holderOf(t, { wrapStore: store => ({ ...store, admit: input => input.refusal && disk.failures-- > 0 ? Promise.reject(new Error('写不进去')) : store.admit(input) }) });
  addMachineB(h);
  const { grant } = await grantB(h);
  h.targets.machines.set(B, { offline: true });
  const body = send(h, { grant });
  await h.holder.tick();
  assert.equal(await h.store.get(F1, body.request), null);
  assert.deepEqual(h.answers(F1, body.request), []);
  await h.settle();
  assert.equal(refusedWith(h, body), 'target_offline');
  assert.equal(h.exec.calls.length, 0);
});
