// The「Kimi」type's sign-in and install (scripts/sign-in.mjs, setup.mjs, the `sign-in` and `install` operations of
// `coda/resource@1`) run as Coda runs them, with a Kimi CLI and a `coda` standing in for the real ones. What the sign-in waits for
// is never the clock: the CLI waits for the login to have dealt with what it printed (a file the login notes it in), the login's 20
// seconds for a link end when the test says so, and the CLI ends once the test says it is confirmed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { resourceRecords } from '@coda-console/plugin-check/resources';
import { barePath, endWait, fakeCoda, operation, pluginEnv, probed } from '../command.mjs';
import { pluginDir } from '../plugin.mjs';

const lastLine = text => text.split('\n').map(line => line.trim()).filter(Boolean).at(-1);
const link = 'https://www.kimi.com/code/authorize_device?user_code=AXWD-2GDC';

// A machine's home with a Kimi CLI where its installer puts it, printing what `kimi login` 2.1.1 does, in pieces: the first ends
// inside the link. FAKE_SILENT: says nothing of a link, and 0 when it is ended; FAKE_REFUSE: ends 1 with that line once all is
// printed; FAKE_END: ends 0 at once; FAKE_OTHER_STREAM: says a whole line on the other stream between the pieces. Else it ends 0
// once `confirmed` is there. It notes how it was run and which `open` and `xdg-open` it would find.
async function machine(t, extra = {}) {
  const home = await mkdtemp(join(tmpdir(), 'coda-kimi-sign-in-')), state = join(home, 'state');
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, '.kimi-code/bin'), { recursive: true });
  await mkdir(state);
  await writeFile(join(home, '.kimi-code/bin/kimi'), `#!${process.execPath}
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const home = process.env.HOME, ack = process.env.TEST_START_ACK;
const found = spawnSync('/bin/sh', ['-c', 'command -v open; command -v xdg-open'], { encoding: 'utf8' }).stdout.trim().split('\\n');
writeFileSync(join(home, 'invocation.json'), JSON.stringify({ args: process.argv.slice(2), color: process.env.NO_COLOR, found }));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const heard = () => existsSync(ack) ? readFileSync(ack, 'utf8') : '';
const write = (stream, text) => new Promise(resolve => process[stream].write(text, resolve));
// Waits until the login has dealt with what was printed.
const until = async text => { while (!heard().includes(text)) await sleep(10); };
if (process.env.FAKE_SILENT) { console.error('Contacting kimi.com...'); process.on('SIGTERM', () => { console.error('登录已取消'); process.exit(0); }); setInterval(() => {}, 1000); }
else {
  await write('stderr', 'Opening browser for Kimi device login: https://www.kimi.com/code/authorize_device?user_code=AXWD-');
  await until('user_code=AXWD-');
  writeFileSync(join(home, 'reported-early'), String(heard().includes('[run coda')));
  if (process.env.FAKE_OTHER_STREAM) { await write('stdout', 'Checking the network...\\n'); await until('Checking the network...'); }
  await write('stderr', '2GDC\\nIf the browser did not open, paste the URL above and enter code: AXWD-2GDC\\nWaiting for authorization to complete…');
  if (process.env.FAKE_REFUSE) { console.error('\\n' + process.env.FAKE_REFUSE); process.exit(1); }
  if (process.env.FAKE_END) process.exit(0);
  while (!existsSync(join(home, 'confirmed'))) await sleep(10);
}
`, { mode: 0o755 });
  const watch = { ack: join(home, 'ack'), gate: join(home, 'gate') };
  const env = pluginEnv('kimi', { HOME: home, CODA_PLUGIN_STATE: state, ...extra, ...(extra.FAKE_CODA_AFTER_EXIT ? { FAKE_CODA_AFTER_EXIT: watch.ack } : {}) });
  const coda = await fakeCoda(home, probed(env, watch));
  return { home, state, coda, watch, login: operation(t, 'kimi', 'scripts/sign-in.mjs', coda.env) };
}
const reported = async coda => { for (let i = 0; i < 1000; i++) { const calls = await coda.calls(); if (calls.length) return calls; await delay(10); } throw new Error('没等到登录报告'); };

