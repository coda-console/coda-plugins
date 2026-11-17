import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { HostProvider, EXECUTOR } from '../../../plugins/host/lib/provider.mjs';
import { ProtocolTypes, validate } from '../../../check/coda/components/protocols/types.mjs';
import { recordId, validKey } from '../records.mjs';

// The protocol package is this repository's dependency; host itself only implements the core protocols.
const { EXECUTOR_PROTOCOL } = await import('@coda-console/protocol/protocol');

// The executor record's ID, as the host derives it from the key the plugin gives.
const PLUGIN = 'host', ID = recordId(PLUGIN, EXECUTOR, 'host'), RECORD = `${EXECUTOR}/${ID}`;
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'host-provider-')); t.after(() => rm(root, { recursive: true, force: true }));
  const objects = new Map(), writes = [], operations = new Map();
  let version = 0, settings = { 'host.capacity': 2 }, group;
  const types = new ProtocolTypes();
  for (const definition of [EXECUTOR_PROTOCOL]) types.register({ ...definition, kind: definition.name, participants: () => [] });
  // The records of the new interface, by the plugin's key, the ID the host's: written whole, spec and status together; one
  // written the same is not written again. `replace` drops what this plugin holds of the kind and does not give, keyless or not.
  const check = (kind, key, { spec, status = {} }) => {
    const held = types.get(kind); assert.ok(held, `type ${kind}`); assert.ok(validKey(key), `key ${key}`);
    validate(held.spec, spec, kind); validate(held.status, status, `${kind}.status`);
  };
  const write = (kind, key, { spec, status = {} }) => {
    const id = recordId(PLUGIN, kind, key), previous = objects.get(`${kind}/${id}`);
    if (!previous || JSON.stringify([previous.spec, previous.status]) !== JSON.stringify([spec, status])) {
      writes.push({ kind, id });
      objects.set(`${kind}/${id}`, { owner: PLUGIN, kind, id, key, spec: structuredClone(spec), status: structuredClone(status), version: String(++version) });
    }
    return { id, key, spec, status };
  };
  const put = async ({ kind, key, ...rest }, value) => {
    assert.deepEqual(Object.keys(rest), []); check(kind, key, value);
    return write(kind, key, value);
  };
  const replace = async (kind, items) => {
    for (const { key, ...value } of items) check(kind, key, value);
    for (const [at, held] of objects) if (held.kind === kind && held.owner === PLUGIN && !items.some(item => item.key === held.key)) objects.delete(at);
    return items.map(({ key, ...value }) => write(kind, key, value));
  };
  const coda = { plugin: { id: PLUGIN, state: root }, environment: async () => ({ PATH: process.env.PATH, CODA_PLUGIN_SETTINGS: JSON.stringify(settings) }),
    put, replace, api: async path => ({ state: path === 'workflow-runs/done' ? 'succeeded' : 'running' }),
    handle: async (kind, operation, handler) => { operations.set(`${kind}/${operation}`, handler); return { dispose: () => operations.delete(`${kind}/${operation}`) }; },
    watch: async (kind, fn) => { assert.equal(kind, 'concurrency-groups'); group = fn; fn({ type: 'ADDED', id: 'host', object: { capacity: 2, occupied: 1, available: 1 } }); return { dispose() {} }; },
  };
  return { coda, objects, writes, operations, settings: value => { settings = value; }, group: event => group(event),
    flush: () => new Promise(resolve => setImmediate(resolve)) };
}
const hostOf = f => new HostProvider(f.coda, { interval: () => null,
  discover: async () => ({ detectedLabels: ['linux', 'x64', 'node-26'], capabilities: { os: 'linux', arch: 'x64', nodeVersion: '26.8.2', graphicalSession: null } }),
});

test('the executor record is a coda/executor@1 object which follows configuration and writes its status again only when it changed', async t => {
  const f = await fixture(t), host = hostOf(f);
  await host.start(); await f.flush();
  let object = f.objects.get(RECORD);
  assert.equal(object.status.accepting, true); assert.deepEqual(object.spec.labels, []);
  assert.deepEqual(object.status.capacity, { slots: 2 }); assert.deepEqual(object.status.occupied, { slots: 1 });
  assert.deepEqual(object.status.available, { slots: 1 });
  const writes = f.writes.length; await host.refresh(); await f.flush();
  assert.equal(f.writes.length, writes);
  f.settings({ 'host.capacity': 1 }); await host.refresh(); await f.flush();
  object = f.objects.get(RECORD);
  assert.deepEqual(object.spec.capacity, { slots: 1 }); assert.deepEqual(object.status.capacity, { slots: 1 });
  assert.equal(object.status.accepting, true); assert.deepEqual(object.status.available, { slots: 0 });
  await host.stop();
});

test('a refused write is tried again by the next refresh', async t => {
  const f = await fixture(t), host = hostOf(f), { put, replace } = f.coda;
  f.coda.put = f.coda.replace = async () => { throw new Error('refused'); };
  await assert.rejects(host.start(), /refused/);
  Object.assign(f.coda, { put, replace }); await host.refresh(); await host.refresh();
  assert.equal(f.writes.length, 1);
  assert.ok(f.objects.has(RECORD));
  await host.stop();
});

