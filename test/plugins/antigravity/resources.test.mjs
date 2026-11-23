// The antigravity plugin's「Antigravity」resource: whether a login is there (the keychain entry, asked without its secret) and
// the quota of each model group from the CLI's own usage report, and the CLI's version (scripts/agy.mjs, quota.mjs, the record command
// resource.mjs). Its sign-in: sign-in.test.mjs.
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resourceRecords } from '../../helpers/resources.mjs';
import { reading, signedIn, usageReport } from '../../../plugins/antigravity/scripts/agy.mjs';
import { windows } from '../../../plugins/antigravity/scripts/quota.mjs';
import { pluginEnv } from '../command.mjs';
import { pluginDir } from '../plugin.mjs';

// The record of the type, as the host takes it.
const record = async env => (await resourceRecords(pluginDir('antigravity'), { env }))[0];
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
  const none = await record(out.env);
  assert.deepEqual([none.key, none.spec.type, none.spec.title, none.spec.resources], ['account', 'account', 'Antigravity', []]);

  const m = await machine(t);
  const result = await record(m.env);
  assert.deepEqual(result.spec.resources, [{ name: 'Antigravity', buttons: [], values: [
    { label: 'Gemini 每周', value: '剩余 98%', fraction: 0.98, time: '2026-11-23T06:16:54.000Z' },
    { label: 'Gemini 5 小时', value: '剩余 97%', fraction: 0.97, time: '2026-11-16T11:16:54.000Z' },
    { label: 'Claude and GPT 每周', value: '剩余 100%', fraction: 1, time: '2026-11-23T08:37:53.000Z' },
    { label: 'Claude and GPT 5 小时', value: '剩余 100%', fraction: 1, time: '2026-11-16T13:37:53.000Z' },
    { label: 'CLI 版本', value: '1.5.9' }] }]);
  // The sign-in asks for the code, and the CLI is there to sign in with.
  assert.deepEqual(result.spec.signIn, { installed: true, installable: true, input: 'authorizationCode', note: result.spec.signIn.note });
  // The report is asked for as the CLI's own read-only one, from the temporary directory, with its update off for that run.
  const [args, update, cwd] = (await readFile(join(m.home, 'usage-args'), 'utf8')).trim().split('|');
  assert.equal(args, '-p /usage --output-format json');
  assert.equal(update, 'true');
  assert.equal(cwd, await realpath(tmpdir()));
  assert.equal(JSON.stringify(result).includes('@'), false, 'no account is invented');
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
  // The CLI's first line is the reason, with no prefix of its own; its exit code is said only when it said nothing.
  assert.throws(() => usageReport('agy', ran({ status: 1, stderr: 'boom\nmore' })), error => error.message === 'boom');
  assert.throws(() => usageReport('agy', ran({ status: 1, stderr: '  \n' })), error => error.message === '退出码 1');
  assert.throws(() => usageReport('agy', ran({ status: null, signal: 'SIGKILL' })), error => error.message === '退出码 SIGKILL');
  assert.throws(() => usageReport('agy', ran({ stdout: 'not json' })), /不是 JSON/);
  assert.throws(() => usageReport('agy', ran({ stdout: JSON.stringify({ ...report, status: 'ERROR' }) })), /状态不是 SUCCESS（ERROR）/);
  assert.throws(() => usageReport('agy', ran({ stdout: '{}' })), /状态不是 SUCCESS（无状态）/);
  assert.throws(() => usageReport('agy', ran({ stdout: JSON.stringify({ ...report, command: { name: 'help' } }) })), /返回的不是额度报告/);
  // The time it may take is the one it is given.
  let given;
  usageReport('agy', (binary, args, options) => { given = options.timeout; return ran()(); }, 1234);
  assert.equal(given, 1234);
});

test('a quota that cannot be had fails the command with the reason, also after a reading that went well: the record Coda has stays', async t => {
  for (const [what, options] of [
    ['an exit that failed', { usageExit: 1 }],
    ['a report that is not a success', { usage: JSON.stringify({ ...report, status: 'ERROR' }) }],
    ['a report with no bucket', { usage: JSON.stringify({ ...report, command: { name: 'usage', data: { groups: [] } } }) }],
    ['output that is not a report', { usage: 'hello' }]]) {
    const m = await machine(t);
    assert.equal((await record(m.env)).spec.resources[0].values.length, 5);
    await writeFile(join(m.home, 'usage.json'), options.usage ?? JSON.stringify(report));
    if (options.usageExit) await writeFile(join(m.home, '.local/bin/agy'), `#!/bin/sh\nif [ "$1" = --version ]; then echo 1.5.9; exit 0; fi\nexit ${options.usageExit}\n`, { mode: 0o755 });
    await assert.rejects(record(m.env), { message: /^暂时无法获取额度：/ }, what);
  }
});

test('the reason of a CLI that fails is its own first line, whole', async t => {
  const m = await machine(t, { usageExit: 1 });
  await writeFile(join(m.home, '.local/bin/agy'), `#!/bin/sh
if [ "$1" = --version ]; then echo 1.5.9; exit 0; fi
echo "Error: failed to start the language server: could not find a usable network interface for the session" >&2
exit 1
`, { mode: 0o755 });
  await assert.rejects(record(m.env), { message: '暂时无法获取额度：Error: failed to start the language server: could not find a usable network interface for the session' });
});

