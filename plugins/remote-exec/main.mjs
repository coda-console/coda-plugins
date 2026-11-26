// 远程执行：设置里的开关打开时，登记一条 remote-exec/machine@1 记录，让空间里别的机器知道这台能执行；关着不登记。
// 记录的内容（系统、用户、目录）是这台上执行进程看到的环境，由本模块自己算；机器名取 Coda 的本机机器记录，变了跟着改。
// 一个操作（exec）两条流（pull、push）的处理函数在这里登记，每次操作都先看当前的开关（见 lib/operation.mjs 的顺序）。
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createAuditLog } from './lib/audit.mjs';
import { activeOutputs, exec } from './lib/exec.mjs';
import { outputRoot, sweepOutputs } from './lib/output.mjs';
import { KEY, LOCAL_MACHINE, MACHINE, SETTING } from './lib/definitions.mjs';
import { pull, push } from './lib/files.mjs';
import { hostSpec } from './lib/host.mjs';
import { TMP_DIR } from './lib/sandbox.mjs';

const report = what => error => console.error(`远程执行：${what}：${error?.message ?? error}`);
let disposables = [];
const RETRY_FIRST = 5_000, RETRY_MAX = 300_000;
// 留下的执行输出：插件激活时回收一次，之后每小时一次（留下新输出时另会当场回收），没人再执行时过期的也删得掉。
export const SWEEP_EVERY = 60 * 60 * 1000;

// `schedule`、`cancel` 只为测试里不真等：重试的计时器可以换掉。
export async function activate(coda, { schedule = setTimeout, cancel = clearTimeout, every = setInterval, stopEvery = clearInterval } = {}) {
  let enabled = false, name = null, ready = false, notified = false, stopped = false, pending = false, inFlight = false, timer = null, delay = RETRY_FIRST;
  disposables.push({ dispose() { stopped = true; cancel(timer); timer = null; } });
  // 只有一个待发布状态：变化只标记「有待发布」，发布时读的是当时最新的开关与机器名。
  // 没有进行中的发布、也不在等重试时才发；失败了按退避等计时器，期间的变化并进这个状态，不另起发布。
  const flush = async () => {
    if (inFlight) return;   // 进行中的发布结束后会再看一次是否还有待发布
    inFlight = true;
    try {
      while (pending && !stopped) {
        pending = false;
        try {
          await coda.replace(MACHINE, enabled ? [{ key: KEY, spec: hostSpec(name), status: { available: true } }] : []);
          delay = RETRY_FIRST;
        } catch (error) {
          pending = true;
          report('登记记录失败')(error);
          if (!stopped && !timer) {
            timer = schedule(() => { timer = null; flush(); }, delay);
            delay = Math.min(delay * 2, RETRY_MAX);
          }
          return;
        }
      }
    } finally { inFlight = false; }
  };
  const publishLater = () => { pending = true; if (ready && !timer) flush(); };
  const apply = settings => {
    const next = settings?.[SETTING] === true;
    if (next === enabled) return;
    enabled = next;
    publishLater();
  };

  // 输出的根在插件状态目录里：每次要用时现查（不在就建），被人删了下次照样建得回来。
  const rootOf = () => outputRoot(coda.plugin.state);
  const sweep = () => rootOf().then(dir => sweepOutputs(dir, { active: activeOutputs }), report('回收留下的执行输出失败'));
  // 状态目录是 `<状态根>/plugins/<插件>`：受限执行的保护范围是整个状态根。
  const { state } = coda.plugin;
  const env = { coda, enabled: () => enabled, audit: createAuditLog(state), outputRoot: rootOf, state, stateRoot: state ? dirname(dirname(state)) : null };
  // 上一次没收尾（后端崩了）留下的受限执行临时目录：登记处理函数之前删，这时没有在跑的调用。
  if (state) await rm(join(state, TMP_DIR), { recursive: true, force: true }).catch(report('删不掉上次留下的受限执行临时目录'));
  disposables.push(
    coda.handle(MACHINE, 'exec', (input, ctx) => exec(env, input, ctx)),
    await coda.stream(MACHINE, 'pull', (request, ctx) => pull(env, request, ctx)),
    await coda.stream(MACHINE, 'push', (request, ctx) => push(env, request, ctx)),
  );
  disposables.push(coda.settings.onChange(settings => { notified = true; apply(settings); }));
  // 读设置期间收到过通知，通知比读到的快照新，以通知为准。
  const snapshot = await coda.settings.get();
  if (!notified) apply(snapshot);
  try {
    disposables.push(await coda.watch(LOCAL_MACHINE, ({ type, entry }) => {
      const next = type === 'DELETED' ? null : entry?.spec?.name ?? null;
      if (next === name) return;
      name = next;
      if (enabled) publishLater();
    }, { scope: 'local' }));
  } catch (error) { report('读不到本机的机器名，用主机名')(error); }
  ready = true;
  pending = true;
  await flush();
  if (coda.plugin.state) {
    await sweep();
    const sweeper = every(sweep, SWEEP_EVERY);
    sweeper?.unref?.();
    disposables.push({ dispose() { stopEvery(sweeper); } });
  }
}

export function deactivate() {
  for (const disposable of disposables.splice(0)) disposable.dispose();
}
