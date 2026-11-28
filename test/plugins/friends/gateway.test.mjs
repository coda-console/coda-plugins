// 好友社交网关 friends/social@1，在测试宿主里整段跑：模块照真实方式激活、操作经协议校验调用；本机 Accord（coda/accord@1）是个替身，
// 记下每次查询与发布，能换身份与证书、一页页吐记录，并像 Coda 一样把变化告诉 watch。
import { createMockCoda } from '../../helpers/mock-coda.mjs';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { activate, deactivate } from '../../../plugins/friends/main.mjs';
import { createGateway } from '../../../plugins/friends/lib/gateway.mjs';
import { canonicalHash, entryKey, markSynced, queuePublish, queueRetract, retractKey } from '../../../plugins/friends/lib/outbox.mjs';
import { XS_A as XS, XS_B as XS_FAR, ZYV, titleOf as identityTitle } from '../../helpers/accord-keys.mjs';
import { definitionProblem } from '@coda-console/protocol/protocol';

const manifest = JSON.parse(await readFile(new URL('../../../plugins/friends/package.json', import.meta.url), 'utf8'));
const SOCIAL = 'friends/social@1';
const A = `ed25519:${'a'.repeat(64)}`, B = `ed25519:${'b'.repeat(64)}`, MK = `ed25519:${'c'.repeat(64)}`, F1 = `ed25519:${'1'.repeat(64)}`, F2 = `ed25519:${'2'.repeat(64)}`, F3 = `ed25519:${'3'.repeat(64)}`;
const RESERVED = ['binding', 'profile', 'friends', 'coda/profile', 'coda/friends', 'friends/card'];
const ACTIVE = { active: true, until: 1_900_000_000 }, EXPIRED = { active: false };

const until = async (check, what = '条件') => {
  for (let i = 0; i < 400; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error(`等不到：${what}`);
};

// 本机的 Accord：身份与证书可换，记录按页吐（cursor 是下标），发布记下来；过期的证书发布会失败（invalid_state）。
// `machine` 是本机的机器钥匙：绑了个人身份时在 `status.certificate.key`，没绑（certificate 为 null）时就是作者；`signer: "machine"` 用它签，不看证书。
function accordFake({ author = A, certificate = ACTIVE, machine = MK, friends = [], pageSize = 2 } = {}) {
  const fake = { author, certificate, machine, friends, pageSize, records: [], queries: [], calls: [], listeners: new Set(), failure: null, loop: false, withCertificateKey: true, gets: 0, getGate: null, callGate: null, onCall: null, queryGate: null, queryFailure: null };
  const certificateOf = () => fake.certificate === null ? null : { ...fake.certificate, key: fake.machine };
  const entry = () => ({ kind: 'coda/accord@1', id: 'local', local: true, spec: { author: fake.author },
    status: { friends: structuredClone(fake.friends), ...(fake.withCertificateKey ? { certificate: certificateOf() } : {}) } });
  Object.assign(fake, {
    entry,
    get: async () => { fake.gets++; await fake.getGate; return structuredClone(entry()); },
    async change(next) {
      Object.assign(fake, next);
      for (const listener of [...fake.listeners]) await listener({ type: 'MODIFIED', id: 'local', entry: structuredClone(entry()) });
    },
    seed: (kind, ids, { author: by = fake.author, local = true } = {}) => { for (const id of ids) fake.records.push({ author: by, kind, id, version: 1, body: { id }, local }); },
    query: async (ref, operation, input) => {
      assert.deepEqual([ref.kind, operation], ['coda/accord@1', 'records']);
      fake.queries.push(structuredClone(input));
      await fake.queryGate;
      if (fake.queryFailure) throw fake.queryFailure;
      if (fake.loop) return { records: [], truncated: true, nextCursor: 'same' };
      const rows = fake.records.filter(r => r.kind === input.kind && (input.author === undefined || r.author === input.author) && (input.id === undefined || r.id === input.id));
      const from = Number(input.cursor ?? 0), page = rows.slice(from, from + fake.pageSize), more = from + fake.pageSize < rows.length;
      return { records: structuredClone(page), truncated: more, ...(more ? { nextCursor: String(from + fake.pageSize) } : {}) };
    },
    call: async (ref, operation, input) => {
      assert.deepEqual([ref.kind, ref.id, operation], ['coda/accord@1', 'local', 'publish']);
      fake.calls.push(structuredClone(input));
      await fake.onCall?.();
      await fake.callGate;
      // 基座的 `signer: "machine"`（coda#3018）：用机器钥匙签、不看证书，只许签调用插件自己命名空间的种类。
      const byMachine = input.signer === 'machine', signer = byMachine ? (fake.certificate === null ? fake.author : fake.machine) : fake.author;
      if (byMachine && !input.kind.startsWith('friends/')) throw Object.assign(new Error('只能签自己命名空间的种类'), { code: 'forbidden' });
      // 「预期作者」：给了就必须与此刻真正署名的作者相同，否则拒签。
      if (input.expectAuthor !== undefined && input.expectAuthor !== signer) throw Object.assign(new Error('预期作者与此刻署名的作者不符'), { code: 'forbidden' });
      if (fake.failure) throw fake.failure;
      // 没绑个人身份（certificate 为 null）用机器钥匙签，没有有效期；绑了的要证书有效。
      if (!byMachine && fake.certificate !== null && fake.certificate?.active !== true) throw Object.assign(new Error('代签证书已过期'), { code: 'invalid_state' });
      const at = fake.records.findIndex(r => r.kind === input.kind && r.id === input.id && r.author === signer);
      const version = (at < 0 ? 0 : fake.records[at].version) + 1;
      if (at >= 0) fake.records.splice(at, 1);
      if (input.audience.length) fake.records.push({ author: signer, kind: input.kind, id: input.id, version, body: input.body, local: true });
      return { author: signer, kind: input.kind, id: input.id, version, audience: input.audience };
    },
    watch: async (name, listener, selector) => {
      assert.deepEqual([name, selector], ['coda/accord@1', { id: 'local' }]);
      fake.listeners.add(listener);
      await listener({ type: 'ADDED', id: 'local', entry: structuredClone(entry()) });
      return { dispose: () => fake.listeners.delete(listener) };
    },
  });
  return fake;
}

async function gateway(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'friends-gateway-'));
  const accord = accordFake(options), host = createMockCoda({ plugin: { id: 'friends', state: dir, protocols: manifest.contributes.protocols, protocolImplementations: manifest.contributes.protocolImplementations } });
  t.after(async () => { deactivate(); await host.close(); await rm(dir, { recursive: true, force: true }); });
  // 网关用到的 Accord 读写走替身；写自己的网关记录、登记处理函数走测试宿主。
  await activate({ ...host.coda, get: ref => ref.kind === 'coda/accord@1' ? accord.get() : host.coda.get(ref), query: accord.query, call: accord.call, watch: accord.watch });
  const [local] = await host.coda.list(SOCIAL, { scope: 'local' }), ref = { kind: SOCIAL, id: local.id };
  const call = (operation, input = {}) => host.call(ref, operation, input);
  const status = async () => (await host.coda.list(SOCIAL, { scope: 'local' }))[0].status;
  const outbox = async () => JSON.parse(await readFile(join(dir, 'outbox.json'), 'utf8').catch(() => '{}')).entries ?? {};
  return { dir, accord, host, ref, call, status, outbox, publish: input => call('publish', input), retract: input => call('retract', input), self: (name, input) => host.self(name, input) };
}
const rejects = (promise, code = 'invalid_input') => assert.rejects(promise, error => error.code === code);

test('activating writes this machine\'s gateway record, and its status follows the identity, the friends and the queue', async t => {
  const g = await gateway(t, { friends: [{ node: 'n1', author: F1, bound: true }, { node: 'n2', author: F2, bound: true }, { node: 'n3', author: F3, bound: false }, { node: 'n4', bound: false }] });
  const records = await g.host.coda.list(SOCIAL, { scope: 'local' });
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].spec, { version: 1 });
  assert.deepEqual(records[0].status, { author: A, certState: 'active', certUntil: 1_900_000_000, friendCount: 2, pendingCount: 0, pausedKinds: [] });
  await g.accord.change({ certificate: EXPIRED });
  await until(async () => (await g.status()).certState === 'needs_cert', '证书过期写进网关记录');
  assert.deepEqual(await g.status(), { author: A, certState: 'needs_cert', friendCount: 2, pendingCount: 0, pausedKinds: [] });
  await g.accord.change({ author: null, certificate: null, friends: [] });
  await until(async () => (await g.status()).certState === 'no_identity', '没有身份写进网关记录');
  assert.deepEqual(await g.status(), { author: null, certState: 'no_identity', friendCount: 0, pendingCount: 0, pausedKinds: [] });
});

