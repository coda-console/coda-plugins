import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { definitions, SOURCE, SNAPSHOT } from './definitions.mjs';
import { repository, git, createSnapshot, removeSnapshot, snapshotRef } from './git.mjs';
import { smartHTTP, readBody, reply } from './http.mjs';

const idOK = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const url = id => `/v1/plugins/git/services/repository/repos/${id}`;
const ended = run => run?.finishedAt != null || ['succeeded', 'failed', 'cancelled'].includes(run?.state);

export class GitProvider {
  constructor(coda) {
    this.coda = coda;
    this.sources = new Map(); this.snapshots = new Map(); this.runs = new Map(); this.runWatches = new Map();
    this.repositories = new Map(); this.subscriptions = []; this.records = {}; this.queue = Promise.resolve();
    this.active = false; this.stopped = false;
    this.file = join(coda.plugin.state, 'snapshots.json');
    this.http = smartHTTP({ lookup: id => this.lookup(id), environment: () => coda.environment() });
  }
  async start() {
    await mkdir(this.coda.plugin.state, { recursive: true });
    try { this.records = JSON.parse(await readFile(this.file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const definition of definitions) await this.coda.protocols.define(definition);
    for (const [kind, map] of [[SOURCE, this.sources], [SNAPSHOT, this.snapshots]]) {
      this.subscriptions.push(await this.coda.protocols.observe(kind, event => {
        if (event.type === 'DELETED') map.delete(event.id); else map.set(event.id, event.object);
        // Revoke HTTP access immediately, before the asynchronous controller catches up.
        if (kind === SOURCE) this.repositories.delete(event.id);
      }, 'local'));
      this.subscriptions.push(await this.coda.protocols.control(kind, () => this.schedule(), 'local'));
    }
    this.active = true;
    await this.schedule();
    this.service = await this.coda.services.register('repository', (req, res, caller) =>
      req.url.startsWith('/repos/') ? this.http(req, res, caller) : this.manage(req, res, caller));
  }
  schedule() {
    if (!this.active || this.stopped) return Promise.resolve();
    const next = this.queue.then(() => this.reconcile());
    this.queue = next.catch(error => console.error('[git snapshots]', error.message));
    return next;
  }
  async save() {
    await writeFile(`${this.file}.tmp`, `${JSON.stringify(this.records)}\n`, { mode: 0o600 });
    await rename(`${this.file}.tmp`, this.file);
  }
  async status(object, value) {
    // Always carry the observed version; do not relabel an old result with a newer revision.
    if (JSON.stringify(object.status) !== JSON.stringify(value))
      await this.coda.protocols.setStatus(object.kind, object.id, value, object.revision);
  }
  async followRuns() {
    const needed = new Set([...this.snapshots.values()].map(item => item.spec.run));
    for (const [id, watcher] of this.runWatches) if (!needed.has(id)) {
      await watcher.dispose(); this.runWatches.delete(id); this.runs.delete(id);
    }
    for (const id of needed) if (!this.runWatches.has(id)) {
      let watcher;
      try { watcher = await this.coda.watch('workflow-runs', event => {
        if (event.id !== id) return; // The filtered collection can also contain child runs.
        this.runs.set(id, event.type === 'DELETED' ? { state: 'cancelled' } : event.object);
        void this.schedule().catch(() => {});
      }, { run: id }); } catch (error) { this.runs.set(id, { error: error.message }); continue; }
      this.runWatches.set(id, watcher);
      if (!this.runs.has(id)) {
        // Confirm old runs that no longer appear in the default recent-runs list. A failed lookup is not completion.
        try { this.runs.set(id, await this.coda.api(`workflow-runs/${encodeURIComponent(id)}`)); }
        catch (error) { this.runs.set(id, { error: error.message }); }
      }
    }
  }
  async reconcile() {
    const env = await this.coda.environment();
    await this.followRuns();
    for (const source of this.sources.values()) {
      try {
        const repo = await repository(source.spec.path, env);
        if (this.sources.get(source.id)?.revision !== source.revision) continue;
        this.repositories.set(source.id, { ...repo, instance: source.instance, pathSpec: source.spec.path });
        await this.status(source, { ready: true, url: url(source.id) });
      } catch (error) {
        this.repositories.delete(source.id);
        await this.status(source, { ready: false, reason: error.message });
      }
    }
    const desired = new Map();
    for (const item of this.snapshots.values()) {
      const source = this.sources.get(item.spec.source), repo = this.repositories.get(item.spec.source);
      const token = hash([item.id, item.instance, item.spec, source?.instance, source?.spec]);
      if (repo && !ended(this.runs.get(item.spec.run))) desired.set(token, { item, repo });
    }
    // The journal precedes ref creation, so deleting objects while the host is down leaves recoverable cleanup work.
    for (const [token, record] of Object.entries(this.records)) if (!desired.has(token)) {
      try {
        await removeSnapshot({ path: record.gitDir }, record.ref, env);
        delete this.records[token]; await this.save();
      } catch (error) { console.error('[git snapshot cleanup]', record.id, error.message); }
    }
    for (const item of this.snapshots.values()) {
      const run = this.runs.get(item.spec.run);
      if (ended(run)) { await this.status(item, { ready: false, released: true, reason: '关联运行已结束' }); continue; }
      const source = this.sources.get(item.spec.source), repo = this.repositories.get(item.spec.source);
      if (!source || !repo) { await this.status(item, { ready: false, reason: '源未登记或不可用' }); continue; }
      if (!run || run.error) { await this.status(item, { ready: false, reason: `无法确认关联运行：${run?.error ?? item.spec.run}` }); continue; }
      const token = hash([item.id, item.instance, item.spec, source.instance, source.spec]);
      try {
        let record = this.records[token];
        if (!record) {
          record = { id: item.id, instance: item.instance, gitDir: repo.commonDir, ref: snapshotRef(token) };
          this.records[token] = record;
        }
        // Persist even after a prior save failed; an in-memory record alone must never authorize a new ref.
        await this.save();
        let commit = await git(repo.path, ['rev-parse', '--verify', record.ref], { env, accept: [0, 128] });
        if (!commit) commit = await createSnapshot(repo, item.spec, record.ref, env);
        record.commit = commit; await this.save();
        // If the source/run changed during Git IO, its event already queued a new reconciliation.
        if (this.sources.get(source.id)?.instance !== source.instance ||
            this.sources.get(source.id)?.spec.path !== source.spec.path || ended(this.runs.get(item.spec.run))) continue;
        await this.status(item, { ready: true, commit, ref: record.ref, url: url(source.id) });
      } catch (error) {
        // A stale status write must not become a failed result on a different revision either.
        if (this.snapshots.get(item.id)?.revision === item.revision)
          await this.status(item, { ready: false, reason: error.message });
      }
    }
  }
  async lookup(id) {
    const source = this.sources.get(id), repo = this.repositories.get(id);
    if (!source || !repo || source.instance !== repo.instance || source.spec.path !== repo.pathSpec) return null;
    // Do not follow a registered path after it is replaced by a symlink to another repository.
    const now = await repository(source.spec.path, await this.coda.environment());
    if (now.path !== repo.path || now.gitDir !== repo.gitDir) return null;
    const refs = new Set();
    for (const [token, record] of Object.entries(this.records)) {
      const item = this.snapshots.get(record.id);
      if (item?.instance === record.instance && item.spec.source === id &&
          token === hash([item.id, item.instance, item.spec, source.instance, source.spec]) &&
          !ended(this.runs.get(item.spec.run))) refs.add(record.ref);
    }
    return { ...repo, refs };
  }
  async manage(req, res, caller) {
    // Registration accepts filesystem paths and creates objects: only a local Coda API caller can do this.
    if (caller?.local !== true) return reply(res, 403, { error: '管理入口仅供本机调用' });
    const match = /^\/(sources|snapshots)\/([a-zA-Z0-9_-]{1,100})(?:\/(delete|publish))?$/.exec(req.url);
    if (!match) return reply(res, 404, { error: '未知管理路径' });
    const [, collection, id, action] = match, kind = collection === 'sources' ? SOURCE : SNAPSHOT;
    const map = collection === 'sources' ? this.sources : this.snapshots;
    try {
      if (req.method === 'GET' && !action) return reply(res, map.has(id) ? 200 : 404, map.get(id) ?? { error: '对象不存在' });
      if (req.method !== 'POST') return reply(res, 405, { error: '需要 GET 或 POST' });
      const data = JSON.parse((await readBody(req, 65536)).toString() || '{}');
      if (action === 'delete') await this.coda.protocols.delete(kind, id);
      else if (action === 'publish') await this.coda.protocols.publish(kind, id, data.enabled !== false);
      else {
        if (kind === SNAPSHOT && (!idOK(data.spec?.source) || !idOK(data.spec?.run))) throw new Error('source 与 run 须为本机 ID');
        if (kind === SOURCE) await repository(data.spec?.path ?? '', await this.coda.environment());
        await this.coda.protocols.put({ kind, id, spec: data.spec, ...(data.revision ? { revision: data.revision } : {}) });
      }
      reply(res, 200, { kind, id });
    } catch (error) { reply(res, error.status ?? 400, { error: error.message }); }
  }
  async stop() {
    this.stopped = true;
    for (const subscription of [...this.subscriptions, ...this.runWatches.values()]) await subscription.dispose();
    this.http.dispose(); await this.service?.dispose(); await this.queue;
    // Live runs retain their refs across host restart; deletion/terminal runs are reconciled on activation.
  }
}
