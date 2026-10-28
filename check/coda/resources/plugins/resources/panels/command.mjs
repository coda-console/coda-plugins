// A panel's command run once to its end (a reading, an action): `sh -c` in its own process group, its standard output kept
// apart from what it says on standard error, both bounded. Past its deadline the group is asked to stop, and made to two
// seconds later; once `signal` aborts (the module closing) it is made to at once.
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

const ansi = /\x1b\[[0-9;]*[A-Za-z]/g;
// The last thing a failed command said, for the one line the user sees.
export const lastLine = text => text.replace(ansi, '').split('\n').map(line => line.trim()).filter(Boolean).at(-1)?.slice(0, 200) ?? '';

export function runCommand(command, { env, timeoutMs, signal: aborted, maxBytes = 64 * 1024 }) {
  return new Promise(resolve => {
    const child = spawn('/bin/sh', ['-c', command], { cwd: tmpdir(), env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [], err = [];
    let sizes = [0, 0], overflow = false, timedOut = false, finished = false, hard = null;
    const signal = name => { try { process.kill(-child.pid, name); } catch {} };
    const stop = () => { signal('SIGTERM'); hard = setTimeout(() => signal('SIGKILL'), 2000); };
    const due = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    const abort = () => { if (!finished) signal('SIGKILL'); };
    aborted?.addEventListener('abort', abort, { once: true });
    const keep = (chunks, i) => chunk => {
      if (sizes[i] + chunk.length > maxBytes) { if (i === 0 && !overflow) { overflow = true; stop(); } return; }
      sizes[i] += chunk.length; chunks.push(chunk);
    };
    child.stdout.on('data', keep(out, 0));
    child.stderr.on('data', keep(err, 1));
    const finish = (code, error) => {
      if (finished) return;
      finished = true; clearTimeout(due); clearTimeout(hard); aborted?.removeEventListener('abort', abort);
      // Whatever it left behind in its group goes with it.
      if (child.pid) signal('SIGKILL');
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), timedOut, overflow, ...(error ? { error } : {}) });
    };
    child.on('error', error => finish(null, error.message));
    child.on('close', code => finish(code));
  });
}
// A command ended well: by itself, with 0. One stopped for its deadline or its output may still say 0 on the way out.
export const ended = result => result.code === 0 && !result.timedOut && !result.overflow;
// Why a command did not end well, in one line.
export function outcome(result, what) {
  if (result.timedOut) return `${what}超时`;
  if (result.overflow) return '输出过长';
  if (result.error) return `${what}没有开始：${result.error}`;
  return lastLine(result.stderr) || lastLine(result.stdout) || `${what}没有完成（退出码 ${result.code ?? '无'}）`;
}
