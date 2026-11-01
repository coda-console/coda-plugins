import { randomUUID } from 'node:crypto';
import { budget, choose, disposition, inOrder } from './policy.mjs';
import { SchedulingState } from './state.mjs';

export class Scheduler {
  constructor(coda, { state = new SchedulingState(coda.plugin.state),
    assignment = randomUUID, now = () => new Date().toISOString(), report = console.error,
    interval = setInterval } = {}) {
    Object.assign(this, { coda, state, assignment, now, report, interval });
    this.executions = new Map(); this.executors = new Map(); this.local = new Set(); this.subscriptions = [];
    this.ready = false; this.closed = false; this.dirty = false; this.running = null;
  }
  async start() {
    // Startup modules activate concurrently; extensionDependencies orders installation, not provider registration.
    // A first install may see host's kinds a moment later. Keep the module alive and retry the subscription.
    this.timer = this.interval(() => void this.connect().then(() => this.wake()), 5000); this.timer?.unref?.();
    await this.connect();
  }
  connect() {
    if (this.closed || this.ready) return Promise.resolve();
    if (!this.connecting) this.connecting = this.subscribe().finally(() => { this.connecting = null; });
    return this.connecting;
  }
  async subscribe() {
    const { protocols } = this.coda;
    try {
      this.subscriptions.push(await protocols.observe('executor', event => {
        if (event.type === 'DELETED') this.local.delete(event.id); else this.local.add(event.id);
        void this.wake();
      }, 'local'));
      this.subscriptions.push(await protocols.observe('executor', event => {
        if (event.type === 'DELETED') this.executors.delete(event.id); else this.executors.set(event.id, event.object);
        void this.wake();
      }, 'available'));
      this.subscriptions.push(await protocols.control('execution', event => {
        if (event.type === 'DELETED') this.executions.delete(event.id);
        else this.executions.set(event.id, event.object);
        // Do not await a global pass here: per-ID control must receive the cancellation/CAS race while IO is pending.
        void this.wake();
      }, 'local'));
      // All initial ADDED events are delivered before observe/control resolves. Only then make choices.
      this.ready = !this.closed;
      await this.wake();
    } catch (error) {
      for (const subscription of this.subscriptions.splice(0)) await subscription.dispose();
      this.executions.clear(); this.executors.clear(); this.local.clear(); this.ready = false;
      this.report('[scheduler observe]', error);
    }
  }
  wake() {
    if (!this.ready || this.closed) return Promise.resolve();
    this.dirty = true;
    if (!this.running) this.running = Promise.resolve().then(async () => {
      while (this.dirty && !this.closed) {
        this.dirty = false;
        try { await this.reconcile(); } catch (error) { this.report('[scheduler]', error); }
      }
    }).finally(() => { this.running = null; });
    return this.running;
  }
  async reconcile() {
    // Cancellation and proven rejection do not need an ordering key and must remain responsive during an upgrade.
    let releaseFailed = false;
    for (const object of this.executions.values()) {
      if (this.closed) return;
      const action = disposition(object);
      if (!['cancel', 'release'].includes(action)) continue;
      try { await this.advance(object); }
      catch (error) {
        this.report(`[scheduler execution ${object.id}]`, error);
        if (action === 'release') releaseFailed = true;
      }
    }
    // A failed release must not hide an older request from FIFO. Finish cancellations, then await observation/retry.
    if (releaseFailed) return;
    const entries = [...this.executions.values()].filter(object => disposition(object) === 'schedule');
    // Sequence is holder-owned, immutable and comparable only within this local collection.
    const missingOrder = entries.some(object => !Number.isSafeInteger(object.creationSequence) || object.creationSequence < 1);
    for (const object of inOrder(entries)) {
      if (this.closed) return;
      // Re-evaluate a changed older request before a younger request can take its candidate.
      if (this.executions.get(object.id)?.revision !== object.revision) { this.dirty = true; break; }
      try {
        if (missingOrder) await this.queue(object, { code: 'creation_order_unavailable', message: '等待持有方提供完整的创建序号，保持 FIFO 排队' });
        else await this.advance(object);
      }
      catch (error) { this.report(`[scheduler execution ${object.id}]`, error); break; }
      // Any observation during IO can change eligibility, estimated capacity or the queue itself.
      // Reuse wake's pending pass to reconsider the earliest request, including after our own writes.
      if (this.dirty) break;
    }
    this.state.retain(new Set([...this.executions.values()].filter(o => disposition(o) !== 'done').map(o => o.instance)));
  }
  async advance(object) {
    const action = disposition(object), { protocols } = this.coda;
    if (action === 'observe' || action === 'done') return;
    if (action === 'release') {
      this.state.reject(object, this.executors.get(object.spec.executor.id));
      // The current executor's terminal rejection is the proof. Never edit its status while still bound.
      await this.setBinding(object, null, null);
      return;
    }
    if (action === 'cancel') {
      await protocols.setStatus('execution', object.id, { phase: 'finished', assignmentId: null,
        outcome: 'cancelled', finishedAt: this.now(), reason: { code: 'cancelled', message: '分配运行器前已取消' } }, object.revision);
      return;
    }
    const executors = [...this.executors.values()];
    const decision = choose(object.spec, executors, { local: this.local,
      remaining: budget(executors, [...this.executions.values()]), rejected: this.state.get(object)?.rejected ?? {} });
    if (decision.action === 'bind') {
      await this.setBinding(object, decision.executor, this.assignment());
    } else {
      await this.queue(object, decision.reason);
    }
  }
  async setBinding(object, executor, assignmentId) {
    // One CAS replaces both scalar fields; task, source, resources, cancellation and attempt remain intact.
    const updated = await this.coda.protocols.update('execution', object.id, { ...object.spec, executor, assignmentId }, object.revision);
    // Both binding and release affect this pass before their watch event arrives. Never overwrite a newer event.
    if (this.executions.get(object.id)?.revision === object.revision) this.executions.set(object.id, updated);
  }
  async queue(object, reason) {
    const status = { phase: 'queued', assignmentId: null, reason };
    if (JSON.stringify(object.status) !== JSON.stringify(status)) await this.coda.protocols.setStatus('execution', object.id, status, object.revision);
  }
  async stop() {
    this.closed = true; clearInterval(this.timer);
    await this.connecting;
    for (const subscription of this.subscriptions.splice(0)) await subscription.dispose();
    await this.running;
  }
}
