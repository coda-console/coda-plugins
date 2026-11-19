import { watchFile, unwatchFile } from 'node:fs';
import { join } from 'node:path';
import { devices } from './scripts/registry.mjs';

let stopWatching;
export async function activate(coda) {
  const file = join(coda.plugin.state, 'devices.json');
  // The whole set each time: the host takes it in order and drops the groups of this plugin that are not in it.
  const publish = async () => {
    try {
      await coda.replace('coda/group@1', devices(file, { missingIsEmpty: false }).map(device => ({
        key: device.udid,
        spec: { name: `device:${device.id}`, capacity: 1, unique: ['udid'],
          attributes: { name: device.name ?? device.id, udid: device.udid, note: device.note ?? '', personal: device.personal === true ? 'true' : 'false',
            platform: 'ios' } },
      })));
    } catch (error) { console.error(`测试机归属声明失败：${error.message}`); }
  };
  // Stat-based watching also observes atomic replacements and a deleted/recreated file.
  watchFile(file, { interval: 500 }, publish);
  stopWatching = () => unwatchFile(file, publish);
  await publish();
}

export function deactivate() {
  stopWatching?.();
  stopWatching = undefined;
}
