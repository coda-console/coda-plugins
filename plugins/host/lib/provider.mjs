import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { capacityStatus, probe } from './capabilities.mjs';
import { serveSimulatorStatus } from './simulator-status.mjs';

export const EXECUTOR = 'coda/executor@1';

const canonical = value => JSON.stringify(value, (_, v) => v && !Array.isArray(v) && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);

// The executor record's ID: made at the first start and kept in the plugin's state directory, as android keeps its entity-id.
export function executorId(state, generate = randomUUID) {
  mkdirSync(state, { recursive: true });
  const file = join(state, 'executor-id');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const id = generate();
  writeFileSync(file, id);
  return id;
}

// Publishes this machine's executor record and its capacity. It takes no execute calls: commands run through run-held.
export class HostProvider {
  constructor(coda, { discover = probe, interval = setInterval } = {}) {
    Object.assign(this, { coda, discover, interval });
    this.executorId = executorId(coda.plugin.state); this.subscriptions = []; this.closed = false;
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
  // The record is written whole, the spec and the status together, only when its content differs from what was last sent
  // (or the status is a minute old): this plugin does not watch its own record, so what it writes sets nothing off.
  // What was sent is taken so before the write is done, so that a refresh while it is under way compares with it, not with an
  // older one (A, then B under way, then A again must write A); a write that fails is cleared, so it is made again.
  // `last` is the record as last sent, kept even when that write failed: `stop` writes it over as no longer accepting.
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
    const writing = this.writing = this.coda.put({ kind: EXECUTOR, id: this.executorId }, sent);
    try { await writing; } catch (error) { if (this.sent === sent) this.sent = undefined; throw error; }
  }
  async stop() {
    this.closed = true; clearInterval(this.probes);
    await this.simulatorStatus?.dispose();
    for (const subscription of this.subscriptions) await subscription.dispose();
    await this.writing?.catch(() => {});
    if (this.last) await this.coda.put({ kind: EXECUTOR, id: this.executorId },
      { spec: this.last.spec, status: { ...this.last.status, accepting: false, reason: { code: 'stopped', message: '运行器插件已停止' } } });
  }
}
