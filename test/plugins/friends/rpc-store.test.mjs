// 好友签名网关的本机状态（lib/rpc-store.mjs）：授权表、在途与去重表、发出表、操作记录与配额，落在插件状态目录的 rpc/ 下。
import assert from 'node:assert/strict';
import fsp, { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { requestDigest } from '../../../plugins/friends/lib/rpc-format.mjs';
import { ANSWER_KEEP_MS, BUSY_RETRY_MS, KEEP_AFTER_EXPIRY_MS, LEDGER_KEEP_MS, LIMITS, commandInfo, createRpcStore, inflightKey, isCorrupt } from '../../../plugins/friends/lib/rpc-store.mjs';

const author = n => `ed25519:${String(n).repeat(64).slice(0, 64)}`;
const A = author(1), B = author(2), C = author(3), D = author(4), E = author(5);
const GRANT = '3f2b8c1e-4d5a-4e6f-8a7b-9c0d1e2f3a4b';
const TARGET = { owner: 'machine-1', provider: 'remote-exec', kind: 'remote-exec/machine@1', id: 'rec-1' };
const START = Date.UTC(2026, 10, 24, 12, 0, 0);
// 提交前要读到这条授权：用到 markSubmitted 的用例先把它写进授权表。
const GRANTED = { id: GRANT, holder: { machine: A }, grantee: B, granteePerson: null, target: TARGET, createdAt: START };
const MINUTE = 60_000, DAY = 86_400_000;

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'friends-rpc-store-')), clock = { now: START }, ids = [];
  t.after(() => rm(dir, { recursive: true, force: true }));
  // 授权号固定是 GRANT；`ids` 记下生成过几次。
  const store = createRpcStore(dir, { now: () => clock.now, newId: () => { ids.push(GRANT); return GRANT; } });
  return { dir, rpc: join(dir, 'rpc'), clock, store, ids };
}
const hex = n => n.toString(16).padStart(32, '0');
let sequence = 0;
// 一个准入的候选：请求号各不相同，期限是 11 分钟后。
const candidate = (clock, more = {}) => {
  const n = ++sequence;
  return { caller: A, request: `c${hex(n)}`, grant: GRANT, digest: `d${hex(n)}`.padEnd(64, '0'), key: `friend:${hex(n)}`, notAfter: clock.now + 11 * MINUTE,
    call: { target: TARGET, input: { command: `echo ${n}` } }, ...more };
};
const readRaw = (dir, name) => readFile(join(dir, 'rpc', name), 'utf8');
const mode = async path => (await stat(path)).mode & 0o777;
// 调用方签出的请求正文：发出项的请求号、期限、作者、持有方、授权号、摘要都取自它。
const sentBody = (n, more = {}) => ({ v: 1, caller: A, holder: B, grant: GRANT, request: `c${hex(n)}`, op: 'exec', input: { command: 'ls' }, createdAt: START, expiresAt: START + MINUTE, ...more });
const finished = (more = {}) => ({ state: 'completed', finishedAt: START + 1, result: { exitCode: 0 }, ...more });

test('state files are written atomically with private permissions, and no temporary file is left', async t => {
  const { dir, rpc, store, clock } = await setup(t);
  await store.addGrant({ id: GRANT, holder: { machine: A }, grantee: B, granteePerson: null, target: TARGET, createdAt: START });
  await store.admit(candidate(clock));
  await store.addOutgoing({ call: 'call-1', key: 'friend:x', machine: 'm2', parent: null, body: sentBody(1) });
  await store.appendLedger({ request: 'c1', friend: B, grant: GRANT, target: { kind: TARGET.kind, id: TARGET.id, name: 'box' }, command: 'ls', outcome: 'completed', ms: 3 });
  assert.equal(await mode(rpc), 0o700);
  assert.deepEqual((await readdir(rpc)).sort(), ['grants.json', 'inflight.json', 'ledger-2026-11.jsonl', 'outgoing.json']);
  for (const name of await readdir(rpc)) assert.equal(await mode(join(rpc, name)), 0o600, name);
  assert.deepEqual(JSON.parse(await readRaw(dir, 'grants.json')), { v: 1, grants: { [GRANT]: { id: GRANT, holder: { machine: A }, grantee: B, granteePerson: null, target: TARGET, ops: ['exec'], createdAt: START } } });
  // 同时发起很多写：排成一条队，没有丢更新，文件始终是完整的 JSON。
  await Promise.all(Array.from({ length: 20 }, (_, i) => store.addOutgoing({ call: `call-${i}`, key: 'friend:x', machine: 'm2', body: sentBody(100 + i) })));
  assert.equal((await store.listOutgoing()).length, 21);
  assert.deepEqual((await readdir(rpc)).filter(name => name.endsWith('.tmp')), []);
  // 目录已存在但权限宽了：写之前收紧。
  await rm(rpc, { recursive: true });
  await mkdir(rpc, { mode: 0o755 });
  await store.addOutgoing({ call: 'call-x', key: 'friend:x', machine: 'm2', body: sentBody(999) });
  assert.equal(await mode(rpc), 0o700);
});

test('a missing file is an empty table; a file that is not JSON or not the right shape is a corruption error and is never overwritten', async t => {
  const { dir, rpc, store, clock } = await setup(t);
  assert.deepEqual(await store.listGrants(), []);
  assert.deepEqual(await store.listInflight(), []);
  assert.deepEqual(await store.listOutgoing(), []);
  assert.deepEqual(await store.readLedger(), []);
  await mkdir(rpc, { recursive: true });
  const goodGrant = { id: GRANT, holder: { machine: A }, grantee: B, granteePerson: null, target: TARGET, ops: ['exec'], createdAt: START };
  const names = ['grants.json', 'inflight.json', 'outgoing.json'];
  const reads = { 'grants.json': () => store.listGrants(), 'inflight.json': () => store.listInflight(), 'outgoing.json': () => store.listOutgoing() };
  const everything = () => [() => store.getGrant(GRANT), () => store.addGrant({ ...goodGrant, id: '11111111-1111-4111-8111-111111111111' }), () => store.revokeGrant(GRANT),
    () => store.admit(candidate(clock)), () => store.get(A, 'c1'), () => store.cancel(A, 'c1'), () => store.markSubmitted(A, 'c1'),
    () => store.finish(A, 'c1', finished()), () => store.markSigned(A, 'c1'), () => store.purge(), () => store.quota(A),
    () => store.addOutgoing({ call: 'x', key: 'k', machine: 'm', body: sentBody(1) }), () => store.setOutgoingState('c1', 'sent'), () => store.settleOutgoing('c1'),
    () => store.removeOutgoing('c1'),
    ...Object.values(reads)];
  const shapeBad = [['', '空文件'], ['{', '半截 JSON'], ['null', 'null'], ['[]', '数组'], ['{"v":1}', '缺表'], ['{"v":2,"grants":{},"entries":{}}', '版本不对'],
    ['{"v":1,"grants":[],"entries":[]}', '表是数组']];
  for (const [text, why] of shapeBad) {
    for (const name of names) await writeFile(join(rpc, name), text);
    for (const call of everything()) await assert.rejects(call(), error => isCorrupt(error) && error.code === 'corrupt', `${why}: ${call}`);
    for (const name of names) assert.equal(await readRaw(dir, name), text, `${why}: ${name} is left as it was`);
  }
  // 表里有一项形状不对、或键与项对不上：只有这张表坏，别的表照常。
  const badEntry = { 'grants.json': { ...goodGrant, ops: ['exec', 'pull'] }, 'inflight.json': { ...settled(1, START + MINUTE), state: 'weird' }, 'outgoing.json': { request: 'c1' } };
  const field = { 'grants.json': 'grants', 'inflight.json': 'entries', 'outgoing.json': 'entries' };
  for (const name of names) {
    for (const [key, entry] of [['c1', badEntry[name]], ['other', name === 'grants.json' ? goodGrant : name === 'inflight.json' ? settled(1, START + MINUTE) : { request: 'c1', call: 'x', key: 'k', machine: 'm', parent: null, expiresAt: 1, state: 'sent' }]]) {
      for (const other of names) await writeFile(join(rpc, other), '{"v":1,"grants":{},"entries":{}}');
      const text = JSON.stringify({ v: 1, [field[name]]: { [key]: entry } });
      await writeFile(join(rpc, name), text);
      await assert.rejects(reads[name](), isCorrupt, `${name} ${key}`);
      assert.equal(await readRaw(dir, name), text);
      for (const fine of names.filter(other => other !== name)) assert.deepEqual(await reads[fine](), []);
    }
  }
  // 其中一个文件坏了不连累别的表。
  await writeFile(join(rpc, 'grants.json'), '{');
  await writeFile(join(rpc, 'inflight.json'), JSON.stringify({ v: 1, entries: {} }));
  assert.deepEqual(await store.listInflight(), []);
  assert.equal((await store.admit(candidate(clock))).ok, true);
});

