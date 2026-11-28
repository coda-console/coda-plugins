// Token 消耗榜的模块（Coda 的 docs/plugins.md「插件宿主」）。随后端启动（onStartupFinished）：
// - 读本机用量（coda/usage@1 的 buckets，只读、不推送，所以按需拉取）；本机用量与当天曲线只靠本机用量，不依赖签名发布；
// - 好友能力只经可选的 friends/social@1 网关：分享开着时，每 10 分钟把月块日归档（`coda/token-day`）和 48 小时曲线（`coda/token-today`）交给网关发布，
//   规范哈希去重、证书过期与暂停的排队、恢复后自动补发都由网关负责；没装或停用好友插件时，本机统计与曲线照常，分享状态报 no_gateway；
// - 同型号映射只来自可选的 magpie/models@1（本机 Magpie 插件）：取数时读一次，只套本机自己的行；发布的记录各行带上归并名（`u`），别台读到后直接用，不拿本机映射去套别人的行；
//   没装 Magpie 插件或读不到时没有映射；
// - 来源 ID 优先用 coda/machine@1 里本机的稳定 ID，读不到就沿用上次的，不会因为一时读不到换成新的随机 UUID；
// - 关掉分享或手动撤回，就按本机 sourceId 筛出自己的记录，逐条（带 id）经网关撤回，好友不再看得到；绝不按 kind 批量撤回，免得误撤同作者其他设备的记录；
// - 页面（view `board`）是目录聚合视图，只读目录里本模块写的记录（协议 token-board/usage@1）：本机用量（月块日归档与 48 小时曲线）、这台的状态、
//   镜像来的好友与自己别的设备的签名记录；模块不回页面消息，只在 `set-share` 操作里开关分享。每种记录都是一份全集，用 `coda.replace` 整份交出。
// `activate` 里不读任何记录：初始化的读取放在延迟的定时器里，并且全都 try/catch。
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DAY_ARCHIVE_KIND, DAY_MS, TODAY_CURVE_KIND, USAGE_RECORD_KIND, buildArchiveBodies, buildTodayBody,
  fetchUsageBuckets, isWithdrawn, markSame, needsSame, ownBuckets, ownedBySource,
} from './lib/usage.mjs';

const KIND = 'token-board/usage@1';
const USAGE = { kind: 'coda/usage@1', id: 'local' };
const SOCIAL = 'friends/social@1';
const SAME = 'magpie/models@1';
const MACHINE = 'coda/machine@1';
export const SYNC_INTERVAL_MS = 10 * 60_000;
export const FIRST_SYNC_DELAY_MS = 5_000;
export const CURVE_INTERVAL_MS = 60_000;
export const MIRROR_DEBOUNCE_MS = 800;
const CURVE_HOURS = 48;
// 目录里一条记录不超过 64 KiB（含持有方、ID 等外壳）；replace 一条超限整份都写不进去，所以镜像来的记录按 spec 的序列化大小留足余量。
const MAX_RECORD_BYTES = 62 * 1024;
const SAME_TIMEOUT_MS = 10_000;   // Magpie 插件自己 8 秒读不完就交空映射
const ARCHIVE_DAYS = 32;   // 归档从 32 天前所在的月初起，盖住「近 30 天」
const MAX_PAGES = 50;
const SOURCE_ID = /^[^\s/]{1,100}$/;
const SHARED_KINDS = [DAY_ARCHIVE_KIND, TODAY_CURVE_KIND, USAGE_RECORD_KIND];
const message = e => String(e?.message ?? e).slice(0, 200);
// 找不到网关的几种错：没装、没权限、服务还没就绪。
const NO_GATEWAY = new Set(['not_found', 'forbidden', 'service_unavailable']);
// 同一轮同步里各条发布的状态，按这个顺序取最要紧的一个当整体状态。
const STATE_ORDER = ['error', 'no_identity', 'needs_cert', 'paused', 'queued', 'synced'];
const worst = states => STATE_ORDER.find(one => states.includes(one));
// 本机已发记录的索引键带上作者：只用来知道要撤回哪些 ID，换了作者不会拿旧作者的 ID 去撤新作者的记录。
const publishedKey = (author, kind, id) => `${author}:${kind}:${id}`;
// 没有作者前缀的旧键：0.1.0 落盘的是 coda/token-usage 的记录 ID（`<UTC 日期>/<sourceId>`），也认 `<kind>:<id>`。
const OLD_USAGE_KEY = /^\d{4}-\d{2}-\d{2}\/[^\s/]{1,100}$/;
function oldKey(key) {
  const kind = SHARED_KINDS.find(candidate => key.startsWith(`${candidate}:`));
  if (kind) return { kind, id: key.slice(kind.length + 1) };
  return OLD_USAGE_KEY.test(key) ? { kind: USAGE_RECORD_KIND, id: key } : null;
}
// published.json 的键 key 若是 author 名下 kind 的记录（或没有作者前缀的旧键），它的记录 ID；否则 null。
function recordIdOf(key, author, kind) {
  const prefix = publishedKey(author, kind, '');
  if (key.startsWith(prefix)) return key.slice(prefix.length);
  const old = oldKey(key);
  return old?.kind === kind ? old.id : null;
}

