// 好友页头像与 Accord 状态的纯逻辑：确定性几何纹、无公钥时的首字兜底、身份与好友统计。
// 页面（WKWebView）直接加载它，Node 单测经测试加载钩子把 coda-view:// 映射到协议包，所以只用标准 JS 和 ./friends.mjs，不拼 HTML。

import { identiconPattern, isAuthor, shortAuthor } from 'coda-view://lib/v1/accord.js';
import { certStateOf } from './friends.mjs';

const CONTROL_CHARS = /[\p{Cc}\u2028\u2029]/gu;

const clean = text => typeof text === 'string' ? text.replace(CONTROL_CHARS, '').trim() : '';

/** 昵称等文本的首字：清掉控制字符与首尾空白后取第一个 Unicode 字符，ASCII 字母转大写，空则给 fallback。 */
export function initialChar(text, fallback = '友') {
  const first = [...clean(text)][0];
  return first ? (/^[a-z]$/.test(first) ? first.toUpperCase() : first) : fallback;
}

/** 决定头像怎么展示，只返回纯数据：合法的 author 画它的几何纹（identicon），否则取 name 的首字（monogram）。 */
export function resolveAvatar({ author, name, fallback = '友' } = {}) {
  if (isAuthor(author)) return { kind: 'identicon', grid: identiconPattern(author), author };
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
