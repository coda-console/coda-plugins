import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { providerAPI } from '../../../check/coda/adapters/provider-api.mjs';
import { providerDefinition } from '../../../check/coda/components/protocols/provider-definition.mjs';
import { ProtocolTypes, validate } from '../../../check/coda/components/protocols/types.mjs';
import { Scheduler } from '../../../plugins/scheduler/lib/scheduler.mjs';

// The host provider owns the public definitions. Use its locked dependency, not a duplicate schema.
const require = createRequire(new URL('../../../plugins/host/package.json', import.meta.url));
const { EXECUTOR_PROTOCOL, EXECUTION_PROTOCOL } = await import(require.resolve('@coda-console/protocol/executor'));
const stamp = '2026-11-01T00:00:00.000Z';
function execution(id, patch = {}, status = { phase: 'queued', assignmentId: null }) {
  return { kind: 'execution', id, instance: `instance-${id}`, spec: {
    protocolVersion: 1, run: { kind: 'workflow-runs', id: 'run' }, attempt: 1, source: null,
    requirements: { labels: ['linux'] }, resources: { slots: 1 }, exclusiveResources: [],
    task: { command: 'true', args: [] }, workingDirectory: '.', env: {}, cancel: false,
    executor: null, assignmentId: null, ...patch,
  }, status };
}
function executor(id, available = 1) {
  return { kind: 'executor', id, instance: `executor-${id}`, spec: {
    protocolVersion: 1, enabled: true, capacity: { slots: 2 }, labels: [],
  }, status: { detectedLabels: ['linux'], capabilities: { os: 'linux', arch: 'x64', nodeVersion: '24', graphicalSession: null },
    capacity: { slots: 2 }, occupied: { slots: 2 - available }, available: { slots: available }, accepting: true,
    observedAt: stamp, observedRevision: 'configuration', executionFeatures: { multiResource: false, multiUnit: false, exclusive: true },
  } };
}

async function fixture(t, initial = [], { local = ['local'], order, root: reuseRoot } = {}) {
  const root = reuseRoot ?? await mkdtemp(join(tmpdir(), 'scheduler-'));
  if (!reuseRoot) t.after(() => rm(root, { recursive: true, force: true }));
  const types = new ProtocolTypes(), objects = new Map(), subscriptions = [], calls = [], errors = [];
  for (const definition of [EXECUTOR_PROTOCOL, { ...EXECUTION_PROTOCOL, controllers: ['scheduler'] }]) {
    types.register({ ...providerDefinition(definition), participants: () => [] });
  }
  let revision = 0, nextAssignment = 0;
  const visible = (sub, object) => sub.kind === object.kind && (sub.scope !== 'local' ||
    (object.kind === 'executor' ? local.includes(object.id) : object.id !== 'foreign-request'));
  const emit = (object, type = 'MODIFIED') => {
    for (const sub of [...subscriptions]) if (visible(sub, object)) sub.fn({ type, id: object.id, object });
  };
  const save = (object, notify = true) => {
    object = structuredClone(object);
    const type = types.get(object.kind); validate(type.spec, object.spec, `${object.kind}.spec`); validate(type.status, object.status, `${object.kind}.status`);
    object.revision = `opaque-${++revision}`; objects.set(`${object.kind}/${object.id}`, object);
    if (notify) emit(object);
    return object;
  };
  for (const object of initial) save(object, false);
  const f = { root, objects, subscriptions, calls, errors, save, beforeWrite: null, beforeWatch: null,
    get: (id, kind = 'execution') => objects.get(`${kind}/${id}`),
    remove(id, kind = 'execution') { const object = this.get(id, kind); objects.delete(`${kind}/${id}`); emit(object, 'DELETED'); },
  };
  const coda = { plugin: { state: root }, protocols: providerAPI({
    async call(method, args) {
      calls.push({ method, args: structuredClone(args) });
      assert.ok(['update', 'setStatus'].includes(method), 'scheduler is a controller, never a provider or supplement');
      const [kind, id, value, observed] = args;
      assert.equal(kind, 'execution'); assert.notEqual(id, 'foreign-request');
      if (f.beforeWrite) await f.beforeWrite(method, args);
      const object = f.get(id);
      if (!object || observed !== object.revision) throw new Error('conflict: re-observe');
      if (method === 'update') {
        const { executor: oldExecutor, assignmentId: oldAssignment, ...before } = object.spec;
        const { executor: newExecutor, assignmentId: newAssignment, ...after } = value;
        assert.deepEqual(after, before, 'binding preserves task, cancellation, source and attempt');
        assert.equal(newExecutor === null, newAssignment === null, 'binding fields are replaced atomically');
        if (oldExecutor) assert.equal(object.status.outcome, 'rejected', 'no ambiguous reassignment');
        return save({ ...object, spec: value });
      }
      assert.equal(object.spec.executor, null, 'scheduler never writes a bound status, including a local binding');
      return save({ ...object, status: value });
    },
    async watch(collection, fn, { scope }) {
      await f.beforeWatch?.(collection, scope);
      const sub = { kind: collection.slice('provider:'.length), fn, scope };
      subscriptions.push(sub);
      for (const object of objects.values()) if (visible(sub, object)) fn({ type: 'ADDED', id: object.id, object });
      return { dispose() { subscriptions.splice(subscriptions.indexOf(sub), 1); } };
    },
    report: (_, error) => errors.push(error),
  }) };
  f.scheduler = new Scheduler(coda, { ...(order ? { order } : {}), interval: () => null,
    assignment: () => `new-${++nextAssignment}`, now: () => stamp, report: (_, error) => errors.push(error) });
  t.after(() => f.scheduler.stop());
  f.flush = async () => { await f.scheduler.wake(); await f.scheduler.wake(); };
  return f;
}

