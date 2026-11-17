import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { HostProvider, EXECUTOR } from '../../../plugins/host/lib/provider.mjs';
import { ProtocolTypes, validate } from '../../../check/coda/components/protocols/types.mjs';
import { providerAPI } from '../../../check/coda/adapters/provider-api.mjs';

// The protocol package is this repository's dependency; host itself only implements the core protocols.
const { EXECUTOR_PROTOCOL } = await import('@coda-console/protocol/protocol');

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'host-provider-')); t.after(() => rm(root, { recursive: true, force: true }));
  const objects = new Map(), watches = [], operations = new Map(), pending = [], errors = [];
  let revision = 0, settings = { 'host.capacity': 2 }, group;
  const types = new ProtocolTypes();
  for (const definition of [EXECUTOR_PROTOCOL]) types.register({ ...definition, kind: definition.name, participants: () => [] });
  const type = kind => { const found = types.get(kind); assert.ok(found, `type ${kind}`); return found; };
  const emit = (object, type = 'MODIFIED') => {
    for (const sub of watches.filter(w => w.kind === object.kind)) pending.push(Promise.resolve(sub.fn({ type, id: object.id, object })).catch(error => errors.push(error)));
  };
  const save = object => { object = { ...structuredClone(object), revision: `r${++revision}` }; objects.set(`${object.kind}/${object.id}`, object); emit(object); return object; };
  const observe = async (kind, fn, scope = 'available') => {
    const sub = { kind, fn, scope }; watches.push(sub);
    for (const object of objects.values()) if (object.kind === kind) fn({ type: 'ADDED', id: object.id, object });
    return { dispose: () => watches.splice(watches.indexOf(sub), 1) };
  };
  const check = object => { const held = type(object.kind); validate(held.spec, object.spec, object.kind); validate(held.status, object.status, `${object.kind}.status`); };
  const coda = { plugin: { state: root }, environment: async () => ({ PATH: process.env.PATH, CODA_PLUGIN_SETTINGS: JSON.stringify(settings) }),
    protocols: {
      put: async object => {
        const previous = objects.get(`${object.kind}/${object.id}`);
        if (previous && object.revision !== previous.revision) throw Object.assign(new Error('协议对象已改变，请重新读取'), { code: 'conflict' });
        object = { ...object, status: previous?.status ?? object.status, instance: previous?.instance ?? `instance-${object.id}` };
        check(object); return save(object);
      },
      setStatus: async (kind, id, status, revision) => {
        const object = objects.get(`${kind}/${id}`); assert.equal(revision, object.revision, 'status uses the observed revision');
        const next = { ...object, status }; check(next); return save(next);
      },
      update: async (kind, id, spec, revision) => {
        const object = objects.get(`${kind}/${id}`); assert.equal(revision, object.revision);
        const next = { ...object, spec }; check(next); return save(next);
      },
      delete: async (kind, id) => { const object = objects.get(`${kind}/${id}`); objects.delete(`${kind}/${id}`); emit(object, 'DELETED'); },
      publish: async () => {}, resolve: async () => {},
      handle: async (kind, operation, handler) => { operations.set(`${kind}/${operation}`, handler); return { dispose: () => operations.delete(`${kind}/${operation}`) }; },
    },
    handle: async (kind, operation, handler) => { operations.set(`${kind}/${operation}`, handler); return { dispose: () => operations.delete(`${kind}/${operation}`) }; },
    api: async path => ({ state: path === 'workflow-runs/done' ? 'succeeded' : 'running' }),
    watch: async (kind, fn) => { assert.equal(kind, 'concurrency-groups'); group = fn; fn({ type: 'ADDED', id: 'host', object: { capacity: 2, occupied: 1, available: 1 } }); return { dispose() {} }; },
  };
  const handlers = coda.protocols;
  coda.protocols = { ...providerAPI({
    call: (method, args) => handlers[method](...args),
    watch: (collection, fn, { scope }) => observe(collection, fn, scope),
    report: (_, error) => errors.push(error),
  }), handle: handlers.handle };
  return { coda, objects, operations, settings: value => { settings = value; }, group: event => group(event), async flush() {
    while (pending.length) await Promise.all(pending.splice(0));
    if (errors.length) throw errors.shift();
  } };
}
const hostOf = f => new HostProvider(f.coda, { interval: () => null,
  discover: async () => ({ detectedLabels: ['linux', 'x64', 'node-26'], capabilities: { os: 'linux', arch: 'x64', nodeVersion: '26.8.2', graphicalSession: null } }),
});

test('the executor record is a coda/executor@1 object which follows configuration without chasing its own status', async t => {
  const f = await fixture(t), host = hostOf(f);
  await host.start(); await f.flush();
  let object = f.objects.get(`${EXECUTOR}/host`);
  assert.equal(object.status.accepting, true); assert.deepEqual(object.spec.labels, []);
  assert.deepEqual(object.status.capacity, { slots: 2 }); assert.deepEqual(object.status.occupied, { slots: 1 });
  assert.deepEqual(object.status.available, { slots: 1 });
  const revision = object.revision; await host.refresh(); await f.flush();
  assert.equal(f.objects.get(`${EXECUTOR}/host`).revision, revision);
  f.settings({ 'host.capacity': 1 }); await host.refresh(); await f.flush();
  object = f.objects.get(`${EXECUTOR}/host`);
  assert.deepEqual(object.spec.capacity, { slots: 1 }); assert.deepEqual(object.status.capacity, { slots: 1 });
  assert.equal(object.status.accepting, true); assert.deepEqual(object.status.available, { slots: 0 });
  await host.stop();
});

test('the capacity status follows the host group and stops accepting without one', async t => {
  const f = await fixture(t), host = hostOf(f);
  await host.start(); await f.flush();
  f.group({ type: 'MODIFIED', id: 'host', object: { capacity: 2, occupied: 0, available: 2 } }); await f.flush(); await host.refresh();
  let object = f.objects.get(`${EXECUTOR}/host`);
  assert.deepEqual([object.status.occupied, object.status.available], [{ slots: 0 }, { slots: 2 }]);
  f.group({ type: 'DELETED', id: 'host' }); await f.flush(); await host.refresh();
  object = f.objects.get(`${EXECUTOR}/host`);
  assert.equal(object.status.accepting, false); assert.deepEqual(object.status.available, { slots: 0 });
  await host.stop();
});

test('a restarted provider takes over the executor record its previous run left', async t => {
  const f = await fixture(t), first = hostOf(f);
  await first.start(); await f.flush(); await first.stop();
  const left = f.objects.get(`${EXECUTOR}/host`); assert.equal(left.status.accepting, false);
  const host = hostOf(f);
  await host.start(); await f.flush();
  const object = f.objects.get(`${EXECUTOR}/host`);
  assert.equal(object.instance, left.instance); assert.notEqual(object.revision, left.revision);
  assert.equal(object.status.accepting, true); assert.equal(host.offered.revision, object.revision);
  await host.stop();
});

test('the provider publishes the record, handles no execute and no run, and answers its own run-finished', async t => {
  const f = await fixture(t), host = hostOf(f);
  await host.start(); await f.flush();
  assert.ok(f.objects.has(`${EXECUTOR}/host`));
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
