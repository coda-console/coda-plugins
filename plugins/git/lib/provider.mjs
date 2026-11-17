import { randomUUID } from 'node:crypto';
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
    // `sources`, `lives` and `repositories` are by record ID, a UUID made at a source's registration; `names` is this plugin's
    // table, kept in sources.json: each name the management routes take → `{ id, identity? }`, the identity once it is pinned.
    this.sources = new Map(); this.lives = new Map(); this.names = new Map(); this.repositories = new Map();
    this.subscriptions = []; this.managing = Promise.resolve();
    this.namesFile = join(coda.plugin.state, 'sources.json');
    this.http = smartHTTP({ lookup: id => this.lookup(id), environment: () => coda.environment() });
  }
  async start() {
    await mkdir(this.coda.plugin.state, { recursive: true });
    try { this.names = new Map(Object.entries(JSON.parse(await readFile(this.namesFile, 'utf8')))); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.subscriptions.push(await this.coda.watch(SOURCE, event => this.observe(event), { scope: 'local' }));
    // Every record there is has been given by now (as `ADDED`): a name whose source is gone, deleted while this plugin was not
    // running, would otherwise stay and keep its pinned identity for a registration of another repository under that name.
    const kept = new Map([...this.names].filter(([, { id }]) => this.sources.has(id)));
    if (kept.size !== this.names.size) this.saveNames(kept);
    this.service = await this.coda.services.register('repository', (req, res, caller) =>
      req.url.startsWith('/repos/') ? this.http(req, res, caller) : this.manage(req, res, caller));
  }
  nameOf(id) { return [...this.names].find(([, entry]) => entry.id === id)?.[0]; }
  observe({ type, id, entry }) {
    const previous = this.sources.get(id);
    if (type === 'DELETED') {
      // Revoke HTTP access at once. A source registered again under its name is a new one, with a new ID and identity.
      this.sources.delete(id); this.lives.delete(id); this.repositories.delete(id);
      const name = this.nameOf(id);
      if (name !== undefined) this.saveNames(new Map([...this.names].filter(([key]) => key !== name)));
      return;
    }
    // A record not in the table is none of this plugin's registrations (one an earlier version left): it is as if not there.
    if (this.nameOf(id) === undefined) return;
    this.sources.set(id, entry);
    if (!this.lives.has(id)) this.lives.set(id, Symbol(id));
    // Only a new record or a changed spec is checked: the echo of its own status write sets nothing off.
    if (sameSpec(previous?.spec, entry.spec)) return;
    // Now names another repository: revoke at once.
    this.repositories.delete(id);
    return this.reconcile(entry);
  }
  // Written in one step so that no other write of the file interleaves with it.
  saveNames(next) {
    writeFileSync(`${this.namesFile}.tmp`, `${JSON.stringify(Object.fromEntries(next))}\n`, { mode: 0o600 });
    renameSync(`${this.namesFile}.tmp`, this.namesFile);
    this.names = next; // Only a durable binding may authorize reads.
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
      const name = source.spec.name, { identity } = this.names.get(name);
      if (identity && !sameRepository(identity, repo)) throw new Error('源路径已指向另一仓库，请删除源后重新登记');
      if (!identity) this.saveNames(new Map(this.names).set(name, { id: source.id, identity: { path: repo.path, gitDir: repo.gitDir, commonDir: repo.commonDir } }));
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
        const id = this.names.get(name)?.id;
        return reply(res, this.sources.has(id) ? 200 : 404, this.sources.get(id) ?? { error: '对象不存在' });
      }
      if (req.method !== 'POST') return reply(res, 405, { error: '需要 GET 或 POST' });
      const data = JSON.parse((await readBody(req, 65536)).toString() || '{}');
      // Registrations and deletions take turns, each reading the name's binding when its turn comes: two at once under one
      // name make one source, not two IDs of which the table keeps only the last.
      const turn = this.managing.then(() => this.change(name, action, data));
      this.managing = turn.catch(() => {});
      reply(res, 200, { kind: SOURCE, id: await turn });
    } catch (error) { reply(res, error.status ?? 400, { error: error.message }); }
  }
  async change(name, action, data) {
    let id = this.names.get(name)?.id;
    // The plugin's state follows its own write, not its echo: a reconcile still waiting must not write back over it.
    if (action === 'delete') {
      if (id === undefined) throw Object.assign(new Error('对象不存在'), { status: 404 });
      this.lives.set(id, Symbol(id)); await this.coda.delete({ kind: SOURCE, id });
      // The name is free at once: registered again, even before the deletion's echo, it is a new source with a new ID.
      if (this.names.get(name)?.id === id) this.saveNames(new Map([...this.names].filter(([key]) => key !== name)));
    } else {
      await repository(data.spec?.path ?? '', await this.coda.environment());
      // A first registration is given its ID here, kept in the table before the record is written.
      if (id === undefined) this.saveNames(new Map(this.names).set(name, { id: id = randomUUID() }));
      const spec = { ...data.spec, name }, same = sameSpec(this.sources.get(id)?.spec, spec);
      if (!same) this.lives.set(id, Symbol(id));
      // A record is written whole: the status it has now is carried over, until the spec's new result replaces it.
      await this.coda.put({ kind: SOURCE, id }, { spec, status: this.sources.get(id)?.status ?? {} });
      // The same spec writes nothing and echoes nothing, so nothing would reconcile it again: a source that failed, its
      // repository mended, is checked here. One already under way is not cancelled; `stale` keeps either from writing over a newer.
      if (same) await this.reconcile(this.sources.get(id));
    }
    return id;
  }
  async stop() {
    for (const subscription of this.subscriptions) await subscription.dispose();
    this.http.dispose(); await this.service?.dispose();
  }
}