// The reading has 25 seconds of the 30 Coda gives: the version and the quota are asked what is left of them less a second to
// print, and no quota is asked for when under 3 seconds are left. A clock the fake CLI moves, and nothing waited for.
function readingAt(spent) {
  let clock = 0; const asks = [];
  const io = { now: () => clock,
    ask: (binary, timeout) => { asks.push(['version', timeout]); clock += spent; return { status: 0, stdout: '1.5.9\n' }; },
    report: (binary, run, timeout) => { asks.push(['usage', timeout]); return report; } };
  return { got: reading('agy', 25_000, '1.5.9', io), asks };
}

test('the version and the quota are given what is left of the reading time, and no quota is asked for when too little is left', () => {
  const quick = readingAt(1_000);
  assert.deepEqual(quick.asks, [['version', 24_000], ['usage', 20_000]]);
  assert.deepEqual(quick.got.report, report);
  // 20 seconds went in the version: 4 seconds are left, less the one to print.
  const slow = readingAt(20_000);
  assert.deepEqual(slow.asks, [['version', 24_000], ['usage', 4_000]]);
  assert.equal(slow.got.version, '1.5.9');
  // 22 seconds: 2 are left, which is too little to ask for a report; it is said, and the version still given.
  const late = readingAt(22_000);
  assert.deepEqual(late.asks, [['version', 24_000]]);
  assert.deepEqual(late.got, { version: '1.5.9', failure: '读取超时' });
  // A CLI too old is not asked for a quota, and one that cannot say its version has none.
  assert.deepEqual(reading('agy', 25_000, '1.5.9', { now: () => 0, ask: () => ({ status: 0, stdout: '1.5.8' }) }), { version: '1.5.8', tooOld: true });
  assert.deepEqual(reading('agy', 25_000, '1.5.9', { now: () => 0, ask: () => ({ status: 1 }) }), { version: null });
  // A report that fails is the reason.
  assert.deepEqual(reading('agy', 25_000, '1.5.9', { now: () => 0, ask: () => ({ status: 0, stdout: '1.5.9' }), report: () => { throw new Error('boom'); } }), { version: '1.5.9', failure: 'boom' });
});

test('a report of more groups than a reading lists values is cut to 7, the version still the last, and its words to the limit', async t => {
  const bucket = window => ({ window, remaining_fraction: 0.5, reset_time: '2026-11-23T06:16:54Z' });
  const groups = ['A', 'B', 'C', 'D'].map(name => ({ name: `${name}${'x'.repeat(100)} Models`, buckets: [bucket('weekly'), bucket('5h')] }));
  assert.equal(windows({ command: { data: { groups } } }).length, 8);
  assert.ok(windows({ command: { data: { groups } } }).every(v => [...v.label].length <= 80));
  const m = await machine(t, { usage: JSON.stringify({ ...report, command: { name: 'usage', data: { groups } } }) });
  const [resource] = (await record(m.env)).spec.resources;
  assert.equal(resource.values.length, 8);
  assert.deepEqual(resource.values.slice(0, 7).map(v => v.label.slice(0, 1)), ['A', 'A', 'B', 'B', 'C', 'C', 'D']);
  assert.deepEqual(resource.values[7], { label: 'CLI 版本', value: '1.5.9' });
  assert.equal(resource.error, undefined);
});

test('a login with a CLI that is old or gone is shown with what to do, and the sign-in is still in the record, offering the install', async t => {
  const old = await record((await machine(t, { version: '1.5.8' })).env);
  assert.match(old.spec.resources[0].error, /低于所需的 1\.5\.9/);
  assert.deepEqual(old.spec.resources[0].values.map(v => v.label), ['CLI 版本'], 'no quota is asked of a CLI too old');
  assert.deepEqual([old.spec.signIn.installed, old.spec.signIn.installable], [false, true]);
  const gone = await record((await machine(t, { version: '' })).env);
  assert.deepEqual(gone.spec.resources, [{ name: 'Antigravity', values: [], buttons: [], error: '这台机器上找不到 Antigravity CLI，请在运行机重新安装' }]);
  assert.equal(gone.spec.signIn.installed, false);
});

test('a CLI that cannot say its version fails the command with the reason, also after a reading that went well', async t => {
  const m = await machine(t);
  assert.equal((await record(m.env)).spec.resources[0].values.at(-1).value, '1.5.9');
  await writeFile(join(m.home, '.local/bin/agy'), '#!/bin/sh\necho oops\n', { mode: 0o755 });
  await assert.rejects(record(m.env), { message: /^读不出 Antigravity CLI 的版本（.*\.local\/bin\/agy）$/ });
});

test('the sign-in counts the CLI as installed only when it is new enough', async t => {
  for (const [version, expected] of [['1.5.9', true], ['1.6.0', true], ['1.5.8', false], ['', false]])
    assert.equal((await record((await machine(t, { version })).env)).spec.signIn.installed, expected, version);
  // Also without a login, where the quota is not read: the CLI is asked its version alone.
  for (const [version, expected] of [['1.5.9', true], ['1.5.8', false], ['', false]])
    assert.equal((await record((await machine(t, { version, login: false })).env)).spec.signIn.installed, expected, `${version} without a login`);
});

test('a keychain that cannot be asked fails the command with the reason, also after a reading that went well: it is not a sign-out', async t => {
  const m = await machine(t);
  assert.equal((await record(m.env)).spec.resources[0].values.length, 5);
  await writeFile(join(m.home, 'keychain', keychain), `#!/bin/sh\necho 'boom: no keychain' >&2\nexit ${process.platform === 'darwin' ? 36 : 2}\n`, { mode: 0o755 });
  await assert.rejects(record(m.env), { message: /^读不了 ?(钥匙串|Secret Service)：/ });
});
