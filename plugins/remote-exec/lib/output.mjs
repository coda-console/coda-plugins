// 输出截短：输出边收边写进目标机的临时目录（每路至多 `DISK_CAP` 字节），内存里只留头和尾。结束时总量没超就删掉临时文件、原样给出；
// 超了就保留头尾，中间插一行注明省略了多少字节和完整输出的路径（落盘也截断了的，注明只存了前多少字节），临时文件留着（用拉取取回）。
// 输出都在这个插件实例私有的根目录下（插件状态目录里的 `outputs/`，见 `outputRoot`），创建与回收只在这个根下做。
// 留下的输出目录由 `sweepOutputs` 回收：超过 `KEEP_MS` 的删掉，总量超过 `KEEP_TOTAL` 时从最旧的删起。
import { chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';

// stdout 与 stderr 在结果里合计约 48 KiB：各留头 12 KiB、尾 12 KiB。
export const HEAD = 12 * 1024;
export const TAIL = 12 * 1024;
// 每路输出落盘的上限：超过后不再写，只继续数字节、留尾。
export const DISK_CAP = 16 * 1024 * 1024;
// 留下的输出目录：保留 24 小时；所有留下的合计超过 256 MiB 时，从最旧的删起。
export const KEEP_MS = 24 * 60 * 60 * 1000;
export const KEEP_TOTAL = 256 * 1024 * 1024;
export const PREFIX = 'coda-remote-exec-';
export const OUTPUTS = 'outputs';

// 这个插件实例放输出的根目录：`<状态目录的真实路径>/outputs`，建成 0700；它必须是真的目录（是符号链接或别的东西就抛），不跟着链接走。
// 状态目录按后端实例分开、只有本人可进，所以两个后端实例各回收各的。回根的真实路径。
export async function outputRoot(state) {
  if (!state) throw new Error('没有插件状态目录，执行的输出无处可放');
  await mkdir(state, { recursive: true });   // 同操作记录：状态目录不在就建
  const root = join(await realpath(state), OUTPUTS);
  try { await mkdir(root, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const info = await lstat(root);
  if (!info.isDirectory()) throw new Error(`${root} 不是目录（可能是符号链接），不放输出`);
  if ((info.mode & 0o777) !== 0o700) await chmod(root, 0o700);
  return root;
}

// 不把一个 UTF-8 字符切成两半：头去掉末尾不完整的字符，尾去掉开头残缺的字符（输出本身不合 UTF-8 时只退让至多三个字节）。
function completeHead(bytes) {
  for (let back = 1; back <= Math.min(3, bytes.length); back++) {
    const byte = bytes[bytes.length - back];
    if ((byte & 0xc0) === 0x80) continue;
    const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return need > back ? bytes.subarray(0, bytes.length - back) : bytes;
  }
  return bytes;
}
function completeTail(bytes) {
  let start = 0;
  while (start < 3 && start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return bytes.subarray(start);
}

// 把 `chunk` 写满：一次只写进一部分就接着写，写不进去（0 字节）就抛，不把缺字节的文件当完整输出。
export async function writeAll(handle, chunk) {
  for (let at = 0; at < chunk.length;) {
    const { bytesWritten } = await handle.write(chunk, at, chunk.length - at);
    if (bytesWritten === 0) throw new Error('输出文件写不进去');
    at += bytesWritten;
  }
}

// 一路输出的收集器，完整内容写进 `file`（独占创建，已有同名的就失败）。`write(chunk)` 回的 promise 在这块写进文件后 resolve，调用方 await 它就有回压；
// `finish()` 回 { text, truncated, bytes }。
async function collector(file, cap = DISK_CAP) {
  const handle = await open(file, 'wx', 0o600);
  let head = Buffer.alloc(0), tail = Buffer.alloc(0), total = 0, stored = 0, queue = Promise.resolve();
  return {
    write(chunk) {
      total += chunk.length;
      const toDisk = chunk.subarray(0, Math.max(0, Math.min(chunk.length, cap - stored)));
      stored += toDisk.length;
      const toHead = Math.min(chunk.length, HEAD - head.length);
      if (toHead > 0) head = Buffer.concat([head, chunk.subarray(0, toHead)]);
      if (chunk.length > toHead) {
        tail = Buffer.concat([tail, chunk.subarray(toHead)]);
        if (tail.length > TAIL) tail = tail.subarray(tail.length - TAIL);
      }
      if (toDisk.length) queue = queue.then(() => writeAll(handle, toDisk));
      queue.catch(() => {});
      return queue;
    },
    async finish() {
      try { await queue; } finally { await handle.close(); }
      if (total === head.length + tail.length) {
        return { text: Buffer.concat([head, tail]).toString(), truncated: false, bytes: total };
      }
      const start = completeHead(head), end = completeTail(tail);
      const omitted = total - start.length - end.length;
      const where = stored < total ? `落盘也截断了：${file} 只存了前 ${stored} 字节（共 ${total} 字节）` : `完整输出在 ${file}`;
      return { text: `${start.toString()}\n[… 省略了 ${omitted} 字节，${where}，至多保留 24 小时 …]\n${end.toString()}`, truncated: true, bytes: total };
    },
  };
}

// 一次执行的两路输出，临时文件（stdout、stderr）在 `root`（`outputRoot` 给的根）下这次新建的私有目录里：
// 目录名带调用编号再加随机串，原子创建、权限 0700，所以不会碰到别人预先放好的路径；清理只删这个目录。
// `finish()` 回 { stdout, stderr, truncated, outputDir }：两路都没截短时整个目录删掉，`outputDir` 是 null；
// 有一路截短，目录与里面两个文件都留着。`discard()` 不要这份输出了，整个目录删掉。
export async function openOutputs(id, root, { cap = DISK_CAP } = {}) {
  const dir = await mkdtemp(join(root, `${PREFIX}${String(id).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40)}-`));
  let stdout, stderr;
  try {
    stdout = await collector(join(dir, 'stdout'), cap); stderr = await collector(join(dir, 'stderr'), cap);
  } catch (error) {
    await stdout?.finish().catch(() => {});
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  return {
    dir, stdout, stderr,
    async finish() {
      const [out, err] = await Promise.all([stdout.finish(), stderr.finish()]);
      const truncated = out.truncated || err.truncated;
      if (!truncated) await rm(dir, { recursive: true, force: true });
      return { stdout: out.text, stderr: err.text, truncated, outputDir: truncated ? dir : null };
    },
    // 输出没人要了（执行失败或被取消）：关掉文件，整个目录删掉，不论有没有截短。
    async discard() {
      await Promise.allSettled([stdout.finish(), stderr.finish()]);
      await rm(dir, { recursive: true, force: true });
    },
  };
}

// 回收留下的输出目录：只看 `root`（`outputRoot` 给的根）下本插件建的（名字以 `PREFIX` 开头、是目录不是链接、属于后端所在用户）、不在 `active` 里的（正在用的）。
// 修改时间早于 `now - keepMs` 的删掉；剩下的合计超过 `keepTotal` 字节时，从最旧的删起。删不掉的跳过，写一行标准错误。
// 回删掉的目录。
export async function sweepOutputs(root, { now = Date.now(), keepMs = KEEP_MS, keepTotal = KEEP_TOTAL, active = new Set(), warn = console.error } = {}) {
  let names;
  try { names = await readdir(root); } catch (error) { warn(`远程执行：读不了输出目录 ${root}：${error.message}`); return []; }
  const uid = process.getuid?.();
  const kept = [];
  for (const name of names) {
    if (!name.startsWith(PREFIX)) continue;
    const dir = join(root, name);
    if (active.has(dir)) continue;
    let info;
    try { info = await lstat(dir); } catch { continue; }
    if (!info.isDirectory() || (uid !== undefined && info.uid !== uid)) continue;
    let size = 0;
    for (const file of ['stdout', 'stderr']) {
      try { const one = await lstat(join(dir, file)); if (one.isFile()) size += one.size; } catch { /* 没有就是 0 */ }
    }
    kept.push({ dir, mtime: info.mtimeMs, size });
  }
  kept.sort((a, b) => a.mtime - b.mtime);
  let total = kept.reduce((sum, one) => sum + one.size, 0);
  const removed = [];
  for (const one of kept) {
    if (now - one.mtime <= keepMs && total <= keepTotal) continue;
    try { await rm(one.dir, { recursive: true, force: true }); removed.push(one.dir); total -= one.size; } catch (error) {
      warn(`远程执行：删不掉留下的输出目录 ${one.dir}：${error.message}`);
    }
  }
  return removed;
}