test('activating also writes this machine\'s friends/machine@1 record for the directory page, only what the page reads, and rewrites it only when that changes', async t => {
  const g = await gateway(t, { certificate: { ...ACTIVE, sig: 'SIG' }, friends: [{ node: 'n1', author: F1, bound: true, authKey: 'tskey-secret', updatedAt: 3 }] });
  const read = async () => await g.host.coda.list('friends/machine@1', { scope: 'local' });
  await until(async () => (await read()).length === 1, '启动时写出目录记录');
  const [record] = await read();
  assert.deepEqual(record.spec, { author: A });
  assert.deepEqual(record.status, { friends: [{ node: 'n1', author: F1, bound: true, updatedAt: 3 }], certificate: { key: MK, active: true, until: 1_900_000_000 }, networkRemovals: [] });
  assert.ok(!JSON.stringify(record).includes('SIG') && !JSON.stringify(record).includes('tskey-secret'));
  await g.accord.change({ friends: [{ node: 'n1', author: F1, bound: true, authKey: 'tskey-secret', updatedAt: 3 }, { node: 'n2', author: F2, bound: false }] });
  await until(async () => (await read())[0].status.friends.length === 2, '好友变了跟着改');
  await g.accord.change({ author: null, certificate: null, friends: [] });
  await until(async () => (await read())[0].spec.author === null, '没有身份也写一条');
  assert.deepEqual((await read())[0].status, { friends: [], certificate: null, networkRemovals: [] });
});

test('friends titles lengthen when two friends, or a friend and this machine\'s own identity, share a nickname and their last 4 digits', async t => {
  const g = await gateway(t, { friends: [{ node: 'n1', author: XS, bound: true, updatedAt: 2 }, { node: 'n2', author: XS_FAR, bound: true, updatedAt: 1 }, { node: 'n3', author: ZYV, bound: true, updatedAt: 0 }] });
  assert.deepEqual((await g.call('friends')).friends.map(row => [row.node, row.title]), [['n1', 'xs #04084'], ['n2', 'xs #14084'], ['n3', 'zyv #4103']]);
  await g.accord.change({ friends: [{ node: 'n2', author: XS_FAR, bound: true }] });
  assert.deepEqual((await g.call('friends')).friends.map(row => row.title), ['xs #4084']);
  await g.accord.change({ author: XS });
  assert.deepEqual((await g.call('friends')).friends.map(row => row.title), ['xs #14084']);
});

test('friends comes from the friend table alone, titled by each key, and shows pending friends only when asked', async t => {
  const g = await gateway(t, { friends: [{ node: 'n1', author: F1, bound: true, scope: 's', updatedAt: 5 }, { node: 'n2', author: F2, bound: true, scope: 's', updatedAt: 9 },
    { node: 'n3', author: F3, bound: false, scope: 's', updatedAt: 1 }, { node: 'n4', bound: false, updatedAt: 0 }] });
  // 旧版名片与备注留着也不再读：这些记录和 notes.json 不影响结果。
  g.accord.records.push({ author: F1, kind: 'profile', id: 'self', version: 1, body: { name: '小一' } }, { author: F1, kind: 'friends/card', id: 'self', version: 1, body: { name: '卡一' } });
  await writeFile(join(g.dir, 'notes.json'), JSON.stringify({ n1: '老王' }));
  const result = await g.call('friends');
  assert.deepEqual(Object.keys(result).sort(), ['certState', 'friends', 'selfAuthor']);
  assert.deepEqual([result.selfAuthor, result.certState], [A, 'active']);
  assert.deepEqual(result.friends.map(row => [row.node, row.status, row.title]), [['n2', 'bound', identityTitle(F2, 'n2')], ['n1', 'bound', identityTitle(F1, 'n1')]]);
  for (const row of result.friends) for (const dropped of ['note', 'profileName', 'emoji', 'color', 'avatar']) assert.ok(!(dropped in row), dropped);
  // 持有方启动时按作者读一次本机的授权记录（friends/rpc-grant），与 friends 无关，不算。
  const asked = () => g.accord.queries.filter(query => !query.kind.startsWith('friends/rpc-'));
  assert.deepEqual(asked(), [], 'friends never asks Accord for records');
  const all = await g.call('friends', { includePending: true });
  assert.deepEqual(all.friends.map(row => [row.node, row.status, row.title]), [['n3', 'pending', identityTitle(F3, 'n3')], ['n4', 'pending', 'n4'], ['n2', 'bound', identityTitle(F2, 'n2')], ['n1', 'bound', identityTitle(F1, 'n1')]]);
  assert.deepEqual(asked(), []);
  await g.accord.change({ author: null, certificate: null, friends: [] });
  assert.deepEqual(await g.call('friends', { includePending: true }), { selfAuthor: null, certState: 'no_identity', friends: [] });
});

test('records passes id, cursor, limit and includeAudience through to Accord and gives its answer back, but refuses binding', async t => {
  const g = await gateway(t, { pageSize: 1 });
  g.accord.seed('x', ['i1', 'i2', 'i3'], { author: B, local: false });
  const input = { kind: 'x', author: B, limit: 1, cursor: '1', includeAudience: true };
  const page = await g.call('records', input);
  assert.deepEqual(g.accord.queries, [input]);
  assert.deepEqual([page.records.map(r => r.id), page.truncated, page.nextCursor], [['i2'], true, '2']);
  const one = await g.call('records', { kind: 'x', id: 'i3' });
  assert.deepEqual(g.accord.queries.at(-1), { kind: 'x', id: 'i3' });
  assert.deepEqual(one.records.map(r => r.id), ['i3']);
  const before = g.accord.queries.length;
  await rejects(g.call('records', { kind: 'binding' }));
  await rejects(g.call('records', { kind: 'binding', author: A, limit: 5 }));
  await rejects(g.call('records', { kind: 'x', id: '好'.repeat(86) }));
  assert.equal(g.accord.queries.length, before, 'a refused query never reaches Accord');
  // 其他保留类型的记录可以读：名片是好友分享的。
  await g.call('records', { kind: 'profile' });
  assert.equal(g.accord.queries.at(-1).kind, 'profile');
});

test('publish refuses the six reserved kinds; a good one is synced and its body released, the same content is skipped, a new author sends it again', async t => {
  const g = await gateway(t);
  for (const kind of RESERVED) await rejects(g.publish({ kind, id: 'self', body: { name: 'x' } }));
  await rejects(g.publish({ kind: 'x', id: 'i', body: [] }));
  assert.deepEqual(g.accord.calls, []);
  assert.deepEqual(await g.outbox(), {});

  assert.deepEqual(await g.publish({ kind: 'x', id: 'i', body: { b: 1, a: { d: 2, c: 3 } } }), { state: 'synced', author: A, version: 1 });
  assert.deepEqual(g.accord.calls, [{ kind: 'x', id: 'i', body: { b: 1, a: { d: 2, c: 3 } }, audience: ['public'] }]);
  const stored = await g.outbox();
  assert.deepEqual(Object.keys(stored), ['p:x:i']);
  assert.equal(stored['p:x:i'].state, 'synced');
  assert.equal(stored['p:x:i'].lastAuthor, A);
  assert.equal(JSON.stringify(stored).includes('"body"'), false, 'no body is kept once it is synced');

  // 键序不同的同一内容、同一个作者：不再发。
  assert.deepEqual(await g.publish({ kind: 'x', id: 'i', body: { a: { c: 3, d: 2 }, b: 1 } }), { state: 'synced', skipped: true, author: A });
  assert.equal(g.accord.calls.length, 1);
  await g.publish({ kind: 'x', id: 'i', body: { v: 2 } });
  assert.equal(g.accord.calls.length, 2);
  // 受众不同也是新内容。
  await g.publish({ kind: 'x', id: 'i', body: { v: 2 }, audience: [B] });
  assert.equal(g.accord.calls.length, 3);

  await g.accord.change({ author: B });
  assert.deepEqual(await g.publish({ kind: 'x', id: 'i', body: { v: 2 }, audience: [B] }), { state: 'synced', author: B, version: 1 });
  assert.equal(g.accord.calls.length, 4, 'the same content under another author is published again');
  assert.equal((await g.outbox())['p:x:i'].lastAuthor, B);
});

test('with no identity or an expired certificate a publish waits in the outbox with its body, and goes out by itself once the certificate is active', async t => {
  const g = await gateway(t, { author: null, certificate: null });
  assert.deepEqual(await g.publish({ kind: 'x', id: 'one', body: { n: 1 } }), { state: 'no_identity', author: null });
  assert.deepEqual(g.accord.calls, []);
  assert.equal((await g.outbox())['p:x:one'].body.n, 1);
  assert.equal((await g.status()).pendingCount, 1);

  await g.accord.change({ author: A, certificate: EXPIRED });
  assert.deepEqual(await g.publish({ kind: 'x', id: 'two', body: { n: 2 } }), { state: 'needs_cert', author: A });
  assert.deepEqual(g.accord.calls, []);

  // 旧宿主没有 certificate 这个键：看作者当可发布，发布遇 invalid_state 再落到需要证书。
  // 看着可发布了，网关就试着冲洗，第一条遇到 invalid_state 即停。
  await g.accord.change({ withCertificateKey: false });
  await until(() => g.accord.calls.length === 1, '旧宿主的冲洗试发了一条');
  const late = await g.publish({ kind: 'x', id: 'three', body: { n: 3 } });
  assert.equal(late.state, 'needs_cert');
  assert.match(late.error, /过期/);
  assert.equal(g.accord.calls.length, 2);
  const waiting = await g.call('outbox');
  assert.deepEqual([waiting.pendingCount, waiting.certState, waiting.author], [3, 'active', A]);
  assert.deepEqual(waiting.items.map(item => [item.id, item.state]), [['one', 'needs_cert'], ['two', 'needs_cert'], ['three', 'needs_cert']]);
  assert.equal(JSON.stringify(waiting).includes('"body"'), false, 'the outbox operation never shows a body');
  assert.equal((await g.status()).pendingCount, 3);

  g.accord.calls.length = 0;
  await g.accord.change({ withCertificateKey: true, certificate: ACTIVE });
  await until(async () => (await g.status()).pendingCount === 0, '证书恢复后冲洗完');
  assert.deepEqual(g.accord.calls.map(c => [c.id, c.body.n]).sort(), [['one', 1], ['three', 3], ['two', 2]]);
  const after = await g.outbox();
  assert.deepEqual(Object.values(after).map(entry => entry.state), ['synced', 'synced', 'synced']);
  assert.equal(JSON.stringify(after).includes('"body"'), false);
  assert.deepEqual((await g.call('outbox')).items.every(item => item.state === 'synced' && item.lastSyncedAt > 0), true);
});

