// An Android test device over adb's TCP transport (README.md「安卓测试机」): the address in its registration is what every
// machine using it connects to. What a use changed of its settings is put back from what they were when it was lent: the
// three tables `settings list` shows, read before the task (snapshot.mjs) and again when it is handed back (blackscreen.mjs),
// with its screen off as it was lent, so that what the system sets by itself as the screen goes on and off is as it was.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

export const NAMESPACES = ['system', 'secure', 'global'];

// adb with this device as its own; its output, or why it could not say.
export function adb(address, args, { timeout = 20_000, input } = {}) {
  const ran = spawnSync('adb', ['-s', address, ...args], { encoding: 'utf8', timeout, maxBuffer: 16 << 20, input });
  if (ran.error) throw new Error(ran.error.code === 'ENOENT' ? '这台机器没有 adb：先装上 Android SDK Platform Tools' : `adb ${args[0]}：${ran.error.message}`);
  if (ran.status !== 0) throw new Error(`adb ${args.join(' ').slice(0, 80)} 失败：${(ran.stderr || ran.stdout).trim().split('\n').at(-1)}`);
  return ran.stdout;
}

// Connected and lent to this machine's key, or why not: unreachable, or the key not authorized on the device.
export function connect(address) {
  const connected = spawnSync('adb', ['connect', address], { encoding: 'utf8', timeout: 20_000 });
  if (connected.error) throw new Error(connected.error.code === 'ENOENT' ? '这台机器没有 adb：先装上 Android SDK Platform Tools' : `adb connect ${address}：${connected.error.message}`);
  const state = spawnSync('adb', ['-s', address, 'get-state'], { encoding: 'utf8', timeout: 10_000 });
  if (state.stdout?.trim() === 'device') return;
  const said = `${connected.stdout ?? ''}${state.stderr ?? ''}`.trim();
  if (/unauthorized/.test(said))
    throw new Error(`${address} 没有授权这台机器的 adb 公钥：把这台 adb pubkey ~/.android/adbkey 打出的一行追加进设备的 /data/misc/adb/adb_keys（设备已 root 时由能上它的机器写入），不用在手机上点`);
  throw new Error(`连不上 ${address}：${said.split('\n').at(-1) || '没有应答'}`);
}

// `settings list <namespace>` as an object; a line without `=` goes on the value before it.
export function parseList(text) {
  const table = {};
  let last;
  for (const line of text.replace(/\r/g, '').split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) table[last = line.slice(0, at)] = line.slice(at + 1);
    else if (last !== undefined && line) table[last] += `\n${line}`;
  }
  return table;
}

// A shell script run on the device, as root where it can be: a vendor's shell (MIUI's) may not write settings.
export const script = (address, lines) =>
  adb(address, ['shell', 'if command -v su >/dev/null 2>&1; then su -c sh; else sh; fi'], { input: `${lines.join('\n')}\n` });

export const readSettings = address => Object.fromEntries(NAMESPACES.map(name => [name, parseList(adb(address, ['shell', 'settings', 'list', name]))]));

// What puts `now` back to `before`, one change per key: a value changed or gone is put back, one added is deleted (value
// null). A value listed as null is one no one set, so it is deleted rather than written as the text "null".
export function changes(before, now) {
  const list = [];
  for (const name of NAMESPACES) {
    const was = before[name] ?? {}, is = now[name] ?? {};
    for (const key of Object.keys(is)) if (!(key in was) && is[key] !== 'null') list.push({ name, key, value: null });
    for (const [key, value] of Object.entries(was)) {
      if (is[key] === value) continue;
      if (value !== 'null') list.push({ name, key, value });
      else if (key in is) list.push({ name, key, value: null });
    }
  }
  return list;
}
// Of these changes, those `now` does not have yet.
export const notDone = (wanted, now) => wanted.filter(({ name, key, value }) => (now[name]?.[key] ?? null) !== value && !(value === null && now[name]?.[key] === 'null'));

const quote = text => `'${text.replace(/'/g, `'\\''`)}'`;
export const command = ({ name, key, value }) => value === null ? `settings delete ${name} ${quote(key)}` : `settings put ${name} ${quote(key)} ${quote(value)}`;

export const snapshotFile = (state, device) => join(state, 'snapshots', `${device}.json`);
