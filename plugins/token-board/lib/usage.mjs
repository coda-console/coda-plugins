// Token 消耗榜的纯逻辑：把 Coda 的用量桶（coda/usage@1 的 buckets）拉全、按 UTC 日打成可分享的汇总、再和好友发来的汇总
// 合成排行榜。不碰 coda 对象，也不读时钟，便于单测。
//
// 外来数据（好友的 Accord 记录与名片）一律当不可信：数字夹到安全整数、字符串去控制字符并截断，只当展示数据用。

export const BUCKET_MS = 600_000;           // 用量桶宽：UTC 十分钟
export const DAY_MS = 86_400_000;
export const MAX_USAGE_LIMIT = 500;          // coda/usage@1 一次最多给几个桶
export const MAX_BODY_BYTES = 60 * 1024;     // Accord 记录体上限 64 KiB，留出余量
export const USAGE_RECORD_KIND = 'coda/token-usage';   // 0.1.0 的每日记录：过渡期只读兼容与撤回
export const DAY_ARCHIVE_KIND = 'coda/token-day';       // 月块日归档（UTC 日）
export const TODAY_CURVE_KIND = 'coda/token-today';     // 48 小时滚动曲线（30 分钟槽位）
export const SLOT_MS = 1_800_000;
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

// ——— 紧凑格式：月块日归档与 48 小时曲线（要分享出去的） ———

// 一条计数就是 [input, output, cacheRead, cacheWrite, turns, reportedTurns]，6 个非负安全整数。
const KEEPS = [Infinity, 32, 8, 2, 1, 0, 'total'];
const sortedObject = (map, inner) => Object.fromEntries([...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, value]) => [key, inner(value)]));
const zeroRow = () => FIELDS.map(() => 0);
const addRow = (to, from) => { from.forEach((value, i) => { to[i] += value; }); return to; };

// 桶按 keyOf(start) 分组成 Map<key, Map<agent, Map<model, 计数>>>，空桶不要。
function collect(buckets, keyOf) {
  const tree = new Map();
  for (const bucket of buckets ?? []) {
    if (!bucket || isEmpty(bucket) || !Number.isSafeInteger(bucket.start)) continue;
    const key = keyOf(bucket.start);
    if (!tree.has(key)) tree.set(key, new Map());
    const agents = tree.get(key);
    if (!agents.has(bucket.agent)) agents.set(bucket.agent, new Map());
    const models = agents.get(bucket.agent);
    models.set(bucket.model, addRow(models.get(bucket.model) ?? zeroRow(), FIELDS.map(field => counter(bucket[field]))));
  }
  return tree;
}
const treeObject = tree => sortedObject(tree, agents => sortedObject(agents, models => sortedObject(models, row => row)));
// 每个 Agent 只留总量最大的 keep 个模型，其余并进 'other'；总量不变。
function fold(tree, keep) {
  if (keep === Infinity) return tree;
  // 最终兜底：每格所有 Agent 和模型合成一条 { _: { _: 合计 } }。
  if (keep === 'total') return new Map([...tree].map(([key, agents]) => [key, new Map([['_', new Map([['_', [...agents.values()].flatMap(models => [...models.values()]).reduce(addRow, zeroRow())]])]])]));
  const totals = new Map();
  for (const agents of tree.values()) for (const [agent, models] of agents) {
    if (!totals.has(agent)) totals.set(agent, new Map());
    for (const [model, row] of models) totals.get(agent).set(model, (totals.get(agent).get(model) ?? 0) + row[0] + row[1] + row[2] + row[3]);
  }
  const kept = new Map([...totals].map(([agent, models]) => [agent,
    new Set([...models].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, keep).map(([model]) => model))]));
  const out = new Map();
  for (const [key, agents] of tree) {
    const next = new Map();
    for (const [agent, models] of agents) {
      const merged = new Map();
      for (const [model, row] of models) {
        const name = kept.get(agent).has(model) ? model : 'other';
        merged.set(name, addRow(merged.get(name) ?? zeroRow(), row));
      }
      next.set(agent, merged);
    }
    out.set(key, next);
  }
  return out;
}
// 先原样，放不下再逐步合并小模型、最后合成一条合计，直到 maxBytes 以内；合计也放不下（预算小得离谱）就抛错，不返回超限的记录体。
function fitted(build, maxBytes) {
  let body;
  for (const keep of KEEPS) { body = build(keep); if (size(body) <= maxBytes) return body; }
  throw new Error(`记录体即使合成合计也有 ${size(body)} 字节，超过 ${maxBytes} 字节的预算`);
}