test('a failed publish waits in the outbox as queued and is sent by the next flush; one Accord refuses outright is reported and not kept', async t => {
  const g = await gateway(t);
  g.accord.failure = new Error('连不上');
  assert.deepEqual(await g.publish({ kind: 'x', id: 'i', body: { v: 1 } }), { state: 'queued', author: A, error: '连不上' });
  assert.deepEqual((await g.call('outbox')).items.map(item => [item.state, item.lastError]), [['queued', '连不上']]);
  g.accord.failure = Object.assign(new Error('太大'), { code: 'invalid_input' });
  assert.deepEqual(await g.publish({ kind: 'y', id: 'j', body: { v: 1 } }), { state: 'error', author: A, error: '太大' });
  assert.deepEqual(Object.keys(await g.outbox()), ['p:x:i']);
  g.accord.failure = null;
  await g.accord.change({ friends: [{ node: 'n1', author: F1, bound: true }] });
  await until(async () => (await g.status()).pendingCount === 0, '下一次变化冲洗掉排队的发布');
  assert.equal((await g.outbox())['p:x:i'].state, 'synced');
});

test('retract withdraws one record with an empty body and no audience, and forgets its outbox entry', async t => {
  const g = await gateway(t);
  await g.publish({ kind: 'x', id: 'i', body: { v: 1 } });
  await g.publish({ kind: 'x', id: 'k', body: { v: 1 } });
  for (const kind of RESERVED) await rejects(g.retract({ kind, id: 'self' }));
  await rejects(g.retract({ kind: 'binding' }));
  assert.deepEqual(await g.retract({ kind: 'x', id: 'i' }), { state: 'retracted', count: 1 });
  assert.deepEqual(g.accord.calls.at(-1), { kind: 'x', id: 'i', body: {}, audience: [] });
  assert.deepEqual(Object.keys(await g.outbox()), ['p:x:k']);
  // 之后同样的内容可以再发：条目没了，不会被当成已同步。
  assert.equal((await g.publish({ kind: 'x', id: 'i', body: { v: 1 } })).state, 'synced');
  assert.equal(g.accord.calls.at(-1).audience.length, 1);
  // 网关没记过的记录：先问 Accord 本机有没有，有才撤；没有就什么也不发。
  g.accord.seed('z', ['old']);
  assert.deepEqual(await g.retract({ kind: 'z', id: 'old' }), { state: 'retracted', count: 1 });
  assert.deepEqual(g.accord.queries.at(-1), { kind: 'z', author: A, id: 'old', limit: 1 });
  assert.deepEqual(g.accord.calls.at(-1), { kind: 'z', id: 'old', body: {}, audience: [] });
  const sent = g.accord.calls.length;
  assert.deepEqual(await g.retract({ kind: 'z', id: 'old' }), { state: 'retracted', count: 0 });
  assert.equal(g.accord.calls.length, sent, 'Accord has nothing of it, so nothing is withdrawn');
});

test('retract without an id withdraws every record of the kind across pages, plus what the outbox still holds; an expired certificate queues it and the recovery finishes it', async t => {
  const g = await gateway(t);
  g.accord.seed('x', ['r1', 'r2', 'r3', 'r4', 'r5']);
  g.accord.seed('x', ['theirs'], { author: B, local: false });
  g.accord.seed('y', ['other']);
  await g.accord.change({ certificate: EXPIRED });
  await g.publish({ kind: 'x', id: 'waiting', body: { v: 1 } });
  await g.publish({ kind: 'y', id: 'keep', body: { v: 1 } });
  g.accord.queries.length = 0;
  const queued = await g.retract({ kind: 'x' });
  assert.deepEqual(queued, { state: 'needs_cert', count: 1, queued: 5 });
  assert.deepEqual(g.accord.queries.map(q => [q.kind, q.author, q.limit, q.cursor]), [['x', A, 200, undefined], ['x', A, 200, '2'], ['x', A, 200, '4']]);
  assert.deepEqual(g.accord.calls, [], 'nothing is sent with an expired certificate');
  const items = (await g.call('outbox')).items;
  assert.deepEqual(items.filter(item => item.desired === 'retract').map(item => item.id).sort(), ['r1', 'r2', 'r3', 'r4', 'r5']);
  assert.deepEqual(items.filter(item => item.kind === 'y').map(item => [item.desired, item.state]), [['publish', 'needs_cert']]);
  assert.equal((await g.call('outbox', { kind: 'x' })).items.length, 5);
  assert.equal((await g.status()).pendingCount, 6);

  await g.accord.change({ certificate: ACTIVE });
  await until(async () => (await g.status()).pendingCount === 0, '证书恢复后补撤完成');
  assert.deepEqual(g.accord.calls.filter(c => c.kind === 'x').map(c => c.id).sort(), ['r1', 'r2', 'r3', 'r4', 'r5']);
  assert.ok(g.accord.calls.filter(c => c.kind === 'x').every(c => c.audience.length === 0 && Object.keys(c.body).length === 0));
  assert.deepEqual(g.accord.records.filter(r => r.kind === 'x').map(r => r.id), ['theirs'], 'only this machine\'s own records were withdrawn');
  assert.deepEqual(Object.keys(await g.outbox()), ['p:y:keep'], 'withdrawn entries are removed, the other kind is untouched and synced');
  assert.equal((await g.outbox())['p:y:keep'].state, 'synced');
});

test('retract of a whole kind with a live certificate withdraws it at once, and says so when Accord has more pages than it read', async t => {
  const g = await gateway(t);
  g.accord.seed('x', ['r1', 'r2', 'r3']);
  assert.deepEqual(await g.retract({ kind: 'x' }), { state: 'retracted', count: 3 });
  assert.deepEqual(g.accord.records, []);
  assert.deepEqual(await g.retract({ kind: 'x' }), { state: 'retracted', count: 0 });
  g.accord.loop = true;
  assert.deepEqual(await g.retract({ kind: 'x' }), { state: 'retracted', count: 0, truncated: true });
});

test('with no identity a retract only clears the unsent publishes and queues nothing, so a later identity is never withdrawn by mistake', async t => {
  const g = await gateway(t);
  await g.self('policy.setKind', { kind: 'x', paused: true });
  await g.publish({ kind: 'x', id: 'never-sent', body: { v: 1 } });
  await g.publish({ kind: 'x', id: 'other', body: { v: 1 } });
  await g.accord.change({ author: null, certificate: null });
  assert.deepEqual(await g.retract({ kind: 'x', id: 'never-sent' }), { state: 'no_identity', count: 0 });
  assert.deepEqual(Object.keys(await g.outbox()), ['p:x:other']);
  assert.deepEqual(await g.retract({ kind: 'x' }), { state: 'no_identity', count: 0 });
  assert.deepEqual(await g.retract({ kind: 'x', id: 'sent-before' }), { state: 'no_identity', count: 0 });
  assert.deepEqual(await g.outbox(), {});
  assert.deepEqual(g.accord.calls, []);
  await g.accord.change({ author: B, certificate: ACTIVE });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(g.accord.calls, [], 'the new identity withdraws nothing');
});

test('a record Accord already has is withdrawn through Accord even when the outbox only holds an unsent update of it, one id or the whole kind', async t => {
  for (const whole of [false, true]) {
    const g = await gateway(t);
    g.accord.seed('x', ['a']);
    await g.self('policy.setKind', { kind: 'x', paused: true });
    assert.equal((await g.publish({ kind: 'x', id: 'a', body: { v: 2 } })).state, 'paused');
    assert.equal((await g.publish({ kind: 'x', id: 'b', body: { v: 1 } })).state, 'paused');
    assert.equal((await g.outbox())['p:x:a'].lastSyncedHash, undefined);
    const result = await g.retract(whole ? { kind: 'x' } : { kind: 'x', id: 'a' });
    assert.deepEqual(result, { state: 'retracted', count: whole ? 2 : 1 });
    assert.deepEqual(g.accord.calls, [{ kind: 'x', id: 'a', body: {}, audience: [] }], 'only a is withdrawn at Accord; b was never there');
    assert.deepEqual(g.accord.records, []);
    assert.deepEqual(Object.keys(await g.outbox()), whole ? [] : ['p:x:b']);
    if (!whole) assert.deepEqual(g.accord.queries.at(-1), { kind: 'x', author: A, id: 'a', limit: 1 });
  }
});

