import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { HostProvider, EXECUTOR } from '../../../plugins/host/lib/provider.mjs';
import { ProtocolTypes, validate } from '../../../check/coda/components/protocols/types.mjs';
import { Executions, RUN } from '../../../plugins/host/lib/executions.mjs';
import { admissionAPI } from '../../../check/coda/adapters/admission-api.mjs';
import { admissionRequest } from '../../../check/coda/domain/resource-admission.mjs';
import { providerAPI } from '../../../check/coda/adapters/provider-api.mjs';

// The protocol package is this repository's dependency; host itself only implements the core protocols.
const { EXECUTOR_PROTOCOL, RUN_PROTOCOL } = await import('@coda-console/protocol/protocol');

const input = (patch = {}) => ({ source: null, requirements: { labels: ['linux'] }, resources: { slots: 1 }, exclusiveResources: [],
  task: { command: 'true', args: [] }, env: {}, ...patch });

function fixture(root, launches = [], controls = []) {
  const objects = new Map(), watches = [], operations = new Map(), pending = [], errors = [];
  let revision = 0, settings = { 'host.capacity': 2, 'host.labels': 'custom' };
  const types = new ProtocolTypes();
  for (const definition of [EXECUTOR_PROTOCOL, RUN_PROTOCOL]) types.register({ ...definition, kind: definition.name, participants: () => [] });
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
        if (previous) assert.equal(object.revision, previous.revision);
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
    resources: admissionAPI(async (method, args) => {
      if (method === 'list') return [];
      if (method === 'release') return;
      admissionRequest(args[0]);
      return { admitted: true, lease: `lease-${launches.length}`, slot: 0 };
    }),
    watch: async (kind, fn) => { assert.equal(kind, 'concurrency-groups'); fn({ type: 'ADDED', id: 'host', object: { capacity: 2, occupied: 1, available: 1 } }); return { dispose() {} }; },
  };
  const handlers = coda.protocols;
  coda.protocols = { ...providerAPI({
    call: (method, args) => handlers[method](...args),
    watch: (collection, fn, { scope }) => observe(collection, fn, scope),
    report: (_, error) => errors.push(error),
  }), handle: handlers.handle };
  return { coda, objects, operations, settings: value => { settings = value; }, async flush() {
    while (pending.length) await Promise.all(pending.splice(0));
    if (errors.length) throw errors.shift();
  } };
}
const hostOf = (f, launches = [], controls = []) => new HostProvider(f.coda, { interval: () => null,
  discover: async () => ({ detectedLabels: ['linux', 'x64', 'node-26'], capabilities: { os: 'linux', arch: 'x64', nodeVersion: '26.8.2', graphicalSession: null } }),
  executions: options => new Executions({ ...options, launch: async (value, directory) => launches.push(value),
    control: async (record, action) => { controls.push([record.key, action]); return true; } }),
});

test('the executor record is a coda/executor@1 object which follows configuration without chasing its own status', async t => {
  const root = await mkdtemp(join(tmpdir(), 'host-provider-')); t.after(() => rm(root, { recursive: true, force: true }));
  const f = fixture(root), host = hostOf(f);
  await host.start(); await f.flush();
  let object = f.objects.get(`${EXECUTOR}/host`);
  assert.equal(object.status.accepting, true); assert.deepEqual(object.spec.labels, ['custom']);
  assert.deepEqual(object.status.available, { slots: 1 });
  const revision = object.revision; await host.refresh(); await f.flush();
  assert.equal(f.objects.get(`${EXECUTOR}/host`).revision, revision);
  f.settings({ 'host.capacity': 1, 'host.enabled': false }); await host.refresh(); await f.flush();
  object = f.objects.get(`${EXECUTOR}/host`); assert.equal(object.status.accepting, false); assert.deepEqual(object.status.available, { slots: 0 });
  await host.stop();
});

test('execute starts the local run once and writes its status on the coda/run@1 object', async t => {
  const root = await mkdtemp(join(tmpdir(), 'host-provider-run-')); t.after(() => rm(root, { recursive: true, force: true }));
  const f = fixture(root), launches = [];
  const host = hostOf(f, launches);
  await host.start(); await f.flush();
  const run = await f.coda.protocols.put({ kind: RUN, id: 'run-1', spec: { record: { kind: EXECUTOR, id: 'host' }, operation: 'execute', input: input(),
    requestId: 'request-1', parent: { kind: 'workflow-runs', id: 'caller' }, awaited: true }, status: { state: 'working' } });
  const execute = f.operations.get(`${EXECUTOR}/execute`);
  execute(input(), { run: { kind: RUN, id: run.id } });
  execute(input(), { run: { kind: RUN, id: run.id } });
  while (host.engine.busy.size) await Promise.all([...host.engine.busy.values()]);
  assert.equal(launches.length, 1);
  const record = host.engine.journal.list()[0];
  record.phase = 'finished'; record.reported = false;
  record.result = { outcome: 'succeeded', exitCode: 0, outputTail: 'done', summary: 'ok', outputs: { answer: 'yes' }, finishedAt: new Date().toISOString() };
  host.engine.journal.save(record);
  await host.engine.tick(); await f.flush();
  const held = f.objects.get(`${RUN}/${run.id}`);
  assert.equal(held.status.state, 'completed');
  assert.deepEqual(held.status.result, { exitCode: 0, output: 'done', summary: 'ok', outputs: { answer: 'yes' } });
  await host.stop();
});

test('cancel is the run provider stopping its worker', async t => {
  const root = await mkdtemp(join(tmpdir(), 'host-provider-cancel-')); t.after(() => rm(root, { recursive: true, force: true }));
  const f = fixture(root), controls = [];
  const host = hostOf(f, [], controls);
  await host.start(); await f.flush();
  const run = await f.coda.protocols.put({ kind: RUN, id: 'run-2', spec: { record: { kind: EXECUTOR, id: 'host' }, operation: 'execute', input: input(),
    requestId: 'request-2', parent: { kind: 'workflow-runs', id: 'caller' }, awaited: true }, status: { state: 'working' } });
  f.operations.get(`${EXECUTOR}/execute`)(input(), { run: { kind: RUN, id: run.id } });
  while (host.engine.busy.size) await Promise.all([...host.engine.busy.values()]);
  const record = host.engine.journal.list()[0]; record.phase = 'running'; record.control = { port: 1, token: 't' }; host.engine.journal.save(record);
  await f.operations.get(`${RUN}/cancel`)({}, { record: { kind: RUN, id: run.id } });
  assert.deepEqual(controls.map(([, action]) => action), ['cancel']);
  await host.stop();
});
