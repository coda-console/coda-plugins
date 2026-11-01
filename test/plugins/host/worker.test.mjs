import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Journal, identity, taskFingerprint } from '../../../plugins/host/lib/journal.mjs';
import { controlWorker } from '../../../plugins/host/lib/worker-control.mjs';

test('real durable worker reports completion after client reconnect and authenticates cancellation without PID signalling', async t => {
  const root = await mkdtemp(join(tmpdir(), 'host-worker-')); t.after(() => rm(root, { recursive: true, force: true }));
  const journal = new Journal(root);
  const spec = { protocolVersion: 1, executor: { kind: 'executor', id: 'host' }, assignmentId: 'assignment', run: { kind: 'run', id: 'run' },
    attempt: 1, source: null, requirements: { labels: [] }, resources: { slots: 1 }, env: {}, cancelGraceMs: 1000,
    task: { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] } };
  const object = { id: 'request', instance: 'instance', spec }, key = identity(object);
  journal.save({ key, id: object.id, instance: object.instance, fingerprint: taskFingerprint(spec), assignmentId: spec.assignmentId,
    admission: { lease: 'lease', slot: 0 }, phase: 'claimed' });
  let waiting;
  const running = new Promise(resolve => { waiting = resolve; });
  const worker = spawn(process.execPath, [fileURLToPath(new URL('../../../plugins/host/scripts/execution-worker.mjs', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '', events = ''; worker.stderr.on('data', value => { stderr += value; });
  worker.stdout.on('data', value => { events += value; if (events.includes('"phase":"running"')) waiting(journal.get(key)); });
  const exited = new Promise((resolve, reject) => { worker.once('error', reject); worker.once('close', code => resolve(code)); });
  t.after(() => worker.kill('SIGKILL'));
  worker.stdin.end(JSON.stringify({ root, key, source: null, spec, env: { PATH: process.env.PATH, HOME: process.env.HOME } }));
  const record = await Promise.race([running, exited.then(code => { throw new Error(`worker exited early (${code}): ${stderr}`); })]);
  // Reconstruct the observer from disk, as a restarted host does. A forged token cannot stop the running task.
  const recovered = new Journal(root).get(key);
  assert.equal(await controlWorker({ ...recovered, control: { ...recovered.control, token: 'wrong' } }, 'cancel'), false);
  assert.equal(await controlWorker(record, 'status'), true);
  assert.equal(await controlWorker(recovered, 'cancel'), true);
  assert.equal(await exited, 0, stderr);
  const result = journal.get(key);
  assert.equal(result.phase, 'finished'); assert.equal(result.result.outcome, 'cancelled');
  assert.ok(result.result.finishedAt); assert.ok(result.startedAt);
  assert.equal(await controlWorker(result), false);
});
