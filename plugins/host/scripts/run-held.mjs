// The step of 持锁执行 that runs the command a session's agent handed over with workflow_run, once the slot is held: in
// the step's own working directory (the `coda:source` it names: the calling work copy here, or the one checked out on
// another Mac), with the project's environment, through the user's shell. Its commands see the slot as theirs
// (`HOST_SIM_LEASE`), so a project script calling host-sim inside runs at once instead of waiting behind itself; a
// simulator one of them registers (`host-sim bind`) is written to `HOST_SIM_DEVICES` and deleted here once the command is
// over, cancelled or not. The total limit is counted from the command's start (queueing does not count): at the limit the
// whole tree is stopped like a silent one, and the step fails with 执行超过总时限. The command's exit status is the
// step's output `exit_code`, and the step fails as the command does: the agent is told a failure, with the end of what it
// printed.
import { spawn, execFile } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { constants } from 'node:os';
import { promisify } from 'node:util';
import { keychainPromptSuffix } from '../lib/keychain-prompt.mjs';
import { processTree, signalTree } from '../lib/process-tree.mjs';
const exec = promisify(execFile);

const { HELD_COMMAND: command, HELD_WHAT: what, HELD_TIMEOUT_MINUTES: timeout } = process.env;
const devices = join(process.env.RUNNER_TEMP, 'host-sim-devices');
// What the step is given as the plugin's and the runner's is not what the command runs with.
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(CODA_(NODE|ARBITER|PLUGIN_.*|GROUPS|ARTIFACTS)|GITHUB_.*|RUNNER_.*|HELD_.*)$/.test(name)));
Object.assign(env, { HOST_SIM_LEASE: `coda-run:${what === '模拟器' ? 'simulator' : 'build'}`, HOST_SIM_DEVICES: devices, HOST_SIM_RUN_ID: process.env.GITHUB_RUN_ID ?? '' });
// The simulator tool, which a test may stand in for.
const simctl = env.HOST_SIM_SIMCTL ?? 'xcrun';

const idleMinutes = Number(process.env.HELD_IDLE_MINUTES ?? 10);
const timeoutMinutes = Number(timeout);
let idleTimer, timeoutTimer, killTimer, stopReason = '';
let ending = false;
// Register before launching the command, and keep cancellation authoritative through cleanup and exit.
// A signal callback may arrive after the child's close callback, even for the same group-wide TERM.
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => { ending = true; process.exitCode = 143; });
if (!(timeoutMinutes > 0 && timeoutMinutes <= 1440)) {
  stopReason = `总时限须在 0～1440 分钟之间：${timeout ?? ''}`;
  await done(2);
} else {
  const child = spawn(env.SHELL || '/bin/sh', ['-c', command], { env, stdio: ['inherit', 'pipe', 'pipe'] });
  // Stop the entire command tree, with what it started in groups of its own (lib/process-tree.mjs), retaining the same
  // five-minute cleanup grace as the workflow's cancelTimeout. The first reason wins.
  const stop = reason => {
    if (stopReason) return;
    stopReason = reason;
    clearTimeout(idleTimer);
    clearTimeout(timeoutTimer);
    void processTree([process.pid]).then(tree => {
      killTimer = setTimeout(() => void signalTree([process.pid], tree, 'SIGKILL'), 5 * 60_000);
      killTimer.unref();
      return signalTree([process.pid], tree, 'SIGTERM');
    });
  };
  const resetIdle = () => {
    clearTimeout(idleTimer);
    if (idleMinutes > 0 && !stopReason && !ending) idleTimer = setTimeout(() => {
      if (ending) return;
      stop(`${idleMinutes} 分钟无输出${keychainPromptSuffix()}`);
    }, idleMinutes * 60_000);
  };
  timeoutTimer = setTimeout(() => stop(`执行超过总时限${keychainPromptSuffix()}`), timeoutMinutes * 60_000);
  for (const [stream, destination] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    stream.setEncoding('utf8');
    stream.on('data', data => {
      destination.write(data);
      resetIdle();
    });
  }
  resetIdle();
  // Cancelled: the step's process group is asked to stop, the command with it; the simulators still go before the step ends.
  const status = await new Promise(resolve => {
    child.on('error', error => { process.stderr.write(`执行不了：${error.message}\n`); resolve(127); });
    child.on('close', (code, signal) => resolve(code ?? 128 + (constants.signals[signal] ?? 0)));
  });
  clearTimeout(idleTimer);
  clearTimeout(timeoutTimer);
  await done(status);
}

async function done(status) {
  for (const udid of existsSync(devices) ? new Set(readFileSync(devices, 'utf8').split('\n').filter(Boolean)) : []) {
    for (const action of ['shutdown', 'delete']) {
      // Leave the event loop free to receive cancellation while simctl is running.
      let failure;
      try { await exec(simctl, ['simctl', action, udid]); } catch (error) { failure = error; }
      if (action === 'delete') process.stdout.write(!failure ? `已删除模拟器 ${udid}\n` : `删除模拟器 ${udid} 失败：${(failure.stderr || failure.message).trim()}\n`);
    }
  }
  appendFileSync(process.env.GITHUB_OUTPUT, `exit_code=${status}\n`);
  const reason = stopReason || (!ending && status !== 0 ? `命令非零退出（退出码 ${status}）` : '');
  if (reason) {
    appendFileSync(process.env.GITHUB_OUTPUT, `failure_reason=${reason}\n`);
    process.stderr.write(`失败：${reason}\n`);
  }
  clearTimeout(killTimer);
  // Let pending signal callbacks and output drain instead of synchronously exiting inside close.
  process.exitCode = stopReason ? 1 : ending ? 143 : status === 0 ? 0 : 1;
}
