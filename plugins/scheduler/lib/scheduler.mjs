import { randomUUID } from 'node:crypto';
import { budget, choose, disposition, inOrder } from './policy.mjs';
import { SchedulingState } from './state.mjs';

export class Scheduler {
  // The envelope reader will be connected after Coda's creation metadata contract is merged and synced.
  // Until then fail closed; observation order and IDs cannot substitute for creation order.
  constructor(coda, { state = new SchedulingState(coda.plugin.state), order = () => null,
    assignment = randomUUID, now = () => new Date().toISOString(), report = console.error,
    interval = setInterval } = {}) {
    Object.assign(this, { coda, state, order, assignment, now, report, interval });
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
    for (const object of this.executions.values()) {
      if (this.closed) return;
      if (!['cancel', 'release'].includes(disposition(object))) continue;
      try { await this.advance(object); }
      catch (error) { this.report(`[scheduler execution ${object.id}]`, error); }
    }
    const entries = [...this.executions.values()].filter(object => disposition(object) === 'schedule')
      .map(object => ({ object, order: this.order(object) }));
    const missingOrder = entries.some(entry => !Number.isSafeInteger(entry.order) || entry.order < 1);
    for (const { object } of inOrder(entries)) {
      if (this.closed) return;
      if (this.executions.get(object.id)?.revision !== object.revision) continue;
      try {
        if (missingOrder) await this.queue(object, { code: 'creation_order_unavailable', message: '等待持有方提供完整的创建序号，保持 FIFO 排队' });
        else await this.advance(object);
      }
      catch (error) { this.report(`[scheduler execution ${object.id}]`, error); }
    }
    this.state.retain(new Set([...this.executions.values()].filter(o => disposition(o) !== 'done').map(o => o.instance)));
  }
  async advance(object) {
    const action = disposition(object), { protocols } = this.coda;
    if (action === 'observe' || action === 'done') return;
    if (action === 'release') {
      this.state.reject(object, this.executors.get(object.spec.executor.id));
      // The current executor's terminal rejection is the proof. Never edit its status while still bound.
      await protocols.update('execution', object.id, { ...object.spec, executor: null, assignmentId: null }, object.revision);
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
      // One CAS replaces both scalar fields; task, source, resources, cancellation and attempt remain intact.
      const updated = await protocols.update('execution', object.id, { ...object.spec,
        executor: decision.executor, assignmentId: this.assignment() }, object.revision);
      // Account for the successful binding even if the watch notification has not arrived yet. Never overwrite a newer event.
      if (this.executions.get(object.id)?.revision === object.revision) this.executions.set(object.id, updated);
    } else {
      await this.queue(object, decision.reason);
    }
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
