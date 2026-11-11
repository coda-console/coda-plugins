// Resolve names once for workflows and host-sim. Links are already filtered to this machine by Coda.
import { execFileSync } from 'node:child_process';
import { devices } from './registry.mjs';

const query = (...args) => JSON.parse(execFileSync('coda-resources', args, { encoding: 'utf8' }));
export const aliases = () => JSON.parse(process.env.CODA_PLUGIN_SETTINGS || '{}')['testbed.entities'] ?? [];
export function selectAdbLink(links) {
  return links.find(link => link.protocol === 'adb');
}
export function resolveDevice(id, { list = devices(), entities = aliases(), groupOwner = group => query('group-owner', group), links = uuid => query('links', uuid) } = {}) {
  const alias = entities.find(row => row.name === id);
  if (alias) {
    const group = `entity:${alias.entity}`;
    const owner = groupOwner(group);
    if (!owner) throw new Error(`测试机 ${id} 的本体 ${alias.entity} 不存在`);
    const link = selectAdbLink(links(alias.entity));
    if (!link) throw new Error(`测试机 ${id} 没有本机可达的 adb 链路`);
    return { id, name: id, udid: '', note: owner.attributes?.note ?? '', personal: false, platform: 'android', entity: alias.entity, group, adb: link.endpoint };
  }
  const local = list.find(device => device.id === id);
  const device = local ?? groupOwner(`device:${id}`)?.attributes;
  if (device) return { id, ...device, personal: local ? local.personal === true : device.personal === 'true', platform: 'ios', adb: '', entity: '', group: `device:${id}` };
  throw new Error(`没有这台测试机 ${id}；本地可用：${list.map(device => device.id).join('、') || '无'}`);
}
