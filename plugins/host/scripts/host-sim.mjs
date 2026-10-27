// A session's `host-sim` (README.md), which this plugin puts on every session's and step's PATH
// (contributes.commands). A build or simulator command takes a slot of the group host: inside one already held — a command
// 持锁执行 runs (`HOST_SIM_LEASE`), or a workflow step holding the group (`CODA_GROUPS`: coda:group="host", or hold-group) —
// host-sim runs what it is given at once, `check` agrees and `bind` registers a simulator, which 持锁执行 deletes as the
// command ends and 清点模拟器 if it did not. A slot is asked for by the session's agent itself, with workflow_run (持锁执行,
// `run-held`): a session's command line cannot say whether a native subagent ran it, and one may not ask for a slot.
// Anywhere else — a terminal, a step holding nothing — there is no slot to take: it is refused (#1054 第 4 期).
// Another kind (a test device's name) is handed whole to what is plugged into this plugin's point `kinds` (the testbed
// plugin's, the testbed plugin's README.md).
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { constants as system } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2), command = args[0];
const option = name => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
// A step names its session too; what it may run is what its groups (`CODA_GROUPS`) hold, never a slot asked for the session.
const kind = option('--kind'), thread = process.env.CODA_GROUPS === undefined && process.env.CODA_THREAD_ID;
// What Coda gives this command as the plugin's (Coda's docs/plugins.md「插件进程的环境」) is not what the session's commands run with.
const session = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^CODA_(NODE|ARBITER|PLUGIN_.*)$/.test(name)));

const lease = process.env.HOST_SIM_LEASE ?? '', leased = lease.startsWith('coda-run:') ? lease.slice('coda-run:'.length) : null;
const stepHeld = (process.env.CODA_GROUPS ?? '').split(' ').includes('host');
const held = stepHeld || ['build', 'simulator'].includes(leased);

if (kind && !['build', 'simulator'].includes(kind)) other();
else if (command === 'run' && held) {
  const at = args.indexOf('--'), argv = at >= 0 ? args.slice(at + 1) : [];
  if (!argv.length) fail('用法：host-sim run --kind build|simulator|<设备名> -- <命令> [参数…]', 2);
  // Inside a held command (a project script calling itself again): the slot is this one's. What it runs is told so as a
  // project script asks, by HOST_SIM_LEASE — else one that goes through host-sim until it is set would never stop.
  follow(argv, { ...session(), HOST_SIM_LEASE: lease || 'coda-group:host' });
} else if (command === 'run' && thread && kind) {
  const at = args.indexOf('--'), argv = at >= 0 ? args.slice(at + 1) : [];
  fail(`在会话里要占着${kind === 'simulator' ? '模拟器' : '构建'}名额执行命令，由 Agent 调用 workflow_run：workflow 为 run-held，inputs 给 command`
    + `（${argv.length ? `如 ${JSON.stringify(argv.join(' ').slice(0, 200))}` : '要执行的命令'}）与 cwd（绝对路径）${kind === 'simulator' ? '，what 为 模拟器' : ''}。`
    + '原生子 Agent 不能申请名额：把这一步交回主 Agent，或由主 Agent 用 spawn 派一个 Coda 子会话去做。', 2);
} else if (command === 'check' && held) {
  process.stderr.write(stepHeld && !leased ? 'host-sim：在流程步骤占着的组 host 里\n' : `host-sim：在 Coda 持锁执行的名额里（${leased}）\n`);
} else if (command === 'bind' && held) {
  const udid = args.slice(1).filter((arg, i, rest) => !arg.startsWith('--') && !rest[i - 1]?.startsWith('--')).at(-1);
  if (!udid) fail('用法：host-sim bind <udid>', 2);
  // This environment's simulators (Coda's docs/deployment.md「后端实例」), in this plugin's state: 持锁执行 deletes the ones its command
  // registered as soon as it ends (`HOST_SIM_DEVICES`), 清点模拟器 what is left.
  appendFileSync(join(process.env.CODA_PLUGIN_STATE, 'simulators'), `${udid}\n`, { mode: 0o600 });
  if (process.env.HOST_SIM_DEVICES) appendFileSync(process.env.HOST_SIM_DEVICES, `${udid}\n`);
  else process.stderr.write(`host-sim：模拟器 ${udid} 由宿主资源插件定时清点时删除\n`);
} else if (!['run', 'check', 'bind'].includes(command)) {
  fail('用法：host-sim run --kind build|simulator|<设备名> -- <命令>，或在名额里用 check、bind', 2);
} else if (thread) {
  fail(command === 'run' ? '需要 --kind build、simulator 或测试机的设备名' : '不在构建与模拟器名额里：由 Agent 调用 workflow_run（workflow 为 run-held）执行这条命令', command === 'run' ? 2 : 1);
} else if (process.env.CODA_GROUPS !== undefined) {
  fail('这一步没有占着组 host：调用 host-sim 的步骤写 coda:group="host"，测试机调用能力 use-testbed', 1);
} else {
  fail('只能在 Coda 的会话或流程步骤里用：名额由 Coda 排，终端里直接运行不排队，也不执行', 1);
}

// A kind this plugin does not hold: the whole command line to the first plugged into `kinds`, run as that plugin's.
function other() {
  const [plugged] = JSON.parse(process.env.CODA_PLUGIN_EXTENSIONS || '{}').kinds ?? [];
  if (!plugged) fail(`没有插件处理 --kind ${kind}：测试机要从商店装上「测试机」插件`, 2);
  follow(['/bin/sh', '-c', `${plugged.command} "$@"`, 'host-sim', ...args], { ...session(), CODA_NODE: process.env.CODA_NODE,
    CODA_PLUGIN_PATH: plugged.path, ...(plugged.state ? { CODA_PLUGIN_STATE: plugged.state } : {}) });
}
// Runs it in the foreground, ending as it ends; a signal to this process goes on to it.
function follow([program, ...rest], env) {
  const child = spawn(program, rest, { stdio: 'inherit', env });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
  child.on('error', error => fail(error.message, 127));
  child.on('close', (code, signal) => process.exit(code ?? 128 + (system.signals[signal] ?? 0)));
}
function fail(message, code) { process.stderr.write(`host-sim：${message}\n`); process.exit(code); }
