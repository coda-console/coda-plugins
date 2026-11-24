// 好友页头像与 Accord 状态的纯逻辑：确定性几何纹、无公钥时的首字兜底、身份与好友统计。
// 页面（WKWebView）与 Node 单测都直接加载它，所以只用标准 JS 和 ./friends.mjs，不拼 HTML。

import { certStateOf, shortAuthor } from './friends.mjs';

const CONTROL_CHARS = /[\p{Cc}\u2028\u2029]/gu;
const AUTHOR = /^ed25519:([0-9a-f]{64})$/;

const clean = text => typeof text === 'string' ? text.replace(CONTROL_CHARS, '').trim() : '';

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

/** 决定头像怎么展示，只返回纯数据：合法的 author 画它的几何纹（identicon），否则取 name 的首字（monogram）。 */
export function resolveAvatar({ author, name, fallback = '友' } = {}) {
  if (AUTHOR.test(author ?? '')) return { kind: 'identicon', grid: identiconPattern(author), author };
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
