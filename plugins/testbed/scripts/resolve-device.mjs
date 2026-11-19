// Resolve names once for workflows and host-sim. Links in the group-owner answer are already filtered to this machine by Coda;
// an answer with `reachable: false` is a group this machine cannot reach, held at `location`, reached by `reachedBy`.
import { execFileSync } from 'node:child_process';
import { devices } from './registry.mjs';

const query = (...args) => JSON.parse(execFileSync('coda', ['resources', ...args], { encoding: 'utf8' }));
export function resolveDevice(id, { list = devices(), groupOwner = group => query('group-owner', group) } = {}) {
  const group = `device:${id}`;
  const local = list.find(device => device.id === id);
  if (local) return { id, ...local, personal: local.personal === true, platform: 'ios', adb: '', group };
  const owner = groupOwner(group);
  if (owner) {
    if (owner.reachable === false) {
      const where = `设备在 ${owner.location} 上，到那台上借（可达机器 ID：${owner.reachedBy.join('、')}）`;
      throw new Error(owner.attributes?.platform === 'android' ? `测试机 ${id} 没有本机可达的 adb 链路：${where}` : `测试机 ${id} 本机够不着：${where}`);
    }
    const adb = owner.links?.find(link => link.protocol === 'adb');
    if (adb) return { id, name: id, udid: '', note: owner.attributes?.note ?? '', personal: false, platform: 'android', adb: adb.endpoint, group };
    if (owner.attributes?.platform === 'android') throw new Error(`测试机 ${id} 没有本机可达的 adb 链路`);
    return { id, ...owner.attributes, personal: owner.attributes?.personal === 'true', platform: 'ios', adb: '', group };
  }
  throw new Error(`没有这台测试机 ${id}；本地可用：${list.map(device => device.id).join('、') || '无'}`);
}
