// The antigravity plugin's「Antigravity」resource: whether a login is there (the keychain entry, asked without its secret) and
// the quota of each model group from the CLI's own usage report, and the CLI's version (scripts/agy.mjs, quota.mjs, resources.mjs); its login as Coda drives the panel's `signIn` command (Coda's
// check/coda/resources/plugins/resources/panels/sign-in.mjs reads the link and passes the code on).
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readResources } from '../../../check/panel.mjs';
import { authorizationLink } from '../../../check/coda/resources/plugins/resources/panels/sign-in.mjs';
import { signedIn, usageReport } from '../../../plugins/antigravity/scripts/agy.mjs';
import { windows } from '../../../plugins/antigravity/scripts/quota.mjs';
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
// and a keychain that has the login entry or not. `usage`: what `agy -p /usage --output-format json` prints (the real report
// of agy 1.5.9, without an account in it, unless given) and `usageExit` its exit code.
const report = JSON.parse(await readFile(new URL('usage.json', import.meta.url), 'utf8'));
async function machine(t, { version = '1.5.9', login = true, usage = JSON.stringify(report), usageExit = 0 } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'coda-antigravity-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, '.local/bin'), { recursive: true });
  await mkdir(join(home, 'keychain'), { recursive: true });
  await writeFile(join(home, 'usage.json'), usage);
  if (version) await writeFile(join(home, '.local/bin/agy'), `#!/bin/sh
if [ "$1" = --version ]; then echo ${version}; exit 0; fi
echo "$@|$AGY_CLI_DISABLE_AUTO_UPDATE|$(pwd -P)" > "${home}/usage-args"
cat "${home}/usage.json"
exit ${usageExit}
`, { mode: 0o755 });
  await writeFile(join(home, 'keychain', keychain), `#!/bin/sh\nexit ${login ? 0 : process.platform === 'darwin' ? 44 : 1}\n`, { mode: 0o755 });
  return { home, env: pluginEnv('antigravity', { HOME: home, PATH: `${join(home, 'keychain')}:/usr/bin:/bin` }) };
}

test('the type shows nothing without a login, and the quota of each model group and the CLI\'s version with one', async t => {
  const out = await machine(t, { login: false });
  const none = await run(declared.command, out.env);
  assert.equal(none.code, 0, none.stderr);
  assert.deepEqual(JSON.parse(none.stdout), { resources: [] });
  assert.deepEqual(readResources(none.stdout, declared), []);

  const m = await machine(t);
  const result = await run(declared.command, m.env);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(readResources(result.stdout, declared), [{ name: 'Antigravity', actions: [], values: [
    { label: 'Gemini 每周', value: '剩余 98%', fraction: 0.98, time: '2026-11-23T06:16:54.000Z' },
    { label: 'Gemini 5 小时', value: '剩余 97%', fraction: 0.97, time: '2026-11-16T11:16:54.000Z' },
    { label: 'Claude and GPT 每周', value: '剩余 100%', fraction: 1, time: '2026-11-23T08:37:53.000Z' },
    { label: 'Claude and GPT 5 小时', value: '剩余 100%', fraction: 1, time: '2026-11-16T13:37:53.000Z' },
    { label: 'CLI 版本', value: '1.5.9' }] }]);
  // The report is asked for as the CLI's own read-only one, from the temporary directory, with its update off for that run.
  const [args, update, cwd] = (await readFile(join(m.home, 'usage-args'), 'utf8')).trim().split('|');
  assert.equal(args, '-p /usage --output-format json');
  assert.equal(update, 'true');
  assert.equal(cwd, await realpath(tmpdir()));
  assert.equal(JSON.stringify(JSON.parse(result.stdout)).includes('@'), false, 'no account is invented');
});