test('an inflight entry that reads back with a wrong shape is corruption too', async t => {
  const { dir, rpc, store, clock } = await setup(t);
  const { entry } = await store.admit(candidate(clock));
  const key = inflightKey(entry.caller, entry.request), file = JSON.parse(await readRaw(dir, 'inflight.json'));
  for (const broken of [{ ...entry, state: 'weird' }, { ...entry, notAfter: 'soon' }, { ...entry, caller: 'someone' }, { ...entry, canceled: false },
    { ...entry, state: 'completed' }, { ...entry, call: { target: { owner: 'x' }, input: {} } }]) {
    await writeFile(join(rpc, 'inflight.json'), JSON.stringify({ v: 1, entries: { [key]: broken } }));
    await assert.rejects(store.listInflight(), isCorrupt, JSON.stringify(broken));
  }
  await writeFile(join(rpc, 'inflight.json'), JSON.stringify(file));
  assert.equal((await store.listInflight()).length, 1);
});

test('grants: added once, revoked to disk first, and a revoked grant stays in the table with the first revocation time', async t => {
  const { dir, store, ids } = await setup(t);
  const grant = { holder: { machine: A }, grantee: B, granteePerson: null, target: TARGET, createdAt: START + 1 };
  const added = await store.addGrant(grant);
  assert.deepEqual([added.created, added.entry.id, added.entry.ops[0], ids.length], [true, GRANT, 'exec', 1]);
  // 同一机器钥匙、同一好友、同一目标再授一次：原样给回已有的那一条，不生成授权号、不写盘。
  const written = await readRaw(dir, 'grants.json');
  assert.deepEqual(await store.addGrant({ ...grant, createdAt: START + 2 }), { created: false, entry: added.entry });
  assert.equal(ids.length, 1, 'no new grant id');
  assert.equal(await readRaw(dir, 'grants.json'), written, 'nothing written');
  await assert.rejects(store.addGrant({ ...grant, target: { owner: 'a' } }), { code: 'invalid_input' });
  assert.equal((await store.getGrant(GRANT)).revokedAt, undefined);
  assert.equal(await store.revokeGrant('nope', START), null);
  const revoked = await store.revokeGrant(GRANT, START + 5);
  assert.equal(revoked.revokedAt, START + 5);
  // 返回之前已经在盘上。
  assert.equal(JSON.parse(await readRaw(dir, 'grants.json')).grants[GRANT].revokedAt, START + 5);
  assert.equal((await store.revokeGrant(GRANT, START + 99)).revokedAt, START + 5);
  assert.deepEqual((await store.listGrants()).map(one => one.id), [GRANT]);
  // 重新打开 store（重启）也读得到。
  assert.equal((await createRpcStore(dir).getGrant(GRANT)).revokedAt, START + 5);
});

test('a new grant id that already exists is refused before writing: grant, revoke, grant again with a fixed id leaves the revoked row as it was', async t => {
  const { dir, store, ids } = await setup(t);
  const grant = { holder: { machine: A }, grantee: B, granteePerson: null, target: TARGET, createdAt: START };
  assert.equal((await store.addGrant(grant)).entry.id, GRANT);
  await store.revokeGrant(GRANT, START + 1);
  const before = await readRaw(dir, 'grants.json');
  // 撤了的不算匹配的有效授权，于是再生成一次授权号；生成器给的还是 GRANT。
  await assert.rejects(store.addGrant({ ...grant, createdAt: START + 2 }), { code: 'invalid_input' });
  assert.equal(ids.length, 2);
  assert.equal(await readRaw(dir, 'grants.json'), before, 'the revoked row is not overwritten');
  assert.equal((await store.getGrant(GRANT)).revokedAt, START + 1, 'the revoked grant does not come back');
});

test('a grant row records the holder\'s machine key, and whether the grantee was a person (null while the host does not say)', async t => {
  const { store } = await setup(t);
  const grant = { ...GRANTED, holder: { machine: A }, granteePerson: true };
  for (const [what, bad] of [['旧的作者', { holder: { author: A } }], ['机器钥匙写成机器 ID', { holder: { machine: 'm1' } }], ['缺 holder', { holder: undefined }],
    ['缺 granteePerson', { granteePerson: undefined }], ['granteePerson 不是布尔', { granteePerson: 1 }]])
    await assert.rejects(store.addGrant({ ...grant, ...bad }), { code: 'invalid_input' }, what);
  assert.deepEqual(await store.listGrants(), []);
  const { entry: added } = await store.addGrant(grant);
  assert.deepEqual([added.holder, added.granteePerson], [{ machine: A }, true]);
});

test('an inflight entry only moves forward: admitted, submitted, then a terminal state that is written once and never undone', async t => {
  const { dir, store, clock } = await setup(t);
  await store.addGrant(GRANTED);
  const one = candidate(clock), { entry } = await store.admit(one);
  assert.deepEqual([entry.state, entry.admittedAt, entry.call.input.command], ['admitted', START, one.call.input.command]);
  const sub = await store.markSubmitted(A, one.request);
  assert.deepEqual([sub.ok, sub.entry.state], [true, 'submitted']);
  assert.equal((await store.markSubmitted(A, one.request)).ok, true, 'submitting again keeps it submitted');
  assert.equal((await store.get(A, one.request)).state, 'submitted');

  const done = await store.finish(A, one.request, finished());
  assert.deepEqual([done.ok, done.entry.state, done.entry.outcome, 'call' in done.entry], [true, 'completed', { finishedAt: START + 1, result: { exitCode: 0 } }, false]);
  // 终态已在盘上，再怎么调也退不回去、结局也改不了。
  assert.equal(JSON.parse(await readRaw(dir, 'inflight.json')).entries[inflightKey(A, one.request)].state, 'completed');
  assert.equal((await store.markSubmitted(A, one.request)).code, 'terminal');
  assert.equal((await store.finish(A, one.request, { state: 'failed', finishedAt: START + 9, error: { code: 'x', message: 'm', effects: 'none' } })).code, 'terminal');
  const after = await store.get(A, one.request);
  assert.deepEqual([after.state, after.outcome.result], ['completed', { exitCode: 0 }]);
  // 没有 admitted 就直接终态也行（没启动的取消）。
  const second = candidate(clock);
  await store.admit(second);
  assert.equal((await store.finish(A, second.request, { state: 'canceled', finishedAt: START + 2 })).entry.state, 'canceled');
  await assert.rejects(store.finish(A, second.request, { state: 'running', finishedAt: 1 }), { code: 'invalid_input' });
  assert.deepEqual(await store.finish(A, 'cnope', finished()), { ok: false, code: 'unknown' });
  // 终态不带 finishedAt 会写出读不回来的文件：拒绝。
  const third = candidate(clock);
  await store.admit(third);
  await assert.rejects(store.finish(A, third.request, { state: 'completed' }), { code: 'invalid_input' });
  assert.equal((await store.get(A, third.request)).state, 'admitted');
  assert.deepEqual(await store.markSubmitted(A, 'cnope'), { ok: false, code: 'unknown' });
});

test('a signed outcome is released from the table; only an entry in a terminal state can be marked signed', async t => {
  const { dir, store, clock } = await setup(t);
  const one = candidate(clock);
  await store.admit(one);
  assert.equal((await store.markSigned(A, one.request)).code, 'not_terminal');
  await store.finish(A, one.request, finished({ result: { stdout: 'x'.repeat(5000) } }));
  assert.ok((await readRaw(dir, 'inflight.json')).includes('xxxxx'));
  const signed = await store.markSigned(A, one.request);
  assert.deepEqual([signed.ok, signed.entry.signed, 'outcome' in signed.entry, signed.entry.state, signed.entry.digest], [true, true, false, 'completed', one.digest]);
  assert.equal((await readRaw(dir, 'inflight.json')).includes('xxxxx'), false);
  assert.equal((await store.markSigned(A, one.request)).entry.signed, true);
  assert.equal((await store.get(A, one.request)).signed, true);
});

test('a duplicate keeps the first entry, and the same request id with another digest is refused without touching the existing outcome', async t => {
  const { store, clock } = await setup(t);
  const one = candidate(clock);
  const first = await store.admit(one);
  assert.equal(first.ok, true);
  const again = await store.admit({ ...one, notAfter: one.notAfter + 1 });
  assert.deepEqual([again.ok, again.code, again.entry.notAfter], [false, 'duplicate', one.notAfter]);
  await store.finish(A, one.request, finished());
  const clash = await store.admit({ ...one, digest: 'f'.repeat(64) });
  assert.deepEqual([clash.ok, clash.code, clash.entry.digest, clash.entry.state], [false, 'digest_conflict', one.digest, 'completed']);
  assert.equal((await store.get(A, one.request)).outcome.result.exitCode, 0);
  // 两位作者用同一个请求号是两项。
  assert.equal((await store.admit({ ...one, caller: B })).ok, true);
  assert.equal((await store.listInflight()).length, 2);
});

