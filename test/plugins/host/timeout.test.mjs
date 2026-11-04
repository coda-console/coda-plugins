import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { readWorkflow } from '@coda-console/protocol/workflow';
import { keychainPromptHint as hint } from '../../../plugins/host/lib/keychain-prompt.mjs';
import { Journal, identity, taskFingerprint } from '../../../plugins/host/lib/journal.mjs';

const plugin = fileURLToPath(new URL('../../../plugins/host/', import.meta.url));
function fixture(t, present) {
  const root = mkdtempSync(join(tmpdir(), 'host-timeout-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = join(root, 'output'), calls = join(root, 'calls');
  writeFileSync(output, '');
  writeFileSync(join(root, 'pgrep'), '#!/bin/sh\necho "$*" >> "$PROBE_CALLS"\nexit ' + (present ? 0 : 1) + '\n', { mode: 0o755 });
  return { root, output, calls, env: { ...process.env, PATH: `${root}:${dirname(process.execPath)}:${process.env.PATH}`,
    CODA_PLUGIN_PATH: plugin, PROBE_CALLS: calls, GITHUB_OUTPUT: output, RUNNER_TEMP: root, HELD_CWD: root, HELD_IDLE_MINUTES: '0.005' } };
}
function execute(t, command, args, env, input) {
  const child = spawn(command, args, { env, detached: true });
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
  test(`workflow total timeout checks SecurityAgent once (present=${present})`, async t => {
    const f = fixture(t, present);
    const { root, problem } = await readWorkflow(readFileSync(join(plugin, '.coda/capabilities/run-held.bpmn'), 'utf8'), 'run-held');
    assert.ok(!problem, problem);
    const held = root.rootElements.find(e => e.$type === 'bpmn:Process').flowElements.find(e => e.id === 'held');
    const report = held.flowElements.find(e => e.id === 'report-timeout');
    assert.equal(held.flowElements.find(e => e.id === 'timeout-failed').targetRef, report);
    const result = await execute(t, '/bin/bash', ['-c', report.script], f.env);
    assert.equal(result.code, 1);
    assert.equal(result.stderr, `失败：执行超过总时限${suffix}\n`);
    assert.equal(readFileSync(f.output, 'utf8'), `failure_reason=执行超过总时限${suffix}\n`);
    checkedOnce(f);
  });
  test(`worker timeout preserves its SecurityAgent reason (present=${present})`, { timeout: 5000 }, async t => {
    const f = fixture(t, present), journal = new Journal(f.root);
    const spec = { assignmentId: 'assignment', attempt: 1, timeoutMs: 300, cancelGraceMs: 1000,
      requirements: { labels: [] }, task: { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] } };
    const object = { id: 'request', instance: 'instance', spec }, key = identity(object);
    journal.save({ key, id: object.id, instance: object.instance, fingerprint: taskFingerprint(spec), assignmentId: spec.assignmentId,
      admission: { lease: 'lease', slot: 0 }, phase: 'claimed' });
    const result = await execute(t, process.execPath, [join(plugin, 'scripts/execution-worker.mjs')], f.env,
      JSON.stringify({ root: f.root, key, source: null, spec, env: f.env }));
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(journal.get(key).result.reason, { code: 'cancelled', message: `执行已取消${suffix}` });
    checkedOnce(f);
  });
}

for (const status of [0, 4]) test(`command exit ${status} does not probe SecurityAgent`, async t => {
  const f = fixture(t, true);
  await execute(t, process.execPath, [join(plugin, 'scripts/run-held.mjs')], { ...f.env, HELD_COMMAND: `exit ${status}` });
  assert.equal(existsSync(f.calls), false);
  assert.equal(readFileSync(f.output, 'utf8'), status === 0 ? 'exit_code=0\n' : 'exit_code=4\nfailure_reason=命令非零退出（退出码 4）\n');
});
