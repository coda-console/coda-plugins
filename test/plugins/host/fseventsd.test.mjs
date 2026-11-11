// The step of 文件事件服务守护 (plugins/host/README.md), run as Coda runs it, with pgrep, top and sudo standing in for the
// machine's: the tests never restart this Mac's fseventsd.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pluginEnv, run } from '../command.mjs';

// A tool that logs its arguments and then runs `body`.
function guard(t, { top = 'console.log("PID COMMAND\\nMEM\\n7872K")', sudo = '' } = {}) {
  const at = mkdtempSync(join(tmpdir(), 'host-fseventsd-'));
  t.after(() => rmSync(at, { recursive: true, force: true }));
  const log = join(at, 'calls'), tool = (name, body) => {
    writeFileSync(join(at, name), `#!${process.execPath}
require('node:fs').appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(name)} + ' ' + process.argv.slice(2).join(' ') + '\\n');
${body}
`, { mode: 0o755 });
    return join(at, name);
  };
  for (const name of ['output', 'summary']) writeFileSync(join(at, name), '');
  const tools = { HOST_FSEVENTSD_PGREP: tool('pgrep', 'console.log("321")'), HOST_FSEVENTSD_TOP: tool('top', top), HOST_FSEVENTSD_SUDO: tool('sudo', sudo) };
  const go = (extra = { CODA_ARBITER: '1' }) => {
    const env = pluginEnv('host', { ...tools, CODA_PLUGIN_STATE: at, THRESHOLD_MB: '512', GITHUB_OUTPUT: join(at, 'output'), GITHUB_STEP_SUMMARY: join(at, 'summary'), ...extra });
    if (!extra.CODA_ARBITER) delete env.CODA_ARBITER;
    return run('node "$CODA_PLUGIN_PATH/scripts/fseventsd-guard.mjs"', env);
  };
  const read = name => existsSync(join(at, name)) ? readFileSync(join(at, name), 'utf8') : '';
  const restarts = () => existsSync(join(at, 'fseventsd-guard.json')) ? JSON.parse(read('fseventsd-guard.json')).restarts : 0;
  return { go, calls: () => read('calls'), output: () => read('output'), summary: () => read('summary'), restarts };
}

test('文件事件服务守护 fails and says why when the memory cannot be read', async t => {
  const g = guard(t, { top: 'console.log("MEM\\n-")' });
  const result = await g.go();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /读不出 fseventsd 的占用：top 的 MEM 列读不懂：-/);
  assert.match(g.output(), /^line=读不出 fseventsd 的占用/);
  assert.doesNotMatch(g.calls(), /^sudo/m);
});

test('文件事件服务守护 under the threshold leaves fseventsd alone', async t => {
  const g = guard(t);
  const result = await g.go();
  assert.equal(result.code, 0, result.stderr);
  assert.match(g.calls(), /^top -l 1 -pid 321 -stats mem$/m);
  assert.doesNotMatch(g.calls(), /^sudo/m);
  assert.equal(g.restarts(), 0);
  assert.equal(g.output(), 'line=fseventsd 占用 8 MB · 累计重启 0 次\n');
  assert.match(g.summary(), /阈值 512 MB/);
});

test('文件事件服务守护 over the threshold restarts fseventsd and counts it', async t => {
  const g = guard(t, { top: 'console.log("MEM\\n3.6G+")' });
  for (const times of [1, 2]) {
    const result = await g.go();
    assert.equal(result.code, 0, result.stderr);
    assert.equal(g.restarts(), times);
    assert.equal(result.stdout.trim().split('\n').at(-1), `fseventsd 占用 3686 MB，超过 512 MB，已重启 · 累计重启 ${times} 次`);
  }
  assert.match(g.calls(), /^sudo -n killall fseventsd$/m);
});

test('文件事件服务守护 fails with the command to run by hand when sudo refuses', async t => {
  const g = guard(t, { top: 'console.log("MEM\\n900M")', sudo: 'console.error("sudo: a password is required"); process.exit(1)' });
  const result = await g.go();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /重启失败：sudo: a password is required/);
  assert.match(result.stderr, /请手动执行：sudo killall fseventsd/);
  assert.match(result.stderr, /NOPASSWD: \/usr\/bin\/killall fseventsd/);
  assert.equal(g.restarts(), 0);
});

test('文件事件服务守护 does nothing outside this instance’s own backend', async t => {
  const g = guard(t, { top: 'console.log("MEM\\n3.6G")' });
  const result = await g.go({});
  assert.equal(result.code, 0);
  assert.equal(g.calls(), '');
  assert.equal(g.output(), '');
});
