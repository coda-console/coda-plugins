import { mkdir, readFile } from 'node:fs/promises';
import { writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { SOURCE } from './definitions.mjs';
import { repository } from './git.mjs';
import { smartHTTP, readBody, reply } from './http.mjs';

const url = id => `/v1/plugins/git/services/repository/repos/${id}`;
const sameRepository = (a, b) => a.path === b.path && a.gitDir === b.gitDir && a.commonDir === b.commonDir;
const sameSpec = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export class GitProvider {
  constructor(coda) {
    this.coda = coda;
    this.sources = new Map(); this.lives = new Map(); this.identities = {}; this.repositories = new Map();
    this.subscriptions = [];
    this.identitiesFile = join(coda.plugin.state, 'sources.json');
    this.http = smartHTTP({ lookup: id => this.lookup(id), environment: () => coda.environment() });
  }
  async start() {
    await mkdir(this.coda.plugin.state, { recursive: true });
    try { this.identities = JSON.parse(await readFile(this.identitiesFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.subscriptions.push(await this.coda.watch(SOURCE, event => this.observe(event), { scope: 'local' }));
    this.service = await this.coda.services.register('repository', (req, res, caller) =>
      req.url.startsWith('/repos/') ? this.http(req, res, caller) : this.manage(req, res, caller));
  }
  observe({ type, id, entry }) {
    const previous = this.sources.get(id);
    if (type === 'DELETED') {
      // Revoke HTTP access at once. A source made again under this ID is a new one, which must not inherit the pinned repository.
      this.sources.delete(id); this.lives.delete(id); this.repositories.delete(id);
      if (id in this.identities) this.saveIdentities(Object.fromEntries(Object.entries(this.identities).filter(([key]) => key !== id)));
      return;
    }
    this.sources.set(id, entry);
    if (!this.lives.has(id)) this.lives.set(id, Symbol(id));
    // Now names another repository: revoke at once; its own status writes do not change what it serves.
    if (!sameSpec(previous?.spec, entry.spec)) this.repositories.delete(id);
    return this.reconcile(entry);
  }
  // Written in one step so that no other write of the file interleaves with it.
  saveIdentities(next) {
    writeFileSync(`${this.identitiesFile}.tmp`, `${JSON.stringify(next)}\n`, { mode: 0o600 });
    renameSync(`${this.identitiesFile}.tmp`, this.identitiesFile);
    this.identities = next; // Only a durable binding may authorize reads.
  }
  // What was reconciled is the source as it was seen (`life`: one registration of its ID, ended by its deletion); once it
  // is deleted, even made again with the same spec, or its spec has changed, a newer event reconciles it again.
  stale(source, life) { return this.lives.get(source.id) !== life || !sameSpec(this.sources.get(source.id)?.spec, source.spec); }
  async status(source, value) {
    const current = this.sources.get(source.id);
    if (!sameSpec(current.status, value)) await this.coda.put({ kind: SOURCE, id: source.id }, { spec: current.spec, status: value });
  }
  async reconcile(source) {
    const life = this.lives.get(source.id);
    try {
      const repo = await repository(source.spec.path, await this.coda.environment());
      if (this.stale(source, life)) return;
      const identity = this.identities[source.id];
      if (identity && !sameRepository(identity, repo)) throw new Error('源路径已指向另一仓库，请删除源后重新登记');
      if (!identity) this.saveIdentities({ ...this.identities, [source.id]: { path: repo.path, gitDir: repo.gitDir, commonDir: repo.commonDir } });
      this.repositories.set(source.id, { ...repo, pathSpec: source.spec.path });
      await this.status(source, { ready: true, url: url(source.id) });
    } catch (error) {
      if (this.stale(source, life)) return;
      this.repositories.delete(source.id);
      await this.status(source, { ready: false, reason: error.message });
    }
  }
  async lookup(id) {
    const source = this.sources.get(id), repo = this.repositories.get(id);
    if (!source || !repo || source.spec.path !== repo.pathSpec) return null;
    // Do not follow a registered path after it is replaced by a symlink to another repository.
    const now = await repository(source.spec.path, await this.coda.environment());
    return sameRepository(now, repo) ? repo : null;
  }
  async manage(req, res, caller) {
    // Registration accepts filesystem paths: only a local Coda API caller can do this.
    if (caller?.local !== true) return reply(res, 403, { error: '管理入口仅供本机调用' });
    const match = /^\/sources\/([a-zA-Z0-9_-]{1,100})(?:\/(delete))?$/.exec(req.url);
    if (!match) return reply(res, 404, { error: '未知管理路径' });
    const [, id, action] = match;
    try {
      if (req.method === 'GET' && !action) return reply(res, this.sources.has(id) ? 200 : 404, this.sources.get(id) ?? { error: '对象不存在' });
      if (req.method !== 'POST') return reply(res, 405, { error: '需要 GET 或 POST' });
      const data = JSON.parse((await readBody(req, 65536)).toString() || '{}');
      if (action === 'delete') await this.coda.delete({ kind: SOURCE, id });
      else {
        await repository(data.spec?.path ?? '', await this.coda.environment());
        // A record is written whole: the status it has now is carried over, until the spec's new result replaces it.
        await this.coda.put({ kind: SOURCE, id }, { spec: data.spec, status: this.sources.get(id)?.status ?? {} });
      }
      reply(res, 200, { kind: SOURCE, id });
    } catch (error) { reply(res, error.status ?? 400, { error: error.message }); }
  }
  async stop() {
    for (const subscription of this.subscriptions) await subscription.dispose();
    this.http.dispose(); await this.service?.dispose();
  }
}
