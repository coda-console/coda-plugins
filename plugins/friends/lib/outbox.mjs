// 网关的纯逻辑：入参校验、保留类型、证书状态、规范哈希，以及待发队列（outbox.json）的条目与状态转换。不碰 Coda。
// 不另建目录库：签名写入与记录查询都由 coda/accord@1 完成；这里只在记录待发、暂停或失败排队时留着待发的 body，
// 同步成功就释放 body，只留去重用的轻量元数据；撤回完成就删掉条目。
import { createHash } from 'node:crypto';
import { readJson, writeJson } from './json-file.mjs';

/** 网关不替业务发布、撤回的类型：好友关系、名片等 Accord 自己的记录。 */
export const RESERVED_KINDS = new Set(['binding', 'profile', 'friends', 'coda/profile', 'coda/friends']);
export const MAX_ID_CHARS = 200, MAX_ID_BYTES = 256, MAX_BODY_BYTES = 65536, MAX_AUDIENCE = 500;
const KIND = /^[a-z][a-z0-9-]{0,63}(?:\/[a-z][a-z0-9-]{0,63})?$/;
const AUDIENCE = /^(?:public|ed25519:[0-9a-f]{64})$/;

export const invalid = message => Object.assign(new Error(message), { code: 'invalid_input', effects: 'none' });
const isPlain = value => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

export const validKind = kind => typeof kind === 'string' && KIND.test(kind) && !RESERVED_KINDS.has(kind);

/** kind 须符合 Accord 的格式，且不是保留类型。 */
export function checkKind(kind) {
  if (typeof kind !== 'string' || !KIND.test(kind)) throw invalid('kind 须是小写字母开头的 name 或 ns/name（只含小写字母、数字、连字符，各段最长 64 位）');
  if (RESERVED_KINDS.has(kind)) throw invalid(`kind「${kind}」是保留类型，网关不发布也不撤回它`);
  return kind;
}

/** id 非空、合法 UTF-8、至多 256 字节；发布与撤回再限 200 个字符（`query: true` 的记录查询只管字节）。 */
export function checkId(id, { query = false } = {}) {
  if (typeof id !== 'string' || !id || !id.isWellFormed()) throw invalid('id 须是非空的文本');
  if (Buffer.byteLength(id) > MAX_ID_BYTES) throw invalid(`id 最多 ${MAX_ID_BYTES} 字节`);
  if (!query && [...id].length > MAX_ID_CHARS) throw invalid(`id 最多 ${MAX_ID_CHARS} 个字符`);
  return id;
}

/** 校验并规范发布的入参：`{ kind, id, body, audience }`，audience 缺省 `['public']`；body 复制一份纯 JSON。 */
export function checkPublish({ kind, id, body, audience = ['public'] } = {}) {
  checkKind(kind);
  checkId(id);
  if (!isPlain(body)) throw invalid('body 须是对象');
  let text;
  try { text = JSON.stringify(body); } catch { throw invalid('body 须能转成 JSON'); }
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw invalid(`body 最多 ${MAX_BODY_BYTES} 字节`);
  if (!Array.isArray(audience) || audience.length > MAX_AUDIENCE) throw invalid(`audience 须是至多 ${MAX_AUDIENCE} 项的数组`);
  if (!audience.every(item => typeof item === 'string' && AUDIENCE.test(item))) throw invalid("audience 每项须是 'public' 或 ed25519:<64 位十六进制>");
  return { kind, id, body: JSON.parse(text), audience: [...audience] };
}

export { certStateOf } from './friends.mjs';

const canonical = value => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
};
/** 规范化哈希：对象键递归按字典序排，再取 JSON 的 SHA-256（十六进制）；键序不同的同一内容哈希相同。 */
export const canonicalHash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

// ---- 条目与状态转换 ----
// 发布条目按 `p:${kind}:${id}` 索引，待撤条目按 `r:${targetAuthor}:${kind}:${id}` 索引（kind 不含冒号，两类前缀互斥，键不会撞）：
// 不同作者对同一个 (kind, id) 排下的待撤互不相干，也不挡着对方撤自己的记录。
// 每次写入发布或撤回的意图都领一个递增的整数 `seq`（落在条目里，不看系统时钟）：冲洗按它的先后执行，并据它判断旧撤回是否已被更晚的发布取代。
//   待发  { seq, kind, id, desired: 'publish', state: queued|paused|no_identity|needs_cert, body, audience, hash, lastError?, + 上次同步的元数据 }
//   已同步 { seq, kind, id, desired: 'publish', state: 'synced', hash, audience, lastAuthor, lastSyncedHash, lastSyncedAt, lastCreatedAt? }（没有 body；
//         lastCreatedAt 是 body.createdAt，同一 id 重试时沿用它，不必再查 Accord）
//   待撤  { seq, kind, id, desired: 'retract', state: queued|no_identity|needs_cert, targetAuthor, lastError?, + 上次同步的元数据 }
//         targetAuthor 是排队时的作者：换了作者就不再替新作者撤，等原作者回来
//   被拒  { …, state: 'error', lastError }：Accord 明确拒绝，不再自动重试；下一次发布或撤回同一条会替换它
export const entryKey = (kind, id) => `p:${kind}:${id}`;
export const retractKey = (author, kind, id) => `r:${author}:${kind}:${id}`;
// 序号计数器挂在整张表上（不可枚举，不算条目），随表一起写进 `outbox.json` 顶层：条目删了、发布被拒了，序号也不会倒退。
const withSeq = (entries, seq) => Object.defineProperty(entries, 'seq', { value: seq, writable: true, configurable: true });
/** 分配下一个意图序号：严格大于此前分配过的所有序号，随下一次写盘落地。 */
export const nextSeq = entries => withSeq(entries, (entries.seq ?? 0) + 1).seq;
export const keyOf = entry => entry.desired === 'retract' ? retractKey(entry.targetAuthor, entry.kind, entry.id) : entryKey(entry.kind, entry.id);
/** 等着发出去的状态（被拒的 error 不算，已同步的也不算）。 */
export const isPending = entry => ['queued', 'paused', 'no_identity', 'needs_cert'].includes(entry?.state);

