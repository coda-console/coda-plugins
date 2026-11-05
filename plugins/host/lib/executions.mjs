import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Journal, canonical, runKey } from './journal.mjs';
import { controlWorker } from './worker-control.mjs';

export const RUN = 'coda/run@1';
const entry = fileURLToPath(new URL('../scripts/execution-worker.mjs', import.meta.url));
const now = () => new Date().toISOString();
const TERMINAL = new Set(['completed', 'failed', 'canceled']);

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

const failure = (code, message, outcome = 'failed') => ({ outcome, exitCode: null, reason: { code, message } });
const cancelled = () => ({ outcome: 'cancelled', exitCode: null });

// The progress a run reports while it still goes; the result once it has ended.
export function runStatus(record) {
  if (record.phase !== 'finished') return { state: 'working',
    progress: record.reason?.message ?? { waiting: '等待本机名额', claimed: '等待启动', preparing: '准备中', running: '运行中', cleanup: '收尾中' }[record.phase] ?? '进行中' };
  const result = record.result;
  if (!result) return { state: 'failed', result: { exitCode: 1, output: '', summary: '', message: '执行没有结果' } };
  if (result.outcome === 'cancelled') return { state: 'canceled' };
  const body = { exitCode: result.exitCode ?? (result.outcome === 'succeeded' ? 0 : 1), output: result.outputTail ?? '', summary: result.summary ?? '',
    ...(result.outputs && Object.keys(result.outputs).length ? { outputs: result.outputs } : {}) };
  return result.outcome === 'succeeded' ? { state: 'completed', result: body }
    : { state: 'failed', result: { ...body, message: result.reason?.message ?? '执行失败' } };
}

