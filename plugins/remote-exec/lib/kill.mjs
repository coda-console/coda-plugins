// 结束一个进程连同它的进程组：先 SIGTERM 整个组，宽限之后组里还有进程就 SIGKILL 整个组。
import { setTimeout as sleep } from 'node:timers/promises';

export const GRACE = 2000;
const STEP = 50;

// 给组（-pid）发信号；组不存在或不许发就退回只发给这个进程，记一行标准错误。回 'group'、'process'；进程已经没了回 null。
function send(pid, signal, kill, warn) {
  try { kill(-pid, signal); return 'group'; } catch (error) {
    warn(`远程执行：给进程组 ${pid} 发 ${signal} 失败（${error.code ?? error.message}），改发给进程本身`);
  }
  try { kill(pid, signal); return 'process'; } catch (error) {
    if (error.code !== 'ESRCH') warn(`远程执行：给进程 ${pid} 发 ${signal} 失败：${error.message}`);
    return null;
  }
}

// 组里还有进程（信号 0 不发信号，只问在不在）。
function groupAlive(pid, kill) {
  try { kill(-pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

// 组信号发成功时，以整组还有没有进程决定要不要升级（组长退了组员还在，照样 KILL）；只有退回单进程时才以 `exited` 为准。
// `exited`：进程退出时 resolve 的 promise；`kill`、`wait` 可注入（测试用）。回 true 说明宽限到了，用了 SIGKILL。
export async function terminate(pid, exited, { kill = process.kill, wait = ms => sleep(ms, undefined, { ref: false }), grace = GRACE, warn = console.error } = {}) {
  const reached = send(pid, 'SIGTERM', kill, warn);
  if (!reached) return false;
  if (reached === 'group') {
    for (let left = grace; groupAlive(pid, kill); left -= STEP) {
      if (left <= 0) { send(pid, 'SIGKILL', kill, warn); return true; }
      await wait(STEP);
    }
    return false;
  }
  if (await Promise.race([exited.then(() => true), wait(grace).then(() => false)])) return false;
  send(pid, 'SIGKILL', kill, warn);
  return true;
}
