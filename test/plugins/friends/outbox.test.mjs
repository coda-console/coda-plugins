// 网关的纯逻辑：保留类型、入参校验的边界、证书状态、规范哈希、待发条目的状态转换与持久化、策略文件。
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { RESERVED_KINDS, canSkip, canonicalHash, certStateOf, checkId, checkKind, checkPublish, entryKey, holdState, nextSeq, retractKey, isPending, markRejected, markSynced,
  queuePublish, queueRetract, readOutbox, withState, writeOutbox } from '../../../plugins/friends/lib/outbox.mjs';
import { readPolicy, setKindPaused } from '../../../plugins/friends/lib/policy.mjs';

const A = `ed25519:${'a'.repeat(64)}`, B = `ed25519:${'b'.repeat(64)}`;
const directory = async t => {
  const dir = await mkdtemp(join(tmpdir(), 'friends-outbox-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};
const refuses = (fn, pattern = /./) => assert.throws(fn, error => error.code === 'invalid_input' && pattern.test(error.message));

test('the six reserved kinds are refused, and a kind must have Accord\'s shape', () => {
  assert.deepEqual([...RESERVED_KINDS].sort(), ['binding', 'coda/friends', 'coda/profile', 'friends', 'friends/card', 'profile']);
  for (const kind of RESERVED_KINDS) refuses(() => checkKind(kind), /保留类型/);
  for (const kind of ['Upper', '1abc', 'a/b/c', 'a/', '/b', '', 'a_b', `a${'b'.repeat(64)}`, undefined, 3]) refuses(() => checkKind(kind));
  for (const kind of ['x', 'ns/name', 'a-b/c-d', `a${'b'.repeat(63)}`, 'profiles', 'coda/profiles']) assert.equal(checkKind(kind), kind);
});

test('an id is non-empty, well-formed UTF-8, at most 200 characters and 256 bytes; a records query only has the byte limit', () => {
  refuses(() => checkId(''));
  refuses(() => checkId(3));
  refuses(() => checkId('a\ud800'));
  assert.equal(checkId('x'.repeat(200)), 'x'.repeat(200));
  refuses(() => checkId('x'.repeat(201)), /200/);
  // 100 个汉字是 300 字节：字符数够，字节数超过 256。
  refuses(() => checkId('好'.repeat(100)), /256/);
  assert.equal(checkId('好'.repeat(85)).length, 85);
  assert.equal(checkId('x'.repeat(256), { query: true }).length, 256);
  refuses(() => checkId('x'.repeat(257), { query: true }), /256/);
  assert.equal(checkId('好'.repeat(85), { query: true }).length, 85);
  refuses(() => checkId('好'.repeat(86), { query: true }), /256/);
});

test('a publish needs a plain object body of at most 65536 bytes and an audience of at most 500 public or key entries', () => {
  assert.deepEqual(checkPublish({ kind: 'x', id: 'i', body: { a: 1 } }), { kind: 'x', id: 'i', body: { a: 1 }, audience: ['public'] });
  assert.deepEqual(checkPublish({ kind: 'x', id: 'i', body: {}, audience: [A, 'public'] }).audience, [A, 'public']);
  for (const body of [null, [], 'text', 1, undefined, new Date(), new Map(), { a: 1n }]) refuses(() => checkPublish({ kind: 'x', id: 'i', body }));
  const cycle = {};
  cycle.self = cycle;
  refuses(() => checkPublish({ kind: 'x', id: 'i', body: cycle }));
  // JSON 正好 65536 字节可以，多一个字节不行。
  const sized = size => ({ text: 'x'.repeat(size - JSON.stringify({ text: '' }).length) });
  assert.equal(Buffer.byteLength(JSON.stringify(sized(65536))), 65536);
  checkPublish({ kind: 'x', id: 'i', body: sized(65536) });
  refuses(() => checkPublish({ kind: 'x', id: 'i', body: sized(65537) }), /65536/);
  refuses(() => checkPublish({ kind: 'profile', id: 'self', body: {} }), /保留类型/);
  checkPublish({ kind: 'x', id: 'i', body: {}, audience: Array.from({ length: 500 }, () => 'public') });
  refuses(() => checkPublish({ kind: 'x', id: 'i', body: {}, audience: Array.from({ length: 501 }, () => 'public') }), /500/);
  for (const audience of ['public', [1], ['everyone'], ['ed25519:abc'], [`ed25519:${'A'.repeat(64)}`], [`${A}0`]]) refuses(() => checkPublish({ kind: 'x', id: 'i', body: {}, audience }));
  // 校验后的 body 是一份拷贝，改原对象不影响它。
  const body = { nested: { n: 1 } }, checked = checkPublish({ kind: 'x', id: 'i', body });
  body.nested.n = 2;
  assert.equal(checked.body.nested.n, 1);
});

test('the cert state follows the certificate key when the host writes it, and the author when it does not', () => {
  assert.equal(certStateOf(null), 'no_identity');
  assert.equal(certStateOf(undefined), 'no_identity');
  assert.equal(certStateOf({ spec: { author: A }, status: { certificate: null } }), 'no_identity');
  assert.equal(certStateOf({ spec: { author: A }, status: { certificate: { active: true, until: 9 } } }), 'active');
  assert.equal(certStateOf({ spec: { author: A }, status: { certificate: { active: false } } }), 'needs_cert');
  assert.equal(certStateOf({ spec: { author: A }, status: { certificate: {} } }), 'needs_cert');
  // 旧宿主没有 certificate 这个键。
  assert.equal(certStateOf({ spec: { author: A }, status: { friends: [] } }), 'active');
  assert.equal(certStateOf({ spec: {}, status: {} }), 'no_identity');
  assert.equal(certStateOf({ spec: { author: A } }), 'active');
});

test('the canonical hash ignores key order at every depth and tells different content apart', () => {
  const one = canonicalHash({ body: { b: 1, a: { y: [1, { q: 1, p: 2 }], x: 'x' } }, audience: ['public'] });
  const two = canonicalHash({ audience: ['public'], body: { a: { x: 'x', y: [1, { p: 2, q: 1 }] }, b: 1 } });
  assert.match(one, /^[0-9a-f]{64}$/);
  assert.equal(one, two);
  assert.notEqual(one, canonicalHash({ body: { b: 1, a: { y: [{ q: 1, p: 2 }, 1], x: 'x' } }, audience: ['public'] }));
  assert.notEqual(one, canonicalHash({ body: { b: 1, a: { y: [1, { q: 1, p: 2 }], x: 'x' } }, audience: [A] }));
});

test('a publish that reaches Accord releases its body and keeps only what dedup needs; the same author and content is skipped, a new author is not', () => {
  const item = { kind: 'x', id: 'i', body: { v: 1 }, audience: ['public'] };
  const pending = queuePublish(undefined, item, 1);
  assert.deepEqual(pending, { seq: 1, kind: 'x', id: 'i', desired: 'publish', state: 'queued', body: { v: 1 }, audience: ['public'], hash: canonicalHash({ body: item.body, audience: item.audience }) });
  assert.ok(isPending(pending));
  const done = markSynced(pending, A, 1000);
  assert.deepEqual(done, { seq: 1, kind: 'x', id: 'i', desired: 'publish', state: 'synced', hash: pending.hash, audience: ['public'], lastAuthor: A, lastSyncedHash: pending.hash, lastSyncedAt: 1000 });
  assert.equal('body' in done, false);
  assert.equal(isPending(done), false);
  assert.equal(canSkip(done, pending.hash, A), true);
  assert.equal(canSkip(done, pending.hash, B), false, 'another author must publish again');
  assert.equal(canSkip(done, pending.hash, null), false);
  assert.equal(canSkip(done, canonicalHash({ body: { v: 2 }, audience: ['public'] }), A), false);
  assert.equal(canSkip(undefined, pending.hash, A), false);
  // 同步过的内容之后又排了新版本，再发回旧内容也要发：条目不在已同步状态。
  const next = queuePublish(done, { ...item, body: { v: 2 } });
  assert.deepEqual([next.lastAuthor, next.lastSyncedHash, next.lastSyncedAt, next.body], [A, pending.hash, 1000, { v: 2 }]);
  assert.equal(canSkip(next, pending.hash, A), false);
  assert.equal(canSkip({ ...done, desired: 'retract' }, pending.hash, A), false);
});

test('a retract is a queued entry that keeps what was last synced; a rejection drops the body and stops being pending', () => {
  const done = markSynced(queuePublish(undefined, { kind: 'x', id: 'i', body: { v: 1 }, audience: [A] }), A, 7);
  const retract = queueRetract(done, 'x', 'i', A, 2);
  assert.deepEqual(retract, { seq: 2, kind: 'x', id: 'i', desired: 'retract', state: 'queued', targetAuthor: A, lastAuthor: A, lastSyncedHash: done.hash, lastSyncedAt: 7 });
  assert.deepEqual(withState(retract, 'needs_cert', '过期'), { ...retract, state: 'needs_cert', lastError: '过期' });
  assert.equal('lastError' in withState(withState(retract, 'queued', '断了'), 'queued'), false);
  const rejected = markRejected(queuePublish(done, { kind: 'x', id: 'i', body: { v: 2 }, audience: ['public'] }), '不允许');
  assert.equal(rejected.state, 'error');
  assert.equal(rejected.lastError, '不允许');
  assert.equal('body' in rejected || 'audience' in rejected, false);
  assert.equal(isPending(rejected), false);
  assert.equal(rejected.lastAuthor, A);
});

test('what holds an entry back: a paused kind (publishes only), no identity, an expired certificate', () => {
  const publish = queuePublish(undefined, { kind: 'x', id: 'i', body: {}, audience: ['public'] }), retract = queueRetract(undefined, 'x', 'i', A);
  assert.equal(holdState(publish, 'active', []), null);
  assert.equal(holdState(publish, 'active', ['y']), null);
  assert.equal(holdState(publish, 'active', ['x']), 'paused');
  assert.equal(holdState(retract, 'active', ['x']), null, 'a withdrawal is never held back by a pause');
  assert.equal(holdState(publish, 'needs_cert', []), 'needs_cert');
  assert.equal(holdState(retract, 'no_identity', ['x']), 'no_identity');
  assert.equal(holdState(publish, 'no_identity', ['x']), 'paused');
});

test('the outbox file is read back by key (renamed from the entry itself), and a missing, broken or malformed file or entry is dropped', async t => {
  const dir = await directory(t);
  assert.deepEqual(await readOutbox(dir), {});
  const entry = queuePublish(undefined, { kind: 'x', id: 'a:b', body: { v: 1 }, audience: ['public'] }, 1);
  await writeOutbox(dir, { [entryKey('x', 'a:b')]: entry });
  assert.deepEqual(await readOutbox(dir), { 'p:x:a:b': entry });
  const retract = queueRetract(undefined, 'x', 'i', A, 2);
  await writeFile(join(dir, 'outbox.json'), JSON.stringify({ 'x:a:b': entry, 'retract:old': retract, 'x:e': { kind: 'x', id: 'e', desired: 'oops', state: 'queued' },
    'x:f': 'text', 'y:g': null, 'x:h': { kind: 'x', id: 'h', desired: 'retract', state: 'queued' }, __proto__: null }));
  assert.deepEqual(await readOutbox(dir), { 'p:x:a:b': entry, [`r:${A}:x:i`]: retract }, 'old key names are renamed, malformed entries dropped');
  for (const text of ['{broken', '[]', 'null', '"x"']) {
    await writeFile(join(dir, 'outbox.json'), text);
    assert.deepEqual(await readOutbox(dir), {});
  }
});

test('reading the outbox drops entries of a reserved kind such as a stale friends/card and counts them, keeping the other entries and the sequence', async t => {
  const dir = await directory(t);
  const card = { ...queuePublish(undefined, { kind: 'friends/card', id: 'self', body: { name: '旧' }, audience: ['public'] }, 7), state: 'needs_cert' };
  const cardRetract = queueRetract(undefined, 'friends/card', 'self', A, 8);
  const keep = queuePublish(undefined, { kind: 'x', id: 'i', body: { v: 1 }, audience: ['public'] }, 3);
  await writeFile(join(dir, 'outbox.json'), JSON.stringify({ seq: 8, entries: { [entryKey('friends/card', 'self')]: card, [retractKey(A, 'friends/card', 'self')]: cardRetract, [entryKey('x', 'i')]: keep } }));
  const read = await readOutbox(dir);
  assert.deepEqual(read, { 'p:x:i': keep });
  assert.equal(read.dropped, 2);
  assert.equal(nextSeq(read), 9, 'the sequence never goes back');
  await writeOutbox(dir, read);
  const clean = await readOutbox(dir);
  assert.equal(clean.dropped, 0);
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'outbox.json'), 'utf8')).entries, { 'p:x:i': keep });
});

