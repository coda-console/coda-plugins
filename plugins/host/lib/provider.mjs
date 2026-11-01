import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { capacityStatus, probe } from './capabilities.mjs';
import { canonical } from './journal.mjs';
import { Sources } from './source.mjs';
import { Executions } from './executions.mjs';

const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
async function body(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 2 ** 20) throw new Error('请求超过 1 MiB'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}

export class HostProvider {
  constructor(coda, { definitions, discover = probe, executions = options => new Executions(options), interval = setInterval } = {}) {
    Object.assign(this, { coda, definitions, discover, executions, interval });
    this.executorId = 'host'; this.local = new Map(); this.runs = new Map(); this.subscriptions = [];
    this.queue = Promise.resolve(); this.closed = false;
  }
  async start() {
    if (!this.coda.resources?.acquire || !this.coda.protocols.resolve) throw new Error('host 需要 Coda 的引用解析与本机账本准入接口');
    const [executor, execution] = this.definitions;
    await this.coda.protocols.define(executor);
    await this.coda.protocols.define({ ...execution, controllers: ['scheduler'] });
    // A local durable receipt for the existing execution, with readable logs; not a second scheduler or workflow queue.
    await this.coda.protocols.define({ kind: 'hostExecution', spec: { type: 'object', properties: {
      execution: { type: 'object', properties: { kind: { const: 'execution' }, id: { type: 'string' } }, required: ['kind', 'id'], additionalProperties: false },
      assignmentId: { type: 'string' },
    }, required: ['execution', 'assignmentId'], additionalProperties: false }, status: execution.status });
    this.subscriptions.push(await this.coda.protocols.observe('executor', event => {
      if (event.id === this.executorId) this.offered = event.type === 'DELETED' ? null : event.object;
    }, 'local'));
    this.subscriptions.push(await this.coda.protocols.observe('hostExecution', event => {
      if (event.type === 'DELETED') this.runs.delete(event.id); else this.runs.set(event.id, event.object);
    }, 'local'));
    this.discovered = await this.discover();
    this.sources = new Sources(this.coda); await this.sources.start();
    this.engine = this.executions({ coda: this.coda, root: this.coda.plugin.state, executorId: this.executorId,
      sources: this.sources, offered: () => this.offered, environment: () => this.coda.environment() });
    this.engine.runs = this.runs;
    await this.engine.recoverLeases();
    this.subscriptions.push(await this.coda.watch('concurrency-groups', event => {
      if (event.id === 'host') { this.group = event.type === 'DELETED' ? null : event.object; void this.refresh().catch(console.error); }
    }));
    await this.refresh();
    await this.coda.protocols.publish('executor', this.executorId);
    this.subscriptions.push(await this.coda.protocols.control('execution', async event => {
      if (event.type === 'DELETED') this.local.delete(event.id);
      else { this.local.set(event.id, event.object); await this.coda.protocols.publish('execution', event.id, !!event.object.spec.executor); }
    }, 'local'));
    // Receive intent immediately while source/admission IO is pending. The engine's per-ID queue serializes work;
    // an outer controller queue would hide cancellation or re-binding until after the old request launches.
    this.subscriptions.push(await this.coda.protocols.observe('execution', event => {
      void this.engine.observe(event).catch(console.error);
    }, 'assigned'));
    this.service = await this.coda.services.register('execution', (req, res, caller) => this.serve(req, res, caller));
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
      const spec = { protocolVersion: 1, enabled: settings['host.enabled'] !== false,
        capacity: { slots: settings['host.capacity'] ?? 1 }, labels: [...new Set((settings['host.labels'] ?? '').split(',').map(s => s.trim()).filter(Boolean))], title: '本机运行器' };
      let object = this.offered;
      if (!object || canonical(object.spec) !== canonical(spec)) object = await this.coda.protocols.put({ kind: 'executor', id: this.executorId, spec,
        ...(object ? { revision: object.revision } : { status: {} }) });
      const facts = capacityStatus(spec, this.group, this.discovered), old = object.status;
      const { observedAt, observedRevision, ...before } = old;
      // Don't chase our own status revisions or create an endless watch-update loop.
      if (canonical(before) !== canonical(facts) || !observedAt || Date.now() - Date.parse(observedAt) >= 55_000) {
        await this.coda.protocols.setStatus('executor', object.id, { ...facts, observedAt: new Date().toISOString(), observedRevision: object.revision }, object.revision);
      }
    }); this.queue = next; return next;
  }
  async serve(req, res, caller) {
    try {
      const url = new URL(req.url, 'http://host'), log = /^\/runs\/([a-f0-9]{64})\/log$/.exec(url.pathname);
      if (req.method === 'GET' && log) {
        if (!this.runs.has(log[1])) return json(res, 404, { error: '执行记录不存在' });
        const offset = Number(url.searchParams.get('offset') ?? 0);
        if (!Number.isSafeInteger(offset) || offset < 0) return json(res, 400, { error: 'offset 无效' });
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        await pipeline(createReadStream(join(this.engine.journal.directory(log[1]), 'log'), { start: offset, end: offset + 65535 }), res);
        return;
      }
      const receipt = /^\/runs\/([a-f0-9]{64})$/.exec(url.pathname);
      if (req.method === 'GET' && receipt) return json(res, this.runs.has(receipt[1]) ? 200 : 404, this.runs.get(receipt[1]) ?? { error: '执行记录不存在' });
      if (caller?.local !== true) return json(res, 403, { error: '执行管理入口只接受本机调用' });
      const match = /^\/requests\/([a-zA-Z0-9_-]{1,100})(?:\/(cancel))?$/.exec(url.pathname);
      if (!match) return json(res, 404, { error: '未知执行路径' });
      const [, id, action] = match, object = this.local.get(id);
      if (req.method === 'GET' && !action) return json(res, object ? 200 : 404, object ?? { error: '请求不存在' });
      if (req.method !== 'POST') return json(res, 405, { error: '需要 GET 或 POST' });
      const data = await body(req);
      if (action === 'cancel') {
        if (!object) return json(res, 404, { error: '请求不存在' });
        await this.coda.protocols.update('execution', id, { ...object.spec, cancel: true }, data.revision);
      } else {
        if (object) return json(res, 409, { error: '一次尝试只能创建一次' });
        if (data.spec?.executor != null || data.spec?.assignmentId != null) return json(res, 400, { error: '绑定只能由 scheduler 写入' });
        await this.coda.protocols.put({ kind: 'execution', id, spec: data.spec,
          status: { phase: 'queued', assignmentId: null } });
      }
      return json(res, 200, { kind: 'execution', id });
    } catch (error) {
      if (res.headersSent) res.destroy(error); else json(res, error.status ?? 400, { error: error.message });
    }
  }
  async stop() {
    this.closed = true; clearInterval(this.follow); clearInterval(this.probes);
    for (const subscription of this.subscriptions) await subscription.dispose();
    await this.engine?.stop(); await this.sources?.stop(); await this.service?.dispose(); await this.queue.catch(() => {});
    // Durable workers keep their ledger leases while the module is down. A restarted provider observes their results.
    if (this.offered) await this.coda.protocols.setStatus('executor', this.offered.id,
      { ...this.offered.status, accepting: false, reason: { code: 'stopped', message: '运行器插件已停止' } }, this.offered.revision);
  }
}