// 一月的块：整月；放不下按半月（-1：1–15 日，-2：16–31 日）；再不行按周（-w1…-w5，每 7 日）。同一个月只用一种拆法，id 不会互相覆盖。
const MONTH_PARTS = [() => '', day => (day <= 15 ? '-1' : '-2'), day => `-w${Math.ceil(day / 7)}`];

/**
 * 按 UTC 日打成月块日归档 `{ 'YYYY-MM[-1|-2|-wN]': { v: 2, days: { 'YYYY-MM-DD': { [agent]: { [model]: [6 个数] } } } } }`。
 * 记录 id 是 `<sourceId>/<键>`。每块序列化后不超过 maxBytes：先拆半月、再拆周，仍超就合并小模型。
 */
export function buildArchiveBodies(buckets, { maxBytes = MAX_BODY_BYTES } = {}) {
  const days = collect(buckets, utcDate);
  const months = new Map();
  for (const date of [...days.keys()].sort()) {
    const month = date.slice(0, 7);
    if (!months.has(month)) months.set(month, new Map());
    months.get(month).set(date, days.get(date));
  }
  const bodies = {};
  for (const [month, monthDays] of months) {
    const build = chunk => keep => ({ v: 2, days: treeObject(fold(chunk, keep)) });
    for (let level = 0; level < MONTH_PARTS.length; level++) {
      const chunks = new Map();
      for (const [date, tree] of monthDays) {
        const suffix = MONTH_PARTS[level](Number(date.slice(8)));
        if (!chunks.has(suffix)) chunks.set(suffix, new Map());
        chunks.get(suffix).set(date, tree);
      }
      if (level < MONTH_PARTS.length - 1 && [...chunks.values()].some(chunk => size(build(chunk)(Infinity)) > maxBytes)) continue;
      for (const [suffix, chunk] of chunks) bodies[`${month}${suffix}`] = fitted(build(chunk), maxBytes);
      break;
    }
  }
  return bodies;
}

/**
 * 最近 windowHours 小时的滚动曲线 `{ v: 2, slotMs, windowStart, windowEnd, slots: { '<槽起点毫秒>': { [agent]: { [model]: [6 个数] } } } }`，
 * 窗口 [windowStart, windowEnd) 对齐 slotMs 且包含 now 所在的槽。记录 id 就是 sourceId，每次覆盖。
 * 超过 maxBytes 先降成 60 分钟槽，再合并小模型。
 */
export function buildTodayBody(buckets, { now, slotMs = SLOT_MS, windowHours = 48, maxBytes = MAX_BODY_BYTES } = {}) {
  const build = (ms, keep) => {
    const windowEnd = (Math.floor(now / ms) + 1) * ms, windowStart = windowEnd - windowHours * 3_600_000;
    const inside = (buckets ?? []).filter(bucket => bucket?.start >= windowStart && bucket.start < windowEnd);
    return { v: 2, slotMs: ms, windowStart, windowEnd, slots: treeObject(fold(collect(inside, at => Math.floor(at / ms) * ms), keep)) };
  };
  const coarse = slotMs < 3_600_000 ? 3_600_000 : slotMs;
  const first = build(slotMs, Infinity);
  if (size(first) <= maxBytes) return first;
  return fitted(keep => build(coarse, keep), maxBytes);
}

/** 只留 person 名下的桶（includeUntagged 为真时，没打标的历史桶也算）；不指定 person 就是全部。 */
export function filterBucketsByPerson(buckets, person, { includeUntagged = true } = {}) {
  if (!person) return buckets;
  return buckets.filter(bucket => bucket.person === person || (includeUntagged && !bucket.person));
}

