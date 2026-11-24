// 输出截短：输出边收边完整写进目标机的临时目录，内存里只留头和尾。结束时总量没超就删掉临时文件、原样给出；
// 超了就保留头尾，中间插一行注明省略了多少字节和完整输出的路径，临时文件留着（用拉取取回）。
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// stdout 与 stderr 在结果里合计约 48 KiB：各留头 12 KiB、尾 12 KiB。
export const HEAD = 12 * 1024;
export const TAIL = 12 * 1024;

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
async function collector(file) {
  const handle = await open(file, 'wx', 0o600);
  let head = Buffer.alloc(0), tail = Buffer.alloc(0), total = 0, queue = Promise.resolve();
  return {
    write(chunk) {
      total += chunk.length;
      const toHead = Math.min(chunk.length, HEAD - head.length);
      if (toHead > 0) head = Buffer.concat([head, chunk.subarray(0, toHead)]);
      if (chunk.length > toHead) {
        tail = Buffer.concat([tail, chunk.subarray(toHead)]);
        if (tail.length > TAIL) tail = tail.subarray(tail.length - TAIL);
      }
      queue = queue.then(() => writeAll(handle, chunk));
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
      return { text: `${start.toString()}\n[… 省略了 ${omitted} 字节，完整输出在 ${file} …]\n${end.toString()}`, truncated: true, bytes: total };
    },
  };
}

// 一次执行的两路输出，临时文件（stdout、stderr）在 `root`（默认系统临时目录）下这次新建的私有目录里：
// 目录名带调用编号再加随机串，原子创建、权限 0700，所以不会碰到别人预先放好的路径；清理只删这个目录。
// `finish()` 回 { stdout, stderr, truncated, outputDir }：两路都没截短时整个目录删掉，`outputDir` 是 null；
// 有一路截短，目录与里面两个文件都留着。
export async function openOutputs(id, root = tmpdir()) {
  const dir = await mkdtemp(join(root, `coda-remote-exec-${String(id).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40)}-`));
  let stdout, stderr;
  try {
    stdout = await collector(join(dir, 'stdout')); stderr = await collector(join(dir, 'stderr'));
  } catch (error) {
    await stdout?.finish().catch(() => {});
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  return {
    stdout, stderr,
    async finish() {
      const [out, err] = await Promise.all([stdout.finish(), stderr.finish()]);
      const truncated = out.truncated || err.truncated;
      if (!truncated) await rm(dir, { recursive: true, force: true });
      return { stdout: out.text, stderr: err.text, truncated, outputDir: truncated ? dir : null };
    },
  };
}
