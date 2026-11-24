// 三个操作共用的部分：顺序是 开关 → 判定点 → 记「开始」 → 执行 → 记结果，路径检查与文件系统错误的码。
import { isAbsolute } from 'node:path';
import { admit } from './gate.mjs';
import { endLine, newOp, startLine } from './audit.mjs';

// 记录里的错误码：带码的错误用它自己的（错误码是文本；DOMException 的 `code` 是数字，不算），取消与到期按名字，其余是 handler_error。
export function errorCode(error) {
  if (typeof error?.code === 'string') return error.code;
  return error?.name === 'AbortError' ? 'cancelled' : error?.name === 'TimeoutError' ? 'timeout' : 'handler_error';
}

// 开始一次操作。`guard(content, run)`：开关 → 判定点 → 记「开始」 → `run`；失败时补一行带错误码的结果再抛，成功的结果由调用方用 `record` 补（结果的内容它才知道）。
//   先记后做：「开始」写不进去（没有状态目录、建不出来、记录文件不是普通文件或打不开）就以 `audit_unavailable` 拒绝，什么也没做。
//   开关或判定点拒绝的也记：「开始」与结果各一行，写不进去只写标准错误，拒绝的码不变。
//   结果那一行写不进去，不改变已完成操作的结局，只在标准错误写明是哪次调用。
//   `ctx`：处理函数的 ctx；`params`：记在记录里的参数；`record({ result | error })` 补结果，只补一次。
export function begin({ coda, enabled, audit, judge }, operation, ctx, params) {
  const started = Date.now(), op = newOp();
  const what = `${operation} ${op}${ctx.id === undefined ? '' : ` ${ctx.id}`} ${params.path ?? params.cwd}`;
  const start = () => audit.start(startLine({ op, id: ctx.id, caller: ctx.caller, operation, params }));
  let ended = false;
  const record = fields => {
    if (ended) return;
    ended = true;
    return audit.end(endLine({ op, operation, ms: Date.now() - started, ...fields }), what);
  };
  async function guard(content, run) {
    try {
      admit(coda, { enabled: enabled(), operation, content, caller: ctx.caller, record: ctx.record }, judge);
    } catch (error) {
      await start().catch(() => {});
      await record({ error: errorCode(error) });
      throw error;
    }
    try { await start(); } catch (error) {
      ended = true;   // 没有「开始」就没有结果可补
      throw coda.error('audit_unavailable', `操作记录不可用，没有执行：${error.message}`, { effects: 'none' });
    }
    try {
      return await run();
    } catch (error) {
      await record({ error: errorCode(error) });
      throw error;
    }
  }
  return { op, record, guard };
}

export function absolute(coda, path, what = 'path') {
  if (!isAbsolute(path)) throw coda.error('invalid_input', `${what} 必须是绝对路径：${path}`, { effects: 'none' });
}

// 文件系统的错误变成带码的错误（已经带码的原样给回）；`effects` 一律 none：调用处只在还没改动任何东西（或改动已由自己撤销）时用它。
const CODES = {
  ENOENT: ['not_found', '不存在'], ENOTDIR: ['not_a_directory', '路径中有不是目录的部分'], EISDIR: ['is_a_directory', '是目录'],
  EACCES: ['permission_denied', '没有权限'], EPERM: ['permission_denied', '没有权限'], EROFS: ['permission_denied', '只读文件系统'],
  ELOOP: ['symlink_loop', '符号链接绕成了圈，解析不出目标'],
};
export function fsError(coda, error, path) {
  if (typeof error?.code === 'string' && /^[a-z0-9_]+$/.test(error.code)) return error;   // 已经是带码的错误（coda.error）
  const [code, text] = CODES[error?.code] ?? ['io_error', error?.message ?? String(error)];
  return coda.error(code, `${path}：${text}`, { effects: 'none' });
}
