// The step of 在测试机上执行 that runs the command a session's host-sim handed over for a test device (scripts/host-sim.mjs),
// once the device is lent to it: in the session's directory, with the session's environment, as if host-sim had run it
// there. Its commands see the device as theirs (`HOST_SIM_LEASE`), so that a project script calling host-sim again for
// it inside runs at once. The command's exit status is the step's output `exit_code`; the step itself succeeds, so that
// the status reaches host-sim as the command gave it.
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync, rmSync } from 'node:fs';
import { constants } from 'node:os';

const spec = JSON.parse(readFileSync(process.env.SPEC, 'utf8'));
rmSync(process.env.SPEC, { force: true });
const env = { ...spec.env, HOST_SIM_LEASE: `coda-run:${spec.kind}` };
const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, env, stdio: 'inherit' });
let ending = false;
// Cancelled (its task over, say): the step's process group is asked to stop, the command with it.
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => { ending = true; });
child.on('error', error => { process.stderr.write(`执行不了：${error.message}\n`); done(127); });
child.on('close', (code, signal) => done(code ?? 128 + (constants.signals[signal] ?? 0)));

function done(status) {
  appendFileSync(process.env.GITHUB_OUTPUT, `exit_code=${status}\n`);
  process.exit(ending ? 143 : 0);
}
