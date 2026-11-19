// Token 消耗榜的纯逻辑：把 Coda 的用量桶（coda/usage@1 的 buckets）拉全、按 UTC 日打成可分享的汇总、再和好友发来的汇总
// 合成排行榜。不碰 coda 对象，也不读时钟，便于单测。
//
// 外来数据（好友的 Accord 记录与名片）一律当不可信：数字夹到安全整数、字符串去控制字符并截断，只当展示数据用。

export const BUCKET_MS = 600_000;           // 用量桶宽：UTC 十分钟
export const DAY_MS = 86_400_000;
export const MAX_USAGE_LIMIT = 500;          // coda/usage@1 一次最多给几个桶
export const MAX_BODY_BYTES = 60 * 1024;     // Accord 记录体上限 64 KiB，留出余量
export const USAGE_RECORD_KIND = 'coda/token-usage';
export const PROFILE_RECORD_KIND = 'profile';
export const FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'turns', 'reportedTurns'];

const BUCKET_KEY = b => JSON.stringify([b.start, b.agent, b.model]);
const pad = n => String(n).padStart(2, '0');

// ——— 拉取 ———

/**
 * 把 [from, to) 里的桶全拉出来。`queryBuckets(input)` 就是 `coda.query(usage, 'buckets', input)`。
 * 单次查询最多 500 桶（约 83 小时），所以按 24 小时分片；某片被截断（truncated）就把窗口对半分，一直分到单桶 10 分钟。
 * 同一 (start, agent, model) 只留一条。返回按时间升序的桶；`truncated` 为真表示最小窗口仍被截断，数据可能不全。
 */
export async function fetchUsageBuckets(queryBuckets, { from, to }) {
  const found = new Map();
  let truncated = false;
  const window = async (start, end) => {
    const result = await queryBuckets({ from: start, to: end, limit: MAX_USAGE_LIMIT });
    const buckets = Array.isArray(result?.buckets) ? result.buckets : [];
    if (result?.truncated) {
      // 切在十分钟边界上，两半各自不含对方的桶。
      let middle = Math.floor((start + end) / 2 / BUCKET_MS) * BUCKET_MS;
      if (middle <= start) middle = start + BUCKET_MS;
      if (end - start > BUCKET_MS && middle < end) {
        await window(start, middle);
        await window(middle, end);
        return;
      }
      truncated = true;
    }
    for (const bucket of buckets) found.set(BUCKET_KEY(bucket), bucket);
  };
  for (let start = from; start < to; start += DAY_MS) await window(start, Math.min(start + DAY_MS, to));
  return { buckets: [...found.values()].sort((a, b) => a.start - b.start || (a.agent < b.agent ? -1 : a.agent > b.agent ? 1 : 0) || (a.model < b.model ? -1 : 1)), truncated };
}

// ——— 每日汇总（要分享出去的） ———

const isEmpty = b => FIELDS.every(field => !(b[field] > 0));
export const utcDate = at => { const d = new Date(at); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
const utcClock = at => { const d = new Date(at); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
const add = (to, from) => { for (const field of FIELDS) to[field] = (to[field] ?? 0) + (from[field] ?? 0); return to; };
const zero = () => Object.fromEntries(FIELDS.map(field => [field, 0]));

/**
 * 按 UTC 日期把桶打成 `{ 'YYYY-MM-DD': { blocks: { 'HH:MM': { [agent]: { [model]: counts } } } } }`，空桶不写。
 * 不含会话、目录、正文和费用。一天的记录体超过 60 KiB 时先合并成按小时、再合并成整天一块。
 */
export function buildDailyUsageBodies(buckets) {
  const days = new Map();
  for (const bucket of buckets ?? []) {
    if (!bucket || isEmpty(bucket) || !Number.isSafeInteger(bucket.start)) continue;
    const date = utcDate(bucket.start);
    if (!days.has(date)) days.set(date, []);
    days.get(date).push(bucket);
  }
  const bodies = {};
  for (const date of [...days.keys()].sort()) {
    const list = days.get(date);
    let body = blocksOf(list, utcClock);
    if (size(body) > MAX_BODY_BYTES) body = blocksOf(list, at => `${pad(new Date(at).getUTCHours())}:00`);
    if (size(body) > MAX_BODY_BYTES) body = blocksOf(list, () => '00:00');
    bodies[date] = body;
  }
  return bodies;
}
const size = body => Buffer.byteLength(JSON.stringify(body), 'utf8');
function blocksOf(list, clock) {
  const blocks = new Map();
  for (const bucket of list) {
    const key = clock(bucket.start);
    if (!blocks.has(key)) blocks.set(key, new Map());
    const agents = blocks.get(key);
    if (!agents.has(bucket.agent)) agents.set(bucket.agent, new Map());
    const models = agents.get(bucket.agent);
    models.set(bucket.model, add(models.get(bucket.model) ?? zero(), bucket));
  }
  const out = (map, inner) => Object.fromEntries([...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, value]) => [key, inner(value)]));
  return { blocks: out(blocks, agents => out(agents, models => out(models, counts => counts))) };
}