let running = null;

export function activate(coda) {
  running?.stop();
  const board = new Board(coda);
  running = board;
  board.start();
}

export function deactivate() {
  running?.stop();
  running = null;
}

// 状态文件写盘：先写临时文件再改名，读到的不是半截。
function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value));
  renameSync(temporary, file);
}

class Board {
  constructor(coda) {
    this.coda = coda;
    this.dir = coda.plugin?.state ?? null;
    this.disposables = [];
    this.timers = new Set();
    this.queue = Promise.resolve();
    this.writes = Promise.resolve();   // 写目录记录排成一个序列
    this.stopped = false;
    this.ready = false;                // 第一轮同步做完之前不写记录：写出去的是全集，不能拿半份换掉上次的
    this.settings = { share: null };
    this.prefs = this.dir ? readJson(join(this.dir, 'prefs.json'), {}) : {};
    this.published = new Map(Object.entries(this.dir ? readJson(join(this.dir, 'published.json'), {}) : {}).filter(([key]) => key.includes(`:${DAY_ARCHIVE_KIND}:`) || key.includes(`:${TODAY_CURVE_KIND}:`) || oldKey(key)));
    this.source = this.loadSource();
    this.retired = new Set();
    this.gatewayAvailable = null; // 好友网关在不在：还没找过是 null
    this.gatewayUnready = false;  // 没找到网关是因为好友插件还没就绪（service_unavailable），不是没装：读不到，不当作它没有
    this.withdrawal = null;       // 关了分享后撤回没做完：{ state: 'error' | 'queued' | 'needs_cert' | 'no_identity' | 'paused', error }；做完是 null
    this.currentAuthor = null;   // 最近一次读到的本机好友作者
    this.lastSync = null;        // { state: 'synced' | 'needs_cert' | 'paused' | 'queued' | 'error', author }：哪个作者上次同步成了什么
    this.lastSyncAt = null;
    this.lastError = null;
    this.local = new Map();      // 本机用量记录的全集：月块日归档与 48 小时曲线，按 `<kind>\0<id>`
    this.friends = [];           // 好友网关给的好友作者
    this.mirror = new Map();     // 镜像来的签名记录的全集：`<作者>\0<kind>` → 这一批的 spec
    this.debounce = null;
  }

  // 本机的来源 ID：记录 ID 里带它，同一作者的多台设备靠它分开。`source.json` 是 `{ source: 'machine' | 'random', sourceId, legacy }`，
  // 旧版只有 `{ sourceId }`（随机 UUID）。`legacy` 是换成机器 ID 之前用过的随机 UUID。
  loadSource() {
    const saved = this.dir ? readJson(join(this.dir, 'source.json'), null) : null;
    if (typeof saved?.sourceId === 'string' && SOURCE_ID.test(saved.sourceId)) {
      return { source: saved.source === 'machine' ? 'machine' : 'random', sourceId: saved.sourceId,
        legacy: Array.isArray(saved.legacy) ? [...new Set(saved.legacy.filter(id => typeof id === 'string' && SOURCE_ID.test(id)))] : [] };
    }
    const source = { source: 'random', sourceId: randomUUID(), legacy: [] };
    this.save('source.json', source);
    return source;
  }
  get sourceId() { return this.source.sourceId; }
  // 机器 ID 稳定：读到了就从随机 UUID 切过去，旧的记进 legacy；读不到（或还没就绪）就沿用现在的，绝不重新生成。
  async refreshSource() {
    if (this.source.source === 'machine') return;
    let id;
    try { id = (await this.coda.list(MACHINE, { scope: 'local' })).find(entry => entry?.local)?.id; } catch { return; }
    if (typeof id !== 'string' || !SOURCE_ID.test(id)) return;
    const legacy = id === this.source.sourceId ? this.source.legacy : [...new Set([...this.source.legacy, this.source.sourceId])];
    this.source = { source: 'machine', sourceId: id, legacy };
    this.save('source.json', this.source);
  }
  save(name, value) {
    if (!this.dir) return;
    try { mkdirSync(this.dir, { recursive: true }); writeJson(join(this.dir, name), value); } catch (e) { console.error(`Token 消耗榜存不下 ${name}：`, message(e)); }
  }

