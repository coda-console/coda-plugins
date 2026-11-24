// 远程执行：设置里的开关打开时，登记一条 remote-exec/machine@1 记录，让空间里别的机器知道这台能执行；关着不登记。
// 记录的内容（系统、用户、目录）是这台上执行进程看到的环境，由本模块自己算；机器名取 Coda 的本机机器记录，变了跟着改。
// 一个操作（exec）两条流（pull、push）的处理函数在这里登记，每次操作都先看当前的开关（见 lib/operation.mjs 的顺序）。
import { createAuditLog } from './lib/audit.mjs';
import { KEY, LOCAL_MACHINE, MACHINE, SETTING } from './lib/definitions.mjs';
import { exec } from './lib/exec.mjs';
import { pull, push } from './lib/files.mjs';
import { hostSpec } from './lib/host.mjs';

const report = what => error => console.error(`远程执行：${what}：${error?.message ?? error}`);
let disposables = [];

export async function activate(coda) {
  let enabled = false, name = null, ready = false, notified = false, queue = Promise.resolve();
  // 登记（或撤掉）这条记录；一次接一次做，旧的读数不会盖过新的。
  const publish = () => coda.replace(MACHINE, enabled ? [{ key: KEY, spec: hostSpec(name), status: { available: true } }] : []);
  const refresh = () => { const run = queue.then(publish); queue = run.catch(() => {}); return run; };
  const apply = settings => {
    const next = settings?.[SETTING] === true;
    if (next === enabled) return;
    enabled = next;
    if (ready) refresh().catch(report('登记记录失败'));
  };

  const env = { coda, enabled: () => enabled, audit: createAuditLog(coda.plugin.state) };
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
      if (ready && enabled) refresh().catch(report('更新机器名失败'));
    }, { scope: 'local' }));
  } catch (error) { report('读不到本机的机器名，用主机名')(error); }
  ready = true;
  await refresh();
}

export function deactivate() {
  for (const disposable of disposables.splice(0)) disposable.dispose();
}
