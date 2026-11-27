// 好友对话的身份纯逻辑：个人身份准入、单聊会话 ID、确定性几何纹 PNG；公钥的昵称、尾号、展示名与几何纹格子都来自 @coda-console/protocol/accord。
import { createHash } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { identiconPattern, identityTitles, isAuthor, parseAuthor } from '@coda-console/protocol/accord';

const DM_CONVERSATION = /^dm:[0-9a-f]{32}$/;
const GROUP_CONVERSATION = /^grp:[a-z0-9][a-z0-9_-]{0,63}$/;

export const isConversationId = value => typeof value === 'string' && (DM_CONVERSATION.test(value) || GROUP_CONVERSATION.test(value));

function hslToRgb(h, s, l) {
  const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  return [0, 8, 4].map(n => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)))));
}

function chunk(type, data) {
  const head = Buffer.alloc(8), tail = Buffer.alloc(4), body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  tail.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, data, tail]);
}

/** 公钥确定性的几何纹头像：size×size 的 8 位 RGB PNG 字节（外圈留一格底色）。 */
export function renderIdenticonPng(author, { size = 96 } = {}) {
  if (!isAuthor(author)) throw new TypeError('author 不是合法的 Accord 公钥');
  if (!Number.isInteger(size) || size < 7 || size > 1024) throw new RangeError('size 须为 7 到 1024 的整数');
  const key = parseAuthor(author), grid = identiconPattern(key);
  const hue = ((key[0] << 8) | key[1]) % 360;
  const fg = hslToRgb(hue, 0.5, 0.58), bg = hslToRgb(hue, 0.35, 0.94);
  const cell = Math.floor(size / 7), origin = Math.floor((size - cell * 5) / 2);
  const cellAt = p => { const i = Math.floor((p - origin) / cell); return p >= origin && i >= 0 && i < 5 ? i : -1; };
  const raw = Buffer.alloc(size * (1 + size * 3));
  for (let y = 0; y < size; y++) {
    const row = cellAt(y), base = y * (1 + size * 3) + 1;
    for (let x = 0; x < size; x++) {
      const col = cellAt(x), color = row >= 0 && col >= 0 && grid[row][col] ? fg : bg;
      raw.set(color, base + x * 3);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const NO_IDENTITY = '请先在「设置 › 身份」绑定个人身份';
const NOT_ACTIVE = '本机签名证书已过期或未生效，打开客户端后自动续期';
const NOT_PERSONAL = '本机当前不是以个人身份签名，请先在「设置 › 身份」绑定个人身份';
const REASONS = {
  uncertified: '对方还没有绑定个人身份',
  pending: '双方还没有完成互认',
  conflict: '该好友的通道与已有记录冲突，请在「好友」页处理',
};

/**
 * 从 coda/accord@1 的记录推出本机能否以个人身份签名、哪些好友可以对话：
 * `{ selfRoot, canSign, reason?, friends: [{ author, title, eligible, unreachableReason? }] }`。
 * 同一公钥的多条通道聚合：任一条已互认、无冲突且绑了个人身份就可对话。
 * `title` 是 `identityTitles`：本机身份与当前所有好友一起比，同昵称且尾号相撞时向左加位。
 */
export function resolveAccordPeers(accord) {
  const certificate = accord?.status?.certificate;
  const personal = typeof certificate === 'object' && certificate !== null && isAuthor(certificate.root);
  const selfRoot = personal ? certificate.root : null;
  const canSign = personal && certificate.active === true && accord?.spec?.author === selfRoot;
  const reason = canSign ? undefined : !personal ? NO_IDENTITY : certificate.active !== true ? NOT_ACTIVE : NOT_PERSONAL;
  const byAuthor = new Map();
  for (const friend of Array.isArray(accord?.status?.friends) ? accord.status.friends : []) {
    if (!isAuthor(friend?.author) || friend.author === selfRoot) continue;
    const channels = byAuthor.get(friend.author) ?? [];
    channels.push(friend);
    byAuthor.set(friend.author, channels);
  }
  const titles = identityTitles([selfRoot, ...byAuthor.keys()]);
  const friends = [...byAuthor].map(([author, channels]) => {
    const eligible = channels.some(c => c.bound === true && !c.conflict && c.certified === true);
    const kind = channels.some(c => c.bound === true && !c.conflict) ? 'uncertified' : channels.some(c => !c.conflict) ? 'pending' : 'conflict';
    return { author, title: titles.get(author), eligible, ...(eligible ? {} : { unreachableReason: REASONS[kind] }) };
  });
  return { selfRoot, canSign, ...(reason ? { reason } : {}), friends };
}

/** 两个公钥之间的单聊会话 ID：对称、确定性，不含通道。 */
export function dmConversationId(authorA, authorB) {
  if (!isAuthor(authorA) || !isAuthor(authorB) || authorA === authorB) throw new TypeError('单聊需要两个不同的合法公钥');
  const [min, max] = [authorA, authorB].sort();
  return `dm:${createHash('sha256').update(`${min}\n${max}`).digest('hex').slice(0, 32)}`;
}
