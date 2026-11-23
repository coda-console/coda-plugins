// 好友页的纯逻辑：解析邀请、名片的清洗与读取、把好友表与名片、本地备注合成列表行。不碰 Coda，也不碰磁盘。
// 页面也加载它，所以只用浏览器和 Node 都有的 API。

export const COLORS = ['blue', 'orange', 'green', 'purple', 'pink', 'teal', 'gray'];
export const PROFILE_KIND = 'profile';
export const PROFILE_ID = 'self';
// 可代签的社交名片：和 profile 同形，id 也是 self；profile 须客户端根签，绑定代签证书后用它。
export const CARD_KIND = 'friends/card';
const MAX_NAME = 40, MAX_EMOJI = 8;
// 邀请各字段的上限，与 coda/accord@1 的 accept 输入一致。
const LIMITS = { control: 500, authKey: 500, linkId: 64, scope: 520, hostname: 100, peerNode: 100 };
const LABELS = { control: '入网地址 control', authKey: '入网码 authKey', linkId: 'linkId', scope: 'scope', hostname: 'hostname', peerNode: 'peerNode', peerPort: 'peerPort' };
const LINK_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ALIASES = { controlurl: 'control', control_url: 'control', authkey: 'authKey', auth_key: 'authKey', linkid: 'linkId', link_id: 'linkId',
  link: 'linkId', peernode: 'peerNode', peer_node: 'peerNode', peerport: 'peerPort', peer_port: 'peerPort' };
const CONTROL_CHARS = /[\p{Cc}\u2028\u2029]/gu;
const length = text => [...text].length;

const clean = text => typeof text === 'string' ? text.replace(CONTROL_CHARS, '').trim() : '';

// ---- 邀请 ----

const fail = message => { throw new Error(message); };
const field = key => ALIASES[key] ?? ALIASES[key.toLowerCase()] ?? (Object.hasOwn(LABELS, key) ? key : null);

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
 * 把粘贴的邀请解析成 accept 的入参：`{ linkId, control, authKey, scope?, hostname?, peerNode?, peerPort? }`。
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
  const raw = input?.peerPort;
  if (raw !== undefined && raw !== null && typeof raw !== 'number' && typeof raw !== 'string') fail('peerPort 须是 1–65535 的整数');
  const port = typeof raw === 'string' ? raw.trim() : raw;
  if (port !== undefined && port !== null && port !== '') {
    const number = typeof port === 'number' ? port : /^\d+$/.test(port) ? Number(port) : NaN;
    if (!Number.isInteger(number) || number < 1 || number > 65535) fail('peerPort 须是 1–65535 的整数');
    invite.peerPort = number;
  }
  if (invite.linkId && !LINK_ID.test(invite.linkId)) fail('linkId 须以小写字母或数字开头，只能含小写字母、数字、下划线和连字符，最长 64 位');
  invite.linkId ??= `f-${[...globalThis.crypto.getRandomValues(new Uint8Array(4))].map(n => n.toString(16).padStart(2, '0')).join('')}`;
  return invite;
}

// ---- 头像指针 ----

const MAX_BLOB = 5 * 1024 * 1024, MAX_MIME = 128, MAX_FILE_NAME = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CONTENT_PATH = /^content\/([0-9a-f]{64})$/;
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;
const POINTER_KEYS = new Set(['owner', 'path', 'sha256', 'mime', 'size', 'name']);

/**
 * 内容寻址的图片指针（BlobPointer，`path` 只收 `content/<sha256>`）的校验：`{ owner, path, sha256, mime?, size?, name? }`，
 * 不许别的键，`sha256` 须与 `path` 里的一致，`size` 至多 5 MiB。合法返回只含这些字段的新对象，不合法抛出中文错误。
 */
