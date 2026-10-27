// The test devices plugged into this Mac, as this plugin registers them (README.md): `devices.json`
// in its state (CODA_PLUGIN_STATE, <data>/plugins/testbed/), so each backend environment of the Mac has its own. An array of
// { id, name, udid, note }; no file, no device.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const file = join(process.env.CODA_PLUGIN_STATE, 'devices.json');
export function devices() {
  let list;
  try { list = JSON.parse(readFileSync(file, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new Error(`读不了设备登记 ${file}：${error.message}`);
  }
  if (!Array.isArray(list)) throw new Error(`设备登记 ${file} 须为设备数组`);
  // A device is held by the group of its name: one device under two names would be held twice, one name twice either device.
  for (const key of ['id', 'udid']) {
    const values = list.map(d => d?.[key]).filter(Boolean);
    const twice = [...new Set(values.filter((value, i) => values.indexOf(value) !== i))];
    if (twice.length) throw new Error(`设备登记 ${file} 里 ${key} 重复：${twice.join('、')}`);
  }
  return list;
}