test('public controller takes local requests only, waits for the initial snapshot, and replaces one binding by CAS', async t => {
  const f = await fixture(t, [executor('remote', 2), execution('foreign-request'), execution('request'), executor('local')]);
  await f.scheduler.start(); await f.flush();
  assert.equal(f.get('request').spec.executor.id, 'local');
  assert.equal(f.get('foreign-request').spec.executor, null);
  assert.equal(f.calls.filter(c => c.method === 'update').length, 1);
  assert.deepEqual(f.errors, []);
  assert.deepEqual(f.subscriptions.map(s => [s.kind, s.scope]), [['executor', 'local'], ['executor', 'available'], ['execution', 'local']]);
});

test('FIFO across IDs and pending assignments prevent filling the same stale free slot twice', async t => {
  const f = await fixture(t, [executor('local'), execution('a-new'), execution('z-old')], {
    order: object => object.id === 'z-old' ? 1 : 2,
  });
  await f.scheduler.start(); await f.flush();
  assert.equal(f.get('z-old').spec.executor.id, 'local');
  assert.equal(f.get('a-new').spec.executor, null);
  assert.equal(f.get('a-new').status.reason.code, 'capacity');
  assert.deepEqual(f.errors, []);
});

test('queued reason changes with availability, no status churn, and a remote offer wakes the queue', async t => {
  const f = await fixture(t, [execution('request')]); await f.scheduler.start(); await f.flush();
  assert.equal(f.get('request').status.reason.code, 'no_executor');
  const count = f.calls.length; await f.flush(); assert.equal(f.calls.length, count);
  f.save(executor('remote')); await f.flush();
  assert.equal(f.get('request').spec.executor.id, 'remote'); assert.deepEqual(f.errors, []);
});

test('current refusal releases by CAS, chooses another offer, and never overwrites bound status', async t => {
  const rejected = execution('request', { executor: { kind: 'executor', id: 'local' }, assignmentId: 'old' }, {
    phase: 'finished', assignmentId: 'old', outcome: 'rejected', finishedAt: stamp, reason: { code: 'capacity', message: 'busy' },
  });
  const f = await fixture(t, [executor('local'), executor('remote'), rejected]); await f.scheduler.start(); await f.flush();
  assert.equal(f.get('request').spec.executor.id, 'remote');
  assert.notEqual(f.get('request').spec.assignmentId, 'old');
  assert.deepEqual(f.calls.map(c => c.method), ['update', 'update']);
  assert.deepEqual(f.errors, []);
});

test('refusal survives restart and only a fresh offer allows the same executor again', async t => {
  const f = await fixture(t, [executor('local'), execution('request', { executor: { kind: 'executor', id: 'local' }, assignmentId: 'old' }, {
    phase: 'finished', assignmentId: 'old', outcome: 'rejected', finishedAt: stamp,
  })]);
  await f.scheduler.start(); await f.flush();
  assert.equal(f.get('request').status.reason.code, 'admission_rejected');
  await f.scheduler.stop();
  const restored = await fixture(t, [...f.objects.values()], { root: f.root });
  await restored.scheduler.start(); await restored.flush();
  assert.equal(restored.get('request').spec.executor, null);
  restored.save(executor('local')); await restored.flush();
  assert.equal(restored.get('request').spec.executor.id, 'local');
  assert.deepEqual([...f.errors, ...restored.errors], []);
});

