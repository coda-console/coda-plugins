import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { SOURCE } from './definitions.mjs';
import { repository } from './git.mjs';
import { smartHTTP, readBody, reply } from './http.mjs';

const url = id => `/v1/plugins/git/services/repository/repos/${id}`;
const sameRepository = (a, b) => a.path === b.path && a.gitDir === b.gitDir && a.commonDir === b.commonDir;

export class GitProvider {
  constructor(coda) {
    this.coda = coda;
    this.sources = new Map(); this.identities = {}; this.repositories = new Map();
    this.subscriptions = []; this.queue = Promise.resolve();
    this.active = false; this.stopped = false;
    this.identitiesFile = join(coda.plugin.state, 'sources.json');
    this.http = smartHTTP({ lookup: id => this.lookup(id), environment: () => coda.environment() });
  }
  async start() {
    await mkdir(this.coda.plugin.state, { recursive: true });
    try { this.identities = JSON.parse(await readFile(this.identitiesFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.subscriptions.push(await this.coda.protocols.observe(SOURCE, event => {
      const previous = this.sources.get(event.id);
      if (event.type === 'DELETED') this.sources.delete(event.id); else this.sources.set(event.id, event.object);
      // Revoke HTTP access immediately when the source is deleted or now names another repository;
      // its own status writes do not change what it serves.
      if (event.type === 'DELETED' || !previous || previous.instance !== event.object.instance ||
          JSON.stringify(previous.spec) !== JSON.stringify(event.object.spec)) this.repositories.delete(event.id);
    }, 'local'));
    this.subscriptions.push(await this.coda.protocols.control(SOURCE, () => this.schedule(), 'local'));
    this.active = true;
    await this.schedule();
    this.service = await this.coda.services.register('repository', (req, res, caller) =>
      req.url.startsWith('/repos/') ? this.http(req, res, caller) : this.manage(req, res, caller));
  }
  schedule() {
    if (!this.active || this.stopped) return Promise.resolve();
    const next = this.queue.then(() => this.reconcile());
    this.queue = next.catch(error => console.error('[git sources]', error.message));
    return next;
  }
  async saveIdentities(next) {
    await writeFile(`${this.identitiesFile}.tmp`, `${JSON.stringify(next)}\n`, { mode: 0o600 });
    await rename(`${this.identitiesFile}.tmp`, this.identitiesFile);
    this.identities = next; // Only a durable binding may authorize reads.
  }
  async status(object, value) {
    // Always carry the observed version; do not relabel an old result with a newer revision.
    if (JSON.stringify(object.status) !== JSON.stringify(value))
      await this.coda.protocols.setStatus(object.kind, object.id, value, object.revision);
  }
  async reconcile() {
    const env = await this.coda.environment();
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
        this.repositories.set(source.id, { ...repo, instance: source.instance, pathSpec: source.spec.path });
        await this.status(source, { ready: true, url: url(source.id) });
      } catch (error) {
        this.repositories.delete(source.id);
        await this.status(source, { ready: false, reason: error.message });
      }
    }
  }
  async lookup(id) {
    const source = this.sources.get(id), repo = this.repositories.get(id);
    if (!source || !repo || source.instance !== repo.instance || source.spec.path !== repo.pathSpec) return null;
    // Do not follow a registered path after it is replaced by a symlink to another repository.
    const now = await repository(source.spec.path, await this.coda.environment());
    return sameRepository(now, repo) ? repo : null;
  }
  async manage(req, res, caller) {
    // Registration accepts filesystem paths: only a local Coda API caller can do this.
    if (caller?.local !== true) return reply(res, 403, { error: '管理入口仅供本机调用' });
    const match = /^\/sources\/([a-zA-Z0-9_-]{1,100})(?:\/(delete|publish))?$/.exec(req.url);
    if (!match) return reply(res, 404, { error: '未知管理路径' });
    const [, id, action] = match;
    try {
      if (req.method === 'GET' && !action) return reply(res, this.sources.has(id) ? 200 : 404, this.sources.get(id) ?? { error: '对象不存在' });
      if (req.method !== 'POST') return reply(res, 405, { error: '需要 GET 或 POST' });
      const data = JSON.parse((await readBody(req, 65536)).toString() || '{}');
      if (action === 'delete') await this.coda.protocols.delete(SOURCE, id);
      else if (action === 'publish') await this.coda.protocols.publish(SOURCE, id, data.enabled !== false);
      else {
        await repository(data.spec?.path ?? '', await this.coda.environment());
        await this.coda.protocols.put({ kind: SOURCE, id, spec: data.spec, ...(data.revision ? { revision: data.revision } : {}) });
      }
      reply(res, 200, { kind: SOURCE, id });
    } catch (error) { reply(res, error.status ?? 400, { error: error.message }); }
  }
  async stop() {
    this.stopped = true;
    for (const subscription of this.subscriptions) await subscription.dispose();
    this.http.dispose(); await this.service?.dispose(); await this.queue;
  }
}
