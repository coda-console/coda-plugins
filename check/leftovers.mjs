// What the checker starts and makes goes however it ends: the process groups of agents and panels it started (detached,
// so a Ctrl-C at the terminal does not reach them), what stops those it had Coda's code start, and its temporary
// directories. bin/check.mjs turns SIGINT and SIGTERM into an exit, which runs this.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const groups = new Set(), closers = new Set(), dirs = new Set();
process.on('exit', () => {
  for (const pid of groups) try { process.kill(-pid, 'SIGKILL'); } catch {}
  for (const close of closers) try { close(); } catch {}
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

// A process group started (named by its leader's pid); the returned function says it is gone.
export function group(pid) {
  if (pid) groups.add(pid);
  return () => groups.delete(pid);
}
// What ends what Coda's code started (it must do so at once); the returned function says it is done with.
export function closing(close) {
  closers.add(close);
  return () => closers.delete(close);
}
// A new temporary directory; `remove()` removes it now.
export function temporary(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.add(dir);
  return { dir, remove: () => { rmSync(dir, { recursive: true, force: true }); dirs.delete(dir); } };
}
