// A process a plugin's module started (`coda.spawn`, `ctx.spawn`; docs/plugins.md「起进程」), relayed to the module over
// the plugin host's channel: by the backend for the processes it starts (components/plugins/plugin-processes.mjs), and
// by the plugins' test host for its own (adapters/plugin-test-host.mjs), so that its output, its input and its end cross
// alike. To the module: `output { process, stream, data }` (base64) and `output { process, stream, end: true }` for
// `stdout` and `stderr` each, then `exited { process, code, signal }` once both have ended and the process has (the
// child's `close`): nothing of it comes after. From it: what it wrote to `stdin` (`input`, answered once written, so a
// writer waits on each), what it has read of an output (`drained`) and `kill`. What it wrote that the process has not
// taken once it has closed (Node calls back no write or end on an input it destroyed as the process exited) fails then,
// and what it writes after fails at once.
//
// A process started with no pipes (a named one, its output in a log file) has none of these but its end and `kill`.
//
// Each output may be at most WINDOW bytes ahead of what the module has read: past it, the stream is paused, and the
// process waits on its pipe as it would on a reader of its own, until the module reads. Detached (the module's process
// gone), what it writes is read and dropped: nobody waits on it.
import { ContractError, requireCondition as check } from '../domain/errors.mjs';

export const WINDOW = 256 * 1024;

// What both say of one asked for: a named one only as the plugin's manifest names it (`contributes.processes`); one that
// did not start at all (no such program; Node refusing its arguments or directory) did nothing.
export const checkNamed = (plugin, processes, name) =>
  check((processes ?? []).includes(name), 'not_found', `插件 ${plugin} 的清单里没有进程 ${name}（contributes.processes）`);
export const unstarted = (command, error) => new ContractError('spawn_failed', `起不了 ${command}：${error.message}`, { effects: 'none' });

export function relayProcess(child, key, send) {
  let attached = true;
  const tell = (method, params) => { if (attached) try { send({ method, params: { process: key, ...params } }); } catch {} };
  const ahead = { stdout: 0, stderr: 0 };
  for (const name of ['stdout', 'stderr']) {
    const stream = child[name];
    if (!stream) continue;
    stream.on('data', chunk => {
      if (!attached) return;
      tell('output', { stream: name, data: chunk.toString('base64') });
      if ((ahead[name] += chunk.length) >= WINDOW) stream.pause();
    });
    stream.on('end', () => tell('output', { stream: name, end: true }));
  }
  child.stdin?.on('error', () => {});
  // The input written or ended and not answered yet, by how each fails.
  const pending = new Set();
  let closed = false;
  const gone = () => Object.assign(new Error('进程已经结束，写不进去了'), { code: 'EPIPE' });
  child.on('close', (code, signal) => {
    closed = true;
    for (const reject of pending) reject(gone());
    pending.clear();
    tell('exited', { code, signal });
  });
  return {
    // What the module wrote, written: done once the pipe has taken it, or its end; failing as either does.
    input({ data, end }) {
      return new Promise((resolve, reject) => {
        if (closed) return reject(gone());
        pending.add(reject);
        const done = error => { pending.delete(reject); if (error) reject(error); else resolve(); };
        if (end) return child.stdin.end(done);
        child.stdin.write(Buffer.from(String(data), 'base64'), done);
      });
    },
    drained({ stream, bytes }) {
      if (!Object.hasOwn(ahead, stream) || !Number.isSafeInteger(bytes) || bytes < 0) return;
      ahead[stream] = Math.max(0, ahead[stream] - bytes);
      if (ahead[stream] < WINDOW) child[stream].resume();
    },
    // A signal Node does not know is sent to nobody.
    kill(signal = 'SIGTERM') { try { child.kill(signal); } catch {} },
    detach() {
      attached = false;
      child.stdout?.resume(); child.stderr?.resume();
    },
  };
}
