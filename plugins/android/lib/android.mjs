import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { NAMESPACES, parseList, changes, command, notDone } from './settings.mjs';

// Android's root namespace, with the script on stdin rather than in shell arguments.
export async function nsenter(lines) {
  return new Promise((resolve, reject) => {
    const child = execFile('nsenter', ['-t', '1', '-m', '--', 'sh'], {
      encoding: 'utf8', timeout: 20_000, maxBuffer: 16 << 20,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(typeof error.code === 'number' ? new Error(`nsenter 失败：${(stderr || stdout).trim()}`) : error);
        return;
      }
      resolve(stdout);
    });
    child.stdin.on('error', reject);
    child.stdin.end(`set -e\n${lines.join('\n')}\n`);
  });
}

export const HOME_AND_SLEEP = [
  'input keyevent KEYCODE_HOME',
  'input keyevent KEYCODE_SLEEP',
  'sleep 3',
];
// From testbed/scripts/blackscreen.mjs: do not match the shell running this script.
export const CLEAN_UP = [
  "pkill -f '[f]rida-server' || [ \"$?\" -eq 1 ]",
  "for i in 1 2 3 4 5; do pgrep -f '[f]rida-server' >/dev/null || break; sleep 1; done",
  "if pgrep -f '[f]rida-server' >/dev/null; then echo 'frida-server 停不下来' >&2; exit 1; fi",
  ...HOME_AND_SLEEP,
];

export function device(state, run = nsenter) {
  const file = join(state, 'settings.json');
  const readSettings = async () => {
    const tables = {};
    for (const name of NAMESPACES) tables[name] = parseList(await run([`settings list ${name}`]));
    return tables;
  };
  return {
    async lend() {
      const settings = await readSettings();
      writeFileSync(file, JSON.stringify(settings));
    },
    async return() {
      if (!existsSync(file)) {
        await run(HOME_AND_SLEEP);
        return;
      }
      await run(CLEAN_UP);
      const before = JSON.parse(readFileSync(file, 'utf8'));
      const wanted = changes(before, await readSettings());
      if (wanted.length) {
        await run(wanted.map(command));
        const left = notDone(wanted, await readSettings());
        if (left.length) throw new Error(`有 ${left.length} 项设置没能改回：\n${left.map(command).join('\n')}`);
      }
      unlinkSync(file);
    },
  };
}

// The adb link of the phone, none when no machine is named: it is reached by those machines only.
export function links({ address, port, machines }) {
  if (!machines.length) return [];
  return [{ protocol: 'adb', endpoint: `${address}:${port}`, reach: { scope: 'machines', machines } }];
}

// The group of the phone, named by its device name (`android.name`, by default `ro.product.device`). Those machines that may use
// the adb link are those that may line up for it.
export async function declaration(settings, run = nsenter) {
  const getprop = async key => (await run([`getprop ${key}`])).trim();
  const attributes = { platform: 'android', model: await getprop('ro.product.model'), android: await getprop('ro.build.version.release'), serial: await getprop('ro.serialno') };
  const name = settings['android.name'] || await getprop('ro.product.device');
  const machines = (settings['android.machines'] ?? []).map(row => row.id);
  const spec = { name: `device:${name}`, capacity: 1, lends: true, attributes, unique: ['serial'] };
  if (!machines.length) return spec;
  const address = settings['android.address']?.trim() || (await run(["ip -4 -o addr show dev wlan0 | awk '{print $4}' | cut -d/ -f1"])).trim();
  if (!address) throw new Error('无法声明 adb 链路：android.address 为空，且 wlan0 没有 IPv4 地址');
  return { ...spec, reach: { scope: 'machines', machines }, links: links({ machines, address, port: await getprop('persist.adb.tcp.port') }) };
}
