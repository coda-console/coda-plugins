import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const file = process.env.CODA_PLUGIN_STATE && join(process.env.CODA_PLUGIN_STATE, 'devices.json');
export function devices(path = file, { missingIsEmpty = true } = {}) {
  let list;
  try { list = JSON.parse(readFileSync(path, 'utf8')); } catch (error) {
    if (missingIsEmpty && error.code === 'ENOENT') return [];
    throw new Error(`读不了设备登记 ${path}：${error.message}`);
  }
  if (!Array.isArray(list)) throw new Error(`设备登记 ${path} 须为设备数组`);
  for (const device of list) {
    if (!/^[a-z][a-z0-9-]*$/.test(device?.id ?? '') || typeof device?.udid !== 'string' || !device.udid)
      throw new Error(`设备登记 ${path} 须有有效的 id 和非空 udid`);
  }
  // A device is held by the group of its name: one device under two names would be held twice, one name twice either device.
  for (const key of ['id', 'udid']) {
    const values = list.map(d => d?.[key]).filter(Boolean);
    const twice = [...new Set(values.filter((value, i) => values.indexOf(value) !== i))];
    if (twice.length) throw new Error(`设备登记 ${path} 里 ${key} 重复：${twice.join('、')}`);
  }
  return list;
}
