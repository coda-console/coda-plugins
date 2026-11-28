// 好友页读的目录记录 friends/machine@1：从 Accord 记录取哪些字段、不带哪些，以及跟着变化写、没变不重写。
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { MACHINE_RECORD_KIND, RETRY_MS, createMachineRecord, machineRecord } from '../../../plugins/friends/lib/machine-record.mjs';

const ME = `ed25519:${'a'.repeat(64)}`, PAL = `ed25519:${'1'.repeat(64)}`, KEY = `ed25519:${'c'.repeat(64)}`;
const FRIEND = { node: 'link:1', mode: 'link', scope: 's', author: PAL, bound: true, machine: KEY, certified: true, createdAt: 1, updatedAt: 2, linkId: 'f-1', peerNode: 'pm', peerPort: 8443, conflict: false };
const accord = (over = {}) => ({ kind: 'coda/accord@1', id: 'local', local: true, spec: { author: ME },
  status: { friends: [FRIEND], certificate: { key: KEY, root: ME, active: true, from: 10, until: 20 }, networkRemovals: [{ node: '41', since: 5 }], ...over } });
const settled = () => new Promise(resolve => setImmediate(resolve));

test('the record carries the identity, the friend channels, the certificate state and the network removals the page reads', () => {
  assert.deepEqual(machineRecord(accord()), {
    spec: { author: ME },
    status: { friends: [FRIEND], certificate: { key: KEY, root: ME, active: true, from: 10, until: 20 }, networkRemovals: [{ node: '41', since: 5 }] },
  });
});

test('nothing the backend must not hand out gets in: no certificate signature, no auth key, no binding token, no private key, whatever else the entry carries', () => {
  const record = machineRecord({ ...accord({ certificate: { key: KEY, root: ME, active: false, sig: 'SIG', privateKey: 'PRIV' },
    friends: [{ ...FRIEND, authKey: 'tskey-secret', bindingToken: 'TOKEN', secret: 'x' }], networkRemovals: [{ node: '41', since: 5, authKey: 'tskey-secret' }], privateKey: 'PRIV' }),
    privateKey: 'PRIV', spec: { author: ME, privateKey: 'PRIV', authKey: 'tskey-secret' } });
  const text = JSON.stringify(record);
  for (const secret of ['SIG', 'PRIV', 'tskey-secret', 'TOKEN', '"secret"']) assert.ok(!text.includes(secret), secret);
  assert.deepEqual(record.status.certificate, { key: KEY, root: ME, active: false });
  assert.deepEqual(record.status.friends, [FRIEND]);
  assert.deepEqual(record.spec, { author: ME });
});

test('no identity: author null and certificate null stay as the backend says; a backend that does not write a certificate key gets none in the record either', () => {
  assert.deepEqual(machineRecord({ spec: {}, status: { friends: [], certificate: null, networkRemovals: [] } }), { spec: { author: null }, status: { friends: [], certificate: null, networkRemovals: [] } });
  assert.deepEqual(machineRecord({ spec: { author: ME }, status: { friends: [] } }), { spec: { author: ME }, status: { friends: [], networkRemovals: [] } });
});

test('it writes once at start and then only when the content changes, as key local of friends/machine@1', async () => {
  const puts = [], coda = { put: async (...args) => { puts.push(args); } };
  const writer = createMachineRecord(coda);
  writer.onAccord({ type: 'ADDED', id: 'local', entry: accord() });
  writer.onAccord({ type: 'MODIFIED', id: 'local', entry: accord() });
  await settled();
  assert.equal(puts.length, 1);
  assert.deepEqual(puts[0], [{ kind: MACHINE_RECORD_KIND, key: 'local' }, machineRecord(accord())]);
  writer.onAccord({ type: 'MODIFIED', entry: { ...accord(), local: false, extra: 1 } });
  await settled();
  assert.equal(puts.length, 1, 'fields the record does not carry changing is no change');
  writer.onAccord({ type: 'MODIFIED', entry: accord({ friends: [] }) });
  await settled();
  assert.equal(puts.length, 2);
  assert.deepEqual(puts[1][1].status.friends, []);
});

test('with no Accord entry nothing is written; a failed write is tried again on the next change; after stop nothing is written', async () => {
  mock.method(console, 'warn', () => {});
  let fail = true;
  const puts = [], coda = { put: async (...args) => { if (fail) throw new Error('目录库忙'); puts.push(args); } };
  const writer = createMachineRecord(coda);
  writer.onAccord({ type: 'DELETED', entry: accord() });
  writer.onAccord({ type: 'ADDED' });
  writer.onAccord();
  await settled();
  assert.equal(puts.length, 0);
  writer.onAccord({ type: 'ADDED', entry: accord() });
  await settled();
  assert.equal(puts.length, 0, 'the failure is swallowed');
  fail = false;
  writer.onAccord({ type: 'MODIFIED', entry: accord() });
  await settled();
  assert.equal(puts.length, 1, 'same content, but it was never written');
  writer.stop();
  writer.onAccord({ type: 'MODIFIED', entry: accord({ friends: [] }) });
  await settled();
  assert.equal(puts.length, 1);
});

test('a failed write is retried on a timer with only the latest record, until it is written or stopped, with no new Accord event needed', async t => {
  const warn = mock.method(console, 'warn', () => {});
  t.after(() => mock.restoreAll());
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  let fail = true;
  const puts = [], coda = { put: async (...args) => { if (fail) throw new Error('目录库忙'); puts.push(args); } };
  const writer = createMachineRecord(coda);
  writer.onAccord({ type: 'ADDED', entry: accord() });
  writer.onAccord({ type: 'MODIFIED', entry: accord({ friends: [] }) });
  await settled();
  assert.equal(warn.mock.callCount(), 2, 'both queued writes carried the newer record and failed');
  assert.match(warn.mock.calls[0].arguments[0], /目录库忙/);
  mock.timers.tick(RETRY_MS - 1);
  await settled();
  assert.equal(warn.mock.callCount(), 2, 'not before the interval, and only one timer is pending');
  mock.timers.tick(1);
  await settled();
  assert.equal(warn.mock.callCount(), 3, 'one retry, not two');
  fail = false;
  mock.timers.tick(RETRY_MS);
  await settled();
  assert.deepEqual(puts, [[{ kind: MACHINE_RECORD_KIND, key: 'local' }, machineRecord(accord({ friends: [] }))]], 'the latest record, written without a new event');
  mock.timers.tick(RETRY_MS * 3);
  await settled();
  assert.equal(puts.length, 1, 'written: the retries stop');
});

test('stop cancels the retry timer', async t => {
  mock.method(console, 'warn', () => {});
  t.after(() => mock.restoreAll());
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  const puts = [];
  let fail = true;
  const writer = createMachineRecord({ put: async (...args) => { if (fail) throw new Error('目录库忙'); puts.push(args); } });
  writer.onAccord({ type: 'ADDED', entry: accord() });
  await settled();
  fail = false;
  writer.stop();
  mock.timers.tick(RETRY_MS * 2);
  await settled();
  assert.equal(puts.length, 0);
});
