// 执行：/bin/sh -c 跑一条命令，等它结束，回退出码与（截短的）输出。
import { stat } from 'node:fs/promises';
import { defaultCwd } from './host.mjs';
import { terminate } from './kill.mjs';
import { timeLimit } from './limits.mjs';
import { openOutputs } from './output.mjs';
import { absolute, begin, fsError } from './operation.mjs';

async function checkCwd(coda, cwd) {
  absolute(coda, cwd, 'cwd');
  let info;
  try { info = await stat(cwd); } catch (error) { throw fsError(coda, error, cwd); }
  if (!info.isDirectory()) throw coda.error('not_a_directory', `${cwd}：不是目录`, { effects: 'none' });
}

// 一路输出读到结束，按块交给收集器；写不进去就抛。
const pump = async (stream, sink) => { for await (const chunk of stream) await sink.write(chunk); };

// 起进程、收输出、到点或被取消就结束整个进程组。成功回结果；取消与到期（外部）抛 `ctx.signal.reason`；失败抛错。
// 不论哪种结局，进程都已结束；没人要的输出目录已删。
async function run(coda, input, ctx, cwd) {
  await checkCwd(coda, cwd);
  const limit = timeLimit(input.timeout, ctx.deadline);
  const outputs = await openOutputs(ctx.id);
  const started = Date.now();
  let child;
  try {
    // 执行进程不能看到插件令牌；env 会 exec 成 sh，进程组的根不变。
    child = await ctx.spawn('/usr/bin/env', ['-u', 'CODA_TOKEN', '/bin/sh', '-c', input.command], { cwd });
  } catch (error) {
    await outputs.discard();
    throw error;
  }
  try {
    const exited = child.exited, settled = exited.then(() => {}, () => {});
    // 命令不读输入就退出是常事：写不进去（EPIPE）不是这次执行的失败。
    child.stdin.on('error', () => {});
    child.stdin.end(input.stdin);

    let timedOut = false, cancelled = false, failure = null, stopping = null;
    const stop = () => stopping ??= terminate(child.pid, settled);
    const timer = setTimeout(() => { timedOut = true; stop(); }, limit);
    const cancel = () => { cancelled = true; stop(); };
    ctx.signal.addEventListener('abort', cancel, { once: true });
    if (ctx.signal.aborted) cancel();
    let status;
    try {
      [status] = await Promise.all([exited, Promise.all([pump(child.stdout, outputs.stdout), pump(child.stderr, outputs.stderr)])]);
    } catch (error) {
      failure = error;
      stop();
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', cancel);
    }
    await stopping;
    if (cancelled) throw ctx.signal.reason;
    if (failure) throw failure;
    const done = await outputs.finish();
    if (ctx.signal.aborted) throw ctx.signal.reason;   // 收尾期间到的取消：不当成功
    return { exitCode: status.code ?? null, signal: status.signal ?? null, stdout: done.stdout, stderr: done.stderr,
      timedOut, truncated: done.truncated, outputDir: done.outputDir, ms: Date.now() - started };
  } catch (error) {
    await outputs.discard();
    throw error;
  }
}

// `input`：{ command, cwd?, timeout?, stdin? }
export async function exec(env, input, ctx) {
  const cwd = input.cwd ?? defaultCwd();
  const op = begin(env, 'exec', ctx, { command: input.command, cwd });
  const result = await op.guard({ command: input.command, cwd, timeout: input.timeout }, () => run(env.coda, input, ctx, cwd));
  await op.record({ result: { exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut } });
  return result;
}