export class Executions {
  constructor({ coda, root, sources, offered, environment, launch = launchWorker, control = controlWorker, report = console.error }) {
    Object.assign(this, { coda, root, sources, offered, environment, launch, control, report });
    this.journal = new Journal(root); this.busy = new Map(); this.stopped = false; this.runs = new Map();
  }
  // A `coda/executor@1` execute: the run is Coda's, this executor only answers on it.
  execute(run, input) {
    const key = runKey(run);
    if (this.journal.get(key)) return;
    this.supported(input);
    this.journal.save({ key, runId: run.id, phase: 'waiting', input });
    void this.reconcile(key).catch(error => this.report('[host execution]', error.message));
  }
  supported(input) {
    const resources = Object.keys(input.resources ?? {});
    if (resources.length && !(resources.length === 1 && resources[0] === 'slots' && input.resources.slots === 1))
      throw new Error('只支持 { slots: 1 } 或不占资源');
    if ((input.exclusiveResources ?? []).length && !(input.exclusiveResources.length === 1 && input.exclusiveResources[0] === 'slots' && resources.includes('slots')))
      throw new Error('只能独占 slots');
  }
  async cancel(id) {
    const record = this.journal.get(runKey({ kind: RUN, id }));
    if (!record || record.phase === 'finished') return;
    record.canceled = true; this.journal.save(record);
    if (record.control) await this.control(record, 'cancel');
    else if (record.phase === 'waiting' || record.phase === 'claimed') this.finish(record, cancelled());
    else void this.reconcile(record.key).catch(error => this.report('[host execution]', error.message));
  }
  async recoverLeases() {
    for (const lease of await this.coda.resources.list()) {
      // A crash between acquire and durable claim cannot have launched a worker. Other leases are never guessed away.
      const match = /^execution:([a-f0-9]{64})$/.exec(lease.requestId);
      if (match && !this.journal.get(match[1])) await this.coda.resources.release(lease.lease);
    }
  }
  reconcile(key) {
    const before = this.busy.get(key) ?? Promise.resolve();
    const next = before.catch(() => {}).then(() => this.advance(key)); this.busy.set(key, next);
    return next.finally(() => { if (this.busy.get(key) === next) this.busy.delete(key); });
  }
  async tick() {
    await Promise.all(this.journal.list().map(record => this.reconcile(record.key).catch(error => this.report('[host execution]', error.message))));
  }
  finish(record, result) {
    const current = this.journal.get(record.key) ?? record;
    current.phase = 'finished'; current.result = { ...result, finishedAt: now() }; current.reason = null;
    this.journal.save(current);
    return this.publish(current);
  }
  async advance(key) {
    if (this.stopped) return;
    let record = this.journal.get(key);
    if (!record) return;
    if (record.phase === 'waiting') {
      if (record.canceled) return this.finish(record, cancelled());
      const offered = this.offered();
      if (!offered?.status.accepting) return this.finish(record, failure('not_accepting', '运行器已停止接活', 'rejected'));
      const labels = new Set([...offered.spec.labels, ...offered.status.detectedLabels]);
      if (!record.input.requirements.labels.every(label => labels.has(label)))
        return this.finish(record, failure('labels_unavailable', '运行器不满足所需能力', 'rejected'));
      let source;
      try { source = await this.sources.resolve(record.input.source); }
      catch (error) { return this.finish(record, failure('source_unavailable', error.message)); }
      const env = await this.environment();
      record = this.journal.get(key);
      if (!record || record.canceled) return record ? this.finish(record, cancelled()) : undefined;
      const slots = record.input.resources?.slots === 1;
      let admission = null;
      if (slots) {
        admission = await this.coda.resources.acquire({ requestId: `execution:${key}`, group: 'host', resources: { slots: 1 },
          exclusive: (record.input.exclusiveResources ?? []).includes('slots') });
        record = this.journal.get(key);
        if (!record || record.canceled) {
          if (admission.admitted) await this.coda.resources.release(admission.lease);
          return record ? this.finish(record, cancelled()) : undefined;
        }
        if (!admission.admitted) {
          record.reason = { code: 'capacity', message: '等待本机名额' }; this.journal.save(record);
          return this.publish(record);
        }
      }
      record.phase = 'claimed'; record.admission = admission; record.startedAt = now(); record.reason = null;
      this.journal.save(record);
      // A slot-less task still gets its own workspace directory without sharing another attempt's cache.
      const slot = admission?.slot ?? (Number.parseInt(key.slice(0, 6), 16) || 0);
      try { await this.launch({ root: this.root, key, source, spec: record.input, env, slot }, this.journal.directory(key)); }
      catch (error) {
        record = this.journal.get(key);
        return record ? this.finish(record, failure('launch_failed', error.message)) : undefined;
      }
      return this.publish(this.journal.get(key));
    }
    if (record.canceled && record.control && record.phase !== 'finished') await this.control(record, 'cancel');
    if (record.canceled && record.phase === 'claimed' && !record.control) return this.finish(record, cancelled());
    if (record.phase !== 'finished' && record.control && !(await this.control(record))) {
      record.reason = { code: 'result_unknown', message: '执行结果未明，保留名额；恢复原执行记录，不自动重跑' };
      this.journal.save(record);
    }
    if (record.phase === 'finished' && !record.released && record.admission) {
      await this.coda.resources.release(record.admission.lease);
      record.released = true; this.journal.save(record);
    }
    await this.publish(this.journal.get(key));
  }
  // Only this executor writes its run; a terminal status is never written again.
  async publish(record) {
    if (!record) return;
    const status = runStatus(record), serialized = canonical(status);
    if (record.reportedStatus === serialized && (record.phase !== 'finished' || record.reported)) return;
    const held = this.runs.get(record.runId);
    if (!held) return;
    try {
      const next = await this.coda.protocols.setStatus(RUN, held.id, status, held.revision);
      this.runs.set(record.runId, next ?? { ...held, status });
      record.reportedStatus = serialized;
      if (TERMINAL.has(status.state)) record.reported = true;
      this.journal.save(record);
    } catch (error) {
      // Another writer may have already accepted the terminal answer (for example just before this process restarted).
      if (TERMINAL.has(status.state) && /终态|已结束/.test(error.message)) {
        record.reportedStatus = serialized; record.reported = true; this.journal.save(record); return;
      }
      throw error;
    }
  }
  async stop() { this.stopped = true; await Promise.allSettled(this.busy.values()); }
}
