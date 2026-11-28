// 测试共用：一个会转调假 mnemon 的可执行脚本。
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FAKE = fileURLToPath(new URL('./fake-mnemon.mjs', import.meta.url));
export const fakeBin = dir => {
  const bin = join(dir, 'mnemon');
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
  chmodSync(bin, 0o755);
  return bin;
};
