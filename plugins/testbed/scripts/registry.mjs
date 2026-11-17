// Devices belong to the instance whose plugin state contains their devices.json registration.
// The plugin publishes ownership declarations to the space; callers missing a local id query group-owner.
// An unreadable registration must not revoke existing declarations; only a valid empty array does.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// An entry without `platform` is an iPhone or iPad, as every entry was before Android devices.
export const PLATFORMS = ['ios'];
export const file = process.env.CODA_PLUGIN_STATE && join(process.env.CODA_PLUGIN_STATE, 'devices.json');
export function devices(path = file, { missingIsEmpty = true } = {}) {
  let list;
  try { list = JSON.parse(readFileSync(path, 'utf8')); } catch (error) {
    if (missingIsEmpty && error.code === 'ENOENT') return [];
    throw new Error(`读不了设备登记 ${path}：${error.message}`);
  }
  if (!Array.isArray(list)) throw new Error(`设备登记 ${path} 须为设备数组`);
  for (const device of list) {
    if (typeof device?.udid !== 'string' || !device.udid)
      throw new Error(`设备登记 ${path} 须有非空 udid`);
    if (!PLATFORMS.includes(device.platform ?? 'ios'))
      throw new Error(`设备登记 ${path} 里 ${device.id} 的 platform 须为 ${PLATFORMS.join(' 或 ')}`);
  }
  // A device is held by the group of its name: one device under two names would be held twice, one name twice either device.
  for (const key of ['id', 'udid']) {
    const values = list.map(d => d?.[key]).filter(Boolean);
    const twice = [...new Set(values.filter((value, i) => values.indexOf(value) !== i))];
    if (twice.length) throw new Error(`设备登记 ${path} 里 ${key} 重复：${twice.join('、')}`);
  }
  return list;
}

// The ID of a device's group record, derived from its udid so it stays the same across restarts and reinstalls: SHA-256 of
// this plugin's namespace and the key, its first 16 bytes with the version set to 5 and the variant to 10xx.
const NAMESPACE = '@coda-console/testbed:';
export function derivedId(key) {
  const b = createHash('sha256').update(NAMESPACE + key).digest().subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50; b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