test('a withdrawal queued for one author is not signed by another: it waits for the original author and nothing of the new author is touched', async t => {
  const g = await gateway(t);
  g.accord.seed('x', ['r']);
  g.accord.seed('x', ['r'], { author: B });
  await g.accord.change({ certificate: EXPIRED });
  assert.deepEqual(await g.retract({ kind: 'x', id: 'r' }), { state: 'needs_cert', count: 0, queued: 1 });
  assert.equal((await g.outbox())[`r:${A}:x:r`].targetAuthor, A);
  await g.accord.change({ author: B, certificate: ACTIVE });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.deepEqual(g.accord.calls, [], 'B never signs a withdrawal that was queued for A');
  assert.deepEqual(g.accord.records.map(r => [r.author, r.id]), [[A, 'r'], [B, 'r']]);
  const kept = (await g.outbox())[`r:${A}:x:r`];
  assert.deepEqual([kept.desired, kept.targetAuthor], ['retract', A]);
  assert.equal((await g.status()).pendingCount, 1);
  await g.accord.change({ author: A });
  await until(async () => (await g.status()).pendingCount === 0, 'A 回来后补撤完成');
  assert.deepEqual(g.accord.calls, [{ kind: 'x', id: 'r', body: {}, audience: [] }]);
  assert.deepEqual(g.accord.records.map(r => [r.author, r.id]), [[B, 'r']]);
});

test('pausing a kind keeps its publishes in the outbox without calling Accord, and resuming sends them', async t => {
  const g = await gateway(t);
  await rejects(g.self('policy.setKind', { kind: 'profile', paused: true }));
  await rejects(g.self('policy.setKind', { kind: 'x' }));
  assert.deepEqual(await g.self('policy.get'), { pausedKinds: [] });
  assert.deepEqual(await g.self('policy.setKind', { kind: 'x', paused: true }), { pausedKinds: ['x'] });
  assert.deepEqual(await g.self('policy.get'), { pausedKinds: ['x'] });
  assert.deepEqual(await g.status(), { author: A, certState: 'active', certUntil: 1_900_000_000, friendCount: 0, pendingCount: 0, pausedKinds: ['x'] });

  assert.deepEqual(await g.publish({ kind: 'x', id: 'i', body: { v: 1 } }), { state: 'paused', author: A });
  assert.deepEqual(g.accord.calls, [], 'a paused kind never reaches coda/accord@1 publish');
  assert.equal((await g.outbox())['p:x:i'].body.v, 1);
  assert.equal((await g.status()).pendingCount, 1);
  assert.equal((await g.publish({ kind: 'y', id: 'j', body: { v: 1 } })).state, 'synced', 'other kinds are not affected');
  const waiting = await g.call('outbox');
  assert.deepEqual([waiting.pausedKinds, waiting.pendingCount, waiting.items.filter(item => item.state === 'paused').length], [['x'], 1, 1]);
  // 暂停只拦发布：撤回照常。
  assert.deepEqual(await g.retract({ kind: 'x', id: 'i' }), { state: 'retracted', count: 1 });
  assert.deepEqual(await g.outbox().then(Object.keys), ['p:y:j']);

  await g.publish({ kind: 'x', id: 'again', body: { v: 2 } });
  g.accord.calls.length = 0;
  assert.deepEqual(await g.self('policy.setKind', { kind: 'x', paused: false }), { pausedKinds: [] });
  assert.deepEqual(g.accord.calls, [{ kind: 'x', id: 'again', body: { v: 2 }, audience: ['public'] }]);
  assert.equal((await g.outbox())['p:x:again'].state, 'synced');
  assert.deepEqual(await g.status(), { author: A, certState: 'active', certUntil: 1_900_000_000, friendCount: 0, pendingCount: 0, pausedKinds: [] });
});

test('after deactivate nothing is handled, watched or written any more', async t => {
  const g = await gateway(t);
  assert.equal(g.accord.listeners.size, 1);
  deactivate();
  assert.equal(g.accord.listeners.size, 0);
  await rejects(g.publish({ kind: 'x', id: 'i', body: {} }), 'not_found');
  await rejects(g.self('policy.get'), 'not_found');
  await g.accord.change({ certificate: EXPIRED });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal((await g.status()).certState, 'active', 'the gateway record is no longer refreshed');
});

test('deactivating while the identity is still being read starts no signature and writes nothing; a signature already out is still saved', async t => {
  const g = await gateway(t);
  const before = g.accord.gets;
  let release;
  g.accord.getGate = new Promise(resolve => { release = resolve; });
  const waiting = g.publish({ kind: 'x', id: 'i', body: { v: 1 } });
  await until(() => g.accord.gets > before, '网关在读身份');
  deactivate();
  g.accord.getGate = null;
  release();
  await rejects(waiting, 'interrupted');
  assert.deepEqual(g.accord.calls, []);
  assert.deepEqual(await g.outbox(), {});

  const h = await gateway(t);
  let finish;
  h.accord.callGate = new Promise(resolve => { finish = resolve; });
  const signing = h.publish({ kind: 'x', id: 'i', body: { v: 1 } });
  await until(() => h.accord.calls.length === 1, '签名已发出');
  deactivate();
  h.accord.callGate = null;
  finish();
  assert.equal((await signing).state, 'synced');
  const stored = await h.outbox();
  assert.deepEqual([stored['p:x:i'].state, stored['p:x:i'].lastAuthor, 'body' in stored['p:x:i']], ['synced', A, false]);
});

test('the intent is written before signing, so a write that fails after the signature never leaves old content looking synced', async t => {
  if (process.getuid?.() === 0) return t.skip('root 不受目录权限限制');
  const g = await gateway(t);
  await g.publish({ kind: 'x', id: 'i', body: { v: 1 } });
  await g.publish({ kind: 'x', id: 'j', body: { v: 1 } });
  g.accord.onCall = () => chmod(g.dir, 0o500);
  await assert.rejects(g.publish({ kind: 'x', id: 'i', body: { v: 2 } }));
  await chmod(g.dir, 0o700);
  assert.deepEqual(g.accord.calls.map(c => c.body.v), [1, 1, 2], 'v2 did reach Accord');
  const disk = (await g.outbox())['p:x:i'];
  assert.deepEqual([disk.state, disk.body], ['queued', { v: 2 }]);
  g.accord.onCall = null;
  const again = await g.publish({ kind: 'x', id: 'i', body: { v: 1 } });
  assert.deepEqual([again.state, again.skipped], ['synced', undefined], 'v1 is not taken for already synced');
  assert.equal(g.accord.calls.length, 4);

  // 撤回同理：意图先落盘，签名后落盘失败，磁盘上也不再是「j 的 v1 已同步」。
  g.accord.onCall = () => chmod(g.dir, 0o500);
  await assert.rejects(g.retract({ kind: 'x', id: 'j' }));
  await chmod(g.dir, 0o700);
  g.accord.onCall = null;
  assert.deepEqual([(await g.outbox())[`r:${A}:x:j`].desired, g.accord.calls.at(-1).audience], ['retract', []]);
  assert.equal((await g.publish({ kind: 'x', id: 'j', body: { v: 1 } })).skipped, undefined);
});

test('an outbox or policy file that cannot be read is an error, never an empty table: a publish neither skips the pause nor overwrites the queue', async t => {
  const g = await gateway(t);
  await g.self('policy.setKind', { kind: 'x', paused: true });
  await rm(join(g.dir, 'policy.json'));
  await mkdir(join(g.dir, 'policy.json'));
  await assert.rejects(g.publish({ kind: 'x', id: 'i', body: { v: 1 } }));
  await assert.rejects(g.self('policy.get'));
  assert.deepEqual(g.accord.calls, [], 'an unreadable policy does not let a paused kind through');
  await rm(join(g.dir, 'policy.json'), { recursive: true });
  assert.equal((await g.publish({ kind: 'x', id: 'i', body: { v: 1 } })).state, 'synced', 'a missing policy means nothing is paused');

  await rm(join(g.dir, 'outbox.json'));
  await mkdir(join(g.dir, 'outbox.json'));
  await assert.rejects(g.publish({ kind: 'x', id: 'k', body: { v: 1 } }));
  await assert.rejects(g.retract({ kind: 'x', id: 'i' }));
  await assert.rejects(g.call('outbox'));
  assert.equal(g.accord.calls.length, 1);
});

test('a withdrawal queued while the certificate was expired is checked against Accord when it recovers: signed if the record exists, dropped if it never did', async t => {
  const g = await gateway(t);
  g.accord.seed('x', ['present']);
  await g.accord.change({ certificate: EXPIRED });
  assert.deepEqual(await g.retract({ kind: 'x', id: 'present' }), { state: 'needs_cert', count: 0, queued: 1 });
  assert.deepEqual(await g.retract({ kind: 'x', id: 'absent' }), { state: 'needs_cert', count: 0, queued: 1 });
  assert.deepEqual(Object.keys(await g.outbox()).sort(), [`r:${A}:x:absent`, `r:${A}:x:present`]);
  g.accord.queries.length = 0;
  await g.accord.change({ certificate: ACTIVE });
  await until(async () => (await g.status()).pendingCount === 0, '恢复后冲洗完');
  assert.deepEqual(g.accord.queries.map(q => q.id).sort(), ['absent', 'present']);
  assert.ok(g.accord.queries.every(q => q.kind === 'x' && q.author === A && q.limit === 1));
  assert.deepEqual(g.accord.calls, [{ kind: 'x', id: 'present', body: {}, audience: [] }], 'no tombstone for an id that was never published');
  assert.deepEqual(await g.outbox(), {});
  assert.deepEqual(g.accord.records, []);
});

