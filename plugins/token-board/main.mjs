// Token 消耗榜的模块（Coda 的 docs/plugins.md「插件宿主」）。随后端启动（onStartupFinished）：
// - 读本机用量（coda/usage@1 的 buckets，只读、不推送，所以按需拉取）；
// - 分享开着时，每 10 分钟把最近 7 天的每日汇总发给好友（coda/accord@1 的 publish，kind `coda/token-usage`），内容没变就不重发；
// - 关掉分享或手动撤回，就把本机发布过的记录以 audience [] 重发，好友不再看得到；
// - 页面（view `board`）通过消息读状态、切开关、立即同步、取榜单。
// `activate` 里不读任何记录：初始化的读取放在延迟的定时器和页面消息里，并且全都 try/catch。
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DAY_MS, PROFILE_RECORD_KIND, RANGES, USAGE_RECORD_KIND, aggregateLeaderboard, buildDailyUsageBodies, fetchUsageBuckets, rangeWindow, summarizeBuckets, utcDate,
} from './lib/usage.mjs';

const USAGE = { kind: 'coda/usage@1', id: 'local' };
const ACCORD = { kind: 'coda/accord@1', id: 'local' };
export const SYNC_INTERVAL_MS = 10 * 60_000;
export const FIRST_SYNC_DELAY_MS = 5_000;
const SYNC_DAYS = 7;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const message = e => String(e?.message ?? e).slice(0, 200);

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
    this.published = new Map(Object.entries(this.dir ? readJson(join(this.dir, 'published.json'), {}) : {}));
    this.sourceId = this.loadSourceId();
    this.lastSyncAt = null;
    this.lastError = null;
    this.notice = null;
  }

  // 本机的稳定 UUID：好友的记录 ID 里带它，同一作者的多台设备靠它分开。
  loadSourceId() {
    if (this.dir) {
      const saved = readJson(join(this.dir, 'source.json'), null)?.sourceId;
      if (typeof saved === 'string' && UUID.test(saved)) return saved;
    }
    const sourceId = randomUUID();
    if (this.dir) {
      try { mkdirSync(this.dir, { recursive: true }); writeJson(join(this.dir, 'source.json'), { sourceId }); } catch (e) { console.error('Token 消耗榜存不下 sourceId：', message(e)); }
    }
    return sourceId;
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
  setShare(on) {
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
    return { type: 'status', share: this.share, fromSettings: this.prefs.share === undefined, range: this.settings.range, lastSyncAt: this.lastSyncAt, lastError: this.lastError,
      published: this.published.size, notice: this.notice };
  }
  tell(text) {
    this.notice = text;
    for (const view of this.views) view.postMessage(this.status());
  }
  async handle(view, request) {
    switch (request?.type) {
      case 'hello':
        await this.readSettings();
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
        this.tell(this.lastError ? null : '已同步');
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

  async board(range, id) {
    const { from, to } = rangeWindow(range, Date.now());
    const result = { type: 'board', id, range, from, to, share: this.share, accord: false, selfAuthor: null, errors: [], truncated: { usage: false, friends: false, profiles: false },
      friendCount: 0, local: null, entries: [] };
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
    result.friendCount = friends.length;

    const usage = [], profiles = [];
    if (result.accord) {
      const authors = [...new Set([selfAuthor, ...friends.map(friend => friend?.author)].filter(author => typeof author === 'string' && author))];
      for (const author of authors) {
        try {
          const read = await this.coda.query(ACCORD, 'records', { kind: USAGE_RECORD_KIND, author, limit: 200 });
          usage.push(...(read.records ?? []));
          if (read.truncated) result.truncated.friends = true;
        } catch (e) { result.errors.push(`读不到一位好友的用量：${message(e)}`); }
      }
      try {
        const read = await this.coda.query(ACCORD, 'records', { kind: PROFILE_RECORD_KIND, limit: 200 });
        profiles.push(...(read.records ?? []));
        if (read.truncated) result.truncated.profiles = true;
      } catch (e) { result.errors.push(`读不到好友名片：${message(e)}`); }
    }
    result.entries = aggregateLeaderboard({ selfAuthor, selfSourceId: this.sourceId, localBuckets, friendUsageRecords: usage, profileRecords: profiles, friends, from, to }).entries;
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
    if (this.share) await this.sync();
  }
  // 开关变了：开就同步一次，关就撤回。
  async reconcile(text) {
    if (this.stopped) return;
    if (this.share) await this.sync(); else await this.withdraw();
    this.tell(this.lastError ? null : text);
  }

  sync() {
    return this.serial(async () => {
      if (this.stopped) return;
      this.lastError = null;
      try {
        const author = (await this.coda.get(ACCORD))?.spec?.author;
        if (!author) throw new Error('这台机器还没有 Accord 身份，无法向好友发布');
        const now = Date.now();
        const from = Date.parse(`${utcDate(now - (SYNC_DAYS - 1) * DAY_MS)}T00:00:00Z`);
        const { buckets } = await fetchUsageBuckets(input => this.coda.query(USAGE, 'buckets', input), { from, to: now + 1 });
        const bodies = buildDailyUsageBodies(buckets);
        let failed = 0;
        for (const [date, body] of Object.entries(bodies)) {
          const id = `${date}/${this.sourceId}`, hash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
          if (this.published.get(id) === hash) continue;
          try {
            await this.coda.call(ACCORD, 'publish', { kind: USAGE_RECORD_KIND, id, body, audience: ['public'] });
            this.published.set(id, hash);
          } catch (e) { failed += 1; this.lastError = `发布 ${date} 失败：${message(e)}`; }
        }
        this.save('published.json', Object.fromEntries(this.published));
        if (!failed) this.lastSyncAt = Date.now();
      } catch (e) { this.lastError = message(e); }
    });
  }

  withdraw() {
    return this.serial(async () => {
      this.lastError = null;
      try {
        const author = (await this.coda.get(ACCORD))?.spec?.author;
        if (!author) { this.published.clear(); this.save('published.json', {}); return; }
        const read = await this.coda.query(ACCORD, 'records', { kind: USAGE_RECORD_KIND, author, limit: 200 });
        const mine = (read.records ?? []).filter(record => typeof record.id === 'string' && record.id.endsWith(`/${this.sourceId}`));
        for (const record of mine) {
          // 记录体已经是空的，就是上次撤回留下的，不再重发。
          if (record.body?.blocks && Object.keys(record.body.blocks).length === 0) continue;
          try {
            await this.coda.call(ACCORD, 'publish', { kind: USAGE_RECORD_KIND, id: record.id, body: { blocks: {} }, audience: [] });
            this.published.delete(record.id);
          } catch (e) { this.lastError = `撤回 ${record.id} 失败：${message(e)}`; }
        }
        // 本机记过但这次没查到的（比如被截断），不当作已撤回。
        if (!this.lastError && !read.truncated) this.published.clear();
        this.save('published.json', Object.fromEntries(this.published));
      } catch (e) { this.lastError = message(e); }
    });
  }
}