test('a cancel that arrives before the request leaves a mark; the request is then a duplicate carrying it, and it cannot be submitted', async t => {
  const { store, clock } = await setup(t);
  await store.addGrant(GRANTED);
  const early = candidate(clock), marked = await store.admit({ ...early, canceled: true });
  assert.deepEqual([marked.ok, marked.entry.canceled, marked.entry.canceledAt], [true, true, START]);
  const arrival = await store.admit(early);
  assert.deepEqual([arrival.code, arrival.entry.canceled], ['duplicate', true]);
  assert.equal((await store.markSubmitted(A, early.request)).code, 'canceled');
  assert.equal((await store.get(A, early.request)).state, 'admitted');
  // 已有的一项后来才取消：留标记，之后不再启动；终态的取消不改它。
  const late = candidate(clock);
  await store.admit(late);
  clock.now += 5;
  assert.deepEqual((await store.cancel(A, late.request)).entry.canceledAt, START + 5);
  clock.now += 5;
  assert.equal((await store.cancel(A, late.request)).entry.canceledAt, START + 5, 'marked once');
  assert.equal((await store.markSubmitted(A, late.request)).code, 'canceled');
  assert.equal((await store.finish(A, late.request, { state: 'canceled', finishedAt: clock.now })).entry.state, 'canceled');
  assert.equal((await store.cancel(A, late.request)).code, 'terminal');
  assert.equal((await store.cancel(A, 'cnope')).code, 'unknown');
  // 已经提交的也能标记（持有方据此去中止那次调用）。
  const running = candidate(clock);
  await store.admit(running);
  await store.markSubmitted(A, running.request);
  assert.equal((await store.cancel(A, running.request)).entry.canceled, true);
  assert.equal((await store.get(A, running.request)).state, 'submitted');
});

const seed = async (dir, entries) => {
  await mkdir(join(dir, 'rpc'), { recursive: true });
  await writeFile(join(dir, 'rpc', 'inflight.json'), JSON.stringify({ v: 1, entries: Object.fromEntries(entries.map(entry => [inflightKey(entry.caller, entry.request), entry])) }));
};
const settled = (n, notAfter, more = {}) => ({ caller: B, request: `c${hex(n)}`, grant: GRANT, digest: `d${hex(n)}`.padEnd(64, '0'), key: `friend:${hex(n)}`, notAfter, admittedAt: START - DAY,
  state: 'completed', signed: true, retracted: true, ...more });

test('a full table refuses new requests and evicts nothing unexpired; expired entries stay 24 hours after expiry while the table has room', async t => {
  const { dir, store, clock } = await setup(t);
  const future = Array.from({ length: LIMITS.table }, (_, i) => settled(i, START + 5 * MINUTE + i));
  await seed(dir, future);
  const before = await readRaw(dir, 'inflight.json');
  const refused = await store.admit(candidate(clock));
  assert.deepEqual([refused.ok, refused.code], [false, 'table_full']);
  assert.equal(await readRaw(dir, 'inflight.json'), before, 'nothing was evicted or rewritten');
  // 同号重发在表满时仍认得出是同号，不是「表满」。
  assert.equal((await store.admit({ caller: B, request: future[0].request, grant: GRANT, digest: future[0].digest, key: 'k', notAfter: future[0].notAfter, call: { target: TARGET, input: { command: 'x' } } })).code, 'duplicate');

  // 表里还有空位：刚过期的（24 小时内）留着；过期超过 24 小时的这次清掉。
  const expired = (n, ago) => settled(n, START - ago);
  await seed(dir, [...future.slice(10), expired(5000, 1), expired(5001, KEEP_AFTER_EXPIRY_MS - 1), expired(5002, KEEP_AFTER_EXPIRY_MS), expired(5003, KEEP_AFTER_EXPIRY_MS + DAY)]);
  const admitted = await store.admit(candidate(clock));
  assert.equal(admitted.ok, true);
  const kept = (await store.listInflight()).map(entry => entry.request);
  assert.ok(kept.includes(`c${hex(5000)}`) && kept.includes(`c${hex(5001)}`), 'expired within 24 hours stays');
  assert.ok(!kept.includes(`c${hex(5002)}`) && !kept.includes(`c${hex(5003)}`), 'expired for 24 hours is cleared');
  assert.equal(kept.length, LIMITS.table - 10 + 2 + 1, '4086 unexpired + 2 recently expired + the new one');
  // 单独清：时间过去后做完了的一次清完；刚准入、还没做完的那一项留着等恢复。
  clock.now += 2 * DAY;
  assert.equal(await store.purge(), LIMITS.table - 10 + 2);
  assert.deepEqual((await store.listInflight()).map(entry => entry.state), ['admitted']);
});

// 过期了、不再承担去重，但还要交付的项：没签出结局、记账没写完、回答还在撤回期内、回答到了撤回时刻还没撤成、没做完。
const LEDGER_ROW = { v: 1, at: START - DAY, request: 'r', friend: B, grant: GRANT, target: { kind: TARGET.kind, id: TARGET.id, name: 'box' }, op: 'exec',
  command: { summary: 'ls', sha256: 'a'.repeat(64) }, outcome: 'completed', ms: 1 };
const duties = from => [
  settled(from, START - 1, { signed: undefined, retracted: undefined, outcome: { finishedAt: START - 1 } }),
  settled(from + 1, START - 1, { retracted: undefined, ledger: LEDGER_ROW }),
  settled(from + 2, START - 1, { retracted: undefined, finishedAt: START - 1 }),
  settled(from + 4, START - 1, { retracted: undefined, finishedAt: START + 1 - ANSWER_KEEP_MS }),
  settled(from + 5, START - 1, { retracted: undefined, finishedAt: START - 2 * ANSWER_KEEP_MS }),
  settled(from + 3, START - 1, { state: 'admitted', signed: undefined, retracted: undefined, call: { target: TARGET, input: { command: 'x' } } }),
];

test('a table full of rows that are safe to clear admits a new request, and only the clearable rows go', async t => {
  const { dir, store, clock } = await setup(t);
  const duty = duties(9000), count = LIMITS.table - duty.length;
  // 过期不到 24 小时、回答已撤回的项可清；加上那几项还承担交付的（含回答已过撤回时刻、还没撤成的）。
  const clearable = Array.from({ length: count }, (_, i) => settled(i, START - 1, { finishedAt: START - 2 * ANSWER_KEEP_MS }));
  await seed(dir, [...clearable, ...duty]);
  const admitted = await store.admit(candidate(clock));
  assert.equal(admitted.ok, true);
  assert.deepEqual((await store.listInflight()).map(entry => entry.request).sort(), [...duty.map(entry => entry.request), admitted.entry.request].sort());
});

test('a table full of rows that still carry dedup or delivery refuses the new request and loses no row', async t => {
  const { dir, store, clock } = await setup(t);
  // 全是过期的、但都还承担交付：按实际行数算，表是满的。
  const rows = Array.from({ length: Math.ceil(LIMITS.table / 6) }, (_, i) => duties(i * 6)).flat().slice(0, LIMITS.table);
  assert.equal(rows.length, LIMITS.table);
  await seed(dir, rows);
  const before = await readRaw(dir, 'inflight.json');
  assert.deepEqual([(await store.admit(candidate(clock))).ok, (await store.admit(candidate(clock))).code], [false, 'table_full']);
  assert.equal(await readRaw(dir, 'inflight.json'), before, 'not one row was dropped or rewritten');
});

test('a full table whose only clearable row is an answer due but not yet withdrawn refuses the new request and keeps that row; once it is withdrawn the next request gets in', async t => {
  const { dir, store, clock } = await setup(t);
  const due = settled(9000, START - 1, { retracted: undefined, finishedAt: START - ANSWER_KEEP_MS });
  await seed(dir, [...Array.from({ length: LIMITS.table - 1 }, (_, i) => settled(i, START + 5 * MINUTE)), due]);
  const before = await readRaw(dir, 'inflight.json');
  assert.deepEqual([(await store.admit(candidate(clock))).ok, (await store.admit(candidate(clock))).code], [false, 'table_full']);
  assert.equal(await readRaw(dir, 'inflight.json'), before, 'the row still to withdraw stays');
  await store.markRetracted(B, due.request);
  const admitted = await store.admit(candidate(clock));
  assert.equal(admitted.ok, true);
  assert.equal(await store.get(B, due.request), null, 'the withdrawn row made room');
});