test('the Kimi sign-in reports the link and code of the CLI\'s device login whole, opens no browser on the machine, and ends well once it is confirmed', async t => {
  const { home, state, coda, login } = await machine(t);
  assert.deepEqual(await reported(coda), [{ command: 'progress', input: { url: link, code: 'AXWD-2GDC' } }]);
  assert.equal(await readFile(join(home, 'reported-early'), 'utf8'), 'false', 'nothing was reported of a link cut short');
  // `kimi login` opens the link with whichever `open` is first on its PATH: do-nothing ones, in the plugin's own state.
  const { args, color, found } = JSON.parse(await readFile(join(home, 'invocation.json'), 'utf8'));
  assert.deepEqual([args, color], [['login'], '1']);
  assert.deepEqual(found.map(path => dirname(path)), [join(state, 'no-browser'), join(state, 'no-browser')]);
  assert.equal(await readFile(found[0], 'utf8'), '#!/bin/sh\nexit 0\n');
  await writeFile(join(home, 'confirmed'), '');
  assert.equal(await login.ended, 0, login.stderr);
  assert.equal(login.stdout, '{}\n');
  assert.equal((await coda.calls()).length, 1, 'once');
});

test('a line is read from one stream only: the other stream speaking in the middle of the link does not cut it', async t => {
  const { home, coda, login } = await machine(t, { FAKE_OTHER_STREAM: '1' });
  assert.deepEqual(await reported(coda), [{ command: 'progress', input: { url: link, code: 'AXWD-2GDC' } }]);
  await writeFile(join(home, 'confirmed'), '');
  assert.equal(await login.ended, 0, login.stderr);
});

test('a login the CLI ends without confirmation fails with the last line it said', async t => {
  const { login } = await machine(t, { FAKE_REFUSE: 'Error: authorization expired' });
  assert.equal(await login.ended, 1);
  assert.equal(lastLine(login.stderr), 'Error: authorization expired');
  assert.equal(login.stdout, '');
});

test('a CLI that prints no link in time is given up on with what it said then, not what it says when ended, even when it ends 0', async t => {
  const { login, coda, watch } = await machine(t, { FAKE_SILENT: '1' });
  await endWait(watch, 'Contacting kimi.com...');
  assert.equal(await login.ended, 1);
  assert.equal(login.stdout, '');
  assert.equal(lastLine(login.stderr), 'Contacting kimi.com...');
  assert.deepEqual(await coda.calls(), []);
});

test('the report is waited for before the login is settled, and one that fails fails the login, the CLI ended well or not', async t => {
  // The CLI ends 0 as soon as it has printed all; the report fails only once the login has dealt with that exit.
  const { login, coda } = await machine(t, { FAKE_END: '1', FAKE_CODA_FAIL: 'progress', FAKE_CODA_AFTER_EXIT: '1' });
  assert.equal(await login.ended, 1);
  assert.equal(login.stdout, '');
  assert.equal(lastLine(login.stderr), 'coda progress 没有成功');
  assert.deepEqual(await coda.calls(), []);
});

