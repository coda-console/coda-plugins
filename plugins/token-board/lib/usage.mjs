// Token 消耗榜的纯逻辑：把 Coda 的用量桶（coda/usage@1 的 buckets）拉全、按 UTC 日打成可分享的汇总、再和好友发来的汇总
// 合成排行榜。不碰 coda 对象，也不读时钟，便于单测。
//
// 外来数据（好友的 Accord 记录）一律当不可信：数字夹到安全整数、字符串去控制字符并截断，只当展示数据用。

export const BUCKET_MS = 600_000;           // 用量桶宽：UTC 十分钟
export const DAY_MS = 86_400_000;
export const MAX_USAGE_LIMIT = 500;          // coda/usage@1 一次最多给几个桶
export const MAX_BODY_BYTES = 60 * 1024;     // Accord 记录体上限 64 KiB，留出余量
export const USAGE_RECORD_KIND = 'coda/token-usage';   // 0.1.0 的每日记录：过渡期只读兼容与撤回
export const DAY_ARCHIVE_KIND = 'coda/token-day';       // 月块日归档（UTC 日）
export const TODAY_CURVE_KIND = 'coda/token-today';     // 48 小时滚动曲线（30 分钟槽位）
export const SLOT_MS = 1_800_000;
export const FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'turns', 'reportedTurns'];

const BUCKET_KEY = b => JSON.stringify([b.start, b.person, b.agent, b.service, b.asked, b.served, b.model]);
const pad = n => String(n).padStart(2, '0');

// ——— 拉取 ———

