// Android test devices of the 测试机 plugin (plugins/testbed/README.md「安卓测试机」): registered with an adb address,
// connected before they are waited for, their settings noted once lent and put back before they are handed on, and adb in
// a borrowed command talking to them. adb here is a stand-in that keeps the device's settings in a file and does to them
// what the shell commands it is given say.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pluginEnv, run } from '../command.mjs';
import { changes, command, notDone, parseList } from '../../../plugins/testbed/scripts/android.mjs';

const address = '192.168.1.7:5555';
const phone = { id: 'xiaomi', name: 'Mi 10 Pro', udid: '3c8a506b', platform: 'android', adb: address, note: '微信桥在上面：不要 force-stop 微信。' };
const lent = {
  system: { screen_off_timeout: '120000' },
  secure: { default_input_method: 'org.quietboard/.Board', show_ime_with_hard_keyboard: '1', said: "it's" },
  global: { adb_enabled: '1' },
};

function temporary(t) {
  const path = mkdtempSync(join(tmpdir(), 'testbed-android-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

// adb standing in for the device at `address`: its settings in settings.json, what it was asked in calls.log, one per line
// (a script given on standard input as its lines). A script that writes no settings runs in sh, with the device's own
// commands standing in: input exits FAKE_INPUT_STATUS, frida-server is running for pgrep while FAKE_FRIDA_STUCK says so,
// sleep does not wait. The screen turned off, the system sets what it sets by itself then.
const ADB = `#!${process.execPath}
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const dir = process.env.FAKE_ADB, args = process.argv.slice(2), file = dir + '/settings.json';
appendFileSync(dir + '/calls.log', JSON.stringify(args) + '\\n');
const unauthorized = !!process.env.FAKE_ADB_UNAUTHORIZED;
if (args[0] === 'connect') { console.log(unauthorized ? 'failed to authenticate to ' + args[1] : 'connected to ' + args[1]); process.exit(0); }
if (args[0] !== '-s' || args[1] !== '${address}') { console.error('no device ' + args[1]); process.exit(1); }
const [what, ...rest] = args.slice(2);
if (what === 'get-state') { if (unauthorized) { console.error('error: device unauthorized.'); process.exit(1); } console.log('device'); process.exit(0); }
if (what === 'install') process.exit(0);
const settings = JSON.parse(readFileSync(file, 'utf8'));
if (rest[0] === 'settings' && rest[1] === 'list') {
  for (const [key, value] of Object.entries(settings[rest[2]])) console.log(key + '=' + value);
  process.exit(0);
}
// A script on standard input: the settings put and delete in it applied, but for a namespace the device keeps as it is.
const lines = readFileSync(0, 'utf8').trim().split('\\n');
appendFileSync(dir + '/calls.log', JSON.stringify(['script', ...lines]) + '\\n');
if (!lines.some(line => line.startsWith('settings '))) {
  const ran = spawnSync('/bin/sh', [], { input: lines.join('\\n'), encoding: 'utf8', env: { ...process.env, PATH: dir + '/bin:' + process.env.PATH } });
  process.stderr.write(ran.stderr);
  if (ran.status === 0 && lines.includes('input keyevent KEYCODE_SLEEP || exit 1')) {
    Object.assign(settings.secure, JSON.parse(process.env.FAKE_ADB_ASLEEP || '{}'));
    writeFileSync(file, JSON.stringify(settings));
  }
  process.exit(ran.status);
}
for (const part of lines) {
  const words = [];
  for (const [, quoted, bare] of part.matchAll(/'((?:[^']|'\\\\'')*)'|(\\S+)/g)) words.push(quoted !== undefined ? quoted.replace(/'\\\\''/g, "'") : bare);
  if (words[0] !== 'settings' || words[2] === process.env.FAKE_ADB_STUCK) continue;
  if (words[1] === 'put') settings[words[2]] ??= {}, settings[words[2]][words[3]] = words[4];
  if (words[1] === 'delete') delete settings[words[2]][words[3]];
}
writeFileSync(file, JSON.stringify(settings));
`;
function device(t, settings = lent) {
  const dir = temporary(t);
  writeFileSync(join(dir, 'adb'), ADB, { mode: 0o755 });
  mkdirSync(join(dir, 'bin'));
  for (const [name, body] of Object.entries({ input: 'exit "${FAKE_INPUT_STATUS:-0}"', pkill: 'exit 0', sleep: 'exit 0',
    pgrep: '[ -n "$FAKE_FRIDA_STUCK" ]' })) writeFileSync(join(dir, 'bin', name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings));
  writeFileSync(join(dir, 'calls.log'), '');
  return {
    dir,
    get settings() { return JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')); },
    set settings(value) { writeFileSync(join(dir, 'settings.json'), JSON.stringify(value)); },
    get calls() { return readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); },
  };
}
function registered(t, devices = [phone]) {
  const state = temporary(t);
  writeFileSync(join(state, 'devices.json'), JSON.stringify(devices));
  return state;
}
// A step's script with the stand-in adb first on the PATH; its outputs in GITHUB_OUTPUT.
async function step(t, name, phoneDevice, extra) {
  const output = join(temporary(t), 'output');
  writeFileSync(output, '');
  const env = pluginEnv('testbed', { CODA_NODE: process.execPath, GITHUB_OUTPUT: output, FAKE_ADB: phoneDevice.dir, ...extra });
  env.PATH = `${phoneDevice.dir}:${env.PATH}`;
  for (const name of ['HOST_SIM_LEASE', 'CODA_GROUPS', 'CODA_THREAD_ID', 'ANDROID_SERIAL']) if (!(name in extra)) delete env[name];
  const ended = await run(`node "$CODA_PLUGIN_PATH/scripts/${name}.mjs"`, env);
  return { ...ended, outputs: readFileSync(output, 'utf8') };
}

test('settings are read as listed; what puts them back changes what changed, deletes what was added and keeps what was unset unset', () => {
  assert.deepEqual(parseList('a=1\nb=x=y\nc=\nd=one\ntwo\n'), { a: '1', b: 'x=y', c: '', d: 'one\ntwo' });
  const now = {
    system: { screen_off_timeout: '600000' },
    secure: { default_input_method: 'com.tencent.wetype/.plugin.hld.WxHldService', said: "it's", added: 'yes', unset: 'set' },
    global: {},
  };
  const before = { ...lent, secure: { ...lent.secure, unset: 'null' } };
  const wanted = changes(before, now);
  assert.deepEqual(wanted.map(command), [
    "settings put system 'screen_off_timeout' '120000'",
    "settings delete secure 'added'",
    "settings put secure 'default_input_method' 'org.quietboard/.Board'",
    "settings put secure 'show_ime_with_hard_keyboard' '1'",
    "settings delete secure 'unset'",
    "settings put global 'adb_enabled' '1'",
  ]);
  assert.deepEqual(changes(lent, lent), []);
  // A key listed as null that is still unlisted, or still null, needs nothing; a value with a quote survives the shell.
  assert.deepEqual(changes({ secure: { gone: 'null' } }, { secure: { added: 'null' } }), []);
  assert.deepEqual(changes({ secure: { said: "it's" } }, { secure: {} }).map(command), [`settings put secure 'said' 'it'\\''s'`]);
  // What is left of them is only what was wanted and is not so yet: a key deleted reads as unlisted or null.
  assert.deepEqual(notDone(wanted, before), []);
  assert.deepEqual(notDone(wanted, { ...before, secure: { ...before.secure, added: 'null' }, global: { adb_enabled: '0' } }).map(command),
    ["settings put global 'adb_enabled' '1'"]);
});

test('an Android device is registered with its adb address; without one, or with a platform not known, the registration is refused', async t => {
  const phoneDevice = device(t);
  const found = await step(t, 'device', phoneDevice, { CODA_PLUGIN_STATE: registered(t), DEVICE: phone.id });
  assert.equal(found.code, 0, found.stderr);
  assert.equal(found.outputs, `name=${phone.name}\nudid=${phone.udid}\npersonal=false\nplatform=android\nadb=${address}\nnote<<CODA_NOTE\n${phone.note}\nCODA_NOTE\n`);
  // Connected here, before waiting for it.
  assert.deepEqual(phoneDevice.calls.slice(0, 2), [['connect', address], ['-s', address, 'get-state']]);
  for (const [entry, said] of [[{ ...phone, adb: undefined }, /安卓设备 xiaomi 须有 adb 地址/], [{ ...phone, adb: '192.168.1.7' }, /须有 adb 地址/],
    [{ ...phone, platform: 'harmony' }, /platform 须为 ios 或 android/]]) {
    const refused = await step(t, 'device', phoneDevice, { CODA_PLUGIN_STATE: registered(t, [entry]), DEVICE: phone.id });
    assert.equal(refused.code, 1); assert.match(refused.stderr, said);
  }
});

test('an Android device whose key this machine has not authorized fails to be found, saying how, and is not waited for', async t => {
  const found = await step(t, 'device', device(t), { CODA_PLUGIN_STATE: registered(t), DEVICE: phone.id, FAKE_ADB_UNAUTHORIZED: '1' });
  assert.equal(found.code, 1);
  assert.match(found.stderr, /192\.168\.1\.7:5555 没有授权这台机器的 adb 公钥：.*adb pubkey .*\/data\/misc\/adb\/adb_keys/);
  assert.equal(found.outputs, '');
});

test('lent, an Android device\'s settings are noted; handed back, what the task changed is put back, frida-server stopped, the screen off', async t => {
  // Lent with its screen off, as the one before handed it back: what the system sets then is in what is noted.
  const asleep = { applock_mask_notify: '1' }, idle = { ...lent, secure: { ...lent.secure, ...asleep } };
  const phoneDevice = device(t, idle), state = registered(t), snapshot = join(state, 'snapshots', `${phone.id}.json`);
  const env = { CODA_PLUGIN_STATE: state, DEVICE: phone.id, PLATFORM: 'android', ADB: address };
  const noted = await step(t, 'snapshot', phoneDevice, env);
  assert.equal(noted.code, 0, noted.stderr);
  assert.deepEqual(JSON.parse(readFileSync(snapshot, 'utf8')), { address, settings: idle });
  // The task switches the input method, turns the hardware keyboard setting off and adds one of its own; with the screen on,
  // the system has set one of its own too, which it sets back as the screen goes off.
  phoneDevice.settings = { ...lent, secure: { default_input_method: 'com.tencent.wetype/.plugin.hld.WxHldService', show_ime_with_hard_keyboard: '0', said: "it's", mine: 'x', applock_mask_notify: '0' } };
  const back = await step(t, 'blackscreen', phoneDevice, { ...env, FAKE_ADB_ASLEEP: JSON.stringify(asleep) });
  assert.equal(back.code, 0, back.stderr);
  assert.deepEqual(phoneDevice.settings, idle);
  // The screen off first, as root; then what the task changed, and nothing the system set by itself.
  const scripts = phoneDevice.calls.filter(call => call[0] === 'script').map(call => call.slice(1));
  assert.equal(scripts.length, 2);
  assert.ok(scripts[0].includes('input keyevent KEYCODE_SLEEP || exit 1'));
  assert.deepEqual(scripts[1], ["settings delete secure 'mine'", "settings put secure 'default_input_method' 'org.quietboard/.Board'", "settings put secure 'show_ime_with_hard_keyboard' '1'"]);
  assert.ok(phoneDevice.calls.some(call => call[3]?.startsWith('if command -v su')));
  assert.match(back.stdout, /改回 3 项设置/);
  assert.equal(existsSync(snapshot), false, 'the snapshot goes once put back');
  // Handed back before it was noted (cancelled while it waited): only the home screen and the screen off.
  const unnoted = await step(t, 'blackscreen', phoneDevice, env);
  assert.equal(unnoted.code, 0, unnoted.stderr); assert.match(unnoted.stdout, /没有借出时记下的设置/);
});

test('a setting the device will not take back fails the handing back, naming it, and the snapshot stays for a retry', async t => {
  const phoneDevice = device(t), state = registered(t), env = { CODA_PLUGIN_STATE: state, DEVICE: phone.id, PLATFORM: 'android', ADB: address };
  assert.equal((await step(t, 'snapshot', phoneDevice, env)).code, 0);
  phoneDevice.settings = { ...lent, global: { adb_enabled: '0' } };
  const back = await step(t, 'blackscreen', phoneDevice, { ...env, FAKE_ADB_STUCK: 'global' });
  assert.equal(back.code, 1);
  assert.match(back.stderr, /有 1 项设置没能改回：\nsettings put global 'adb_enabled' '1'/);
  assert.equal(existsSync(join(state, 'snapshots', `${phone.id}.json`)), true);
  // The device's own line in the setting is run instead, its address in ADB and ANDROID_SERIAL.
  const own = await step(t, 'blackscreen', phoneDevice, { ...env, COMMANDS: JSON.stringify({ [phone.id]: 'echo "$ADB $ANDROID_SERIAL"' }) });
  assert.deepEqual([own.code, own.stdout.split('\n')[1]], [0, `${address} ${address}`]);
});

test('frida-server that will not stop, or the screen that will not go off, fails the handing back before anything is put back', async t => {
  for (const [failing, said] of [[{ FAKE_FRIDA_STUCK: '1' }, /frida-server 停不下来/], [{ FAKE_INPUT_STATUS: '1' }, /失败/]]) {
    const phoneDevice = device(t), state = registered(t), env = { CODA_PLUGIN_STATE: state, DEVICE: phone.id, PLATFORM: 'android', ADB: address };
    assert.equal((await step(t, 'snapshot', phoneDevice, env)).code, 0);
    const changed = { ...lent, global: { adb_enabled: '0' } };
    phoneDevice.settings = changed;
    const back = await step(t, 'blackscreen', phoneDevice, { ...env, ...failing });
    assert.equal(back.code, 1); assert.match(back.stderr, said);
    // Not handed on as if it were put back: nothing written, the snapshot kept for a retry.
    assert.deepEqual(phoneDevice.settings, changed);
    assert.equal(existsSync(join(state, 'snapshots', `${phone.id}.json`)), true);
  }
});

test('an iPhone or iPad has nothing noted', async t => {
  const phoneDevice = device(t), state = registered(t);
  const noted = await step(t, 'snapshot', phoneDevice, { CODA_PLUGIN_STATE: state, DEVICE: 'iphone-testbed', PLATFORM: 'ios', ADB: '' });
  assert.equal(noted.code, 0);
  assert.deepEqual([existsSync(join(state, 'snapshots')), phoneDevice.calls], [false, []]);
});

test('a command whose device cannot be found now is not run, rather than run on whatever device its environment names', async t => {
  const at = temporary(t), spec = join(at, 'spec.json'), tools = temporary(t);
  writeFileSync(join(tools, 'coda-resources'), '#!/bin/sh\necho "本机的网络组件没有应答" >&2\nexit 1\n', { mode: 0o755 });
  writeFileSync(spec, JSON.stringify({ argv: ['sh', '-c', 'touch ran'], cwd: at, env: { PATH: process.env.PATH, ANDROID_SERIAL: 'other' }, kind: phone.id }));
  const ran = await step(t, 'run-on-device', device(t), { CODA_PLUGIN_STATE: registered(t, []), SPEC: spec, PATH: `${tools}:${process.env.PATH}` });
  assert.deepEqual([ran.code, ran.outputs], [0, 'exit_code=1\n']);
  assert.match(ran.stderr, /找不到测试机 xiaomi，不执行：[\s\S]*没有应答/);
  assert.equal(existsSync(join(at, 'ran')), false);
});

test('a command borrowing an Android device has its adb address as ANDROID_SERIAL', async t => {
  const at = temporary(t), spec = join(at, 'spec.json');
  writeFileSync(spec, JSON.stringify({ argv: ['sh', '-c', 'echo "serial=$ANDROID_SERIAL"'], cwd: at, env: { PATH: process.env.PATH, ANDROID_SERIAL: 'other' }, kind: phone.id }));
  const ran = await step(t, 'run-on-device', device(t), { CODA_PLUGIN_STATE: registered(t), SPEC: spec });
  assert.deepEqual([ran.code, ran.stdout, ran.outputs], [0, `serial=${address}\n`, 'exit_code=0\n']);
});
