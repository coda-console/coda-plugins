// 好友页的纯逻辑：解析邀请、名片的清洗与读取、把好友表与名片、本地备注合成列表行。不碰 Coda，也不碰磁盘。
// 页面也加载它，所以只用浏览器和 Node 都有的 API。

export const COLORS = ['blue', 'orange', 'green', 'purple', 'pink', 'teal', 'gray'];
export const PROFILE_KIND = 'profile';
export const PROFILE_ID = 'self';
const MAX_NAME = 40, MAX_EMOJI = 8;
// 邀请各字段的上限，与 coda/accord@1 的 accept 输入一致。
const LIMITS = { control: 500, authKey: 500, linkId: 64, scope: 200, hostname: 100, peerNode: 100 };
const LABELS = { control: '入网地址 control', authKey: '入网码 authKey', linkId: 'linkId', scope: 'scope', hostname: 'hostname', peerNode: 'peerNode' };
const LINK_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ALIASES = { controlurl: 'control', control_url: 'control', authkey: 'authKey', auth_key: 'authKey', linkid: 'linkId', link_id: 'linkId',
  link: 'linkId', peernode: 'peerNode', peer_node: 'peerNode' };
const CONTROL_CHARS = /[\p{Cc}\u2028\u2029]/gu;
const length = text => [...text].length;

const clean = text => typeof text === 'string' ? text.replace(CONTROL_CHARS, '').trim() : '';

// ---- 邀请 ----

const fail = message => { throw new Error(message); };
const field = key => ALIASES[key] ?? ALIASES[key.toLowerCase()] ?? (Object.hasOwn(LIMITS, key) ? key : null);

function fromObject(object) {
  const found = {};
  for (const [key, value] of Object.entries(object)) {
    const name = field(key);
    if (!name || value === undefined || value === null) continue;
    if (typeof value !== 'string' && typeof value !== 'number') fail(`${LABELS[name]} 须是文本`);
    found[name] = String(value);
  }
  return found;
}

function fromUrl(text) {
  let url;
  try { url = new URL(text); } catch { return null; }
  const found = fromObject(Object.fromEntries(url.searchParams));
  // coda-friend://host/path?authKey=… 没有写 control 时，用它的地址当入网地址。
  if (!found.control && url.protocol === 'coda-friend:' && url.host) found.control = `https://${url.host}${url.pathname === '/' ? '' : url.pathname}`;
  return found;
}

function fromLines(text) {
  const found = {};
  for (const line of text.split(/\r?\n|&/)) {
    const at = line.search(/[=:：]/);
    if (at < 1) continue;
    const key = line.slice(0, at).trim(), name = field(key);
    // 值里自带的冒号（如 https://）只在第一个分隔符处切开。
    if (name) found[name] = line.slice(at + 1).trim();
  }
  return found;
}

/**
 * 把粘贴的邀请解析成 accept 的入参：`{ linkId, control, authKey, scope?, hostname?, peerNode? }`。
 * 接受 JSON 对象、coda-friend:// 或带查询串的链接、多行 key=value；错误抛出清晰的中文提示。
 */
