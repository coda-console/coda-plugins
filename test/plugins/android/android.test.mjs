import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { device, declaration, links, CLEAN_UP, HOME_AND_SLEEP } from '../../../plugins/android/lib/android.mjs';
import { activate, deactivate, declare } from '../../../plugins/android/main.mjs';
import { TEST_OWNER, createTestHost } from '../../../check/coda/adapters/plugin-test-host.mjs';
import { NAMESPACES, changes, command, notDone, parseList } from '../../../plugins/android/lib/settings.mjs';

function state(t) {
  const dir = mkdtempSync(join(tmpdir(), 'android-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const before = { system: { sample: 'before' }, secure: { default_input_method: 'org.quietboard/.Board' }, global: {} };
const changed = { system: { sample: 'after', added: 'value' }, secure: { default_input_method: 'other' }, global: {} };
const reads = NAMESPACES.map(name => [`settings list ${name}`]);

function fixture(t) {
  const dir = state(t), calls = [];
  const fake = { settings: structuredClone(before), fail: null, stuck: false };
  const phone = device(dir, async lines => {
    calls.push(lines);
    if (fake.fail?.(lines)) throw new Error('执行失败');
    if (lines[0].startsWith('settings list ')) {
      const table = fake.settings[lines[0].split(' ').at(-1)];
      return Object.entries(table).map(([k, v]) => `${k}=${v}`).join('\n');
    }
    if (lines[0].startsWith('settings put ') || lines[0].startsWith('settings delete ')) {
      assert.deepEqual(lines, changes(before, changed).map(command));
      if (!fake.stuck) fake.settings = structuredClone(before);
    }
    return '';
  });
  return { dir, calls, fake, phone, file: join(dir, 'settings.json') };
}

test('借出记三张表；归还先清理，再比较、写变化项、核对并删除快照', async t => {
  const { phone, calls, fake, file } = fixture(t);
  await phone.lend();
  assert.deepEqual(JSON.parse(readFileSync(file)), before);
  assert.deepEqual(calls, reads);
  fake.settings = structuredClone(changed);
  await phone.return();
  assert.deepEqual(calls, [...reads, CLEAN_UP, ...reads, changes(before, changed).map(command), ...reads]);
  assert.equal(existsSync(file), false);
});

test('借出读取失败向外抛错，不留下不完整快照', async t => {
  const { phone, fake, file } = fixture(t);
  fake.fail = lines => lines[0] === reads[1][0];
  await assert.rejects(() => phone.lend(), /执行失败/);
  assert.equal(existsSync(file), false);
});

test('清理失败时不读写设置，保留快照供核心重试', async t => {
  const { phone, calls, fake, file } = fixture(t);
  await phone.lend();
  calls.length = 0;
  fake.fail = lines => lines === CLEAN_UP;
  await assert.rejects(() => phone.return(), /执行失败/);
  assert.deepEqual(calls, [CLEAN_UP]);
  assert.deepEqual(JSON.parse(readFileSync(file)), before);
});

test('恢复命令失败时抛错并保留快照', async t => {
  const { phone, fake, file } = fixture(t);
  await phone.lend();
  fake.settings = structuredClone(changed);
  fake.fail = lines => lines[0].startsWith('settings delete ');
  await assert.rejects(() => phone.return(), /执行失败/);
  assert.equal(existsSync(file), true);
});

test('有项没有改回时抛错并保留快照', async t => {
  const { phone, fake, file } = fixture(t);
  await phone.lend();
  fake.settings = structuredClone(changed);
  fake.stuck = true;
  await assert.rejects(() => phone.return(), /设置没能改回/);
  assert.equal(existsSync(file), true);
});

test('无变化不写设置、不多核对；无快照只回桌面和熄屏', async t => {
  const { phone, calls, file } = fixture(t);
  await phone.return();
  assert.deepEqual(calls, [HOME_AND_SLEEP]);
  calls.length = 0;
  await phone.lend();
  await phone.return();
  assert.deepEqual(calls, [...reads, CLEAN_UP, ...reads]);
  assert.equal(existsSync(file), false);
});

test('链路是 adb，使用机器 ID 名单；空名单不声明', () => {
  const machine = 'f9bf79a1-61c3-40ce-b656-aec1bc7c60b8';
  assert.deepEqual(links({ address: '192.168.1.7', port: '5555', machines: [machine] }), [
    { protocol: 'adb', endpoint: '192.168.1.7:5555', reach: { scope: 'machines', machines: [machine] } },
  ]);
  assert.deepEqual(links({ machines: [] }), []);
});

async function properties(lines) {
  const values = { 'getprop ro.product.device': 'xiaomi', 'getprop ro.product.model': 'Mi 10 Pro', 'getprop ro.build.version.release': '13',
    'getprop ro.serialno': 'serial', 'getprop persist.adb.tcp.port': '5555' };
  return values[lines[0]] ?? '192.168.1.7';
}

test('组名默认取 ro.product.device，属性、容量、借还与链路范围如记录所写；空名单不读取网络属性', async () => {
  const machine = 'f9bf79a1-61c3-40ce-b656-aec1bc7c60b8';
  const settings = { 'android.machines': [{ id: machine }] };
  const reach = { scope: 'machines', machines: [machine] };
  assert.deepEqual(await declaration(settings, properties), { name: 'device:xiaomi', capacity: 1, lends: true, unique: ['serial'],
    attributes: { platform: 'android', model: 'Mi 10 Pro', android: '13', serial: 'serial' }, reach,
    links: [{ protocol: 'adb', endpoint: '192.168.1.7:5555', reach }] });
  const override = await declaration({ ...settings, 'android.name': 'phone', 'android.address': 'wifi' }, async lines => {
    assert.ok(lines[0].startsWith('getprop '));
    return properties(lines);
  });
  assert.equal(override.name, 'device:phone');
  assert.equal(override.links[0].endpoint, 'wifi:5555');
  const none = await declaration({}, async lines => {
    assert.ok(lines[0].startsWith('getprop '));
    return properties(lines);
  });
  assert.deepEqual(none, { name: 'device:xiaomi', capacity: 1, lends: true, unique: ['serial'], attributes: { platform: 'android', model: 'Mi 10 Pro', android: '13', serial: 'serial' } });
});

test('复制的解析、比较、核对和引号逻辑保留多行、null、删除及特殊字符', () => {
  assert.deepEqual(parseList("a=it's\nnext\nb=x=y\r\n"), { a: "it's\nnext", b: 'x=y' });
  const wanted = changes({ secure: { missing: 'old', unset: 'null' } }, { secure: { added: 'new', unset: 'yes' } });
  assert.deepEqual(wanted, [{ name: 'secure', key: 'added', value: null },
    { name: 'secure', key: 'missing', value: 'old' }, { name: 'secure', key: 'unset', value: null }]);
  assert.deepEqual(notDone(wanted, { secure: { missing: 'old', unset: 'null' } }), []);
  assert.deepEqual(notDone(wanted, { secure: { missing: 'wrong' } }), [wanted[1]]);
  assert.equal(command({ name: 'secure', key: "k'", value: "it's\n$(anything)" }), "settings put secure 'k'\\''' 'it'\\''s\n$(anything)'");
});
test('地址设置为空且 wlan0 没有 IPv4 时拒绝声明链路', async () => {
  await assert.rejects(() => declaration({
    'android.address': '', 'android.machines': [{ id: 'f9bf79a1-61c3-40ce-b656-aec1bc7c60b8' }],
  }, async lines => lines[0].startsWith('getprop ') ? properties(lines) : '\n'), /android.address 为空，且 wlan0 没有 IPv4 地址/);
});

const GROUP = 'coda/group@1';
const phoneHost = records => createTestHost({ plugin: { id: 'android', protocolImplementations: [GROUP] }, records });

test('组记录按插件整份替换，不写 status：状态归 Coda，别的插件的记录原样留着，重名冲突被拒', async t => {
  const machine = 'f9bf79a1-61c3-40ce-b656-aec1bc7c60b8';
  const spec = await declaration({ 'android.machines': [{ id: machine }] }, properties);
  const foreign = { kind: GROUP, id: 'b1d3f2a0-0000-4000-8000-000000000001', owner: TEST_OWNER, plugin: 'other', status: { state: 'free' },
    spec: { name: 'device:other', capacity: 1, attributes: {}, unique: [] } };
  const host = phoneHost([foreign]), { coda } = host;
  t.after(() => host.close());
  const declareAgain = () => declare(coda, {}, async () => structuredClone(spec));
  const mine = async () => (await coda.list(GROUP, { scope: 'local' })).filter(row => row.plugin === 'android');
  await declareAgain();
  const [entry, ...more] = await mine();
  assert.deepEqual([entry.key, entry.spec, entry.status, more.length], ['device', spec, { state: 'free' }, 0]);
  const version = entry.version;
  await declareAgain();
  assert.equal((await mine())[0].version, version, 'declared again as it was: not written again');
  // The link settings emptied: the group comes without a link, and another plugin's record stays.
  delete spec.links; delete spec.reach;
  await declareAgain();
  assert.equal((await mine())[0].spec.links, undefined);
  assert.deepEqual((await coda.get({ kind: GROUP, id: foreign.id })).spec, foreign.spec);
  await assert.rejects(() => coda.replace(GROUP, [{ key: 'device', spec, shared: true }]), { code: 'invalid_input' });
  await assert.rejects(() => coda.replace(GROUP, [{ key: 'device', spec, status: { state: 'free' } }]), { code: 'invalid_input' });
  await assert.rejects(() => coda.replace(GROUP, [{ key: 'device', spec: { ...spec, name: 'device:two words' } }]), { code: 'invalid_input' });
  await assert.rejects(() => coda.replace(GROUP, [{ key: 'device', spec: { ...spec, capacity: 2 } }]), { code: 'invalid_input' });
  await assert.rejects(() => coda.replace(GROUP, [{ key: 'device', spec: { ...spec, name: foreign.spec.name } }]), { code: 'conflict' });
});

test('activate：先登记 lend、return，再写记录；借还照原样做并答 {}；停用后撤掉', async t => {
  const dir = state(t), machine = 'f9bf79a1-61c3-40ce-b656-aec1bc7c60b8';
  const host = createTestHost({ plugin: { id: 'android', protocolImplementations: [GROUP] }, settings: { 'android.machines': [{ id: machine }] } });
  const { coda } = host, order = [];
  t.after(() => host.close());
  const calls = [], fake = { settings: structuredClone(before) };
  const run = async lines => {
    if (lines[0].startsWith('settings list ')) return Object.entries(fake.settings[lines[0].split(' ').at(-1)]).map(([k, v]) => `${k}=${v}`).join('\n');
    if (lines[0].startsWith('settings ')) { fake.settings = structuredClone(before); return ''; }
    calls.push(lines);
    return lines[0].startsWith('getprop ') || lines[0].startsWith('ip ') ? properties(lines) : '';
  };
  const record = { kind: GROUP, id: null };
  await activate({ ...coda, plugin: { ...coda.plugin, state: dir }, 
    handle: (...args) => { order.push(`handle ${args[1]}`); return coda.handle(...args); },
    replace: (...args) => { order.push('replace'); return coda.replace(...args); } }, run);
  assert.deepEqual(order, ['handle lend', 'handle return', 'replace']);
  const [group] = await coda.list(GROUP, { scope: 'local' });
  assert.equal(group.spec.name, 'device:xiaomi');
  record.id = group.id;
  const holder = { owner: 'o', location: 'l', runId: 'r' };
  assert.deepEqual(await host.call(record, 'lend', { holder }), {});
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'settings.json'))), before);
  fake.settings = structuredClone(changed);
  assert.deepEqual(await host.call(record, 'return', { holder }), {});
  assert.deepEqual(fake.settings, before);
  assert.equal(existsSync(join(dir, 'settings.json')), false);
  assert.ok(calls.some(lines => lines === CLEAN_UP));
  deactivate();
  await assert.rejects(() => host.call(record, 'lend', { holder }), { code: 'not_found' });
});

