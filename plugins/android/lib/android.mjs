import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { NAMESPACES, parseList, changes, command, notDone } from './settings.mjs';

// Android's root namespace, with the script on stdin rather than in shell arguments.
export function nsenter(lines) {
  const ran = spawnSync('nsenter', ['-t', '1', '-m', '--', 'sh'], {
    input: `set -e\n${lines.join('\n')}\n`, encoding: 'utf8', timeout: 20_000, maxBuffer: 16 << 20,
  });
  if (ran.error) throw ran.error;
  if (ran.status !== 0) throw new Error(`nsenter 失败：${(ran.stderr || ran.stdout).trim()}`);
  return ran.stdout;
}

export function entityId(state, generate = randomUUID) {
  mkdirSync(state, { recursive: true });
  const file = join(state, 'entity-id');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const id = generate();
  writeFileSync(file, id);
  return id;
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
  const readSettings = () => Object.fromEntries(NAMESPACES.map(name => [name, parseList(run([`settings list ${name}`]))]));
  return {
    lend() {
      const settings = readSettings();
      writeFileSync(file, JSON.stringify(settings));
    },
    return() {
      if (!existsSync(file)) {
        run(HOME_AND_SLEEP);
        return;
      }
      run(CLEAN_UP);
      const before = JSON.parse(readFileSync(file, 'utf8'));
      const wanted = changes(before, readSettings());
      if (wanted.length) {
        run(wanted.map(command));
        const left = notDone(wanted, readSettings());
        if (left.length) throw new Error(`有 ${left.length} 项设置没能改回：\n${left.map(command).join('\n')}`);
      }
      unlinkSync(file);
    },
  };
}

export function links(id, { address, port, machines }) {
  if (!machines.length) return [];
  return [{ id: 'adb', entity: id, protocol: 'adb', endpoint: `${address}:${port}`, reach: { scope: 'machines', machines } }];
}

export function declarations(id, settings, run = nsenter) {
  const getprop = key => run([`getprop ${key}`]).trim();
  const model = getprop('ro.product.model');
  const entities = [{ id, name: settings['android.name'] || model, category: 'android',
    attributes: { model, android: getprop('ro.build.version.release'), serial: getprop('ro.serialno') }, capacity: 1 }];
  const machines = (settings['android.machines'] ?? []).map(row => row.id);
  const connections = machines.length ? links(id, {
    machines,
    address: settings['android.address'] || run(["ip -4 -o addr show dev wlan0 | awk '{print $4}' | cut -d/ -f1"]).trim(),
    port: getprop('persist.adb.tcp.port'),
  }) : [];
  return { entities, links: connections };
}
