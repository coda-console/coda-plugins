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
import { entryKey, markSynced, queuePublish, queueRetract, retractKey } from '../../../plugins/friends/lib/outbox.mjs';
import { readFrames, writeFrames } from '@coda-console/protocol/frames';
import { normalizeDmInput, normalizeFeedInput } from '../../../plugins/friends/lib/social-streams.mjs';
import { definitionProblem } from '@coda-console/protocol/protocol';
import { pointProblem } from '@coda-console/protocol/validate';

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
      // 基座将来的「预期作者」（coda#3012）：给了就必须与此刻真正署名的作者相同，否则拒签。
      if (input.expectAuthor !== undefined && input.expectAuthor !== fake.author) throw Object.assign(new Error('预期作者与此刻署名的作者不符'), { code: 'forbidden' });
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
  // 测试开过的流先收掉：断言失败时没人读完它们，不收的话心跳定时器会让进程一直挂着。
  const streams = [];
  t.after(async () => { for (const one of streams) await one.frames.return(); deactivate(); await host.close(); await rm(dir, { recursive: true, force: true }); });
  // 网关用到的 Accord 读写走替身；写自己的网关记录、登记处理函数走测试宿主。
  await activate({ ...host.coda, get: ref => ref.kind === 'coda/accord@1' ? accord.get() : host.coda.get(ref), query: accord.query, call: accord.call, watch: accord.watch });
  const [local] = await host.coda.list(SOCIAL, { scope: 'local' }), ref = { kind: SOCIAL, id: local.id };
  const call = (operation, input = {}) => host.call(ref, operation, input);
  const status = async () => (await host.coda.list(SOCIAL, { scope: 'local' }))[0].status;
  const outbox = async () => JSON.parse(await readFile(join(dir, 'outbox.json'), 'utf8').catch(() => '{}')).entries ?? {};
  return { dir, accord, host, ref, streams, call, status, outbox, publish: input => call('publish', input), retract: input => call('retract', input), self: (name, input) => host.self(name, input) };
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
  assert.deepEqual(g.accord.queries.filter(q => q.kind === 'profile').map(q => [q.kind, q.limit, q.cursor]), [['profile', 200, undefined], ['profile', 200, '2']]);
  assert.deepEqual(g.accord.queries.filter(q => q.kind === 'friends/card').map(q => [q.limit, q.cursor]), [[200, undefined]]);
  const all = await g.call('friends', { includePending: true });
  assert.deepEqual(all.friends.map(row => [row.node, row.status]), [['n3', 'pending'], ['n2', 'bound'], ['n1', 'bound']]);
});

