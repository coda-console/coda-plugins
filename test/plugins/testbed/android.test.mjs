import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveDevice } from '../../../plugins/testbed/scripts/resolve-device.mjs';

const endpoint = '192.168.1.7:5555';
const adb = { protocol: 'adb', endpoint, reach: { scope: 'machines', machines: ['mac'] } };
const asked = [];
const owner = value => group => { asked.push(group); return value; };

test('a device registered here is iOS and is not asked about', () => {
  const found = resolveDevice('iphone', { list: [{ id: 'iphone', udid: 'UDID', personal: true }], groupOwner: () => assert.fail('asked') });
  assert.deepEqual([found.group, found.platform, found.personal, found.udid, found.adb], ['device:iphone', 'ios', true, 'UDID', '']);
});
test('a group with an adb link this machine reaches is Android, at the first adb endpoint', () => {
  const found = resolveDevice('xiaomi', { list: [], groupOwner: owner({ attributes: { platform: 'android', model: 'Mi 10 Pro' },
    links: [{ protocol: 'ssh', endpoint: 'other' }, adb, { protocol: 'adb', endpoint: 'second' }] }) });
  assert.deepEqual(asked, ['device:xiaomi']);
  assert.deepEqual([found.id, found.group, found.platform, found.adb, found.personal, found.udid], ['xiaomi', 'device:xiaomi', 'android', endpoint, false, '']);
});
test('a group of another instance without an adb link is an iOS device, its attributes read as registered', () => {
  const found = resolveDevice('iphone', { list: [], groupOwner: owner({ attributes: { name: 'iPhone', udid: 'UDID', note: 'n', personal: 'true', platform: 'ios' }, links: [] }) });
  assert.deepEqual([found.group, found.platform, found.name, found.udid, found.note, found.personal, found.adb], ['device:iphone', 'ios', 'iPhone', 'UDID', 'n', true, '']);
});
test('an Android group this machine reaches no adb link of, and a name nobody has, fail with the reason', () => {
  const android = { attributes: { platform: 'android' }, links: [] };
  assert.throws(() => resolveDevice('xiaomi', { list: [], groupOwner: () => android }), /测试机 xiaomi 没有本机可达的 adb 链路/);
  assert.throws(() => resolveDevice('xiaomi', { list: [], groupOwner: () => ({ ...android, links: [{ protocol: 'ssh', endpoint: 'other' }] }) }), /没有本机可达的 adb 链路/);
  assert.throws(() => resolveDevice('unknown', { list: [{ id: 'iphone' }], groupOwner: () => null }), /没有这台测试机 unknown；本地可用：iphone/);
  assert.throws(() => resolveDevice('unknown', { list: [], groupOwner: () => null }), /本地可用：无/);
});