test('the policy file keeps the paused kinds sorted and unique, refuses reserved and malformed kinds, and falls back to none when missing or broken', async t => {
  const dir = await directory(t);
  assert.deepEqual(await readPolicy(dir), { pausedKinds: [] });
  assert.deepEqual(await setKindPaused(dir, 'b', true), { pausedKinds: ['b'] });
  assert.deepEqual(await setKindPaused(dir, 'a/x', true), { pausedKinds: ['a/x', 'b'] });
  assert.deepEqual(await setKindPaused(dir, 'b', true), { pausedKinds: ['a/x', 'b'] });
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'policy.json'), 'utf8')), { pausedKinds: ['a/x', 'b'] });
  assert.deepEqual(await readPolicy(dir), { pausedKinds: ['a/x', 'b'] });
  assert.deepEqual(await setKindPaused(dir, 'a/x', false), { pausedKinds: ['b'] });
  assert.deepEqual(await setKindPaused(dir, 'zzz', false), { pausedKinds: ['b'] });
  for (const kind of [...RESERVED_KINDS, 'Bad', '', undefined]) await assert.rejects(setKindPaused(dir, kind, true), error => error.code === 'invalid_input');
  await writeFile(join(dir, 'policy.json'), JSON.stringify({ pausedKinds: ['ok', 'profile', 'Bad', 3, 'ok'] }));
  assert.deepEqual(await readPolicy(dir), { pausedKinds: ['ok'] });
  for (const text of ['{broken', '[]', 'null', '{"pausedKinds":"x"}']) {
    await writeFile(join(dir, 'policy.json'), text);
    assert.deepEqual(await readPolicy(dir), { pausedKinds: [] });
  }
});