test('the in-flight quota: 8 per author and 32 in all; a finished request frees its slot', async t => {
  const { store, clock } = await setup(t);
  const mine = [];
  for (let i = 0; i < LIMITS.inflight.author; i++) mine.push(candidate(clock, { caller: A }));
  for (const one of mine) assert.equal((await store.admit(one)).ok, true);
  const over = await store.admit(candidate(clock, { caller: A }));
  assert.deepEqual([over.ok, over.code, over.limit, over.scope, over.retryAfterMs], [false, 'busy', 'inflight', 'author', BUSY_RETRY_MS]);
  assert.equal((await store.admit(candidate(clock, { caller: B }))).ok, true, 'another author is not held back');
  await store.finish(A, mine[0].request, finished());
  assert.equal((await store.admit(candidate(clock, { caller: A }))).ok, true, 'a finished request frees its slot');
  // 全机 32：A 8、B 8、C 8、D 7，加上 E 一个正好 32，再来一个全机满。
  for (const caller of [B, C, D]) while ((await store.quota(caller)).inflight.author < (caller === D ? 7 : 8)) assert.equal((await store.admit(candidate(clock, { caller }))).ok, true);
  assert.equal((await store.quota(E)).inflight.total, 31);
  assert.equal((await store.admit(candidate(clock, { caller: E }))).ok, true);
  const full = await store.admit(candidate(clock, { caller: E }));
  assert.deepEqual([full.code, full.limit, full.scope], ['busy', 'inflight', 'total']);
  assert.deepEqual((await store.quota(E)).inflight, { author: 1, total: 32 });
  assert.equal((await store.quota(E)).verdict.code, 'busy');
});

test('the executing quota: 4 per author and 8 in all, judged when it is submitted', async t => {
  const { store, clock } = await setup(t);
  await store.addGrant(GRANTED);
  const admit = async caller => { const one = candidate(clock, { caller }); await store.admit(one); return one; };
  const own = [];
  for (let i = 0; i < LIMITS.executing.author; i++) { const one = await admit(A); own.push(one); assert.equal((await store.markSubmitted(A, one.request)).ok, true); }
  const fifth = await admit(A), blocked = await store.markSubmitted(A, fifth.request);
  assert.deepEqual([blocked.ok, blocked.code, blocked.limit, blocked.scope, blocked.retryAfterMs], [false, 'busy', 'executing', 'author', BUSY_RETRY_MS]);
  assert.equal((await store.get(A, fifth.request)).state, 'admitted', 'still waiting, not started');
  const other = await admit(B);
  assert.equal((await store.markSubmitted(B, other.request)).ok, true, 'another author still runs');
  // 一个跑完，名额就空出来。
  await store.finish(A, own[0].request, finished());
  assert.equal((await store.markSubmitted(A, fifth.request)).ok, true);
  // 全机 8：A 已 4（own[1..3] + fifth），B 已 1，C 再 3 个到 8，C 第 4 个、D 的第 1 个都被全机拦。
  for (let i = 0; i < 3; i++) { const one = await admit(C); assert.equal((await store.markSubmitted(C, one.request)).ok, true); }
  assert.equal((await store.quota(D)).executing.total, 8);
  const last = await admit(D), total = await store.markSubmitted(D, last.request);
  assert.deepEqual([total.code, total.limit, total.scope], ['busy', 'executing', 'total']);
  // 已经 submitted 的再提交（重启后用同一个幂等键）不受名额拦。
  assert.equal((await store.markSubmitted(A, fifth.request)).ok, true);
});

test('the per-minute quota: 30 per author and 120 in all in a sliding minute, with the time to wait', async t => {
  const { store, clock } = await setup(t);
  const send = async caller => {
    const one = candidate(clock, { caller }), result = await store.admit(one);
    if (result.ok) await store.finish(caller, one.request, finished());
    return result;
  };
  for (let i = 0; i < LIMITS.perMinute.author; i++) { assert.equal((await send(A)).ok, true); clock.now += 100; }
  const over = await send(A);
  assert.deepEqual([over.ok, over.code, over.limit, over.scope], [false, 'busy', 'perMinute', 'author']);
  // 最早那一条在 START 到的：60 秒后滑出窗口，此刻已过了 30 × 100 毫秒。
  assert.equal(over.retryAfterMs, MINUTE - 30 * 100);
  assert.equal((await send(B)).ok, true, 'another author has its own count');
  clock.now = START + MINUTE - 1;
  assert.equal((await send(A)).code, 'busy');
  clock.now = START + MINUTE;
  assert.equal((await send(A)).ok, true, 'the first request has slid out of the window');
  // 被拒的不计入窗口：反复敲也只是一直等到最早那条滑出。
  // 全机 120：四位作者各 30 个，第五位被全机拦。
  clock.now = START + 10 * MINUTE;
  for (const caller of [A, B, C, D]) for (let i = 0; i < 30; i++) assert.equal((await send(caller)).ok, true, `${caller} ${i}`);
  const total = await send(E);
  assert.deepEqual([total.code, total.limit, total.scope], ['busy', 'perMinute', 'total']);
  assert.equal(total.retryAfterMs, MINUTE);
  clock.now += MINUTE;
  assert.equal((await send(E)).ok, true);
  // 同号重发（去重）不占每分钟的名额。
  const one = candidate(clock, { caller: E });
  await store.admit(one);
  for (let i = 0; i < 50; i++) assert.equal((await store.admit(one)).code, 'duplicate');
  assert.equal((await send(E)).ok, true);
});

test('the outgoing table keeps the request body with the author, holder, grant and digest taken from it; its state and settlement change; a bad entry is refused', async t => {
  const { store } = await setup(t);
  const body = sentBody(1), entry = { call: 'call-1', key: 'friend:aaaa:grant', machine: 'm2', parent: 'parent-1', body };
  const kept = { request: body.request, call: 'call-1', key: 'friend:aaaa:grant', machine: 'm2', parent: 'parent-1', expiresAt: body.expiresAt,
    author: A, holder: B, grant: GRANT, digest: requestDigest(body), body, state: 'sent' };
  assert.deepEqual(await store.addOutgoing(entry), kept);
  assert.equal((await store.addOutgoing({ ...entry, body: sentBody(2), parent: undefined })).parent, null);
  assert.deepEqual(await store.getOutgoing(body.request), kept);
  assert.equal((await store.setOutgoingState(body.request, 'cancel_pending')).state, 'cancel_pending');
  assert.equal((await store.setOutgoingState(body.request, 'finished')).state, 'finished');
  assert.equal(await store.setOutgoingState('cnope', 'finished'), null);
  await assert.rejects(store.setOutgoingState(body.request, 'lost'), { code: 'invalid_input' });
  assert.deepEqual(await store.settleOutgoing(body.request), { ...kept, state: 'finished', settled: true });
  assert.equal(await store.settleOutgoing('cnope'), null);
  await assert.rejects(store.addOutgoing({ ...entry, body: sentBody(3, { expiresAt: 'soon' }) }), { code: 'invalid_input' });
  await assert.rejects(store.addOutgoing({ ...entry, body: sentBody(3, { caller: 'someone' }) }), { code: 'invalid_input' });
  await assert.rejects(store.addOutgoing({ ...entry, body: undefined }), { code: 'invalid_input' });
  assert.equal(await store.removeOutgoing(body.request), true);
  assert.equal(await store.removeOutgoing(body.request), false);
  assert.deepEqual((await store.listOutgoing()).map(one => one.request), [`c${hex(2)}`]);
});

const READ = { v: 1 };
const row = (more = {}) => ({ request: 'c1', friend: B, grant: GRANT, target: { kind: TARGET.kind, id: TARGET.id, name: 'box' }, command: 'ls -l', outcome: 'completed', exitCode: 0, ms: 12, ...more });

test('the ledger keeps a summary and a hash of the command, never the command, the cwd or the stdin', async t => {
  const { dir, store } = await setup(t);
  const command = `echo ${'x'.repeat(200)} secret-token`;
  const written = await store.appendLedger({ ...row({ command }), cwd: '/home/secret', stdin: 'password', env: { A: 1 } });
  assert.deepEqual(written, { ...READ, at: START, request: 'c1', friend: B, grant: GRANT, target: { kind: TARGET.kind, id: TARGET.id, name: 'box' }, op: 'exec',
    command: commandInfo(command), outcome: 'completed', exitCode: 0, ms: 12 });
  assert.equal(written.command.summary, command.slice(0, 80));
  assert.equal([...written.command.summary].length, 80);
  const text = await readRaw(dir, 'ledger-2026-11.jsonl');
  for (const leak of ['secret-token', '/home/secret', 'password']) assert.equal(text.includes(leak), false, leak);
  assert.deepEqual(JSON.parse(text), written);
  // 摘要按字符（码点）算，不切坏多字节字符。
  assert.equal(commandInfo('😀'.repeat(100)).summary, '😀'.repeat(80));
  await assert.rejects(store.appendLedger(row({ command: { text: 'ls' } })), { code: 'invalid_input' });
  const failed = await store.appendLedger(row({ outcome: 'failed', code: 'timeout', exitCode: undefined }));
  assert.deepEqual([failed.code, 'exitCode' in failed], ['timeout', false]);
});

