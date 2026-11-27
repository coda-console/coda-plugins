import { identityTitles } from '@coda-console/protocol/accord';

// 真实公钥样本（来自 @coda-console/protocol/vectors/accord.json 与好友页的同名用例）：展示名与撞号加位的回归测试共用。
export const SAKURA = 'ed25519:24005142202c7fffffffffffffffffffffffffffffffffffffffffffffff01ab'; // sakura #8283
export const ZYV = 'ed25519:66c8aec217cac5fa9829e4e314c2dfe6f3b3710cbf2c4b4df462c333565b4e27'; // zyv #4103
export const XS_A = 'ed25519:2e4b9cc2428beb7bff6a56c14d7304e472a23e890e91ef0a6b0b0380e89f9734'; // xs，十进制尾号 …2604084
export const XS_B = 'ed25519:2e4b9cc2428beb7bff6a56c14d7304e472a23e890e91ef0a6b0b0380e89fbe44'; // xs，十进制尾号 …14084：与 XS_A 末 4 位相同
export const DIGITS = 'ed25519:9d56c050a142850a142850a142850a142850a142850a142850a142850a142710'; // 昵称 07
export const NO_NAME = `ed25519:${'f'.repeat(64)}`; // 解不出昵称：短码 ffffffff

// 单个公钥的展示名（没有合法公钥时给 fallback）：只有它一个时没有撞号可加位。
export const titleOf = (author, fallback = '') => identityTitles([author]).get(author) ?? fallback;
