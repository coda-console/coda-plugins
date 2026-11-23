// 私信 friends/dm 与好友动态 friends/feed 的纯逻辑：发布入参的清洗、Accord 记录的投影，以及实时流的变更集与游标。不碰 Coda，也不碰磁盘。
// 记录照旧由 coda/accord@1 签名与保存；这里只把一页页读回来的记录投影成规范项，并在内存里比对前后两份投影，算出增量帧。
import { normalizeContentPointer, readContentPointer } from './friends.mjs';

export const DM_KIND = 'friends/dm', FEED_KIND = 'friends/feed';
export const MAX_TEXT = 8000, MAX_MEDIA = 4, MAX_HISTORY = 500;
// 快照一帧的字节上限，远低于 readFrames 默认的一行 1 MiB：快照按它分片。
export const MAX_SNAPSHOT_FRAME_BYTES = 256 * 1024;
const MAX_ID = 200, MAX_ID_BYTES = 256, MAX_AUDIENCE = 500;
const AUTHOR = /^ed25519:[0-9a-f]{64}$/, AUDIENCE = /^(?:public|ed25519:[0-9a-f]{64})$/;
const CONTROL = /[\p{Cc}]/u;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const CURSOR = new RegExp(`^(${UUID}):(0|[1-9][0-9]*)$`);

const fail = message => { throw new Error(message); };
const length = text => [...text].length;
const encoder = new TextEncoder();
const bytes = text => encoder.encode(text).length;
const isPlain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isTime = value => Number.isSafeInteger(value) && value >= 0;
const validLabel = text => typeof text === 'string' && text.length > 0 && length(text) <= MAX_ID && !CONTROL.test(text);
export const isAuthor = value => typeof value === 'string' && AUTHOR.test(value);

// ---- 发布入参 ----

/**
 * 可选的 id、replyTo：原样至多 200 个字符（与 schema 的 maxLength 同样按码点数）、UTF-8 至多 256 字节（与 Accord 一致）、
 * 不含控制字符，去首尾空白后不能是空的；省略给 undefined（id 由调用方生成）。
 */
function readLabel(value, name) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || length(value) > MAX_ID || bytes(value) > MAX_ID_BYTES || CONTROL.test(value) || !value.trim())
    fail(`${name} 须是 1–${MAX_ID} 个字符、UTF-8 至多 ${MAX_ID_BYTES} 字节的文本，不含控制字符`);
  return value.trim();
}

/** text 原样至多 8000 个字（码点，与 schema 一致），再去首尾空白。 */
function readText(text) {
  if (text === undefined) return '';
  if (typeof text !== 'string') fail('text 须是文本');
  if (length(text) > MAX_TEXT) fail(`text 最多 ${MAX_TEXT} 个字`);
  return text.trim();
}

function readPointers(list, name) {
  if (list === undefined) return [];
  if (!Array.isArray(list) || !list.length || list.length > MAX_MEDIA) fail(`${name} 须是 1–${MAX_MEDIA} 项的数组`);
  return list.map(normalizeContentPointer);
}

const createdAtOf = (existingCreatedAt, now) => {
  const at = isTime(existingCreatedAt) ? existingCreatedAt : now;
  if (!isTime(at)) fail('createdAt 须是非负整数');
  return at;
};

/**
 * 私信的入参 `{ to, id?, text?, attachments?, replyTo? }` → `{ id, to, audience: [to], body }`。只发给一个人，不能发给 public 或自己；
 * text 与 attachments 不能都空。createdAt 先用同一 id 已有记录的（重试时内容不变，才能按幂等跳过），没有再取 now。
 */
export function normalizeDmInput(input, { selfAuthor, existingCreatedAt, now = Date.now() } = {}) {
  if (!isPlain(input)) fail('私信须是对象');
  const { to } = input;
  if (!isAuthor(to)) fail('to 须是一位好友的公钥 ed25519:<64 位小写十六进制>');
  if (to === selfAuthor) fail('不能给自己发私信');
  const id = readLabel(input.id, 'id'), text = readText(input.text), attachments = readPointers(input.attachments, 'attachments');
  if (!text && !attachments.length) fail('私信的 text 与 attachments 不能都空');
  const replyTo = readLabel(input.replyTo, 'replyTo'), createdAt = createdAtOf(existingCreatedAt, now);
  return { id, to, audience: [to], body: { to, text, ...(attachments.length ? { attachments } : {}), ...(replyTo ? { replyTo } : {}), createdAt } };
}