  start() {
    const { coda } = this;
    this.disposables.push(coda.views.register('board', { open: () => {} }));
    this.disposables.push(coda.handle(KIND, 'set-share', async ({ on }) => {
      this.setShare(on);
      await this.reconcile();
      return { share: this.share };
    }));
    try {
      this.disposables.push(coda.settings.onChange(settings => {
        const before = this.share;
        this.applySettings(settings);
        if (this.share !== before) this.reconcile().catch(() => {});
      }));
    } catch (e) { console.error('Token 消耗榜听不到设置变化：', message(e)); }
    // 设置在首跳里读，不阻塞 activate；首跳之后每 10 分钟同步一次、每分钟重算曲线。
    const first = setTimeout(() => { this.timers.delete(first); this.begin().catch(() => {}); }, FIRST_SYNC_DELAY_MS);
    first.unref?.();
    this.timers.add(first);
  }
  async begin() {
    await this.readSettings();
    await this.loadRecords();
    if (this.stopped) return;
    for (const [work, every] of [[() => this.tick(), SYNC_INTERVAL_MS], [() => this.curveTick(), CURVE_INTERVAL_MS]]) {
      const timer = setInterval(() => { work().catch(() => {}); }, every);
      timer.unref?.();
      this.timers.add(timer);
    }
    await this.tick();
    if (!this.stopped) await this.watchFriends();
  }
  stop() {
    this.stopped = true;
    for (const timer of this.timers) { clearTimeout(timer); clearInterval(timer); }
    this.timers.clear();
    for (const disposable of this.disposables.splice(0)) { try { disposable.dispose(); } catch {} }
  }

  // ——— 设置与开关 ———

  async readSettings() {
    try { this.applySettings(await this.coda.settings.get()); } catch (e) { console.error('Token 消耗榜读不到设置：', message(e)); }
  }
  applySettings(settings) {
    const share = ((settings?.['token-board.share'] ?? settings?.share) ?? true) === true;
    // 首次读取保留页面存下的选择。之后设置里的开关变化才覆盖页面选择。
    if (this.settings.share !== null && share !== this.settings.share && this.prefs.share !== undefined) { delete this.prefs.share; this.save('prefs.json', this.prefs); }
    this.settings = { share };
  }
  get share() { return typeof this.prefs.share === 'boolean' ? this.prefs.share : this.settings.share === true; }
  // 同步状态：没开分享 disabled；没有好友网关 no_gateway；没有身份 no_identity；上次同步的是当前作者才沿用它的结果，否则 pending
  // （还没发布过、刚切了作者、刚从没身份恢复、关了再开后还没发布完）。
  syncStateFor(author) {
    if (!this.share) return 'disabled';
    if (this.gatewayAvailable === false) return 'no_gateway';
    if (!author) return 'no_identity';
    return this.lastSync?.author === author ? this.lastSync.state : 'pending';
  }
  setShare(on) {
    this.lastSync = null;
    this.prefs.share = on === true;
    if (on === true) this.withdrawal = null;
    this.save('prefs.json', this.prefs);
  }

  // ——— 目录里的记录 ———

