// 三个操作共用的部分：顺序是 开关 → 判定点 → 记录可写 → 执行 → 记录，路径检查与文件系统错误的码。
import { isAbsolute } from 'node:path';
import { admit } from './gate.mjs';
import { auditLine } from './audit.mjs';

// 记录里的错误码：带码的错误用它自己的（错误码是文本；DOMException 的 `code` 是数字，不算），取消与到期按名字，其余是 handler_error。
export function errorCode(error) {
  if (typeof error?.code === 'string') return error.code;
  return error?.name === 'AbortError' ? 'cancelled' : error?.name === 'TimeoutError' ? 'timeout' : 'handler_error';
}

// 开始一次操作。`guard(content, run)`：开关 → 判定点 → 记录可写 → `run`；失败时记一行带错误码的记录再抛，成功的记录由调用方用 `record` 记（结果的内容它才知道）。
//   每次操作都要有记录：记录写不了（没有状态目录、建不出来、文件打不开）就在执行之前以 `audit_unavailable` 拒绝；执行完之后那一行才写不进去，不改变已完成操作的结局，只在标准错误写明是哪次调用。
//   `ctx`：处理函数的 ctx；`params`：记在记录里的参数；`record({ result | error })` 追加一行。
export function begin({ coda, enabled, audit, judge }, operation, ctx, params) {
  const started = Date.now();
  const what = `${operation}${ctx.id === undefined ? '' : ` ${ctx.id}`} ${params.path ?? params.cwd}`;
  const record = fields => audit.write(auditLine({ id: ctx.id, caller: ctx.caller, operation, params, ms: Date.now() - started, ...fields }), what);
  async function guard(content, run) {
    try {
      admit(coda, { enabled: enabled(), operation, content, caller: ctx.caller, record: ctx.record }, judge);
      try { await audit.ready(); } catch (error) { throw coda.error('audit_unavailable', `操作记录不可用，没有执行：${error.message}`, { effects: 'none' }); }
      return await run();
    } catch (error) {
      await record({ error: errorCode(error) });
      throw error;
    }
  }
  return { record, guard };
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
