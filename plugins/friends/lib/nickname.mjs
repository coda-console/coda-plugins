// 由 Accord 公钥派生展示昵称（算法见 coda#3040）：浏览器与 Node 通用，只用纯 JS 与 Uint8Array，不碰 Buffer 或 node:*。

const AUTHOR = /^ed25519:([0-9a-f]{64})$/;
const GROUPS = 36;

/** 密钥的短码：`ed25519:` 之后的前 8 位（没有就空串）。 */
export function shortAuthor(author) {
  const match = AUTHOR.exec(author ?? '');
  return match ? match[1].slice(0, 8) : '';
}

/**
 * 32 字节公钥的昵称：256 位从第 0 字节最高位起每 7 位一组，至多 36 组。0–77 是字母（v % 26），78–87 是数字，
 * 88–127 是结束符：已有不足 2 位时跳过，够 2 位就结束。读完仍不足 2 位给空串。
 */
export function nicknameOf(key) {
  let name = '';
  for (let group = 0; group < GROUPS; group++) {
    let v = 0;
    for (let bit = group * 7; bit < group * 7 + 7; bit++) v = (v << 1) | ((key[bit >> 3] >> (7 - (bit & 7))) & 1);
    if (v < 78) name += String.fromCharCode(97 + (v % 26));
    else if (v < 88) name += String(v - 78);
    else if (name.length >= 2) return name;
  }
  return name.length >= 2 ? name : '';
}

/** 32 字节公钥按大端无符号整数转成十进制，左侧补零到 78 位。 */
export const tailOf = key => BigInt(`0x${[...key].map(byte => byte.toString(16).padStart(2, '0')).join('')}`).toString().padStart(78, '0');

/**
 * 好友与本机身份的展示名：合法公钥且解得出昵称给 `昵称 #尾号`（尾号是 tail 的末 4 位）；合法公钥解不出昵称给公钥短码；
 * 没有合法公钥（如待互认的好友）给 fallbackNode。
 */
export function identityTitle(author, fallbackNode = '') {
  const hex = AUTHOR.exec(author ?? '')?.[1];
  if (hex) {
    const key = Uint8Array.from({ length: 32 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16));
    const name = nicknameOf(key);
    return name ? `${name} #${tailOf(key).slice(-4)}` : shortAuthor(author);
  }
  return fallbackNode;
}
