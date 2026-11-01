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

test('observed order and refusal persist across reopen, without treating opaque IDs as property names', t => {
  const { root, journal } = state(t), first = request('first'), second = request('second');
  journal.remember(first); journal.remember(second); journal.reject(first, { revision: 'offer' });
  const restored = new SchedulingState(root);
  assert.ok(restored.remember(first).order < restored.remember(second).order);
  assert.equal(restored.get(first).rejected.__proto__, 'offer');
  restored.reject(first, { revision: 'newer-offer' });
  assert.equal(restored.get(first).rejected.__proto__, 'offer', 'replaying a refusal does not blacklist a newer offer');
  restored.retain(new Set(['second']));
  assert.equal(new SchedulingState(root).get(first), undefined);
});

test('failed persistence cannot silently authorize a decision from memory on retry', t => {
  const { root, journal } = state(t), object = request('instance');
  const original = journal.path; journal.path = join(root, 'missing', 'state.json');
  assert.throws(() => journal.remember(object), /ENOENT/);
  assert.equal(journal.get(object), undefined);
  journal.path = original; journal.remember(object);
  assert.equal(new SchedulingState(root).get(object).order, 1);
});

test('corrupt existing metadata is an error, never a silently empty queue', t => {
  const { root, journal } = state(t);
  journal.remember(request('instance'));
  assert.ok(readFileSync(journal.path, 'utf8').includes('instance'));
  writeFileSync(journal.path, '{broken');
  assert.throws(() => new SchedulingState(root), SyntaxError);
});
