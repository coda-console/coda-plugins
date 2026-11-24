// 拉取（读的流）与推送（写的流）。错误都在第一个字节之前以带码的错误抛，读的 effects 一律 none。
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readlink, realpath, rename, rm, rmdir, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { writeAll } from './output.mjs';
import { absolute, begin, errorCode, fsError } from './operation.mjs';

// `length` 不给就不声明长度。
const octet = length => ({ status: 200, headers: { 'content-type': 'application/octet-stream', ...(length === undefined ? {} : { 'content-length': String(length) }) } });

// 推送的大小上限：请求体超过它就拒绝（`too_large`），临时文件删掉，原文件不动。
export const MAX_PUSH = 1024 * 1024 * 1024;

// 打开普通文件，目录与特殊节点（FIFO、设备、套接字）不行；回 `{ handle, size }`。
// 非阻塞打开（没有写端的 FIFO 也不会挂住），打开之后对句柄判类型；对普通文件的读不受非阻塞影响。
async function openFile(coda, path) {
  const check = info => {
    if (info.isDirectory()) throw coda.error('is_a_directory', `${path}：是目录，不能当文件读`, { effects: 'none' });
    if (!info.isFile()) throw coda.error('not_a_regular_file', `${path}：不是普通文件（FIFO、设备或套接字），不能读`, { effects: 'none' });
  };
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK); } catch (error) { throw fsError(coda, error, path); }
  try {
    const info = await handle.stat();
    check(info);
    return { handle, size: info.size };
  } catch (error) {
    await handle.close();
    throw fsError(coda, error, path);
  }
}

// `ctx.input`：{ path, offset?, length? }（字符串）。
export async function pull(env, request, ctx) {
  const { coda } = env, { path, offset, length } = ctx.input;
  const op = begin(env, 'pull', ctx, { path, offset, length });
  return op.guard({ path, offset, length }, async () => {
    absolute(coda, path);
    ctx.signal.throwIfAborted();
    const { handle, size } = await openFile(coda, path);
    // 打开之后到读第一块之间没有别的等待：这一次检查也管空范围与首块预读。
    if (ctx.signal.aborted) { await handle.close(); throw ctx.signal.reason; }
    // `stat` 的大小为 0 的普通文件不一定是空的（如 /proc/cpuinfo）：读到 EOF 为准，一律不声明长度。
    // 超出安全整数的 offset、length 在建读流之前收口：offset 超过末尾就是空体，length 超大就是读到末尾。
    const unsized = size === 0, limit = unsized ? Infinity : size, declared = length => unsized ? undefined : length;
    const start = Math.min(Number(offset ?? 0), unsized ? Number.MAX_SAFE_INTEGER : size), end = length === undefined ? limit : Math.min(limit, start + Number(length));
    if (end <= start) {
      await handle.close();
      ctx.signal.throwIfAborted();
      await op.record({ result: { bytes: 0 } });
      return new Response(null, octet(declared(0)));
    }
    const expected = unsized ? 0 : end - start, file = handle.createReadStream({ start, end: Number.isSafeInteger(end) ? end - 1 : Infinity }), chunks = file[Symbol.asyncIterator]();
    let sent = 0, recorded = false, controller;
    const record = fields => { if (!recorded) { recorded = true; return op.record(fields); } };
    // 调用被中止：文件关掉，响应体当场以取消的原因出错（预读的块随之丢掉），并记一行，不等调用方再读。
    // 响应体建立之前（还在读第一块）只关文件：随后 next 抛出取消的原因，由 guard 记那一行。
    // 先记再让响应体出错：调用方看到结束时，记录已经写完。
    const onAbort = () => {
      file.destroy();
      if (!controller) return;
      const reason = ctx.signal.reason;
      Promise.resolve(record({ error: errorCode(reason) })).finally(() => { try { controller.error(reason); } catch { /* 已经结束 */ } });
    };
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    // 下一块；读完回 null。读失败、读到的比声明的短（文件在读的过程中被截短）都是错误，不当成功。
    const next = async () => {
      try {
        const { value, done } = await chunks.next();
        if (!done) { sent += value.length; return value; }
      } catch (error) {
        throw ctx.signal.aborted ? ctx.signal.reason : fsError(coda, error, path);
      }
      if (ctx.signal.aborted) throw ctx.signal.reason;
      if (sent < expected) throw coda.error('short_read', `${path}：读到 ${sent} 字节就结束了，应有 ${expected}（文件被截短？）`, { effects: 'none' });
      return null;
    };
    // 第一块在回答之前读出来：这之前的失败还能按错误码答复。
    let pending = await next();
    if (unsized && pending === null) {   // 真的是空的
      ctx.signal.removeEventListener('abort', onAbort);
      await record({ result: { bytes: 0 } });
      return new Response(null, octet());
    }
    const body = new ReadableStream({
      start(c) { controller = c; },
      async pull(controller) {
        try {
          const chunk = pending ?? await next();
          pending = null;
          // 先记再结束响应：调用方读到结尾时，这一行已经写完（不会在它清理之后才迟到地追加）。
          if (chunk === null) { await record({ result: { bytes: sent } }); controller.close(); } else controller.enqueue(chunk);
        } catch (error) {
          await record({ error: errorCode(error) });
          controller.error(error);
        }
      },
      // 读的人走了：关掉文件。
      async cancel() {
        file.destroy();
        await record({ error: errorCode(ctx.signal.aborted ? ctx.signal.reason : { code: 'interrupted' }) });
      },
    }, { highWaterMark: 0 });
    if (ctx.signal.aborted) onAbort();
    return new Response(body, octet(declared(expected)));
  });
}

