// 不可变事件信封：发出时构造 Accord 记录，入站时校验并前向兼容地解析成会话消息。
import { parseBlobPath } from '@coda-console/protocol/blob';
import { isAuthor } from '@coda-console/protocol/accord';
import { dmConversationId, isConversationId } from './identity.mjs';

export const EVENT_KIND = 'friend-chat/event';
const MAX_RECORD_ID_CHARS = 200, MAX_RECORD_ID_BYTES = 256, MAX_BODY_BYTES = 60000, MAX_DATE = 8.64e15, MAX_ID = 2048;
const MEDIA = new Set(['audio', 'image', 'video', 'file']);
const CHANGES = new Set(['recall', 'edit', 'reaction']);

export function invalidInput(message) {
  return Object.assign(new Error(message), { code: 'invalid_input', effects: 'none' });
}

const isEventId = id => typeof id === 'string' && id.length > 0 && id.isWellFormed() && /^[^\s/\p{Cc}]+$/u.test(id);
const isRecordId = (conv, id) => {
  const recordId = `${conv}/${id}`;
  return recordId.length <= MAX_RECORD_ID_CHARS && Buffer.byteLength(recordId) <= MAX_RECORD_ID_BYTES;
};
const isSentAt = value => Number.isSafeInteger(value) && value >= 0 && value <= MAX_DATE;
const isText = value => typeof value === 'string' && value.length > 0 && value.isWellFormed();
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
// JSON Schema 的 maxLength 数 Unicode 码点：码元数不超过 max 一定符合，超过 2 倍一定不符，之间才展开计数。
const isString = (value, max = Infinity) => typeof value === 'string' && value.isWellFormed()
  && (value.length <= max || (value.length <= max * 2 && [...value].length <= max));
const isCount = (value, min) => Number.isSafeInteger(value) && value >= min;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;

// coda/session@1 read 结果里的 blob 指针：只留 schema 认的键；任何一项不合规给 null。
function cleanBlob(blob) {
  if (!isObject(blob) || typeof blob.owner !== 'string' || !UUID.test(blob.owner) || !parseBlobPath(blob.path)) return null;
  const out = { owner: blob.owner, path: blob.path };
  if (blob.name !== undefined) { if (!isString(blob.name, 1024)) return null; out.name = blob.name; }
  if (blob.size !== undefined) { if (!isCount(blob.size, 0)) return null; out.size = blob.size; }
  if (blob.mime !== undefined) { if (!isString(blob.mime, 255)) return null; out.mime = blob.mime; }
  if (blob.sha256 !== undefined) { if (typeof blob.sha256 !== 'string' || !SHA256.test(blob.sha256)) return null; out.sha256 = blob.sha256; }
  return out;
}

/** 严格符合 coda/session@1 read 结果的消息片段（文本，或带 blob 指针的 audio/image/video/file），去掉多余键；不合规给 null。 */
function cleanPart(part) {
  if (!isObject(part)) return null;
  if (part.type === 'text') return isString(part.text) ? { type: 'text', text: part.text } : null;
  if (!MEDIA.has(part.type) || !isString(part.name, 1024)) return null;
  const blob = cleanBlob(part.blob);
  if (!blob) return null;
  const out = { type: part.type, name: part.name, blob };
  for (const [key, ok] of [['size', v => isCount(v, 0)], ['width', v => isCount(v, 1)], ['height', v => isCount(v, 1)],
    ['duration', v => Number.isFinite(v) && v >= 0], ['mime', v => isString(v, 255)], ['thumb', v => isString(v, 8192)]]) {
    if (part[key] === undefined) continue;
    if (!ok(part[key])) return null;
    out[key] = part[key];
  }
  if (part.preview !== undefined) {
    const preview = cleanBlob(part.preview);
    if (!preview) return null;
    out.preview = preview;
  }
  return out;
}