  // 重启后先把自己已有的记录读回内存全集：之后哪一部分这一次读失败，就留着它的上一份，不拿空集合把目录里的覆盖掉。
  async loadRecords() {
    try {
      for (const { spec } of await this.coda.list(KIND, { scope: 'local' })) {
        if (spec.record === 'usage') this.local.set(`${spec.kind}\0${spec.id}`, spec);
        else if (spec.record === 'mirror') this.mirror.set(`${spec.author}\0${spec.kind}`, [...this.mirror.get(`${spec.author}\0${spec.kind}`) ?? [], spec]);
        else if (spec.record === 'state') this.friends = spec.friends;
      }
    } catch (e) { console.error('Token 消耗榜读不到已有的记录：', message(e)); }
  }
  // 三种记录各是一份全集，合起来整份交给 `coda.replace`：内容没变的记录宿主不重写。
  // 这台的状态；本机用量（月块日归档与曲线，只含当前作者与无身份的行）；镜像来的签名记录（好友与自己别的设备）。
  items() {
    const state = { record: 'state', share: this.share, syncState: this.syncStateFor(this.currentAuthor), lastSyncAt: this.lastSyncAt,
      error: this.share ? this.lastError : null, withdrawal: this.share ? null : this.withdrawal, author: this.currentAuthor, friends: this.friends };
    return [{ key: 'state', spec: state },
      ...[...this.local.values()].map(spec => ({ key: `usage/${spec.kind}/${spec.id}`, spec })),
      ...[...this.mirror.values()].flat().map(spec => ({ key: `mirror/${createHash('sha256').update(JSON.stringify([spec.author, spec.kind, spec.id])).digest('hex')}`, spec }))];
  }
  project() {
    if (!this.ready || this.stopped) return Promise.resolve();
    const next = this.writes.then(() => this.coda.replace(KIND, this.items()));
    this.writes = next.catch(e => console.error('Token 消耗榜写不进记录：', message(e)));
    return this.writes;
  }
  // 本机桶里算作当前作者的：有好友网关就按它的身份（没有身份只含无身份的行）；没装好友插件时没有作者可归属，不按身份切。
  async ownRows(gateway, from, to) {
    const fetched = (await fetchUsageBuckets(input => this.coda.query(USAGE, 'buckets', input), { from, to })).buckets;
    const buckets = markSame(fetched, ...await this.sameNames(fetched));
    return gateway ? ownBuckets(buckets, gateway.status.author ?? null) : buckets;
  }
  usageSpec(kind, id, body, author) { return { record: 'usage', kind, id, author, sourceId: this.sourceId, legacy: this.source.legacy, body }; }
  // 本机曲线约每分钟重算一次，只查最近 48 小时的桶。
  curveTick() {
    return this.serial(async () => {
      if (this.stopped) return;
      try {
        await this.refreshSource();
        const gateway = await this.gateway(), now = Date.now();
        const buckets = await this.ownRows(gateway, now - CURVE_HOURS * 3_600_000, now + 1);
        this.local.set(`${TODAY_CURVE_KIND}\0${this.sourceId}`, this.usageSpec(TODAY_CURVE_KIND, this.sourceId, buildTodayBody(buckets, { now }), gateway?.status.author ?? null));
      } catch (e) { console.error('Token 消耗榜算不出曲线：', message(e)); }
      await this.project();
    });
  }

  // 好友在两种时候重算：同步时，和好友网关有变化时（去抖）。
  async watchFriends() {
    let primed = false;
    try {
      this.disposables.push(await this.coda.watch(SOCIAL, () => { if (primed) this.later(); }, { scope: 'local' }));
    } catch {}   // 没装或没启用好友插件：没有可订阅的，同步时再看
    primed = true;
  }
  later() {
    clearTimeout(this.debounce);
    this.timers.delete(this.debounce);
    this.debounce = setTimeout(() => { this.timers.delete(this.debounce); this.mirrorTick().catch(() => {}); }, MIRROR_DEBOUNCE_MS);
    this.debounce.unref?.();
    this.timers.add(this.debounce);
  }
  mirrorTick() {
    return this.serial(async () => {
      if (this.stopped) return;
      try { await this.refreshMirror(await this.gateway()); } catch (e) { console.error('Token 消耗榜读不到好友的记录：', message(e)); }
      await this.project();
    });
  }
  // 好友网关里的好友（includePending: false）、好友与自己别的设备发布的三种记录，镜像成目录里的记录。本机自己发布的不镜像（本机用量记录就是它们的正本）。
  // 某个作者的某一种读失败，留着上一份，不让它从目录里消失；没有好友网关就清空。
  async refreshMirror(gateway) {
    if (!gateway) {
      if (!this.gatewayUnready) { this.friends = []; this.mirror.clear(); }
      return;
    }
    const self = gateway.status.author ?? null, mine = [this.sourceId, ...this.source.legacy];
    try {
      const read = await this.coda.query(gateway.ref, 'friends', { includePending: false });
      this.friends = [...new Set((Array.isArray(read.friends) ? read.friends : []).map(friend => friend?.author).filter(author => typeof author === 'string' && author))];
    } catch {}
    const authors = [...new Set([self, ...this.friends].filter(Boolean))];
    for (const key of [...this.mirror.keys()]) if (!authors.includes(key.split('\0')[0])) this.mirror.delete(key);
    for (const author of authors) {
      for (const kind of SHARED_KINDS) {
        let read;
        try { read = await this.fetchAllRecords(gateway.ref, { kind, author }); } catch { continue; }
        const specs = read.records
          .filter(record => typeof record?.id === 'string' && record.id.length <= 256 && Number.isFinite(record.version) && record.body && typeof record.body === 'object' && !Array.isArray(record.body)
            && !(author === self && mine.some(sourceId => ownedBySource(kind, record.id, sourceId))))
          .map(record => ({ record: 'mirror', author, kind, id: record.id, version: record.version, body: record.body }))
          .filter(spec => Buffer.byteLength(JSON.stringify(spec)) <= MAX_RECORD_BYTES);
        this.mirror.set(`${author}\0${kind}`, specs);
      }
    }
  }