export function parseInvite(raw) {
  if (typeof raw !== 'string' || !raw.trim()) fail('请先粘贴邀请内容');
  const text = raw.trim();
  if (text.includes('\0')) fail('邀请内容含有不合法的字符');
  let found;
  if (/^[{[]/.test(text)) {
    let object;
    try { object = JSON.parse(text); } catch { fail('邀请不是合法的 JSON'); }
    if (!object || typeof object !== 'object' || Array.isArray(object)) fail('邀请 JSON 须是对象');
    found = fromObject(object);
  } else {
    found = /^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(text) ? fromUrl(text) : null;
    if (!found || !Object.keys(found).length) found = fromLines(text);
  }
  const invite = {};
  for (const [name, value] of Object.entries(found)) {
    const one = value.trim();
    if (/[\0]/.test(value)) fail(`${LABELS[name]} 含有不合法的字符`);
    if (one) invite[name] = one;
  }
  return checked(invite);
}

/** 校验一份邀请（分字段表单也走这里）。 */
export function checked(input) {
  const invite = {};
  for (const name of Object.keys(LIMITS)) {
    const value = typeof input?.[name] === 'string' ? input[name].trim() : '';
    if (/[\0]/.test(value)) fail(`${LABELS[name]} 含有不合法的字符`);
    if (value) invite[name] = value;
  }
  if (!invite.control) fail('邀请缺少 control（入网地址）');
  if (!invite.authKey) fail('邀请缺少 authKey（入网码）');
  for (const [name, max] of Object.entries(LIMITS)) if (invite[name] && length(invite[name]) > max) fail(`${LABELS[name]} 太长（最多 ${max} 字）`);
  if (invite.linkId && !LINK_ID.test(invite.linkId)) fail('linkId 须以小写字母或数字开头，只能含小写字母、数字、下划线和连字符，最长 64 位');
  invite.linkId ??= `f-${[...globalThis.crypto.getRandomValues(new Uint8Array(4))].map(n => n.toString(16).padStart(2, '0')).join('')}`;
  return invite;
}

// ---- 名片 ----

/** 名片输入的清洗：昵称 1–40 字，emoji 最多 8 字，颜色须在白名单里。不合法的昵称、emoji 抛错；不认识的颜色丢掉。 */
export function normalizeProfileInput({ name, emoji, color } = {}) {
  const body = { name: clean(name) };
  if (!body.name) fail('昵称不能为空');
  if (length(body.name) > MAX_NAME) fail(`昵称最多 ${MAX_NAME} 个字`);
  const mark = clean(emoji);
  if (mark) { if (length(mark) > MAX_EMOJI) fail(`头像最多 ${MAX_EMOJI} 个字符`); body.emoji = mark; }
  if (typeof color === 'string' && COLORS.includes(color)) body.color = color;
  return body;
}

/**
 * 读 Accord 记录里的名片，来自好友的外来数据：按同样的规则清洗，不合法的字段忽略，昵称不合法整张忽略（null）。
 * 结果只当文本用，不当指令或 HTML。
 */
export function readProfileRecord(record) {
  if (!record || record.kind !== PROFILE_KIND || record.id !== PROFILE_ID) return null;
  const body = record.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const name = clean(body.name);
  if (!name || length(name) > MAX_NAME) return null;
  const profile = { author: typeof record.author === 'string' ? record.author : null, version: Number.isFinite(record.version) ? record.version : 0, name };
  const emoji = clean(body.emoji);
  if (emoji && length(emoji) <= MAX_EMOJI) profile.emoji = emoji;
  if (typeof body.color === 'string' && COLORS.includes(body.color)) profile.color = body.color;
  return profile;
}

/** 密钥的短码：`ed25519:` 之后的前 8 位（没有就空串）。 */
export function shortAuthor(author) {
  const match = /^ed25519:([0-9a-f]{64})$/.exec(author ?? '');
  return match ? match[1].slice(0, 8) : '';
}

// ---- 好友列表 ----

const RANK = { conflict: 0, pending: 1, bound: 2 };
export const statusOf = friend => friend.conflict ? 'conflict' : friend.bound ? 'bound' : 'pending';

/**
 * 好友表（`status.friends`）、好友的名片记录（取每把钥匙 version 最大的）和本地备注（按 node，没有再按 author）合成的行，
 * 按状态（冲突、待互认、已互认）再按更新时间新的在前排序，同样的输入排出同样的顺序。
 */
export function mergeFriendRows({ friends = [], profiles = [], notes = {} } = {}) {
  const latest = new Map();
  for (const record of profiles) {
    const profile = readProfileRecord(record);
    if (profile?.author && (!latest.has(profile.author) || profile.version > latest.get(profile.author).version)) latest.set(profile.author, profile);
  }
  const note = friend => (Object.hasOwn(notes, friend.node) ? notes[friend.node] : friend.author && Object.hasOwn(notes, friend.author) ? notes[friend.author] : '');
  const rows = friends.map(friend => {
    const profile = friend.author ? latest.get(friend.author) ?? null : null, status = statusOf(friend), remark = clean(note(friend));
    const short = shortAuthor(friend.author);
    return { node: friend.node, author: friend.author ?? null, short, status, peerNode: friend.peerNode ?? null, scope: friend.scope, updatedAt: friend.updatedAt ?? 0,
      note: remark, profileName: profile?.name ?? '', emoji: profile?.emoji ?? '', color: profile?.color ?? 'gray',
      title: remark || profile?.name || (short ? `好友 ${short}` : friend.node) };
  });
  return rows.sort((a, b) => RANK[a.status] - RANK[b.status] || b.updatedAt - a.updatedAt || (a.node < b.node ? -1 : a.node > b.node ? 1 : 0));
}