test('friends stops at a cursor it has seen and says it is truncated; with no identity it reads nothing', async t => {
  const g = await gateway(t, { friends: [{ node: 'n1', author: F1, bound: true }] });
  g.accord.loop = true;
  const result = await g.call('friends');
  assert.equal(result.truncated, true);
  assert.equal(g.accord.queries.length, 4, 'each kind\'s second page repeats the cursor, so there is no third');
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

const OWNER = '0123abcd-4567-89ef-0123-456789abcdef', HASH = 'ab'.repeat(32);
const AVATAR = { owner: OWNER, path: `content/${HASH}`, sha256: HASH, mime: 'image/png', size: 1024 };

test('set-card publishes the cleaned friends/card self record to the public, clears an avatar with null, and refuses a bad pointer', async t => {
  const g = await gateway(t);
  assert.deepEqual(await g.call('set-card', { name: ' 小明 ', emoji: '🙂', color: 'teal', avatar: AVATAR }), { state: 'synced', author: A, version: 1 });
  assert.deepEqual(g.accord.calls, [{ kind: 'friends/card', id: 'self', body: { name: '小明', emoji: '🙂', color: 'teal', avatar: AVATAR }, audience: ['public'] }]);
  assert.equal((await g.outbox())['p:friends/card:self'].state, 'synced');
  assert.deepEqual(await g.call('set-card', { name: '小明', emoji: '🙂', color: 'teal', avatar: AVATAR }), { state: 'synced', skipped: true, author: A });
  assert.deepEqual(await g.call('set-card', { name: '小明', avatar: null }), { state: 'synced', author: A, version: 2 });
  assert.deepEqual(g.accord.calls.at(-1).body, { name: '小明', avatar: null });
  for (const avatar of [{ ...AVATAR, path: `uploads/${OWNER}` }, { ...AVATAR, path: 'plugins/friends/services/x/a.png' }, { ...AVATAR, sha256: 'cd'.repeat(32) },
    { ...AVATAR, size: 5 * 1024 * 1024 + 1 }, { ...AVATAR, extra: 1 }, { ...AVATAR, name: ' \u0007 ' }]) await rejects(g.call('set-card', { name: '小明', avatar }));
  await rejects(g.call('set-card', { name: '' }));
  await rejects(g.call('set-card', { name: '小明', color: 'red' }));
  assert.equal(g.accord.calls.length, 2, 'a refused card never reaches Accord');
});

test('set-card waits in the outbox while the certificate is expired and goes out once it is active again', async t => {
  const g = await gateway(t, { certificate: EXPIRED });
  assert.deepEqual(await g.call('set-card', { name: '小明', avatar: AVATAR }), { state: 'needs_cert', author: A });
  assert.deepEqual(g.accord.calls, []);
  assert.deepEqual((await g.outbox())['p:friends/card:self'].body, { name: '小明', avatar: AVATAR });
  await g.accord.change({ certificate: ACTIVE });
  await until(async () => (await g.status()).pendingCount === 0, '证书恢复后补发名片');
  assert.deepEqual(g.accord.calls, [{ kind: 'friends/card', id: 'self', body: { name: '小明', avatar: AVATAR }, audience: ['public'] }]);
  assert.equal((await g.outbox())['p:friends/card:self'].state, 'synced');
});

test('friends reads profiles and friends/card records, falls back to the card field by field and gives each row its avatar', async t => {
  const g = await gateway(t, { friends: [{ node: 'n1', author: F1, bound: true, updatedAt: 2 }, { node: 'n2', author: F2, bound: true, updatedAt: 1 }, { node: 'n3', author: F3, bound: true, updatedAt: 0 }] });
  g.accord.records.push({ author: F1, kind: 'profile', id: 'self', version: 1, body: { name: '小一' } },
    { author: F1, kind: 'friends/card', id: 'self', version: 3, body: { name: '卡一', emoji: '🐱', avatar: AVATAR } },
    { author: F2, kind: 'friends/card', id: 'self', version: 1, body: { name: '卡二', color: 'green' } },
    { author: F3, kind: 'friends/card', id: 'self', version: 1, body: { name: '卡三', avatar: { ...AVATAR, path: 'uploads/x' } } });
  const result = await g.call('friends');
  assert.equal(result.truncated, false);
  assert.deepEqual(result.friends.map(row => [row.node, row.profileName, row.emoji, row.color, row.avatar]),
    [['n1', '小一', '🐱', 'gray', AVATAR], ['n2', '卡二', '', 'green', null], ['n3', '卡三', '', 'gray', null]]);
});

test('set-card takes an emoji of up to 8 code points, as the card itself does, and refuses 9', async t => {
  const g = await gateway(t);
  assert.equal((await g.call('set-card', { name: '小明', emoji: '🙂'.repeat(8) })).state, 'synced');
  assert.equal(g.accord.calls.at(-1).body.emoji, '🙂'.repeat(8));
  await rejects(g.call('set-card', { name: '小明', emoji: '🙂'.repeat(9) }));
  assert.equal(g.accord.calls.length, 1);
  // 协议 schema 自己就判到 8：调用方照 schema 填的，处理函数不会再拒。
  const input = manifest.contributes.protocols[0].operations['set-card'].input;
  assert.equal(pointProblem(input, { name: '小明', emoji: '🙂'.repeat(8) }, 'set-card'), null);
  assert.notEqual(pointProblem(input, { name: '小明', emoji: '🙂'.repeat(9) }, 'set-card'), null);
});

// ---- 私信 friends/dm、动态 friends/feed 与它们的实时流 ----

test('the protocol definition is valid, and its new operations and streams belong to the read and publish groups', () => {
  const [definition] = manifest.contributes.protocols;
  assert.equal(definitionProblem(definition, { namespace: 'friends', where: definition.name }), null);
  assert.equal(manifest.version, '0.5.0');
  assert.deepEqual(definition.permissions.read.streams, ['dm', 'feed']);
  assert.deepEqual(definition.permissions.publish.operations, ['publish', 'set-card', 'send-dm', 'post-feed', 'retract', 'outbox']);
  for (const name of ['send-dm', 'post-feed']) assert.equal(definition.operations[name].idempotent, true);
  assert.deepEqual(Object.entries(definition.streams).map(([name, { shape, frames }]) => [name, shape, frames]), [['dm', 'read', true], ['feed', 'read', true]]);
  // schema 与处理函数的边界一致：8000 字、4 个附件、id 200 字、audience 非空。
  const { 'send-dm': dm, 'post-feed': feed } = definition.operations;
  assert.equal(pointProblem(dm.input, { to: B, text: 'x'.repeat(8000) }, 'send-dm'), null);
  assert.notEqual(pointProblem(dm.input, { to: B, text: 'x'.repeat(8001) }, 'send-dm'), null);
  assert.notEqual(pointProblem(dm.input, { to: B, attachments: Array(5).fill(AVATAR) }, 'send-dm'), null);
  assert.notEqual(pointProblem(dm.input, { to: B, text: 'x', id: 'x'.repeat(201) }, 'send-dm'), null);
  assert.notEqual(pointProblem(feed.input, { text: 'x', audience: [] }, 'post-feed'), null);
  assert.equal(pointProblem(feed.input, { text: 'x', audience: Array(500).fill(B) }, 'post-feed'), null);
});

test('send-dm publishes to exactly the one friend, says which id it used, skips a retry of the same id and is withdrawn by retract', async t => {
  const g = await gateway(t);
  const sent = await g.call('send-dm', { to: B, id: 'm1', text: ' 你好 ', attachments: [AVATAR], replyTo: 'm0' });
  assert.deepEqual(sent, { state: 'synced', author: A, version: 1, id: 'm1' });
  const [call] = g.accord.calls;
  assert.deepEqual({ ...call, body: { ...call.body, createdAt: 0 } }, { kind: 'friends/dm', id: 'm1', body: { to: B, text: '你好', attachments: [AVATAR], replyTo: 'm0', createdAt: 0 }, audience: [B] });
  assert.ok(Number.isSafeInteger(call.body.createdAt));
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(await g.call('send-dm', { to: B, id: 'm1', text: '你好', attachments: [AVATAR], replyTo: 'm0' }), { state: 'synced', skipped: true, author: A, id: 'm1' },
    'the retry reuses the createdAt Accord already has, so it is the same message');
  assert.equal(g.accord.calls.length, 1);
  const fresh = await g.call('send-dm', { to: B, text: '没给 id' });
  assert.match(fresh.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(g.accord.calls.at(-1).id, fresh.id);
  assert.deepEqual(await g.retract({ kind: 'friends/dm', id: 'm1' }), { state: 'retracted', count: 1 });
  assert.deepEqual(g.accord.calls.at(-1), { kind: 'friends/dm', id: 'm1', body: {}, audience: [] });
});

test('send-dm refuses the public, oneself, an empty message, a bad pointer and text over 8000 code points before anything is signed', async t => {
  const g = await gateway(t);
  for (const input of [{ to: 'public', text: 'x' }, { to: '', text: 'x' }, { to: A, text: 'x' }, { to: B }, { to: B, text: '   ' }, { to: B, attachments: [] },
    { to: B, attachments: [{ ...AVATAR, path: 'uploads/x' }] }, { to: B, text: '😀'.repeat(8001) }, { to: B, text: 'x', id: ' ' }, { to: B, text: 'x', extra: 1 }])
    await rejects(g.call('send-dm', input));
  assert.equal((await g.call('send-dm', { to: B, text: '😀'.repeat(8000) })).state, 'synced');
  assert.equal(g.accord.calls.length, 1);
  assert.deepEqual(await g.outbox().then(entries => Object.keys(entries).filter(key => key.startsWith('p:friends/dm:')).length), 1);
});

test('send-dm waits in the outbox while the certificate is expired, a retry keeps its createdAt, and it goes out once the certificate is back', async t => {
  const g = await gateway(t, { certificate: EXPIRED });
  assert.deepEqual(await g.call('send-dm', { to: B, id: 'm1', text: '晚点到' }), { state: 'needs_cert', author: A, id: 'm1' });
  const queued = (await g.outbox())['p:friends/dm:m1'];
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(await g.call('send-dm', { to: B, id: 'm1', text: '晚点到' }), { state: 'needs_cert', author: A, id: 'm1' });
  assert.deepEqual((await g.outbox())['p:friends/dm:m1'].body, queued.body);
  assert.deepEqual(g.accord.calls, []);
  await g.accord.change({ certificate: ACTIVE });
  await until(async () => (await g.status()).pendingCount === 0, '证书恢复后补发私信');
  assert.deepEqual(g.accord.calls, [{ kind: 'friends/dm', id: 'm1', body: queued.body, audience: [B] }]);
});

test('post-feed goes to the public by default or to a chosen set of friends, refuses an empty audience and bad media, and is withdrawn by retract', async t => {
  const g = await gateway(t);
  assert.deepEqual(await g.call('post-feed', { id: 'p1', text: '今天天气好' }), { state: 'synced', author: A, version: 1, id: 'p1' });
  assert.deepEqual(g.accord.calls.at(-1).audience, ['public']);
  assert.deepEqual(await g.call('post-feed', { id: 'p2', media: [AVATAR], audience: [B, F1, B] }), { state: 'synced', author: A, version: 1, id: 'p2' });
  assert.deepEqual([g.accord.calls.at(-1).audience, g.accord.calls.at(-1).body.media, g.accord.calls.at(-1).body.text], [[B, F1], [AVATAR], '']);
  for (const input of [{ text: 'x', audience: [] }, { text: 'x', audience: ['friends'] }, {}, { media: [{ ...AVATAR, sha256: 'cd'.repeat(32) }] }, { media: Array(5).fill(AVATAR) }])
    await rejects(g.call('post-feed', input));
  assert.equal(g.accord.calls.length, 2);
  assert.deepEqual(await g.retract({ kind: 'friends/feed', id: 'p2' }), { state: 'retracted', count: 1 });
  assert.deepEqual(g.accord.calls.at(-1), { kind: 'friends/feed', id: 'p2', body: {}, audience: [] });
});

// 开一条流：参数走查询串，像真实宿主一样；返回读帧的迭代器与能中止请求的 controller。
async function openStream(g, name, query = {}) {
  const url = new URL(`http://coda.test/streams/${name}`), controller = new AbortController();
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const response = await g.host.stream(g.ref, name, new Request(url, { signal: controller.signal }));
  const one = { response, frames: readFrames(response.body), controller };
  g.streams.push(one);
  return one;
}
const next = (frames, what = '下一帧') => Promise.race([frames.next().then(step => step.done ? null : step.value),
  new Promise((_, reject) => setTimeout(() => reject(new Error(`等不到：${what}`)), 2000))]);
const dmRecord = (author, id, version, body, local) => ({ author, kind: 'friends/dm', id, version, body, local });
const short = item => [item.author === A ? 'A' : item.author === B ? 'B' : 'F', item.id, item.version];

function seedDms(accord) {
  accord.records.push(
    dmRecord(A, 'm1', 1, { to: B, text: '旧', createdAt: 10 }, true), dmRecord(A, 'm1', 2, { to: B, text: '改过', createdAt: 10 }, true),
    dmRecord(B, 'r1', 1, { to: A, text: '回你', createdAt: 20 }, false),
    dmRecord(B, 'r2', 1, { to: A, text: '撤了', createdAt: 5 }, false), dmRecord(B, 'r2', 2, {}, false),
    dmRecord(F1, 'y', 1, { to: A, text: 'F1 说', createdAt: 15 }, false),
    dmRecord(F1, 'x', 1, { to: B, text: '串线：F1 发给 B 的', createdAt: 1 }, false),
    dmRecord(B, 'z', 1, { to: F1, text: '串线：B 发给 F1 的', createdAt: 2 }, false));
}

test('the dm stream answers ndjson whose first frame is a deduplicated, sorted snapshot, filtered by peer, without cross-talk', async t => {
  const g = await gateway(t, { pageSize: 3 });
  seedDms(g.accord);
  const all = await openStream(g, 'dm');
  assert.equal(all.response.status, 200);
  assert.deepEqual([all.response.headers.get('content-type'), all.response.headers.get('cache-control')], ['application/x-ndjson', 'no-store']);
  const snapshot = await next(all.frames);
  assert.equal(snapshot.type, 'snapshot');
  assert.match(snapshot.cursor, /^[0-9a-f-]{36}:\d+$/);
  assert.deepEqual(snapshot.items.map(short), [['A', 'm1', 2], ['F', 'y', 1], ['B', 'r1', 1]]);
  assert.deepEqual(snapshot.items[0], { author: A, id: 'm1', version: 2, local: true, peer: B, to: B, text: '改过', attachments: [], createdAt: 10 });
  const withB = await openStream(g, 'dm', { peer: B });
  assert.deepEqual((await next(withB.frames)).items.map(short), [['A', 'm1', 2], ['B', 'r1', 1]]);
  await assert.rejects(openStream(g, 'dm', { peer: 'public' }), error => error.code === 'invalid_input');
  await assert.rejects(openStream(g, 'dm', { other: 'x' }), error => error.code === 'invalid_input');
  for (const one of [all, withB]) await one.frames.return();
});

test('the dm stream pushes upserts and retracts as Accord changes and as this machine sends, only to the subscribers they concern', async t => {
  const g = await gateway(t, { pageSize: 50 });
  seedDms(g.accord);
  const withB = await openStream(g, 'dm', { peer: B }), withF1 = await openStream(g, 'dm', { peer: F1 });
  const first = await next(withB.frames);
  await next(withF1.frames);
  g.accord.records.push(dmRecord(B, 'r3', 1, { to: A, text: '在吗', createdAt: 30 }, false), dmRecord(F1, 'x2', 1, { to: B, text: '串线', createdAt: 31 }, false));
  await g.accord.change({});
  const upsert = await next(withB.frames, 'B 的新消息');
  assert.equal(upsert.type, 'upsert');
  assert.deepEqual(short(upsert.item), ['B', 'r3', 1]);
  assert.notEqual(upsert.cursor, first.cursor);
  g.accord.records.push(dmRecord(B, 'r1', 2, {}, false));
  await g.accord.change({});
  const [epoch, seq] = upsert.cursor.split(':');
  assert.deepEqual(await next(withB.frames, 'B 撤回'), { type: 'retract', author: B, id: 'r1', peer: B, cursor: `${epoch}:${Number(seq) + 1}` });
  await g.call('send-dm', { to: B, id: 'm2', text: '我在' });
  const mine = await next(withB.frames, '本机发出的私信');
  assert.deepEqual([mine.type, mine.item.author, mine.item.id, mine.item.peer, mine.item.local], ['upsert', A, 'm2', B, true]);
  await g.call('send-dm', { to: F1, id: 'm3', text: '给 F1' });
  const forF1 = await next(withF1.frames, 'F1 的会话');
  assert.deepEqual([forF1.type, forF1.item.id, forF1.item.peer], ['upsert', 'm3', F1], 'F1 saw neither B\'s messages nor the cross-talk');
  for (const one of [withB, withF1]) await one.frames.return();
});

test('reconnecting with a good cursor replays only the missed changes, withdrawals included, and nothing twice', async t => {
  const g = await gateway(t, { pageSize: 50 });
  seedDms(g.accord);
  const first = await openStream(g, 'dm', { peer: B });
  const { cursor } = await next(first.frames);
  first.controller.abort();
  assert.equal(await next(first.frames, '中止后流结束'), null);
  g.accord.records.push(dmRecord(B, 'r1', 2, {}, false), dmRecord(B, 'r3', 1, { to: A, text: '断线时发的', createdAt: 30 }, false), dmRecord(F1, 'y2', 1, { to: A, text: '别的会话', createdAt: 31 }, false));
  const again = await openStream(g, 'dm', { peer: B, after: cursor });
  const retract = await next(again.frames), upsert = await next(again.frames);
  assert.deepEqual([retract.type, retract.author, retract.id], ['retract', B, 'r1']);
  assert.deepEqual([upsert.type, ...short(upsert.item)], ['upsert', 'B', 'r3', 1]);
  g.accord.records.push(dmRecord(B, 'r4', 1, { to: A, text: '之后的', createdAt: 40 }, false));
  await g.accord.change({});
  const later = await next(again.frames);
  assert.deepEqual([later.type, later.item.id], ['upsert', 'r4'], 'the next frame is the new message, not a repeat');
  const caughtUp = await openStream(g, 'dm', { peer: B, after: later.cursor });
  g.accord.records.push(dmRecord(B, 'r5', 1, { to: A, text: '再一条', createdAt: 50 }, false));
  await g.accord.change({});
  assert.deepEqual((await next(caughtUp.frames)).item.id, 'r5', 'an up-to-date cursor gets no snapshot and no replay');
  for (const one of [again, caughtUp]) await one.frames.return();
});

test('a cursor from another epoch, from the future, malformed or pushed out of the ring buffer falls back to a full snapshot', async t => {
  const g = await gateway(t, { pageSize: 200 });
  seedDms(g.accord);
  const first = await openStream(g, 'dm');
  const { cursor } = await next(first.frames);
  await first.frames.return();
  const [epoch, seq] = cursor.split(':');
  for (const after of ['00000000-0000-4000-8000-000000000000:1', `${epoch}:${Number(seq) + 100}`, 'garbage']) {
    const one = await openStream(g, 'dm', { after });
    const frame = await next(one.frames);
    assert.deepEqual([frame.type, frame.cursor, frame.items.length], ['snapshot', cursor, 3], after);
    await one.frames.return();
  }
  for (let i = 0; i < 501; i++) g.accord.records.push(dmRecord(B, `n${i}`, 1, { to: A, text: `第 ${i} 条`, createdAt: 100 + i }, false));
  const overflow = await openStream(g, 'dm', { after: cursor });
  const frame = await next(overflow.frames);
  assert.deepEqual([frame.type, frame.items.length, frame.cursor], ['snapshot', 504, `${epoch}:${Number(seq) + 501}`]);
  await overflow.frames.return();
});

test('the feed stream gives the newest first, keeps only the highest version, filters by author and pushes changes', async t => {
  const g = await gateway(t, { pageSize: 50 });
  const post = (author, id, version, body, local = false) => ({ author, kind: 'friends/feed', id, version, body, local });
  g.accord.records.push(post(B, 'p1', 1, { text: '旧', createdAt: 1 }), post(B, 'p1', 2, { text: '新', media: [AVATAR], createdAt: 1 }),
    post(F1, 'p2', 1, { text: 'F1', createdAt: 5 }), post(B, 'p3', 1, { text: '撤', createdAt: 9 }), post(B, 'p3', 2, {}));
  const all = await openStream(g, 'feed'), byB = await openStream(g, 'feed', { author: B });
  const snapshot = await next(all.frames);
  assert.deepEqual(snapshot.items.map(short), [['F', 'p2', 1], ['B', 'p1', 2]]);
  assert.deepEqual(snapshot.items[1], { author: B, id: 'p1', version: 2, local: false, text: '新', media: [AVATAR], createdAt: 1 });
  assert.deepEqual((await next(byB.frames)).items.map(short), [['B', 'p1', 2]]);
  await g.call('post-feed', { id: 'mine', text: '我的动态' });
  const mine = await next(all.frames);
  assert.deepEqual([mine.type, mine.item.author, mine.item.id, mine.item.local], ['upsert', A, 'mine', true]);
  g.accord.records.push(post(B, 'p1', 3, {}));
  await g.accord.change({});
  const gone = await next(byB.frames);
  assert.deepEqual([gone.type, gone.author, gone.id], ['retract', B, 'p1'], 'B\'s subscriber skipped A\'s post and got B\'s withdrawal');
  assert.deepEqual([(await next(all.frames)).type], ['retract']);
  for (const one of [all, byB]) await one.frames.return();
});

test('a stream whose caller leaves ends cleanly and stops being refreshed; deactivate ends every open stream', async t => {
  const g = await gateway(t, { pageSize: 50 });
  seedDms(g.accord);
  const one = await openStream(g, 'dm');
  await next(one.frames);
  one.controller.abort();
  assert.equal(await next(one.frames, '调用方走掉后流结束'), null);
  const before = g.accord.queries.length;
  await g.accord.change({});
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(g.accord.queries.filter(q => q.kind === 'friends/dm').length, g.accord.queries.slice(0, before).filter(q => q.kind === 'friends/dm').length,
    'no subscriber left, so a change reads no dm records');
  const dm = await openStream(g, 'dm'), feed = await openStream(g, 'feed');
  await next(dm.frames);
  await next(feed.frames);
  deactivate();
  assert.equal(await next(dm.frames, 'deactivate 后 dm 结束'), null);
  assert.equal(await next(feed.frames, 'deactivate 后 feed 结束'), null);
  await rejects(g.host.stream(g.ref, 'dm', new Request('http://coda.test/streams/dm')), 'not_found');
});

// ---- 边界与流生命周期的回归 ----

// 直接建网关（不经 main.mjs）：要看实时流此刻的订阅者数，和 frames.write 手上还在走的心跳定时器（`heartbeats()`）。
async function direct(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'friends-gateway-')), streams = [], pending = new Set();
  const timers = {
    setTimeout(fn, ms) { const handle = setTimeout(() => { pending.delete(handle); fn(); }, ms); pending.add(handle); return handle; },
    clearTimeout(handle) { pending.delete(handle); clearTimeout(handle); },
  };
  const accord = accordFake(options), host = createMockCoda({ plugin: { id: 'friends', state: dir, protocols: manifest.contributes.protocols } });
  const frames = { ...host.coda.frames, write: (iterable, more) => writeFrames(iterable, { ...more, timers }) };
  const gw = createGateway({ ...host.coda, frames, get: ref => ref.kind === 'coda/accord@1' ? accord.get() : host.coda.get(ref), query: accord.query, call: accord.call, watch: accord.watch }, dir);
  t.after(async () => { for (const one of streams) await one.frames.return(); gw.stop(); await host.close(); await rm(dir, { recursive: true, force: true }); });
  await gw.start();
  const [local] = await host.coda.list(SOCIAL, { scope: 'local' });
  return { gw, accord, host, ref: { kind: SOCIAL, id: local.id }, streams, heartbeats: () => pending.size };
}
// 读完一份分片快照：各片的 items 拼起来，直到 more 为 false。
async function wholeSnapshot(frames) {
  const parts = [];
  for (;;) {
    const frame = await next(frames, '快照分片');
    assert.equal(frame.type, 'snapshot');
    parts.push(frame);
    if (!frame.more) return { cursor: frame.cursor, items: parts.flatMap(part => part.items), parts };
  }
}

test('a snapshot bigger than the 1 MiB frame limit is sent in pieces that the default readFrames reads whole', async t => {
  const g = await gateway(t, { pageSize: 200 });
  for (let i = 0; i < 40; i++) g.accord.records.push(dmRecord(B, `big${i}`, 1, { to: A, text: '😀'.repeat(8000), createdAt: i }, false));
  const one = await openStream(g, 'dm');
  const { items, parts } = await wholeSnapshot(one.frames);
  assert.ok(parts.length > 4, `${parts.length} pieces`);
  assert.deepEqual(items.map(item => item.id), Array.from({ length: 40 }, (_, i) => `big${i}`));
  assert.ok(parts.every(part => part.cursor === parts[0].cursor));
  assert.ok(items.every(item => item.text === '😀'.repeat(8000)));
  const empty = await openStream(g, 'feed'), frame = await next(empty.frames);
  assert.match(frame.cursor, /^[0-9a-f-]{36}:0$/);
  assert.deepEqual(frame, { type: 'snapshot', cursor: frame.cursor, items: [], more: false }, 'an empty snapshot is one frame saying more: false');
});

test('a live stream reads every page; a truncated or failed read never reaches the hub, and with no complete read yet a new stream fails before its first byte', async t => {
  const g = await gateway(t, { pageSize: 2 });
  g.accord.loop = true;
  await assert.rejects(openStream(g, 'dm'), error => error.code === 'unavailable');
  g.accord.loop = false;
  g.accord.queryFailure = new Error('Accord 暂时不可用');
  await assert.rejects(openStream(g, 'dm'), error => error.code === 'unavailable');
  g.accord.queryFailure = null;
  for (let i = 0; i < 120; i++) g.accord.records.push(dmRecord(B, `p${i}`, 1, { to: A, text: `${i}`, createdAt: i }, false));
  const one = await openStream(g, 'dm');
  assert.equal((await wholeSnapshot(one.frames)).items.length, 120, 'all 60 pages, past the 50 a friends read stops at');
  // 截断的一次读（只给空页）若当真，会把 120 条全撤掉；它被丢下，下一帧是之后真正的新消息。
  g.accord.loop = true;
  const before = g.accord.queries.length;
  await g.accord.change({});
  await until(() => g.accord.queries.length > before, '截断的那次读');
  const late = await openStream(g, 'dm');
  assert.equal((await wholeSnapshot(late.frames)).items.length, 120, 'a stream joining meanwhile gets the last complete projection');
  g.accord.loop = false;
  g.accord.records.push(dmRecord(B, 'new', 1, { to: A, text: '新的', createdAt: 999 }, false));
  await g.accord.change({});
  const frame = await next(one.frames, '新消息');
  assert.deepEqual([frame.type, frame.item?.id], ['upsert', 'new']);
});

test('a message sent again under the same id to another friend is withdrawn from the old conversation, live and on reconnect', async t => {
  const g = await gateway(t, { pageSize: 50 });
  await g.call('send-dm', { to: B, id: 'm1', text: '发错人了' });
  const withB = await openStream(g, 'dm', { peer: B }), withF1 = await openStream(g, 'dm', { peer: F1 });
  const { cursor } = await wholeSnapshot(withB.frames);
  await wholeSnapshot(withF1.frames);
  assert.equal((await g.call('send-dm', { to: F1, id: 'm1', text: '发错人了' })).state, 'synced');
  assert.deepEqual(await next(withB.frames, 'B 那边撤回'), { type: 'retract', author: A, id: 'm1', peer: B, cursor: cursor.replace(/\d+$/, n => `${Number(n) + 1}`) });
  const moved = await next(withF1.frames, 'F1 那边收到');
  assert.deepEqual([moved.type, moved.item.id, moved.item.peer, moved.item.to], ['upsert', 'm1', F1, F1]);
  const again = await openStream(g, 'dm', { peer: B, after: cursor });
  const replay = await next(again.frames, '重连补发撤回');
  assert.deepEqual([replay.type, replay.id, replay.peer], ['retract', 'm1', B]);
});

test('a message queued with no identity is never signed to oneself: when the identity bound turns out to be its recipient the flush marks it refused', async t => {
  const g = await gateway(t, { author: null, certificate: null });
  assert.deepEqual(await g.call('send-dm', { to: A, id: 'm1', text: '给未来的自己' }), { state: 'no_identity', author: null, id: 'm1' });
  await g.accord.change({ author: A, certificate: ACTIVE });
  await until(async () => (await g.outbox())['p:friends/dm:m1']?.state === 'error', '补发时拒签给自己的私信');
  assert.match((await g.outbox())['p:friends/dm:m1'].lastError, /自己/);
  assert.deepEqual(g.accord.calls, []);
  assert.equal((await g.status()).pendingCount, 0);
});

test('a retry reuses the createdAt kept as lastCreatedAt once synced; without it, a failed lookup is a retryable error and never a new timestamp', async t => {
  const g = await gateway(t);
  await g.call('send-dm', { to: B, id: 'm1', text: '一次' });
  const createdAt = g.accord.calls[0].body.createdAt, synced = (await g.outbox())['p:friends/dm:m1'];
  assert.deepEqual([synced.state, synced.lastCreatedAt, synced.body], ['synced', createdAt, undefined]);
  g.accord.queryFailure = new Error('Accord 暂时不可用');
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(await g.call('send-dm', { to: B, id: 'm1', text: '一次' }), { state: 'synced', skipped: true, author: A, id: 'm1' }, 'no lookup needed');
  // 已在 Accord 里、队列里却没有的一条（如换了机器）：查不出来就报错，不重签。
  g.accord.records.push(dmRecord(A, 'old', 1, { to: B, text: '早就发了', createdAt: 5 }, true));
  await rejects(g.call('send-dm', { to: B, id: 'old', text: '早就发了' }), 'unavailable');
  await rejects(g.call('post-feed', { id: 'old', text: 'x' }), 'unavailable');
  assert.equal(g.accord.calls.length, 1);
  g.accord.queryFailure = null;
  assert.equal((await g.call('send-dm', { to: B, id: 'old', text: '早就发了' })).state, 'synced');
  assert.equal(g.accord.calls.at(-1).body.createdAt, 5, 'once the lookup works the stored createdAt is used');
  assert.equal((await g.call('send-dm', { to: B, text: '没给 id 的不用查' })).state, 'synced');
});

test('the schema and the handler agree on the id bytes and the text length: 86 Han characters pass the schema and are refused plainly, 8000 code points and a space by both', async t => {
  const g = await gateway(t);
  const { 'send-dm': dm, 'post-feed': feed } = manifest.contributes.protocols[0].operations;
  assert.equal(pointProblem(dm.input, { to: B, text: 'x', id: '好'.repeat(86) }, 'send-dm'), null, 'JSON Schema counts characters, not bytes');
  await rejects(g.call('send-dm', { to: B, text: 'x', id: '好'.repeat(86) }));
  await rejects(g.call('post-feed', { text: 'x', id: '好'.repeat(86) }));
  await rejects(g.call('send-dm', { to: B, text: 'x', replyTo: '好'.repeat(86) }));
  assert.equal((await g.call('send-dm', { to: B, text: 'x', id: '好'.repeat(85) })).state, 'synced');
  for (const [input, value] of [[dm.input, { to: B, text: `${'😀'.repeat(8000)} ` }], [feed.input, { text: `${'😀'.repeat(8000)} ` }]])
    assert.notEqual(pointProblem(input, value, 'x'), null);
  for (const [input, value] of [[dm.input, { to: B, text: 'x', id: 'a\u0000b' }], [dm.input, { to: B, text: 'x', replyTo: 'a\nb' }], [feed.input, { text: 'x', id: '\u0007' }]])
    assert.notEqual(pointProblem(input, value, 'x'), null, 'the schema refuses control characters too');
  assert.equal(g.accord.calls.length, 1);
});

test('a stream opened and never read is released the moment its caller aborts or the gateway stops, its heartbeat timer cleared with it', async t => {
  const g = await direct(t);
  await openStream(g, 'dm');
  const feed = await openStream(g, 'feed');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([g.gw.subscriberCount(), g.heartbeats()], [{ dm: 1, feed: 1 }, 2], 'both first frames wait unread behind backpressure, each with a heartbeat timer');
  feed.controller.abort();
  assert.deepEqual([g.gw.subscriberCount(), g.heartbeats()], [{ dm: 1, feed: 0 }, 1]);
  await openStream(g, 'feed');
  assert.equal(g.heartbeats(), 2);
  g.gw.stop();
  assert.deepEqual([g.gw.subscriberCount(), g.heartbeats()], [{ dm: 0, feed: 0 }, 0]);
});

test('cancelling the response body of an idle stream finishes at once and releases its subscription', async t => {
  const g = await direct(t);
  const url = 'http://coda.test/streams/dm', response = await g.host.stream(g.ref, 'dm', new Request(url));
  const reader = response.body.getReader(), first = await reader.read();
  assert.equal(JSON.parse(new TextDecoder().decode(first.value)).type, 'snapshot');
  reader.releaseLock();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(g.gw.subscriberCount().dm, 1, 'idle, waiting for a change');
  await Promise.race([response.body.cancel(), new Promise((_, reject) => setTimeout(() => reject(new Error('取消没有立刻完成')), 500))]);
  assert.deepEqual([g.gw.subscriberCount().dm, g.heartbeats()], [0, 0]);
});

test('the schema and the normalizer refuse the same ids and replyTos: blank ones and ones with control characters, at the schema already', () => {
  const { 'send-dm': dm, 'post-feed': feed } = manifest.contributes.protocols[0].operations;
  const samples = [' ', '   ', '\t', '\u3000', '\u2028', 'a\u0000b', 'a\nb', '\u0007', '\u0085x', 'x\u009f', 'x', ' m1 ', '好', '\u2028x', 'a b', '\u3000好'];
  const takes = fn => { try { fn(); return true; } catch { return false; } };
  const at = { selfAuthor: A, now: 1 };
  const cases = [
    [dm.input, value => ({ to: B, text: 'x', id: value }), input => normalizeDmInput(input, at)],
    [dm.input, value => ({ to: B, text: 'x', replyTo: value }), input => normalizeDmInput(input, at)],
    [feed.input, value => ({ text: 'x', id: value }), input => normalizeFeedInput(input, at)],
  ];
  for (const [schema, build, normalize] of cases) for (const value of samples) {
    const input = build(value), bySchema = pointProblem(schema, input, 'x') === null;
    assert.equal(bySchema, takes(() => normalize(input)), JSON.stringify(input));
  }
  assert.deepEqual(samples.map(value => pointProblem(dm.input, { to: B, text: 'x', id: value }, 'x') === null),
    [false, false, false, false, false, false, false, false, false, false, true, true, true, true, true, true]);
});

test('switching the identity resets the dm hub: an open stream of the old author ends, and a failed read never hands the new author the old one\'s messages', async t => {
  const g = await gateway(t, { pageSize: 50 });
  g.accord.records.push(dmRecord(A, 'secret', 1, { to: F1, text: 'A 写给 F1 的', createdAt: 1 }, true), dmRecord(F1, 'hi', 1, { to: A, text: 'F1 写给 A 的', createdAt: 2 }, false));
  const old = await openStream(g, 'dm');
  const before = await wholeSnapshot(old.frames);
  assert.deepEqual(before.items.map(item => item.id), ['secret', 'hi']);
  // 切到 B 的同时 Accord 查不了：换 hub 时关掉 A 的流，B 那份读不出来就不算就绪。
  g.accord.queryFailure = new Error('Accord 暂时不可用');
  await g.accord.change({ author: B });
  assert.equal(await next(old.frames, '旧作者的流结束'), null);
  await assert.rejects(openStream(g, 'dm'), error => error.code === 'unavailable', 'nothing cached is B\'s yet');
  g.accord.queryFailure = null;
  const fresh = await openStream(g, 'dm', { after: before.cursor });
  const snapshot = await wholeSnapshot(fresh.frames);
  assert.deepEqual(snapshot.items, [], 'none of A\'s conversations are B\'s');
  assert.notEqual(snapshot.cursor.split(':')[0], before.cursor.split(':')[0], 'a new epoch, so A\'s cursor starts over');
  // 读不出本机作者时也不复用缓存。
  const getFails = Object.assign(new Error('读不到 Accord'), { code: 'unavailable' });
  const get = g.accord.get;
  g.accord.get = async () => { throw getFails; };
  await assert.rejects(openStream(g, 'dm'), error => error.code === 'unavailable');
  g.accord.get = get;
});

test('a retry by another author under the same id does not take the createdAt the first author synced, but its own from Accord', async t => {
  const g = await gateway(t);
  await g.call('send-dm', { to: F1, id: 'm1', text: '同一个 id' });
  const first = g.accord.calls[0].body.createdAt;
  assert.equal((await g.outbox())['p:friends/dm:m1'].lastCreatedAt, first);
  await g.accord.change({ author: B });
  g.accord.records.push(dmRecord(B, 'm1', 1, { to: F1, text: '同一个 id', createdAt: 42 }, true));
  const queries = g.accord.queries.length;
  assert.equal((await g.call('send-dm', { to: F1, id: 'm1', text: '同一个 id' })).state, 'synced');
  assert.equal(g.accord.calls.at(-1).body.createdAt, 42);
  assert.ok(g.accord.queries.slice(queries).some(q => q.kind === 'friends/dm' && q.author === B && q.id === 'm1'), 'looked up under B');
});

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
  assert.equal(g.accord.queries.some(query => query.kind.startsWith('friends/rpc-')), false);

  // 只有这类条目、没有别的待发时，下一次冲洗也清掉它们。
  const only = Object.fromEntries([put(queuePublish(undefined, item('friends/rpc-call', 'c2'), 6)), put(markSynced(queuePublish(undefined, item('friends/rpc-answer', 'a2'), 7), A, 5))]);
  await writeFile(join(g.dir, 'outbox.json'), JSON.stringify({ seq: 7, entries: { ...(await g.outbox()), ...only } }));
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
  g.accord.seed('friends/dm', ['d1'], { author: B, local: false });
  assert.equal((await g.call('records', { kind: 'friends/dm' })).records.length, 1);
});