const synced = prev => ({ ...(prev?.lastAuthor === undefined ? {} : { lastAuthor: prev.lastAuthor }),
  ...(prev?.lastSyncedHash === undefined ? {} : { lastSyncedHash: prev.lastSyncedHash }), ...(prev?.lastSyncedAt === undefined ? {} : { lastSyncedAt: prev.lastSyncedAt }) });

/** 同作者、同内容、已同步的发布不用再发。作者换了（`lastAuthor !== author`）必须重发。 */
export const canSkip = (prev, hash, author) =>
  !!author && prev?.desired === 'publish' && prev.state === 'synced' && prev.lastAuthor === author && prev.lastSyncedHash === hash;

/** 一次发布的待发条目（带 body），保留上一次同步的元数据。 */
export const queuePublish = (prev, { kind, id, body, audience }, seq) =>
  ({ seq, kind, id, desired: 'publish', state: 'queued', body, audience, hash: canonicalHash({ body, audience }), ...synced(prev) });

/** 一次撤回的待撤条目：记下要撤的是哪个作者的记录，保留上一次同步的元数据。 */
export const queueRetract = (prev, kind, id, targetAuthor, seq) => ({ seq, kind, id, desired: 'retract', state: 'queued', targetAuthor, ...synced(prev) });

/** 换状态；`error` 是这次失败的原因，不给就清掉旧的。 */
export function withState(entry, state, error) {
  const { lastError, ...rest } = entry;
  return { ...rest, state, ...(error ? { lastError: error } : {}) };
}

/** 发布成功：释放 body，只留 `{ seq, kind, id, desired, state: 'synced', hash, audience, lastAuthor, lastSyncedHash, lastSyncedAt }`，body 有合法的 createdAt 再留 `lastCreatedAt`。 */
export const markSynced = (entry, author, now) => {
  const createdAt = entry.body?.createdAt;
  return { seq: entry.seq, kind: entry.kind, id: entry.id, desired: 'publish', state: 'synced', hash: entry.hash, audience: entry.audience, lastAuthor: author, lastSyncedHash: entry.hash,
    lastSyncedAt: now, ...(Number.isSafeInteger(createdAt) && createdAt >= 0 ? { lastCreatedAt: createdAt } : {}) };
};

/** Accord 明确拒绝：不再留 body 和 audience，只留元数据与原因。 */
export const markRejected = (entry, message) =>
  ({ kind: entry.kind, id: entry.id, desired: entry.desired, state: 'error', lastError: message, ...(entry.hash === undefined ? {} : { hash: entry.hash }), ...synced(entry) });

/** 现在拦着这个条目、不让它外发的状态：暂停（只管发布，撤回不拦）、没有身份、需要证书；没有就是 null，可以发。 */
export function holdState(entry, certState, pausedKinds) {
  if (entry.desired === 'publish' && pausedKinds.includes(entry.kind)) return 'paused';
  return certState === 'active' ? null : certState;
}

// ---- 持久化 ----

/**
 * 读出整张表 `{ 键: 条目 }`（磁盘上是 `{ seq, entries }`，旧版是直接平铺的条目）；键按条目内容重新规范（兼容旧键名），
 * 缺失、损坏、条目不成样子的都丢掉。序号计数器取顶层 `seq` 与现存条目最大序号中较大的。
 */
export async function readOutbox(dir) {
  const parsed = await readJson(dir, 'outbox.json'), entries = withSeq({}, 0);
  if (!isPlain(parsed)) return entries;
  const stored = isPlain(parsed.entries) ? parsed.entries : parsed;
  for (const entry of Object.values(stored)) {
    if (isPlain(entry) && typeof entry.kind === 'string' && typeof entry.id === 'string' && ['publish', 'retract'].includes(entry.desired) && typeof entry.state === 'string'
      && (entry.desired === 'publish' || typeof entry.targetAuthor === 'string')) entries[keyOf(entry)] = entry;
  }
  return withSeq(entries, Math.max(Number.isSafeInteger(parsed.seq) ? parsed.seq : 0, ...Object.values(entries).map(entry => entry.seq ?? 0)));
}

export const writeOutbox = (dir, entries) => writeJson(dir, 'outbox.json', { seq: entries.seq ?? 0, entries });
