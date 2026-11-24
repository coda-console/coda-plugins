// 操作记录：每次操作一行 JSON（JSONL），追加在插件状态目录的 audit.jsonl。被拒绝的也记。
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export const AUDIT_FILE = 'audit.jsonl';

// 同一个文件的追加一个接一个做：长命令的一行会被拆成几次写，并发的两行不能穿插；做完（不论成败，任务自己不抛）再轮到下一个。
const tails = new Map();
function enqueue(file, task) {
  const run = (tails.get(file) ?? Promise.resolve()).then(task);
  tails.set(file, run);
  run.then(() => { if (tails.get(file) === run) tails.delete(file); });
  return run;
}

// 把一次操作变成一行（不含换行）。
//   id：`ctx.id`，流没有就不写；caller：`ctx.caller` 原样整个存，不挑字段（`machine` 是接收方核验的，`plugin`、`parent`
//   是来源后端转述的，以后可能还有别的）；operation：exec | pull | push；params：命令全文与目录，或路径与范围；
//   result：退出码/信号/是否超时，或字节数；error：错误码（被拒绝或失败）；ms：耗时。
export function auditLine({ time = new Date(), id, caller, operation, params, result, error, ms }) {
  return JSON.stringify({
    time: time.toISOString(),
    ...(id === undefined ? {} : { id }),
    caller: caller ?? null,
    operation,
    params,
    ...(error === undefined ? { result } : { error }),
    ms,
  });
}

// 追加到 `state`（插件状态目录）里的记录文件。
//   `ready()`：操作开始之前问一次记录能不能写（建状态目录、以追加方式打开记录文件、不写内容）；不能就抛，调用方据此拒绝这次操作。
//   `write(line, what)`：操作之后追加一行。写不进去不抛（操作已经做完，结局不能变），在标准错误写明哪次调用（`what`）的记录丢了。
export function createAuditLog(state, { warn = console.error } = {}) {
  let said = false;
  return {
    async ready() {
      if (!state) throw new Error('没有插件状态目录，操作记录无处可写');
      try {
        await mkdir(state, { recursive: true });
        await appendFile(join(state, AUDIT_FILE), '');
      } catch (error) { throw new Error(`操作记录写不进 ${join(state, AUDIT_FILE)}：${error.message}`); }
    },
    async write(line, what = '一次调用') {
      if (!state) {
        if (!said) { said = true; warn(`远程执行：没有插件状态目录，操作记录不会保存（${what}的记录丢了）`); }
        return;
      }
      const file = join(state, AUDIT_FILE);
      await enqueue(file, async () => {
        try {
          await mkdir(state, { recursive: true });
          await appendFile(file, `${line}\n`);
        } catch (error) { warn(`远程执行：操作记录写不进 ${file}：${error.message}（${what}的记录丢了）`); }
      });
    },
  };
}