test('the dm and feed streams only ever read their own kinds, so no friends/rpc- record shows up in a snapshot or a later frame', async t => {
  const g = await gateway(t, { pageSize: 50 });
  seedDms(g.accord);
  for (const kind of RPC) g.accord.seed(kind, ['c1', 'd1'], { author: B, local: false });
  g.accord.records.push({ author: B, kind: 'friends/feed', id: 'f1', version: 1, body: { text: '动态', createdAt: 30 }, local: false });
  const dm = await openStream(g, 'dm'), feed = await openStream(g, 'feed');
  const dmSnapshot = await next(dm.frames), feedSnapshot = await next(feed.frames);
  assert.deepEqual(dmSnapshot.items.map(short), [['A', 'm1', 2], ['F', 'y', 1], ['B', 'r1', 1]]);
  assert.deepEqual(feedSnapshot.items.map(item => item.id), ['f1']);
  // 之后又来了这类记录和一条动态：帧里只有动态。
  g.accord.records.push({ author: B, kind: 'friends/rpc-call', id: 'c9', version: 1, body: { text: 'x', createdAt: 99 }, local: false },
    { author: B, kind: 'friends/feed', id: 'f2', version: 1, body: { text: '又一条', createdAt: 40 }, local: false });
  await g.accord.change({});
  const frame = await next(feed.frames);
  assert.deepEqual([frame.type, frame.item.id], ['upsert', 'f2']);
  assert.ok(g.accord.queries.length > 0);
  assert.deepEqual([...new Set(g.accord.queries.map(query => query.kind))].sort(), ['friends/dm', 'friends/feed']);
  assert.equal(JSON.stringify([dmSnapshot, feedSnapshot, frame]).includes('rpc'), false);
});

