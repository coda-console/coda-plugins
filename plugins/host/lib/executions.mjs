import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Journal, canonical, identity, taskFingerprint } from './journal.mjs';
import { controlWorker } from './worker-control.mjs';

const entry = fileURLToPath(new URL('../scripts/execution-worker.mjs', import.meta.url));
const now = () => new Date().toISOString();

export function launchWorker(input, directory) {
  const fd = openSync(join(directory, 'worker.log'), 'a', 0o600);
  let child;
  try { child = spawn(process.execPath, [entry], { detached: true, stdio: ['pipe', fd, fd], env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR } }); }
  finally { closeSync(fd); }
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('spawn', () => {
      child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(input));
      child.unref(); resolve();
    });
  });
}

export class Executions {
  constructor({ coda, root, executorId, sources, offered, environment, launch = launchWorker, control = controlWorker, report = console.error }) {
    Object.assign(this, { coda, root, executorId, sources, offered, environment, launch, control, report });
    this.journal = new Journal(root); this.objects = new Map(); this.busy = new Map(); this.stopped = false;
  }
  async observe(event) {
    if (event.type === 'DELETED') this.objects.delete(event.id); else this.objects.set(event.id, event.object);
    // Return after reconciling, not after the command. A following cancel is never stuck behind a long script.
    await this.reconcile(event.id);
  }
  async recoverLeases() {
    for (const lease of await this.coda.resources.list()) {
      // A crash between acquire and durable claim cannot have launched a worker. Other leases are never guessed away.
      const match = /^execution:([a-f0-9]{64})$/.exec(lease.requestId);
      if (match && !this.journal.get(match[1])) await this.coda.resources.release(lease.lease);
    }
  }
  reconcile(id) {
    const before = this.busy.get(id) ?? Promise.resolve();
    const next = before.catch(() => {}).then(() => this.advance(id)); this.busy.set(id, next);
    return next.finally(() => { if (this.busy.get(id) === next) this.busy.delete(id); });
  }
  async tick() {
    const ids = new Set([...this.objects.keys(), ...this.journal.list().map(r => r.id)]);
    await Promise.all([...ids].map(id => this.reconcile(id).catch(error => this.report('[host execution]', error.message))));
  }
  matches(object) { return object?.spec.executor?.kind === 'executor' && object.spec.executor.id === this.executorId && object.spec.assignmentId; }
  async reply(object, status) {
    const current = this.objects.get(object.id);
    if (!current || current.instance !== object.instance || taskFingerprint(current.spec) !== taskFingerprint(object.spec)) return;
    if (canonical(current.status) === canonical(status)) return;
    // The result is reconciled against the same immutable assignment. A different task never inherits an old answer.
    await this.coda.protocols.setStatus('execution', current.id, status, current.revision);
  }
  async advance(id) {
    if (this.stopped) return;
    const object = this.objects.get(id), records = this.journal.list().filter(r => r.id === id);
    let hasCurrent = false;
    for (const record of records) {
      const current = object && record.key === identity(object) && record.fingerprint === taskFingerprint(object.spec);
      if (current) hasCurrent = true;
      if ((!current || object.spec.cancel) && record.phase !== 'finished') await this.control(record, 'cancel');
      if (record.phase === 'finished' && !record.released) {
        if (record.admission) await this.coda.resources.release(record.admission.lease);
        record.released = true; this.journal.save(record);
      }
      {
        const run = { kind: 'hostExecution', id: record.key };
        const status = { phase: record.phase === 'finished' ? 'finished' : record.phase === 'claimed' ? 'queued'
          : record.phase === 'running' || record.phase === 'cleanup' ? 'running' : 'preparing', assignmentId: record.assignmentId,
          ...(record.startedAt ? { startedAt: record.startedAt } : {}), executionRun: run,
          ...(record.admission ? { admission: { lease: record.admission.lease, slots: [record.admission.slot] } } : {}),
          ...(record.result ?? {}), logs: [{ ref: run }] };
        if (record.phase !== 'finished' && !await this.control(record)) {
          status.reason = { code: 'result_unknown', message: '执行结果未明，保留绑定与名额；恢复原执行记录，不自动重跑' };
        }
        await this.publishRun(record, status);
        if (current) await this.reply(object, status);
      }
    }
    // Old bindings still need cancellation and lease release even when the current binding already exists.
    if (hasCurrent || !this.matches(object)) return;
    // An already-terminal answer without a journal is not permission to rerun.
    if (object.status.assignmentId === object.spec.assignmentId && object.status.phase === 'finished') return;
    const { spec } = object, offered = this.offered();
    const refuse = async (code, message, outcome = 'rejected') => this.reply(object, {
      phase: 'finished', assignmentId: spec.assignmentId, outcome, exitCode: null, finishedAt: now(), reason: { code, message },
    });
    if (spec.cancel) return refuse('cancelled', '开始前已取消', 'cancelled');
    if (!offered?.status.accepting) return refuse('not_accepting', '运行器已停止接活');
    if (Object.keys(spec.resources).length !== 1 || spec.resources.slots !== 1 || (spec.exclusiveResources ?? []).some(k => k !== 'slots')) return refuse('unsupported_resources', '只支持 slots: 1 或 slots 独占');
    const labels = new Set([...offered.spec.labels, ...offered.status.detectedLabels]);
    if (!spec.requirements.labels.every(label => labels.has(label))) return refuse('labels_unavailable', '运行器不满足所需能力');
    let source;
    try { source = await this.sources.resolve(spec.source); }
    catch (error) { return this.reply(object, { phase: 'queued', assignmentId: spec.assignmentId,
      reason: { code: 'source_unavailable', message: error.message.slice(0, 4096) } }); }
    const key = identity(object), env = await this.environment();
    // Any asynchronous source lookup may race cancellation, deletion or re-binding. Re-read before admission.
    const current = this.objects.get(id);
    if (!current || current.instance !== object.instance || taskFingerprint(current.spec) !== taskFingerprint(spec) || current.spec.cancel) return;
    if (!this.offered()?.status.accepting) return refuse('not_accepting', '运行器已停止接活');
    const admission = await this.coda.resources.acquire({ requestId: `execution:${key}`, group: 'host', resources: { slots: 1 }, exclusive: spec.exclusiveResources?.includes('slots') ?? false });
    const latest = this.objects.get(id);
    if (!latest || latest.instance !== object.instance || taskFingerprint(latest.spec) !== taskFingerprint(spec) || latest.spec.cancel) {
      if (admission.admitted) await this.coda.resources.release(admission.lease);
      return;
    }
    if (!this.offered()?.status.accepting) {
      if (admission.admitted) await this.coda.resources.release(admission.lease);
      return refuse('not_accepting', '运行器已停止接活');
    }
    if (!admission.admitted) return this.reply(object, { phase: 'queued', assignmentId: spec.assignmentId, reason: { code: 'capacity', message: '等待本机名额' } });
    const record = { key, id, instance: object.instance, assignmentId: spec.assignmentId, fingerprint: taskFingerprint(spec), admission, phase: 'claimed' };
    this.journal.save(record);
    try { await this.launch({ root: this.root, key, source, spec, env }, this.journal.directory(key)); }
    catch (error) {
      // A spawn error is definite non-execution. No automatic retry in this assignment.
      record.phase = 'finished'; record.result = { outcome: 'rejected', exitCode: null, finishedAt: now(), reason: { code: 'launch_failed', message: error.message } }; this.journal.save(record);
    }
  }
  async publishRun(record, status) {
    let held = this.runs?.get(record.key);
    if (!held) {
      held = await this.coda.protocols.put({ kind: 'hostExecution', id: record.key,
        spec: { execution: { kind: 'execution', id: record.id }, assignmentId: record.assignmentId }, status });
      await this.coda.protocols.publish('hostExecution', record.key);
    } else if (canonical(held.status) !== canonical(status)) await this.coda.protocols.setStatus('hostExecution', held.id, status, held.revision);
  }
  async stop() { this.stopped = true; await Promise.allSettled(this.busy.values()); }
}
