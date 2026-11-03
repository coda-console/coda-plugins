import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../scripts/executor-hook.mjs', import.meta.url));
const kill = (pid, signal) => { try { process.kill(-pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } };

// The existing three-part JSON hook envelope, including a responseFile and opaque prepare state.
// Each hook has its own process group. Cancellation waits for termination before cleanup and lease release.
export async function callHook({ command, args, state = null, directory, env, signal, grace = 10_000, onProcess = async () => {} }) {
  signal?.throwIfAborted();
  await mkdir(directory, { recursive: true });
  const responseFile = join(directory, `${command}.json`), log = join(directory, 'log');
  const output = openSync(log, 'a', 0o600);
  let child;
  try { child = spawn(process.execPath, [entry], { cwd: directory, env, detached: true, stdio: ['pipe', output, output] }); }
  finally { closeSync(output); }
  let timer, aborted = false;
  const stop = () => {
    aborted = true;
    if (child.pid) kill(child.pid, 'SIGTERM');
    timer ??= setTimeout(() => { if (child.pid) kill(child.pid, 'SIGKILL'); }, grace);
  };
  const ended = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code: code ?? null, signal }));
  });
  child.stdin.on('error', () => {});
  // Register cancellation before delivering the work, including an abort during spawn.
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();
  let failure, result;
  try {
    await onProcess(child.pid);
    child.stdin.end(JSON.stringify({ command, responseFile, args, state }));
    result = await ended;
  } catch (error) { failure = error; stop(); await ended.catch(() => {}); }
  finally {
    clearTimeout(timer); signal?.removeEventListener('abort', stop);
    // No surviving background commands may retain the slot after the hook returns.
    if (child.pid) kill(child.pid, 'SIGKILL');
  }
  let answer = null;
  try { answer = JSON.parse(await readFile(responseFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  if (failure) throw failure;
  return { ...result, aborted, answer };
}

export async function executeHooks({ directory, root, attempt, source, slot, spec, env, signal, checkpoint, hook = callHook }) {
  let state = null, code = null, failure = null;
  const grace = spec.cancelGraceMs ?? 10_000;
  let deadline = signal.aborted ? Date.now() + grace : null;
  const cancelled = () => { deadline ??= Date.now() + grace; };
  signal.addEventListener('abort', cancelled, { once: true });
  const common = { directory, env, grace: spec.cancelGraceMs ?? 10_000,
    onProcess: pid => checkpoint({ pid }) };
  try {
    const prepared = await hook({ ...common, command: 'prepare_job', signal,
      args: { root, source, slot, attempt, directory, labels: spec.requirements.labels, checkout: source !== null } });
    state = prepared.answer?.state ?? null;
    if (state) await checkpoint({ hookState: state });
    if (prepared.aborted) throw new Error('准备已取消');
    if (prepared.code !== 0 || !state) throw new Error('prepare_job 失败或未返回 state');
    signal.throwIfAborted();
    await checkpoint({ phase: 'running', startedAt: new Date().toISOString() });
    const result = await hook({ ...common, command: 'run_script_step', signal, state,
      args: { ...spec.task, workingDirectory: spec.workingDirectory ?? '.', env: spec.env ?? {},
        context: spec.context, metered: slot !== null,
        files: { output: join(directory, 'output'), summary: join(directory, 'summary') } } });
    code = result.code;
    if (result.aborted || signal.aborted) throw new Error('执行已取消');
  } catch (error) { failure = error; }
  finally {
    if (state) {
      await checkpoint({ phase: 'cleanup' });
      // A fresh bounded cleanup signal: a cancelled command must still receive cleanup_job.
      const remaining = Math.max(0, (deadline ?? Date.now() + grace) - Date.now());
      const cleanup = new AbortController(), timer = setTimeout(() => cleanup.abort(), Math.min(remaining, 2 ** 31 - 1));
      try {
        const result = await hook({ ...common, command: 'cleanup_job', args: {}, state, signal: cleanup.signal, grace: 0 });
        if (result.code !== 0 || result.aborted) await appendFile(join(directory, 'log'), 'cleanup_job 失败或超过收尾期限\n');
      } catch (error) { await appendFile(join(directory, 'log'), `cleanup_job: ${error.message}\n`); }
      finally { clearTimeout(timer); }
    }
    await checkpoint({ pid: null });
    signal.removeEventListener('abort', cancelled);
  }
  return { exitCode: code, outcome: signal.aborted ? 'cancelled' : failure || code !== 0 ? 'failed' : 'succeeded',
    ...(failure ? { reason: { code: signal.aborted ? 'cancelled' : 'execution_failed', message: failure.message } } : {}) };
}
