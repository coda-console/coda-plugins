// 规范卡片：YAML frontmatter + Markdown 正文。
// frontmatter 每行是 `键: JSON 值`（JSON 的标量和数组同时是合法的 YAML 流式写法），不引第三方 YAML 库，往返完全一致。
import { randomBytes } from 'node:crypto';
import { DEFAULT_IMPORTANCE, ID_PATTERN, KINDS, MAX_BODY_BYTES, MAX_ENTITIES, MAX_ENTITY_BYTES, MAX_TAGS, MAX_TAG_BYTES, STATUSES } from './definitions.mjs';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ISO_UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/;
const LIST_FIELDS = ['entities', 'tags', 'supersedes', 'contradicts', 'related'];
// 序列化的字段顺序；archived_reason 只在有值时写。
const ORDER = ['id', 'kind', 'status', 'importance', 'refs', ...LIST_FIELDS, 'created_at', 'updated_at', 'archived_reason'];

const encode = (value, length) => {
  let out = '';
  for (let i = 0; i < length; i++, value >>= 5n) out = CROCKFORD[Number(value & 31n)] + out;
  return out;
};
let lastTime = -1, lastRandom = 0n;
// 26 位 Crockford Base32 ULID：同一毫秒内随机部分递增，保证单调。
export function newId(now = Date.now()) {
  if (now > lastTime) {
    lastTime = now;
    lastRandom = BigInt(`0x${randomBytes(10).toString('hex')}`);
  } else {
    lastRandom = (lastRandom + 1n) & ((1n << 80n) - 1n);
  }
  return encode(BigInt(lastTime), 10) + encode(lastRandom, 16);
}

export function assertId(id) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new Error(`卡片 id 只能是 1 到 64 位的字母、数字、下划线和连字符：${JSON.stringify(id)}`);
  return id;
}

// 每项 trim、去重保序；空项报错。
export function stringList(value, name, { required = false, id = false } = {}) {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value)) throw new Error(`${name} 必须是字符串数组`);
  const out = [];
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) throw new Error(`${name} 的每一项都必须是非空字符串`);
    const text = item.trim();
    if (id) assertId(text);
    if (!out.includes(text)) out.push(text);
  }
  if (required && !out.length) throw new Error(`${name} 至少要有一项`);
  return out;
}

// 数量和每项的 UTF-8 字节数都不能超过 mnemon 的上限。
const assertLimits = (items, name, maxItems, maxBytes) => {
  if (items.length > maxItems) throw new Error(`${name} 最多 ${maxItems} 个，现有 ${items.length} 个`);
  const long = items.find(item => Buffer.byteLength(item, 'utf8') > maxBytes);
  if (long !== undefined) throw new Error(`${name} 的每一项不能超过 ${maxBytes} 字节：${JSON.stringify(long)}`);
};

const oneOf = (value, allowed, name) => {
  if (!allowed.includes(value)) throw new Error(`${name} 必须是 ${allowed.join('、')} 之一：${JSON.stringify(value)}`);
  return value;
};
// 格式对、日历上也要真有这一天这一刻（2026-02-30、24:00:00 都不行）。
const timestamp = (value, name) => {
  const match = typeof value === 'string' && ISO_UTC.exec(value);
  const [year, month, day, hour, minute, second] = match ? match.slice(1, 7).map(Number) : [];
  const date = match && new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (!match || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) {
    throw new Error(`${name} 必须是 ISO 8601 UTC 时间：${JSON.stringify(value)}`);
  }
  return value;
};

// 校验并规整一张卡片，返回新对象；缺省值在这里补。
export function normalizeCard(input) {
  if (!input || typeof input !== 'object') throw new Error('卡片必须是对象');
  // 正文只用 trim 判空，原样保留首尾空白和缩进。
  const body = input.body;
  if (typeof body !== 'string' || !body.trim()) throw new Error('卡片正文不能为空');
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > MAX_BODY_BYTES) throw new Error(`卡片正文 ${bytes} 字节，超过 mnemon 的 ${MAX_BODY_BYTES} 字节上限`);
  const importance = input.importance ?? DEFAULT_IMPORTANCE;
  if (!Number.isInteger(importance) || importance < 1 || importance > 5) throw new Error(`importance 必须是 1 到 5 的整数：${JSON.stringify(importance)}`);
  const card = {
    id: assertId(input.id),
    kind: oneOf(input.kind, KINDS, 'kind'),
    status: oneOf(input.status ?? 'active', STATUSES, 'status'),
    importance,
    refs: stringList(input.refs, 'refs', { required: true }),
  };
  for (const field of LIST_FIELDS) card[field] = stringList(input[field], field, { id: ['supersedes', 'contradicts', 'related'].includes(field) });
  assertLimits(card.tags, 'tags', MAX_TAGS, MAX_TAG_BYTES);
  assertLimits(card.entities, 'entities', MAX_ENTITIES, MAX_ENTITY_BYTES);
  card.created_at = timestamp(input.created_at, 'created_at');
  card.updated_at = timestamp(input.updated_at, 'updated_at');
  if (input.archived_reason !== undefined) {
    if (typeof input.archived_reason !== 'string') throw new Error('archived_reason 必须是字符串');
    if (input.archived_reason.trim()) card.archived_reason = input.archived_reason.trim();
  }
  card.body = body;
  return card;
}

export function serializeCard(input) {
  const card = normalizeCard(input);
  const lines = ORDER.filter(key => card[key] !== undefined).map(key => `${key}: ${JSON.stringify(card[key])}`);
  return `---\n${lines.join('\n')}\n---\n\n${card.body}\n`;
}

export function parseCard(text) {
  // 文件整体是 CRLF 时（如 git 换行转换）按 CRLF 的分隔符解析；本插件自己写的都是 LF。
  const eol = typeof text === 'string' && text.startsWith('---\r\n') ? '\r\n' : '\n';
  if (typeof text !== 'string' || !text.startsWith(`---${eol}`)) throw new Error('卡片缺少 frontmatter 开头的 ---');
  const end = text.indexOf(`${eol}---${eol}`, 3);
  if (end < 0) throw new Error('卡片缺少 frontmatter 结尾的 ---');
  const card = {};
  for (const line of text.slice(3 + eol.length, end).split(eol)) {
    // s 标志让 . 也匹配 U+2028、U+2029。
    const match = /^([a-z_]+): (.*)$/s.exec(line);
    if (!match) throw new Error(`frontmatter 的行写法不对：${line}`);
    const [, key, raw] = match;
    if (!ORDER.includes(key)) throw new Error(`frontmatter 里有不认识的字段：${key}`);
    if (key in card) throw new Error(`frontmatter 的字段重复：${key}`);
    try { card[key] = JSON.parse(raw); } catch { throw new Error(`frontmatter 字段 ${key} 的值不是合法 JSON：${raw}`); }
  }
  let body = text.slice(end + 3 + 2 * eol.length);
  if (body.startsWith(eol)) body = body.slice(eol.length);
  if (body.endsWith(eol)) body = body.slice(0, -eol.length);
  card.body = body;
  return normalizeCard(card);
}
