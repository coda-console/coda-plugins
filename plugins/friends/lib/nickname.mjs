// 公钥昵称与尾号（coda#3040），与基座的 AccordNickname 同一套。都收 32 字节的公钥。

/**
 * 昵称：256 位从第一个字节的最高位起每 7 位一组，至多 36 组；0–77 是字母（对 26 取余，`a` 起），78–87 是数字（减 78），
 * 88–127 是结束，名字还不足 2 位时跳过结束继续读。读完仍不足 2 位给空串（没有昵称）。
 */
export function nicknameOf(key) {
  let name = '';
  for (let group = 0; group < 36; group++) {
    let value = 0;
    for (let bit = group * 7; bit < group * 7 + 7; bit++) value = (value << 1) | ((key[bit >> 3] >> (7 - (bit & 7))) & 1);
    if (value < 78) name += String.fromCharCode(97 + (value % 26));
    else if (value < 88) name += String(value - 78);
    else if (name.length >= 2) return name;
  }
  return name.length >= 2 ? name : '';
}

/** 完整尾号：公钥按大端无符号整数写成十进制，补零到 78 位。 */
export const tailOf = key => BigInt(`0x${Buffer.from(key).toString('hex')}`).toString().padStart(78, '0');