test('a batch retract of a kind leaves another author\'s queued withdrawals alone, and they go out when that author is back', async t => {
  const g = await gateway(t);
  g.accord.seed('x', ['r']);
  await g.accord.change({ certificate: EXPIRED });
  await g.retract({ kind: 'x', id: 'r' });
  await g.accord.change({ author: B, certificate: ACTIVE });
  g.accord.seed('x', ['r'], { author: B });
  assert.deepEqual(await g.retract({ kind: 'x' }), { state: 'retracted', count: 1 }, 'only B\'s own record is withdrawn; A\'s queued entry is not touched or counted');
  assert.deepEqual(g.accord.calls, [{ kind: 'x', id: 'r', body: {}, audience: [] }]);
  g.accord.calls.length = 0;
  const kept = (await g.outbox())[`r:${A}:x:r`];
  assert.deepEqual([kept.desired, kept.targetAuthor], ['retract', A]);
  await g.accord.change({ author: A });
  await until(async () => (await g.status()).pendingCount === 0, 'A 回来后补撤完成');
  assert.deepEqual(g.accord.calls, [{ kind: 'x', id: 'r', body: {}, audience: [] }]);
  assert.deepEqual(g.accord.records, []);
});

test('stopping in the middle of a batch retract says some of it was done; the policy is not written once stopped', async t => {
  const g = await gateway(t);
  g.accord.seed('x', ['r1', 'r2']);
  let release;
  g.accord.callGate = new Promise(resolve => { release = resolve; });
  const running = g.retract({ kind: 'x' });
  await until(() => g.accord.calls.length === 1, '第一条撤回已发出');
  deactivate();
  g.accord.callGate = null;
  release();
  await assert.rejects(running, error => error.code === 'interrupted' && error.effects === 'some');
  assert.equal(g.accord.calls.length, 1, 'the second withdrawal is never signed');
  const stored = await g.outbox();
  assert.deepEqual(Object.values(stored).map(entry => [entry.id, entry.desired, entry.state]), [['r2', 'retract', 'queued']], 'the first is confirmed on disk, the second is still queued');
  await assert.rejects(g.self('policy.setKind', { kind: 'x', paused: true }), error => error.code === 'not_found');
  await assert.rejects(readFile(join(g.dir, 'policy.json')), { code: 'ENOENT' });
});

test('stopping while a flush is still asking Accord whether a withdrawal has anything to withdraw deletes and writes nothing', async t => {
  const g = await gateway(t);
  await g.accord.change({ certificate: EXPIRED });
  await g.retract({ kind: 'x', id: 'r' });
  const key = `r:${A}:x:r`, before = await readFile(join(g.dir, 'outbox.json'), 'utf8');
  let release;
  g.accord.queryGate = new Promise(resolve => { release = resolve; });
  g.accord.queries.length = 0;
  await g.accord.change({ certificate: ACTIVE });
  await until(() => g.accord.queries.length === 1, '冲洗在问 Accord');
  deactivate();
  g.accord.queryGate = null;
  release();
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(await readFile(join(g.dir, 'outbox.json'), 'utf8'), before, 'the file was not written');
  assert.deepEqual(Object.keys(await g.outbox()), [key]);
  assert.deepEqual(g.accord.calls, []);
});

test('each author\'s queued withdrawals are kept apart: B can withdraw its own record of the same id, A\'s waits and goes out when A is back, a new publish overrides one', async t => {
  const g = await gateway(t);
  g.accord.seed('x', ['same']);
  await g.accord.change({ certificate: EXPIRED });
  await g.retract({ kind: 'x', id: 'same' });
  await g.accord.change({ author: B, certificate: ACTIVE });
  g.accord.seed('x', ['same'], { author: B });
  assert.deepEqual(await g.retract({ kind: 'x', id: 'same' }), { state: 'retracted', count: 1 });
  assert.deepEqual(g.accord.calls, [{ kind: 'x', id: 'same', body: {}, audience: [] }]);
  assert.deepEqual(g.accord.records.map(r => [r.author, r.id]), [[A, 'same']]);
  g.accord.seed('x', ['same'], { author: B });
  assert.deepEqual(await g.retract({ kind: 'x' }), { state: 'retracted', count: 1 }, 'B\'s record; A\'s withdrawal is not counted');
  assert.deepEqual(g.accord.records.map(r => [r.author, r.id]), [[A, 'same']]);
  assert.ok(`r:${A}:x:same` in await g.outbox());
  const listed = await g.call('outbox');
  assert.ok(listed.items.some(item => item.desired === 'retract' && item.id === 'same'));
  assert.equal(listed.pendingCount, 1);

  g.accord.calls.length = 0;
  await g.accord.change({ author: A });
  await until(async () => (await g.status()).pendingCount === 0, 'A 回来后补撤完成');
  assert.deepEqual(g.accord.calls, [{ kind: 'x', id: 'same', body: {}, audience: [] }]);
  assert.deepEqual(g.accord.records, []);
});

test('one withdrawal whose Accord lookup fails stays queued and counted, the entries after it are still flushed, and the next flush finishes it', async t => {
  const g = await gateway(t);
  g.accord.seed('x', ['r']);
  await g.accord.change({ certificate: EXPIRED });
  await g.retract({ kind: 'x', id: 'r' });
  await g.publish({ kind: 'x', id: 'p', body: { v: 1 } });
  assert.deepEqual(Object.keys(await g.outbox()), [`r:${A}:x:r`, 'p:x:p']);
  g.accord.queryFailure = new Error('查询失败');
  await g.accord.change({ certificate: ACTIVE });
  await until(async () => (await g.status()).certState === 'active' && (await g.outbox())['p:x:p']?.state === 'synced', '后面的待发照常冲洗');
  const stored = await g.outbox();
  assert.deepEqual([stored[`r:${A}:x:r`].state, stored[`r:${A}:x:r`].lastError], ['queued', '查询失败']);
  assert.equal('body' in stored['p:x:p'], false);
  assert.deepEqual(g.accord.calls, [{ kind: 'x', id: 'p', body: { v: 1 }, audience: ['public'] }]);
  await until(async () => (await g.status()).pendingCount === 1, '网关记录仍计入这条待撤');
  g.accord.queryFailure = null;
  await g.accord.change({ certificate: ACTIVE });
  await until(async () => (await g.status()).pendingCount === 0, '恢复后补撤完成');
  assert.deepEqual(g.accord.calls.slice(1), [{ kind: 'x', id: 'r', body: {}, audience: [] }]);
  assert.equal(g.accord.records.some(record => record.id === 'r'), false);
  assert.equal(`r:${A}:x:r` in await g.outbox(), false);
});

test('a publish replaces the same author\'s queued withdrawal of that id, so the old withdrawal cannot undo it later', async t => {
  const g = await gateway(t);
  g.accord.seed('x', ['over']);
  await g.accord.change({ certificate: EXPIRED });
  await g.retract({ kind: 'x', id: 'over' });
  assert.deepEqual(Object.keys(await g.outbox()), [`r:${A}:x:over`]);
  assert.deepEqual(await g.publish({ kind: 'x', id: 'over', body: { v: 1 } }), { state: 'needs_cert', author: A });
  assert.deepEqual(Object.keys(await g.outbox()), ['p:x:over']);
  await g.accord.change({ certificate: ACTIVE });
  await until(async () => (await g.status()).pendingCount === 0, '恢复后只发新内容');
  assert.deepEqual(g.accord.calls, [{ kind: 'x', id: 'over', body: { v: 1 }, audience: ['public'] }]);
});

test('a withdrawal and a publish whose keys used to be the same string are both kept, in either order', async t => {
  for (const withdrawFirst of [true, false]) {
    const g = await gateway(t);
    await g.accord.change({ certificate: EXPIRED });
    const withdraw = () => g.retract({ kind: 'x', id: 'same' }), publish = () => g.publish({ kind: 'retract', id: `${A}:x:same`, body: { v: 1 } });
    if (withdrawFirst) { await withdraw(); await publish(); } else { await publish(); await withdraw(); }
    const stored = await g.outbox();
    assert.deepEqual(Object.keys(stored).sort(), [`p:retract:${A}:x:same`, `r:${A}:x:same`].sort());
    assert.deepEqual([stored[`r:${A}:x:same`].desired, stored[`p:retract:${A}:x:same`].desired], ['retract', 'publish']);
    assert.ok(stored[`p:retract:${A}:x:same`].seq !== stored[`r:${A}:x:same`].seq);
  }
});