  // 本机 Magpie 插件的同型号映射，`[names, services]`：`names` 是 `{ [asked]: 名字 }`，`services` 是本机 Magpie 插件提供的模型服务的引用（只有走这些服务的行才套映射）。
  // 只在有行用得上时读，没装、没启动、读不到或超时都是没有映射，不抛错。
  async sameNames(buckets) {
    if (!needsSame(buckets)) return [{}, []];
    try {
      const entry = (await this.coda.list(SAME, { scope: 'local' }))?.[0];
      const { names, services } = await this.coda.query({ kind: SAME, id: entry.id }, 'names', {}, { timeout: SAME_TIMEOUT_MS });
      return [names, services];
    } catch { return [{}, []]; }
  }
  // 好友网关（friends/social@1）：本机记录里取第一条；没装、没权限、服务没就绪，或没有记录，都是 null（没有网关），不抛错。
  async gateway() {
    let entry;
    this.gatewayUnready = false;
    try { entry = (await this.coda.list(SOCIAL, { scope: 'local' }))?.[0]; } catch (e) { if (!NO_GATEWAY.has(e?.code)) throw e; this.gatewayUnready = e.code === 'service_unavailable'; }
    this.gatewayAvailable = Boolean(entry);
    const status = entry?.status ?? {};
    this.observe(entry ? status.author ?? null : null);
    return entry ? { ref: { kind: SOCIAL, id: entry.id }, status } : null;
  }
  // 翻页读网关的记录，沿 nextCursor 往后；cursor 重复或翻得太多页就停，标记为没读全。
  async fetchAllRecords(ref, query) {
    const records = [], seen = new Set();
    let cursor;
    for (let page = 0; page < MAX_PAGES; page++) {
      const read = await this.coda.query(ref, 'records', { ...query, limit: 200, ...(cursor ? { cursor } : {}) });
      records.push(...(read?.records ?? []));
      cursor = read?.nextCursor;
      if (!read?.truncated) return { records, truncated: false };
      if (!cursor || seen.has(cursor)) break;
      seen.add(cursor);
    }
    return { records, truncated: true };
  }

  // ——— 发布与撤回（一次一件，按顺序做） ———

  serial(work) {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }
  async tick() {
    if (this.stopped) return;
    await this.readSettings();
    // 关着分享、索引里还有发布过的记录：上次没撤完，再撤一次（排了队的等续签之后能确认）。
    if (!this.share && this.published.size) await this.withdraw();
    await this.sync();
  }
  // 开关变了：开就同步一次，关就撤回；做完把状态写进目录。
  async reconcile() {
    if (this.stopped) return;
    this.lastSync = null;
    if (this.share) await this.sync(); else await this.withdraw();
    await this.project();
  }

