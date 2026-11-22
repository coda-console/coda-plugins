// Token 消耗榜的模块（Coda 的 docs/plugins.md「插件宿主」）。随后端启动（onStartupFinished）：
// - 读本机用量（coda/usage@1 的 buckets，只读、不推送，所以按需拉取）；统计、多机聚合和当天曲线只靠本机用量与已读到的记录，不依赖签名发布；
// - 分享开着时，每 10 分钟把月块日归档（`coda/token-day`）和 48 小时曲线（`coda/token-today`）发给好友（coda/accord@1 的 publish），内容没变就不重发；
//   签名证书过期（publish 报 invalid_state）就安静停下，不记 hash，续签后下一次同步自动补发；
// - 来源 ID 优先用 coda/machine@1 里本机的稳定 ID，读不到就沿用上次的，不会因为一时读不到换成新的随机 UUID；
// - 关掉分享或手动撤回，就把本机发布过的记录以 audience [] 重发，好友不再看得到；
// - 页面（view `board`）通过消息读状态、切开关、立即同步、取榜单。
// `activate` 里不读任何记录：初始化的读取放在延迟的定时器和页面消息里，并且全都 try/catch。
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DAY_ARCHIVE_KIND, DAY_MS, PROFILE_RECORD_KIND, RANGES, SLOT_MS, TODAY_CURVE_KIND, USAGE_RECORD_KIND, aggregateLeaderboard, aggregateTodayCurve, buildArchiveBodies, buildTodayBody,
  fetchUsageBuckets, isWithdrawn, ownedBySource, rangeWindow, summarizeBuckets, withdrawnBody,
} from './lib/usage.mjs';