export function normalizeContentPointer(pointer) {
  if (!pointer || typeof pointer !== 'object' || Array.isArray(pointer)) fail('头像须是图片指针对象');
  for (const key of Object.keys(pointer)) if (!POINTER_KEYS.has(key)) fail(`头像指针不认识的字段：${key}`);
  const { owner, path, sha256, mime, size, name } = pointer;
  if (typeof owner !== 'string' || !UUID.test(owner)) fail('头像指针的 owner 须是小写 UUID');
  const match = typeof path === 'string' ? CONTENT_PATH.exec(path) : null;
  if (!match) fail('头像指针的 path 须是 content/<64 位小写十六进制 SHA-256>');
  if (sha256 !== match[1]) fail('头像指针的 sha256 须与 path 里的一致');
  const out = { owner, path, sha256 };
  if (mime !== undefined) {
    if (typeof mime !== 'string' || !mime || mime.length > MAX_MIME || !MIME.test(mime)) fail(`头像指针的 mime 须是合法的 MIME 类型（最多 ${MAX_MIME} 字）`);
    out.mime = mime;
  }
  if (size !== undefined) {
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_BLOB) fail('头像指针的 size 须是 0 到 5 MiB 之间的整数');
    out.size = size;
  }
  if (name !== undefined) {
    const text = clean(name);
    if (!text || length(text) > MAX_FILE_NAME) fail(`头像指针的 name 须是非空文本（最多 ${MAX_FILE_NAME} 字）`);
    out.name = text;
  }
  return out;
}

/** 读外来记录里的图片指针：合法给规范化的指针，不合法给 null，从不抛错。 */
export function readContentPointer(pointer) {
  try { return normalizeContentPointer(pointer); } catch { return null; }
}

// ---- 名片 ----

/**
 * 名片输入的清洗（profile 与 friends/card 同形）：昵称 1–40 字，emoji 最多 8 字，颜色须在白名单里；
 * avatar 省略不写，null 表示清除，否则须是合法的 content 指针。不合法的昵称、emoji、头像抛错；不认识的颜色丢掉。
 */
export function normalizeCardInput({ name, emoji, color, avatar } = {}) {
  const body = { name: clean(name) };
  if (!body.name) fail('昵称不能为空');
  if (length(body.name) > MAX_NAME) fail(`昵称最多 ${MAX_NAME} 个字`);
  const mark = clean(emoji);
  if (mark) { if (length(mark) > MAX_EMOJI) fail(`头像最多 ${MAX_EMOJI} 个字符`); body.emoji = mark; }
  if (typeof color === 'string' && COLORS.includes(color)) body.color = color;
  if (avatar !== undefined) body.avatar = avatar === null ? null : normalizeContentPointer(avatar);
  return body;
}
export const normalizeProfileInput = normalizeCardInput;

/**
 * 读 Accord 记录里的名片，来自好友的外来数据：按同样的规则清洗，不合法的字段忽略，昵称不合法整张忽略（null）。
 * 头像分三种：没写或畸形是 `avatarPresent: false`；显式清除（`avatar: null`）与合法指针是 `avatarPresent: true`，`avatar` 为 null 或指针。
 * 结果只当文本用，不当指令或 HTML。
 */
export const readProfileRecord = record => readNameRecord(record, PROFILE_KIND);
/** 同 readProfileRecord，读 friends/card 记录。 */
export const readCardRecord = record => readNameRecord(record, CARD_KIND);

function readNameRecord(record, kind) {
  if (!record || record.kind !== kind || record.id !== PROFILE_ID) return null;
  const body = record.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const name = clean(body.name);
  if (!name || length(name) > MAX_NAME) return null;
  const profile = { author: typeof record.author === 'string' ? record.author : null, version: Number.isFinite(record.version) ? record.version : 0, name };
  const emoji = clean(body.emoji);
  if (emoji && length(emoji) <= MAX_EMOJI) profile.emoji = emoji;
  if (typeof body.color === 'string' && COLORS.includes(body.color)) profile.color = body.color;
  const avatar = body.avatar === null ? null : readContentPointer(body.avatar);
  profile.avatar = avatar;
  profile.avatarPresent = body.avatar === null || avatar !== null;
  return profile;
}

/**
 * 同一作者的 profile（根私钥签名）与 friends/card（可代签）合成一张名片：profile 写了的字段优先，免得代签的机器盖过根签的资料；
 * profile 没写的由 friends/card 补。头像看 `avatarPresent`：profile 写了（含显式清除的 null）就用 profile 的。两张都没有给 null。
 */
