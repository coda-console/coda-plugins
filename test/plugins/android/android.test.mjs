import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { device, declaration, links, CLEAN_UP, HOME_AND_SLEEP } from '../../../plugins/android/lib/android.mjs';
import { activate, deactivate, declare } from '../../../plugins/android/main.mjs';
import { recordsHost, recordId, held } from '../records.mjs';
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

test('组记录按插件整份替换，不写 status：借出的状态与别的插件的记录原样留着', async () => {
  const machine = 'f9bf79a1-61c3-40ce-b656-aec1bc7c60b8';
  const { coda, records } = recordsHost('android');
  const spec = await declaration({ 'android.machines': [{ id: machine }] }, properties);
  const foreign = { owner: 'other', kind: 'coda/group@1', id: 'b1d3f2a0-0000-4000-8000-000000000001', status: {}, spec: { name: 'device:other', attributes: {}, unique: [] } };
  records.set(`${foreign.kind}/${foreign.id}`, foreign);
  const declareAgain = () => declare(coda, {}, async () => structuredClone(spec));
  await declareAgain();
  const id = recordId('android', 'coda/group@1', 'device');
  assert.deepEqual(held(records, 'coda/group@1').find(row => row.owner === 'android'), { owner: 'android', kind: 'coda/group@1', id, key: 'device', status: {}, spec });
  // Lent out, and given again at the next start: the state stays, so the return still to do is retried.
  records.get(`coda/group@1/${id}`).status = { state: 'returning', holder: { owner: 'o', location: 'l', runId: 'r' } };
  await declareAgain();
  assert.equal(records.get(`coda/group@1/${id}`).status.state, 'returning');
  // The link settings emptied: the group comes without a link, and another plugin's record stays.
  delete spec.links; delete spec.reach;
  await declareAgain();
  assert.equal(records.get(`coda/group@1/${id}`).spec.links, undefined);
  assert.equal(records.get(`coda/group@1/${foreign.id}`), foreign);
  await assert.rejects(() => coda.replace('coda/group@1', [{ key: 'device', spec, shared: true }]), { code: 'invalid_input' });
  await assert.rejects(() => coda.replace('coda/group@1', [{ key: 'device', spec, status: { state: 'free' } }]), /refused/);
  await assert.rejects(() => coda.replace('coda/group@1', [{ key: 'device', spec: { ...spec, name: 'device:two words' } }]), /refused/);
  await assert.rejects(() => coda.replace('coda/group@1', [{ key: 'device', spec: { ...spec, capacity: 2 } }]), /refused/);
});

test('activate：先登记 lend、return，再写记录；借还照原样做并答 {}；停用后撤掉', async t => {
  const dir = state(t), machine = 'f9bf79a1-61c3-40ce-b656-aec1bc7c60b8';
  const { coda, records } = recordsHost('android');
  const calls = [], handled = new Map(), disposed = [], fake = { settings: structuredClone(before) };
  const run = async lines => {
    if (lines[0].startsWith('settings list ')) return Object.entries(fake.settings[lines[0].split(' ').at(-1)]).map(([k, v]) => `${k}=${v}`).join('\n');
    if (lines[0].startsWith('settings ')) { fake.settings = structuredClone(before); return ''; }
    calls.push(lines);
    return lines[0].startsWith('getprop ') || lines[0].startsWith('ip ') ? properties(lines) : '';
  };
  await activate({ ...coda, plugin: { ...coda.plugin, state: dir },
    settings: { get: async () => ({ 'android.machines': [{ id: machine }] }) },
    handle: (kind, op, handler) => { assert.equal(records.size, 0, 'registered before declaring'); handled.set(`${kind}:${op}`, handler); return { dispose: () => disposed.push(op) }; } }, run);
  assert.deepEqual([...handled.keys()], ['coda/group@1:lend', 'coda/group@1:return']);
  assert.equal(held(records, 'coda/group@1')[0].spec.name, 'device:xiaomi');
  const holder = { owner: 'o', location: 'l', runId: 'r' };
  assert.deepEqual(await handled.get('coda/group@1:lend')({ holder }, {}), {});
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'settings.json'))), before);
  fake.settings = structuredClone(changed);
  assert.deepEqual(await handled.get('coda/group@1:return')({ holder }, {}), {});
  assert.deepEqual(fake.settings, before);
  assert.equal(existsSync(join(dir, 'settings.json')), false);
  assert.ok(calls.some(lines => lines === CLEAN_UP));
  deactivate();
  assert.deepEqual(disposed, ['lend', 'return']);
});
