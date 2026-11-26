// 执行：/bin/sh -c 跑一条命令，等它结束，回退出码与（截短的）输出。
import { stat } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { cleanEnv, shellArgs } from './environ.mjs';
import { defaultCwd } from './host.mjs';
import { terminate } from './kill.mjs';
import { timeLimit } from './limits.mjs';
import { openOutputs, sweepOutputs } from './output.mjs';
import { absolute, begin, fsError } from './operation.mjs';
import { prepareSandbox, probe } from './sandbox.mjs';

async function checkCwd(coda, cwd) {
  absolute(coda, cwd, 'cwd');
  let info;
  try { info = await stat(cwd); } catch (error) { throw fsError(coda, error, cwd); }
  if (!info.isDirectory()) throw coda.error('not_a_directory', `${cwd}：不是目录`, { effects: 'none' });
}

// 终止之后等输出收完的时间上限：命令里起的脱离进程组的进程（新会话）会拿着继承来的输出管道，组已经没了管道还不关。
export const DRAIN = 2000;

// 同时在跑的执行至多这么多，再来的以 `too_many_running` 拒绝（什么都没做）。
export const MAX_RUNNING = 8;
let running = 0;
export const runningCount = () => running;
// 正在用的输出目录：回收时跳过它们。
export const activeOutputs = new Set();

// 一路输出读到结束，按块交给收集器；写不进去就抛。
const pump = async (stream, sink) => { for await (const chunk of stream) await sink.write(chunk); };

// 起进程、收输出、到点或被取消就结束整个进程组。带了 `input.restrict` 的走受限执行（见 sandbox.mjs），准备不成就抛错，不会退回不受限。成功回结果；取消与到期（外部）抛 `ctx.signal.reason`；失败抛错。
// 终止之后只再等 `DRAIN` 毫秒让输出收完；还没收完（脱离进程组的后代拿着管道）就销毁两路输出、不再等，按已收到的输出走原来的结局。
// 不论哪种结局，进程都已结束；没人要的输出目录已删。
// `env`：exec 的环境（`env.outputRoot` 回输出根目录，见 output.mjs 的 `outputRoot`；`env.maxRunning` 并发上限）。
async function run(env, input, ctx, cwd) {
  const { coda, maxRunning: max = MAX_RUNNING } = env;
  if (running >= max) {
    throw coda.error('too_many_running', `这台机器上已有 ${running} 个执行在跑（上限 ${max}），稍后再试`, { effects: 'none', retryAfterMs: 5000 });
  }
  running++;
  try { return await runSlot(env, input, ctx, cwd); } finally { running--; }
}

async function runSlot(env, input, ctx, cwd) {
  const { coda } = env;
  // 受限：准备不成（不支持、参数不合法、目录不对、cwd 越界……）与空跑不过都在这里抛，之后才有 `sandbox`；它的临时目录不论怎么结束都删。
  const sandbox = input.restrict === undefined ? null : await prepareSandbox(env, input.restrict, input.cwd);
  try {
    if (sandbox) await probe(coda, sandbox, ctx.spawn); else await checkCwd(coda, cwd);
    const limit = timeLimit(input.timeout, ctx.deadline);
    let root;
    try { root = await env.outputRoot(); } catch (error) { throw coda.error('output_unavailable', `执行的输出无处可放，没有执行：${error.message}`, { effects: 'none' }); }
    const outputs = await openOutputs(ctx.id, root);
    activeOutputs.add(outputs.dir);
    let result;
    try { result = await runWith(input, ctx, sandbox?.cwd ?? cwd, limit, outputs, sandbox); } finally { activeOutputs.delete(outputs.dir); }
    // 留下了这次的输出：把它算进总量，当场回收超额与过期的（正在写的跳过）。
    if (result.outputDir) await sweepOutputs(root, { active: activeOutputs });
    return result;
  } finally { await sandbox?.cleanup(); }
}

async function runWith(input, ctx, cwd, limit, outputs, sandbox) {
  const started = Date.now();
  let child;
  try {
    // 不继承后端的环境：`env -i` 清空，只带白名单（见 environ.mjs）；env 会 exec 成 sh，进程组的根不变。受限的在 env 与 sh 之间多一层 sandbox-exec（见 sandbox.mjs）。
    const [command, args] = sandbox ? sandbox.argv(input.command, cleanEnv()) : shellArgs(input.command, cleanEnv());
    child = await ctx.spawn(command, args, { cwd });
  } catch (error) {
    await outputs.discard();
    throw error;
  }
  try {
    const exited = child.exited, settled = exited.then(() => {}, () => {});
    let status = {};
    const pumps = Promise.all([pump(child.stdout, outputs.stdout), pump(child.stderr, outputs.stderr)]);
    const drained = Promise.all([exited.then(value => { status = value; }), pumps]);
    const finished = drained.then(() => true, () => true);
    // 命令不读输入就退出是常事：写不进去（EPIPE）不是这次执行的失败。
    child.stdin.on('error', () => {});
    child.stdin.end(input.stdin);

    let timedOut = false, cancelled = false, failure = null, stopping = null, abandoned = false, giveUp;
    const gaveUp = new Promise(resolve => { giveUp = resolve; });
    const stop = () => stopping ??= (async () => {
      await terminate(child.pid, settled);
      if (await Promise.race([finished, sleep(DRAIN, false, { ref: false })])) return;
      abandoned = true;
      child.stdout.destroy();
      child.stderr.destroy();
      await Promise.allSettled([pumps]);
      giveUp();
    })();
    const timer = setTimeout(() => { timedOut = true; stop(); }, limit);
    const cancel = () => { cancelled = true; stop(); };
    ctx.signal.addEventListener('abort', cancel, { once: true });
    if (ctx.signal.aborted) cancel();
    try {
      await Promise.race([drained, gaveUp]);
    } catch (error) {
      if (!abandoned) { failure = error; stop(); }   // 自己销毁管道引起的错误不算失败
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

// `input`：{ command, cwd?, timeout?, stdin?, restrict? }；`restrict` 是 { dirs: [{ path, access: 'rw' | 'ro' }] }，带了就只在这些目录里读写（见 sandbox.mjs）。
export async function exec(env, input, ctx) {
  const restricted = input.restrict !== undefined;
  // 受限且没给 cwd 时用第一条 rw 目录，不是家目录。
  const cwd = input.cwd ?? (restricted ? input.restrict?.dirs?.find?.(one => one?.access === 'rw')?.path : defaultCwd());
  const limits = restricted ? { restrict: input.restrict } : {};
  const op = begin(env, 'exec', ctx, { command: input.command, cwd, timeout: input.timeout, ...limits });
  // 判定点拿到完整的执行输入（含 stdin 与实际生效的 cwd）；记录只记命令全文、目录、传入的时限（没给就不写）与受限的目录列表（带了才有），不记 stdin。
  const result = await op.guard({ command: input.command, cwd, timeout: input.timeout, stdin: input.stdin, ...limits }, () => run(env, input, ctx, cwd));
  await op.record({ result: { exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut } });
  return result;
}
