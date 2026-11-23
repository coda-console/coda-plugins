import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, renameSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { activate, deactivate } from '../../../plugins/testbed/main.mjs';
import { TEST_OWNER, createMockCoda } from '../../helpers/mock-coda.mjs';

const GROUP = 'coda/group@1';
const testbedHost = records => createMockCoda({ plugin: { id: 'testbed', protocolImplementations: [GROUP] }, records });
const phone = { id: 'phone', name: 'Phone', udid: 'UDID', note: 'local runner required' };
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'testbed-ownership-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
async function until(check, tries = 300) {
  for (let i = 0; i < tries; i++) {
    if (await check()) return;
    await setTimeout(10);
  }
  assert.fail('file change not observed');
}
// The plugin activated with a count of its publishes. fs.watchFile's first stat is only its baseline and sets nothing off, so a
// change made before that stat is done is lost: the watcher is ready once a change of the file has been seen to publish.
async function activated(coda, state, file) {
  let published = 0;
  await activate({ ...coda, plugin: { ...coda.plugin, state }, replace: (...args) => { published++; return coda.replace(...args); } });
  for (let probe = 1; probe <= 5; probe++) {
    const seen = published, time = new Date(Date.now() + probe * 1000);
    utimesSync(file, time, time);
    try { await until(() => published > seen, 100); return; } catch {}
  }
  assert.fail('devices.json is not watched');
}

test('declarations follow atomic replacements; invalid/missing registration preserves ownership; [] revokes', async t => {
  const state = fixture(t), file = join(state, 'devices.json'), errors = [];
  const original = console.error;
  console.error = message => errors.push(message);
  t.after(async () => { await deactivate(); console.error = original; });
  const host = testbedHost([]), sent = [];
  t.after(() => host.close());
  const coda = { ...host.coda, replace: (kind, items) => { sent.push(structuredClone(items)); return host.coda.replace(kind, items); } };
  const groups = () => host.coda.list(GROUP, { scope: 'local' });
  writeFileSync(file, JSON.stringify([phone]));
  await activated(coda, state, file);
  // The capacity is the plugin's to write, not left to the definition's default.
  assert.equal(sent[0][0].spec.capacity, 1);
  const [declared, ...more] = await groups();
  assert.deepEqual([declared.key, declared.status, more.length], [phone.udid, { state: 'free' }, 0]);
  assert.deepEqual(declared.spec, { name: 'device:phone', capacity: 1, unique: ['udid'], attributes: { name: phone.name, udid: phone.udid, note: phone.note, personal: 'false', platform: 'ios' } });
  writeFileSync(join(state, 'next'), JSON.stringify([{ ...phone, name: 'Changed', personal: true }]));
  renameSync(join(state, 'next'), file);
  await until(async () => (await groups())[0]?.spec.attributes.name === 'Changed');
  assert.equal((await groups())[0].spec.attributes.personal, 'true');
  const before = await groups();
  writeFileSync(file, '{broken');
  await until(() => errors.length > 0);
  assert.deepEqual(await groups(), before);
  const logged = errors.length;
  rmSync(file);
  await until(() => errors.length > logged);
  assert.deepEqual(await groups(), before);
  writeFileSync(file, '[]');
  await until(async () => (await groups()).length === 0);
});

test('the set replaces only this plugin\'s groups; a refused set is logged', async t => {
  const state = fixture(t), file = join(state, 'devices.json'), errors = [];
  const original = console.error;
  console.error = message => errors.push(message);
  t.after(async () => { await deactivate(); console.error = original; });
  // Another plugin's group on this machine (the Android one, of a name of its own), and testbed's own on another machine.
  const group = (spec, more) => ({ kind: GROUP, status: { state: 'free' }, spec: { capacity: 1, attributes: {}, unique: [], ...spec }, ...more });
  const xiaomi = group({ name: 'device:xiaomi' }, { id: 'b1d3f2a0-0000-4000-8000-000000000002', owner: TEST_OWNER, plugin: 'android' });
  const other = group({ name: 'device:other' }, { id: 'b1d3f2a0-0000-4000-8000-000000000001', owner: 'other', plugin: 'testbed' });
  const host = testbedHost([xiaomi, other]), { coda } = host;
  t.after(() => host.close());
  writeFileSync(file, JSON.stringify([phone]));
  await activated(coda, state, file);
  const local = await coda.list(GROUP, { scope: 'local' }), available = await coda.list(GROUP);
  assert.deepEqual(local.map(row => row.plugin).sort(), ['android', 'testbed']);
  assert.deepEqual(available.map(row => row.id).sort(), [other.id, xiaomi.id, local.find(row => row.plugin === 'testbed').id].sort());
  // A key the host refuses (longer than 256): nothing changes, the refusal is logged.
  writeFileSync(file, JSON.stringify([{ ...phone, udid: 'U'.repeat(257) }]));
  await until(() => errors.length > 0);
  assert.match(errors[0], /^测试机归属声明失败：/);
  assert.deepEqual(await coda.list(GROUP), available);
  // A name another plugin's group here has is the one group's: the declaration is refused, the other's stays.
  writeFileSync(file, JSON.stringify([phone, { ...phone, id: 'xiaomi', udid: 'UDID-2' }]));
  await until(() => errors.length > 1);
  assert.match(errors[1], /conflict|本机已有组 device:xiaomi/);
  assert.deepEqual(await coda.list(GROUP), available);
});

test('find resolves remote devices and propagates missing/conflict errors', t => {
  const state = fixture(t), output = join(state, 'output');
  writeFileSync(join(state, 'devices.json'), '[]');
  writeFileSync(join(state, 'coda'), `#!${process.execPath}\nif(process.argv[2] !== 'resources' || process.argv[3] !== 'group-owner' || process.argv[4] !== 'device:phone') process.exit(9);\nif(process.env.CONFLICT) {console.error('conflict owner-a owner-b'); process.exit(1);}\nconsole.log(process.env.OWNER);\n`, { mode: 0o755 });
  const env = { ...process.env, CODA_PLUGIN_STATE: state, PATH: `${state}:${process.env.PATH}`, DEVICE: phone.id,
    GITHUB_OUTPUT: output, OWNER: JSON.stringify({ attributes: phone }), CODA_GROUPS: 'device:phone' };
  const run = (script, args = [], extra = {}) => spawnSync(process.execPath, [resolve('plugins/testbed/scripts', `${script}.mjs`), ...args], { env: { ...env, ...extra }, encoding: 'utf8', cwd: process.cwd() });
  let result = run('device');
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(output, 'utf8'), /udid=UDID/);
  assert.match(readFileSync(output, 'utf8'), /local runner required/);
  assert.match(readFileSync(output, 'utf8'), /personal=false/);
  writeFileSync(output, '');
  result = run('device', [], { OWNER: JSON.stringify({ attributes: { ...phone, personal: 'true' } }) });
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(output, 'utf8'), /personal=true/);
  writeFileSync(output, '');
  result = run('device', [], { OWNER: JSON.stringify({ attributes: { ...phone, personal: 'false' } }) });
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(output, 'utf8'), /personal=false/);
  result = run('device', [], { OWNER: 'null' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /没有这台测试机 phone/);
  result = run('device', [], { CONFLICT: '1' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /conflict owner-a owner-b/);
  writeFileSync(join(state, 'devices.json'), JSON.stringify([phone]));
  result = run('device', [], { CONFLICT: '1' });
  assert.equal(result.status, 0, 'local registration does not query remote ownership');
});