// 一条要签的记录：正文里的发送方按种类取（grant、answer 是 holder，call 是 caller），默认是 A。
const SENDER = { 'friends/rpc-call': 'caller', 'friends/rpc-grant': 'holder', 'friends/rpc-answer': 'holder' };
const sign = ({ from = A, ...more } = {}) => ({ kind: 'friends/rpc-call', id: 'c1', body: { v: 1, n: 1, [SENDER[more.kind ?? 'friends/rpc-call']]: from }, audience: [F1], ...more });

test('the internal signer publishes the three rpc kinds to one recipient with expectAuthor, and is not an operation of the gateway or of coda self', async t => {
  const d = await direct(t);
  const done = await d.gw.signRpc(sign());
  assert.deepEqual(d.accord.calls, [{ kind: 'friends/rpc-call', id: 'c1', body: { v: 1, n: 1, caller: A }, audience: [F1], expectAuthor: A }]);
  assert.deepEqual([done.author, done.version], [A, 1]);
  for (const kind of ['friends/rpc-grant', 'friends/rpc-answer']) await d.gw.signRpc(sign({ kind, id: `${kind}-1` }));
  assert.deepEqual(d.accord.calls.map(call => call.kind), ['friends/rpc-call', 'friends/rpc-grant', 'friends/rpc-answer']);
  // 同一个 id 再签是更高的版本（取消用它）。
  assert.equal((await d.gw.signRpc(sign({ body: { v: 1, n: 1, caller: A, cancel: true } }))).version, 2);
  // 本机此刻应署的根跟着身份变。
  await d.accord.change({ author: B });
  await d.gw.signRpc(sign({ id: 'c2', audience: [F2], from: B }));
  assert.equal(d.accord.calls.at(-1).expectAuthor, B);
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

test('the internal signer fails on the spot when the certificate is not active: invalid_state, nothing sent, nothing queued', async t => {
  const d = await direct(t, { certificate: EXPIRED });
  const failed = () => assert.rejects(d.gw.signRpc(sign()), error => error.code === 'invalid_state' && error.effects === 'none');
  await failed();
  await d.accord.change({ author: null, certificate: null, friends: [] });
  await failed();
  // 证书项里写着未生效（active 不是 true）也一样；旧宿主没有证书这个键、有作者就当可用，签的时候由 Accord 说了算。
  await d.accord.change({ author: A, certificate: { active: false, until: 1_000 } });
  await failed();
  assert.deepEqual(d.accord.calls, []);
  await assert.rejects(readFile(join(d.host.coda.plugin.state, 'outbox.json')), { code: 'ENOENT' });
  await d.accord.change({ certificate: ACTIVE });
  assert.equal((await d.gw.signRpc(sign())).version, 1);
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
  // 签名入口读身份之前，作者就换成了 B：为 A 写的记录，三种都当场失败，什么也没发。
  await d.accord.change({ author: B });
  for (const kind of kinds) await notYou({ kind, id: `${kind}-1`, from: A });
  assert.deepEqual(d.accord.calls, []);
  // 为 B 写的就能签，expectAuthor 是正文里的发送方。
  for (const kind of kinds) await d.gw.signRpc(sign({ kind, id: `${kind}-1`, from: B }));
  assert.deepEqual(d.accord.calls.map(call => [call.kind, call.expectAuthor, call.body[SENDER[call.kind]]]), kinds.map(kind => [kind, B, B]));
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