/**
 * 把 [from, to) 里的桶全拉出来。`queryBuckets(input)` 就是 `coda.query(usage, 'buckets', input)`。
 * 单次查询最多 500 桶（约 83 小时），所以按 24 小时分片；某片被截断（truncated）就把窗口对半分，一直分到单桶 10 分钟。
 * 同一 (start, person, agent, service, asked, served, model) 只留一条（同桶内不同身份的分层行互不覆盖）。返回按时间升序的桶；`truncated` 为真表示最小窗口仍被截断，数据可能不全。
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
  const order = b => [b.agent, b.model, b.person, b.service, b.asked, b.served].map(value => value ?? '');
  const compare = (a, b) => { const x = order(a), y = order(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1; return 0; };
  return { buckets: [...found.values()].sort((a, b) => a.start - b.start || compare(a, b)), truncated };
}

// ——— 一行用量：型号名与请求项 ———

/** 接口种类：模型服务引用 `coda://<接口种类>/<UUID>` 里的种类名；没有服务返回 null。服务的 UUID 不出这台机器。 */
export const serviceKind = ref => (typeof ref === 'string' ? /^coda:\/\/([a-z][a-z0-9-]*)\//.exec(ref)?.[1] ?? null : null);
/**
 * 一行显示用的型号名：实际型号 `served`，没有取同型号映射归并后的名字 `same`，再没有取请求的 `asked`，再没有取未分层的旧标签 `model`；
 * 后端允许只带 `service` 的行，这时取服务的接口种类名。全插件只在这里算。`same` 只在本机行取数时（markSame）或读到别人记录里的 `u` 时才有，
 * 展开的请求项仍是 `asked` 与接口种类。
 */
export const modelName = row => row.served ?? row.same ?? row.asked ?? row.model ?? row.api;
/**
 * 同型号映射（Magpie 插件的 `magpie/models@1`：`names` 是 `{ [asked]: 名字 }`，`services` 是本机 Magpie 插件提供的模型服务的资源引用）套到本机桶上：
 * 只套 `service` 在 `services` 里、没有实际型号（`served` 为空）、`asked` 在 `names` 里的行，名字记在桶的 `same` 上；
 * 有 `served` 的行、旧标签行、别台或别的插件提供的服务的行、映射里没有的 `asked` 都不动。映射只属于本机，别人记录里的行不走这里。
 */
const mappable = (bucket, services) => services.includes(bucket.service) && bucket.served == null && typeof bucket.asked === 'string';
export const needsSame = buckets => buckets.some(bucket => bucket.service && bucket.served == null && typeof bucket.asked === 'string');
export const markSame = (buckets, names, services) => buckets.map(bucket => (mappable(bucket, services) && Object.hasOwn(names, bucket.asked) ? { ...bucket, same: names[bucket.asked] } : bucket));
/** 本机桶（coda/usage@1 的 buckets 一行）→ 统一的一行：`api` 是服务的接口种类，计数夹成非负安全整数。 */
const rowOf = bucket => ({ start: bucket.start, agent: bucket.agent, api: serviceKind(bucket.service), asked: bucket.asked ?? null, served: bucket.served ?? null, same: bucket.same ?? null, model: bucket.model ?? null,
  ...Object.fromEntries(FIELDS.map(field => [field, counter(bucket[field])])) });
const identityKey = row => JSON.stringify([row.api ?? null, row.asked ?? null, row.served ?? null, row.same ?? null, row.model ?? null]);
/**
 * 本机桶里算作 identity（这台后端当前的根身份）名下的：`person` 是它，或是空字符串的无身份行；别的身份的行不算。
 * 同桶不同身份的行本来就不相加，这里只决定谁的行算进当前作者的用量。
 */
export const ownBuckets = (buckets, identity) => buckets.filter(bucket => !bucket.person || bucket.person === identity);
/**
 * 轮数记在请求行（`served` 为空）上，Token 可能在带 `served` 的行上。请求行只有轮数没有 Token 时，轮数记到同一请求项
 * （Agent、接口种类、`asked`）下 Token 最多的型号行上（并列取型号名靠前的），请求行随之清空；请求项下没有带 Token 的型号行，轮数就留在请求行。
 * 同一轮因此只在一行上算。只在读取端的 Tally 里做一次，范围就是这次聚合的全部行（当次查询窗口）；写签名记录时各行原样保留。返回新的行，空行去掉。
 */
export function settleTurns(rows) {
  const copies = rows.map(row => ({ ...row })), groups = new Map();
  for (const row of copies) {
    if (row.asked == null) continue;
    const key = JSON.stringify([row.agent ?? null, row.api ?? null, row.asked]);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  for (const group of groups.values()) {
    const heaviest = group.filter(row => row.served != null && total(row) > 0).sort((a, b) => total(b) - total(a) || (a.served < b.served ? -1 : 1))[0];
    if (!heaviest) continue;
    for (const row of group) {
      if (row.served != null || total(row) > 0) continue;
      heaviest.turns += row.turns; heaviest.reportedTurns += row.reportedTurns;
      row.turns = 0; row.reportedTurns = 0;
    }
  }
  return copies.filter(row => !isEmpty(row));
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

// 一行的 `n` 就是 [input, output, cacheRead, cacheWrite, turns, reportedTurns]，6 个非负安全整数。
const KEEPS = [Infinity, 32, 8, 2, 1, 0, 'total'];
const sortedObject = (map, inner) => Object.fromEntries([...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, value]) => [key, inner(value)]));

// 桶按 keyOf(start) 分组成 Map<key, Map<agent, 行[]>>：同一身份的行相加，空桶不要；各行原样保留（含只有轮数的请求行），轮数在读取端的 Tally 里记定。
function collect(buckets, keyOf) {
  const tree = new Map();
  for (const bucket of buckets ?? []) {
    if (!bucket || isEmpty(bucket) || !Number.isSafeInteger(bucket.start)) continue;
    const key = keyOf(bucket.start), row = rowOf(bucket);
    if (!tree.has(key)) tree.set(key, new Map());
    const agents = tree.get(key);
    if (!agents.has(row.agent)) agents.set(row.agent, new Map());
    const rows = agents.get(row.agent), id = identityKey(row);
    rows.set(id, add(rows.get(id) ?? { ...row, ...zero() }, row));
  }
  return new Map([...tree].map(([key, agents]) => [key, new Map([...agents].map(([agent, rows]) => [agent, [...rows.values()]]))]));
}
// 一行写成 `{ a: asked, s: served, u: 同型号映射归并后的名字, i: 接口种类, m: 未分层的旧标签, n: [6 个数] }`，没有的不写；不带服务的 UUID。
const wireKey = row => JSON.stringify([row.asked ?? '', row.served ?? '', row.same ?? '', row.api ?? '', row.model ?? '']);
const wireRow = row => ({ ...(row.asked == null ? {} : { a: row.asked }), ...(row.served == null ? {} : { s: row.served }), ...(row.same == null ? {} : { u: row.same }), ...(row.api == null ? {} : { i: row.api }),
  ...(row.model == null ? {} : { m: row.model }), n: FIELDS.map(field => row[field]) });
const treeObject = tree => sortedObject(tree, agents => sortedObject(agents, rows => [...rows].sort((a, b) => (wireKey(a) < wireKey(b) ? -1 : wireKey(a) > wireKey(b) ? 1 : 0)).map(wireRow)));
const labelRow = (model, rows) => ({ api: null, asked: null, served: null, same: null, model, ...rows.reduce(add, zero()) });
// 每个 Agent 只留总量（按型号名）最大的 keep 个型号，其余各行并成一行旧标签 'other'；总量不变。
function fold(tree, keep) {
  if (keep === Infinity) return tree;
  // 最终兜底：每格所有 Agent 和型号合成一条 { _: [{ m: '_' }] }。
  if (keep === 'total') return new Map([...tree].map(([key, agents]) => [key, new Map([['_', [labelRow('_', [...agents.values()].flat())]]])]));
  const totals = new Map();
  for (const agents of tree.values()) for (const [agent, rows] of agents) {
    if (!totals.has(agent)) totals.set(agent, new Map());
    for (const row of rows) totals.get(agent).set(modelName(row), (totals.get(agent).get(modelName(row)) ?? 0) + total(row));
  }
  const kept = new Map([...totals].map(([agent, names]) => [agent,
    new Set([...names].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, keep).map(([name]) => name))]));
  return new Map([...tree].map(([key, agents]) => [key, new Map([...agents].map(([agent, rows]) => {
    const rest = rows.filter(row => !kept.get(agent).has(modelName(row)));
    return [agent, [...rows.filter(row => kept.get(agent).has(modelName(row))), ...(rest.length ? [labelRow('other', rest)] : [])]];
  }))]));
}
// 先原样，放不下再逐步合并小模型、最后合成一条合计，直到 maxBytes 以内；合计也放不下（预算小得离谱）就抛错，不返回超限的记录体。
function fitted(build, maxBytes) {
  let body;
  for (const keep of KEEPS) { body = build(keep); if (size(body) <= maxBytes) return body; }
  throw new Error(`记录体即使合成合计也有 ${size(body)} 字节，超过 ${maxBytes} 字节的预算`);
}