// ——— 名片 ———

const CONTROL = /[\p{Cc}\u{2028}\u{2029}\u{061C}\u{200E}\u{200F}\u{202A}-\u{202E}\u{2066}-\u{2069}]/gu;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
export function cleanText(value, max) {
  if (typeof value !== 'string') return null;
  const text = value.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(text);
  return chars.length ? chars.slice(0, max).join('').trim() || null : null;
}
/** 好友名片记录（kind `profile`）的 body 里能展示的部分：名字 ≤ 40 字、emoji ≤ 8 字、颜色只认 #RRGGBB。 */
export function sanitizeProfile(record) {
  const body = record && typeof record === 'object' && record.body && typeof record.body === 'object' ? record.body : {};
  const color = typeof body.color === 'string' && HEX_COLOR.test(body.color.trim()) ? body.color.trim().toLowerCase() : null;
  return { name: cleanText(body.name, 40), emoji: cleanText(body.emoji, 8), color };
}
/** `ed25519:` 后的前 8 位，名片缺失时顶替名字。 */
export function shortAuthor(author) {
  const hex = String(author ?? '').replace(/^ed25519:/, '');
  return hex.slice(0, 8) || '未知';
}

// ——— 外来用量记录 ———

const RECORD_ID = /^(\d{4})-(\d{2})-(\d{2})\/([^\s/]{1,100})$/;
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;
const counter = value => (Number.isSafeInteger(value) && value > 0 ? value : 0);

/** 一条 `coda/token-usage` 记录里 [from, to) 内的块，摊平成 `[{ start, agent, model, ...counts }]`；格式不对的部分丢掉。 */
export function readUsageRecord(record, { from, to }) {
  const matched = RECORD_ID.exec(String(record?.id ?? ''));
  if (!matched) return null;
  const [, year, month, day, sourceId] = matched;
  const base = Date.UTC(Number(year), Number(month) - 1, Number(day));
  if (!Number.isFinite(base) || utcDate(base) !== `${year}-${month}-${day}`) return null;
  const rows = [];
  const blocks = record.body?.blocks;
  if (blocks && typeof blocks === 'object') {
    for (const [clock, agents] of Object.entries(blocks)) {
      const at = CLOCK.exec(clock);
      if (!at || !agents || typeof agents !== 'object') continue;
      const start = base + Number(at[1]) * 3_600_000 + Number(at[2]) * 60_000;
      if (start < from || start >= to) continue;
      for (const [agent, models] of Object.entries(agents)) {
        if (!models || typeof models !== 'object') continue;
        for (const [model, counts] of Object.entries(models)) {
          if (!counts || typeof counts !== 'object') continue;
          rows.push({ start, agent: cleanText(agent, 100) ?? '?', model: cleanText(model, 200) ?? '?', ...Object.fromEntries(FIELDS.map(field => [field, counter(counts[field])])) });
        }
      }
    }
  }
  return { sourceId, rows };
}

// ——— 排行榜 ———

const total = c => c.input + c.output + c.cacheRead + c.cacheWrite;
const compare = (a, b) => b.totalTokens - a.totalTokens || b.turns - a.turns || (a.author < b.author ? -1 : a.author > b.author ? 1 : 0);

