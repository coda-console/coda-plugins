import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { keychainPromptHint as hint } from '../../../plugins/host/lib/keychain-prompt.mjs';
import { Journal, runKey } from '../../../plugins/host/lib/journal.mjs';

const plugin = fileURLToPath(new URL('../../../plugins/host/', import.meta.url));
function fixture(t, present) {
  const root = mkdtempSync(join(tmpdir(), 'host-timeout-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = join(root, 'output'), calls = join(root, 'calls');
  writeFileSync(output, '');
  writeFileSync(join(root, 'pgrep'), '#!/bin/sh\necho "$*" >> "$PROBE_CALLS"\nexit ' + (present ? 0 : 1) + '\n', { mode: 0o755 });
  return { root, output, calls, env: { ...process.env, PATH: `${root}:${dirname(process.execPath)}:${process.env.PATH}`,
    CODA_PLUGIN_PATH: plugin, PROBE_CALLS: calls, GITHUB_OUTPUT: output, RUNNER_TEMP: root, HELD_IDLE_MINUTES: '0.005', HELD_TIMEOUT_MINUTES: '30' } };
}
function execute(t, command, args, env, input) {
  const child = spawn(command, args, { env, detached: true, cwd: env.RUNNER_TEMP });
  let stderr = '';
  child.stdout.resume(); child.stderr.on('data', value => { stderr += value; });
  t.after(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} });
  child.stdin.end(input);
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve({ code, stderr }));
  });
}
function checkedOnce(f) {
  assert.equal(existsSync(f.calls) ? readFileSync(f.calls, 'utf8') : '', process.platform === 'darwin' ? '-x SecurityAgent\n' : '');
}

for (const present of [false, true]) {
  const suffix = present && process.platform === 'darwin' ? hint : '';
  test(`idle timeout checks SecurityAgent once (present=${present})`, { timeout: 5000 }, async t => {
    const f = fixture(t, present);
    const result = await execute(t, process.execPath, [join(plugin, 'scripts/run-held.mjs')], { ...f.env, HELD_COMMAND: 'exec sleep 60' });
    assert.equal(result.code, 1);
    assert.equal(result.stderr, `失败：0.005 分钟无输出${suffix}\n`);
    assert.ok(readFileSync(f.output, 'utf8').endsWith(`failure_reason=0.005 分钟无输出${suffix}\n`));
    checkedOnce(f);
  });
  test(`total timeout checks SecurityAgent once (present=${present})`, { timeout: 5000 }, async t => {
    const f = fixture(t, present);
    const result = await execute(t, process.execPath, [join(plugin, 'scripts/run-held.mjs')],
      { ...f.env, HELD_COMMAND: 'exec sleep 60', HELD_IDLE_MINUTES: '0', HELD_TIMEOUT_MINUTES: '0.005' });
    assert.equal(result.code, 1);
    assert.equal(result.stderr, `失败：执行超过总时限${suffix}\n`);
    assert.ok(readFileSync(f.output, 'utf8').endsWith(`failure_reason=执行超过总时限${suffix}\n`));
    checkedOnce(f);
  });
  test(`worker timeout preserves its SecurityAgent reason (present=${present})`, { timeout: 5000 }, async t => {
    const f = fixture(t, present), journal = new Journal(f.root);
    const spec = { source: null, timeoutMs: 300, cancelGraceMs: 1000, requirements: { labels: [] }, resources: {},
      task: { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] }, env: {} };
    const run = { kind: 'coda/run@1', id: 'request' }, key = runKey(run);
    journal.save({ key, runId: run.id, phase: 'claimed', admission: { lease: 'lease', slot: 0 } });
    const result = await execute(t, process.execPath, [join(plugin, 'scripts/execution-worker.mjs')], f.env,
      JSON.stringify({ root: f.root, key, source: null, spec, env: f.env, slot: 0 }));
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(journal.get(key).result.reason, { code: 'cancelled', message: `执行已取消${suffix}` });
    checkedOnce(f);
  });
}

for (const value of ['-1', '1441']) test(`a total timeout of ${value} minutes fails before the command runs`, async t => {
  const f = fixture(t, false);
  const result = await execute(t, process.execPath, [join(plugin, 'scripts/run-held.mjs')],
    { ...f.env, HELD_COMMAND: 'echo ran', HELD_IDLE_MINUTES: '0', HELD_TIMEOUT_MINUTES: value });
  assert.equal(result.code, 1);
  assert.equal(result.stderr, `失败：总时限须在 0～1440 分钟之间：${value}\n`);
  assert.equal(readFileSync(f.output, 'utf8'), `exit_code=2\nfailure_reason=总时限须在 0～1440 分钟之间：${value}\n`);
});

// A shell with job control puts its background job in a group of its own, as swift build does its compilers: TERM to the
// command's group alone leaves it under launchd, holding the output pipe and the machine's memory.
test('idle timeout also ends what the command started in a process group of its own', { timeout: 5000 }, async t => {
  const f = fixture(t, false), escaped = join(f.root, 'escaped');
  const result = await execute(t, process.execPath, [join(plugin, 'scripts/run-held.mjs')],
    { ...f.env, SHELL: '/bin/bash', HELD_COMMAND: `set -m; sleep 60 & echo $! > ${JSON.stringify(escaped)}; wait` });
  const pid = Number(readFileSync(escaped, 'utf8'));
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch {} });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /无输出/);
  // Gone once launchd has reaped it; the test's time limit stands for a process that is not.
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  while (alive()) await new Promise(resolve => setTimeout(resolve, 20));
});

for (const status of [0, 4]) test(`command exit ${status} does not probe SecurityAgent`, async t => {
  const f = fixture(t, true);
  await execute(t, process.execPath, [join(plugin, 'scripts/run-held.mjs')], { ...f.env, HELD_COMMAND: `exit ${status}` });
  assert.equal(existsSync(f.calls), false);
  assert.equal(readFileSync(f.output, 'utf8'), status === 0 ? 'exit_code=0\n' : 'exit_code=4\nfailure_reason=命令非零退出（退出码 4）\n');
});
