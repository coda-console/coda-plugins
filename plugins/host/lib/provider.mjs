import { createHash } from 'node:crypto';
import { capacityStatus, probe } from './capabilities.mjs';
import { serveSimulatorStatus } from './simulator-status.mjs';

export const EXECUTOR = 'coda/executor@1';

const canonical = value => JSON.stringify(value, (_, v) => v && !Array.isArray(v) && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);

// Publishes this machine's executor record and its capacity. It takes no execute calls: commands run through run-held.
export class HostProvider {
  constructor(coda, { discover = probe, interval = setInterval } = {}) {
    Object.assign(this, { coda, discover, interval });
    this.executorId = 'host'; this.subscriptions = []; this.closed = false;
  }
  async start() {
    this.discovered = await this.discover();
    this.subscriptions.push(await this.coda.watch('concurrency-groups', event => {
      if (event.id === 'host') { this.group = event.type === 'DELETED' ? null : event.object; void this.refresh().catch(console.error); }
    }));
    await this.refresh();
    this.simulatorStatus = await serveSimulatorStatus(this.coda);
    this.probes = this.interval(() => {
      void this.discover().then(discovered => { this.discovered = discovered; return this.refresh(); }).catch(console.error);
    }, 60_000); this.probes?.unref?.();
  }
  // The record is written whole, the spec and the status together, only when its content differs from what was written last
  // (or the status is a minute old): this plugin does not watch its own record, so what it writes sets nothing off.
  async refresh() {
    const settings = JSON.parse((await this.coda.environment()).CODA_PLUGIN_SETTINGS ?? '{}');
    if (this.closed) return;
    // The executor schema still requires enabled and labels.
    const spec = { enabled: true, capacity: { slots: settings['host.capacity'] ?? 1 }, labels: [], title: '本机运行器' };
    const facts = capacityStatus(spec, this.group, this.discovered), { observedAt, observedRevision: _, ...before } = this.written?.status ?? {};
    if (canonical(this.written?.spec) === canonical(spec) && canonical(before) === canonical(facts) && observedAt && Date.now() - Date.parse(observedAt) < 55_000) return;
    // A status that is not empty must carry `observedRevision` (the executor protocol's `status.anyOf`, though `required` is empty); nothing in Coda reads it, so it is only the content of the spec, as a digest.
    const observedRevision = createHash('sha256').update(canonical(spec)).digest('hex');
    const written = { spec, status: { ...facts, observedAt: new Date().toISOString(), observedRevision } };
    // Taken as written only once the write is done; `stop` waits for the last one under way, to write over it.
    const writing = this.writing = this.coda.put({ kind: EXECUTOR, id: this.executorId }, written);
    await writing;
    this.written = written;
  }
  async stop() {
    this.closed = true; clearInterval(this.probes);
    await this.simulatorStatus?.dispose();
    for (const subscription of this.subscriptions) await subscription.dispose();
    await this.writing?.catch(() => {});
    if (this.written) await this.coda.put({ kind: EXECUTOR, id: this.executorId },
      { spec: this.written.spec, status: { ...this.written.status, accepting: false, reason: { code: 'stopped', message: '运行器插件已停止' } } });
  }
}