/**
 * 动态的入参 `{ id?, text?, media?, audience? }` → `{ id, audience, body }`。audience 省略是 `['public']`，写了须是 1–500 项、
 * 每项 public 或公钥，去重；`[]` 不收（撤回走 retract）。text 与 media 不能都空；createdAt 同私信。
 */
export function normalizeFeedInput(input, { existingCreatedAt, now = Date.now() } = {}) {
  if (!isPlain(input)) fail('动态须是对象');
  const id = readLabel(input.id, 'id'), text = readText(input.text), media = readPointers(input.media, 'media');
  if (!text && !media.length) fail('动态的 text 与 media 不能都空');
  const { audience = ['public'] } = input;
  if (!Array.isArray(audience) || !audience.length || audience.length > MAX_AUDIENCE) fail(`audience 须是 1–${MAX_AUDIENCE} 项的数组；撤回用 retract`);
  if (!audience.every(item => typeof item === 'string' && AUDIENCE.test(item))) fail("audience 每项须是 'public' 或 ed25519:<64 位小写十六进制>");
  return { id, audience: [...new Set(audience)], body: { text, ...(media.length ? { media } : {}), createdAt: createdAtOf(existingCreatedAt, now) } };
}

// ---- 记录投影 ----

// 每个 (author, id) 只留 version 最大的一条：最新的是撤回（空 body）或畸形，整条就算没了，不回落到旧版本。
function latest(records) {
  const top = new Map();
  for (const record of records ?? []) {
    if (!isPlain(record) || typeof record.author !== 'string' || typeof record.id !== 'string') continue;
    const key = JSON.stringify([record.author, record.id]), version = Number.isSafeInteger(record.version) ? record.version : 0;
    if (!top.has(key) || version > top.get(key).version) top.set(key, { record, version });
  }
  return [...top.values()];
}

// 外来正文：text 是至多 8000 字的文本（不合法当空），图片指针只留校验通过的、至多 4 个；两样都空、或 createdAt 不对就是畸形（null）。
function readBody(body, pointersKey) {
  if (!isPlain(body) || !isTime(body.createdAt)) return null;
  const text = typeof body.text === 'string' && length(body.text) <= MAX_TEXT ? body.text.trim() : '';
  const pointers = Array.isArray(body[pointersKey]) ? body[pointersKey].map(readContentPointer).filter(Boolean).slice(0, MAX_MEDIA) : [];
  return text || pointers.length ? { text, pointers, createdAt: body.createdAt } : null;
}