for (const failure of ['no identity', 'identity unreadable']) {
  test(`a publish queued while there is ${failure} replaces A's older withdrawal when A is back: only the new content goes out, other authors' withdrawals stay`, async t => {
    const g = await gateway(t);
    g.accord.seed('x', ['same']);
    await g.accord.change({ author: B });
    await g.publish({ kind: 'x', id: 'same', body: { v: 1 } });
    await g.accord.change({ certificate: EXPIRED });
    await g.retract({ kind: 'x', id: 'other' });
    await g.accord.change({ author: A });
    await g.retract({ kind: 'x', id: 'same' });
    assert.ok(`r:${A}:x:same` in await g.outbox());

    const get = g.accord.get;
    if (failure === 'no identity') await g.accord.change({ author: null, certificate: null });
    else g.accord.get = async () => { throw new Error('读不出身份'); };
    const queued = await g.publish({ kind: 'x', id: 'same', body: { v: 2 } });
    assert.equal(queued.state, failure === 'no identity' ? 'no_identity' : 'queued');
    assert.ok(`r:${A}:x:same` in await g.outbox(), 'the old withdrawal survives until A is back');
    g.accord.get = get;

    g.accord.calls.length = 0;
    await g.accord.change({ author: A, certificate: ACTIVE });
    await until(async () => (await g.outbox())['p:x:same']?.state === 'synced', '新发布冲洗完成');
    assert.deepEqual(g.accord.calls, [{ kind: 'x', id: 'same', body: { v: 2 }, audience: ['public'] }], 'the stale withdrawal is never signed');
    const stored = await g.outbox();
    assert.equal(stored['p:x:same'].lastAuthor, A);
    assert.equal(`r:${A}:x:same` in stored, false);
    assert.equal(`r:${B}:x:other` in stored, true);
    assert.deepEqual(g.accord.records.map(r => [r.author, r.id, r.body]), [[B, 'same', { v: 1 }], [A, 'same', { v: 2 }]], "B's record untouched, A's is the new content");
    await until(async () => (await g.status()).pendingCount === 1, "只剩 B 的待撤");
  });
}

// A 先排下旧撤回，又在没有身份时排了更晚的新发布；之后 A 回来、证书可用。
async function withStaleWithdrawal(t) {
  const g = await gateway(t);
  await g.accord.change({ certificate: EXPIRED });
  await g.retract({ kind: 'x', id: 'same' });
  await g.accord.change({ author: null, certificate: null });
  assert.equal((await g.publish({ kind: 'x', id: 'same', body: { v: 2 } })).state, 'no_identity');
  assert.ok(`r:${A}:x:same` in await g.outbox());
  return g;
}

test('a publish Accord refuses outright leaves the older withdrawal it would have replaced on disk', async t => {
  const g = await withStaleWithdrawal(t);
  g.accord.failure = Object.assign(new Error('不合规'), { code: 'invalid_input' });
  await g.accord.change({ author: A, certificate: ACTIVE });
  await until(async () => (await g.outbox())['p:x:same']?.state === 'error', '新发布被拒');
  assert.deepEqual(g.accord.calls, [{ kind: 'x', id: 'same', body: { v: 2 }, audience: ['public'] }], 'the withdrawal is held back, not signed');
  assert.equal((await g.outbox())[`r:${A}:x:same`].desired, 'retract', 'and not discarded');
});

test("a publish Accord signs as another author than the one read at flush time clears that author's older withdrawal, not A's", async t => {
  const g = await withStaleWithdrawal(t);
  await g.accord.change({ author: A, certificate: ACTIVE });
  g.accord.onCall = () => { g.accord.author = B; };
  await until(async () => (await g.outbox())['p:x:same']?.state === 'synced', '新发布已同步');
  const stored = await g.outbox();
  assert.equal(stored['p:x:same'].lastAuthor, B);
  assert.equal(stored[`r:${A}:x:same`].desired, 'retract', "A's withdrawal is kept");
});

test('deactivating while a flush is still reading the identity leaves the queued withdrawal and publish untouched', async t => {
  const g = await withStaleWithdrawal(t);
  const before = g.accord.gets, stored = await g.outbox();
  let release;
  g.accord.getGate = new Promise(resolve => { release = resolve; });
  await g.accord.change({ author: A, certificate: ACTIVE });
  await until(() => g.accord.gets > before, '冲洗在读身份');
  deactivate();
  g.accord.getGate = null;
  release();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(g.accord.calls, []);
  assert.deepEqual(await g.outbox(), stored);
});

test('a withdrawal that a later publish of the same author already replaced and synced is dropped without being signed', async t => {
  const g = await gateway(t);
  await g.accord.change({ certificate: EXPIRED });
  await g.retract({ kind: 'x', id: 'same' });
  const stored = await g.outbox(), [retract] = Object.values(stored);
  const synced = { seq: retract.seq + 1, kind: 'x', id: 'same', desired: 'publish', state: 'synced', hash: 'h', audience: ['public'], lastAuthor: A, lastSyncedHash: 'h', lastSyncedAt: 1 };
  await writeFile(join(g.dir, 'outbox.json'), JSON.stringify({ seq: synced.seq, entries: { ...stored, 'p:x:same': synced } }));
  await g.accord.change({ certificate: ACTIVE });
  await until(async () => Object.keys(await g.outbox()).join() === 'p:x:same', '过期撤回被丢掉');
  assert.deepEqual(g.accord.calls, []);
});

test('friends/card is refused by publish and retract, without touching Accord or the outbox', async t => {
  const g = await gateway(t);
  await rejects(g.publish({ kind: 'friends/card', id: 'self', body: { name: 'x' } }));
  await rejects(g.retract({ kind: 'friends/card', id: 'self' }));
  await rejects(g.retract({ kind: 'friends/card' }));
  assert.deepEqual(g.accord.calls, []);
  assert.deepEqual(await g.outbox(), {});
});

test('the card, direct message and feed operations and streams are gone from the gateway', async t => {
  const g = await gateway(t);
  for (const operation of ['set-card', 'send-dm', 'post-feed']) await rejects(g.call(operation, {}), 'not_found');
  for (const name of ['notes.list', 'notes.set', 'notes.delete']) await rejects(g.self(name, {}), 'not_found');
});

// 旧版 outbox.json 里残留的待发名片：读表时丢掉并落盘清理，不补发，同队的合法条目照常发出。
const staleCard = { seq: 1, kind: 'friends/card', id: 'self', desired: 'publish', state: 'needs_cert', body: { name: '旧名片' }, audience: ['public'], hash: 'h' };
const staleRetract = { seq: 2, kind: 'friends/card', id: 'self', desired: 'retract', state: 'queued', targetAuthor: A };
const legit = { seq: 3, kind: 'x', id: 'i', desired: 'publish', state: 'needs_cert', body: { v: 1 }, audience: ['public'], hash: canonicalHash({ body: { v: 1 }, audience: ['public'] }) };
async function withStaleOutbox(t, options) {
  const dir = await mkdtemp(join(tmpdir(), 'friends-stale-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'outbox.json'), JSON.stringify({ seq: 3, entries: { 'p:friends/card:self': staleCard, [`r:${A}:friends/card:self`]: staleRetract, 'p:x:i': legit } }));
  const accord = accordFake(options), host = createMockCoda({ plugin: { id: 'friends', state: dir, protocols: manifest.contributes.protocols, protocolImplementations: manifest.contributes.protocolImplementations } });
  t.after(async () => { deactivate(); await host.close(); });
  await activate({ ...host.coda, get: ref => ref.kind === 'coda/accord@1' ? accord.get() : host.coda.get(ref), query: accord.query, call: accord.call, watch: accord.watch });
  const stored = async () => JSON.parse(await readFile(join(dir, 'outbox.json'), 'utf8')).entries;
  return { accord, stored };
}

test('a stale pending friends/card in an old outbox.json is cleaned from disk on activation, and the other queued record is kept', async t => {
  const { accord, stored } = await withStaleOutbox(t, { certificate: EXPIRED });
  assert.deepEqual(Object.keys(await stored()), ['p:x:i']);
  assert.deepEqual(accord.calls, []);
});

test('a stale friends/card is never sent when the certificate recovers, and does not hold back the legitimate record queued with it', async t => {
  const { accord, stored } = await withStaleOutbox(t, { certificate: EXPIRED });
  await accord.change({ certificate: ACTIVE });
  await until(async () => (await stored())['p:x:i']?.state === 'synced', '合法的待发条目补发');
  assert.deepEqual(accord.calls, [{ kind: 'x', id: 'i', body: { v: 1 }, audience: ['public'] }]);
  assert.deepEqual(Object.keys(await stored()), ['p:x:i']);
});

test('the protocol definition is valid and has only the friends, records, publish, retract and outbox operations, with no streams', () => {
  const [definition] = manifest.contributes.protocols;
  assert.equal(definitionProblem(definition, { namespace: 'friends', where: definition.name }), null);
  assert.equal(manifest.version, '0.13.0');
  assert.deepEqual(Object.keys(definition.operations), ['friends', 'records', 'publish', 'retract', 'outbox']);
  assert.equal(definition.streams, undefined);
  assert.deepEqual(definition.permissions.read, { title: definition.permissions.read.title, read: true, operations: ['friends', 'records'] });
  assert.deepEqual(definition.permissions.publish.operations, ['publish', 'retract', 'outbox']);
  assert.deepEqual(definition.operations.friends.result.required, ['selfAuthor', 'certState', 'friends']);
  assert.deepEqual(Object.keys(definition.operations.friends.result.properties), ['selfAuthor', 'certState', 'friends']);
  assert.ok(!manifest.description.includes('名片'));
});

// 直接建网关（不经 main.mjs）：内部签名入口不登记成操作，只能这样拿到。
async function direct(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'friends-gateway-'));
  const accord = accordFake(options), host = createMockCoda({ plugin: { id: 'friends', state: dir, protocols: manifest.contributes.protocols } });
  const gw = createGateway({ ...host.coda, get: ref => ref.kind === 'coda/accord@1' ? accord.get() : host.coda.get(ref), query: accord.query, call: accord.call, watch: accord.watch }, dir);
  t.after(async () => { gw.stop(); await host.close(); await rm(dir, { recursive: true, force: true }); });
  await gw.start();
  const [local] = await host.coda.list(SOCIAL, { scope: 'local' });
  return { gw, accord, host, ref: { kind: SOCIAL, id: local.id } };
}

