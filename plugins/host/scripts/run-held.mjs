// The step of 持锁执行 that runs the command a session's agent handed over with workflow_run, once the slot is held: in
// the directory it named, with the project's environment, through the user's shell. Its commands see the slot as theirs
// (`HOST_SIM_LEASE`), so a project script calling host-sim inside runs at once instead of waiting behind itself; a
// simulator one of them registers (`host-sim bind`) is written to `HOST_SIM_DEVICES` and deleted here once the command is
// over, cancelled or not. The command's exit status is the step's output `exit_code`, and the step fails as the command
// does: the agent is told a failure, with the end of what it printed.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { constants } from 'node:os';

const { HELD_COMMAND: command, HELD_CWD: cwd, HELD_WHAT: what } = process.env;
const devices = join(process.env.RUNNER_TEMP, 'host-sim-devices');
// What the step is given as the plugin's and the runner's is not what the command runs with.
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(CODA_(NODE|ARBITER|PLUGIN_.*|GROUPS|ARTIFACTS)|GITHUB_.*|RUNNER_.*|HELD_.*)$/.test(name)));
Object.assign(env, { HOST_SIM_LEASE: `coda-run:${what === '模拟器' ? 'simulator' : 'build'}`, HOST_SIM_DEVICES: devices });
// The simulator tool, which a test may stand in for.
const simctl = env.HOST_SIM_SIMCTL ?? 'xcrun';

let ending = false;
if (!isAbsolute(cwd ?? '') || !existsSync(cwd) || !statSync(cwd).isDirectory()) {
  process.stderr.write(`cwd 须为存在的目录的绝对路径：${cwd}\n`);
  done(2);
} else {
  const child = spawn(env.SHELL || '/bin/sh', ['-c', command], { cwd, env, stdio: 'inherit' });
  // Cancelled: the step's process group is asked to stop, the command with it; the simulators still go before the step ends.
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => { ending = true; });
  child.on('error', error => { process.stderr.write(`执行不了：${error.message}\n`); done(127); });
  child.on('close', (code, signal) => done(code ?? 128 + (constants.signals[signal] ?? 0)));
}

function done(status) {
  for (const udid of existsSync(devices) ? new Set(readFileSync(devices, 'utf8').split('\n').filter(Boolean)) : []) {
    for (const action of ['shutdown', 'delete']) {
      const result = spawnSync(simctl, ['simctl', action, udid], { encoding: 'utf8' });
      if (action === 'delete') process.stdout.write(result.status === 0 ? `已删除模拟器 ${udid}\n` : `删除模拟器 ${udid} 失败：${(result.stderr || result.error?.message || '').trim()}\n`);
    }
  }
  appendFileSync(process.env.GITHUB_OUTPUT, `exit_code=${status}\n`);
  process.exit(ending ? 143 : status === 0 ? 0 : 1);
}
