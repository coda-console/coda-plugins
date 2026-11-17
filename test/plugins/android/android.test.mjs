import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { device, declarations, links, record, CLEAN_UP, HOME_AND_SLEEP } from '../../../plugins/android/lib/android.mjs';
import { declare } from '../../../plugins/android/main.mjs';
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

test('链路的 key 是 adb，使用机器 ID 名单；空名单不声明', () => {
  const machine = 'f9bf79a1-61c3-40ce-b656-aec1bc7c60b8';
  assert.deepEqual(links({ address: '192.168.1.7', port: '5555', machines: [machine] }), [
    { key: 'adb', protocol: 'adb', endpoint: '192.168.1.7:5555', reach: { scope: 'machines', machines: [machine] } },
  ]);
  assert.deepEqual(links({ machines: [] }), []);
});

async function properties(lines) {
  const values = { 'getprop ro.product.model': 'Mi 10 Pro', 'getprop ro.build.version.release': '13',
    'getprop ro.serialno': 'serial', 'getprop persist.adb.tcp.port': '5555' };
  return values[lines[0]] ?? '192.168.1.7';
}

test('本体默认名称与属性，链路地址读取或覆盖；空名单不读取网络属性', async () => {
  const machine = 'f9bf79a1-61c3-40ce-b656-aec1bc7c60b8';
  const settings = { 'android.machines': [{ id: machine }] };
  const declared = await declarations(settings, properties);
  assert.deepEqual(declared.entities, [{ key: 'device', name: 'Mi 10 Pro', category: 'android', capacity: 1,
    attributes: { model: 'Mi 10 Pro', android: '13', serial: 'serial' } }]);
  assert.deepEqual(declared.links, links({ address: '192.168.1.7', port: '5555', machines: [machine] }));
  const override = await declarations({ ...settings, 'android.name': '手机', 'android.address': 'phone' }, async lines => {
    assert.ok(lines[0].startsWith('getprop '));
    return properties(lines);
  });
  assert.equal(override.entities[0].name, '手机');
  assert.equal(override.links[0].endpoint, 'phone:5555');
  assert.deepEqual((await declarations({}, async lines => {
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
  await assert.rejects(() => declarations({
    'android.address': '', 'android.machines': [{ id: 'f9bf79a1-61c3-40ce-b656-aec1bc7c60b8' }],
  }, async lines => lines[0].startsWith('getprop ') ? properties(lines) : '\n'), /android.address 为空，且 wlan0 没有 IPv4 地址/);
});

test('本体与链路按插件整份替换：先写本体，链路指向宿主给本体的 ID；补上插件，不写 status，借出的状态与别的插件的记录原样留着，旧版不带 key 的记录清掉', async () => {
  const machine = 'f9bf79a1-61c3-40ce-b656-aec1bc7c60b8';
  const { coda, records } = recordsHost('android');
  const declared = await declarations({ 'android.machines': [{ id: machine }] }, properties);
  const foreign = { owner: 'other', kind: 'coda/entity@1', id: 'b1d3f2a0-0000-4000-8000-000000000001', status: { state: 'free' },
    spec: { name: '别的', category: 'x', plugin: 'other', attributes: {}, capacity: 1 } };
  // What 0.1.x left: its own records, under the ID it made, without a key.
  const old = { owner: 'android', kind: 'coda/entity@1', id: 'a50fa7ca-b420-40bd-bbef-39ce25bfd3aa', status: { state: 'free' },
    spec: { name: 'Mi 10 Pro', category: 'android', plugin: 'android', attributes: {}, capacity: 1 } };
  for (const row of [foreign, old]) records.set(`${row.kind}/${row.id}`, row);
  const declareAgain = () => declare(coda, {}, async () => structuredClone(declared));
  await declareAgain();
  const entity = recordId('android', 'coda/entity@1', 'device');
  assert.equal(records.get(`coda/entity@1/${old.id}`), undefined);
  assert.deepEqual(held(records, 'coda/entity@1').find(row => row.owner === 'android'), { owner: 'android', kind: 'coda/entity@1', id: entity, key: 'device', status: {},
    spec: { name: 'Mi 10 Pro', category: 'android', capacity: 1, attributes: { model: 'Mi 10 Pro', android: '13', serial: 'serial' }, plugin: 'android' } });
  assert.deepEqual(held(records, 'coda/link@1').map(({ id, key, spec }) => ({ id, key, spec })), [{ id: recordId('android', 'coda/link@1', 'adb'), key: 'adb',
    spec: { entity, protocol: 'adb', endpoint: '192.168.1.7:5555', reach: { scope: 'machines', machines: [machine] }, plugin: 'android' } }]);
  // Lent out, and declared again at the next start: the state stays, so the return still to do is retried.
  records.get(`coda/entity@1/${entity}`).status = { state: 'returning' };
  await declareAgain();
  assert.deepEqual(records.get(`coda/entity@1/${entity}`).status, { state: 'returning' });
  // The link settings emptied: the link goes, the entity and another plugin's records stay.
  declared.links.length = 0;
  await declareAgain();
  assert.deepEqual(held(records, 'coda/link@1'), []);
  assert.equal(records.get(`coda/entity@1/${foreign.id}`), foreign);
  await assert.rejects(() => coda.replace('coda/entity@1', [{ ...record('android', declared.entities[0]), shared: true }]), { code: 'invalid_input' });
  await assert.rejects(() => coda.replace('coda/entity@1', [{ ...record('android', declared.entities[0]), id: entity }]), { code: 'invalid_input' });
});
