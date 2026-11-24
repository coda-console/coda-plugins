// 操作记录：每次操作两行 JSON（JSONL），追加在插件状态目录的 audit.jsonl：动手之前一行「开始」，结束之后一行结果，用同一个 `op` 关联。
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';

export const AUDIT_FILE = 'audit.jsonl';
export const newOp = () => randomUUID();

// 同一个文件的追加一个接一个做：长命令的一行会被拆成几次写，并发的两行不能穿插；做完（不论成败）再轮到下一个，一次失败不卡住后面的。
const tails = new Map();
function enqueue(file, task) {
  const run = (tails.get(file) ?? Promise.resolve()).then(task);
  const settled = run.catch(() => {});
  tails.set(file, settled);
  settled.then(() => { if (tails.get(file) === settled) tails.delete(file); });
  return run;
}

// 「开始」：动手之前写。
//   op：这次操作的编号（两行共用）；id：`ctx.id`，流没有就不写；caller：`ctx.caller` 原样整个存，不挑字段（`machine` 是接收方核验的，
//   `plugin`、`parent` 是来源后端转述的，以后可能还有别的）；operation：exec | pull | push；params：命令全文、目录与时限，或路径与范围。
export function startLine({ time = new Date(), op, id, caller, operation, params }) {
  return JSON.stringify({ time: time.toISOString(), op, phase: 'start', ...(id === undefined ? {} : { id }), caller: caller ?? null, operation, params });
}
// 结果：结束之后写。result：退出码/信号/是否超时，或字节数；error：错误码（被拒绝或失败）；ms：耗时。
export function endLine({ time = new Date(), op, operation, result, error, ms }) {
  return JSON.stringify({ time: time.toISOString(), op, phase: 'end', operation, ...(error === undefined ? { result } : { error }), ms });
}

// 打开记录文件追加，前置探测与实际追加都经它：非阻塞打开（命名管道没有读端也不会挂住）、不跟随符号链接、新建为 0600，
// 打开之后对句柄判类型，只认普通文件；权限显式收成 0600。回打开的句柄，调用方写完关掉。
export async function openLog(file) {
  const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NONBLOCK | constants.O_NOFOLLOW;
  let handle;
  try { handle = await open(file, flags, 0o600); } catch (error) {
    if (error.code === 'ELOOP' || error.code === 'EMLINK') throw new Error(`${file} 是符号链接，不写`);
    if (error.code === 'ENXIO') throw new Error(`${file} 是命名管道，不写`);
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`${file} 不是普通文件，不写`);
    if ((info.mode & 0o777) !== 0o600) await handle.chmod(0o600);
    return handle;
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function append(state, line) {
  if (!state) throw new Error('没有插件状态目录，操作记录无处可写');
  const file = join(state, AUDIT_FILE);
  await enqueue(file, async () => {
    try {
      await mkdir(state, { recursive: true });
      const handle = await openLog(file);
      try { await handle.appendFile(`${line}\n`); } finally { await handle.close(); }
    } catch (error) { throw new Error(`操作记录写不进 ${file}：${error.message}`); }
  });
}

// 追加到 `state`（插件状态目录）里的记录文件。
//   `start(line)`：动手之前写「开始」；写不进去就抛，调用方据此拒绝这次操作（什么都没做）。
//   `end(line, what)`：结束之后补结果。写不进去不抛（操作已经做完，结局不能变），在标准错误写明哪次调用（`what`）的结果丢了。
export function createAuditLog(state, { warn = console.error } = {}) {
  return {
    start: line => append(state, line),
    async end(line, what = '一次调用') {
      try { await append(state, line); } catch (error) { warn(`远程执行：${error.message}（${what}的结果丢了）`); }
    },
  };
}