test('改 android.name、android.machines 后用新值重发：记录 ID 不变，旧名随全集替换消失；停用后不再重发', async t => {
  const dir = state(t), machine = 'f9bf79a1-61c3-40ce-b656-aec1bc7c60b8';
  const host = createTestHost({ plugin: { id: 'android', protocolImplementations: [GROUP] }, settings: {} });
  t.after(() => host.close());
  const rows = () => host.coda.list(GROUP, { scope: 'local' });
  // The listeners of `onChange` are not waited for by the host: the rows are read again until they show the change.
  const after = async (change, ready) => {
    await host.setSettings(change);
    for (let tries = 0; tries < 100; tries++) {
      const found = await rows();
      if (ready(found[0].spec)) return found;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return rows();
  };
  await activate({ ...host.coda, plugin: { ...host.coda.plugin, state: dir } }, properties);
  let [first, ...more] = await rows();
  assert.deepEqual([first.spec.name, first.spec.reach, more.length], ['device:xiaomi', undefined, 0]);
  let [row, ...rest] = await after({ 'android.name': 'phone' }, spec => spec.name === 'device:phone');
  assert.deepEqual([row.id, row.spec.name, rest.length], [first.id, 'device:phone', 0]);
  const reach = { scope: 'machines', machines: [machine] };
  [row, ...rest] = await after({ 'android.name': 'phone', 'android.machines': [{ id: machine }] }, spec => spec.reach);
  assert.deepEqual([row.id, row.spec.name, row.spec.reach, row.spec.links, rest.length],
    [first.id, 'device:phone', reach, [{ protocol: 'adb', endpoint: '192.168.1.7:5555', reach }], 0]);
  [row, ...rest] = await after({ 'android.name': 'phone' }, spec => !spec.reach);
  assert.deepEqual([row.id, row.spec.reach, row.spec.links, rest.length], [first.id, undefined, undefined, 0]);
  deactivate();
  [row] = await after({ 'android.name': 'later' }, spec => spec.name === 'device:later');
  assert.equal(row.spec.name, 'device:phone');
});

test('设置连着变两次：第一次的 wlan0 查询挂住，第二次先保存，放行后记录仍是第二次的组名与名单', async t => {
  const dir = state(t), machine = 'f9bf79a1-61c3-40ce-b656-aec1bc7c60b8';
  const host = createTestHost({ plugin: { id: 'android', protocolImplementations: [GROUP] }, settings: {} });
  t.after(() => host.close());
  let release, asked;
  const hung = new Promise(resolve => { release = resolve; });
  const reached = new Promise(resolve => { asked = resolve; });
  const run = async lines => {
    if (!lines[0].startsWith('ip ')) return properties(lines);
    asked();
    await hung;
    return '192.168.1.7';
  };
  await activate({ ...host.coda, plugin: { ...host.coda.plugin, state: dir } }, run);
  await host.setSettings({ 'android.name': 'one', 'android.machines': [{ id: machine }] });
  await reached;
  await host.setSettings({ 'android.name': 'two' });
  // Time for the second to publish first, were it not made to wait.
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  await wait(100);
  release();
  await wait(100);
  const [row, ...rest] = await host.coda.list(GROUP, { scope: 'local' });
  assert.deepEqual([row.spec.name, row.spec.reach, row.spec.links, rest.length], ['device:two', undefined, undefined, 0]);
  deactivate();
});