for (const status of [{}, { phase: 'queued', assignmentId: 'old', reason: { code: 'capacity', message: 'busy' } },
  { phase: 'preparing', assignmentId: 'old' },
  { phase: 'running', assignmentId: 'old', startedAt: stamp, executionRun: { kind: 'hostExecution', id: 'receipt' }, admission: { lease: 'opaque', slots: [0] } },
  { phase: 'finished', assignmentId: 'previous', outcome: 'rejected', finishedAt: stamp }]) {
  test(`restart preserves uncertain or started binding (${status.phase ?? 'empty'}/${status.assignmentId ?? 'absent'})`, async t => {
    const f = await fixture(t, [executor('remote', 2), execution('request', { executor: { kind: 'executor', id: 'missing' }, assignmentId: 'old' }, status)]);
    await f.scheduler.start(); await f.flush();
    assert.deepEqual(f.calls, []); assert.equal(f.get('request').spec.executor.id, 'missing');
    assert.deepEqual(f.get('request').status, status); assert.deepEqual(f.errors, []);
  });
}

test('cancel unbound completes without binding; cancel bound stays intent for the execution provider', async t => {
  const f = await fixture(t, [executor('local'), execution('unbound', { cancel: true }), execution('bound', {
    cancel: true, executor: { kind: 'executor', id: 'local' }, assignmentId: 'old',
  }, {})]);
  await f.scheduler.start(); await f.flush();
  assert.equal(f.get('unbound').status.outcome, 'cancelled');
  assert.deepEqual(f.get('bound').status, {}); assert.equal(f.get('bound').spec.cancel, true);
  assert.equal(f.calls.length, 1); assert.deepEqual(f.errors, []);
});

test('cancel racing a binding rejects stale revision and reconciles current intent', async t => {
  const f = await fixture(t, [executor('local'), execution('request')]);
  f.beforeWrite = async method => {
    if (method !== 'update') return;
    f.beforeWrite = null;
    const current = f.get('request'); f.save({ ...current, spec: { ...current.spec, cancel: true } });
  };
  await f.scheduler.start(); await f.flush();
  assert.equal(f.get('request').spec.executor, null); assert.equal(f.get('request').status.outcome, 'cancelled');
  assert.equal(f.errors.length, 1); assert.match(f.errors[0].message, /conflict/);
});

test('delete/recreate invalidates old revision; the new instance cannot inherit rejection metadata', async t => {
  const f = await fixture(t, [executor('local'), execution('request')]);
  f.beforeWrite = async () => {
    f.beforeWrite = null; f.remove('request');
    f.save({ ...execution('request', { cancel: true }), instance: 'new-instance' });
  };
  await f.scheduler.start(); await f.flush();
  assert.equal(f.get('request').instance, 'new-instance'); assert.equal(f.get('request').spec.executor, null);
  assert.equal(f.get('request').status.outcome, 'cancelled'); assert.equal(f.errors.length, 1);
});

test('deactivate disposes every watch; subsequent events do not schedule', async t => {
  const f = await fixture(t, [execution('request')]); await f.scheduler.start(); await f.scheduler.stop();
  assert.equal(f.subscriptions.length, 0); const count = f.calls.length;
  f.save(executor('local')); await f.flush(); assert.equal(f.calls.length, count);
});

test('first install retries provider registration after disposing partial subscriptions', async t => {
  const f = await fixture(t, [executor('local'), execution('request')]);
  f.beforeWatch = collection => { if (collection === 'provider:execution') throw new Error('kind not registered yet'); };
  await f.scheduler.start(); assert.equal(f.scheduler.ready, false); assert.equal(f.subscriptions.length, 0);
  f.beforeWatch = null; await f.scheduler.connect(); await f.flush();
  assert.equal(f.get('request').spec.executor.id, 'local'); assert.equal(f.subscriptions.length, 3);
  assert.equal(f.errors.length, 1); assert.match(f.errors[0].message, /not registered/);
});
