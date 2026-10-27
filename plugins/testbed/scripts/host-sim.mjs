// What this plugin plugs into the host plugin's `host-sim` (its point `kinds`, README.md):
// `host-sim run|check --kind <设备名> …` for a test device, handed over whole. In a session doing that device's task, a
// command is handed to the capability 在测试机上执行 and followed with `coda-run`: Coda lends it the device the task holds
// and runs it in the session's directory, with its environment. Inside that command (`HOST_SIM_LEASE=coda-run:<设备名>`),
// or in a step whose run holds the device's group (`CODA_GROUPS` names device:<设备名>), it runs at once.
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { constants as system, tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2), command = args[0];
const option = name => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
// A step names its session too; what it may run is what its groups (`CODA_GROUPS`) hold, never a device asked for the session.
const kind = option('--kind'), thread = process.env.CODA_GROUPS === undefined && process.env.CODA_THREAD_ID, group = `device:${kind}`;
// What Coda gives this command as the plugin's (Coda's docs/plugins.md「插件进程的环境」) is not what the session's commands run with.
const session = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^CODA_(NODE|ARBITER|PLUGIN_.*)$/.test(name)));
const lease = process.env.HOST_SIM_LEASE ?? '';
const stepHeld = (process.env.CODA_GROUPS ?? '').split(' ').includes(group);
const held = stepHeld || lease === `coda-run:${kind}`;

if (command === 'run' && (held || thread)) {
  const at = args.indexOf('--'), argv = at >= 0 ? args.slice(at + 1) : [];
  if (!argv.length) fail('用法：host-sim run --kind <设备名> -- <命令> [参数…]', 2);
  // Already inside a command on the device (a project script calling itself again): it is this one's.
  if (held) follow(argv, { ...session(), HOST_SIM_LEASE: lease || `coda-group:${group}` });
  else {
    // What to run, where and with what, for 在测试机上执行 to read: kept while the run may still read it. coda-run ending
    // with any status but 75 (Coda's docs/workflows.md「从命令行调用」) says the run is over or never started — the device
    // not lent, say —, so it goes then; let go of (75, or a signal), the run goes on and reads it however late that is.
    const env = session();
    delete env.HOST_SIM_LEASE; delete env.HOST_SIM_DEVICES;
    const dir = join(process.env.TMPDIR || tmpdir(), 'coda-host-sim');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const spec = join(dir, `${randomUUID()}.json`);
    writeFileSync(spec, JSON.stringify({ argv, cwd: process.cwd(), env, kind }), { mode: 0o600 });
    follow(['coda-run', 'run-on-device', `spec=${spec}`, `device=${kind}`, `label=${argv.join(' ').slice(0, 200)}`], session(),
      code => { if (code !== null && code !== 75) rmSync(spec, { force: true }); });
  }
} else if (command === 'check' && held) {
  process.stderr.write(`host-sim：在借到的测试机 ${kind} 上\n`);
} else if (!['run', 'check'].includes(command)) {
  fail(`用法：host-sim run --kind ${kind} -- <命令>，或在借到的测试机上用 check`, 2);
} else if (thread) {
  fail(`不在测试机 ${kind} 里：先用 host-sim run --kind ${kind} -- <命令>`, 1);
} else if (process.env.CODA_GROUPS !== undefined) {
  fail(`这一步没有占着组 ${group}：测试机调用能力 use-testbed`, 1);
} else {
  fail('只能在 Coda 的会话或流程步骤里用：测试机由 Coda 借出，终端里直接运行不借，也不执行', 1);
}

// Runs it in the foreground, ending as it ends; a signal to this process goes on to it (coda-run then lets the run go on).
// `ended` is told its exit code first: 127 when it could not be started, null when a signal ended it.
function follow([program, ...rest], env, ended = () => {}) {
  const child = spawn(program, rest, { stdio: 'inherit', env });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
  child.on('error', error => { ended(127); fail(error.message, 127); });
  child.on('close', (code, signal) => { ended(code); process.exit(code ?? 128 + (system.signals[signal] ?? 0)); });
}
function fail(message, code) { process.stderr.write(`host-sim：${message}\n`); process.exit(code); }