// ---- 好友签名网关：friends/rpc- 前缀的封口与内部签名入口 ----

const RPC = ['friends/rpc-grant', 'friends/rpc-call', 'friends/rpc-answer', 'friends/rpc-other'];

test('publish, a single retract and a retract of a whole kind refuse every friends/rpc- kind, and nothing reaches Accord or the queue', async t => {
  const g = await gateway(t);
  g.accord.seed('friends/rpc-call', ['c1'], { author: A });
  for (const kind of RPC) {
    await rejects(g.publish({ kind, id: 'c1', body: { v: 1 }, audience: [B] }));
    await rejects(g.publish({ kind, id: 'c1', body: { v: 1 } }));
    await rejects(g.retract({ kind, id: 'c1' }));
    await rejects(g.retract({ kind }));
  }
  assert.deepEqual(g.accord.calls, []);
  assert.deepEqual(g.accord.queries, []);
  assert.deepEqual(await g.outbox(), {});
  assert.equal(g.accord.records.length, 1, 'the record already in Accord is not withdrawn');
  await assert.rejects(g.publish({ kind: 'friends/rpc-call', id: 'c1', body: { v: 1 } }), error => /保留类型/.test(error.message) && error.effects === 'none');
  // 前缀之外的相近 kind 照常。
  assert.equal((await g.publish({ kind: 'friends/rpc', id: 'i', body: { v: 1 } })).state, 'synced');
  assert.equal((await g.publish({ kind: 'friends/rpcx', id: 'i', body: { v: 1 } })).state, 'synced');
  assert.deepEqual(g.accord.calls.map(call => call.kind), ['friends/rpc', 'friends/rpcx']);
  // 暂停与恢复一个这类 kind 也不行（策略只收可发布的 kind）。
  await assert.rejects(g.self('policy.setKind', { kind: 'friends/rpc-call', paused: true }), error => error.code === 'invalid_input');
});

test('a flush drops queued friends/rpc- entries without signing them, including ones queued before the upgrade, and sends the rest as usual', async t => {
  const g = await gateway(t, { certificate: EXPIRED });
  const item = (kind, id, body = { v: 1 }) => ({ kind, id, body, audience: [B] });
  const put = entry => [entry.desired === 'retract' ? retractKey(entry.targetAuthor, entry.kind, entry.id) : entryKey(entry.kind, entry.id), entry];
  const synced = markSynced(queuePublish(undefined, item('friends/rpc-grant', 'g1'), 3), A, 5);
  const seeded = Object.fromEntries([
    put(queuePublish(undefined, item('friends/rpc-call', 'c1'), 1)), put(queueRetract(undefined, 'friends/rpc-answer', 'a1', A, 2)), put(synced),
    put({ ...queuePublish(undefined, item('x', 'ok', { n: 1 }), 4), audience: ['public'] }), put(queueRetract(undefined, 'y', 'gone', A, 5)),
  ]);
  await writeFile(join(g.dir, 'outbox.json'), JSON.stringify({ seq: 5, entries: seeded }));
  await g.accord.change({ certificate: ACTIVE });
  await until(async () => Object.keys(await g.outbox()).every(key => !key.includes('friends/rpc-')) && g.accord.calls.length >= 1, '冲洗掉了旧队列');
  // 网关记录在冲洗完才刷新，冲洗途中它还是播种前的 0：同时等队列里只剩发出去的那条。
  await until(async () => (await g.status()).pendingCount === 0 && Object.keys(await g.outbox()).length === 1, '其余条目照常发完');
  assert.deepEqual(g.accord.calls.map(call => call.kind), ['x'], 'only the ordinary entry is signed');
  assert.deepEqual(Object.keys(await g.outbox()), ['p:x:ok']);
  // 冲洗不按条目去查这类记录；持有方启动时按作者查一次本机的授权记录（不带 id），不算。
  assert.equal(g.accord.queries.some(query => query.kind.startsWith('friends/rpc-') && query.id !== undefined), false);

  // 只有这类条目、没有别的待发时，下一次冲洗也清掉它们。
  const only = Object.fromEntries([put(queuePublish(undefined, item('friends/rpc-call', 'c2'), 6)), put(markSynced(queuePublish(undefined, item('friends/rpc-answer', 'a2'), 7), A, 5))]);
  await writeFile(join(g.dir, 'outbox.json'), JSON.stringify({ seq: 7, entries: { ...(await g.outbox()), ...only } }));
  // 盘上还在的这类条目，outbox 操作也读不到。
  for (const input of [{}, { kind: 'friends/rpc-call' }]) assert.deepEqual((await g.call('outbox', input)).items.filter(item => item.kind.startsWith('friends/rpc-')), []);
  g.accord.calls.length = 0;
  await g.accord.change({});
  await until(async () => Object.keys(await g.outbox()).every(key => !key.includes('friends/rpc-')), '只剩这类条目时也清掉');
  assert.deepEqual(g.accord.calls, []);
  assert.deepEqual(Object.keys(await g.outbox()), ['p:x:ok']);
});

test('records refuses every friends/rpc- kind without asking Accord, while other kinds are still read', async t => {
  const g = await gateway(t);
  g.accord.seed('friends/rpc-call', ['c1'], { author: B, local: false });
  for (const kind of RPC) {
    await rejects(g.call('records', { kind }));
    await rejects(g.call('records', { kind, author: B, id: 'c1', limit: 1, includeAudience: true }));
  }
  assert.deepEqual(g.accord.queries, []);
  g.accord.seed('x', ['d1'], { author: B, local: false });
  assert.equal((await g.call('records', { kind: 'x' })).records.length, 1);
});

// 一条要签的记录：正文里的发送方按种类取（grant、answer 是 holder，call 是 caller）；默认请求署本机作者 A，授权记录与回答署本机机器钥匙 MK。
const SENDER = { 'friends/rpc-call': 'caller', 'friends/rpc-grant': 'holder', 'friends/rpc-answer': 'holder' };
const HOLDER_KINDS = ['friends/rpc-grant', 'friends/rpc-answer'];
const sign = ({ from, ...more } = {}) => {
  const holder = HOLDER_KINDS.includes(more.kind);
  return { kind: 'friends/rpc-call', id: 'c1', body: { v: 1, n: 1, [holder ? 'holder' : 'caller']: from ?? (holder ? MK : A) }, audience: [F1], ...more };
};

test('the internal signer publishes the three rpc kinds to one recipient with expectAuthor, grants and answers with the machine key, and is not an operation of the gateway or of coda self', async t => {
  const d = await direct(t);
  const done = await d.gw.signRpc(sign());
  assert.deepEqual(d.accord.calls, [{ kind: 'friends/rpc-call', id: 'c1', body: { v: 1, n: 1, caller: A }, audience: [F1], expectAuthor: A }]);
  assert.deepEqual([done.author, done.version], [A, 1]);
  for (const kind of HOLDER_KINDS) assert.equal((await d.gw.signRpc(sign({ kind, id: `${kind}-1` }))).author, MK);
  assert.deepEqual(d.accord.calls.slice(1), HOLDER_KINDS.map(kind => ({ kind, id: `${kind}-1`, body: { v: 1, n: 1, holder: MK }, audience: [F1], signer: 'machine', expectAuthor: MK })));
  // 同一个 id 再签是更高的版本（取消用它）。
  assert.equal((await d.gw.signRpc(sign({ body: { v: 1, n: 1, caller: A, cancel: true } }))).version, 2);
  // 请求该署的作者跟着身份变；授权记录与回答仍是机器钥匙。
  await d.accord.change({ author: B });
  await d.gw.signRpc(sign({ id: 'c2', audience: [F2], from: B }));
  assert.equal(d.accord.calls.at(-1).expectAuthor, B);
  await d.gw.signRpc(sign({ kind: 'friends/rpc-answer', id: 'a2' }));
  assert.deepEqual([d.accord.calls.at(-1).signer, d.accord.calls.at(-1).expectAuthor], ['machine', MK]);
  // 不进待发队列、不写 outbox。
  await assert.rejects(readFile(join(await stateOf(d), 'outbox.json')), { code: 'ENOENT' });
  // 不是 friends/social@1 的操作，也不经 coda self。
  const social = manifest.contributes.protocols.find(protocol => protocol.name === SOCIAL);
  assert.equal(Object.keys(social.operations).some(name => /rpc|sign/i.test(name)), false);
  for (const name of ['signRpc', 'sign-rpc', 'sign']) await assert.rejects(d.host.call(d.ref, name, sign()), error => error.code === 'not_found');
  const g = await gateway(t);
  for (const name of ['signRpc', 'sign-rpc', 'rpc.sign']) await assert.rejects(g.self(name, sign()));
});
const stateOf = async d => d.host.coda.plugin.state;

