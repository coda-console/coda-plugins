import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SchedulingState } from '../../../plugins/scheduler/lib/state.mjs';

function state(t) {
  const root = mkdtempSync(join(tmpdir(), 'scheduler-state-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, journal: new SchedulingState(root) };
}
const request = instance => ({ id: 'same-id', instance, spec: { assignmentId: 'assignment', executor: { id: '__proto__' } } });

test('only refusal persists across reopen, without treating opaque IDs as property names', t => {
  const { root, journal } = state(t), first = request('first');
  journal.reject(first, { revision: 'offer' });
  const restored = new SchedulingState(root);
  assert.deepEqual(Object.keys(restored.data), ['entries']);
  assert.deepEqual(Object.keys(restored.get(first)).sort(), ['lastRejected', 'rejected']);
  assert.equal(restored.get(first).rejected.__proto__, 'offer');
  restored.reject(first, { revision: 'newer-offer' });
  assert.equal(restored.get(first).rejected.__proto__, 'offer', 'replaying a refusal does not blacklist a newer offer');
  restored.retain(new Set(['second']));
  assert.equal(new SchedulingState(root).get(first), undefined);
});

test('failed persistence cannot silently authorize a decision from memory on retry', t => {
  const { root, journal } = state(t), object = request('instance');
  const original = journal.path; journal.path = join(root, 'missing', 'state.json');
  assert.throws(() => journal.reject(object, { revision: 'offer' }), /ENOENT/);
  assert.equal(journal.get(object), undefined);
  journal.path = original; journal.reject(object, { revision: 'offer' });
  assert.equal(new SchedulingState(root).get(object).lastRejected, 'assignment');
});

test('corrupt existing metadata is an error, never a silently empty queue', t => {
  const { root, journal } = state(t);
  journal.reject(request('instance'), { revision: 'offer' });
  assert.ok(readFileSync(journal.path, 'utf8').includes('instance'));
  writeFileSync(journal.path, '{broken');
  assert.throws(() => new SchedulingState(root), SyntaxError);
});
