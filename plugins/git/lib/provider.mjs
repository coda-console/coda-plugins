import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, realpath } from 'node:fs/promises';
import { join, isAbsolute, relative } from 'node:path';
import { SOURCE, SNAPSHOT, SERVICE } from './definitions.mjs';
import { repository, git, createSnapshot, removeSnapshot, snapshotRef } from './git.mjs';
import { smartHTTP, readBody, reply } from './http.mjs';

const SERVICE_ID = 'git';
const idOK = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const autoSourceId = path => `worktree-${hash([path]).slice(0, 40)}`;
const url = id => `/v1/plugins/git/services/repository/repos/${id}`;
const sameRepository = (a, b) => a.path === b.path && a.gitDir === b.gitDir && a.commonDir === b.commonDir;
const ended = run => run?.finishedAt != null || ['succeeded', 'failed', 'cancelled'].includes(run?.state);

export class GitProvider {
  constructor(coda) {
    this.coda = coda;
    this.sources = new Map(); this.snapshots = new Map(); this.runs = new Map(); this.runWatches = new Map();
    this.identities = {}; this.repositories = new Map(); this.subscriptions = []; this.records = {}; this.queue = Promise.resolve();
    this.holds = new Set(); this.waiters = new Map();
    this.active = false; this.stopped = false;
    this.file = join(coda.plugin.state, 'snapshots.json');
    this.identitiesFile = join(coda.plugin.state, 'sources.json');
    this.http = smartHTTP({ lookup: id => this.lookup(id), environment: () => coda.environment() });
  }
  async start() {
    await mkdir(this.coda.plugin.state, { recursive: true });
    try { this.records = JSON.parse(await readFile(this.file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { this.identities = JSON.parse(await readFile(this.identitiesFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const [kind, map] of [[SOURCE, this.sources], [SNAPSHOT, this.snapshots]]) {
      this.subscriptions.push(await this.coda.protocols.observe(kind, event => {
        if (event.type === 'DELETED') map.delete(event.id); else map.set(event.id, event.object);
        // Revoke HTTP access immediately, before the asynchronous controller catches up.
        if (kind === SOURCE) this.repositories.delete(event.id);
        this.notify(kind, event.id);
      }, 'local'));
      this.subscriptions.push(await this.coda.protocols.control(kind, () => this.schedule(), 'local'));
    }
    this.active = true;
    await this.ensureService();
    this.subscriptions.push(await this.coda.protocols.handle(SERVICE, 'snapshot', (input, context) => this.snapshot(input, context)));
    await this.schedule();
    this.service = await this.coda.services.register('repository', (req, res, caller) =>
      req.url.startsWith('/repos/') ? this.http(req, res, caller) : this.manage(req, res, caller));
  }
  async ensureService() {
    let held;
    (await this.coda.protocols.observe(SERVICE, event => { if (event.id === SERVICE_ID) held = event.object; }, 'local')).dispose();
    if (!held) await this.coda.protocols.put({ kind: SERVICE, id: SERVICE_ID, spec: {} });
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
  async saveIdentities(next) {
    await writeFile(`${this.identitiesFile}.tmp`, `${JSON.stringify(next)}\n`, { mode: 0o600 });
    await rename(`${this.identitiesFile}.tmp`, this.identitiesFile);
    this.identities = next; // Only a durable binding may authorize reads or new snapshot refs.
  }
  async status(object, value) {
    // Always carry the observed version; do not relabel an old result with a newer revision.
    if (JSON.stringify(object.status) !== JSON.stringify(value))
      await this.coda.protocols.setStatus(object.kind, object.id, value, object.revision);
  }
  notify(kind, id) {
    const set = this.waiters.get(`${kind}\0${id}`);
    if (set) for (const check of [...set]) check();
  }
  waitFor(kind, id, done) {
    const map = kind === SOURCE ? this.sources : this.snapshots, key = `${kind}\0${id}`;
    return new Promise(resolve => {
      const check = () => {
        const object = map.get(id);
        if (!object || !done(object)) return;
        set.delete(check); if (!set.size) this.waiters.delete(key);
        resolve(object);
      };
      let set = this.waiters.get(key);
      if (!set) { set = new Set(); this.waiters.set(key, set); }
      set.add(check); check();
    });
  }
  // One local call from a workflow run: snapshot the worktree under `path`, publish it and its source, and answer.
  async snapshot(input, { parent, requestId } = {}) {
    if (parent?.kind !== 'workflow-runs' || typeof parent.id !== 'string' || !parent.id || parent.id.length > 2048)
      throw new Error('snapshot 须由本机流程运行发起：parent 须为 { kind: "workflow-runs", id }');
    if (typeof requestId !== 'string' || !requestId || requestId.length > 2048) throw new Error('snapshot 缺少请求 ID');
    const path = input?.path;
    if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) throw new Error('path 须为本机绝对路径');
    const env = await this.coda.environment();
    let dir, root;
    try {
      dir = await realpath(path);
      root = await realpath(await git(dir, ['rev-parse', '--show-toplevel'], { env }));
    } catch (error) { throw new Error(`path 不在任何 Git 工作副本里：${error.message}`); }
    const workingDirectory = relative(root, dir);
    if (workingDirectory.startsWith('..') || isAbsolute(workingDirectory)) throw new Error('path 不在工作副本根目录内');
    const source = [...this.sources.values()].find(item => item.spec.path === root);
    const sourceId = source?.id ?? autoSourceId(root);
    this.holds.add(sourceId);
    try {
      if (!source) {
        if (this.sources.has(sourceId)) throw new Error(`源 ${sourceId} 已被另一路径占用`);
        await this.coda.protocols.put({ kind: SOURCE, id: sourceId, spec: { path: root } });
      }
      const sourceItem = await this.waitFor(SOURCE, sourceId, item => item.status?.ready === true || item.status?.reason);
      if (!sourceItem.status.ready) throw new Error(sourceItem.status.reason ?? '源不可用');
      const spec = { source: sourceId, mode: 'worktree', run: parent.id };
      const snapshotId = `snapshot-${hash([parent.kind, parent.id, requestId]).slice(0, 40)}`;
      const held = this.snapshots.get(snapshotId);
      if (held && JSON.stringify(held.spec) !== JSON.stringify(spec)) throw new Error(`请求 ${requestId} 已用于另一个快照`);
      if (!held) await this.coda.protocols.put({ kind: SNAPSHOT, id: snapshotId, spec });
      // A status write of the source clears the cached repository until the next reconciliation; that transient
      // failure is retried, while a source that really became unavailable ends the call.
      const item = await this.waitFor(SNAPSHOT, snapshotId, object => {
        if (object.status?.ready === true || object.status?.released === true) return true;
        if (!object.status?.reason) return false;
        if (object.status.reason !== '源未登记或不可用') return true;
        const current = this.sources.get(sourceId);
        return !current || current.status?.ready === false;
      });
      if (!item.status.ready) {
        const current = this.sources.get(sourceId);
        throw new Error(item.status.reason === '源未登记或不可用' && current?.status?.reason
          ? current.status.reason : item.status.reason ?? '快照未就绪');
      }
      await this.coda.protocols.publish(SOURCE, sourceId);
      await this.coda.protocols.publish(SNAPSHOT, snapshotId);
      return { snapshot: { kind: SNAPSHOT, id: snapshotId }, commit: item.status.commit, workingDirectory: workingDirectory || '.' };
    } finally { this.holds.delete(sourceId); void this.schedule().catch(() => {}); }
  }
  async followRuns() {
    const needed = new Set([...this.snapshots.values()].map(item => item.spec.run));
    for (const [id, watcher] of this.runWatches) if (!needed.has(id)) {
      await watcher.dispose(); this.runWatches.delete(id); this.runs.delete(id);
    }
    for (const id of needed) {
      let watcher = this.runWatches.get(id);
      if (!watcher) {
        watcher = { generation: 0 };
        try {
          const subscription = await this.coda.watch('workflow-runs', event => {
            if (event.id !== id) return; // The filtered collection can also contain child runs.
            watcher.generation++;
            this.runs.set(id, event.type === 'DELETED' ? { state: 'cancelled' } : event.object);
            void this.schedule().catch(() => {});
          }, { run: id });
          watcher.dispose = () => subscription.dispose();
        } catch (error) { if (watcher.generation === 0) this.runs.set(id, { error: error.message }); continue; }
        this.runWatches.set(id, watcher);
      }
      if (!this.runs.has(id) || this.runs.get(id).error) {
        // Confirm old runs absent from the recent list; retry failed lookups on subsequent reconciliations.
        const observed = watcher.generation;
        try {
          const run = await this.coda.api(`workflow-runs/${encodeURIComponent(id)}`);
          if (watcher.generation === observed) this.runs.set(id, run);
        } catch (error) { if (watcher.generation === observed) this.runs.set(id, { error: error.message }); }
      }
    }
  }
  async reconcile() {
    const env = await this.coda.environment();
    await this.followRuns();
    const instances = new Set([...this.sources.values()].map(source => source.instance));
    const retained = Object.fromEntries(Object.entries(this.identities).filter(([instance]) => instances.has(instance)));
    if (Object.keys(retained).length !== Object.keys(this.identities).length) await this.saveIdentities(retained);
    for (const source of this.sources.values()) {
      try {
        const repo = await repository(source.spec.path, env);
        if (this.sources.get(source.id)?.revision !== source.revision) continue;
        const identity = this.identities[source.instance];
        if (identity && !sameRepository(identity, repo)) throw new Error('源路径已指向另一仓库，请删除源后重新登记');
        if (!identity) await this.saveIdentities({ ...this.identities, [source.instance]: { path: repo.path, gitDir: repo.gitDir, commonDir: repo.commonDir } });
        if (this.sources.get(source.id)?.revision !== source.revision) continue;
        this.repositories.set(source.id, { ...repo, instance: source.instance, pathSpec: source.spec.path });
        await this.status(source, { ready: true, url: url(source.id) });
      } catch (error) {
        if (this.sources.get(source.id)?.revision !== source.revision) continue;
        this.repositories.delete(source.id);
        await this.status(source, { ready: false, reason: error.message });
      }
    }
    // Availability gates reads and creation, not the lifetime of an existing snapshot.
    const desired = new Set();
    for (const item of this.snapshots.values()) {
      const source = this.sources.get(item.spec.source);
      const token = hash([item.id, item.instance, item.spec, source?.instance, source?.spec]);
      if (source && !ended(this.runs.get(item.spec.run))) desired.add(token);
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
    // Sources made for this call are temporary: once no live snapshot names one, unpublish and delete it.
    const liveSources = new Set();
    for (const item of this.snapshots.values()) if (!ended(this.runs.get(item.spec.run))) liveSources.add(item.spec.source);
    for (const source of [...this.sources.values()]) {
      if (source.id !== autoSourceId(source.spec.path) || liveSources.has(source.id) || this.holds.has(source.id)) continue;
      try {
        await this.coda.protocols.publish(SOURCE, source.id, false);
        await this.coda.protocols.delete(SOURCE, source.id);
        this.sources.delete(source.id); this.repositories.delete(source.id);
      } catch (error) { console.error('[git source cleanup]', source.id, error.message); }
    }
  }
  async lookup(id) {
    const source = this.sources.get(id), repo = this.repositories.get(id);
    if (!source || !repo || source.instance !== repo.instance || source.spec.path !== repo.pathSpec) return null;
    // Do not follow a registered path after it is replaced by a symlink to another repository.
    const now = await repository(source.spec.path, await this.coda.environment());
    if (!sameRepository(now, repo)) return null;
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
