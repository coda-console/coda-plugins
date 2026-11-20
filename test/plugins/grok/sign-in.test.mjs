// The「Grok」type's sign-in and install (scripts/sign-in.mjs, install.mjs, the `sign-in` and `install` operations of
// `coda/resource@1`) run as Coda runs them, with a Grok CLI and a `coda` standing in for the real ones. What the sign-in waits for is
// never the clock: the CLI waits for the login to have dealt with what it printed (a file the login notes it in), the login's 20
// seconds for a link end when the test says so, and the CLI ends once the test says it is confirmed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { resourceRecords } from '@coda-console/plugin-check/resources';
import { barePath, endWait, fakeCoda, manifest, operation, pluginEnv, probed, run } from '../command.mjs';
import { pluginDir } from '../plugin.mjs';

const lastLine = text => text.split('\n').map(line => line.trim()).filter(Boolean).at(-1);
const link = 'https://accounts.x.ai/oauth2/device?user_code=ABCD-EF12';

// A machine's home with a Grok CLI where its installer puts it, printing what `grok login --device-auth` 1.0 does, in pieces: the
// first ends inside the link. FAKE_SILENT: says nothing of a link, and 0 when it is ended; FAKE_REFUSE: ends 1 with that line once
// all is printed; FAKE_END: ends 0 at once; FAKE_OTHER_STREAM: says a whole line on the other stream between the pieces. Else it
// ends 0 once `confirmed` is there.
async function machine(t, extra = {}) {
  const home = await mkdtemp(join(tmpdir(), 'coda-grok-sign-in-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, '.grok/bin'), { recursive: true });
  await writeFile(join(home, '.grok/bin/grok'), `#!${process.execPath}
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const home = process.env.HOME, ack = process.env.TEST_START_ACK;
writeFileSync(join(home, 'invocation.json'), JSON.stringify({ args: process.argv.slice(2), browser: process.env.BROWSER, color: process.env.NO_COLOR }));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const heard = () => existsSync(ack) ? readFileSync(ack, 'utf8') : '';
const write = (stream, text) => new Promise(resolve => process[stream].write(text, resolve));
// Waits until the login has dealt with what was printed.
const until = async text => { while (!heard().includes(text)) await sleep(10); };
if (process.env.FAKE_SILENT) { console.error('Contacting x.ai...'); process.on('SIGTERM', () => { console.error('登录已取消'); process.exit(0); }); setInterval(() => {}, 1000); }
else {
  await write('stderr', '\\nTo sign in, open this URL in your browser:\\n\\n  https://accounts.x.ai/oauth2/device?user_code=ABCD-');
  await until('user_code=ABCD-');
  writeFileSync(join(home, 'reported-early'), String(heard().includes('[run coda')));
  if (process.env.FAKE_OTHER_STREAM) { await write('stdout', 'Checking the network...\\n'); await until('Checking the network...'); }
  await write('stderr', 'EF12\\n\\nConfirm this code in your browser:\\n\\n  \\x1b[1mABCD-EF12\\x1b[0m\\n\\nWaiting for authorization...\\n');
  if (process.env.FAKE_REFUSE) { console.error(process.env.FAKE_REFUSE); process.exit(1); }
  if (process.env.FAKE_END) process.exit(0);
  while (!existsSync(join(home, 'confirmed'))) await sleep(10);
}
`, { mode: 0o755 });
  const watch = { ack: join(home, 'ack'), gate: join(home, 'gate') };
  const env = pluginEnv('grok', { HOME: home, ...extra, ...(extra.FAKE_CODA_AFTER_EXIT ? { FAKE_CODA_AFTER_EXIT: watch.ack } : {}) });
  const coda = await fakeCoda(home, probed(env, watch));
  return { home, coda, watch, login: operation(t, 'grok', 'scripts/sign-in.mjs', coda.env) };
}
const reported = async coda => { for (let i = 0; i < 1000; i++) { const calls = await coda.calls(); if (calls.length) return calls; await delay(10); } throw new Error('没等到登录报告'); };

test('the Grok sign-in reports the link and code of the CLI\'s device login whole, uncoloured, opening no browser, and ends well once it is confirmed', async t => {
  const { home, coda, login } = await machine(t);
  assert.deepEqual(await reported(coda), [{ command: 'progress', input: { url: link, code: 'ABCD-EF12' } }]);
  assert.equal(await readFile(join(home, 'reported-early'), 'utf8'), 'false', 'nothing was reported of a link cut short');
  assert.deepEqual(JSON.parse(await readFile(join(home, 'invocation.json'), 'utf8')), { args: ['login', '--device-auth'], browser: '/usr/bin/true', color: '1' });
  await writeFile(join(home, 'confirmed'), '');
  assert.equal(await login.ended, 0, login.stderr);
  assert.equal(login.stdout, '{}\n');
  assert.equal((await coda.calls()).length, 1, 'once');
});

test('a line is read from one stream only: the other stream speaking in the middle of the link does not cut it', async t => {
  const { home, coda, login } = await machine(t, { FAKE_OTHER_STREAM: '1' });
  assert.deepEqual(await reported(coda), [{ command: 'progress', input: { url: link, code: 'ABCD-EF12' } }]);
  await writeFile(join(home, 'confirmed'), '');
  assert.equal(await login.ended, 0, login.stderr);
});

test('a login the CLI ends without confirmation fails with the last line it said', async t => {
  const { login } = await machine(t, { FAKE_REFUSE: 'Error: access_denied' });
  assert.equal(await login.ended, 1);
  assert.equal(lastLine(login.stderr), 'Error: access_denied');
  assert.equal(login.stdout, '');
});

test('a CLI that prints no link in time is given up on with what it said then, not what it says when ended, even when it ends 0', async t => {
  const { login, coda, watch } = await machine(t, { FAKE_SILENT: '1' });
  await endWait(watch, 'Contacting x.ai...');
  assert.equal(await login.ended, 1);
  assert.equal(login.stdout, '');
  assert.equal(lastLine(login.stderr), 'Contacting x.ai...');
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

test('without a Grok CLI the sign-in says so', async t => {
  const home = await mkdtemp(join(tmpdir(), 'coda-grok-sign-in-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const login = operation(t, 'grok', 'scripts/sign-in.mjs', { ...pluginEnv('grok', { HOME: home }), PATH: await barePath(home) });
  assert.equal(await login.ended, 1);
  assert.equal(login.stderr.trim(), '这台机器上找不到 Grok CLI');
});

// A bash that notes how it was run instead of fetching Grok's installer.
async function installer(t, script) {
  const home = await mkdtemp(join(tmpdir(), 'coda-grok-install-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const bin = join(home, 'fake-bin');
  await mkdir(bin);
  await writeFile(join(bin, 'bash'), `#!/bin/sh\n${script}`, { mode: 0o755 });
  return { home, install: operation(t, 'grok', 'scripts/install.mjs', pluginEnv('grok', { HOME: home, PATH: `${bin}:/usr/bin:/bin`, SHELL: '/bin/zsh' })) };
}

// What an installer run here leaves in ~/.grok/bin: a `grok` whose version says `grok <said>`, or (null) one that does not start.
const leaves = said => `mkdir -p "$HOME/.grok/bin"; printf '#!/bin/sh\\n${said ? `echo grok ${said}` : 'exit 1'}\\n' > "$HOME/.grok/bin/grok"; chmod 755 "$HOME/.grok/bin/grok"\n`;

test('Grok is installed by its own installer, touching no shell configuration, and the result is {}', async t => {
  const { home, install } = await installer(t, `${leaves('1.0.52')}printf '%s\\n' "$SHELL" "$PATH" "$2" > "$HOME/installed"`);
  assert.equal(await install.ended, 0, install.stderr);
  assert.equal(install.stdout, '{}\n');
  const [shell, path, script] = (await readFile(join(home, 'installed'), 'utf8')).trimEnd().split('\n');
  assert.equal(shell, '', 'no shell configuration to update');
  assert.equal(path.split(':')[0], join(home, '.grok/bin'), 'nothing to link into ~/.local/bin');
  assert.equal(script, 'set -o pipefail; curl -fsSL https://x.ai/cli/install.sh | bash');
});

test('an installer that fails fails the install with a line of its own', async t => {
  const { install } = await installer(t, 'exit 3');
  assert.equal(await install.ended, 1);
  assert.equal(install.stdout, '');
  assert.equal(install.stderr.trim(), '安装失败（退出码 3）');
});

test('an installer that ends well but leaves no CLI that starts, or one too old, fails the install with the reason the setup would give', async t => {
  for (const [script, reason] of [
    ['exit 0', '安装后这台机器上没有 Grok CLI'],
    [leaves(null), home => `安装后Grok CLI 无法运行（${join(home, '.grok/bin/grok')}）`],
    [leaves('1.0.51'), '安装后Grok CLI 1.0.51 低于所需的 1.0.52'],
    [leaves('grok'), home => `安装后读不出 Grok CLI 的版本（${join(home, '.grok/bin/grok')}）`],
  ]) {
    const { home, install } = await installer(t, script);
    assert.equal(await install.ended, 1, script);
    assert.equal(install.stdout, '');
    assert.equal(install.stderr.trim(), typeof reason === 'function' ? reason(home) : reason);
  }
});

// What the first-choice path may hold that is no CLI (a leftover that cannot run), with a `grok` on the PATH that is: the record, the
// sign-in and the setup all take the one that runs, and say "not installed" only when there is none.
test('a file that cannot run on the first-choice path does not hide the Grok CLI on the PATH, in the record, the sign-in and the setup', async t => {
  const home = await mkdtemp(join(tmpdir(), 'coda-grok-leftover-')), bin = join(home, 'bin'), noInstaller = join(home, 'no-installer');
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, '.grok/bin'), { recursive: true });
  await mkdir(bin); await mkdir(noInstaller); await mkdir(join(home, 'alone'));
  await writeFile(join(home, '.grok/bin/grok'), '#!/bin/sh\nexit 1\n', { mode: 0o644 });
  // The one that runs says its version (the setup asks), and prints a device login and ends.
  await writeFile(join(bin, 'grok'), `#!/bin/sh
[ "$1" = --version ] && { echo 'grok 1.0.52'; exit 0; }
echo "$@" > "${home}/ran"
printf '\\nhttps://accounts.x.ai/oauth2/device?user_code=ABCD-EF12\\n' >&2
`, { mode: 0o755 });
  // An installer that would be run for a CLI not found is a failure here, not the network.
  await writeFile(join(noInstaller, 'bash'), `#!/bin/sh\n: > "${home}/installer-ran"\nexit 1\n`, { mode: 0o755 });
  // Everything the lookup reads is in the test's own directory: the home, the first-choice path under it, and the PATH.
  const path = await barePath(home, noInstaller, bin), env = { ...pluginEnv('grok', { HOME: home, GROK_HOME: '' }), PATH: path };
  const [record] = await resourceRecords(pluginDir('grok'), { env });
  assert.equal(record.spec.signIn.installed, true);
  const coda = await fakeCoda(home, env), login = operation(t, 'grok', 'scripts/sign-in.mjs', coda.env);
  assert.equal(await login.ended, 0, login.stderr);
  assert.equal((await readFile(join(home, 'ran'), 'utf8')).trim(), 'login --device-auth');
  const setup = await run(manifest('grok').contributes.setup.command, { ...env, CODA_NODE: process.execPath });
  assert.deepEqual([setup.code, setup.stdout.trim()], [0, 'Grok CLI 1.0.52'], setup.stderr);
  assert.equal(existsSync(join(home, 'installer-ran')), false, 'nothing was installed');
  // With none on the PATH, the leftover alone is not an installed CLI.
  const [alone] = await resourceRecords(pluginDir('grok'), { env: { ...env, PATH: await barePath(join(home, 'alone'), noInstaller) } });
  assert.equal(alone.spec.signIn.installed, false);
});
