// remote-exec 的处理函数测试共用：假的 ctx（`spawn` 用 Node 的 child_process 起真的进程，不起 Coda 后端）、操作记录读取。
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuditLog, AUDIT_FILE } from '../../../plugins/remote-exec/lib/audit.mjs';

export const SECRET = 'plugin-token-for-test';
export const caller = { machine: 'm-1', plugin: 'other', parent: { kind: 'coda/thread@1', id: 't-1' }, future: 1 };
export const coda = { error: (code, message, { effects } = {}) => Object.assign(new Error(message), { code, effects }) };

export const scratch = t => {
  const path = mkdtempSync(join(tmpdir(), 'remote-exec-test-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
};

// 条件成立为止（每 10 ms 看一次，至多 10 秒）：等一件已经在路上的事，不是赌时序。
export async function waitFor(check, what = '条件') {
  for (let i = 0; i < 1000; i++) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`等不到：${what}`);
}

// 照后端的样子起进程：自成进程组的组长，`CODA_TOKEN` 在环境里（执行进程不该看到它），输出是 Buffer 流。
//   reap：根退出时把组里剩下的收掉（后端会这样做）；测试结束进程组的处理要由插件自己做的，传 false，并让后台进程不拿着输出管道。
//   ready：等进程写出第一个字节才算起好，计时从那之后开始。
export function fakeSpawn(t, { reap = true, ready = false } = {}) {
  const leaders = [];
  t.after(() => { for (const pid of leaders) try { process.kill(-pid, 'SIGKILL'); } catch {} });
  return async (command, args = [], { cwd } = {}) => {
    const child = spawn(command, args, { cwd, detached: true, env: { ...process.env, CODA_TOKEN: SECRET } });
    try { await once(child, 'spawn'); } catch (error) { throw Object.assign(new Error(error.message), { code: 'spawn_failed', effects: 'none' }); }
    leaders.push(child.pid);
    const exited = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    if (reap) child.once('exit', () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} });
    if (ready) await once(child.stdout, 'readable');
    return { pid: child.pid, stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, exited, kill: signal => child.kill(signal) };
  };
}

// 处理函数的环境与记录：`lines()` 读操作记录。
export function setup(t, { enabled = true } = {}) {
  const state = scratch(t), gate = { enabled };
  const env = { coda, enabled: () => gate.enabled, audit: createAuditLog(state) };
  const lines = () => {
    try { return readFileSync(join(state, AUDIT_FILE), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; }
  };
  return { env, state, lines, set: value => { gate.enabled = value; } };
}

const gone = pid => { try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } };
export const allGone = pids => waitFor(() => pids.every(gone), `进程 ${pids} 结束`);
