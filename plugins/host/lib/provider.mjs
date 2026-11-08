import { capacityStatus, probe } from './capabilities.mjs';
import { canonical, runKey } from './journal.mjs';
import { Sources } from './source.mjs';
import { Executions, RUN } from './executions.mjs';
import { serveSimulatorStatus } from './simulator-status.mjs';

export const EXECUTOR = 'coda/executor@1';

export class HostProvider {
  constructor(coda, { discover = probe, executions = options => new Executions(options), interval = setInterval } = {}) {
    Object.assign(this, { coda, discover, executions, interval });
    this.executorId = 'host'; this.runs = new Map(); this.subscriptions = [];
    this.queue = Promise.resolve(); this.closed = false;
  }
  async start() {
    if (!this.coda.resources?.acquire || !this.coda.protocols.resolve) throw new Error('host 需要 Coda 的引用解析与本机账本准入接口');
    this.discovered = await this.discover();
    this.sources = new Sources(this.coda); await this.sources.start();
    this.engine = this.executions({ coda: this.coda, root: this.coda.plugin.state,
      sources: this.sources, offered: () => this.offered, environment: () => this.coda.environment() });
    this.engine.runs = this.runs;
    await this.engine.recoverLeases();
    this.subscriptions.push(await this.coda.watch('concurrency-groups', event => {
      if (event.id === 'host') { this.group = event.type === 'DELETED' ? null : event.object; void this.refresh().catch(console.error); }
    }));
    await this.refresh();
    await this.coda.protocols.publish(EXECUTOR, this.executorId);
    // Recovered runs are read only after the executor knows its own capacity and acceptance.
    this.subscriptions.push(await this.coda.protocols.observe(RUN, event => {
      if (event.type === 'DELETED') this.runs.delete(event.id);
      else { this.runs.set(event.id, event.object); void this.engine.reconcile(runKey(event.object)).catch(console.error); }
    }, 'local'));
    this.subscriptions.push(await this.coda.protocols.handle(EXECUTOR, 'execute', (input, { run }) => this.engine.execute(run, input)));
    this.subscriptions.push(await this.coda.protocols.handle(RUN, 'cancel', async (_input, { record }) => { await this.engine.cancel(record.id); return {}; }));
    this.simulatorStatus = await serveSimulatorStatus(this.coda);
    // Recovery follows the durable worker; this timer never grants a slot or starts a second attempt.
    this.follow = this.interval(() => void this.engine.tick().catch(console.error), 1000); this.follow?.unref?.();
    this.probes = this.interval(() => {
      void this.discover().then(discovered => { this.discovered = discovered; return this.refresh(); }).catch(console.error);
    }, 60_000); this.probes?.unref?.();
    await this.engine.tick();
  }
  refresh() {
    const next = this.queue.catch(() => {}).then(async () => {
      if (this.closed) return;
      const settings = JSON.parse((await this.coda.environment()).CODA_PLUGIN_SETTINGS ?? '{}');
      const spec = { enabled: settings['host.enabled'] !== false,
        capacity: { slots: settings['host.capacity'] ?? 1 }, labels: [...new Set((settings['host.labels'] ?? '').split(',').map(s => s.trim()).filter(Boolean))], title: '本机运行器' };
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
    this.closed = true; clearInterval(this.follow); clearInterval(this.probes);
    await this.simulatorStatus?.dispose();
    for (const subscription of this.subscriptions) await subscription.dispose();
    await this.engine?.stop(); await this.sources?.stop(); await this.queue.catch(() => {});
    // Durable workers keep their ledger leases while the module is down. A restarted provider observes their results.
    if (this.offered) this.offered = await this.coda.protocols.setStatus(EXECUTOR, this.offered.id,
      { ...this.offered.status, accepting: false, reason: { code: 'stopped', message: '运行器插件已停止' } }, this.offered.revision);
  }
}