class Tally {
  constructor() { this.sum = zero(); this.models = new Map(); }
  add(row) {
    add(this.sum, row);
    if (!this.models.has(row.model)) this.models.set(row.model, zero());
    add(this.models.get(row.model), row);
  }
  get empty() { return FIELDS.every(field => this.sum[field] === 0); }
  result() {
    const models = [...this.models].map(([model, counts]) => ({ model, ...counts, totalTokens: total(counts) }))
      .sort((a, b) => b.totalTokens - a.totalTokens || b.turns - a.turns || (a.model < b.model ? -1 : 1));
    return { ...this.sum, totalTokens: total(this.sum), models };
  }
}

/** 汇总一批桶（本机自己的）。 */
export function summarizeBuckets(buckets, { from, to }) {
  const tally = new Tally();
  for (const bucket of buckets ?? []) if (bucket.start >= from && bucket.start < to) tally.add({ ...bucket, ...Object.fromEntries(FIELDS.map(field => [field, counter(bucket[field])])) });
  return tally.result();
}

/**
 * 熟人消耗榜。
 * - `selfAuthor` 用最新的 `localBuckets`，再并上同一作者名下其他 `sourceId`（别的设备）的记录；本机自己发布过的 `selfSourceId` 记录丢掉，不重复计。
 * - 好友按 `author` 汇总他所有 `sourceId` 的记录里落在 [from, to) 的部分；同一 (author, id) 只取版本最新的一条。
 * - 只认 `selfAuthor` 和 `friends` 里出现过的作者；`profileRecords` 同一作者取版本最新的一条。
 * 按总 Token 降序，平局按回合数降序、再按 author 升序。
 */
export function aggregateLeaderboard({ selfAuthor, selfSourceId, localBuckets = [], friendUsageRecords = [], profileRecords = [], friends = [], from, to }) {
  const friendAuthors = new Set(friends.map(friend => friend?.author).filter(author => typeof author === 'string' && author));
  const known = new Set([...friendAuthors, ...(selfAuthor ? [selfAuthor] : [])]);

  // 每个 (author, id) 取最新版本。
  const latest = new Map();
  for (const record of friendUsageRecords) {
    if (!record || record.kind !== USAGE_RECORD_KIND || !known.has(record.author)) continue;
    const key = JSON.stringify([record.author, record.id]);
    if (!latest.has(key) || record.version > latest.get(key).version) latest.set(key, record);
  }
  const tallies = new Map([...known].map(author => [author, new Tally()]));
  const shared = new Set();
  if (selfAuthor) for (const bucket of localBuckets) if (bucket.start >= from && bucket.start < to) tallies.get(selfAuthor).add({ ...bucket, ...Object.fromEntries(FIELDS.map(field => [field, counter(bucket[field])])) });
  for (const record of latest.values()) {
    const read = readUsageRecord(record, { from, to });
    if (!read) continue;
    if (record.author === selfAuthor && read.sourceId === selfSourceId) continue;
    shared.add(record.author);
    for (const row of read.rows) tallies.get(record.author).add(row);
  }

  const profiles = new Map();
  for (const record of profileRecords) {
    if (!record || record.kind !== PROFILE_RECORD_KIND || !known.has(record.author)) continue;
    if (!profiles.has(record.author) || record.version > profiles.get(record.author).version) profiles.set(record.author, record);
  }

  const entries = [...tallies].map(([author, tally]) => {
    const profile = profiles.has(author) ? sanitizeProfile(profiles.get(author)) : { name: null, emoji: null, color: null };
    return { author, shortId: shortAuthor(author), self: author === selfAuthor, shared: author === selfAuthor || shared.has(author),
      ...profile, ...tally.result() };
  }).sort(compare);
  entries.forEach((entry, index) => { entry.rank = index + 1; });
  return { from, to, entries };
}

// ——— 时间范围 ———

export const RANGES = ['today', '7d', '30d'];
/** 范围对应的 [from, to)：从本机日历日的零点起（今天、近 7 天含今天、近 30 天含今天），到现在为止（含当前十分钟桶）。 */
export function rangeWindow(range, now) {
  const days = range === 'today' ? 0 : range === '30d' ? 29 : 6;
  const d = new Date(now);
  return { from: new Date(d.getFullYear(), d.getMonth(), d.getDate() - days).getTime(), to: now + 1 };
}
