import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveDevice } from '../../../plugins/testbed/scripts/resolve-device.mjs';
import { createTestHost } from '../../../check/coda/adapters/plugin-test-host.mjs';

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

// The group-owner answer of Coda as it now is, made of the group records the test host holds: none with the name, one this machine
// holds or reaches, or one it does not (`reachedBy`: machine IDs), each with its holder's machine name as `location`.
const group = (name, platform, owner = 'machine-b') => ({ kind: 'coda/group@1', id: `id-${name}`, owner, location: owner === 'machine-b' ? 'xiaomi' : owner,
  spec: { name: `device:${name}`, capacity: 1, attributes: { platform } } });
async function ownerOf(records, reachable) {
  const host = createTestHost({ plugin: { id: 'testbed', protocolImplementations: ['coda/group@1'] }, records });
  const entries = await host.coda.list('coda/group@1', { scope: 'available' });
  await host.close();
  return name => {
    const entry = entries.find(({ spec }) => spec.name === name);
    if (!entry) return null;
    const answer = { id: entry.id, name, plugin: entry.plugin, owner: entry.owner, location: entry.location, attributes: entry.spec.attributes, links: [], reachable };
    return reachable ? answer : { ...answer, reachedBy: ['machine-b', 'machine-c'] };
  };
}
test('group-owner finds no record: no such device, naming the local ones', async () => {
  const none = await ownerOf([group('other', 'android')], false);
  assert.throws(() => resolveDevice('xiaomi', { list: [{ id: 'iphone' }], groupOwner: none }), /^Error: 没有这台测试机 xiaomi；本地可用：iphone$/);
  assert.throws(() => resolveDevice('xiaomi', { list: [], groupOwner: none }), /^Error: 没有这台测试机 xiaomi；本地可用：无$/);
});
test('group-owner finds a record this machine does not reach: where it is and which machines reach it, per platform', async () => {
  const android = await ownerOf([group('xiaomi', 'android')], false), ios = await ownerOf([group('iphone', 'ios')], false);
  assert.throws(() => resolveDevice('xiaomi', { list: [], groupOwner: android }), /^Error: 测试机 xiaomi 没有本机可达的 adb 链路：设备在 xiaomi 上，到那台上借（可达机器 ID：machine-b、machine-c）$/);
  assert.throws(() => resolveDevice('iphone', { list: [], groupOwner: ios }), /^Error: 测试机 iphone 本机够不着：设备在 xiaomi 上，到那台上借（可达机器 ID：machine-b、machine-c）$/);
});
test('group-owner finds a record this machine reaches: borrowed as before', async () => {
  const answer = (await ownerOf([group('xiaomi', 'android')], true))('device:xiaomi');
  assert.equal('reachedBy' in answer, false);
  const found = resolveDevice('xiaomi', { list: [], groupOwner: () => ({ ...answer, links: [adb] }) });
  assert.deepEqual([found.platform, found.adb, found.group], ['android', endpoint, 'device:xiaomi']);
});
