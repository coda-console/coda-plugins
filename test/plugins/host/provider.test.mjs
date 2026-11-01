import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { HostProvider } from '../../../plugins/host/lib/provider.mjs';
import { providerDefinition } from '../../../check/coda/components/protocols/provider-definition.mjs';
import { ProtocolTypes, validate } from '../../../check/coda/components/protocols/types.mjs';
import { Executions } from '../../../plugins/host/lib/executions.mjs';
import { identity } from '../../../plugins/host/lib/journal.mjs';
import { admissionAPI } from '../../../check/coda/adapters/admission-api.mjs';
import { admissionRequest } from '../../../check/coda/domain/resource-admission.mjs';
import { providerAPI } from '../../../check/coda/adapters/provider-api.mjs';

// Consume the exact package installed beside host, never a second schema fixture or the root checker's older version.
const require = createRequire(new URL('../../../plugins/host/package.json', import.meta.url));
const { EXECUTOR_PROTOCOL, EXECUTION_PROTOCOL } = await import(require.resolve('@coda-console/protocol/executor'));

function fixture(root) {
  const objects = new Map(), watches = [], types = new ProtocolTypes(), pending = [], errors = [];
  let revision = 0, settings = { 'host.capacity': 2, 'host.labels': 'custom' };
  const scope = (sub, object) => sub.scope !== 'assigned' || object.spec.executor?.id === 'host';
  const emit = (object, type = 'MODIFIED') => {
    for (const sub of watches.filter(w => w.kind === object.kind && scope(w, object))) {
      pending.push(Promise.resolve(sub.fn({ type, id: object.id, object })).catch(error => errors.push(error)));
    }
  };
  const save = object => { object = { ...structuredClone(object), revision: `r${++revision}` }; objects.set(`${object.kind}/${object.id}`, object); emit(object); return object; };
  const observe = async (kind, fn, scope = 'available') => {
    const sub = { kind, fn, scope }; watches.push(sub);
    for (const object of objects.values()) if (object.kind === kind && (scope !== 'assigned' || object.spec.executor?.id === 'host')) fn({ type: 'ADDED', id: object.id, object });
    return { dispose: () => watches.splice(watches.indexOf(sub), 1) };
  };
  const check = object => { const type = types.get(object.kind); validate(type.spec, object.spec, object.kind); validate(type.status, object.status, `${object.kind}.status`); };
  const coda = { plugin: { state: root }, environment: async () => ({ PATH: process.env.PATH, CODA_PLUGIN_SETTINGS: JSON.stringify(settings) }),
    protocols: {
      define: async definition => { providerDefinition(definition); types.register({ ...definition, participants: () => [] }); },
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
      delete: async (kind, id) => {
        const object = objects.get(`${kind}/${id}`); objects.delete(`${kind}/${id}`); emit(object, 'DELETED');
      },
      publish: async () => {}, resolve: async () => {},
    },
    resources: admissionAPI(async (method, args) => {
      if (method === 'list') return [];
      if (method === 'release') { assert.deepEqual(args, ['lease']); return; }
      assert.equal(method, 'acquire');
      const request = admissionRequest(args[0]);
      assert.equal(request.group, 'host'); assert.match(request.requestId, /^execution:[a-f0-9]{64}$/);
      return { admitted: true, lease: 'lease', slot: 0 };
    }),
    watch: async (kind, fn) => { assert.equal(kind, 'concurrency-groups'); fn({ type: 'ADDED', id: 'host', object: { capacity: 2, occupied: 1, available: 1 } }); return { dispose() {} }; },
    services: { register: async () => ({ dispose() {} }) },
  };
  const handlers = coda.protocols;
  coda.protocols = providerAPI({
    call: (method, args) => handlers[method](...args),
    watch: (collection, fn, { scope }) => observe(collection.slice('provider:'.length), fn, scope),
    report: (_, error) => errors.push(error),
  });
  return { coda, objects, settings: value => { settings = value; }, async flush() {
    while (pending.length) await Promise.all(pending.splice(0));
    if (errors.length) throw errors.shift();
  } };
}

test('provider uses public schemas, publishes real ledger facts, applies configuration and does not chase status revisions', async t => {
  const root = await mkdtemp(join(tmpdir(), 'host-provider-')); t.after(() => rm(root, { recursive: true, force: true }));
  const f = fixture(root);
  const host = new HostProvider(f.coda, { definitions: [EXECUTOR_PROTOCOL, EXECUTION_PROTOCOL], interval: () => null,
    discover: async () => ({ detectedLabels: ['linux', 'x64', 'node-26'], capabilities: { os: 'linux', arch: 'x64', nodeVersion: '26.8.2', graphicalSession: null } }),
    executions: options => new Executions({ ...options, launch: async () => {}, control: async () => true }),
  });
  await host.start(); await f.flush();
  let object = f.objects.get('executor/host');
  assert.equal(object.status.accepting, true); assert.deepEqual(object.spec.labels, ['custom']);
  assert.deepEqual(object.status.available, { slots: 1 });
  const revision = object.revision; await host.refresh(); await f.flush();
  assert.equal(f.objects.get('executor/host').revision, revision);
  f.settings({ 'host.capacity': 1, 'host.enabled': false }); await host.refresh(); await f.flush();
  object = f.objects.get('executor/host'); assert.equal(object.status.accepting, false); assert.deepEqual(object.status.available, { slots: 0 });
  await host.stop();
});