export function mergeProfileAndCard(profile, card) {
  if (!profile && !card) return null;
  const pick = key => profile?.[key] ?? card?.[key];
  const from = profile?.avatarPresent ? profile : card?.avatarPresent ? card : null;
  return { name: pick('name'), emoji: pick('emoji'), color: pick('color'), avatar: from ? from.avatar : null, avatarPresent: Boolean(from) };
}

/**
 * 代签回退发布了 friends/card 之后的提示：`true` 已确认有根签的 profile，如实说明好友看到的仍以它为准；`false` 已确认没有；
 * `null` / `undefined` 没读出来，不承诺好友看到的是哪张。
 */
export const cardFallbackNotice = hasRootProfile => hasRootProfile === true
  ? '社交名片已保存，但你已有根私钥签名的名片，昵称等已有项仍以根签名为准（未设项由社交名片补充）'
  : hasRootProfile === false ? '本机用的是代签证书，名片已改作社交名片（friends/card）发布，好友会看到它'
  : '社交名片已保存；若你曾用根私钥发布过名片，昵称等已有项仍以根签名为准';

/** 密钥的短码：`ed25519:` 之后的前 8 位（没有就空串）。 */
export function shortAuthor(author) {
  const match = /^ed25519:([0-9a-f]{64})$/.exec(author ?? '');
  return match ? match[1].slice(0, 8) : '';
}

/**
 * 本机 Accord 记录（`coda/accord@1` 的 local）的证书状态：状态里写了 `certificate` 的按它判：null 没有身份，
 * `active` 为 true 才是可发布，其余要换证书；旧宿主不写这个键，有作者就当可发布（发布遇 invalid_state 再落到需要证书）。
 */
export function certStateOf(accord) {
  const status = accord?.status;
  if (status && typeof status === 'object' && Object.hasOwn(status, 'certificate')) {
    if (status.certificate === null) return 'no_identity';
    return status.certificate?.active === true ? 'active' : 'needs_cert';
  }
  return accord?.spec?.author ? 'active' : 'no_identity';
}

// ---- 好友列表 ----

const RANK = { conflict: 0, pending: 1, bound: 2 };
export const statusOf = friend => friend.conflict ? 'conflict' : friend.bound ? 'bound' : 'pending';

/**
 * 好友表（`status.friends`）、好友的名片记录（profile 与 friends/card 各取每把钥匙 version 最大的，按 mergeProfileAndCard
 * 合成）和本地备注（按 node，没有再按 author）合成的行，按状态（冲突、待互认、已互认）再按更新时间新的在前排序，
 * 同样的输入排出同样的顺序。
 */
export function mergeFriendRows({ friends = [], profiles = [], cards = [], notes = {} } = {}) {
  const latestOf = (records, read) => {
    const latest = new Map();
    for (const record of records) {
      const one = read(record);
      if (one?.author && (!latest.has(one.author) || one.version > latest.get(one.author).version)) latest.set(one.author, one);
    }
    return latest;
  };
  const byProfile = latestOf(profiles, readProfileRecord), byCard = latestOf(cards, readCardRecord);
  const note = friend => (Object.hasOwn(notes, friend.node) ? notes[friend.node] : friend.author && Object.hasOwn(notes, friend.author) ? notes[friend.author] : '');
  const rows = friends.map(friend => {
    const card = friend.author ? mergeProfileAndCard(byProfile.get(friend.author), byCard.get(friend.author)) : null;
    const status = statusOf(friend), remark = clean(note(friend)), short = shortAuthor(friend.author), name = card?.name;
    return { node: friend.node, author: friend.author ?? null, short, status, peerNode: friend.peerNode ?? null, scope: friend.scope, updatedAt: friend.updatedAt ?? 0,
      note: remark, profileName: name ?? '', emoji: card?.emoji ?? '', color: card?.color ?? 'gray', avatar: card?.avatar ?? null,
      title: remark || name || (short ? `好友 ${short}` : friend.node) };
  });
  return rows.sort((a, b) => RANK[a.status] - RANK[b.status] || b.updatedAt - a.updatedAt || (a.node < b.node ? -1 : a.node > b.node ? 1 : 0));
}