// 推送里能解析出符号链接目标的写到目标；悬空的符号链接按它指向的路径写，链接保留；路径本身不存在就是它自己。
// 悬空链接目标的目录部分必须已经存在：「链接所在目录 + '/' + 目标的目录部分」原样交给 `realpath`（`..` 与符号链接由文件系统按序处理，
// 不做词法折叠），再接上目标的文件名；解析不了就带码失败，不经符号链接新建目录。绕成圈的链接 `realpath` 报 ELOOP，照常带码失败。
async function resolveTarget(coda, path) {
  for (let current = path;;) {
    try { return await realpath(current); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    let link;
    try { link = await readlink(current); } catch (error) {
      if (error.code === 'ENOENT') return current;
      throw error;
    }
    if (link.endsWith('/')) throw coda.error('is_a_directory', `${path}：符号链接指向目录（${link}），不能当文件写`, { effects: 'none' });
    try { current = join(await realpath(isAbsolute(link) ? dirname(link) : `${dirname(current)}/${dirname(link)}`), basename(link)); } catch (error) {
      if (error.code === 'ENOENT') throw coda.error('not_found', `${path}：符号链接指向的目录不存在（${link}）`, { effects: 'none' });
      throw error;
    }
  }
}

// 从已存在的祖先起逐级建目录（非递归的 mkdir），每建成一个立即登记到 `made`（深的在前），失败时已建的也在里面。
async function makeDirectories(dir, made) {
  try { await mkdir(dir); } catch (error) {
    if (error.code === 'EEXIST') return;
    if (error.code !== 'ENOENT') throw error;
    await makeDirectories(dirname(dir), made);
    try { await mkdir(dir); } catch (again) { if (again.code === 'EEXIST') return; throw again; }
  }
  made.unshift(dir);
}

// `ctx.input`：{ path }；请求体是文件的全部字节。
export async function push(env, request, ctx) {
  const { coda } = env, { path } = ctx.input;
  const op = begin(env, 'push', ctx, { path });
  const size = await op.guard({ path }, async () => {
    absolute(coda, path);
    if (path.endsWith('/')) throw coda.error('is_a_directory', `${path}：以 / 结尾是目录，不能当文件写`, { effects: 'none' });
    let temp = null, handle = null, reader, written = 0;
    const made = [];
    // 等请求体的时候也要响应取消：一个监听去取消 reader，等着的那次读随即结束，之后照常走收尾。
    const onAbort = () => reader?.cancel(ctx.signal.reason).catch(() => {});
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    try {
      ctx.signal.throwIfAborted();
      // 先把路径上的父目录建好，再解析最终目标：`missing/../x` 建出 `missing` 之后指向的可能是已有的文件。
      await makeDirectories(dirname(path), made);
      const target = await resolveTarget(coda, path);
      const existing = await stat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (existing?.isDirectory()) throw coda.error('is_a_directory', `${path}：是目录，不能当文件写`, { effects: 'none' });
      if (existing && !existing.isFile()) throw coda.error('not_a_regular_file', `${path}：已有的不是普通文件（FIFO、设备或套接字），不替换`, { effects: 'none' });
      if (existing && existing.uid !== process.getuid()) throw coda.error('owner_mismatch', `${path}：已有的文件属于别的用户（uid ${existing.uid}），不替换`, { effects: 'none' });
      // 临时文件与目标在内核解析出的同一个父目录里；原始路径里的 `..` 与符号链接不做词法拼接。
      const parent = await realpath(dirname(target)), destination = join(parent, basename(target));
      const candidate = join(parent, `.coda-push-${randomBytes(8).toString('hex')}`);
      // 写的过程中只有自己能读写，最终权限在写满之后、改名之前才给。
      handle = await open(candidate, 'wx', 0o600);
      temp = candidate;
      if (existing && (await handle.stat()).gid !== existing.gid) {
        try { await handle.chown(-1, existing.gid); } catch (error) {
          throw coda.error('group_unavailable', `${path}：改不成原文件的属组（gid ${existing.gid}），不替换：${error.message}`, { effects: 'none' });
        }
      }
      const cap = env.maxPush ?? MAX_PUSH;   // 测试里换小
      const tooLarge = () => coda.error('too_large', `${path}：超过推送的大小上限 ${cap} 字节，没有写入`, { effects: 'none' });
      const declared = Number(request.headers?.get?.('content-length'));
      if (Number.isFinite(declared) && declared > cap) throw tooLarge();
      reader = request.body?.getReader();
      ctx.signal.throwIfAborted();   // 取消若在拿到 reader 之前到，监听没有东西可取消
      while (reader) {
        const { value, done } = await reader.read();
        if (done) break;
        if (written + value.length > cap) throw tooLarge();
        await writeAll(handle, value);
        written += value.length;
      }
      ctx.signal.throwIfAborted();
      await handle.sync();
      await handle.chmod(existing ? existing.mode & 0o777 : 0o666 & ~process.umask());
      await handle.close();
      handle = null;
      ctx.signal.throwIfAborted();
      await rename(temp, destination);
      return written;
    } catch (error) {
      reader?.cancel().catch(() => {});
      await handle?.close().catch(() => {});
      // 临时文件与本次新建的目录（深的在前）各自独立地收；有任何残留，`effects: 'none'` 就不成立，如实报 unknown。
      let leftover = false;
      if (temp) await rm(temp, { force: true }).catch(() => { leftover = true; });
      for (const dir of made) await rmdir(dir).catch(() => { leftover = true; });
      const failure = ctx.signal.aborted ? ctx.signal.reason : fsError(coda, error, path);
      if (leftover) failure.effects = 'unknown';
      throw failure;
    } finally {
      ctx.signal.removeEventListener('abort', onAbort);
    }
  });
  await op.record({ result: { bytes: size } });
  return Response.json({ path, size });
}
