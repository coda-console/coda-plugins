// 插件状态目录里的 JSON 文件：不存在或不是合法 JSON 读成 null；其他读取错误（EACCES、EISDIR、EIO……）原样抛出，
// 免得读不出来的文件被当成空表绕过策略、覆盖队列。写入原子（临时文件 + rename）。调用方自己保证同一文件的读改写不交叉。
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function readJson(dir, name) {
  let text;
  try { text = await readFile(join(dir, name), 'utf8'); } catch (e) {
    if (e?.code === 'ENOENT') return null;
    throw e;
  }
  try { return JSON.parse(text); } catch { return null; }
}

let counter = 0;
// `beforeWrite` 在动第一个字节之前调用（它抛错就不写），前面只隔着建目录这一步。
export async function writeJson(dir, name, value, beforeWrite) {
  await mkdir(dir, { recursive: true });
  beforeWrite?.();
  const target = join(dir, name), temporary = join(dir, `${name}.${process.pid}.${++counter}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, target);
  } catch (e) { await rm(temporary, { force: true }).catch(() => {}); throw e; }
}