/** 构造要发布的消息事件：`{ recordId, body }`，recordId 是 `${conv}/${id}`。 */
export function buildMessageEvent({ conv, id, sentAt, text, parts } = {}) {
  if (!isConversationId(conv)) throw invalidInput('会话 ID 不合法');
  if (!isEventId(id) || !isRecordId(conv, id)) throw invalidInput('事件 ID 不合法');
  if (!isSentAt(sentAt)) throw invalidInput('sentAt 须为非负安全整数毫秒时间戳');
  if (!isText(text)) throw invalidInput('消息文本须为非空的合法 UTF-8 字符串');
  const clean = parts === undefined ? [{ type: 'text', text }] : Array.isArray(parts) ? parts.map(cleanPart) : null;
  if (!clean || clean.includes(null)) throw invalidInput('消息片段不合法');
  const body = { v: 1, conv, id, type: 'message', sentAt, text, parts: clean };
  if (Buffer.byteLength(JSON.stringify(body)) > MAX_BODY_BYTES) throw invalidInput('消息太大');
  return { recordId: `${conv}/${id}`, body };
}

// 变更目标写成 `<作者>/<eventId>`；不含 `/` 的裸 eventId 指作者自己的消息。
function targetOf(target, author) {
  const cut = target.indexOf('/');
  const [owner, id] = cut < 0 ? [author, target] : [target.slice(0, cut), target.slice(cut + 1)];
  return isAuthor(owner) && isEventId(id) && id.length <= MAX_RECORD_ID_CHARS ? `${owner}/${id}` : null;
}

const invalid = reason => ({ status: 'invalid', reason });

/**
 * 解析入站的 Accord 记录。结果的 status：
 * - `empty`：撤回后的空体记录；`ignored`：认得信封但没有可显示内容；`invalid`：不合规（带 reason）；
 * - `ok`：`{ conv, id, author, sentAt, text, parts?, about? }`。
 * 传了 `{ selfRoot, peerAuthor }` 时，单聊会话必须正是这两人之间的，且记录作者是其中之一。
 */
export function parseEventRecord(record, context) {
  if (record?.kind !== EVENT_KIND || !isAuthor(record.author)) return invalid('不是好友对话事件');
  // 只有完全没给成员上下文才不做成员校验；给了任一个，两个都必须是合法公钥。
  const scoped = context != null && ('selfRoot' in context || 'peerAuthor' in context);
  if (scoped && !(isAuthor(context.selfRoot) && isAuthor(context.peerAuthor))) return invalid('成员上下文不完整');
  const body = record.body;
  if (!body || Object.keys(body).length === 0) return { status: 'empty' };
  if (body.v !== 1) return invalid('不支持的信封版本');
  if (!isConversationId(body.conv)) return invalid('会话 ID 不合法');
  if (!isEventId(body.id) || !isRecordId(body.conv, body.id) || record.id !== `${body.conv}/${body.id}`) return invalid('事件 ID 与记录 ID 不一致');
  if (!isSentAt(body.sentAt)) return invalid('sentAt 不合法');
  if (scoped && body.conv.startsWith('dm:')) {
    const { selfRoot, peerAuthor } = context;
    let expected;
    try { expected = dmConversationId(selfRoot, peerAuthor); } catch { return invalid('会话成员不合法'); }
    if (body.conv !== expected) return invalid('会话不属于本机与该好友');
    if (record.author !== selfRoot && record.author !== peerAuthor) return invalid('记录作者不是会话成员');
  }
  const base = { status: 'ok', conv: body.conv, id: body.id, author: record.author, sentAt: body.sentAt };
  const text = typeof body.text === 'string' ? body.text : '';
  if (body.type === 'message') {
    const parts = (Array.isArray(body.parts) ? body.parts : []).map(cleanPart).filter(Boolean);
    const shown = text || parts.filter(part => part.type === 'text').map(part => part.text).join('\n');
    return parts.length || shown ? { ...base, text: shown, ...(parts.length ? { parts } : {}) } : { status: 'ignored' };
  }
  if (CHANGES.has(body.type)) {
    if (typeof body.target !== 'string' || !body.target) return { status: 'ignored' };
    const message = targetOf(body.target, record.author);
    if (!message) return invalid('变更目标不合法');
    if (body.value !== undefined && !isString(body.value, MAX_ID)) return invalid('变更内容不合法');
    return { ...base, text, about: { message, change: body.type, ...(body.value !== undefined ? { value: body.value } : {}) } };
  }
  return text ? { ...base, text, parts: [{ type: 'text', text }] } : { status: 'ignored' };
}
