// 按项目串行：进程内严格 FIFO 的 Promise 队列，加进程间的目录锁。
// 插件主进程与定时同步脚本因此不会同时碰同一个 mnemon.db（避免 SQLITE_BUSY）。
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// 项目 id 编码成单层目录名：字母、数字、下划线、连字符原样保留，其余字符转 %XX（%XX 的 % 不在保留集里，所以不会撞名）；
// 「.」也被转码，路径穿越进不来。
export function safeProjectId(projectId) {
  if (typeof projectId !== 'string' || !projectId) throw new Error(`projectId 必须是非空字符串：${JSON.stringify(projectId)}`);
  const safe = [...Buffer.from(projectId, 'utf8')].map(byte => {
    const char = String.fromCharCode(byte);
    return /[A-Za-z0-9_-]/.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }).join('');
  if (safe.length > 200) throw new Error(`projectId 太长：${projectId.length} 个字符`);
  return safe;
}

// 项目的状态目录：锁、同步状态都在这里。
export const projectDir = (stateDir, projectId) => join(stateDir, 'projects', safeProjectId(projectId));

const alive = pid => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
};
async function readOwner(lockDir) {
  try { return JSON.parse(await readFile(join(lockDir, 'owner.json'), 'utf8')); } catch { return null; }
}

// 只在持有者进程确已退出（ESRCH）时才算过期：长耗时的全量重建不能被中途抢锁。
// 没有可用 pid 的锁（持有者刚 mkdir 还没写完，或 owner.json 坏了）才按目录的年龄判断。
async function isStale(lockDir, staleMs) {
  const owner = await readOwner(lockDir);
  if (Number.isInteger(owner?.pid) && owner.pid > 0) return !alive(owner.pid);
  const info = await stat(lockDir).catch(() => null);
  return !!info && Date.now() - info.mtimeMs > staleMs;
}

// 把过期的锁挪走再删。挪走之后核对挪走的确是刚判过期的那一把：别的等待者可能已经清掉它并建了新锁，
// 这时把新锁放回去，不能误删。
async function reap(lockDir, staleMs) {
  const before = await readOwner(lockDir);
  if (!await isStale(lockDir, staleMs)) return;
  const moved = `${lockDir}.stale-${randomBytes(4).toString('hex')}`;
  try { await rename(lockDir, moved); } catch { return; }
  const owner = await readOwner(moved);
  if (owner?.token === before?.token) { await rm(moved, { recursive: true, force: true }); return; }
  await rename(moved, lockDir).catch(() => rm(moved, { recursive: true, force: true }));
}

async function acquire(dir, { staleMs, timeoutMs }) {
  const lockDir = join(dir, '.lock'), token = randomBytes(8).toString('hex'), deadline = Date.now() + timeoutMs;
  await mkdir(dir, { recursive: true });
  for (let wait = 20; ; wait = Math.min(wait * 1.5, 250)) {
    try {
      await mkdir(lockDir);
      await writeFile(join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }));
      return { lockDir, token };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    await reap(lockDir, staleMs);
    if (Date.now() > deadline) throw Object.assign(new Error(`等待项目锁超时：${lockDir}`), { code: 'lock_timeout' });
    await delay(wait);
  }
}

// 锁已被别人当过期清掉并重建时，不删别人的。
async function release({ lockDir, token }) {
  if ((await readOwner(lockDir))?.token === token) await rm(lockDir, { recursive: true, force: true });
}

const tails = new Map();

// 同一项目的 fn 一个接一个跑（FIFO，成功或抛错都放行下一个），并持有跨进程的目录锁。
export async function withProjectLock(stateDir, projectId, fn, { staleMs = 10_000, timeoutMs = 10 * 60_000 } = {}) {
  const dir = projectDir(stateDir, projectId), key = resolve(dir);
  const run = (tails.get(key) ?? Promise.resolve()).then(async () => {
    const lock = await acquire(dir, { staleMs, timeoutMs });
    try { return await fn(); } finally { await release(lock); }
  });
  const tail = run.catch(() => {});
  tails.set(key, tail);
  tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
  return run;
}