test('the report gives one value for each bucket that says what is left, as the CLI\'s groups and windows name them', () => {
  const bucket = (window, remaining_fraction, extra = {}) => ({ window, remaining_fraction, reset_time: '2026-11-23T06:16:54Z', ...extra });
  const of = groups => windows({ command: { data: { groups } } });
  assert.deepEqual(windows(report).map(v => [v.label, v.value]), [['Gemini 每周', '剩余 98%'], ['Gemini 5 小时', '剩余 97%'], ['Claude and GPT 每周', '剩余 100%'], ['Claude and GPT 5 小时', '剩余 100%']]);
  // No ratio, one not between 0 and 1 or not a number, and a disabled bucket are left out, not shown as full.
  assert.deepEqual(of([{ name: 'Gemini Models', buckets: [bucket('weekly', undefined), bucket('5h', 1.2), bucket('weekly', -0.1), bucket('5h', '0.5'), bucket('5h', null),
    bucket('weekly', 0.5, { disabled: true }), bucket('5h', 0.5, { disabled: false })] }]).map(v => [v.label, v.value]), [['Gemini 5 小时', '剩余 50%']]);
  // A window not known is shown as it is; a time that cannot be read is not written; a ratio of none left is zero left.
  assert.deepEqual(of([{ name: 'Other', buckets: [bucket('monthly', 0, { reset_time: 'soon' })] }]), [{ label: 'Other monthly', value: '剩余 0%', fraction: 0 }]);
  for (const odd of [null, {}, { command: {} }, { command: { data: { groups: 'x' } } }, { command: { data: { groups: [null, { name: 'A' }, { buckets: [null] }] } } }]) assert.deepEqual(windows(odd), []);
});

test('the usage report is the CLI\'s successful one, and anything else is why there is no quota', () => {
  const ran = over => () => ({ status: 0, stdout: JSON.stringify(report), stderr: '', ...over });
  assert.deepEqual(usageReport('agy', ran()), report);
  assert.throws(() => usageReport('agy', ran({ error: Object.assign(new Error('x'), { code: 'ETIMEDOUT' }), status: null })), /读取超时/);
  assert.throws(() => usageReport('agy', ran({ error: Object.assign(new Error('x'), { code: 'EACCES' }), status: null })), /EACCES/);
  assert.throws(() => usageReport('agy', ran({ status: 1, stderr: 'boom\nmore' })), /退出码 1：boom$/);
  assert.throws(() => usageReport('agy', ran({ status: null, signal: 'SIGKILL' })), /退出码 SIGKILL/);
  assert.throws(() => usageReport('agy', ran({ stdout: 'not json' })), /不是 JSON/);
  assert.throws(() => usageReport('agy', ran({ stdout: JSON.stringify({ ...report, status: 'ERROR' }) })), /（ERROR）/);
  assert.throws(() => usageReport('agy', ran({ stdout: JSON.stringify({ ...report, command: { name: 'help' } }) })), /没有给出额度报告/);
});

test('a quota that cannot be had is said, with the CLI\'s version still shown', async t => {
  for (const [what, options] of [
    ['an exit that failed', { usageExit: 1 }],
    ['a report that is not a success', { usage: JSON.stringify({ ...report, status: 'ERROR' }) }],
    ['a report with no bucket', { usage: JSON.stringify({ ...report, command: { name: 'usage', data: { groups: [] } } }) }],
    ['output that is not a report', { usage: 'hello' }]]) {
    const result = await run(declared.command, (await machine(t, options)).env);
    assert.equal(result.code, 0, `${what}: ${result.stderr}`);
    const [resource] = readResources(result.stdout, declared);
    assert.match(resource.error, /^暂时无法获取额度：/, what);
    assert.deepEqual(resource.values, [{ label: 'CLI 版本', value: '1.5.9' }], what);
  }
});

test('a long reason is cut to a line the reading takes, and the version is still shown', async t => {
  const m = await machine(t, { usageExit: 1 });
  await writeFile(join(m.home, '.local/bin/agy'), `#!/bin/sh
if [ "$1" = --version ]; then echo 1.5.9; exit 0; fi
echo "Error: failed to start the language server: could not find a usable network interface for the session" >&2
exit 1
`, { mode: 0o755 });
  const result = await run(declared.command, m.env);
  assert.equal(result.code, 0, result.stderr);
  const [resource] = readResources(result.stdout, declared);
  assert.equal([...resource.error].length, 80);
  assert.match(resource.error, /^暂时无法获取额度：Antigravity CLI 退出码 1：Error: failed/);
  assert.deepEqual(resource.values, [{ label: 'CLI 版本', value: '1.5.9' }]);
});

test('a login with a CLI that is old or gone is shown with what to do, and a CLI that cannot say its version fails the reading', async t => {
  const old = await run(declared.command, (await machine(t, { version: '1.5.8' })).env);
  assert.equal(old.code, 0, old.stderr);
  assert.match(readResources(old.stdout, declared)[0].error, /低于所需的 1\.5\.9/);
  assert.deepEqual(readResources(old.stdout, declared)[0].values.map(v => v.label), ['CLI 版本'], 'no quota is asked of a CLI too old');
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
