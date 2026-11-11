import { watchFile, unwatchFile } from 'node:fs';
import { join } from 'node:path';
import { devices } from './scripts/registry.mjs';

let stopWatching;
let pending = Promise.resolve();
export async function activate(coda) {
  const file = join(coda.plugin.state, 'devices.json');
  const publish = () => {
    pending = pending.then(async () => {
      const list = devices(file, { missingIsEmpty: false });
      await coda.resources.declareGroups(list.map(device => ({
        name: `device:${device.id}`,
        attributes: { name: device.name ?? device.id, udid: device.udid, note: device.note ?? '', personal: device.personal === true ? 'true' : 'false',
          platform: 'ios' },
        unique: ['udid'],
      })));
    }).catch(error => console.error(`测试机归属声明失败：${error.message}`));
    return pending;
  };
  // Stat-based watching also observes atomic replacements and a deleted/recreated file.
  watchFile(file, { interval: 500 }, publish);
  stopWatching = () => unwatchFile(file, publish);
  await publish();
}

export async function deactivate() {
  stopWatching?.();
  stopWatching = undefined;
  await pending;
}
