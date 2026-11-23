// 好友社交网关 friends/social@1，在测试宿主里整段跑：模块照真实方式激活、操作经协议校验调用；本机 Accord（coda/accord@1）是个替身，
// 记下每次查询与发布，能换身份与证书、一页页吐记录，并像 Coda 一样把变化告诉 watch。
import { createMockCoda } from '../../helpers/mock-coda.mjs';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { activate, deactivate } from '../../../plugins/friends/main.mjs';

const manifest = JSON.parse(await readFile(new URL('../../../plugins/friends/package.json', import.meta.url), 'utf8'));
const SOCIAL = 'friends/social@1';
const A = `ed25519:${'a'.repeat(64)}`, B = `ed25519:${'b'.repeat(64)}`, F1 = `ed25519:${'1'.repeat(64)}`, F2 = `ed25519:${'2'.repeat(64)}`, F3 = `ed25519:${'3'.repeat(64)}`;
const RESERVED = ['binding', 'profile', 'friends', 'coda/profile', 'coda/friends'];
const ACTIVE = { active: true, until: 1_900_000_000 }, EXPIRED = { active: false };

const until = async (check, what = '条件') => {
  for (let i = 0; i < 400; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error(`等不到：${what}`);
};

// 本机的 Accord：身份与证书可换，记录按页吐（cursor 是下标），发布记下来；过期的证书发布会失败（invalid_state）。
function accordFake({ author = A, certificate = ACTIVE, friends = [], pageSize = 2 } = {}) {
  const fake = { author, certificate, friends, pageSize, records: [], queries: [], calls: [], listeners: new Set(), failure: null, loop: false, withCertificateKey: true, gets: 0, getGate: null, callGate: null, onCall: null, queryGate: null, queryFailure: null };
  const entry = () => ({ kind: 'coda/accord@1', id: 'local', local: true, spec: { author: fake.author },
    status: { friends: structuredClone(fake.friends), ...(fake.withCertificateKey ? { certificate: fake.certificate } : {}) } });
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
      if (fake.failure) throw fake.failure;
      if (fake.certificate?.active !== true) throw Object.assign(new Error('代签证书已过期'), { code: 'invalid_state' });
      const at = fake.records.findIndex(r => r.kind === input.kind && r.id === input.id && r.author === fake.author);
      const version = (at < 0 ? 0 : fake.records[at].version) + 1;
      if (at >= 0) fake.records.splice(at, 1);
      if (input.audience.length) fake.records.push({ author: fake.author, kind: input.kind, id: input.id, version, body: input.body, local: true });
      return { author: fake.author, kind: input.kind, id: input.id, version, audience: input.audience };
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
  return { dir, accord, host, call, status, outbox, publish: input => call('publish', input), retract: input => call('retract', input), self: (name, input) => host.self(name, input) };
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

test('friends merges the friend table with the paged profiles and the local notes, and shows pending friends only when asked', async t => {
  const g = await gateway(t, { friends: [{ node: 'n1', author: F1, bound: true, scope: 's', updatedAt: 5 }, { node: 'n2', author: F2, bound: true, scope: 's', updatedAt: 9 },
    { node: 'n3', author: F3, bound: false, scope: 's', updatedAt: 1 }] });
  g.accord.records.push({ author: F1, kind: 'profile', id: 'self', version: 1, body: { name: '小一', emoji: '🐱', color: 'blue' } },
    { author: F2, kind: 'profile', id: 'self', version: 1, body: { name: '旧名' } }, { author: F2, kind: 'profile', id: 'self', version: 2, body: { name: '小二' } },
    { author: F3, kind: 'profile', id: 'self', version: 1, body: { name: '小三' } });
  await g.self('notes.set', { node: 'n1', note: '老王' });
  const result = await g.call('friends');
  assert.deepEqual([result.selfAuthor, result.certState, result.truncated], [A, 'active', false]);
  assert.deepEqual(result.friends.map(row => [row.node, row.status, row.title, row.profileName, row.emoji, row.color, row.note]),
    [['n2', 'bound', '小二', '小二', '', 'gray', ''], ['n1', 'bound', '老王', '小一', '🐱', 'blue', '老王']]);
  assert.deepEqual(g.accord.queries.map(q => [q.kind, q.limit, q.cursor]), [['profile', 200, undefined], ['profile', 200, '2']]);
  const all = await g.call('friends', { includePending: true });
  assert.deepEqual(all.friends.map(row => [row.node, row.status]), [['n3', 'pending'], ['n2', 'bound'], ['n1', 'bound']]);
});

test('friends stops at a cursor it has seen and says it is truncated; with no identity it reads nothing', async t => {
  const g = await gateway(t, { friends: [{ node: 'n1', author: F1, bound: true }] });
  g.accord.loop = true;
  const result = await g.call('friends');
  assert.equal(result.truncated, true);
  assert.equal(g.accord.queries.length, 2, 'the second page repeats the cursor, so there is no third');
  g.accord.queries.length = 0;
  await g.accord.change({ author: null, certificate: null, friends: [] });
  const none = await g.call('friends', { includePending: true });
  assert.deepEqual(none, { selfAuthor: null, certState: 'no_identity', friends: [], truncated: false });
  assert.deepEqual(g.accord.queries, []);
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

test('publish refuses the five reserved kinds; a good one is synced and its body released, the same content is skipped, a new author sends it again', async t => {
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