test('only a missing file or broken JSON reads as empty; any other read error is thrown, so an unreadable file is never taken for an empty table', async t => {
  const dir = await directory(t);
  await mkdir(join(dir, 'outbox.json'));
  await mkdir(join(dir, 'policy.json'));
  await assert.rejects(readOutbox(dir), { code: 'EISDIR' });
  await assert.rejects(readPolicy(dir), { code: 'EISDIR' });
  await assert.rejects(setKindPaused(dir, 'x', true), { code: 'EISDIR' });
  await assert.rejects(writeOutbox(dir, {}));
});

test('a policy write is stopped by its beforeWrite hook before anything is written', async t => {
  const dir = await directory(t);
  await assert.rejects(setKindPaused(dir, 'x', true, () => { throw new Error('停了'); }), /停了/);
  assert.deepEqual(await readPolicy(dir), { pausedKinds: [] });
  await assert.rejects(readFile(join(dir, 'policy.json')), { code: 'ENOENT' });
});

test('publish and withdrawal keys never collide, whichever of them is queued first', async t => {
  const dir = await directory(t);
  const retract = queueRetract(undefined, 'x', 'same', A, 1), publish = queuePublish(undefined, { kind: 'retract', id: `${A}:x:same`, body: {}, audience: ['public'] }, 2);
  assert.notEqual(retractKey(A, 'x', 'same'), entryKey('retract', `${A}:x:same`));
  for (const order of [[retract, publish], [publish, retract]]) {
    await writeFile(join(dir, 'outbox.json'), JSON.stringify(Object.fromEntries(order.map(entry => [entry.desired === 'retract' ? 'whatever' : 'also', entry]))));
    const read = await readOutbox(dir);
    assert.deepEqual(Object.keys(read).sort(), [entryKey('retract', `${A}:x:same`), retractKey(A, 'x', 'same')].sort());
    assert.equal(nextSeq(read), 3);
  }
  assert.equal(nextSeq({}), 1);
});

test('the sequence counter is kept at the top of the file, so it never goes back after entries are removed, and an old flat file starts it from its largest seq', async t => {
  const dir = await directory(t);
  const table = await readOutbox(dir);
  assert.equal(nextSeq(table), 1);
  const keep = queuePublish(undefined, { kind: 'x', id: 'a', body: {}, audience: ['public'] }, nextSeq(table));
  const gone = queueRetract(undefined, 'x', 'b', A, nextSeq(table));
  table[entryKey('x', 'a')] = keep;
  table[retractKey(A, 'x', 'b')] = gone;
  await writeOutbox(dir, table);
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'outbox.json'), 'utf8')).seq, 3);
  delete table[retractKey(A, 'x', 'b')];
  delete table[entryKey('x', 'a')];
  await writeOutbox(dir, table);
  const reloaded = await readOutbox(dir);
  assert.deepEqual(Object.keys(reloaded), []);
  assert.equal(nextSeq(reloaded), 4, 'removing every entry does not let the counter fall back');
  await writeFile(join(dir, 'outbox.json'), JSON.stringify({ [entryKey('x', 'a')]: { ...keep, seq: 9 } }));
  assert.equal(nextSeq(await readOutbox(dir)), 10);
});