test('rejections merge by author, reason and minute into one counted line instead of one line per bad input', async t => {
  const { dir, store, clock } = await setup(t);
  const bad = (friend, code) => store.recordRejection({ friend, code });
  for (let i = 0; i < 50; i++) await bad(B, 'bad_audience');
  assert.equal((await readRaw(dir, 'ledger-2026-11.jsonl')).trim().split('\n').length, 1);
  assert.deepEqual(JSON.parse(await readRaw(dir, 'ledger-2026-11.jsonl')), { v: 1, at: START, friend: B, outcome: 'rejected', code: 'bad_audience', count: 50 });
  // 另一个原因、另一位作者、下一分钟，各是新的一行；之前的行计数不变。
  await bad(B, 'bad_author');
  await bad(C, 'bad_audience');
  clock.now += MINUTE + 5_000;
  await bad(B, 'bad_audience');
  await bad(B, 'bad_audience');
  const lines = (await readRaw(dir, 'ledger-2026-11.jsonl')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(lines.map(line => [line.friend, line.code, line.at - START, line.count]),
    [[B, 'bad_audience', 0, 50], [B, 'bad_author', 0, 1], [C, 'bad_audience', 0, 1], [B, 'bad_audience', MINUTE, 2]]);
  // 同一分钟里夹着别的行，计数仍加在原来那一行上，别的行不动。
  await store.appendLedger(row({ request: 'c9', friend: D }));
  clock.now += 1_000;
  await bad(B, 'bad_audience');
  await bad(C, 'bad_audience');
  const merged = (await readRaw(dir, 'ledger-2026-11.jsonl')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(merged.map(line => [line.friend, line.code ?? line.outcome, line.at - START, line.count]),
    [[B, 'bad_audience', 0, 50], [B, 'bad_author', 0, 1], [C, 'bad_audience', 0, 1], [B, 'bad_audience', MINUTE, 3], [D, 'completed', MINUTE + 5_000, undefined], [C, 'bad_audience', MINUTE, 1]]);
});

test('the ledger splits by month, reads the latest rows first with filters, and drops months older than 90 days', async t => {
  const { rpc, store, clock } = await setup(t);
  clock.now = Date.UTC(2026, 7, 20);
  const at = (month, day) => Date.UTC(2026, month - 1, day, 12);
  await store.appendLedger(row({ at: at(7, 1), request: 'jul' }));
  await store.appendLedger(row({ at: at(8, 15), request: 'aug' }));
  await store.appendLedger(row({ at: at(11, 20), request: 'nov-1', friend: C }));
  await store.appendLedger(row({ at: at(11, 21), request: 'nov-2', outcome: 'failed', code: 'timeout' }));
  assert.deepEqual((await readdir(rpc)).filter(name => name.startsWith('ledger')).sort(), ['ledger-2026-07.jsonl', 'ledger-2026-08.jsonl', 'ledger-2026-11.jsonl']);
  assert.deepEqual((await store.readLedger()).map(one => one.request), ['nov-2', 'nov-1', 'aug', 'jul']);
  assert.deepEqual((await store.readLedger({ limit: 2 })).map(one => one.request), ['nov-2', 'nov-1']);
  assert.deepEqual((await store.readLedger({ limit: 3 })).map(one => one.request), ['nov-2', 'nov-1', 'aug'], 'a limit reaches back into the earlier month');
  assert.deepEqual((await store.readLedger({ friend: C })).map(one => one.request), ['nov-1']);
  assert.deepEqual((await store.readLedger({ outcome: 'failed' })).map(one => one.request), ['nov-2']);
  assert.deepEqual((await store.readLedger({ request: 'aug' })).map(one => one.request), ['aug']);
  // 记录里夹着读不出的坏行：报损坏，不跳过。
  await writeFile(join(rpc, 'ledger-2026-11.jsonl'), `garbage\n${JSON.stringify(row({ at: 1, request: 'ok' }))}\n{"half":`);
  await assert.rejects(store.readLedger(), isCorrupt);

  // 90 天：整月都早于 90 天前才删；2026-07 的最后一刻是 8 月 1 日 0 点，2026-08 的是 9 月 1 日 0 点。
  const aug1 = Date.UTC(2026, 7, 1), sep1 = Date.UTC(2026, 8, 1);
  clock.now = aug1 + LEDGER_KEEP_MS - 1;
  assert.deepEqual(await store.pruneLedger(), []);
  clock.now = aug1 + LEDGER_KEEP_MS;
  assert.deepEqual(await store.pruneLedger(), ['ledger-2026-07.jsonl']);
  clock.now = sep1 + LEDGER_KEEP_MS - 1;
  assert.deepEqual(await store.pruneLedger(), []);
  clock.now = sep1 + LEDGER_KEEP_MS;
  assert.deepEqual(await store.pruneLedger(), ['ledger-2026-08.jsonl']);
  assert.deepEqual((await readdir(rpc)).filter(name => name.startsWith('ledger')), ['ledger-2026-11.jsonl']);
  assert.equal(await mode(join(rpc, 'ledger-2026-11.jsonl')), 0o600);
});

test('appending to the ledger clears the months that are too old, once a day', async t => {
  const { rpc, store, clock } = await setup(t);
  await mkdir(rpc, { recursive: true });
  for (const month of ['01', '07', '09']) await writeFile(join(rpc, `ledger-2026-${month}.jsonl`), '{}\n');
  await writeFile(join(rpc, 'notes.txt'), 'not a ledger');
  // 今天第一次追加就清：1 月、7 月整月都早于 90 天前，9 月还有可能在期内。
  await store.appendLedger(row({ request: 'now' }));
  assert.deepEqual((await readdir(rpc)).filter(name => name.startsWith('ledger')).sort(), ['ledger-2026-09.jsonl', 'ledger-2026-11.jsonl']);
  assert.ok((await readdir(rpc)).includes('notes.txt'), 'only ledger files are touched');
  // 同一天后来放进去的，今天不再清；过了一天再追加才清。
  await writeFile(join(rpc, 'ledger-2026-02.jsonl'), '{}\n');
  await store.appendLedger(row({ request: 'again' }));
  assert.ok((await readdir(rpc)).includes('ledger-2026-02.jsonl'));
  clock.now += DAY;
  await store.appendLedger(row({ request: 'tomorrow' }));
  assert.equal((await readdir(rpc)).includes('ledger-2026-02.jsonl'), false);
});

// ---- 评审后的补充 ----

// 让落盘的最后一步（改名换上）失败：写到一半失败，换上之前的那份必须完整可读。
function failRename(t, match) {
  const real = fsp.rename, patch = mock.method(fsp, 'rename', async (from, to) => {
    if (match(String(to))) throw Object.assign(new Error('磁盘满了'), { code: 'ENOSPC' });
    return real(from, to);
  });
  syncBuiltinESMExports();
  const restore = () => { patch.mock.restore(); syncBuiltinESMExports(); };
  t.after(restore);
  return restore;
}
const noTemporary = async rpc => assert.deepEqual((await readdir(rpc)).filter(name => name.endsWith('.tmp')), []);
// 一行存下来的正常行，写进月份文件的测试数据用。
const stored = (more = {}) => ({ v: 1, at: START, request: 'c1', friend: B, grant: GRANT, target: { kind: TARGET.kind, id: TARGET.id, name: 'box' }, op: 'exec',
  command: commandInfo('ls'), outcome: 'completed', ms: 1, ...more });
const rejected = (more = {}) => ({ v: 1, at: START, friend: B, outcome: 'rejected', code: 'bad_audience', count: 1, ...more });
const lines = rows => `${rows.map(one => (typeof one === 'string' ? one : JSON.stringify(one))).join('\n')}\n`;

test('an inflight entry is checked by its state: a waiting one carries its whole sub-call, only a finished one carries an outcome or a signed mark, and the cancel mark comes with its time', async t => {
  const { rpc, store, clock } = await setup(t);
  const { entry } = await store.admit(candidate(clock));
  const key = inflightKey(entry.caller, entry.request), outcome = { finishedAt: START + 1 };
  const { call, ...bare } = entry;
  const bad = [
    ['waiting without its sub-call', bare], ['submitted without its sub-call', { ...bare, state: 'submitted' }],
    ['a sub-call with no input', { ...entry, call: { target: TARGET } }], ['a sub-call with no target', { ...entry, call: { input: {} } }],
    ['no idempotency key', { ...entry, key: undefined }], ['no latest start time', { ...entry, notAfter: undefined }],
    ['waiting with an outcome', { ...entry, outcome }], ['submitted with an outcome', { ...entry, state: 'submitted', outcome }],
    ['waiting with a signed mark', { ...entry, signed: true }], ['finished with neither', { ...bare, state: 'failed' }],
    ['finished with both', { ...bare, state: 'completed', outcome, signed: true }], ['an outcome without its time', { ...bare, state: 'completed', outcome: {} }],
    ['cancel mark without its time', { ...entry, canceled: true }], ['cancel time without its mark', { ...entry, canceledAt: START }],
  ];
  const good = [['canceled and timed', { ...entry, canceled: true, canceledAt: START }], ['finished with an outcome', { ...bare, state: 'completed', outcome }],
    ['finished and signed', { ...bare, state: 'canceled', signed: true, canceled: true, canceledAt: START }]];
  for (const [why, one] of bad) {
    await writeFile(join(rpc, 'inflight.json'), JSON.stringify({ v: 1, entries: { [key]: one } }));
    await assert.rejects(store.listInflight(), isCorrupt, why);
    await assert.rejects(store.admit(candidate(clock)), isCorrupt, why);
  }
  for (const [why, one] of good) {
    await writeFile(join(rpc, 'inflight.json'), JSON.stringify({ v: 1, entries: { [key]: one } }));
    assert.equal((await store.listInflight()).length, 1, why);
  }
});

test('every write of the inflight table is checked too: an entry that would read back as corrupt is refused and nothing is written', async t => {
  const { dir, rpc, store, clock } = await setup(t);
  const base = candidate(clock);
  for (const [why, more] of [['no sub-call', { call: undefined }], ['no input', { call: { target: TARGET } }], ['no idempotency key', { key: undefined }],
    ['a latest start time that is not a time', { notAfter: 'soon' }], ['an author that is not a key', { caller: 'someone' }]])
    await assert.rejects(store.admit({ ...base, ...more }), { code: 'invalid_input' }, why);
  await assert.rejects(readFile(join(rpc, 'inflight.json')), { code: 'ENOENT' });
  // 改一项的路径也过同一道检查：落终态不带时刻会写出读不回来的文件，被拒，原样留着。
  const one = candidate(clock);
  await store.admit(one);
  const before = await readRaw(dir, 'inflight.json');
  await assert.rejects(store.finish(A, one.request, { state: 'completed' }), { code: 'invalid_input' });
  assert.equal(await readRaw(dir, 'inflight.json'), before);
});

test('a request whose write failed does not count against the per-minute quota', async t => {
  const { rpc, store, clock } = await setup(t);
  const restore = failRename(t, to => to.endsWith('inflight.json'));
  for (let i = 0; i < LIMITS.perMinute.author + 10; i++) await assert.rejects(store.admit(candidate(clock)), { code: 'ENOSPC' });
  await assert.rejects(readFile(join(rpc, 'inflight.json')), { code: 'ENOENT' });
  await noTemporary(rpc);
  restore();
  for (let i = 0; i < LIMITS.perMinute.author; i++) {
    const one = candidate(clock), result = await store.admit(one);
    assert.equal(result.ok, true, `request ${i}`);
    await store.finish(A, one.request, finished());
  }
  const over = await store.admit(candidate(clock));
  assert.deepEqual([over.code, over.limit], ['busy', 'perMinute']);
  // 窗口按已落盘的准入时刻算：重新打开 store（重启）也一样。
  assert.equal((await createRpcStore(join(rpc, '..'), { now: () => clock.now }).admit(candidate(clock))).code, 'busy');
});

test('a state table that fails to write leaves the file as it was and no temporary file behind', async t => {
  const { dir, rpc, store, clock } = await setup(t);
  await store.admit(candidate(clock));
  const before = await readRaw(dir, 'inflight.json');
  failRename(t, to => to.endsWith('.json'));
  await assert.rejects(store.admit(candidate(clock)), { code: 'ENOSPC' });
  await assert.rejects(store.addGrant({ id: GRANT, holder: { machine: A }, grantee: B, granteePerson: null, target: TARGET, createdAt: START }), { code: 'ENOSPC' });
  assert.equal(await readRaw(dir, 'inflight.json'), before);
  await noTemporary(rpc);
  assert.equal((await store.listInflight()).length, 1);
});

test('appending to the ledger and merging a rejection go through the same atomic write: a failure leaves the earlier month file whole and readable', async t => {
  const { dir, rpc, store } = await setup(t);
  await store.appendLedger(row({ request: 'first' }));
  await store.recordRejection({ friend: B, code: 'bad_audience' });
  const before = await readRaw(dir, 'ledger-2026-11.jsonl');
  const restore = failRename(t, to => to.endsWith('.jsonl'));
  await assert.rejects(store.appendLedger(row({ request: 'second' })), { code: 'ENOSPC' });
  await assert.rejects(store.recordRejection({ friend: B, code: 'bad_audience' }), { code: 'ENOSPC' });
  await assert.rejects(store.recordRejection({ friend: C, code: 'bad_author' }), { code: 'ENOSPC' });
  assert.equal(await readRaw(dir, 'ledger-2026-11.jsonl'), before);
  await noTemporary(rpc);
  assert.deepEqual((await store.readLedger()).map(one => one.request ?? one.code), ['bad_audience', 'first']);
  restore();
  await store.appendLedger(row({ request: 'second' }));
  assert.deepEqual((await store.readLedger()).map(one => one.request ?? `${one.code}×${one.count}`), ['second', 'bad_audience×1', 'first']);
  assert.equal(await mode(join(rpc, 'ledger-2026-11.jsonl')), 0o600);
  await noTemporary(rpc);
});

test('a ledger month file with a line that is not JSON or not a valid row is corruption: read, append and merge all refuse it and leave it as it was', async t => {
  const { rpc, store } = await setup(t);
  await mkdir(rpc, { recursive: true });
  const file = join(rpc, 'ledger-2026-11.jsonl'), good = stored();
  const broken = [
    ['not JSON', lines([good, 'garbage'])], ['half a line at the end', `${lines([good])}{"half":`], ['a blank line', `${JSON.stringify(good)}\n\n${JSON.stringify(good)}\n`],
    ['not an object', lines([good, '[]'])], ['an extra field (cwd)', lines([{ ...good, cwd: '/home/secret' }])], ['an extra field (stdin)', lines([{ ...good, stdin: 'x' }])],
    ['the whole command', lines([{ ...good, command: { ...good.command, command: 'ls' } }])], ['a summary over 80 characters', lines([{ ...good, command: { ...good.command, summary: 'x'.repeat(81) } }])],
    ['a bad hash', lines([{ ...good, command: { ...good.command, sha256: 'abc' } }])], ['no request', lines([{ ...good, request: undefined }])],
    ['a friend that is not a key', lines([{ ...good, friend: 'someone' }])], ['no target name', lines([{ ...good, target: { kind: 'k', id: 'i' } }])],
    ['a negative ms', lines([{ ...good, ms: -1 }])], ['the wrong version', lines([{ ...good, v: 2 }])], ['an op that is not exec', lines([{ ...good, op: 'pull' }])],
    ['a rejection with count 0', lines([rejected({ count: 0 })])], ['a rejection with a request', lines([rejected({ request: 'c1' })])],
    ['a rejection with no code', lines([rejected({ code: undefined })])], ['a rejection from nobody', lines([rejected({ friend: 'someone' })])],
  ];
  for (const [why, text] of broken) {
    await writeFile(file, text);
    await assert.rejects(store.readLedger(), isCorrupt, why);
    await assert.rejects(store.appendLedger(row({ request: 'new' })), isCorrupt, why);
    await assert.rejects(store.recordRejection({ friend: B, code: 'bad_audience' }), isCorrupt, why);
    assert.equal(await readFile(file, 'utf8'), text, `${why}: left as it was`);
  }
  // 好的月份文件：正常行、合并后的拒绝行都读得出；退出码为 null（被信号结束）也是合法的。
  await writeFile(file, lines([good, rejected({ count: 7 }), stored({ exitCode: null, code: 'timeout', outcome: 'failed' })]));
  assert.equal((await store.readLedger()).length, 3);
});

test('a ledger row that is not valid is refused before anything is written: the same check for ordinary rows and merged rejections', async t => {
  const { rpc, store } = await setup(t);
  const bad = [['rejected as an ordinary row', { outcome: 'rejected' }], ['a friend that is not a key', { friend: 'someone' }], ['no request', { request: undefined }],
    ['no outcome', { outcome: undefined }], ['a negative ms', { ms: -3 }], ['ms that is not a number', { ms: '3' }], ['no target', { target: undefined }],
    ['a target without a name', { target: { kind: 'k', id: 'i' } }], ['an exit code that is a string', { exitCode: '0' }], ['a code that is empty', { code: '' }],
    ['an op that is not exec', { op: 'pull' }], ['a time that is not one', { at: 'now' }]];
  for (const [why, more] of bad) await assert.rejects(store.appendLedger(row(more)), { code: 'invalid_input' }, why);
  for (const input of [{ friend: 'someone', code: 'x' }, { friend: B, code: '' }, { friend: B }, { code: 'x' }, { friend: B, code: 'x', at: 'now' }])
    await assert.rejects(store.recordRejection(input), { code: 'invalid_input' }, JSON.stringify(input));
  assert.deepEqual((await readdir(rpc).catch(() => [])).filter(name => name.startsWith('ledger')), []);
  // 只有规定的那些字段落盘：多传的 cwd、stdin 进不了文件（已有的测试覆盖了内容，这里看形状）。
  const written = await store.appendLedger({ ...row(), exitCode: null });
  assert.deepEqual(Object.keys(written).sort(), ['at', 'command', 'exitCode', 'friend', 'grant', 'ms', 'op', 'outcome', 'request', 'target', 'v']);
});

test('a rejection is merged into its line wherever it sits in the month file, however far back and whatever came after', async t => {
  const { rpc, store, clock } = await setup(t);
  await store.recordRejection({ friend: B, code: 'bad_audience' });
  await store.recordRejection({ friend: C, code: 'bad_audience' });
  // 后面又写了 64 KiB 以上的别的行：原来的拒绝行早已不在文件的最后一段里。
  const filler = Array.from({ length: 400 }, (_, i) => stored({ request: `c${i}`, at: START + i }));
  const file = join(rpc, 'ledger-2026-11.jsonl'), head = (await readFile(file, 'utf8')).trim().split('\n');
  await writeFile(file, lines([...head, ...filler]));
  assert.ok((await stat(file)).size > 64 * 1024 * 1.5);
  const before = (await readFile(file, 'utf8')).trim().split('\n');
  await store.recordRejection({ friend: B, code: 'bad_audience' });
  await store.recordRejection({ friend: C, code: 'bad_audience' });
  await store.recordRejection({ friend: C, code: 'bad_audience' });
  const after = (await readFile(file, 'utf8')).trim().split('\n');
  assert.equal(after.length, before.length, 'no second line for the same author, reason and minute');
  assert.deepEqual(after.slice(0, 2).map(line => JSON.parse(line).count), [2, 3]);
  assert.deepEqual(after.slice(2), before.slice(2), 'the other lines are untouched');
  // 另一分钟是新的一行，在末尾。
  clock.now += MINUTE;
  await store.recordRejection({ friend: B, code: 'bad_audience' });
  const last = JSON.parse((await readFile(file, 'utf8')).trim().split('\n').at(-1));
  assert.deepEqual([last.count, last.at], [1, START + MINUTE]);
});

test('rows older than 90 days are not listed even before any sweep, and a day with no new operation still sweeps them out', async t => {
  const { store } = await setup(t);
  // 同一天里先清扫过，之后写进来的旧行（补写）只靠读出时的过滤挡住。
  await store.appendLedger(row({ at: START - 91 * DAY, request: 'old' }));
  await store.appendLedger(row({ at: START - 89 * DAY, request: 'edge' }));
  await store.appendLedger(row({ at: START - 1, request: 'fresh' }));
  assert.deepEqual((await store.readLedger()).map(one => one.request), ['fresh', 'edge']);
  // 只写了一次账，之后没有任何新操作：走过 91 天，列出来是空的，旧行也从文件里清掉。
  const lone = await setup(t);
  await lone.store.appendLedger(row({ request: 'only' }));
  lone.clock.now += 91 * DAY;
  assert.deepEqual(await lone.store.readLedger(), []);
  assert.equal(await readFile(join(lone.rpc, 'ledger-2026-11.jsonl'), 'utf8'), '', 'the expired row is gone from the file, not only hidden');
});

test('a write with an explicit time past 90 days is not stored but counts as handled', async t => {
  const { rpc, store } = await setup(t);
  const old = START - 91 * DAY, ledgerFiles = async () => (await readdir(rpc).catch(() => [])).filter(name => name.startsWith('ledger'));
  const done = { v: 1, at: old, request: 'late', friend: B, grant: GRANT, target: { kind: TARGET.kind, id: TARGET.id, name: 'box' }, op: 'exec',
    command: { summary: 'ls', sha256: 'a'.repeat(64) }, outcome: 'completed', ms: 1 };
  assert.deepEqual(await store.appendLedgerRow(done), { written: false });
  await store.appendLedger(row({ at: old, request: 'late-2' }));
  await store.recordRejection({ friend: B, code: 'bad_audience', at: old });
  assert.deepEqual(await ledgerFiles(), [], 'nothing reached the disk');
  // 90 天以内的照常写。
  assert.deepEqual(await store.appendLedgerRow({ ...done, at: START - 89 * DAY }), { written: true });
  assert.equal((await ledgerFiles()).length, 1);
});

test('a write whose time passes the 90-day line while it is reading the month is not stored', async t => {
  const old = START - 90 * DAY + 1000;   // 开头查时还在 90 天以内
  const done = { v: 1, at: old, request: 'late', friend: B, grant: GRANT, target: { kind: TARGET.kind, id: TARGET.id, name: 'box' }, op: 'exec',
    command: { summary: 'ls', sha256: 'a'.repeat(64) }, outcome: 'completed', ms: 1 };
  const writes = {
    appendLedgerRow: store => store.appendLedgerRow(done),
    appendLedger: store => store.appendLedger(row({ at: old })),
    recordRejection: store => store.recordRejection({ friend: B, code: 'bad_audience', at: old }),
  };
  for (const [name, write] of Object.entries(writes)) {
    const { rpc, store, clock } = await setup(t);
    // 读目标月份的那一刻，时钟走过截止线。
    const real = fsp.readFile, patch = mock.method(fsp, 'readFile', async (path, ...rest) => {
      try { return await real(path, ...rest); } finally { if (String(path).includes('ledger-')) clock.now += 2000; }
    });
    syncBuiltinESMExports();
    try { await write(store); } finally { patch.mock.restore(); syncBuiltinESMExports(); }
    assert.ok(clock.now > START, `${name}: the clock moved while reading`);
    assert.deepEqual((await readdir(rpc)).filter(file => file.startsWith('ledger')), [], `${name}: the old row was not written`);
  }
});

test('a damaged month on the cutoff does not stop writes to other months; the sweep is reported and retried, and reading that month is still corrupt', async t => {
  const reported = [];
  const dir = await mkdtemp(join(tmpdir(), 'friends-rpc-store-')), clock = { now: START };
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createRpcStore(dir, { now: () => clock.now, onMaintenanceError: e => reported.push(e) }), rpc = join(dir, 'rpc');
  await mkdir(rpc, { recursive: true });
  // 截止日是 8 月 26 日，8 月文件就是边界月。
  const boundary = join(rpc, 'ledger-2026-08.jsonl');
  await writeFile(boundary, 'garbage\n');
  await store.appendLedger(row({ request: 'first' }));
  assert.deepEqual((await readdir(rpc)).sort(), ['ledger-2026-08.jsonl', 'ledger-2026-11.jsonl'], 'this month was written');
  assert.deepEqual(reported.map(e => [e.code, isCorrupt(e.cause)]), [['ledger_maintenance', true]]);
  // 失败不算清过：下一笔写入再试；读到那个月，照旧报损坏。
  await store.appendLedger(row({ request: 'second' }));
  assert.equal(reported.length, 2, 'retried');
  await assert.rejects(store.readLedger(), isCorrupt);
  assert.equal(reported.length, 3, 'reading also retries the sweep');
  // 文件修好以后，下一次清扫成功，过期的行去掉；之后同一天不再清。
  const augRow = (request, at) => JSON.stringify({ ...row({ request }), v: 1, at, op: 'exec', command: commandInfo('ls') });
  await writeFile(boundary, `${augRow('aug-old', Date.UTC(2026, 7, 10))}\n${augRow('aug-new', Date.UTC(2026, 7, 30))}\n`);
  await store.appendLedger(row({ request: 'third' }));
  assert.equal(reported.length, 3);
  assert.deepEqual((await readFile(boundary, 'utf8')).trim().split('\n').map(line => JSON.parse(line).request), ['aug-new']);
  await writeFile(boundary, 'garbage\n');
  await store.appendLedger(row({ request: 'fourth' }));
  assert.equal(reported.length, 3, 'the sweep succeeded today, so it is not run again');
});

test('the month holding the cutoff keeps only unexpired rows, and a month wholly past it is deleted', async t => {
  const { rpc, store, clock } = await setup(t);
  clock.now = Date.UTC(2026, 7, 22, 12);   // 先在 8 月 22 日把各行写进去
  const at = (month, day, hour = 12) => Date.UTC(2026, month - 1, day, hour);
  await store.appendLedger(row({ at: at(7, 30), request: 'jul' }));
  await store.appendLedger(row({ at: at(8, 10), request: 'aug-old' }));
  await store.appendLedger(row({ at: at(8, 22, 11), request: 'aug-just-old' }));
  await store.appendLedger(row({ at: at(8, 22, 12), request: 'aug-edge' }));
  await store.appendLedger(row({ at: at(8, 25), request: 'aug-new' }));
  await store.appendLedger(row({ at: at(9, 5), request: 'sep' }));
  clock.now = Date.UTC(2026, 10, 20, 12);   // 截止日是 8 月 22 日 12 点
  assert.deepEqual(await store.pruneLedger(), ['ledger-2026-07.jsonl']);
  const requests = name => readFile(join(rpc, name), 'utf8').then(text => text.trim().split('\n').map(line => JSON.parse(line).request));
  assert.deepEqual(await requests('ledger-2026-08.jsonl'), ['aug-edge', 'aug-new']);
  assert.deepEqual(await requests('ledger-2026-09.jsonl'), ['sep']);
  assert.deepEqual((await store.readLedger()).map(one => one.request), ['sep', 'aug-new', 'aug-edge']);
});

test('the latest rows are chosen by their time before the limit is applied, even when a month was written out of order', async t => {
  const { store } = await setup(t);
  const at = day => Date.UTC(2026, 10, day, 12);
  for (const [day, request] of [[20, 'r20'], [22, 'r22'], [21, 'r21'], [3, 'r03'], [22, 'r22b']]) await store.appendLedger(row({ at: at(day), request }));
  assert.deepEqual((await store.readLedger({ limit: 2 })).map(one => one.request), ['r22b', 'r22']);
  assert.deepEqual((await store.readLedger({ limit: 3 })).map(one => one.request), ['r22b', 'r22', 'r21']);
  assert.deepEqual((await store.readLedger({ limit: 4 })).map(one => one.request), ['r22b', 'r22', 'r21', 'r20']);
  assert.deepEqual((await store.readLedger()).map(one => one.request), ['r22b', 'r22', 'r21', 'r20', 'r03']);
  assert.deepEqual((await store.readLedger({ limit: 1, request: 'r03' })).map(one => one.request), ['r03']);
  // 一个月内的乱序也和上个月的拼起来：月份新的先，月内按时间。
  await store.appendLedger(row({ at: Date.UTC(2026, 9, 30, 12), request: 'oct' }));
  assert.deepEqual((await store.readLedger({ limit: 6 })).map(one => one.request), ['r22b', 'r22', 'r21', 'r20', 'r03', 'oct']);
});

test('the stored sub-call input must be exactly what the exec input rebuild gives: anything else is corruption on read and refused on write', async t => {
  const { rpc, store, clock } = await setup(t);
  const { entry } = await store.admit(candidate(clock));
  const key = inflightKey(entry.caller, entry.request);
  const inputs = [['an empty object', {}], ['no command', { cwd: '/tmp' }], ['an empty command', { command: '' }], ['a command that is not text', { command: 5 }],
    ['an extra field', { command: 'ls', env: { A: 'b' } }], ['a relative cwd', { command: 'ls', cwd: 'tmp' }], ['a timeout out of range', { command: 'ls', timeout: 601 }],
    ['a timeout that is a string', { command: 'ls', timeout: '5' }], ['stdin that is not text', { command: 'ls', stdin: 1 }], ['not an object', 'ls']];
  for (const [why, input] of inputs) {
    // 读盘：admitted、submitted 都按损坏处理。
    for (const state of ['admitted', 'submitted']) {
      await writeFile(join(rpc, 'inflight.json'), JSON.stringify({ v: 1, entries: { [key]: { ...entry, state, call: { target: TARGET, input } } } }));
      await assert.rejects(store.listInflight(), isCorrupt, `${why} (${state})`);
    }
    // 写入：准入时拒绝，什么也不写。
    await rm(join(rpc, 'inflight.json'));
    await assert.rejects(store.admit({ ...candidate(clock), call: { target: TARGET, input } }), { code: 'invalid_input' }, why);
    await assert.rejects(readFile(join(rpc, 'inflight.json')), { code: 'ENOENT' }, why);
  }
  // 重建后原样的输入（可选项齐全、键序不同）读得出。
  const full = { stdin: 'x', timeout: 600, cwd: '/tmp', command: 'ls' };
  await writeFile(join(rpc, 'inflight.json'), JSON.stringify({ v: 1, entries: { [key]: { ...entry, call: { target: TARGET, input: full } } } }));
  assert.deepEqual((await store.listInflight())[0].call.input, full);
});

test('the sha256 of a ledger command must be a string before it is matched: an array holding one valid digest is corruption', async t => {
  const { rpc, store } = await setup(t);
  await mkdir(rpc, { recursive: true });
  const file = join(rpc, 'ledger-2026-11.jsonl'), good = stored(), digest = good.command.sha256;
  for (const [why, sha256] of [['an array of one digest', [digest]], ['an object', { toString: () => digest }], ['a number', 5], ['null', null], ['upper case', digest.toUpperCase()]]) {
    const text = lines([{ ...good, command: { ...good.command, sha256 } }]);
    await writeFile(file, text);
    await assert.rejects(store.readLedger(), isCorrupt, why);
    await assert.rejects(store.appendLedger(row()), isCorrupt, why);
    assert.equal(await readFile(file, 'utf8'), text);
  }
  await writeFile(file, lines([good]));
  assert.equal((await store.readLedger()).length, 1);
});

test('a limited query of a month with hundreds of thousands of rows returns, picking the latest by time (no argument-count limit)', async t => {
  const { rpc, store } = await setup(t);
  await mkdir(rpc, { recursive: true });
  const total = 300_000, base = stored(), rows = [];
  for (let i = 0; i < total; i++) rows.push(JSON.stringify({ ...base, request: `c${i}`, at: START + ((i * 7919) % total) }));
  await writeFile(join(rpc, 'ledger-2026-11.jsonl'), `${rows.join('\n')}\n`);
  const latest = await store.readLedger({ limit: 3 });
  assert.deepEqual(latest.map(one => one.at - START), [total - 1, total - 2, total - 3]);
});

test('a ledger query returns every matching row up to a large limit and filters by request id', async t => {
  const { rpc, store } = await setup(t);
  await mkdir(rpc, { recursive: true });
  await writeFile(join(rpc, 'ledger-2026-11.jsonl'), lines(Array.from({ length: 50 }, (_, i) => stored({ request: `c${i}`, at: START + i, friend: i % 2 ? B : C }))));
  assert.equal((await store.readLedger({ limit: 1000 })).length, 50);
  assert.equal((await store.readLedger({ limit: 1000, friend: B })).length, 25);
  assert.deepEqual((await store.readLedger({ request: 'c12' })).map(one => one.request), ['c12']);
});

test('a refusal admitted is written as its terminal state at once, with no call to run; it is deduplicated and counted as any admission is', async t => {
  const { store, clock } = await setup(t);
  const row = { v: 1, at: START, request: 'c1', friend: A, grant: GRANT, target: { kind: TARGET.kind, id: TARGET.id, name: 'box' }, op: 'exec',
    command: commandInfo('echo 1'), outcome: 'failed', code: 'target_offline', ms: 0 };
  const refusal = { state: 'failed', ending: { finishedAt: START, error: { code: 'target_offline', message: '授权的目标机器此刻离线，命令没有启动', effects: 'none' } }, row };
  const one = candidate(clock);
  const admitted = await store.admit({ ...one, refusal });
  assert.equal(admitted.ok, true);
  const entry = await store.get(A, one.request);
  assert.deepEqual([entry.state, entry.call, entry.outcome, entry.ledger], ['failed', undefined, refusal.ending, row]);
  assert.equal((await store.markSubmitted(A, one.request)).code, 'terminal', 'never submitted');
  assert.equal((await store.admit({ ...one, refusal })).code, 'duplicate');
  // 每分钟的名额照算。
  for (let i = 1; i < LIMITS.perMinute.author; i++) assert.equal((await store.admit({ ...candidate(clock), refusal })).ok, true);
  assert.equal((await store.admit({ ...candidate(clock), refusal })).code, 'busy');
});