// 撤回时重发的空记录体；和它一样的记录体就是上次撤回留下的。
const WITHDRAWN = {
  [USAGE_RECORD_KIND]: { blocks: {} },
  [DAY_ARCHIVE_KIND]: { v: 2, days: {} },
  [TODAY_CURVE_KIND]: { v: 2, slotMs: SLOT_MS, windowStart: 0, windowEnd: 0, slots: {} },
};
export const withdrawnBody = kind => structuredClone(WITHDRAWN[kind]);
export const isWithdrawn = (kind, body) => JSON.stringify(body) === JSON.stringify(WITHDRAWN[kind]);
/** 这条记录（kind、id）是不是 sourceId 这台机器发布的。 */
export function ownedBySource(kind, id, sourceId) {
  if (typeof id !== 'string') return false;
  if (kind === USAGE_RECORD_KIND) return id.endsWith(`/${sourceId}`);
  if (kind === DAY_ARCHIVE_KIND) return id.startsWith(`${sourceId}/`);
  return id === sourceId;
}

// ——— 名片 ———

const CONTROL = /[\p{Cc}\u{2028}\u{2029}\u{061C}\u{200E}\u{200F}\u{202A}-\u{202E}\u{2066}-\u{2069}]/gu;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
// 好友插件（@coda-console/friends）发布的命名主题色。
export const NAMED_COLORS = ['blue', 'orange', 'green', 'purple', 'pink', 'teal', 'gray'];
export function cleanText(value, max) {
  if (typeof value !== 'string') return null;
  const text = value.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(text);
  return chars.length ? chars.slice(0, max).join('').trim() || null : null;
}
/** 好友名片记录（kind `profile`）的 body 里能展示的部分：名字 ≤ 40 字、emoji ≤ 8 字、颜色只认命名色板（blue、orange…）和 #RRGGBB。 */
export function sanitizeProfile(record) {
  const body = record && typeof record === 'object' && record.body && typeof record.body === 'object' ? record.body : {};
  return { name: cleanText(body.name, 40), emoji: cleanText(body.emoji, 8), color: cleanColor(body.color) };
}
function cleanColor(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  return HEX_COLOR.test(raw) || NAMED_COLORS.includes(raw) ? raw.toLowerCase() : null;
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

const ARCHIVE_ID = /^([^\s/]{1,100})\/(\d{4})-(\d{2})(?:-(1|2|w[1-5]))?$/;
const SOURCE_ID = /^[^\s/]{1,100}$/;
const validRow = row => Array.isArray(row) && row.length === FIELDS.length && row.every(value => Number.isSafeInteger(value) && value >= 0);
// { [agent]: { [model]: [6 个数] } } 摊平成行；不合格的丢掉。
function rowsOf(agents) {
  const rows = [];
  if (!agents || typeof agents !== 'object') return rows;
  for (const [agent, models] of Object.entries(agents)) {
    if (!models || typeof models !== 'object') continue;
    for (const [model, row] of Object.entries(models)) {
      if (validRow(row)) rows.push({ agent: cleanText(agent, 100) ?? '?', model: cleanText(model, 200) ?? '?', ...Object.fromEntries(FIELDS.map((field, i) => [field, row[i]])) });
    }
  }
  return rows;
}
const partRange = part => (part === '1' ? [1, 15] : part === '2' ? [16, 31] : part ? [Number(part[1]) * 7 - 6, Number(part[1]) * 7 + (part[1] === '5' ? 3 : 0)] : [1, 31]);

/** 一条 `coda/token-day` 记录：`{ sourceId, days: [{ date, start（UTC 零点）, rows }] }`；id 或版本不对返回 null，日期不在 id 的月份与分块里的、计数不合格的丢掉。 */
export function readArchiveRecord(record) {
  const matched = ARCHIVE_ID.exec(String(record?.id ?? ''));
  if (!matched || record.body?.v !== 2 || !record.body.days || typeof record.body.days !== 'object') return null;
  const [, sourceId, year, month, part] = matched;
  const [first, last] = partRange(part);
  const days = [];
  for (const [date, agents] of Object.entries(record.body.days)) {
    const at = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    if (!at || at[1] !== year || at[2] !== month) continue;
    const start = Date.UTC(Number(year), Number(month) - 1, Number(at[3]));
    if (utcDate(start) !== date || Number(at[3]) < first || Number(at[3]) > last) continue;
    days.push({ date, start, rows: rowsOf(agents) });
  }
  return { sourceId, days };
}

/** 一条 `coda/token-today` 记录：`{ sourceId, slotMs, windowStart, windowEnd, slots: [{ start, rows }] }`；窗口、槽位对不齐或不在窗口内的丢掉。 */
export function readTodayRecord(record) {
  const id = String(record?.id ?? ''), body = record?.body;
  if (!SOURCE_ID.test(id) || body?.v !== 2 || ![SLOT_MS, 3_600_000].includes(body.slotMs)) return null;
  const { slotMs, windowStart, windowEnd } = body;
  if (!Number.isSafeInteger(windowStart) || !Number.isSafeInteger(windowEnd) || windowStart % slotMs || windowEnd % slotMs || windowEnd <= windowStart || !body.slots || typeof body.slots !== 'object') return null;
  const slots = [];
  for (const [key, agents] of Object.entries(body.slots)) {
    const start = /^\d{1,16}$/.test(key) ? Number(key) : NaN;
    if (!Number.isSafeInteger(start) || start % slotMs || start < windowStart || start >= windowEnd) continue;
    slots.push({ start, rows: rowsOf(agents) });
  }
  return { sourceId: id, slotMs, windowStart, windowEnd, slots };
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

// 每个 (author, id) 只取版本最新的一条，且只要某个 kind、认识的作者。
function latestOf(records, kind, known) {
  const latest = new Map();
  for (const record of records) {
    if (!record || record.kind !== kind || !known.has(record.author)) continue;
    const key = JSON.stringify([record.author, record.id]);
    if (!latest.has(key) || record.version > latest.get(key).version) latest.set(key, record);
  }
  return [...latest.values()];
}
const localRows = (buckets, from, to) => buckets.filter(bucket => bucket.start >= from && bucket.start < to)
  .map(bucket => ({ ...bucket, ...Object.fromEntries(FIELDS.map(field => [field, counter(bucket[field])])) }));

// 一台远端机器（author + sourceId）在 [from, to) 里的行。逐个 UTC 日选来源：
// - 这一日在查询窗口内的那一段 [max(from, 日零点), min(to, 日末))，完整落在曲线的 [windowStart, windowEnd) 里：取曲线槽位（精确到窗口边界）；
// - 否则（曲线起点晚于这一段、曲线在这一段结束前就停了，也就是旧曲线）：取这一日的日归档，并排除这一日的曲线槽位，免得双计；
//   日归档只有整日，按「这一日过半在窗口内」算进来（过半不在窗口内的，归档不算，当日曲线槽位照常取）；
// - 没有日归档的日子，取曲线里落在窗口内的槽位。
function remoteRows({ days, today }, from, to) {
  const rows = [], archived = new Set();
  for (const day of days) {
    const dayEnd = day.start + DAY_MS;
    if (day.start >= to || dayEnd <= from) continue;
    if (today && today.windowStart <= Math.max(from, day.start) && today.windowEnd >= Math.min(to, dayEnd)) continue;
    if (day.start + DAY_MS / 2 < from) continue;
    archived.add(day.start);
    rows.push(...day.rows.map(row => ({ ...row, start: day.start })));
  }
  for (const slot of today?.slots ?? []) {
    if (slot.start >= from && slot.start < to && !archived.has(Math.floor(slot.start / DAY_MS) * DAY_MS)) rows.push(...slot.rows.map(row => ({ ...row, start: slot.start })));
  }
  return rows;
}

/**
 * 熟人消耗榜。
 * - `selfAuthor` 用最新的 `localBuckets`（可按 `person` 切片），再并上同一作者名下其他 `sourceId`（别的设备）的记录；
 *   本机的 `selfSourceId` 和换成机器 ID 之前留下的 `excludedSourceIds` 在同作者记录里一律跳过，不重复计。
 * - 好友（和自己的其他设备）按 `author` + `sourceId` 汇总：`dayRecords`（coda/token-day）与 `todayRecords`（coda/token-today）按窗口拼接，
 *   同一 (author, id) 只取版本最新的一条；某台机器有任何新版记录，就不再读它旧版的 `legacyUsageRecords`（coda/token-usage），只有旧版好友才回退读旧记录。
 * - `person` 只切本机桶：远端记录里没有人的标签。
 * - 只认 `selfAuthor` 和 `friends` 里出现过的作者；`profileRecords` 同一作者取版本最新的一条。`friends` 行若带 `note`（备注）、`profileName`、`title`、`emoji`、`color`，
 *   名字取 备注 > 名片记录 > profileName > title，emoji 与颜色名片记录优先、缺了才用好友行的。
 * 按总 Token 降序，平局按回合数降序、再按 author 升序。
 */
export function aggregateLeaderboard({ selfAuthor, selfSourceId, excludedSourceIds = [], localBuckets = [], legacyUsageRecords = [], dayRecords = [], todayRecords = [], profileRecords = [], friends = [], from, to, person }) {
  const friendAuthors = new Set(friends.map(friend => friend?.author).filter(author => typeof author === 'string' && author));
  const known = new Set([...friendAuthors, ...(selfAuthor ? [selfAuthor] : [])]);
  const excluded = new Set([selfSourceId, ...excludedSourceIds]);

  const tallies = new Map([...known].map(author => [author, new Tally()]));
  const shared = new Set();
  if (selfAuthor) for (const row of localRows(filterBucketsByPerson(localBuckets, person), from, to)) tallies.get(selfAuthor).add(row);

  const sources = new Map();
  const source = (author, sourceId) => {
    if (author === selfAuthor && excluded.has(sourceId)) return null;
    const key = JSON.stringify([author, sourceId]);
    if (!sources.has(key)) sources.set(key, { author, days: [], today: null, current: false, legacy: [] });
    return sources.get(key);
  };
  // 换拆法（整月 ↔ 半月 ↔ 周）时，新旧块可能同时被读到：同一 (author, sourceId, UTC 日) 只采用版本最大的那条记录里的。
  const dayOwner = new Map();
  for (const record of latestOf(dayRecords, DAY_ARCHIVE_KIND, known)) {
    const read = readArchiveRecord(record), target = read && source(record.author, read.sourceId);
    if (!target) continue;
    target.current = true;
    for (const day of read.days) {
      const key = JSON.stringify([record.author, read.sourceId, day.date]);
      if (!dayOwner.has(key) || record.version > dayOwner.get(key).version) dayOwner.set(key, { version: record.version, target, day });
    }
  }
  for (const { target, day } of dayOwner.values()) target.days.push(day);
  for (const record of latestOf(todayRecords, TODAY_CURVE_KIND, known)) {
    const read = readTodayRecord(record), target = read && source(record.author, read.sourceId);
    if (target) { target.current = true; target.today = read; }
  }
  for (const record of latestOf(legacyUsageRecords, USAGE_RECORD_KIND, known)) {
    const read = readUsageRecord(record, { from, to }), target = read && source(record.author, read.sourceId);
    if (target) target.legacy.push(...read.rows);
  }
  for (const target of sources.values()) {
    shared.add(target.author);
    for (const row of target.current ? remoteRows(target, from, to) : target.legacy) tallies.get(target.author).add(row);
  }

  const profiles = new Map();
  for (const record of profileRecords) {
    if (!record || record.kind !== PROFILE_RECORD_KIND || !known.has(record.author)) continue;
    if (!profiles.has(record.author) || record.version > profiles.get(record.author).version) profiles.set(record.author, record);
  }

  // 好友网关给的好友行自带备注和名片：备注最优先，其次名片记录，再回落好友行里的名片名、标题。
  const friendRows = new Map();
  for (const friend of friends) if (typeof friend?.author === 'string' && friend.author && !friendRows.has(friend.author)) friendRows.set(friend.author, friend);
  const entries = [...tallies].map(([author, tally]) => {
    const profile = profiles.has(author) ? sanitizeProfile(profiles.get(author)) : { name: null, emoji: null, color: null };
    const friend = friendRows.get(author);
    if (friend) {
      profile.name = cleanText(friend.note, 40) ?? profile.name ?? cleanText(friend.profileName, 40) ?? cleanText(friend.title, 40);
      profile.emoji ??= cleanText(friend.emoji, 8);
      profile.color ??= cleanColor(friend.color);
    }
    return { author, shortId: shortAuthor(author), self: author === selfAuthor, shared: author === selfAuthor || shared.has(author),
      ...profile, ...tally.result() };
  }).sort(compare);
  entries.forEach((entry, index) => { entry.rank = index + 1; });
  return { from, to, entries };
}

/**
 * 当天曲线：[range.from, range.to) 按 slotMs 切成有序槽位（没用量的槽也在，值全 0），每槽 `{ start, totalTokens, input, output, cacheRead, cacheWrite, turns, reportedTurns }`。
 * 本机用最新的 `localBuckets`（可按 `person` 切片），再并上同作者其他设备的 `todayRecords`（coda/token-today）；`selfSourceId` 与 `excludedSourceIds` 的一律跳过。
 * 返回 `{ curve, byAuthor }`：`curve` 是本机作者（本机加其他设备）的曲线，`byAuthor` 是 selfAuthor 与 `friends` 各自的曲线。
 * 外来槽位按槽起点落进包含它的输出槽；落在窗口外的丢掉。
 */
export function aggregateTodayCurve({ selfAuthor, selfSourceId, excludedSourceIds = [], localBuckets = [], todayRecords = [], friends = [], range, slotMs = SLOT_MS, person }) {
  const { from, to } = range;
  const authors = new Set([...friends.map(friend => friend?.author).filter(author => typeof author === 'string' && author), ...(selfAuthor ? [selfAuthor] : [])]);
  const grid = () => { const slots = []; for (let start = from; start < to; start += slotMs) slots.push({ start, ...zero() }); return slots; };
  const curves = new Map([...authors, null].map(author => [author, grid()]));
  const place = (author, start, row) => {
    if (start < from || start >= to) return;
    add(curves.get(author)[Math.floor((start - from) / slotMs)], row);
  };
  for (const bucket of filterBucketsByPerson(localBuckets, person)) place(selfAuthor ?? null, bucket.start, Object.fromEntries(FIELDS.map(field => [field, counter(bucket[field])])));
  const excluded = new Set([selfSourceId, ...excludedSourceIds]);
  for (const record of latestOf(todayRecords, TODAY_CURVE_KIND, authors)) {
    const read = readTodayRecord(record);
    if (!read || (record.author === selfAuthor && excluded.has(read.sourceId))) continue;
    for (const slot of read.slots) for (const row of slot.rows) place(record.author, slot.start, row);
  }
  const finish = slots => slots.map(slot => ({ start: slot.start, totalTokens: total(slot), ...Object.fromEntries(FIELDS.map(field => [field, slot[field]])) }));
  return { curve: finish(curves.get(selfAuthor ?? null)), byAuthor: Object.fromEntries([...authors].map(author => [author, finish(curves.get(author))])) };
}

// ——— 时间范围 ———

export const RANGES = ['today', '7d', '30d'];
/** 范围对应的 [from, to)：从本机日历日的零点起（今天、近 7 天含今天、近 30 天含今天），到现在为止（含当前十分钟桶）。 */
export function rangeWindow(range, now) {
  const days = range === 'today' ? 0 : range === '30d' ? 29 : 6;
  const d = new Date(now);
  return { from: new Date(d.getFullYear(), d.getMonth(), d.getDate() - days).getTime(), to: now + 1 };
}
