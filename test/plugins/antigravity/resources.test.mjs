// The antigravity plugin's「Antigravity」resource: whether a login is there (the keychain entry, asked without its secret) and
// the CLI's version (scripts/agy.mjs, resources.mjs); its login as Coda drives the panel's `signIn` command (Coda's
// check/coda/resources/plugins/resources/panels/sign-in.mjs reads the link and passes the code on).
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readResources } from '../../../check/panel.mjs';
import { authorizationLink } from '../../../check/coda/resources/plugins/resources/panels/sign-in.mjs';
import { signedIn } from '../../../plugins/antigravity/scripts/agy.mjs';
import { declaredPanel, installed, pluginEnv, run, signIn } from '../command.mjs';

const declared = declaredPanel('antigravity');
const keychain = process.platform === 'darwin' ? 'security' : 'secret-tool';

test('a login is the keychain entry being there; a keychain that cannot be asked is not a sign-out', () => {
  const asked = [];
  const answer = status => (command, args, options) => { asked.push([command, args, options.stdio]); return { status, stderr: 'SecKeychainSearchCopyNext: boom\nmore' }; };
  assert.equal(signedIn('darwin', answer(0)), true);
  assert.equal(signedIn('darwin', answer(44)), false);
  assert.throws(() => signedIn('darwin', answer(36)), /读不了钥匙串：SecKeychainSearchCopyNext: boom/);
  assert.equal(signedIn('linux', answer(0)), true);
  // `secret-tool lookup` exits 1 for no entry, saying nothing, and also for a query that failed, saying why.
  assert.equal(signedIn('linux', () => ({ status: 1, stderr: '' })), false);
  assert.throws(() => signedIn('linux', () => ({ status: 1, stderr: 'secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY\n' })), /读不了 Secret Service：secret-tool: Cannot autolaunch D-Bus/);
  assert.throws(() => signedIn('linux', () => ({ status: 2, stderr: '' })), /读不了 Secret Service：2/);
  // No `secret-tool` is not signed in; one that cannot answer (killed, timed out, failing to start) is no answer.
  assert.equal(signedIn('linux', () => ({ status: null, error: Object.assign(new Error('spawn secret-tool ENOENT'), { code: 'ENOENT' }) })), false);
  assert.throws(() => signedIn('linux', () => ({ status: null, signal: 'SIGKILL' })), /读不了 Secret Service：SIGKILL/);
  assert.throws(() => signedIn('linux', () => ({ status: null, error: Object.assign(new Error('spawn secret-tool EACCES'), { code: 'EACCES' }) })), /读不了 Secret Service：EACCES/);
  // A timeout as spawnSync reports it, from a real process that outlasts it.
  assert.throws(() => signedIn('linux', (command, args, options) => spawnSync('sleep', ['5'], { ...options, timeout: 100 })), /读不了 Secret Service：ETIMEDOUT/);
  assert.equal(signedIn('win32', answer(0)), false);
  // The entry alone is asked for: no `-w` or `-g` (which print the secret), and the output goes nowhere.
  assert.deepEqual(asked[0], ['security', ['find-generic-password', '-s', 'gemini', '-a', 'antigravity'], ['ignore', 'ignore', 'pipe']]);
  assert.deepEqual(asked.find(a => a[0] === 'secret-tool'), ['secret-tool', ['lookup', 'service', 'gemini', 'username', 'antigravity'], ['ignore', 'ignore', 'pipe']]);
});

// A machine's home with an Antigravity CLI where its installer puts it (`version`: what `--version` prints; none for no CLI),
// and a keychain that has the login entry or not.
async function machine(t, { version = '1.5.9', login = true } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'coda-antigravity-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, '.local/bin'), { recursive: true });
  await mkdir(join(home, 'keychain'), { recursive: true });
  if (version) await writeFile(join(home, '.local/bin/agy'), `#!/bin/sh\n[ "$1" = --version ] && echo ${version}\n`, { mode: 0o755 });
  await writeFile(join(home, 'keychain', keychain), `#!/bin/sh\nexit ${login ? 0 : process.platform === 'darwin' ? 44 : 1}\n`, { mode: 0o755 });
  return { home, env: pluginEnv('antigravity', { HOME: home, PATH: `${join(home, 'keychain')}:/usr/bin:/bin` }) };
}