// 签名记录的版本：3 起每行带 asked、served、接口种类（见 wireRow）；读取端也认 2（每个型号一个旧标签）。
const RECORD_VERSION = 3;
const READABLE_VERSIONS = [2, 3];

// 一月的块：整月；放不下按半月（-1：1–15 日，-2：16–31 日）；再不行按周（-w1…-w5，每 7 日）。同一个月只用一种拆法，id 不会互相覆盖。
const MONTH_PARTS = [() => '', day => (day <= 15 ? '-1' : '-2'), day => `-w${Math.ceil(day / 7)}`];

/**
 * 按 UTC 日打成月块日归档 `{ 'YYYY-MM[-1|-2|-wN]': { v: 3, days: { 'YYYY-MM-DD': { [agent]: [{ a, s, i, m, n }] } } } }`（一行的写法见 wireRow）。
 * 记录 id 是 `<sourceId>/<键>`。每块序列化后不超过 maxBytes：先拆半月、再拆周，仍超就合并小型号。
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
    const build = chunk => keep => ({ v: RECORD_VERSION, days: treeObject(fold(chunk, keep)) });
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
 * 最近 windowHours 小时的滚动曲线 `{ v: 3, slotMs, windowStart, windowEnd, slots: { '<槽起点毫秒>': { [agent]: [{ a, s, i, m, n }] } } }`，
 * 窗口 [windowStart, windowEnd) 对齐 slotMs 且包含 now 所在的槽。记录 id 就是 sourceId，每次覆盖。
 * 超过 maxBytes 先降成 60 分钟槽，再合并小型号。
 */
