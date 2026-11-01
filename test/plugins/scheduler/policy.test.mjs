import assert from 'node:assert/strict';
import { test } from 'node:test';
import { budget, choose, disposition, inOrder } from '../../../plugins/scheduler/lib/policy.mjs';

const spec = { resources: { slots: 1 }, requirements: { labels: ['linux', 'build'] }, exclusiveResources: [] };
function executor(id, slots = 1, patch = {}) {
  return { id, revision: `${id}-v1`, spec: { enabled: true, labels: ['build'] }, status: {
    detectedLabels: ['linux'], accepting: true, available: { slots }, capacity: { slots }, occupied: { slots: 0 },
    executionFeatures: { exclusive: true }, ...patch,
  } };
}
const local = new Set(['local']);
const cases = [
  ['local free wins over larger remote', [executor('remote', 4), executor('local')], {}, 'local'],
  ['busy local falls back to remote', [executor('local', 0), executor('remote')], {}, 'remote'],
  ['most free remote wins', [executor('a'), executor('b', 3)], {}, 'b'],
  ['ties use opaque ID for stable ordering', [executor('b'), executor('a')], {}, 'a'],
  ['all labels required', [executor('local', 2, { detectedLabels: ['darwin'] }), executor('remote')], {}, 'remote'],
  ['status accepting is authoritative', [executor('local', 2, { accepting: false }), executor('remote')], {}, 'remote'],
  ['spec capacity never supplies availability', [executor('local', 0)], {}, 'capacity'],
  ['no executor', [], {}, 'no_executor'],
  ['no matching labels', [executor('local', 1, { detectedLabels: [] })], {}, 'labels_unavailable'],
  ['unknown status does not accept', [{ ...executor('local'), status: {} }], { requirements: { labels: [] } }, 'not_accepting'],
  ['disabled spec does not accept', [{ ...executor('local'), spec: { enabled: false, labels: ['build'] } }], {}, 'not_accepting'],
  ['exclusive unsupported', [executor('local', 2, { executionFeatures: { exclusive: false } })], { exclusiveResources: ['slots'] }, 'exclusive_unsupported'],
  ['exclusive waits for all occupants', [executor('local', 1, { capacity: { slots: 2 }, occupied: { slots: 1 } })], { exclusiveResources: ['slots'] }, 'capacity'],
  ['exclusive on fully free executor', [executor('local', 2)], { exclusiveResources: ['slots'] }, 'local'],
  ['shrunk capacity never inferred from config', [executor('local', 0, { occupied: { slots: 3 } })], {}, 'capacity'],
  ['multiple units refused', [executor('local')], { resources: { slots: 2 } }, 'unsupported_resources'],
  ['unknown resource refused', [executor('local')], { resources: { slots: 1, gpu: 1 } }, 'unsupported_resources'],
];
for (const [name, executors, patch, expected] of cases) test(name, () => {
  const input = structuredClone({ spec: { ...spec, ...patch }, executors });
  const before = structuredClone(input);
  const result = choose(input.spec, input.executors, { local });
  assert.equal(result.executor?.id ?? result.reason.code, expected);
  assert.deepEqual(input, before, 'policy does not mutate its inputs');
});

test('rejected offer waits for a new revision and can choose another executor', () => {
  const e = executor('local'), rejected = { local: e.revision };
  assert.equal(choose(spec, [e], { local, rejected }).reason.code, 'admission_rejected');
  assert.equal(choose(spec, [e, executor('remote')], { local, rejected }).executor.id, 'remote');
  assert.equal(choose(spec, [{ ...e, revision: 'fresh' }], { local, rejected }).executor.id, 'local');
});

const assigned = (status = {}, patch = {}) => ({ spec: { ...spec, executor: { kind: 'executor', id: 'local' }, assignmentId: 'a', ...patch }, status });
for (const [name, object, expected] of [
  ['unbound', assigned({}, { executor: null, assignmentId: null }), 'schedule'],
  ['unbound cancellation', assigned({}, { executor: null, assignmentId: null, cancel: true }), 'cancel'],
  ['empty answer', assigned(), 'observe'],
  ['old rejection', assigned({ phase: 'finished', assignmentId: 'old', outcome: 'rejected' }), 'observe'],
  ['current rejection', assigned({ phase: 'finished', assignmentId: 'a', outcome: 'rejected' }), 'release'],
  ['queued capacity is not proof', assigned({ phase: 'queued', assignmentId: 'a', reason: { code: 'capacity' } }), 'observe'],
  ['preparing without startedAt', assigned({ phase: 'preparing', assignmentId: 'a' }), 'observe'],
  ['running with cancel', assigned({ phase: 'running', assignmentId: 'a' }, { cancel: true }), 'observe'],
  ['finished cancellation never retries', assigned({ phase: 'finished', assignmentId: 'a', outcome: 'cancelled' }), 'done'],
  ['finished failure never retries', assigned({ phase: 'finished', assignmentId: 'a', outcome: 'failed' }), 'done'],
]) test(`disposition: ${name}`, () => assert.equal(disposition(object), expected));

for (const createdAt of ['2026-11-01T00:00:00Z', '2026-10-31T00:00:00Z']) {
  test(`FIFO uses envelope creationSequence even with equal or regressed time (${createdAt})`, () => {
    const entries = [{ creationSequence: 30, id: 'a', createdAt },
      { creationSequence: 10, id: 'z', createdAt: '2026-11-01T00:00:00Z' }];
    assert.deepEqual(inOrder(entries).map(e => e.id), ['z', 'a']);
    assert.equal(entries[0].id, 'a');
  });
}

test('pending assignments consume estimates, admission is not double counted, exclusive blocks successors', () => {
  const e = executor('local', 2), pending = assigned();
  assert.equal(budget([e], [pending]).get('local'), 1);
  const running = assigned({ assignmentId: 'a', admission: { slots: [0] }, phase: 'running' });
  assert.equal(budget([executor('local', 1, { capacity: { slots: 2 }, occupied: { slots: 1 } })], [running]).get('local'), 1);
  assert.equal(budget([e], [running, pending]).get('local'), 0);
  assert.equal(budget([e], [assigned({}, { exclusiveResources: ['slots'] })]).get('local'), 0);
  assert.equal(budget([e], [assigned({ phase: 'finished', outcome: 'rejected', assignmentId: 'a' })]).get('local'), 2);
});
