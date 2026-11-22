import { mkdir, readFile } from 'node:fs/promises';
import { writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { SOURCE } from './definitions.mjs';
import { repository } from './git.mjs';
import { smartHTTP, pathOf, readBody, reply } from './http.mjs';

const url = id => `/v1/records/${encodeURIComponent(SOURCE)}/${id}/streams/transport`;
const sameRepository = (a, b) => a.path === b.path && a.gitDir === b.gitDir && a.commonDir === b.commonDir;

export class GitProvider {
  constructor(coda) {
    this.coda = coda;
    // The registered sources, by name, are kept in sources.json: `{ version: 2, sources: { <name>: { spec, identity } } }`. `identity` is the
    // repository the name is pinned to, set when the source is first ready. `id` is the host's record ID, `status` the last
    // one written; neither is in the file. `repositories` is by record ID.
    this.sources = new Map(); this.repositories = new Map(); this.managing = Promise.resolve();
    this.file = join(coda.plugin.state, 'sources.json');
    this.http = smartHTTP({ lookup: (id, signal) => this.lookup(id, signal) }); this.served = [];
  }
  async start() {
    await mkdir(this.coda.plugin.state, { recursive: true });
    try {
      // Any other file is an earlier version's table of identities: no sources.
      const file = JSON.parse(await readFile(this.file, 'utf8'));
      if (file.version === 2) this.sources = new Map(Object.entries(file.sources).map(([name, { spec, identity }]) => [name, { spec, identity }]));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await this.replace();
    // Served once checked: a source left ready by the last run is not refused meanwhile.
    await Promise.all([...this.sources.keys()].map(name => this.reconcile(name)));
    this.served.push(await this.coda.stream(SOURCE, 'transport', this.http));
    this.served.push(await this.coda.serve('repository', (request, { caller }) => this.manage(request, caller)));
  }
  // Written in one step so that no other write of the file interleaves with it. What is saved is the next state: it is
  // `this.sources` only once the file has it.
  save(next) {
    const sources = Object.fromEntries([...next].map(([name, { spec, identity }]) => [name, { spec, identity }]));
    writeFileSync(`${this.file}.tmp`, `${JSON.stringify({ version: 2, sources })}\n`, { mode: 0o600 });
    renameSync(`${this.file}.tmp`, this.file);
  }
  // The whole set, from memory: the host drops the records of the kind that are not in it. The status is the one it holds.
  async replace() {
    const entries = await this.coda.replace(SOURCE, [...this.sources].map(([key, { spec }]) => ({ key, spec })));
    for (const { key, id } of entries) this.sources.get(key).id = id;
  }
  // The status is the source's only once the host has it. A refused `put` throws: a first registration's record has no status
  // yet, an updated source keeps the old one on the host, until the registration is retried or `start()` checks every source again.
  async reconcile(name) {
    const source = this.sources.get(name);
    let status;
    try {
      const repo = await repository(source.spec.path);
      if (source.identity && !sameRepository(source.identity, repo)) throw new Error('源路径已指向另一仓库，请删除源后重新登记');
      if (!source.identity) {
        const identity = { path: repo.path, gitDir: repo.gitDir, commonDir: repo.commonDir };
        this.save(new Map(this.sources).set(name, { spec: source.spec, identity }));
        source.identity = identity;
      }
      this.repositories.set(source.id, { ...repo, pathSpec: source.spec.path });
      status = { ready: true, url: url(source.id) };
    } catch (error) {
      this.repositories.delete(source.id);
      status = { ready: false, reason: error.message };
    }
    await this.coda.put({ kind: SOURCE, key: name }, { spec: source.spec, status });
    source.status = status;
  }
  async lookup(id, signal) {
    const source = [...this.sources.values()].find(source => source.id === id), repo = this.repositories.get(id);
    if (!source || !repo || source.spec.path !== repo.pathSpec) return null;
    // Do not follow a registered path after it is replaced by a symlink to another repository.
    const now = await repository(source.spec.path, { signal });
    return sameRepository(now, repo) ? repo : null;
  }
  async manage(request, caller) {
    // Registration accepts filesystem paths: only a local Coda API caller can do this.
    if (caller.local !== true) return reply(403, { error: '管理入口仅供本机调用' });
    const match = /^\/sources\/([a-zA-Z0-9_-]{1,100})(?:\/(delete))?$/.exec(pathOf(request));
    if (!match) return reply(404, { error: '未知管理路径' });
    const [, name, action] = match;
    try {
      if (request.method === 'GET' && !action) {
        const source = this.sources.get(name);
        return reply(source ? 200 : 404, source ? { id: source.id, key: name, spec: source.spec, status: source.status } : { error: '对象不存在' });
      }
      if (request.method !== 'POST') return reply(405, { error: '需要 GET 或 POST' });
      const data = JSON.parse((await readBody(request, 65536)).toString() || '{}');
      // Registrations and deletions take turns, each reading the sources when its turn comes.
      const turn = this.managing.then(() => this.change(name, action, data));
      this.managing = turn.catch(() => {});
      return reply(200, { kind: SOURCE, id: await turn });
    } catch (error) { return reply(error.status ?? 400, { error: error.message }); }
  }
  // The file first, then the host's records. A `replace` the host refuses leaves nothing changed: the file and the sources are
  // back as they were. Once it is accepted the change stays, whatever a later `put` does.
  async change(name, action, data) {
    const before = this.sources, source = before.get(name), next = new Map(before);
    if (action === 'delete') {
      if (!source) throw Object.assign(new Error('对象不存在'), { status: 404 });
      next.delete(name);
    } else {
      await repository(data.spec?.path ?? '');
      // The new spec is not checked yet: no status until `reconcile` has put it.
      next.set(name, { ...source, spec: { path: data.spec.path, name }, status: undefined });
    }
    this.save(next); this.sources = next;
    try { await this.replace(); } catch (error) { this.save(before); this.sources = before; throw error; }
    if (action === 'delete') {
      this.repositories.delete(source.id);
      return source.id;
    }
    // The registration alone is checked, every time (the same spec included: a source that failed, its repository mended, is
    // ready again). No other source is: each one's own request or `start()` does that.
    await this.reconcile(name);
    return this.sources.get(name).id;
  }
  async stop() {
    await Promise.all(this.served.map(served => served.dispose()));
    await this.http.ended();
  }
}