test('the internal signer refuses anything but the three kinds and a recipient list that is not exactly one friend, before Accord is asked', async t => {
  const d = await direct(t);
  const refused = more => assert.rejects(d.gw.signRpc(sign(more)), error => error.code === 'invalid_input' && error.effects === 'none');
  for (const kind of ['friends/dm', 'friends/rpc-other', 'friends/rpc-', 'x', undefined]) await refused({ kind });
  for (const audience of [undefined, [], ['public'], [F1, F2], [F1, F1], [F1, 'public'], F1, ['someone']]) await refused({ audience });
  await refused({ id: '' });
  await refused({ id: undefined });
  // 正文里没写发送方、或写在了别的种类的字段上。
  await refused({ body: { v: 1 } });
  await refused({ body: { v: 1, holder: A } });
  await refused({ kind: 'friends/rpc-answer', body: { v: 1, caller: A } });
  await refused({ kind: 'friends/rpc-grant', body: { v: 1, caller: A } });
  await refused({ body: { v: 1, caller: 'someone' } });
  await refused({ body: [] });
  await refused({ body: undefined });
  await refused({ body: { text: 'x'.repeat(70_000) } });
  await assert.rejects(d.gw.signRpc(), error => error.code === 'invalid_input');
  assert.deepEqual(d.accord.calls, []);
  assert.deepEqual(d.accord.queries, []);
});

test('a request fails on the spot when a personal author\'s certificate is not active: invalid_state, nothing sent, nothing queued; grants and answers still go out with the machine key', async t => {
  const d = await direct(t, { certificate: EXPIRED });
  const failed = (more, call = () => d.gw.signRpc(sign(more))) => assert.rejects(call(), error => error.code === 'invalid_state' && error.effects === 'none');
  await failed();
  // 证书项里写着未生效（active 不是 true）也一样。
  await d.accord.change({ certificate: { active: false, until: 1_000 } });
  await failed();
  // 读不出作者、旧宿主没写证书这个键：也不签。
  await d.accord.change({ author: null, certificate: null, friends: [] });
  await failed();
  await d.accord.change({ author: A, certificate: ACTIVE, withCertificateKey: false });
  await failed();
  assert.deepEqual(d.accord.calls, []);
  await assert.rejects(readFile(join(d.host.coda.plugin.state, 'outbox.json')), { code: 'ENOENT' });
  await d.accord.change({ withCertificateKey: true });
  assert.equal((await d.gw.signRpc(sign())).version, 1);
  // 证书过期了，撤回也当场失败。
  await d.accord.change({ certificate: EXPIRED });
  await failed({}, () => d.gw.retractRpc({ kind: 'friends/rpc-call', id: 'c1', author: A }));
  assert.equal(d.accord.calls.length, 1);
  // 授权记录与回答用机器钥匙签：证书过期照签、照撤，署名是机器钥匙。
  for (const kind of HOLDER_KINDS) assert.equal((await d.gw.signRpc(sign({ kind, id: `${kind}-1` }))).author, MK);
  assert.equal((await d.gw.retractRpc({ kind: 'friends/rpc-answer', id: 'friends/rpc-answer-1', author: MK })).state, 'retracted');
  assert.deepEqual(d.accord.calls.at(-1), { kind: 'friends/rpc-answer', id: 'friends/rpc-answer-1', body: {}, audience: [], signer: 'machine', expectAuthor: MK });
  // 写成本机此刻的作者（根）不行：授权记录与回答只署机器钥匙。
  await failed({ kind: 'friends/rpc-answer', id: 'a2', from: A });
  await failed({}, () => d.gw.retractRpc({ kind: 'friends/rpc-grant', id: 'friends/rpc-grant-1', author: A }));
  // 读不出机器钥匙（旧宿主没写证书这个键）：授权记录与回答也不签。
  await d.accord.change({ withCertificateKey: false });
  await failed({ kind: 'friends/rpc-grant', id: 'g2' });
  assert.equal(d.accord.calls.length, 4);
});

test('a machine author (no personal identity bound) signs and retracts with its machine key whatever the certificate, with expectAuthor set to it', async t => {
  const M = `ed25519:${'e'.repeat(64)}`;
  const d = await direct(t, { author: M, certificate: null });
  const done = await d.gw.signRpc(sign({ from: M }));
  assert.deepEqual([done.author, done.version], [M, 1]);
  assert.deepEqual(d.accord.calls, [{ kind: 'friends/rpc-call', id: 'c1', body: { v: 1, n: 1, caller: M }, audience: [F1], expectAuthor: M }]);
  // 没绑个人身份时机器钥匙就是作者：授权记录与回答同样署它，带 signer: "machine"。
  for (const kind of HOLDER_KINDS) await d.gw.signRpc(sign({ kind, id: `${kind}-1`, from: M }));
  assert.deepEqual(d.accord.calls.slice(1).map(call => [call.signer, call.expectAuthor]), [['machine', M], ['machine', M]]);
  assert.equal((await d.gw.retractRpc({ kind: 'friends/rpc-grant', id: 'friends/rpc-grant-1', author: M })).state, 'retracted');
  assert.deepEqual(d.accord.calls.at(-1), { kind: 'friends/rpc-grant', id: 'friends/rpc-grant-1', body: {}, audience: [], signer: 'machine', expectAuthor: M });
  // 发送方不是此刻的机器作者，照旧当场失败。
  await assert.rejects(d.gw.signRpc(sign({ id: 'c2', from: A })), error => error.code === 'invalid_state' && error.effects === 'none');
  assert.equal(d.accord.calls.length, 4);
});

test('the internal signer lets Accord refuse a signature when the author changed under it, and reports an Accord failure without queueing it', async t => {
  const d = await direct(t);
  // 读到本机身份之后、签名之前身份换了：替身认 expectAuthor，不符就拒签，什么也没发出。
  d.accord.onCall = () => { d.accord.author = F2; };
  await assert.rejects(d.gw.signRpc(sign()), error => error.code === 'forbidden');
  assert.deepEqual(d.accord.records, []);
  d.accord.onCall = null;
  d.accord.author = A;
  d.accord.failure = new Error('连不上');
  await assert.rejects(d.gw.signRpc(sign()), /连不上/);
  d.accord.failure = Object.assign(new Error('太大'), { code: 'invalid_input' });
  await assert.rejects(d.gw.signRpc(sign()), error => error.code === 'invalid_input');
  await assert.rejects(readFile(join(d.host.coda.plugin.state, 'outbox.json')), { code: 'ENOENT' });
  assert.deepEqual(d.accord.records, []);
  // 网关停了以后不再签。
  d.accord.failure = null;
  d.gw.stop();
  await assert.rejects(d.gw.signRpc(sign()), error => error.code === 'interrupted');
});

test('the internal signer takes the sender from the body by kind and refuses on the spot when it is not the author signing right now', async t => {
  const d = await direct(t);
  const kinds = Object.keys(SENDER);
  const notYou = more => assert.rejects(d.gw.signRpc(sign(more)), error => error.code === 'invalid_state' && error.effects === 'none');
  // 签名入口读身份之前，作者换成了 B、机器钥匙换成了 F3：为 A、MK 写的记录，三种都当场失败，什么也没发。
  await d.accord.change({ author: B, machine: F3 });
  for (const kind of kinds) await notYou({ kind, id: `${kind}-1` });
  assert.deepEqual(d.accord.calls, []);
  // 为此刻该署的写就能签（请求是 B，授权记录与回答是 F3），expectAuthor 是正文里的发送方。
  const now = kind => kind === 'friends/rpc-call' ? B : F3;
  for (const kind of kinds) await d.gw.signRpc(sign({ kind, id: `${kind}-1`, from: now(kind) }));
  assert.deepEqual(d.accord.calls.map(call => [call.kind, call.expectAuthor, call.body[SENDER[call.kind]]]), kinds.map(kind => [kind, now(kind), now(kind)]));
  // 读身份的当口换的：读到的是换了以后的，不符就拒。
  d.accord.calls.length = 0;
  let release;
  d.accord.getGate = new Promise(resolve => { release = resolve; });
  const reads = d.accord.gets, pending = notYou({ from: B });
  await until(() => d.accord.gets > reads, '签名入口开始读身份');
  d.accord.author = F2;
  release();
  await pending;
  d.accord.getGate = null;
  assert.deepEqual(d.accord.calls, []);
  assert.equal(d.accord.records.filter(record => record.author === F2).length, 0);
});

test('friends and friendCount count one friend per author, however many channels point at it, and carry the channels', async t => {
  const g = await gateway(t, { friends: [{ node: 'link:1', author: F1, bound: true, peerNode: 'p', updatedAt: 1 }, { node: 'node:p', author: F1, bound: true, peerNode: 'p', updatedAt: 2 },
    { node: 'n2', author: F2, bound: true, updatedAt: 3 }, { node: 'link:3', author: F3, bound: false, updatedAt: 1 }, { node: 'link:4', author: F3, bound: false, updatedAt: 2 }] });
  const { friends } = await g.call('friends');
  assert.deepEqual(friends.map(row => [row.node, row.channels.map(c => c.node)]), [['n2', ['n2']], ['node:p', ['node:p', 'link:1']]]);
  assert.equal((await g.status()).friendCount, 2);
  const all = (await g.call('friends', { includePending: true })).friends;
  assert.deepEqual(all.map(row => [row.node, row.status]), [['link:4', 'pending'], ['n2', 'bound'], ['node:p', 'bound']]);
});