const USAGE = { kind: 'coda/usage@1', id: 'local' };
const ACCORD = { kind: 'coda/accord@1', id: 'local' };
const MACHINE = 'coda/machine@1';
export const SYNC_INTERVAL_MS = 10 * 60_000;
export const FIRST_SYNC_DELAY_MS = 5_000;
const ARCHIVE_DAYS = 32;   // 归档从 32 天前所在的月初起，盖住「近 30 天」
const SOURCE_ID = /^[^\s/]{1,100}$/;
const SHARED_KINDS = [DAY_ARCHIVE_KIND, TODAY_CURVE_KIND, USAGE_RECORD_KIND];
const message = e => String(e?.message ?? e).slice(0, 200);
// 已发布内容的去重键带上作者：24 小时证书换了根作者，旧作者的 hash 不会挡住新作者的发布。
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
    this.settings = { share: false, range: '7d' };
    this.prefs = this.dir ? readJson(join(this.dir, 'prefs.json'), {}) : {};
    this.published = new Map(Object.entries(this.dir ? readJson(join(this.dir, 'published.json'), {}) : {}).filter(([key]) => key.includes(`:${DAY_ARCHIVE_KIND}:`) || key.includes(`:${TODAY_CURVE_KIND}:`) || oldKey(key)));
    this.source = this.loadSource();
    this.retired = new Set();
    this.currentAuthor = null;   // 最近一次读到的本机 Accord 作者
    this.pushedState = null;     // 上次推给页面的 syncState
    this.lastSync = null;        // { state: 'synced' | 'needs_cert' | 'error', author }：哪个作者上次同步成了什么
    this.lastSyncAt = null;
    this.lastError = null;
    this.notice = null;
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
    const share = value('share') === true, range = RANGES.includes(value('range')) ? value('range') : '7d';
    // 设置里的开关一改，页面上临时切的就作废，以设置为准。
    if (share !== this.settings.share && this.prefs.share !== undefined) { delete this.prefs.share; this.save('prefs.json', this.prefs); }
    this.settings = { share, range };
  }
  get share() { return typeof this.prefs.share === 'boolean' ? this.prefs.share : this.settings.share; }
  // board() 和 status() 共用的同步状态：没开分享 disabled；没有身份 no_identity；上次同步的是当前作者才沿用它的结果，否则 pending
  // （还没发布过、刚切了作者、刚从没身份恢复、关了再开后还没发布完）。
  syncStateFor(author) {
    if (!this.share) return 'disabled';
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
    view.onMessage(request => { this.handle(view, request).catch(e => view.postMessage({ type: 'error', message: message(e) })); });
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
        await this.author();
        view.postMessage(this.status());
        return;
      case 'board': {
        const range = RANGES.includes(request.range) ? request.range : this.settings.range;
        view.postMessage(await this.board(range, request.id));
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
        this.tell(this.lastError ? null : '已撤回发布的记录，分享保持关闭');
        return;
      default:
    }
  }

  // ——— 榜单 ———

  // 统计只靠本机用量和已读到的记录：Accord、好友、各种记录读不到都只记一条提示，本机统计与曲线照常返回。
  async board(range, id) {
    const now = Date.now();
    const { from, to } = rangeWindow(range, now);
    await this.refreshSource();
    const result = { type: 'board', id, range, from, to, share: this.share, accord: false, selfAuthor: null, errors: [], truncated: { usage: false, friends: false, profiles: false },
      friendCount: 0, local: null, entries: [], curve: [], syncState: 'disabled' };
    let localBuckets = [];
    try {
      const fetched = await fetchUsageBuckets(input => this.coda.query(USAGE, 'buckets', input), { from, to });
      localBuckets = fetched.buckets;
      result.truncated.usage = fetched.truncated;
    } catch (e) { result.errors.push(`读不到本机用量：${message(e)}`); }
    result.local = summarizeBuckets(localBuckets, { from, to });

    let friends = [], selfAuthor = null;
    try {
      const accord = await this.coda.get(ACCORD);
      if (accord) { result.accord = true; selfAuthor = accord.spec?.author ?? null; friends = Array.isArray(accord.status?.friends) ? accord.status.friends : []; }
    } catch (e) { result.errors.push(`读不到好友：${message(e)}`); }
    result.selfAuthor = selfAuthor;
    this.observe(selfAuthor);
    result.friendCount = friends.length;

    const records = { [USAGE_RECORD_KIND]: [], [DAY_ARCHIVE_KIND]: [], [TODAY_CURVE_KIND]: [] }, profiles = [];
    if (result.accord) {
      const authors = [...new Set([selfAuthor, ...friends.map(friend => friend?.author)].filter(author => typeof author === 'string' && author))];
      for (const author of authors) {
        let failed = false;
        for (const kind of SHARED_KINDS) {
          try {
            const read = await this.coda.query(ACCORD, 'records', { kind, author, limit: 200 });
            records[kind].push(...(read.records ?? []));
            if (read.truncated) result.truncated.friends = true;
          } catch (e) { failed = true; }
        }
        if (failed) result.errors.push('读不到一位好友的用量');
      }
      try {
        const read = await this.coda.query(ACCORD, 'records', { kind: PROFILE_RECORD_KIND, limit: 200 });
        profiles.push(...(read.records ?? []));
        if (read.truncated) result.truncated.profiles = true;
      } catch (e) { result.errors.push(`读不到好友名片：${message(e)}`); }
    }
    const shared = { selfAuthor, selfSourceId: this.sourceId, excludedSourceIds: this.source.legacy, localBuckets, friends };
    result.entries = aggregateLeaderboard({ ...shared, legacyUsageRecords: records[USAGE_RECORD_KIND], dayRecords: records[DAY_ARCHIVE_KIND], todayRecords: records[TODAY_CURVE_KIND], profileRecords: profiles, from, to }).entries;
    result.curve = aggregateTodayCurve({ ...shared, todayRecords: records[TODAY_CURVE_KIND], range: rangeWindow('today', now), slotMs: SLOT_MS }).curve;
    result.syncState = this.syncStateFor(selfAuthor);
    // 榜单读到的状态和页面上次拿到的不一样（比如 Accord 读不出了），把最新状态推给页面，免得旧的状态盖住它。
    if (result.syncState !== this.pushedState) this.tell(this.notice);
    return result;
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
  // 操作做完后给页面的提示：失败不另写（页面显示失败原因）；没身份说一声；证书过期由页面单独提示。
  outcome(text) {
    const state = this.syncStateFor(this.currentAuthor);
    if (this.lastError || state === 'needs_cert') return null;
    return state === 'no_identity' ? '这台机器还没有 Accord 身份，暂时无法向好友发布' : text;
  }

  // 签名发布是独立的异步投影：证书过期（invalid_state）时安静停下等续签，不影响统计；没发出去的不记 hash，下次同步一并补发。
  sync() {
    return this.serial(async () => {
      if (this.stopped || !this.share) return;
      this.lastError = null;
      let author = null;
      try {
        await this.refreshSource();
        author = await this.author();
        if (!author) return;
        const now = Date.now(), d = new Date(now - ARCHIVE_DAYS * DAY_MS);
        const from = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1), sourceId = this.sourceId;
        const { buckets } = await fetchUsageBuckets(input => this.coda.query(USAGE, 'buckets', input), { from, to: now + 1 });
        const jobs = [...Object.entries(buildArchiveBodies(buckets)).map(([part, body]) => [DAY_ARCHIVE_KIND, `${sourceId}/${part}`, body]), [TODAY_CURVE_KIND, sourceId, buildTodayBody(buckets, { now })]];
        let failed = 0, needsCert = false;
        for (const [kind, id, body] of jobs) {
          const key = publishedKey(author, kind, id), hash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
          if (this.published.get(key) === hash) continue;
          try {
            await this.coda.call(ACCORD, 'publish', { kind, id, body, audience: ['public'] });
            this.published.set(key, hash);
          } catch (e) {
            if (e?.code === 'invalid_state' || /证书|certificate/i.test(message(e))) { needsCert = true; break; }
            failed += 1; this.lastError = `发布 ${id} 失败：${message(e)}`;
          }
        }
        // 月块拆法变了（整月 ↔ 半月 ↔ 周），同一个月里不再用的旧块撤回，免得和新块重复。
        if (!needsCert && !failed) {
          const months = new Set(jobs.filter(([kind]) => kind === DAY_ARCHIVE_KIND).map(([, id]) => id.split('/')[1].slice(0, 7)));
          const current = new Set(jobs.map(([kind, id]) => publishedKey(author, kind, id)));
          const prefix = publishedKey(author, DAY_ARCHIVE_KIND, '');
          for (const key of [...this.published.keys()]) {
            const id = key.slice(prefix.length);
            if (!key.startsWith(prefix) || current.has(key) || !ownedBySource(DAY_ARCHIVE_KIND, id, sourceId) || !months.has(id.split('/')[1].slice(0, 7))) continue;
            try {
              await this.coda.call(ACCORD, 'publish', { kind: DAY_ARCHIVE_KIND, id, body: withdrawnBody(DAY_ARCHIVE_KIND), audience: [] });
              this.published.delete(key);
            } catch (e) { failed += 1; this.lastError = `撤回 ${id} 失败：${message(e)}`; }
          }
        }
        this.save('published.json', Object.fromEntries(this.published));
        if (!needsCert && !failed) await this.retireLegacy(author);
        this.lastSync = { state: needsCert ? 'needs_cert' : this.lastError ? 'error' : 'synced', author };
        if (this.lastSync.state === 'synced') this.lastSyncAt = Date.now();
      } catch (e) {
        this.lastError = message(e);
        if (author) this.lastSync = { state: 'error', author };
      }
    });
  }

  // 读不到身份（读取抛错或没有 spec.author）一律当没有身份。
  async author() {
    let author = null;
    try { author = (await this.coda.get(ACCORD))?.spec?.author || null; } catch {}
    return this.observe(author);
  }
  // 记下最近读到的作者；读不到、或换成了别的作者，上次的同步结果就作废（A → B → A 也不恢复旧的 synced），从 pending 重新算。
  observe(author) {
    this.currentAuthor = author;
    if (!author || (this.lastSync && author !== this.lastSync.author)) this.lastSync = null;
    return author;
  }

  // 把 sourceIds 名下的记录（三种 kind）以 audience [] 重发成空记录：远端查到的，加上本机 published.json 记着发过、这次没查到的；
  // 记录体已经是空的，就是上次撤回留下的，不再重发。查询被截断或有一条没撤回成，就记下错误并返回 false，留着下次再清。
  async retire(author, sourceIds) {
    let complete = true;
    const fail = text => { this.lastError = text; complete = false; };
    for (const kind of SHARED_KINDS) {
      const read = await this.coda.query(ACCORD, 'records', { kind, author, limit: 200 });
      if (read.truncated) fail('记录太多，没能查全，旧记录可能还没撤回完');
      const owned = id => sourceIds.some(sourceId => ownedBySource(kind, id, sourceId));
      const ids = new Set((read.records ?? []).filter(record => owned(record.id) && !isWithdrawn(kind, record.body)).map(record => record.id));
      const seen = new Set((read.records ?? []).map(record => record.id));
      // 本机记着发过、这次远端没查到的（比如落在截断页外的），也按记着的 ID 撤；键有带作者的，也有 0.1.0 没有作者前缀的。
      const keysOf = new Map();
      for (const key of this.published.keys()) {
        const id = recordIdOf(key, author, kind);
        if (id === null || !owned(id)) continue;
        keysOf.set(id, [...(keysOf.get(id) ?? []), key]);
        if (!seen.has(id)) ids.add(id);
      }
      for (const id of ids) {
        try {
          await this.coda.call(ACCORD, 'publish', { kind, id, body: withdrawnBody(kind), audience: [] });
          for (const key of keysOf.get(id) ?? []) this.published.delete(key);
        } catch (e) { fail(`撤回 ${id} 失败：${message(e)}`); }
      }
    }
    return complete;
  }
  // 换成机器 ID 之前的随机 UUID 留下的记录，同步成功后撤回；没撤回完整就下次同步再来。
  async retireLegacy(author) {
    const todo = this.source.legacy.filter(id => !this.retired.has(id));
    if (!todo.length) return;
    try {
      if (await this.retire(author, todo)) for (const id of todo) this.retired.add(id);
    } catch (e) { this.lastError = message(e); }
    this.save('published.json', Object.fromEntries(this.published));
  }

  withdraw() {
    return this.serial(async () => {
      this.lastError = null;
      try {
        // 读 Accord 抛错要当失败（保留已发布索引等重试）；正常返回却没有作者，才是没有身份、没东西可撤。
        const author = (await this.coda.get(ACCORD))?.spec?.author;
        if (!author) { this.published.clear(); this.save('published.json', {}); return; }
        // 本机的和 legacy 的都撤。没查全或没撤回成的，不当作已撤回。
        if (await this.retire(author, [this.sourceId, ...this.source.legacy])) this.published.clear();
        this.save('published.json', Object.fromEntries(this.published));
      } catch (e) { this.lastError = message(e); }
    });
  }
}