test('the type shows nothing without a login, and the CLI\'s version with one', async t => {
  const out = await machine(t, { login: false });
  const none = await run(declared.command, out.env);
  assert.equal(none.code, 0, none.stderr);
  assert.deepEqual(JSON.parse(none.stdout), { resources: [] });
  assert.deepEqual(readResources(none.stdout, declared), []);

  const m = await machine(t);
  const result = await run(declared.command, m.env);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(readResources(result.stdout, declared), [{ name: 'Antigravity', values: [{ label: 'CLI 版本', value: '1.5.9' }], actions: [] }]);
  assert.equal(JSON.stringify(JSON.parse(result.stdout)).includes('@'), false, 'no account is invented');
});

test('a login with a CLI that is old or gone is shown with what to do, and a CLI that cannot say its version fails the reading', async t => {
  const old = await run(declared.command, (await machine(t, { version: '1.5.8' })).env);
  assert.equal(old.code, 0, old.stderr);
  assert.match(readResources(old.stdout, declared)[0].error, /低于所需的 1\.5\.9/);
  const gone = await run(declared.command, (await machine(t, { version: '' })).env);
  assert.equal(gone.code, 0, gone.stderr);
  assert.match(readResources(gone.stdout, declared)[0].error, /找不到 Antigravity CLI/);
  const mute = await run(declared.command, (await machine(t, { version: 'oops' })).env);
  assert.equal(mute.code, 1);
  assert.match(mute.stderr, /读不出 Antigravity CLI 的版本/);
});

// What `agy acp --login` prints with no terminal, with made-up state and challenge.
const prompt = `Open this link in a browser to log in with Google:

  https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=1.apps.googleusercontent.com&code_challenge=FAKE-challenge&code_challenge_method=S256&redirect_uri=https%3A%2F%2Fexample.com%2Fcallback&response_type=code&scope=openid+email&state=FAKE-state

Then paste the authorization code, or the full URL of the page you land on, and press Enter:
`;

test('the login link is read as Coda reads it, asks for the code, and the code reaches the CLI', async t => {
  assert.deepEqual(declared.signIn.input, 'authorizationCode');
  const link = authorizationLink(prompt);
  assert.equal(link.input, 'authorizationCode');
  assert.equal(new URL(link.url).origin + new URL(link.url).pathname, 'https://accounts.google.com/o/oauth2/auth');
  assert.equal(new URL(link.url).searchParams.get('state'), 'FAKE-state');
  assert.equal(authorizationLink(prompt.slice(0, 60)), null, 'a line cut short is not read');

  const m = await machine(t);
  await writeFile(join(m.home, '.local/bin/agy'), `#!/bin/sh
echo "$@|$BROWSER|$NO_COLOR" > "${m.home}/args"
cat <<'EOT'
${prompt}EOT
read code
echo "$code" > "${m.home}/code"
echo "Logged in as me@example.com."
`, { mode: 0o755 });
  const login = signIn(t, declared.signIn.command, m.env);
  await login.printed(/press Enter:/);
  assert.deepEqual(authorizationLink(login.output), link);
  login.write('4/0AFAKE-code\n');
  assert.equal(await login.ended, 0);
  assert.equal((await readFile(join(m.home, 'args'), 'utf8')).trim(), 'acp --login|/usr/bin/true|1');
  assert.equal((await readFile(join(m.home, 'code'), 'utf8')).trim(), '4/0AFAKE-code');
});

test('the login counts as installed only with a CLI new enough, and its install is the setup', async t => {
  for (const [version, expected] of [['1.5.9', true], ['1.6.0', true], ['1.5.8', false], ['', false]])
    assert.equal(installed(declared.signIn.installed, (await machine(t, { version })).env), expected, version);
  assert.equal(declared.signIn.install, 'exec "$CODA_NODE" "$CODA_PLUGIN_PATH/scripts/setup.mjs"');
});
