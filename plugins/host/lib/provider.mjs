import { capacityStatus, probe } from './capabilities.mjs';
import { serveSimulatorStatus } from './simulator-status.mjs';

export const EXECUTOR = 'coda/executor@1';

const canonical = value => JSON.stringify(value, (_, v) => v && !Array.isArray(v) && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);

// Publishes this machine's executor record and its capacity. It takes no execute calls: commands run through run-held.
export class HostProvider {
  constructor(coda, { discover = probe, interval = setInterval } = {}) {
    Object.assign(this, { coda, discover, interval });
    this.executorId = 'host'; this.subscriptions = [];
    this.queue = Promise.resolve(); this.closed = false;
  }
  async start() {
    this.discovered = await this.discover();
    // The record a previous run left is written over at its revision, so read it before the first refresh.
    (await this.coda.protocols.observe(EXECUTOR, event => { if (event.id === this.executorId) this.offered = event.object; }, 'local')).dispose();
    this.subscriptions.push(await this.coda.watch('concurrency-groups', event => {
      if (event.id === 'host') { this.group = event.type === 'DELETED' ? null : event.object; void this.refresh().catch(console.error); }
    }));
    await this.refresh();
    await this.coda.protocols.publish(EXECUTOR, this.executorId);
    this.simulatorStatus = await serveSimulatorStatus(this.coda);
    this.probes = this.interval(() => {
      void this.discover().then(discovered => { this.discovered = discovered; return this.refresh(); }).catch(console.error);
    }, 60_000); this.probes?.unref?.();
  }
  refresh() {
    const next = this.queue.catch(() => {}).then(async () => {
      if (this.closed) return;
      const settings = JSON.parse((await this.coda.environment()).CODA_PLUGIN_SETTINGS ?? '{}');
      // The executor schema still requires enabled and labels.
      const spec = { enabled: true, capacity: { slots: settings['host.capacity'] ?? 1 }, labels: [], title: '本机运行器' };
      let object = this.offered;
      if (!object || canonical(object.spec) !== canonical(spec)) object = await this.coda.protocols.put({ kind: EXECUTOR, id: this.executorId, spec,
        ...(object ? { revision: object.revision } : { status: {} }) });
      this.offered = object;
      const facts = capacityStatus(spec, this.group, this.discovered), old = object.status;
      const { observedAt, observedRevision, ...before } = old;
      // Don't chase our own status revisions or create an endless watch-update loop.
      if (canonical(before) !== canonical(facts) || !observedAt || Date.now() - Date.parse(observedAt) >= 55_000) {
        object = await this.coda.protocols.setStatus(EXECUTOR, object.id, { ...facts, observedAt: new Date().toISOString(), observedRevision: object.revision }, object.revision);
        this.offered = object;
      }
    }); this.queue = next; return next;
  }
  async stop() {
    this.closed = true; clearInterval(this.probes);
    await this.simulatorStatus?.dispose();
    for (const subscription of this.subscriptions) await subscription.dispose();
    await this.queue.catch(() => {});
    if (this.offered) this.offered = await this.coda.protocols.setStatus(EXECUTOR, this.offered.id,
      { ...this.offered.status, accepting: false, reason: { code: 'stopped', message: '运行器插件已停止' } }, this.offered.revision);
  }
}
