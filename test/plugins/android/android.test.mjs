import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { entityId, device, declarations, links, CLEAN_UP, HOME_AND_SLEEP } from '../../../plugins/android/lib/android.mjs';
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

test('UUID 生成一次，重读及新实例沿用磁盘上的 ID', t => {
  const dir = state(t);
  let generated = 0;
  const id = entityId(dir, () => { generated++; return 'a50fa7ca-b420-40bd-bbef-39ce25bfd3aa'; });
  assert.equal(entityId(dir, () => { throw new Error('不应再生成'); }), id);
  assert.equal(entityId(dir), id);
  assert.equal(generated, 1);
});

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

test('链路使用机器 ID 名单；空名单不声明', () => {
  const machine = 'f9bf79a1-61c3-40ce-b656-aec1bc7c60b8';
  assert.deepEqual(links('entity', { address: '192.168.1.7', port: '5555', machines: [machine] }), [
    { id: 'adb', entity: 'entity', protocol: 'adb', endpoint: '192.168.1.7:5555', reach: { scope: 'machines', machines: [machine] } },
  ]);
  assert.deepEqual(links('entity', { machines: [] }), []);
});

async function properties(lines) {
  const values = { 'getprop ro.product.model': 'Mi 10 Pro', 'getprop ro.build.version.release': '13',
    'getprop ro.serialno': 'serial', 'getprop persist.adb.tcp.port': '5555' };
  return values[lines[0]] ?? '192.168.1.7';
}

test('本体默认名称与属性，链路地址读取或覆盖；空名单不读取网络属性', async () => {
  const machine = 'f9bf79a1-61c3-40ce-b656-aec1bc7c60b8';
  const settings = { 'android.machines': [{ id: machine }] };
  const declared = await declarations('entity', settings, properties);
  assert.deepEqual(declared.entities, [{ id: 'entity', name: 'Mi 10 Pro', category: 'android', capacity: 1,
    attributes: { model: 'Mi 10 Pro', android: '13', serial: 'serial' } }]);
  assert.deepEqual(declared.links, links('entity', { address: '192.168.1.7', port: '5555', machines: [machine] }));
  const override = await declarations('entity', { ...settings, 'android.name': '手机', 'android.address': 'phone' }, async lines => {
    assert.ok(lines[0].startsWith('getprop '));
    return properties(lines);
  });
  assert.equal(override.entities[0].name, '手机');
  assert.equal(override.links[0].endpoint, 'phone:5555');
  assert.deepEqual((await declarations('entity', {}, async lines => {
    assert.ok(['getprop ro.product.model', 'getprop ro.build.version.release', 'getprop ro.serialno'].includes(lines[0]));
    return properties(lines);
  })).links, []);
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
  await assert.rejects(() => declarations('entity', {
    'android.address': '', 'android.machines': [{ id: 'f9bf79a1-61c3-40ce-b656-aec1bc7c60b8' }],
  }, async lines => lines[0].startsWith('getprop ') ? properties(lines) : '\n'), /android.address 为空，且 wlan0 没有 IPv4 地址/);
});
