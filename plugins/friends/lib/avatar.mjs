// 好友页头像与 Accord 状态的纯逻辑：头像地址、回退链、确定性几何纹、身份与好友统计。
// 页面（WKWebView）与 Node 单测都直接加载它，所以只用标准 JS 和 ./friends.mjs，不拼 HTML。

import { certStateOf, readContentPointer, shortAuthor } from './friends.mjs';

/** 头像图片的大小上限，与客户端和后端的 5 MiB 一致。 */
export const BLOB_MAX_BYTES = 5 * 1024 * 1024;

const CONTROL_CHARS = /[\p{Cc}\u2028\u2029]/gu;
const AUTHOR = /^ed25519:([0-9a-f]{64})$/;
const MAX_EMOJI = 8;

const clean = text => typeof text === 'string' ? text.replace(CONTROL_CHARS, '').trim() : '';
const machineQuery = machine => typeof machine === 'string' && machine.trim() ? `?coda-machine=${encodeURIComponent(machine.trim())}` : '';

/** 头像指针的读取地址：指针不合法（或为空）给 null；多机空间里带上 machine。 */
export function blobReadUrl(pointer, machine) {
  const p = readContentPointer(pointer);
  return p ? `coda-view://blob/${p.owner}/content/${p.sha256}${machineQuery(machine)}` : null;
}

/** 上传头像的地址；多机空间里带上 machine。 */
export const blobUploadUrl = machine => `coda-view://blob/content${machineQuery(machine)}`;

/** 一串字节的确定性混合（FNV-1a 作种，mulberry32 取数），给几何纹用。 */
function* stream(bytes) {
  let seed = 0x811c9dc5;
  for (const byte of bytes) seed = Math.imul(seed ^ byte, 0x01000193) >>> 0;
  for (;;) {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    yield (t ^ (t >>> 14)) >>> 0;
  }
}

/**
 * 5×5 水平轴对称的几何纹（`grid[r][c] === grid[r][4 - c]`）：同一个 author 永远同一张，
 * 不会全空也不会全满。合法的 `ed25519:<64 位十六进制>` 取公钥字节推导，其余非空串取其字符码兜底。
 */
export function identiconPattern(author) {
  const text = String(author ?? '');
  const hex = AUTHOR.exec(text)?.[1];
  const bytes = hex ? Array.from({ length: 32 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16)) : [...text].map(ch => ch.codePointAt(0));
  for (const draw of stream(bytes)) {
    const grid = Array.from({ length: 5 }, (_, r) => {
      const half = [0, 1, 2].map(c => ((draw >>> (r * 3 + c)) & 1) === 1);
      return [half[0], half[1], half[2], half[1], half[0]];
    });
    const active = grid.flat().filter(Boolean).length;
    if (active >= 8 && active <= 18) return grid;
  }
}

/** 昵称等文本的首字：清掉控制字符与首尾空白后取第一个 Unicode 字符，ASCII 字母转大写，空则给 fallback。 */
export function initialChar(text, fallback = '友') {
  const first = [...clean(text)][0];
  return first ? (/^[a-z]$/.test(first) ? first.toUpperCase() : first) : fallback;
}

/**
 * 决定头像怎么展示，只返回纯数据：
 * 有可读的图片指针且没失败 → photo；否则有 emoji（1–8 字）→ emoji；否则有合法 author（且 prefer 不是 monogram）→ identicon；否则 monogram。
 * photo 带 `fallback`：图片加载失败时直接换用的描述。
 */
export function resolveAvatar({ avatar, emoji, author, name, fallback = '友', machine, photoFailed = false, prefer = 'auto' } = {}) {
  const url = photoFailed ? null : blobReadUrl(avatar, machine);
  if (url) return { kind: 'photo', url, fallback: resolveAvatar({ avatar, emoji, author, name, fallback, machine, photoFailed: true, prefer }) };
  const mark = clean(emoji);
  if (mark && [...mark].length <= MAX_EMOJI) return { kind: 'emoji', emoji: mark };
  if (prefer !== 'monogram' && AUTHOR.test(author ?? '')) return { kind: 'identicon', grid: identiconPattern(author), author };
  return { kind: 'monogram', text: initialChar(name, fallback) };
}

/**
 * 本机 Accord 身份与证书状态（判定见 friends.mjs 的 certStateOf），加上好友统计。
 */
export function accordStatusSummary(entry, rows = []) {
  const certificate = entry?.status?.certificate;
  const author = entry?.spec?.author ?? null;
  const until = [certificate?.until, certificate?.expiresAt].find(value => Number.isFinite(value) && value > 0);
  const count = status => rows.filter(row => row.status === status).length;
  return { cert: certStateOf(entry), author, short: shortAuthor(author), certUntil: until ?? null,
    friends: { total: rows.length, bound: count('bound'), pending: count('pending'), conflict: count('conflict') } };
}