test('without a Kimi CLI the sign-in says so', async t => {
  const home = await mkdtemp(join(tmpdir(), 'coda-kimi-sign-in-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const login = operation(t, 'kimi', 'scripts/sign-in.mjs', { ...pluginEnv('kimi', { HOME: home, CODA_PLUGIN_STATE: home }), PATH: await barePath(home) });
  assert.equal(await login.ended, 1);
  assert.equal(login.stderr.trim(), '这台机器上找不到 Kimi CLI');
});

test('Kimi is installed by the setup, with its own installer at the version checked, touching nothing else, and the result is {}', async t => {
  const home = await mkdtemp(join(tmpdir(), 'coda-kimi-install-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  // The installer is the CLI's own, fetched by bash: a bash here notes how it was run instead, and leaves a CLI of the version it
  // was asked for.
  const bin = join(home, 'fake-bin'), binary = join(home, '.kimi-code/bin/kimi');
  await mkdir(bin);
  await mkdir(dirname(binary), { recursive: true });
  await writeFile(join(bin, 'bash'), `#!/bin/sh\nprintf '%s\\n' "$KIMI_NO_MODIFY_PATH" "$PATH" "$2" "$KIMI_VERSION" > "${home}/installed"
printf '#!/bin/sh\\necho kimi %s\\n' "$KIMI_VERSION" > "${binary}" && chmod 755 "${binary}"\n`, { mode: 0o755 });
  const install = operation(t, 'kimi', 'scripts/setup.mjs', { ...pluginEnv('kimi', { HOME: home }), PATH: await barePath(home, bin, join(home, '.kimi-code/bin'), '/usr/bin', '/bin') });
  assert.equal(await install.ended, 0, install.stderr);
  assert.equal(install.stdout, '{}\n');
  assert.equal(lastLine(install.stderr), 'Kimi CLI 2.1.1');
  const [noModify, path, script, version] = (await readFile(join(home, 'installed'), 'utf8')).trim().split('\n');
  assert.equal(noModify, '1');
  assert.ok(!path.split(':').includes(join(home, '.kimi-code/bin')), 'its directory is left off PATH, so an older kimi is not renamed');
  assert.equal(script, 'set -o pipefail; curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash');
  assert.equal(version, '2.1.1');
});

// What the first-choice path may hold that is no CLI (a leftover that cannot run), with a `kimi` on the PATH that is: the record, the
// sign-in and the setup all take the one that runs, and say "not installed" only when there is none.
test('a file that cannot run on the first-choice path does not hide the Kimi CLI on the PATH, in the record, the sign-in and the setup', async t => {
  const home = await mkdtemp(join(tmpdir(), 'coda-kimi-leftover-')), bin = join(home, 'bin'), noInstaller = join(home, 'no-installer'), state = join(home, 'state');
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, '.kimi-code/bin'), { recursive: true });
  await mkdir(bin); await mkdir(noInstaller); await mkdir(state); await mkdir(join(home, 'alone'));
  await writeFile(join(home, '.kimi-code/bin/kimi'), '#!/bin/sh\nexit 1\n', { mode: 0o644 });
  // The one that runs says its version (the setup asks), and prints a device login and ends.
  await writeFile(join(bin, 'kimi'), `#!/bin/sh
[ "$1" = --version ] && { echo 'kimi 2.1.1'; exit 0; }
echo "$@" > "${home}/ran"
printf 'Opening browser for Kimi device login: https://www.kimi.com/code/authorize_device?user_code=AXWD-2GDC\\n' >&2
`, { mode: 0o755 });
  // An installer that would be run for a CLI not found is a failure here, not the network.
  await writeFile(join(noInstaller, 'bash'), `#!/bin/sh\n: > "${home}/installer-ran"\nexit 1\n`, { mode: 0o755 });
  // Everything the lookup reads is in the test's own directory: the home, the first-choice path under it, and the PATH.
  const env = { ...pluginEnv('kimi', { HOME: home, KIMI_CODE_HOME: '', CODA_PLUGIN_STATE: state }), PATH: await barePath(home, noInstaller, bin) };
  const [record] = await resourceRecords(pluginDir('kimi'), { env });
  assert.equal(record.spec.signIn.installed, true);
  const coda = await fakeCoda(home, env), login = operation(t, 'kimi', 'scripts/sign-in.mjs', coda.env);
  assert.equal(await login.ended, 0, login.stderr);
  assert.equal((await readFile(join(home, 'ran'), 'utf8')).trim(), 'login');
  const install = operation(t, 'kimi', 'scripts/setup.mjs', env);
  assert.equal(await install.ended, 0, install.stderr);
  assert.equal(install.stdout, '{}\n');
  assert.equal(existsSync(join(home, 'installer-ran')), false, 'nothing was installed');
  // With none on the PATH, the leftover alone is not an installed CLI.
  const [alone] = await resourceRecords(pluginDir('kimi'), { env: { ...env, PATH: await barePath(join(home, 'alone'), noInstaller) } });
  assert.equal(alone.spec.signIn.installed, false);
});