export function buildTodayBody(buckets, { now, slotMs = SLOT_MS, windowHours = 48, maxBytes = MAX_BODY_BYTES } = {}) {
  const build = (ms, keep) => {
    const windowEnd = (Math.floor(now / ms) + 1) * ms, windowStart = windowEnd - windowHours * 3_600_000;
    const inside = (buckets ?? []).filter(bucket => bucket?.start >= windowStart && bucket.start < windowEnd);
    return { v: RECORD_VERSION, slotMs: ms, windowStart, windowEnd, slots: treeObject(fold(collect(inside, at => Math.floor(at / ms) * ms), keep)) };
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
/** 这条记录（kind、id）是哪台机器（sourceId）发布的。 */
export const sourceOf = (kind, id) => (kind === TODAY_CURVE_KIND ? id : id.split('/')[kind === DAY_ARCHIVE_KIND ? 0 : 1]);
/** 这条记录（kind、id）是不是 sourceId 这台机器发布的。 */
export function ownedBySource(kind, id, sourceId) {
  if (typeof id !== 'string') return false;
  if (kind === USAGE_RECORD_KIND) return id.endsWith(`/${sourceId}`);
  if (kind === DAY_ARCHIVE_KIND) return id.startsWith(`${sourceId}/`);
  return id === sourceId;
}

// ——— 文本清洗 ———

const CONTROL = /[\p{Cc}\u{2028}\u{2029}\u{061C}\u{200E}\u{200F}\u{202A}-\u{202E}\u{2066}-\u{2069}]/gu;
export function cleanText(value, max) {
  if (typeof value !== 'string') return null;
  const text = value.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(text);
  return chars.length ? chars.slice(0, max).join('').trim() || null : null;
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
const API_KIND = /^[a-z][a-z0-9-]{0,63}$/;
const countsOf = row => Object.fromEntries(FIELDS.map((field, i) => [field, row[i]]));
// asked、served、旧标签是身份：记录两端原样保存、按字符串完全相等比较，边界上只验类型与长度（同后端：1–200 字、不含 NUL）；清洗留给渲染层。
const validName = value => typeof value === 'string' && value.length > 0 && Array.from(value).length <= 200 && !value.includes('\0');
// v3 的一行 `{ a, s, u, i, m, n }`：旧标签 m 单独成立，否则 a、s、i 至少有一个（只带服务的行也合法），`u` 是可选的归并名；任何一项不合格整行丢弃，返回 null。
function wireRead(item) {
  if (!item || typeof item !== 'object' || !validRow(item.n)) return null;
  const [asked, served, same, model] = [item.a, item.s, item.u, item.m].map(value => value ?? null), api = item.i ?? null;
  if ([asked, served, same, model].some(value => value !== null && !validName(value)) || (api !== null && !(typeof api === 'string' && API_KIND.test(api)))) return null;
  if (model !== null ? asked !== null || served !== null || same !== null || api !== null : asked === null && served === null && api === null) return null;
  return { api, asked, served, same, model, ...countsOf(item.n) };
}
// 一格里的 Agent → 行摊平成行；不合格的丢掉。v2 是 { [agent]: { [model]: [6 个数] } }（旧标签），v3 是 { [agent]: [{ a, s, i, m, n }] }。
function rowsOf(agents, version) {
  const rows = [];
  if (!agents || typeof agents !== 'object') return rows;
  for (const [agent, list] of Object.entries(agents)) {
    const name = cleanText(agent, 100) ?? '?';
    if (version === 2) {
      if (!list || typeof list !== 'object') continue;
      for (const [model, row] of Object.entries(list)) if (validRow(row)) rows.push({ agent: name, api: null, asked: null, served: null, same: null, model: cleanText(model, 200) ?? '?', ...countsOf(row) });
    } else if (Array.isArray(list)) {
      for (const item of list) { const row = wireRead(item); if (row) rows.push({ agent: name, ...row }); }
    }
  }
  return rows;
}
const partRange = part => (part === '1' ? [1, 15] : part === '2' ? [16, 31] : part ? [Number(part[1]) * 7 - 6, Number(part[1]) * 7 + (part[1] === '5' ? 3 : 0)] : [1, 31]);

/** 一条 `coda/token-day` 记录（v2、v3）：`{ sourceId, days: [{ date, start（UTC 零点）, rows }] }`；id 或版本不对返回 null，日期不在 id 的月份与分块里的、计数不合格的丢掉。 */
export function readArchiveRecord(record) {
  const matched = ARCHIVE_ID.exec(String(record?.id ?? ''));
  if (!matched || !READABLE_VERSIONS.includes(record.body?.v) || !record.body.days || typeof record.body.days !== 'object') return null;
  const [, sourceId, year, month, part] = matched;
  const [first, last] = partRange(part);
  const days = [];
  for (const [date, agents] of Object.entries(record.body.days)) {
    const at = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    if (!at || at[1] !== year || at[2] !== month) continue;
    const start = Date.UTC(Number(year), Number(month) - 1, Number(at[3]));
    if (utcDate(start) !== date || Number(at[3]) < first || Number(at[3]) > last) continue;
    days.push({ date, start, rows: rowsOf(agents, record.body.v) });
  }
  return { sourceId, days };
}

/** 一条 `coda/token-today` 记录（v2、v3）：`{ sourceId, slotMs, windowStart, windowEnd, slots: [{ start, rows }] }`；窗口、槽位对不齐或不在窗口内的丢掉。 */
export function readTodayRecord(record) {
  const id = String(record?.id ?? ''), body = record?.body;
  if (!SOURCE_ID.test(id) || !READABLE_VERSIONS.includes(body?.v) || ![SLOT_MS, 3_600_000].includes(body.slotMs)) return null;
  const { slotMs, windowStart, windowEnd } = body;
  if (!Number.isSafeInteger(windowStart) || !Number.isSafeInteger(windowEnd) || windowStart % slotMs || windowEnd % slotMs || windowEnd <= windowStart || !body.slots || typeof body.slots !== 'object') return null;
  const slots = [];
  for (const [key, agents] of Object.entries(body.slots)) {
    const start = /^\d{1,16}$/.test(key) ? Number(key) : NaN;
    if (!Number.isSafeInteger(start) || start % slotMs || start < windowStart || start >= windowEnd) continue;
    slots.push({ start, rows: rowsOf(agents, body.v) });
  }
  return { sourceId: id, slotMs, windowStart, windowEnd, slots };
}

// ——— 排行榜 ———

const total = c => c.input + c.output + c.cacheRead + c.cacheWrite;
export const compareEntries = (a, b) => b.totalTokens - a.totalTokens || b.turns - a.turns || (a.author < b.author ? -1 : a.author > b.author ? 1 : 0);

// 汇总里一个型号名下的请求项（asked、接口种类）；旧标签行的 asked 取标签本身。
const itemOf = cell => ({ asked: cell.asked, api: cell.api, ...Object.fromEntries(FIELDS.map(field => [field, cell[field]])), totalTokens: total(cell) });
const text = value => value ?? '';
const byCount = (a, b) => total(b) - total(a) || b.turns - a.turns;

/**
 * 按型号名（modelName）聚合：同名的行合成一行，名下按请求项（asked、接口种类）分开列出；轮数按 settleTurns 记在请求项上，
 * 型号行的轮数是它名下请求项之和，同一轮只算一次。`add` 收一行（`{ agent, api, asked, served, model, ...计数 }`），
 * `addModel` 收另一份 `result().models` 里的一项，合并多台、多个来源时用。
 */
export class Tally {
  constructor() { this.sum = zero(); this.rows = new Map(); this.cells = new Map(); }
  add(row) {
    add(this.sum, row);
    const key = JSON.stringify([row.agent ?? null, identityKey(row)]);
    if (!this.rows.has(key)) this.rows.set(key, { agent: row.agent ?? null, api: row.api ?? null, asked: row.asked ?? null, served: row.served ?? null, same: row.same ?? null, model: row.model ?? null, ...zero() });
    add(this.rows.get(key), row);
  }
  addModel(model) {
    add(this.sum, model);
    for (const item of model.items ?? []) this.put(this.cells, model.model, item.api, item.asked, item);
  }
  put(cells, name, api, asked, counts) {
    const key = JSON.stringify([name, api, asked]);
    if (!cells.has(key)) cells.set(key, { model: name, api, asked, ...zero() });
    add(cells.get(key), counts);
  }
  get empty() { return FIELDS.every(field => this.sum[field] === 0); }
  result() {
    const cells = new Map([...this.cells].map(([key, cell]) => [key, { ...cell }]));
    for (const row of settleTurns([...this.rows.values()])) this.put(cells, modelName(row), row.api, row.asked ?? row.model, row);
    const models = new Map();
    for (const cell of cells.values()) {
      if (!models.has(cell.model)) models.set(cell.model, { model: cell.model, ...zero(), items: [] });
      const model = models.get(cell.model);
      add(model, cell);
      model.items.push(itemOf(cell));
    }
    const list = [...models.values()].map(model => ({ ...model, totalTokens: total(model), items: model.items.sort((a, b) => byCount(a, b) || (text(a.asked) < text(b.asked) ? -1 : text(a.asked) > text(b.asked) ? 1 : text(a.api) < text(b.api) ? -1 : 1)) }))
      .sort((a, b) => byCount(a, b) || (a.model < b.model ? -1 : 1));
    return { ...this.sum, totalTokens: total(this.sum), models: list };
  }
}

/** 汇总一批桶（本机自己的）。 */
export function summarizeBuckets(buckets, { from, to }) {
  const tally = new Tally();
  for (const bucket of buckets ?? []) if (bucket.start >= from && bucket.start < to) tally.add(rowOf(bucket));
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
const localRows = (buckets, from, to) => buckets.filter(bucket => bucket.start >= from && bucket.start < to).map(rowOf);

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
 * - 只认 `selfAuthor` 和 `friends` 里出现过的作者。
 * 按总 Token 降序，平局按回合数降序、再按 author 升序。
 * `sources` 是每个 (author, sourceId) 的合计 `{ author, sourceId, local, ...合计与分模型 }`：`local` 是这台自己的本机数据；`todayVersion` 是这个来源当天曲线记录（coda/token-today）的版本，没有这条记录就没有这个字段。
 * `localBuckets` 为 null 表示本机用量没读到：不交出本机来源。多台机器读到同一批记录时，页面按它去重（见 merge.mjs）。
 */
export function aggregateLeaderboard({ selfAuthor, selfSourceId, excludedSourceIds = [], localBuckets = [], legacyUsageRecords = [], dayRecords = [], todayRecords = [], friends = [], from, to, person }) {
  const known = new Set(friends.map(friend => friend?.author).filter(author => typeof author === 'string' && author));
  if (selfAuthor) known.add(selfAuthor);
  // 本机用量没读到（localBuckets 为 null）时，没有本机数据可以优先：自己发布过的副本照常算，也不交出本机来源。
  const excluded = new Set(localBuckets ? [selfSourceId, ...excludedSourceIds] : excludedSourceIds);

  const tallies = new Map([...known].map(author => [author, new Tally()]));
  const shared = new Set();
  const localTally = new Tally();
  if (selfAuthor && localBuckets) for (const row of localRows(filterBucketsByPerson(localBuckets, person), from, to)) { tallies.get(selfAuthor).add(row); localTally.add(row); }

  const sources = new Map();
  const source = (author, sourceId) => {
    if (author === selfAuthor && excluded.has(sourceId)) return null;
    const key = JSON.stringify([author, sourceId]);
    if (!sources.has(key)) sources.set(key, { author, sourceId, days: [], today: null, current: false, legacy: [], todayVersion: null });
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
    if (target) { target.current = true; target.today = read; if (Number.isFinite(record.version)) target.todayVersion = record.version; }
  }
  for (const record of latestOf(legacyUsageRecords, USAGE_RECORD_KIND, known)) {
    const read = readUsageRecord(record, { from, to }), target = read && source(record.author, read.sourceId);
    if (target) target.legacy.push(...read.rows);
  }
  // 每个 (作者, 来源) 的合计也交出去：多台机器各自读到同一批记录，页面按它去重后再按作者汇总。
  const breakdown = selfAuthor && localBuckets ? [{ author: selfAuthor, sourceId: selfSourceId, local: true, ...localTally.result() }] : [];
  for (const target of sources.values()) {
    shared.add(target.author);
    const tally = new Tally();
    for (const row of target.current ? remoteRows(target, from, to) : target.legacy) { tallies.get(target.author).add(row); tally.add(row); }
    breakdown.push({ author: target.author, sourceId: target.sourceId, local: false, ...(target.todayVersion === null ? {} : { todayVersion: target.todayVersion }), ...tally.result() });
  }

  const entries = [...tallies].map(([author, tally]) => ({ author, self: author === selfAuthor, shared: author === selfAuthor || shared.has(author), ...tally.result() })).sort(compareEntries);
  entries.forEach((entry, index) => { entry.rank = index + 1; });
  return { from, to, entries, sources: breakdown };
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
