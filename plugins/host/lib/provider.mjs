import { createHash } from 'node:crypto';
import { capacityStatus, probe } from './capabilities.mjs';
import { runFinished } from './simulator-status.mjs';

export const EXECUTOR = 'coda/executor@1';
// The executor record's key: the host derives its ID from it.
const KEY = 'host';

const canonical = value => JSON.stringify(value, (_, v) => v && !Array.isArray(v) && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);

// Publishes this machine's executor record and its capacity. It takes no execute calls: commands run through run-held.
export class HostProvider {
  constructor(coda, { discover = probe, interval = setInterval } = {}) {
    Object.assign(this, { coda, discover, interval });
    this.subscriptions = []; this.closed = false;
  }
  async start() {
    this.discovered = await this.discover();
    this.subscriptions.push(await this.coda.watch('concurrency-groups', event => {
      if (event.id === 'host') { this.group = event.type === 'DELETED' ? null : event.object; void this.refresh().catch(console.error); }
    }));
    await this.refresh();
    this.runFinished = await this.coda.handle('self', 'run-finished', async ({ run } = {}) => ({ finished: await runFinished(this.coda, run) }));
    this.probes = this.interval(() => {
      void this.discover().then(discovered => { this.discovered = discovered; return this.refresh(); }).catch(console.error);
    }, 60_000); this.probes?.unref?.();
  }
  // The record is written whole, the spec and the status together, only when its content differs from what was last sent
  // (or the status is a minute old): this plugin does not watch its own record, so what it writes sets nothing off.
  // What was sent is taken so before the write is done, so that a refresh while it is under way compares with it, not with an
  // older one (A, then B under way, then A again must write A); a write that fails is cleared, so it is made again.
  // `last` is the record as last sent, kept even when that write failed: `stop` writes it over as no longer accepting.
  // The first write that is done gives the whole of this kind (`replace`), so that the record 2.4.0 left under the ID `host`,
  // without a key, goes; the later ones only put.
  async refresh() {
    const settings = JSON.parse((await this.coda.environment()).CODA_PLUGIN_SETTINGS ?? '{}');
    if (this.closed) return;
    // The executor schema still requires enabled and labels.
    const spec = { enabled: true, capacity: { slots: settings['host.capacity'] ?? 1 }, labels: [], title: '本机运行器' };
    const facts = capacityStatus(spec, this.group, this.discovered), { observedAt, observedRevision: _, ...before } = this.sent?.status ?? {};
    if (canonical(this.sent?.spec) === canonical(spec) && canonical(before) === canonical(facts) && observedAt && Date.now() - Date.parse(observedAt) < 55_000) return;
    // A status that is not empty must carry `observedRevision` (the executor protocol's `status.anyOf`, though `required` is empty); nothing in Coda reads it, so it is only the content of the spec, as a digest.
    const observedRevision = createHash('sha256').update(canonical(spec)).digest('hex');
    const sent = this.sent = this.last = { spec, status: { ...facts, observedAt: new Date().toISOString(), observedRevision } };
    // `stop` waits for the last one under way, to write over it.
    const writing = this.writing = this.replaced ? this.coda.put({ kind: EXECUTOR, key: KEY }, sent) : this.coda.replace(EXECUTOR, [{ key: KEY, ...sent }]);
    try { await writing; } catch (error) { if (this.sent === sent) this.sent = undefined; throw error; }
    this.replaced = true;
  }
  async stop() {
    this.closed = true; clearInterval(this.probes);
    await this.runFinished?.dispose();
    for (const subscription of this.subscriptions) await subscription.dispose();
    await this.writing?.catch(() => {});
    if (this.last) await this.coda.put({ kind: EXECUTOR, key: KEY },
      { spec: this.last.spec, status: { ...this.last.status, accepting: false, reason: { code: 'stopped', message: '运行器插件已停止' } } });
  }
}
