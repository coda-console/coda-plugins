// Local registration is authoritative here; otherwise read the owner's published attributes.
import { execFileSync } from 'node:child_process';
import { devices } from './registry.mjs';

export function resolveDevice(id) {
  const list = devices();
  const local = list.find(device => device.id === id);
  if (local) return { ...local, personal: local.personal === true, platform: local.platform ?? 'ios', adb: local.adb ?? '' };
  const owner = JSON.parse(execFileSync('coda-resources', ['group-owner', `device:${id}`], { encoding: 'utf8' }));
  // An owner on a version before Android devices publishes neither: its devices are iPhones and iPads.
  if (owner) return { id, ...owner.attributes, personal: owner.attributes.personal === 'true', platform: owner.attributes.platform || 'ios', adb: owner.attributes.adb ?? '' };
  throw new Error(`没有这台测试机 ${id}；本地可用：${list.map(device => device.id).join('、') || '无'}`);
}