for (const stage of ['source', 'environment', 'admission']) for (const change of ['cancel', 'delete', 'rebind']) {
  test(`formal provider dispatch observes ${change} during ${stage} before launching the old binding`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'host-provider-dispatch-')); t.after(() => rm(root, { recursive: true, force: true }));
    const f = fixture(root), entered = Promise.withResolvers(), resume = Promise.withResolvers();
    const launches = [], released = [], acquired = [];
    let waiting = false;
    const pause = async () => { if (waiting) { waiting = false; entered.resolve(); await resume.promise; } };
    const environment = f.coda.environment;
    f.coda.environment = async () => { if (stage === 'environment') await pause(); return environment(); };
    f.coda.resources = admissionAPI(async (method, args) => {
      if (method === 'list') return [];
      if (method === 'release') { released.push(args[0]); return; }
      admissionRequest(args[0]);
      const lease = `lease-${acquired.length}`; acquired.push(lease);
      if (stage === 'admission') await pause();
      return { admitted: true, lease, slot: 0 };
    });
    const host = new HostProvider(f.coda, { definitions: [EXECUTOR_PROTOCOL, EXECUTION_PROTOCOL], interval: () => null,
      discover: async () => ({ detectedLabels: ['linux'], capabilities: { os: 'linux', arch: 'x64', nodeVersion: '26', graphicalSession: null } }),
      executions: options => new Executions({ ...options,
        sources: { resolve: async () => { if (stage === 'source') await pause(); return null; } },
        launch: async input => launches.push(input.spec.assignmentId), control: async () => true,
      }),
    });
    await host.start(); await f.flush();
    waiting = true;
    const object = await f.coda.protocols.put({ kind: 'execution', id: 'request', spec: {
      protocolVersion: 1, executor: { kind: 'executor', id: 'host' }, assignmentId: 'old-binding', run: { kind: 'workflow-runs', id: 'run' },
      attempt: 1, source: null, requirements: { labels: ['linux'] }, resources: { slots: 1 }, task: { command: 'true', args: [] }, env: {},
    }, status: {} });
    await entered.promise;
    if (change === 'delete') await f.coda.protocols.delete(object.kind, object.id);
    else await f.coda.protocols.update(object.kind, object.id, { ...object.spec,
      ...(change === 'cancel' ? { cancel: true } : { assignmentId: 'new-binding' }),
    }, object.revision);
    resume.resolve();
    await host.engine.tick(); await f.flush();
    // Drain reconciliations caused by status events too, without timers or a fake controller dispatcher.
    while (host.engine.busy.size) await Promise.all([...host.engine.busy.values()]);
    await f.flush();
    assert.deepEqual(launches, change === 'rebind' ? ['new-binding'] : []);
    assert.equal(host.engine.journal.get(identity(object)), null, 'superseded binding never receives a durable claim');
    assert.deepEqual(released, stage === 'admission' ? ['lease-0'] : []);
    if (change === 'cancel') assert.equal(f.objects.get('execution/request').status.outcome, 'cancelled');
    if (change === 'delete') assert.equal(f.objects.has('execution/request'), false);
    await host.stop();
  });
}

test('execution results and local receipts validate against the published schema, including recovery and completion', async t => {
  const root = await mkdtemp(join(tmpdir(), 'host-public-contract-')); t.after(() => rm(root, { recursive: true, force: true }));
  const f = fixture(root);
  const host = new HostProvider(f.coda, { definitions: [EXECUTOR_PROTOCOL, EXECUTION_PROTOCOL], interval: () => null,
    discover: async () => ({ detectedLabels: ['linux'], capabilities: { os: 'linux', arch: 'x64', nodeVersion: '26', graphicalSession: null } }),
    executions: options => new Executions({ ...options, launch: async () => {}, control: async () => false }),
  });
  await host.start(); await f.flush();
  const object = await f.coda.protocols.put({ kind: 'execution', id: 'request', spec: {
    protocolVersion: 1, executor: { kind: 'executor', id: 'host' }, assignmentId: 'assigned', run: { kind: 'workflow-runs', id: 'run' },
    attempt: 1, source: null, requirements: { labels: ['linux'] }, resources: { slots: 1 }, task: { command: 'true', args: [] }, env: {},
  }, status: {} });
  await f.flush(); await host.engine.tick(); await f.flush();
  assert.equal(f.objects.get('execution/request').status.reason.code, 'result_unknown');
  const record = host.engine.journal.get(identity(object)); record.phase = 'finished'; record.startedAt = '2026-11-01T00:00:00.000Z';
  record.result = { outcome: 'succeeded', exitCode: 0, finishedAt: '2026-11-01T00:00:01.000Z', outputs: { answer: 'yes' } };
  host.engine.journal.save(record); await host.engine.tick(); await f.flush();
  assert.equal(f.objects.get('execution/request').status.outcome, 'succeeded');
  assert.equal(f.objects.get(`hostExecution/${record.key}`).status.outputs.answer, 'yes');
  await host.stop();
});
