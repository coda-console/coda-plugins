// 好友签名网关的持有方（lib/rpc-holder.mjs），在测试宿主里整段跑：签名与撤回经真实的网关内部入口；本机 Accord（coda/accord@1）是替身，
// 能换作者与证书（certificate 为 null 是没绑个人身份、作者是机器钥匙）、注入别人的签名记录、记下本机的发布与撤回、认 expectAuthor；本机 remote-exec 的 exec 也是替身，能控制完成、失败、
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
const ME = key('a'), NEW_ROOT = key('b'), MACHINE_KEY = key('c'), F1 = key('1'), F2 = key('2'), F3 = key('3'), STRANGER = key('9');
const ACTIVE = { active: true, until: 1_900_000_000 }, EXPIRED = { active: false };
const START = Date.UTC(2026, 10, 24, 12, 0, 0), MINUTE = 60_000;
const SPEC = { name: 'box', os: 'linux', user: 'u', cwd: '/home/u' };

const until = async (check, what = '条件') => {
  for (let i = 0; i < 600; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error(`等不到：${what}`);
};
const fail = (code, message, effects = 'none') => Object.assign(new Error(message), { code, effects });

// 本机 Accord：记录按 (作者, kind, id) 存最新版本；本机的发布与撤回（正文为空、受众为空）记在 calls；别人的签名记录用 inject 放进来。
function accordFake({ author = ME, certificate = ACTIVE, friends = [{ node: 'n1', author: F1, bound: true }, { node: 'n2', author: F2, bound: true }, { node: 'n3', author: F3, bound: false }] } = {}) {
  const fake = { author, certificate, friends, records: [], calls: [], queries: [], listeners: new Set(), pageSize: 3 };
  const entry = () => ({ kind: ACCORD, id: 'local', local: true, spec: { author: fake.author }, status: { friends: structuredClone(fake.friends), certificate: fake.certificate } });
  const upsert = (by, kind, id, body, audience, local) => {
    const at = fake.records.findIndex(r => r.author === by && r.kind === kind && r.id === id);
    const version = (at < 0 ? 0 : fake.records[at].version) + 1;
    if (at >= 0) fake.records.splice(at, 1);
    // 受众为空是撤回；null 是没写受众的记录（测拒绝用）。
    if (audience === null || audience.length) fake.records.push({ author: by, kind, id, version, body: structuredClone(body), ...(audience === null ? {} : { audience: [...audience] }), local });
    return version;
  };
  Object.assign(fake, {
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
      if (input.expectAuthor !== fake.author) throw fail('forbidden', '预期作者与此刻署名的作者不符');
      // 没绑个人身份（certificate 为 null）用机器钥匙签，没有有效期；绑了的要证书有效。
      if (fake.certificate !== null && fake.certificate?.active !== true) throw fail('invalid_state', '代签证书已过期');
      fake.calls.push(structuredClone(input));
      const version = upsert(fake.author, input.kind, input.id, input.body, input.audience, true);
      return { author: fake.author, kind: input.kind, id: input.id, version, audience: input.audience };
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
// 给结果对象就完成，给 Error 就失败，给 'hang' 就挂着等 release；中止（signal）时以 interrupted、unknown 失败。
function execFake() {
  const ok = command => ({ exitCode: 0, signal: null, stdout: `ran ${command}`, stderr: '', timedOut: false, truncated: false, outputDir: null, ms: 7 });
  const fake = { calls: [], jobs: new Map(), runs: 0, plan: input => ok(input.command) };
  fake.call = async (ref, operation, input, options = {}) => {
    assert.equal(operation, 'exec');
    fake.calls.push({ ref: structuredClone(ref), input: structuredClone(input), id: options.id, timeout: options.timeout });
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
  fake.release = (id, result = ok(fake.jobs.get(id).input.command)) => fake.jobs.get(id).resolve(result);
  fake.pending = () => [...fake.jobs.values()].filter(job => !job.settled).length;
  // 把还挂着的都放掉，等持有方接着做完；挂着的会再挂起，所以按轮放。
  fake.releaseAll = async settle => { for (let round = 0; round < 4 && fake.pending(); round++) { for (const [id, job] of fake.jobs) if (!job.settled) fake.release(id); await settle(); } };
  return fake;
}

// 本机的目标记录：get 找不到给 not_found；改动告诉 watch（quiet 时不告诉，测「准入时才发现」）。
function targetsFake() {
  const fake = { rows: new Map(), listeners: new Set() };
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
      if (!fake.rows.has(id)) throw fail('not_found', `没有记录 ${id}`);
      return structuredClone(fake.rows.get(id));
    },
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
    get: ref => ref.kind === ACCORD ? accord.get() : ref.kind === MACHINE ? targets.get(ref.id) : host.coda.get(ref),
    query: accord.query,
    call: (ref, operation, input, options) => ref.kind === ACCORD ? accord.call(ref, operation, input) : exec.call(ref, operation, input, options),
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
    timers: shared.timers ?? { setTimeout: () => null, clearTimeout() {} } });
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
function send(h, { from = F1, grant, holder = h.accord.author, ctx = `call-${++counter}`, request = requestId(ctx), input = { command: `echo ${counter}` },
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

// ---- 授予与撤销 ----

test('granting checks the target, the friend and the certificate, pins the target and the author, and publishes the grant to that friend alone', async t => {
  const h = await holderOf(t);
  h.targets.set('other-machine', { owner: 'someone-else', location: 'x', local: false });
  h.targets.set('own-proxy', { plugin: 'friends' });
  const refused = async (input, code = 'invalid_input') => assert.rejects(h.holder.self['grants.grant'](input), error => error.code === code);
  await refused({ friend: F1, target: { kind: MACHINE, id: 'other-machine' } });
  await refused({ friend: F1, target: { kind: MACHINE, id: 'own-proxy' } });
  await refused({ friend: F1, target: { kind: MACHINE, id: 'nope' } }, 'not_found');
  await refused({ friend: F1, target: { kind: 'other/kind@1', id: 'rx-1' } });
  await refused({ friend: F3, target: { kind: MACHINE, id: 'rx-1' } }, 'invalid_input');
  await refused({ friend: STRANGER, target: { kind: MACHINE, id: 'rx-1' } });
  await refused({ friend: 'someone', target: { kind: MACHINE, id: 'rx-1' } });
  await h.accord.change({ certificate: EXPIRED });
  await refused({ friend: F1, target: { kind: MACHINE, id: 'rx-1' } }, 'invalid_state');
  assert.deepEqual(await h.store.listGrants(), []);
  assert.deepEqual(h.published('friends/rpc-grant'), []);

  await h.accord.change({ certificate: ACTIVE });
  const granted = await h.grant();
  assert.equal(granted.status, 'available');
  const [row] = await h.store.listGrants();
  assert.match(row.id, /^[0-9a-f-]{36}$/);
  // 宿主还不写好友表的 certified：被授权者是不是个人作者记 null。
  assert.equal(row.granteePerson, null);
  assert.deepEqual([row.grantee, row.holder, row.target, row.createdAt], [F1, { author: ME, person: true, machine: TEST_OWNER }, { owner: TEST_OWNER, provider: 'remote-exec', kind: MACHINE, id: 'rx-1' }, START]);
  assert.deepEqual(h.published('friends/rpc-grant'), [{ kind: 'friends/rpc-grant', id: row.id, audience: [F1], expectAuthor: ME,
    body: { v: 1, holder: ME, grantee: F1, grant: row.id, protocol: MACHINE, ops: ['exec'], spec: SPEC, available: true, grantedAt: START } }]);
  // 再授一次是新的授权号。
  const again = await h.grant();
  assert.notEqual(again.grant, row.id);
});

test('when the target\'s availability changes the grant record is published again under the same id; nothing changes, nothing is sent', async t => {
  const h = await holderOf(t);
  const { grant } = await h.grant();
  h.targets.set('rx-1', { spec: { ...SPEC, name: 'renamed' } });
  await h.settle();
  assert.equal(h.published('friends/rpc-grant').length, 1, 'only availability is watched');
  h.targets.set('rx-1', { status: { available: false } });
  await h.settle();
  const grants = h.published('friends/rpc-grant');
  assert.equal(grants.length, 2);
  assert.deepEqual([grants[1].id, grants[1].body.available, grants[1].body.spec.name], [grant, false, 'renamed']);
  await h.settle();
  assert.equal(h.published('friends/rpc-grant').length, 2);
});

test('revoking is written to disk first and takes effect even when the retraction cannot be sent; it is sent once the certificate is back', async t => {
  const h = await holderOf(t);
  const { grant } = await h.grant();
  await h.accord.change({ certificate: EXPIRED });
  const revoked = await h.holder.self['grants.revoke']({ grant });
  assert.equal(revoked.status, 'revoked');
  const onDisk = JSON.parse(await readFile(join(h.dir, 'rpc', 'grants.json'), 'utf8')).grants[grant];
  assert.equal(onDisk.revokedAt, START);
  assert.equal(h.accord.calls.length, 1, 'nothing sent while the certificate is out');
  // 撤了的授权不再准入：证书恢复后来的请求被拒。
  await h.accord.change({ certificate: ACTIVE });
  await h.settle();
  assert.deepEqual(h.accord.calls.at(-1), { kind: 'friends/rpc-grant', id: grant, body: {}, audience: [], expectAuthor: ME });
  const body = send(h, { grant });
  await h.settle();
  assert.deepEqual(h.answers(F1, body.request), []);
  assert.equal(h.exec.runs, 0);
  assert.equal((await rejections(h, 'revoked'))[0].count, 1);
  await assert.rejects(h.holder.self['grants.revoke']({ grant: 'no-such-grant' }), error => error.code === 'not_found');
});

test('a grant whose target is gone ends for good: it is no longer admitted, its record is withdrawn and it stays ended when the target returns', async t => {
  const h = await holderOf(t);
  const { grant } = await h.grant();
  h.targets.remove('rx-1');
  await h.settle();
  assert.deepEqual(h.accord.calls.at(-1), { kind: 'friends/rpc-grant', id: grant, body: {}, audience: [], expectAuthor: ME });
  h.targets.set('rx-1');
  await h.settle();
  const { grants } = await h.holder.self['grants.list']();
  assert.deepEqual(grants.map(row => [row.grant, row.status]), [[grant, 'target_missing']]);
  const body = send(h, { grant });
  await h.settle();
  assert.equal(h.exec.runs, 0);
  assert.deepEqual(h.answers(F1, body.request), []);
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
  // 期限到最晚启动时刻加命令时限（再加 remote-exec 自己的 30 秒收尾）。
  assert.equal(h.exec.calls[0].timeout, one.expiresAt - START + 30_000 + 30_000);
  assert.equal(h.exec.calls[1].timeout, two.expiresAt - START + 120_000 + 30_000);
  assert.notEqual(answerId(F1, request), answerId(F2, request));
  for (const [caller, body, text] of [[F1, one, 'ran echo one'], [F2, two, 'ran echo two']]) {
    assert.deepEqual(h.answers(caller, request), ['running', 'completed']);
    const last = h.lastAnswer(caller, request);
    assert.deepEqual([last.audience, last.expectAuthor, last.body.holder, last.body.caller, last.body.grant, last.body.result.stdout],
      [[caller], ME, ME, caller, body.grant, text]);
    assert.equal(last.body.acceptedAt, START);
  }
  // 同号同摘要再看到（下一拍、或别处又发了一遍）：不再执行。
  h.accord.inject({ author: F1, kind: 'friends/rpc-call', id: request, body: one, audience: [ME] });
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

test('revoking: what was submitted runs to its end; what was admitted but not yet submitted never starts', async t => {
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
  for (const one of bodies.slice(0, 4)) h.exec.release(idempotencyKey(F1, one.request));
  await h.settle();
  for (const one of bodies.slice(0, 4)) assert.deepEqual(h.answers(F1, one.request), ['running', 'completed']);
  assert.equal(h.exec.runs, 4, 'the waiting one was never started');
  assert.deepEqual(h.answers(F1, waiting.request), ['running', 'failed']);
  assert.deepEqual(h.lastAnswer(F1, waiting.request).body.error.code, 'revoked');
  assert.equal(h.lastAnswer(F1, waiting.request).body.error.effects, 'none');
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
    ['several', () => send(h, { grant: g1, audience: [ME, F2] }), 'bad_audience', F1],
    ['missing', () => send(h, { grant: g1, audience: null }), 'bad_audience', F1],
    ['to someone else', () => send(h, { grant: g1, audience: [F2], holder: F2 }), 'bad_audience', F1],
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
  assert.deepEqual(merged.map(row => row.count), [5]);
});

test('requests are refused after the author changed, when the friend is unbound, and when the target is no longer remote-exec\'s or no longer there', async t => {
  const h = await holderOf(t);
  const old = (await h.grant(F1)).grant;
  // 换根：旧作者下的授权停用；新根下给 F1 一条授权，F1 拿旧授权号来请求被拒。
  await h.accord.change({ author: NEW_ROOT });
  await h.settle();
  const fresh = (await h.grant(F1)).grant;
  const stale = send(h, { grant: old });
  await h.settle();
  assert.deepEqual(h.answers(F1, stale.request), []);
  assert.equal((await rejections(h, 'author_changed')).length, 1);
  assert.deepEqual((await h.holder.self['grants.list']()).grants.find(row => row.grant === old).status, 'author_changed');

  // 好友绑定没了。
  await h.accord.change({ friends: [{ node: 'n1', author: F1, bound: false }] });
  const unbound = send(h, { grant: fresh });
  await h.settle();
  assert.deepEqual(h.answers(F1, unbound.request), []);
  assert.equal((await rejections(h, 'not_friend')).length, 1);
  await h.accord.change({ friends: [{ node: 'n1', author: F1, bound: true }] });

  // 目标的 provider 变了、目标不在了（准入时才发现）。
  h.targets.set('rx-1', { plugin: 'friends' }, { quiet: true });
  const proxied = send(h, { grant: fresh });
  await h.settle();
  assert.deepEqual(h.answers(F1, proxied.request), []);
  assert.equal((await rejections(h, 'target_changed')).length, 1);
  h.targets.remove('rx-1', { quiet: true });
  const missing = send(h, { grant: fresh });
  await h.settle();
  assert.deepEqual(h.answers(F1, missing.request), []);
  assert.equal((await rejections(h, 'target_missing')).length, 1);
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

  // 已启动：中止那次调用，结局照它的实际结束方式给。
  cancelOf(h, busy[0]);
  await h.settle();
  assert.deepEqual(h.answers(F1, busy[0].request), ['running', 'failed']);
  assert.deepEqual(h.lastAnswer(F1, busy[0].request).body.error, { code: 'interrupted', message: '命令被中止', effects: 'unknown' });
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
  h.accord.inject({ author: F1, kind: 'friends/rpc-call', id: body.request, body, audience: [ME] });
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
  assert.deepEqual(h.accord.calls.at(-1), { kind: 'friends/rpc-answer', id: answerId(F1, body.request), body: {}, audience: [], expectAuthor: ME });
  assert.equal((await h.store.get(F1, body.request)).retracted, true);
  await h.settle();
  assert.equal(h.answers(F1, body.request).length, 3);
  // 再过一天清出在途表。
  h.clock.now += ANSWER_KEEP_MS;
  await h.settle();
  assert.equal(await h.store.get(F1, body.request), null);
});

// ---- 证书 ----

test('without a usable certificate nothing is sent; once it is back the outcome already reached is sent, not running again', async t => {
  const h = await holderOf(t);
  const { grant } = await h.grant();
  const sent = h.accord.calls.length;
  await h.accord.change({ certificate: EXPIRED });
  const late = send(h, { grant });
  await h.settle();
  assert.equal(h.accord.calls.length, sent);
  assert.equal(h.exec.runs, 0, 'not admitted without a certificate');
  await h.accord.change({ certificate: ACTIVE });
  await h.settle();
  assert.deepEqual(h.answers(F1, late.request), ['running', 'completed']);

  h.exec.plan = () => 'hang';
  const body = send(h, { grant });
  await h.settle();
  await h.accord.change({ certificate: EXPIRED });
  h.exec.release(idempotencyKey(F1, body.request));
  await h.settle();
  assert.deepEqual(h.answers(F1, body.request), ['running']);
  assert.equal((await h.store.get(F1, body.request)).state, 'completed');
  await h.accord.change({ certificate: ACTIVE });
  await h.settle();
  assert.deepEqual(h.answers(F1, body.request), ['running', 'completed']);
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

test('the internal retraction only withdraws this author\'s own record of the three kinds, with expectAuthor, and fails plainly without a certificate', async t => {
  const h = await holderOf(t);
  const { grant } = await h.grant();
  const refused = (input, code) => assert.rejects(h.gateway.retractRpc(input), error => error.code === code && error.effects === 'none');
  await refused({ kind: 'friends/dm', id: grant, author: ME }, 'invalid_input');
  await refused({ kind: 'friends/rpc-grant', id: grant, author: 'me' }, 'invalid_input');
  await refused({ kind: 'friends/rpc-grant', id: grant, author: NEW_ROOT }, 'invalid_state');
  const calls = h.accord.calls.length;
  // 本机没署过的：不生成墓碑。
  h.accord.inject({ author: F1, kind: 'friends/rpc-grant', id: 'theirs', body: { x: 1 }, audience: [ME] });
  assert.deepEqual(await h.gateway.retractRpc({ kind: 'friends/rpc-grant', id: 'theirs', author: ME }), { state: 'absent' });
  assert.equal(h.accord.calls.length, calls);
  await h.accord.change({ certificate: EXPIRED });
  await refused({ kind: 'friends/rpc-grant', id: grant, author: ME }, 'invalid_state');
  await h.accord.change({ certificate: ACTIVE });
  assert.equal((await h.gateway.retractRpc({ kind: 'friends/rpc-grant', id: grant, author: ME })).state, 'retracted');
  assert.deepEqual(h.accord.calls.at(-1), { kind: 'friends/rpc-grant', id: grant, body: {}, audience: [], expectAuthor: ME });
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
  assert.deepEqual(h.answers(F1, late.request), ['running', 'failed']);
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
  await h.holder.self['grants.revoke']({ grant });
  assert.deepEqual(h.accord.calls.at(-1), { kind: 'friends/rpc-grant', id: grant, body: {}, audience: [], expectAuthor: ME });
  const calls = h.accord.calls.length;
  h.targets.set('rx-1', { status: { available: false } });
  await h.settle();
  assert.equal(h.accord.calls.length, calls);
});

test('an author change ends a grant for good, written at once; the retraction waits for the original author: A to B and back to A, the grant stays ended', async t => {
  const h = await holderOf(t);
  const { grant } = await h.grant();
  await h.accord.change({ author: NEW_ROOT });
  await h.settle();
  const ended = await h.store.getGrant(grant);
  assert.deepEqual([ended.endedBy, ended.retractedAt], ['author_changed', undefined]);
  assert.equal(h.accord.calls.filter(call => call.id === grant).length, 1, 'the new root does not sign for the old one');
  await h.accord.change({ author: ME });
  await h.settle();
  assert.deepEqual(h.accord.calls.at(-1), { kind: 'friends/rpc-grant', id: grant, body: {}, audience: [], expectAuthor: ME });
  assert.notEqual((await h.store.getGrant(grant)).retractedAt, undefined);
  assert.equal((await h.holder.self['grants.list']()).grants[0].status, 'author_changed');
  const body = send(h, { grant });
  await h.settle();
  assert.deepEqual(h.answers(F1, body.request), []);
  assert.equal(h.exec.runs, 0);
  assert.equal((await rejections(h, 'author_changed')).length, 1);
});

test('a target deleted while the certificate is out ends the grant at once; rebuilt under the same id it does not revive it', async t => {
  const h = await holderOf(t);
  const { grant } = await h.grant();
  await h.accord.change({ certificate: EXPIRED });
  h.targets.remove('rx-1');
  await h.settle();
  h.targets.set('rx-1');
  await h.settle();
  const ended = await h.store.getGrant(grant);
  assert.deepEqual([ended.endedBy, ended.retractedAt], ['target_missing', undefined]);
  await h.accord.change({ certificate: ACTIVE });
  await h.settle();
  assert.deepEqual(h.accord.calls.at(-1), { kind: 'friends/rpc-grant', id: grant, body: {}, audience: [], expectAuthor: ME });
  const body = send(h, { grant });
  await h.settle();
  assert.equal(h.exec.runs, 0);
  assert.deepEqual(h.answers(F1, body.request), []);
});

test('while admission is paused for the certificate, a newer cancel of a known request still aborts the running call', async t => {
  const h = await holderOf(t);
  const { grant } = await h.grant();
  h.exec.plan = () => 'hang';
  const body = send(h, { grant });
  await h.settle();
  // 同一版本再看到、或同号的旧内容：不算取消。
  h.accord.inject({ author: F1, kind: 'friends/rpc-call', id: body.request, body, audience: [ME] });
  await h.accord.change({ certificate: EXPIRED });
  await h.settle();
  assert.equal(h.exec.pending(), 1, 'still running');
  cancelOf(h, body);
  await h.settle();
  assert.equal(h.exec.pending(), 0, 'aborted');
  assert.equal((await h.store.get(F1, body.request)).state, 'failed');
  assert.deepEqual(h.answers(F1, body.request), ['running'], 'nothing is sent without a certificate');
  await h.accord.change({ certificate: ACTIVE });
  await h.settle();
  assert.deepEqual(h.answers(F1, body.request), ['running', 'failed']);
  assert.equal(h.lastAnswer(F1, body.request).body.error.code, 'interrupted');
});

test('an outcome that could not be signed is kept past its expiry plus 24 hours and signed when the certificate returns', async t => {
  const h = await holderOf(t);
  const { grant } = await h.grant();
  h.exec.plan = () => 'hang';
  const body = send(h, { grant });
  await h.settle();
  await h.accord.change({ certificate: EXPIRED });
  h.exec.release(idempotencyKey(F1, body.request));
  await h.settle();
  h.clock.now = body.expiresAt + ANSWER_KEEP_MS + 60 * MINUTE;
  await h.settle();
  assert.equal((await h.store.get(F1, body.request))?.state, 'completed');
  await h.accord.change({ certificate: ACTIVE });
  await h.settle();
  // 补签出结局；这时已过终态 24 小时，随后照规则撤回。
  assert.deepEqual(h.answers(F1, body.request), ['running', 'completed', 'retracted']);
});

test('after a shutdown across the expiry plus 24 hours a submitted request is still there on restart and recovers', async t => {
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
  assert.deepEqual(again.answers(F1, body.request), ['running', 'completed']);
  assert.equal(h.exec.runs, 1);
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
    const again = await holderOf(t, { ...h, wrapStore: undefined });
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

test('the events themselves end the grants: A to B and back to A, or a delete followed at once by a rebuild under the same id, before anything is looked up again', async t => {
  const h = await holderOf(t);
  const { grant } = await h.grant();
  // 不等任何一拍：换到 B 的那个事件里就把 A 授出的授权写成失效，马上又换回 A。
  h.accord.change({ author: NEW_ROOT });
  await h.accord.change({ author: ME });
  const body = send(h, { grant });
  await h.settle();
  assert.equal(h.exec.runs, 0);
  assert.deepEqual(h.answers(F1, body.request), []);
  assert.equal((await h.store.getGrant(grant)).endedBy, 'author_changed');
  // 之后的补查只补撤回：A 能签，撤回发了。
  assert.deepEqual(h.accord.calls.at(-1), { kind: 'friends/rpc-grant', id: grant, body: {}, audience: [], expectAuthor: ME });

  // 删除的事件里就让指向它的授权失效；同 id、同 owner、同 provider 马上重建出来也不再生效。
  const second = (await h.grant()).grant;
  h.targets.remove('rx-1');
  h.targets.set('rx-1');
  const late = send(h, { grant: second });
  await h.settle();
  assert.equal(h.exec.runs, 0);
  assert.deepEqual(h.answers(F1, late.request), []);
  assert.equal((await h.store.getGrant(second)).endedBy, 'target_missing');
  assert.deepEqual(h.accord.calls.at(-1), { kind: 'friends/rpc-grant', id: second, body: {}, audience: [], expectAuthor: ME });
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

test('an ending that fails to reach the disk is kept in memory: back on the old author its grant is refused, and once the disk recovers the ending is written and dropped from memory', async t => {
  // 定时器替身：兜底查询（15 秒）不走，别的（失效落盘的重试）由测试放行。
  const retries = [];
  const timers = { setTimeout: (fn, ms) => { if (ms !== POLL_MS) retries.push(fn); return null; }, clearTimeout() {} };
  const disk = { failing: true };
  const failing = write => (...args) => disk.failing ? Promise.reject(new Error('写不进去')) : write(...args);
  const h = await holderOf(t, { timers, wrapStore: store => ({ ...store, endGrants: failing(store.endGrants), revokeGrant: failing(store.revokeGrant) }) });
  const { grant } = await h.grant();
  h.accord.change({ author: NEW_ROOT });
  await h.accord.change({ author: ME });
  const body = send(h, { grant });
  await h.settle();
  assert.equal(h.exec.runs, 0);
  assert.deepEqual(h.answers(F1, body.request), []);
  assert.equal((await h.store.getGrant(grant)).revokedAt, undefined, 'not on disk yet');
  // A→B 记下旧作者 A 的一笔，B→A 记下旧作者 B 的一笔（没有授权，同样等落盘）。
  assert.equal(h.holder.pendingEnds(), 2);
  assert.equal(h.published('friends/rpc-grant').length, 1, 'neither published again nor withdrawn while the ending is not on disk');
  assert.ok(retries.length >= 1, 'a retry is scheduled');
  // 事件之后才授出的授权不归这笔失效管。
  const later = (await h.grant()).grant;

  disk.failing = false;
  for (const retry of retries.splice(0)) retry();
  await until(async () => (await h.store.getGrant(grant)).endedBy === 'author_changed', '失效落盘');
  await h.settle();
  assert.equal(h.holder.pendingEnds(), 0);
  assert.deepEqual(h.accord.calls.at(-1), { kind: 'friends/rpc-grant', id: grant, body: {}, audience: [], expectAuthor: ME });
  assert.equal((await h.store.getGrant(later)).revokedAt, undefined);
  const again = send(h, { grant });
  await h.settle();
  assert.deepEqual(h.answers(F1, again.request), []);
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
  for (const [what, code] of [['target', 'target_missing'], ['root', 'author_changed']]) {
    let fire = null;
    // markSubmitted 进了 store 的队、还没轮到时，来一个删除再重建（或 A→B→A）的事件。
    const disk = failingDisk(store => ({ markSubmitted: (...args) => { const run = store.markSubmitted(...args); fire?.(); fire = null; return run; } }));
    disk.failing = false;
    const h = await holderOf(t, disk);
    const { grant } = await h.grant();
    disk.failing = true;
    fire = what === 'target' ? () => { h.targets.remove('rx-1'); h.targets.set('rx-1'); } : () => { h.accord.change({ author: NEW_ROOT }); h.accord.change({ author: ME }); };
    const body = send(h, { grant });
    await h.settle();
    assert.equal(fire, null, `${what}: the event fired`);
    assert.equal(h.exec.runs, 0, what);
    assert.deepEqual(h.answers(F1, body.request), ['running', 'failed'], what);
    assert.equal(h.lastAnswer(F1, body.request).body.error.code, code, what);
    assert.equal((await h.store.getGrant(grant)).revokedAt, undefined, `${what}: not on disk yet`);
  }
});

test('the same ending key seen twice keeps one retry: delete, rebuild, delete, rebuild (or A to B and back, twice) with both writes failing; once the disk recovers the old grants end and the newest stays', async t => {
  for (const what of ['target', 'root']) {
    const disk = failingDisk(() => ({}));
    const h = await holderOf(t, disk);
    const flip = what === 'target' ? async () => { h.targets.remove('rx-1'); h.targets.set('rx-1'); }
      : async () => { h.accord.change({ author: NEW_ROOT }); await h.accord.change({ author: ME }); };
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

test('an ending not yet on disk keeps a grant record from being published and shows in grants.list: a delete during the directory lookup, a rebuild under the same id, a return to the old author', async t => {
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
  h.accord.change({ author: NEW_ROOT });
  await h.accord.change({ author: ME });
  await h.settle();
  assert.equal((await h.store.getGrant(second)).revokedAt, undefined, 'not on disk yet');
  assert.equal(await status(second), 'author_changed');
});

// ---- 作者：机器钥匙与个人身份 ----

// F1 是个人作者（绑了个人身份、证书有效），F2 是机器作者；`certified` 是好友表里说的（coda#3012）。
const PERSON_AND_MACHINE = [{ node: 'n1', author: F1, bound: true, certified: true }, { node: 'n2', author: F2, bound: true, certified: false }];

test('a holder with no personal identity grants, takes requests, runs them and answers with its machine key, to a personal caller and a machine caller alike', async t => {
  const h = await holderOf(t, { accordOptions: { author: MACHINE_KEY, certificate: null, friends: PERSON_AND_MACHINE } });
  const person = await h.grant(F1), machine = await h.grant(F2);
  assert.deepEqual([person.status, machine.status], ['available', 'available']);
  const rows = Object.fromEntries((await h.store.listGrants()).map(row => [row.grantee, row]));
  assert.deepEqual([rows[F1].holder, rows[F1].granteePerson, rows[F2].granteePerson], [{ author: MACHINE_KEY, person: false, machine: TEST_OWNER }, true, false]);
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

test('a personal caller whose certificate expired is no longer bound, and its request is refused', async t => {
  const h = await holderOf(t, { accordOptions: { author: MACHINE_KEY, certificate: null, friends: PERSON_AND_MACHINE } });
  const { grant } = await h.grant(F1);
  // 替身照基座的做法：调用方的证书过期，它的好友绑定判为未绑定。
  await h.accord.change({ friends: [{ ...PERSON_AND_MACHINE[0], bound: false }, PERSON_AND_MACHINE[1]] });
  const body = send(h, { from: F1, grant });
  await h.settle();
  assert.equal(h.exec.runs, 0);
  assert.deepEqual(h.answers(F1, body.request), []);
  assert.equal((await rejections(h, 'not_friend')).length, 1);
});

test('binding a personal identity (machine key to root) and unbinding it again each end the grants made under the author before, at once; requests on them are refused and their retraction waits for that author', async t => {
  const h = await holderOf(t, { accordOptions: { author: MACHINE_KEY, certificate: null } });
  const first = (await h.grant(F1)).grant;
  // 绑了个人身份：作者从机器钥匙变成根，事件里就失效落盘。
  await h.accord.change({ author: ME, certificate: ACTIVE });
  await until(async () => (await h.store.getGrant(first)).endedBy === 'author_changed', '绑定后失效落盘');
  await h.settle();
  const second = (await h.grant(F1)).grant;
  assert.deepEqual((await h.store.getGrant(second)).holder, { author: ME, person: true, machine: TEST_OWNER });
  const stale = send(h, { grant: first });
  await h.settle();
  assert.equal(h.exec.runs, 0);
  assert.deepEqual(h.answers(F1, stale.request), []);
  assert.equal((await rejections(h, 'author_changed')).length, 1);
  assert.equal((await h.store.getGrant(first)).retractedAt, undefined, 'the root does not sign the machine key\'s retraction');
  assert.equal(h.accord.calls.filter(call => call.id === first).length, 1);
  assert.equal((await h.holder.self['grants.list']()).grants.find(row => row.grant === first).status, 'author_changed');

  // 解绑：作者从根变回机器钥匙。根下的授权同样失效、撤回待补；机器钥匙这时能签，补上第一条授权的撤回。
  await h.accord.change({ author: MACHINE_KEY, certificate: null });
  await until(async () => (await h.store.getGrant(second)).endedBy === 'author_changed', '解绑后失效落盘');
  await h.settle();
  assert.equal((await h.store.getGrant(second)).retractedAt, undefined);
  assert.equal(h.accord.calls.filter(call => call.id === second).length, 1);
  assert.notEqual((await h.store.getGrant(first)).retractedAt, undefined);
  assert.deepEqual(h.accord.calls.filter(call => call.id === first).at(-1), { kind: 'friends/rpc-grant', id: first, body: {}, audience: [], expectAuthor: MACHINE_KEY });
  const again = send(h, { grant: second });
  await h.settle();
  assert.equal(h.exec.runs, 0);
  assert.deepEqual(h.answers(F1, again.request), []);
  // 同一作者、同一原因、同一分钟合成一行计数。
  assert.deepEqual((await rejections(h, 'author_changed')).map(row => row.count), [2]);
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
  await accord.change({ certificate: EXPIRED });
  assert.deepEqual(await status(), [[F1, 'needs_cert'], [F2, 'needs_cert']]);
  await accord.change({ certificate: ACTIVE });
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
