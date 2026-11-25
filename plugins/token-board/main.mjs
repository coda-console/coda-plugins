// Token 消耗榜的模块（Coda 的 docs/plugins.md「插件宿主」）。随后端启动（onStartupFinished）：
// - 读本机用量（coda/usage@1 的 buckets，只读、不推送，所以按需拉取）；统计、多机聚合和当天曲线只靠本机用量与已读到的记录，不依赖签名发布；
// - 好友能力只经可选的 friends/social@1 网关：分享开着时，每 10 分钟把月块日归档（`coda/token-day`）和 48 小时曲线（`coda/token-today`）交给网关发布，
//   规范哈希去重、证书过期与暂停的排队、恢复后自动补发都由网关负责；没装或停用好友插件时，本机统计与曲线照常，分享状态报 no_gateway；
// - 来源 ID 优先用 coda/machine@1 里本机的稳定 ID，读不到就沿用上次的，不会因为一时读不到换成新的随机 UUID；
// - 关掉分享或手动撤回，就按本机 sourceId 筛出自己的记录，逐条（带 id）经网关撤回，好友不再看得到；绝不按 kind 批量撤回，免得误撤同作者其他设备的记录；
// - 页面（view `board`）通过消息读状态、切开关、立即同步、取榜单。
// `activate` 里不读任何记录：初始化的读取放在延迟的定时器和页面消息里，并且全都 try/catch。
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DAY_ARCHIVE_KIND, DAY_MS, RANGES, SLOT_MS, TODAY_CURVE_KIND, USAGE_RECORD_KIND, aggregateLeaderboard, aggregateTodayCurve, buildArchiveBodies, buildTodayBody,
  fetchUsageBuckets, isWithdrawn, ownedBySource, rangeWindow, summarizeBuckets,
} from './lib/usage.mjs';

