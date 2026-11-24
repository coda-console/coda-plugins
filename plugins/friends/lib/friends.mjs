// 好友页的纯逻辑：解析邀请、证书状态、把好友表合成列表行。不碰 Coda，也不碰磁盘。
// 页面也加载它，所以只用浏览器和 Node 都有的 API。
import { identityTitle, shortAuthor } from './nickname.mjs';

export { shortAuthor };

// 邀请各字段的上限，与 coda/accord@1 的 accept 输入一致。
const LIMITS = { control: 500, authKey: 500, linkId: 64, scope: 520, hostname: 100, peerNode: 100 };
const LABELS = { control: '入网地址 control', authKey: '入网码 authKey', linkId: 'linkId', scope: 'scope', hostname: 'hostname', peerNode: 'peerNode', peerPort: 'peerPort' };
const LINK_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ALIASES = { controlurl: 'control', control_url: 'control', authkey: 'authKey', auth_key: 'authKey', linkid: 'linkId', link_id: 'linkId',
  link: 'linkId', peernode: 'peerNode', peer_node: 'peerNode', peerport: 'peerPort', peer_port: 'peerPort' };
const length = text => [...text].length;

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
 * 好友表（`status.friends`）合成的行：标题是公钥派生的昵称（见 nickname.mjs），没有公钥的待互认项用节点名；
 * 按状态（冲突、待互认、已互认）再按更新时间新的在前排序，同样的输入排出同样的顺序。
 */
export function mergeFriendRows(friends = []) {
  const rows = friends.map(friend => ({ node: friend.node, author: friend.author ?? null, short: shortAuthor(friend.author), status: statusOf(friend),
    peerNode: friend.peerNode ?? null, scope: friend.scope, updatedAt: friend.updatedAt ?? 0, title: identityTitle(friend.author, friend.node) }));
  return rows.sort((a, b) => RANK[a.status] - RANK[b.status] || b.updatedAt - a.updatedAt || (a.node < b.node ? -1 : a.node > b.node ? 1 : 0));
}