test('a refresh while an earlier write is under way compares with what was sent last: A, then B under way, then A again ends as A', async t => {
  const f = await fixture(t), host = hostOf(f), put = f.coda.put;
  t.after(() => { f.coda.put = put; return host.stop(); });
  await host.start(); await f.flush();
  assert.deepEqual(f.objects.get(RECORD).spec.capacity, { slots: 2 });
  // A host that takes the writes in order and finishes each only when let go.
  const held = [];
  f.coda.put = (...args) => new Promise((resolve, reject) => held.push(() => put(...args).then(resolve, reject)));
  f.settings({ 'host.capacity': 1 }); const b = host.refresh(); await f.flush();
  f.settings({ 'host.capacity': 2 }); const a = host.refresh(); await f.flush();
  for (const write of held.splice(0)) await write();
  await Promise.all([b, a]);
  assert.deepEqual(f.objects.get(RECORD).spec.capacity, { slots: 2 });
});

test('a refresh refused after a record was published does not keep stop from writing it as no longer accepting', async t => {
  const f = await fixture(t), host = hostOf(f), put = f.coda.put;
  await host.start(); await f.flush();
  assert.equal(f.objects.get(RECORD).status.accepting, true);
  f.coda.put = async () => { throw new Error('refused'); };
  f.settings({ 'host.capacity': 1 }); await assert.rejects(host.refresh(), /refused/);
  f.coda.put = put; await host.stop();
  assert.equal(f.objects.get(RECORD).status.accepting, false);
  assert.equal(f.objects.get(RECORD).status.reason.code, 'stopped');
});

test('the first write gives the executor records whole: the one 2.4.0 left under the ID host, without a key, goes; later writes put', async t => {
  const f = await fixture(t), host = hostOf(f), other = `${EXECUTOR}/${recordId('other', EXECUTOR, 'host')}`;
  f.objects.set(`${EXECUTOR}/host`, { owner: PLUGIN, kind: EXECUTOR, id: 'host', spec: {}, status: {} });
  f.objects.set(other, { owner: 'other', kind: EXECUTOR, id: other, key: 'host', spec: {}, status: {} });
  const replace = f.coda.replace; let replaced = 0;
  f.coda.replace = (...args) => { replaced++; return replace(...args); };
  await host.start(); await f.flush();
  assert.deepEqual([...f.objects.keys()].sort(), [RECORD, other].sort());
  assert.equal(f.objects.get(RECORD).key, 'host');
  f.settings({ 'host.capacity': 1 }); await host.refresh(); await host.stop();
  assert.equal(replaced, 1);
  assert.deepEqual(f.objects.get(RECORD).spec.capacity, { slots: 1 }); assert.equal(f.objects.get(RECORD).status.accepting, false);
});

test('the capacity status follows the host group and stops accepting without one', async t => {
  const f = await fixture(t), host = hostOf(f);
  await host.start(); await f.flush();
  f.group({ type: 'MODIFIED', id: 'host', object: { capacity: 2, occupied: 0, available: 2 } }); await f.flush(); await host.refresh();
  let object = f.objects.get(RECORD);
  assert.deepEqual([object.status.occupied, object.status.available], [{ slots: 0 }, { slots: 2 }]);
  f.group({ type: 'DELETED', id: 'host' }); await f.flush(); await host.refresh();
  object = f.objects.get(RECORD);
  assert.equal(object.status.accepting, false); assert.deepEqual(object.status.available, { slots: 0 });
  await host.stop();
});

test('a restarted provider writes over the executor record its previous run left', async t => {
  const f = await fixture(t), first = hostOf(f);
  await first.start(); await f.flush(); await first.stop();
  const left = f.objects.get(RECORD); assert.equal(left.status.accepting, false);
  const host = hostOf(f);
  await host.start(); await f.flush();
  const object = f.objects.get(RECORD);
  assert.notEqual(object.version, left.version); assert.equal(object.status.accepting, true); assert.equal(object.status.reason, undefined);
  await host.stop();
});

test('the provider writes the one executor record, handles no execute and no run, and answers its own run-finished', async t => {
  const f = await fixture(t), host = hostOf(f);
  await host.start(); await f.flush();
  assert.deepEqual([...f.objects.keys()], [RECORD]);
  assert.deepEqual([...f.operations.keys()], ['self/run-finished']);
  const finished = f.operations.get('self/run-finished');
  assert.deepEqual([await finished({ run: 'done' }), await finished({ run: 'live' }), await finished()], [{ finished: true }, { finished: false }, { finished: false }]);
  await host.stop();
  assert.deepEqual([...f.operations.keys()], []);
});

test('the manifest implements only the executor record, with neither the dropped settings nor an execute handler', () => {
  const { contributes } = JSON.parse(readFileSync(new URL('../../../plugins/host/package.json', import.meta.url), 'utf8'));
  assert.deepEqual(contributes.protocolImplementations, [EXECUTOR]);
  assert.deepEqual(Object.keys(contributes.configuration.properties).filter(name => /enabled|labels/.test(name)), []);
});
