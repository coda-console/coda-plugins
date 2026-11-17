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
    // `sources`, `lives` and `repositories` are by record ID, the host's, derived from the source's name, its key. `identities`
    // is the repository each name is pinned to, kept in sources.json: a check, not a table of IDs.
    this.sources = new Map(); this.lives = new Map(); this.identities = new Map(); this.repositories = new Map();
    this.subscriptions = []; this.managing = Promise.resolve();
    this.identitiesFile = join(coda.plugin.state, 'sources.json');
    this.http = smartHTTP({ lookup: id => this.lookup(id), environment: () => coda.environment() });
  }
  async start() {
    await mkdir(this.coda.plugin.state, { recursive: true });
    try { this.identities = new Map(Object.entries(JSON.parse(await readFile(this.identitiesFile, 'utf8')))); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    // Until the sources are all given and checked, an event only keeps what it says: the checks come after the whole set.
    this.starting = true;
    this.subscriptions.push(await this.coda.watch(SOURCE, event => this.observe(event), { scope: 'local' }));
    // Every record there is has been given by now (as `ADDED`). The whole set, once: the host drops the sources an earlier
    // version left, without a key. A name whose source is gone, deleted while this plugin was not running, loses its pinned
    // identity, which would otherwise hold a registration of another repository under that name.
    await this.coda.replace(SOURCE, [...this.sources.values()].map(({ key, spec, status }) => ({ key, spec, status })));
    const names = new Set([...this.sources.values()].map(source => source.key));
    const kept = new Map([...this.identities].filter(([name]) => names.has(name)));
    if (kept.size !== this.identities.size) this.saveIdentities(kept);
    this.starting = false;
    // Served once checked: a source left ready by the last run is not refused meanwhile.
    await Promise.all([...this.sources.values()].map(source => this.reconcile(source)));
    this.service = await this.coda.services.register('repository', (req, res, caller) =>
      req.url.startsWith('/repos/') ? this.http(req, res, caller) : this.manage(req, res, caller));
  }
  idOf(name) { return [...this.sources].find(([, source]) => source.key === name)?.[0]; }
  observe({ type, id, entry }) {
    const previous = this.sources.get(id);
    if (type === 'DELETED') {
      // Revoke HTTP access at once. A source registered again under its name is a new one, with a new identity.
      this.sources.delete(id); this.lives.delete(id); this.repositories.delete(id);
      if (previous && this.identities.has(previous.key)) this.forget(previous.key);
      return;
    }
    // A record without a key is none of this plugin's registrations (one an earlier version left): it is as if not there.
    if (entry.key === undefined) return;
    this.sources.set(id, entry);
    if (!this.lives.has(id)) this.lives.set(id, Symbol(id));
    // Only a new record or a changed spec is checked: the echo of its own status write sets nothing off.
    if (this.starting || sameSpec(previous?.spec, entry.spec)) return;
    // Now names another repository: revoke at once.
    this.repositories.delete(id);
    return this.reconcile(entry);
  }
  // Written in one step so that no other write of the file interleaves with it.
  saveIdentities(next) {
    writeFileSync(`${this.identitiesFile}.tmp`, `${JSON.stringify(Object.fromEntries(next))}\n`, { mode: 0o600 });
    renameSync(`${this.identitiesFile}.tmp`, this.identitiesFile);
    this.identities = next; // Only a durable binding may authorize reads.
  }
  forget(name) { this.saveIdentities(new Map([...this.identities].filter(([key]) => key !== name))); }
  // What was reconciled is the source as it was seen (`life`: one registration of its ID, ended by its deletion); once it
  // is deleted, even made again with the same spec, or its spec has changed, a newer event reconciles it again.
  stale(source, life) { return this.lives.get(source.id) !== life || !sameSpec(this.sources.get(source.id)?.spec, source.spec); }
  async status(source, value) {
    const current = this.sources.get(source.id);
    if (!sameSpec(current.status, value)) await this.coda.put({ kind: SOURCE, key: current.key }, { spec: current.spec, status: value });
  }
  async reconcile(source) {
    const life = this.lives.get(source.id);
    try {
      const repo = await repository(source.spec.path, await this.coda.environment());
      if (this.stale(source, life)) return;
      const identity = this.identities.get(source.key);
      if (identity && !sameRepository(identity, repo)) throw new Error('源路径已指向另一仓库，请删除源后重新登记');
      if (!identity) this.saveIdentities(new Map(this.identities).set(source.key, { path: repo.path, gitDir: repo.gitDir, commonDir: repo.commonDir }));
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
    const [, name, action] = match;
    try {
      if (req.method === 'GET' && !action) {
        const source = this.sources.get(this.idOf(name));
        return reply(res, source ? 200 : 404, source ?? { error: '对象不存在' });
      }
      if (req.method !== 'POST') return reply(res, 405, { error: '需要 GET 或 POST' });
      const data = JSON.parse((await readBody(req, 65536)).toString() || '{}');
      // Registrations and deletions take turns, each reading the name's source when its turn comes.
      const turn = this.managing.then(() => this.change(name, action, data));
      this.managing = turn.catch(() => {});
      reply(res, 200, { kind: SOURCE, id: await turn });
    } catch (error) { reply(res, error.status ?? 400, { error: error.message }); }
  }
  async change(name, action, data) {
    const id = this.idOf(name);
    // The plugin's state follows its own write, not its echo: a reconcile still waiting must not write back over it.
    if (action === 'delete') {
      if (id === undefined) throw Object.assign(new Error('对象不存在'), { status: 404 });
      this.lives.set(id, Symbol(id));
      try { await this.coda.delete({ kind: SOURCE, key: name }); }
      catch (error) {
        // Refused, the record stays, and no event will check it: a reconcile made stale above would leave it as it was.
        const source = this.sources.get(id);
        if (source) await this.reconcile(source);
        throw error;
      }
      // The name is free at once: registered again, even before the deletion's echo, it is pinned anew.
      if (this.identities.has(name)) this.forget(name);
      return id;
    }
    await repository(data.spec?.path ?? '', await this.coda.environment());
    const spec = { ...data.spec, name }, same = sameSpec(this.sources.get(id)?.spec, spec);
    if (id !== undefined && !same) this.lives.set(id, Symbol(id));
    // A record is written whole: the status it has now is carried over, until the spec's new result replaces it.
    const written = await this.coda.put({ kind: SOURCE, key: name }, { spec, status: this.sources.get(id)?.status ?? {} });
    // The same spec writes nothing and echoes nothing, so nothing would reconcile it again: a source that failed, its
    // repository mended, is checked here. One already under way is not cancelled; `stale` keeps either from writing over a newer.
    if (same) await this.reconcile(this.sources.get(id));
    return written.id;
  }
  async stop() {
    for (const subscription of this.subscriptions) await subscription.dispose();
    this.http.dispose(); await this.service?.dispose();
  }
}