const compare = (a, b) => a.createdAt - b.createdAt || a.version - b.version || (a.author < b.author ? -1 : a.author > b.author ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Accord 的 friends/dm 记录 → 私信规范项，按 (createdAt, version, author, id) 升序。只收真是本机与对方之间的：本机发出的须是本人签的、
 * 发给别人；收到的须是别人签的、发给本人。`peer` 是对面那个人。
 */
export function projectDmRecords(records, { selfAuthor } = {}) {
  const items = [];
  for (const { record, version } of latest(records)) {
    const body = readBody(record.body, 'attachments'), to = record.body?.to;
    if (!body || !isAuthor(to)) continue;
    let peer;
    if (record.local === true && record.author === selfAuthor && to !== selfAuthor) peer = to;
    else if (record.local === false && record.author !== selfAuthor && to === selfAuthor) peer = record.author;
    else continue;
    const { replyTo } = record.body;
    items.push({ author: record.author, id: record.id, version, local: record.local, peer, to, text: body.text, attachments: body.pointers,
      ...(validLabel(replyTo) ? { replyTo } : {}), createdAt: body.createdAt });
  }
  return items.sort(compare);
}

/** Accord 的 friends/feed 记录 → 动态规范项，按 (createdAt, version, author, id) 降序（新的在前）。 */
export function projectFeedRecords(records) {
  const items = [];
  for (const { record, version } of latest(records)) {
    const body = readBody(record.body, 'media');
    if (body) items.push({ author: record.author, id: record.id, version, local: record.local === true, text: body.text, media: body.pointers, createdAt: body.createdAt });
  }
  return items.sort((a, b) => compare(b, a));
}

// ---- 变更集与游标 ----

/** 游标 `${epoch}:${seq}` → `{ epoch, seq }`；不合法给 null。 */
export function parseCursor(after) {
  const match = typeof after === 'string' ? CURSOR.exec(after) : null;
  if (!match) return null;
  const seq = Number(match[2]);
  return Number.isSafeInteger(seq) ? { epoch: match[1], seq } : null;
}

const keyOf = item => JSON.stringify([item.author, item.id]);
/** 一次变化里用来过滤的那一项：upsert 看它的 item，retract 看它自己（带 author、peer）。 */
export const subjectOf = event => event.type === 'upsert' ? event.item : event;
/** 变化 → 帧：seq 换成游标。 */
export const frameOf = (epoch, { seq, ...event }) => ({ ...event, cursor: `${epoch}:${seq}` });

/**
 * 快照的帧：items 按序切成每帧 JSON 至多 `maxBytes` 字节的几片，`{ type: 'snapshot', cursor, items, more }`，还有后续分片的
 * `more` 为 true，最后一片（空快照也有这一片，`items: []`）为 false；客户端收到 more 为 false 才把整份快照与游标落定。
 */
export function snapshotFrames(cursor, items, maxBytes = MAX_SNAPSHOT_FRAME_BYTES) {
  const empty = bytes(JSON.stringify({ type: 'snapshot', cursor, items: [], more: false })), chunks = [[]];
  let size = empty;
  for (const item of items) {
    const one = bytes(JSON.stringify(item)) + 1;
    if (chunks.at(-1).length && size + one > maxBytes) { chunks.push([]); size = empty; }
    chunks.at(-1).push(item);
    size += one;
  }
  return chunks.map((chunk, i) => ({ type: 'snapshot', cursor, items: chunk, more: i < chunks.length - 1 }));
}

/**
 * 一条流的内存状态：启动时的 epoch、单调的 seq、当前投影（按 (author, id)）、至多 `maxHistory` 条变化的环缓冲。
 * `applySnapshot` 换上新一份投影并给出这次的变化；`resume(after, match)` 按游标给出续上的增量，续不上就给全量快照。
 */
export function createStreamHub({ epoch = globalThis.crypto.randomUUID(), maxHistory = MAX_HISTORY } = {}) {
  let seq = 0, current = new Map(), history = [];
  const oldestSeq = () => history.length ? history[0].seq : seq + 1;
  const cursor = () => `${epoch}:${seq}`;
  return {
    epoch,
    get seq() { return seq; },
    get oldestSeq() { return oldestSeq(); },
    cursor,
    items: () => [...current.values()],
    // 先在局部算好这次的变化，最后一并换上投影、seq 与历史：中途出错，hub 还是原来那份。
    applySnapshot(nextItems) {
      const next = new Map(nextItems.map(item => [keyOf(item), item])), events = [];
      let at = seq;
      for (const [key, item] of current) {
        if (!next.has(key)) events.push({ seq: ++at, type: 'retract', author: item.author, id: item.id, ...(item.peer ? { peer: item.peer } : {}) });
      }
      for (const [key, item] of next) {
        const old = current.get(key);
        if (old && old.version === item.version && JSON.stringify(old) === JSON.stringify(item)) continue;
        // 同一条私信换了收件人：旧会话那边先撤掉，新会话再收到它。
        if (old?.peer && old.peer !== item.peer) events.push({ seq: ++at, type: 'retract', author: old.author, id: old.id, peer: old.peer });
        events.push({ seq: ++at, type: 'upsert', item });
      }
      // 不把 events 展开成实参（一次几十万条会超出实参上限）：够多就只取最后 maxHistory 条，否则逐条追加再裁。
      let kept;
      if (events.length >= maxHistory) kept = events.slice(-maxHistory);
      else {
        kept = history.slice();
        for (const event of events) kept.push(event);
        if (kept.length > maxHistory) kept.splice(0, kept.length - maxHistory);
      }
      current = next;
      seq = at;
      history = kept;
      return events;
    },
    resume(after, match = () => true) {
      const at = parseCursor(after);
      if (!at || at.epoch !== epoch || at.seq > seq || at.seq < oldestSeq() - 1) return { mode: 'snapshot', cursor: cursor(), items: [...current.values()].filter(match) };
      return { mode: 'delta', cursor: cursor(), events: history.filter(event => event.seq > at.seq && match(subjectOf(event))) };
    },
  };
}