  // 每轮同步：重算本机的月块日归档与曲线、镜像好友的记录，把全集写进目录；分享开着时再把归档与曲线交给好友网关发布：
  // 规范哈希去重、证书过期与暂停时的排队、恢复后自动补发都在网关里；没有网关就不发布，不碰上次同步的结果。
  sync() {
    return this.serial(async () => {
      if (this.stopped) return;
      if (this.share) this.lastError = null;
      let author = null;
      try {
        await this.refreshSource();
        const gateway = await this.gateway();
        author = gateway?.status.author ?? null;
        const now = Date.now(), d = new Date(now - ARCHIVE_DAYS * DAY_MS);
        const from = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1), sourceId = this.sourceId;
        // 本机用量记录与发布的都只有这个作者名下的用量：person 是它或无身份的行；别的身份的行不进以它签名的记录。
        const buckets = await this.ownRows(gateway, from, now + 1);
        const jobs = [...Object.entries(buildArchiveBodies(buckets)).map(([part, body]) => [DAY_ARCHIVE_KIND, `${sourceId}/${part}`, body]), [TODAY_CURVE_KIND, sourceId, buildTodayBody(buckets, { now })]];
        this.local = new Map(jobs.map(([kind, id, body]) => [`${kind}\0${id}`, this.usageSpec(kind, id, body, author)]));
        await this.refreshMirror(gateway);
        if (!this.share || !gateway) return;
        const { certState, pausedKinds = [] } = gateway.status;
        const sent = [];
        let switched = false;
        for (const [kind, id, body] of jobs) {
          let result;
          try { result = await this.coda.call(gateway.ref, 'publish', { kind, id, body }); } catch (e) { result = { state: 'error', error: message(e) }; }
          if (result.state === 'error') this.lastError = `发布 ${id} 失败：${result.error ?? '未知错误'}`;
          else {
            // 按网关实际签名的作者登记；途中身份换了，后面的清理与成功确认都不再基于旧作者。
            if (result.author && result.author !== author) { switched = true; author = this.observe(result.author); }
            if (author) this.published.set(publishedKey(author, kind, id), true);
          }
          if (!result.skipped) sent.push(result.state);
        }
        if (switched) { this.lastSync = null; this.save('published.json', Object.fromEntries(this.published)); return; }
        // 全是网关已同步过的（没有新记录可发），整体状态看网关自己的证书与暂停情况。
        let state = worst(sent)
          ?? (!author ? 'no_identity' : certState === 'needs_cert' ? 'needs_cert' : pausedKinds.some(kind => jobs.some(job => job[0] === kind)) ? 'paused' : 'synced');
        // 月块拆法变了（整月 ↔ 半月 ↔ 周），同一个月里不再用的旧块逐条（带 id）撤回，免得和新块重复；撤回没确认完成，整体就不是 synced。
        if (state === 'synced') {
          const months = new Set(jobs.filter(([kind]) => kind === DAY_ARCHIVE_KIND).map(([, id]) => id.split('/')[1].slice(0, 7)));
          const current = new Set(jobs.map(([kind, id]) => publishedKey(author, kind, id)));
          const prefix = publishedKey(author, DAY_ARCHIVE_KIND, '');
          const stale = [];
          for (const key of [...this.published.keys()]) {
            const id = key.slice(prefix.length);
            if (!key.startsWith(prefix) || current.has(key) || !ownedBySource(DAY_ARCHIVE_KIND, id, sourceId) || !months.has(id.split('/')[1].slice(0, 7))) continue;
            const result = await this.retractOne(gateway.ref, DAY_ARCHIVE_KIND, id);
            if (result.state === 'retracted') this.published.delete(key);
            else if (result.state === 'error') this.lastError = `撤回 ${id} 失败：${result.error ?? '未知错误'}`;
            else stale.push(result.state);
          }
          state = worst([state, ...stale]);
        }
        this.save('published.json', Object.fromEntries(this.published));
        if (state === 'synced' && !this.lastError) state = worst([state, await this.retireLegacy(gateway, author)]);
        if (this.lastError) state = 'error';
        this.lastSync = { state, author };
        if (state === 'synced') this.lastSyncAt = Date.now();
      } catch (e) {
        this.lastError = message(e);
        if (author) this.lastSync = { state: 'error', author };
      } finally {
        this.ready = true;
        await this.project();
      }
    });
  }

  // 记下最近读到的作者；读不到、或换成了别的作者，上次的同步结果就作废（A → B → A 也不恢复旧的 synced），从 pending 重新算。
  observe(author) {
    this.currentAuthor = author;
    if (!author || (this.lastSync && author !== this.lastSync.author)) this.lastSync = null;
    return author;
  }

  // 经网关撤回一条记录，一定带 id：网关省略 id 会按 kind 把同作者所有记录都撤了，包括别的设备的。
  async retractOne(ref, kind, id) {
    try { return await this.coda.call(ref, 'retract', { kind, id }); } catch (e) { return { state: 'error', error: message(e) }; }
  }

  // 把 sourceIds 名下的记录（三种 kind）逐条经网关撤回：远端查到的（有作者才查，只取非空记录体）、网关待发队列里的、本机 published.json 记着发过的。
  // 没有身份时网关的撤回只取消本机还没发出去的待发项，返回 no_identity，这也算撤完。
  // 返回 { complete, state }：查询被截断或有一条没撤回成（排了队、出错），complete 为 false，本机索引原样留着下次再清；已确认撤回的键等整轮完成才一起删。
  async retire(gateway, author, sourceIds) {
    let complete = true;
    const states = [], confirmed = [];
    const fail = text => { this.lastError = text; complete = false; states.push('error'); };
    for (const kind of SHARED_KINDS) {
      const owned = id => sourceIds.some(sourceId => ownedBySource(kind, id, sourceId));
      const emptyBody = body => !body || !Object.keys(body).length || isWithdrawn(kind, body);
      const ids = new Set();
      if (author) {
        const read = await this.fetchAllRecords(gateway.ref, { kind, author });
        if (read.truncated) fail('记录太多，没能查全，旧记录可能还没撤回完');
        for (const record of read.records) if (owned(record.id) && !emptyBody(record.body)) ids.add(record.id);
      }
      for (const item of (await this.coda.query(gateway.ref, 'outbox', { kind })).items ?? []) if (item.desired === 'publish' && owned(item.id)) ids.add(item.id);
      // 本机记着发过的，即使远端这次没查到（落在截断页外、还在网关队列里）也按记着的 ID 撤；键有带作者的，也有 0.1.0 没有作者前缀的。
      const keysOf = new Map();
      for (const key of this.published.keys()) {
        const id = recordIdOf(key, author, kind);
        if (id === null || !owned(id)) continue;
        keysOf.set(id, [...(keysOf.get(id) ?? []), key]);
        ids.add(id);
      }
      for (const id of ids) {
        const result = await this.retractOne(gateway.ref, kind, id);
        if (result.state === 'retracted' || (!author && result.state === 'no_identity')) { confirmed.push(...keysOf.get(id) ?? []); continue; }
        if (result.state === 'error') fail(`撤回 ${id} 失败：${result.error ?? '未知错误'}`);
        else { complete = false; states.push(result.state); }
      }
    }
    if (complete) for (const key of confirmed) this.published.delete(key);
    return { complete, state: worst(states) ?? 'synced' };
  }
  // 换成机器 ID 之前的随机 UUID 留下的记录，同步成功后撤回；没撤回完整就下次同步再来。返回这一步的状态。
  async retireLegacy(gateway, author) {
    const todo = this.source.legacy.filter(id => !this.retired.has(id));
    if (!todo.length) return 'synced';
    let state = 'synced';
    try {
      const done = await this.retire(gateway, author, todo);
      state = done.state;
      if (done.complete) for (const id of todo) this.retired.add(id);
    } catch (e) { this.lastError = message(e); }
    this.save('published.json', Object.fromEntries(this.published));
    return state;
  }

  withdraw() {
    return this.serial(async () => {
      this.lastError = null;
      try {
        // 读网关抛错要当失败（保留已发布索引等重试）；没有网关没法撤，也保留索引。有网关就一定逐条撤：没有身份时网关里可能还排着本机的待发项，要取消掉。
        const gateway = await this.gateway();
        if (!gateway) {
          this.lastError = '未安装或未启用好友插件，无法撤回好友可见记录';
          this.withdrawal = this.published.size ? { state: 'error', error: this.lastError } : null;   // 没发布过什么，就没有要撤的
          return;
        }
        // 本机的和 legacy 的都撤。没查全或没撤回成的，不当作已撤回。
        const done = await this.retire(gateway, gateway.status.author ?? null, [this.sourceId, ...this.source.legacy]);
        if (done.complete) this.published.clear();
        this.withdrawal = done.complete ? null : { state: done.state, error: done.state === 'error' ? this.lastError : null };
        this.save('published.json', Object.fromEntries(this.published));
      } catch (e) {
        this.lastError = message(e);
        this.withdrawal = { state: 'error', error: this.lastError };
      }
    });
  }
}
