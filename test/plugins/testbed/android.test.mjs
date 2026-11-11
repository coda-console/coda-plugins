import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveDevice, selectAdbLink } from '../../../plugins/testbed/scripts/resolve-device.mjs';

const entity = '03acc3f8-6a6c-4f65-a90e-48f3af5aa3e5';
const endpoint = '192.168.1.7:5555';
const options = { list: [], entities: [{ name: 'xiaomi', entity }],
  groupOwner: group => { assert.equal(group, `entity:${entity}`); return { attributes: {} }; },
  links: id => { assert.equal(id, entity); return [{ protocol: 'adb', endpoint }]; } };
test('Android alias resolves to the custodian entity and reachable adb endpoint', () => {
  const found = resolveDevice('xiaomi', options);
  assert.deepEqual([found.group, found.platform, found.entity, found.adb], [`entity:${entity}`, 'android', entity, endpoint]);
});
test('iOS registration and remote ownership keep their device group', () => {
  const phone = { id: 'iphone', udid: 'UDID' };
  for (const config of [{ list: [phone] }, { list: [], groupOwner: () => ({ attributes: phone }) }]) {
    const found = resolveDevice('iphone', { entities: [], ...config });
    assert.deepEqual([found.group, found.platform, found.entity], ['device:iphone', 'ios', '']);
  }
});
test('unknown name, missing entity and no reachable adb link fail resolution', () => {
  assert.throws(() => resolveDevice('unknown', { list: [], entities: [], groupOwner: () => null }), /没有这台测试机 unknown/);
  assert.throws(() => resolveDevice('xiaomi', { ...options, groupOwner: () => null }), /本体.*不存在/);
  assert.throws(() => resolveDevice('xiaomi', { ...options, links: () => [{ protocol: 'ssh', endpoint: 'other' }] }), /没有本机可达的 adb 链路/);
});
test('link selection skips other protocols and follows Coda reachable-link order', () => {
  const adb = { protocol: 'adb', endpoint };
  assert.equal(selectAdbLink([{ protocol: 'ssh' }, adb, { protocol: 'adb', endpoint: 'second' }]), adb);
  assert.equal(selectAdbLink([]), undefined);
});