const USAGE = { kind: 'coda/usage@1', id: 'local' };
const SOCIAL = 'friends/social@1';
const MACHINE = 'coda/machine@1';
export const SYNC_INTERVAL_MS = 10 * 60_000;
export const FIRST_SYNC_DELAY_MS = 5_000;
const ARCHIVE_DAYS = 32;   // 归档从 32 天前所在的月初起，盖住「近 30 天」
const MAX_PAGES = 50;
const MESSAGE_LIMIT = 128 * 1024;   // 宿主转给页面的消息上限（plugin-host 的 MESSAGE_LIMIT，按 JSON.stringify 的长度量）
const SOURCE_ID = /^[^\s/]{1,100}$/;
const SHARED_KINDS = [DAY_ARCHIVE_KIND, TODAY_CURVE_KIND, USAGE_RECORD_KIND];
const message = e => String(e?.message ?? e).slice(0, 200);
// 找不到网关的几种错：没装、没权限、服务还没就绪。
const NO_GATEWAY = new Set(['not_found', 'forbidden', 'service_unavailable']);
// 同一轮同步里各条发布的状态，按这个顺序取最要紧的一个当整体状态。
const STATE_ORDER = ['error', 'no_identity', 'needs_cert', 'paused', 'queued', 'synced'];
const worst = states => STATE_ORDER.find(one => states.includes(one));
const RETRACT_NOTES = { needs_cert: '代签证书已过期，撤回已排队，续签后将自动完成', queued: '撤回已排队，稍后将自动完成', no_identity: '这台机器还没有好友身份，撤回暂未完成' };
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
    this.views = new Set();
    this.disposables = [];
    this.timers = new Set();
    this.queue = Promise.resolve();
    this.stopped = false;
    this.settings = { share: null, range: '7d' };
    this.prefs = this.dir ? readJson(join(this.dir, 'prefs.json'), {}) : {};
    this.published = new Map(Object.entries(this.dir ? readJson(join(this.dir, 'published.json'), {}) : {}).filter(([key]) => key.includes(`:${DAY_ARCHIVE_KIND}:`) || key.includes(`:${TODAY_CURVE_KIND}:`) || oldKey(key)));
    this.source = this.loadSource();
    this.retired = new Set();
    this.gatewayAvailable = null; // 好友网关在不在：还没找过是 null
    this.currentAuthor = null;   // 最近一次读到的本机好友作者
    this.pushedState = null;     // 上次推给页面的 syncState
    this.lastSync = null;        // { state: 'synced' | 'needs_cert' | 'paused' | 'queued' | 'error', author }：哪个作者上次同步成了什么
    this.lastSyncAt = null;
    this.lastError = null;
    this.notice = null;
    this.retractNote = null;     // 撤回排了队没做完时给页面的提示
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
    this.disposables.push(coda.views.register('board', { open: view => this.open(view) }));
    try {
      this.disposables.push(coda.settings.onChange(settings => {
        const before = this.share;
        this.applySettings(settings);
        if (this.share !== before) this.reconcile(this.share ? '已开启分享' : '已关闭分享，已撤回发布的记录').catch(() => {}); else this.tell(this.notice);
      }));
    } catch (e) { console.error('Token 消耗榜听不到设置变化：', message(e)); }
    // 设置在首跳里读，不阻塞 activate；首跳之后每 10 分钟一次。
    const first = setTimeout(() => { this.timers.delete(first); this.begin().catch(() => {}); }, FIRST_SYNC_DELAY_MS);
    first.unref?.();
    this.timers.add(first);
  }
  async begin() {
    await this.readSettings();
    if (this.stopped) return;
    const every = setInterval(() => { this.tick().catch(() => {}); }, SYNC_INTERVAL_MS);
    every.unref?.();
    this.timers.add(every);
    await this.tick();
  }
  stop() {
    this.stopped = true;
    for (const timer of this.timers) { clearTimeout(timer); clearInterval(timer); }
    this.timers.clear();
    for (const disposable of this.disposables.splice(0)) { try { disposable.dispose(); } catch {} }
    this.views.clear();
  }

  // ——— 设置与开关 ———

  async readSettings() {
    try { this.applySettings(await this.coda.settings.get()); } catch (e) { console.error('Token 消耗榜读不到设置：', message(e)); }
  }
  applySettings(settings) {
    const value = key => settings?.[`token-board.${key}`] ?? settings?.[key];
    const share = (value('share') ?? true) === true, range = RANGES.includes(value('range')) ? value('range') : '7d';
    // 首次读取保留页面存下的选择。之后设置里的开关变化才覆盖页面选择。
    if (this.settings.share !== null && share !== this.settings.share && this.prefs.share !== undefined) { delete this.prefs.share; this.save('prefs.json', this.prefs); }
    this.settings = { share, range };
  }
  get share() { return typeof this.prefs.share === 'boolean' ? this.prefs.share : this.settings.share === true; }
  // board() 和 status() 共用的同步状态：没开分享 disabled；没有好友网关 no_gateway；没有身份 no_identity；上次同步的是当前作者才沿用它的结果，否则 pending
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
    this.save('prefs.json', this.prefs);
  }

  // ——— 页面 ———

  open(view) {
    this.views.add(view);
    view.onMessage(request => { this.handle(view, request).catch(e => view.postMessage({ type: 'error', request: request?.type, id: request?.id, message: message(e) })); });
    view.onClose(() => this.views.delete(view));
  }
  status() {
    this.pushedState = this.syncStateFor(this.currentAuthor);
    return { type: 'status', share: this.share, fromSettings: this.prefs.share === undefined, range: this.settings.range, lastSyncAt: this.lastSyncAt, lastError: this.lastError,
      published: this.published.size, notice: this.notice, syncState: this.syncStateFor(this.currentAuthor) };
  }
  tell(text) {
    this.notice = text;
    for (const view of this.views) view.postMessage(this.status());
  }
  async handle(view, request) {
    switch (request?.type) {
      case 'hello':
        await this.readSettings();
        await this.gateway().catch(() => null);
        view.postMessage(this.status());
        return;
      case 'board': {
        const range = RANGES.includes(request.range) ? request.range : this.settings.range;
        const result = await this.board(range, request.id, request);
        // 宿主丢弃超过上限的消息，页面既收不到回包也收不到错误：量过，放不下就回一个送得到的失败。
        if (JSON.stringify({ message: result }).length > MESSAGE_LIMIT) throw new Error(`榜单明细超过宿主 ${MESSAGE_LIMIT / 1024} KiB 的消息上限，没能送达`);
        view.postMessage(result);
        return;
      }
      case 'set-share':
        this.setShare(request.on === true);
        this.notice = null;
        await this.reconcile(request.on === true ? '已开启分享' : '已关闭分享，已撤回发布的记录');
        return;
      case 'sync':
        if (!this.share) { this.tell('分享还没开启，没有可同步的内容'); return; }
        await this.sync();
        this.tell(this.outcome('已同步'));
        return;
      case 'withdraw':
        this.setShare(false);
        await this.withdraw();
        this.tell(this.lastError ? null : this.retractNote ?? '已撤回发布的记录，分享保持关闭');
        return;
      default:
    }
  }

  // ——— 榜单 ———

  // 统计只靠本机用量和已读到的记录：好友网关、好友、各种记录读不到都只记一条提示，本机统计与曲线照常返回。
  // 窗口优先用页面发来的 from、to（几台电脑共用同一段时间）；没带或不成窗口才按本机的当地时间由 range 算。
  async board(range, id, asked) {
    const now = Date.now();
    const { from, to } = Number.isFinite(asked?.from) && Number.isFinite(asked?.to) && asked.from < asked.to ? asked : rangeWindow(range, now);
    await this.refreshSource();
    const result = { type: 'board', id, range, from, to, share: this.share, accord: false, selfAuthor: null, errors: [], truncated: { usage: false, friends: false },
      friendCount: 0, local: null, people: [], sources: [], retired: [], curve: [], syncState: this.share ? 'no_gateway' : 'disabled' };
    let localBuckets = null;   // null：本机用量没读到，不能当成「没有用量」
    try {
      const fetched = await fetchUsageBuckets(input => this.coda.query(USAGE, 'buckets', input), { from, to });
      localBuckets = fetched.buckets;
      result.truncated.usage = fetched.truncated;
    } catch (e) { result.errors.push(`读不到本机用量：${message(e)}`); }
    result.local = localBuckets && summarizeBuckets(localBuckets, { from, to });

    let gateway = null, friends = [], selfAuthor = null;
    try { gateway = await this.gateway(); } catch (e) { result.errors.push(`读不到好友：${message(e)}`); }
    const records = { [USAGE_RECORD_KIND]: [], [DAY_ARCHIVE_KIND]: [], [TODAY_CURVE_KIND]: [] };
    if (gateway) {
      result.accord = true;
      try {
        const read = await this.coda.query(gateway.ref, 'friends', { includePending: false });
        selfAuthor = read.selfAuthor ?? null;
        friends = Array.isArray(read.friends) ? read.friends : [];
      } catch (e) { result.errors.push(`读不到好友：${message(e)}`); }
      result.selfAuthor = selfAuthor;
      this.observe(selfAuthor);
      result.friendCount = friends.length;
      const authors = [...new Set([selfAuthor, ...friends.map(friend => friend?.author)].filter(author => typeof author === 'string' && author))];
      for (const author of authors) {
        let failed = false;
        for (const kind of SHARED_KINDS) {
          try {
            const read = await this.fetchAllRecords(gateway.ref, { kind, author });
            records[kind].push(...read.records);
            if (read.truncated) result.truncated.friends = true;
          } catch (e) { failed = true; }
        }
        if (failed) result.errors.push('读不到一位好友的用量');
      }
    }
    const shared = { selfAuthor, selfSourceId: this.sourceId, excludedSourceIds: this.source.legacy, localBuckets, friends };
    const board = aggregateLeaderboard({ ...shared, legacyUsageRecords: records[USAGE_RECORD_KIND], dayRecords: records[DAY_ARCHIVE_KIND], todayRecords: records[TODAY_CURVE_KIND], from, to });
    // 页面用 sources 算合计，用 people 的作者地址映射显示 ID，并读取分享状态。
    result.people = board.entries.map(({ author, self, shared }) => ({ author, self, shared }));
    result.sources = board.sources;
    result.retired = this.source.legacy;   // 这台已弃用的旧来源 ID：别的机器读到它们的旧副本时统一不算
    result.curve = aggregateTodayCurve({ ...shared, localBuckets: localBuckets ?? [], todayRecords: records[TODAY_CURVE_KIND], range: rangeWindow('today', now), slotMs: SLOT_MS }).curve;
    result.syncState = this.syncStateFor(selfAuthor);
    // 榜单读到的状态和页面上次拿到的不一样（比如好友网关没了），把最新状态推给页面，免得旧的状态盖住它。
    if (result.syncState !== this.pushedState) this.tell(this.notice);
    return result;
  }

  // 好友网关（friends/social@1）：本机记录里取第一条；没装、没权限、服务没就绪，或没有记录，都是 null（没有网关），不抛错。
  async gateway() {
    let entry;
    try { entry = (await this.coda.list(SOCIAL, { scope: 'local' }))?.[0]; } catch (e) { if (!NO_GATEWAY.has(e?.code)) throw e; }
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
    if (!this.share) return;
    const before = [this.syncStateFor(this.currentAuthor), this.lastError];
    await this.sync();
    // 定时同步让状态变了（进入或离开 needs_cert 等），已经打开的页面也跟着更新。
    if (before[0] !== this.syncStateFor(this.currentAuthor) || before[1] !== this.lastError) this.tell(this.notice);
  }
  // 开关变了：开就同步一次，关就撤回。
  async reconcile(text) {
    if (this.stopped) return;
    this.lastSync = null;
    if (this.share) await this.sync(); else await this.withdraw();
    this.tell(this.outcome(text));
  }
  // 操作做完后给页面的提示：失败不另写（页面显示失败原因）；没身份说一声；证书过期、暂停、没有好友网关由页面单独提示；撤回排了队就说明白。
  outcome(text) {
    const state = this.syncStateFor(this.currentAuthor);
    if (this.lastError || ['needs_cert', 'paused', 'no_gateway'].includes(state)) return null;
    if (state === 'queued') return '已提交好友网关排队，稍后自动同步';
    if (state === 'pending') return '身份已切换，本轮同步尚未确认';
    if (this.retractNote) return this.retractNote;
    return state === 'no_identity' ? '这台机器还没有好友身份，暂时无法向好友发布' : text;
  }

  // 发布交给好友网关：规范哈希去重、证书过期与暂停时的排队、恢复后自动补发都在网关里；没有网关就安静返回，不碰上次同步的结果。
  sync() {
    return this.serial(async () => {
      if (this.stopped || !this.share) return;
      this.lastError = null;
      this.retractNote = null;
      let author = null;
      try {
        await this.refreshSource();
        const gateway = await this.gateway();
        if (!gateway) return;
        author = gateway.status.author ?? null;
        const { certState, pausedKinds = [] } = gateway.status;
        const now = Date.now(), d = new Date(now - ARCHIVE_DAYS * DAY_MS);
        const from = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1), sourceId = this.sourceId;
        const { buckets } = await fetchUsageBuckets(input => this.coda.query(USAGE, 'buckets', input), { from, to: now + 1 });
        const jobs = [...Object.entries(buildArchiveBodies(buckets)).map(([part, body]) => [DAY_ARCHIVE_KIND, `${sourceId}/${part}`, body]), [TODAY_CURVE_KIND, sourceId, buildTodayBody(buckets, { now })]];
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
        else { complete = false; states.push(result.state); this.retractNote = RETRACT_NOTES[result.state] ?? null; }
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
      this.retractNote = null;
      try {
        // 读网关抛错要当失败（保留已发布索引等重试）；没有网关没法撤，也保留索引。有网关就一定逐条撤：没有身份时网关里可能还排着本机的待发项，要取消掉。
        const gateway = await this.gateway();
        if (!gateway) { this.lastError = '未安装或未启用好友插件，无法撤回好友可见记录'; return; }
        // 本机的和 legacy 的都撤。没查全或没撤回成的，不当作已撤回。
        if ((await this.retire(gateway, gateway.status.author ?? null, [this.sourceId, ...this.source.legacy])).complete) this.published.clear();
        this.save('published.json', Object.fromEntries(this.published));
      } catch (e) { this.lastError = message(e); }
    });
  }
}
