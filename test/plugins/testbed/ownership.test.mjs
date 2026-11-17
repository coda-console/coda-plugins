import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, renameSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { activate, deactivate } from '../../../plugins/testbed/main.mjs';
import { recordsHost, recordId, held } from '../records.mjs';

const phone = { id: 'phone', name: 'Phone', udid: 'UDID', note: 'local runner required' };
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'testbed-ownership-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
async function until(check, tries = 300) {
  for (let i = 0; i < tries; i++) {
    if (check()) return;
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
  const { coda, records } = recordsHost('testbed');
  const groups = () => held(records, 'coda/group@1');
  writeFileSync(file, JSON.stringify([phone]));
  await activated(coda, state, file);
  assert.deepEqual(groups(), [{ owner: 'testbed', kind: 'coda/group@1', id: recordId('testbed', 'coda/group@1', phone.udid), key: phone.udid, status: {},
    spec: { name: 'device:phone', plugin: 'testbed', unique: ['udid'], attributes: { name: phone.name, udid: phone.udid, note: phone.note, personal: 'false', platform: 'ios' } } }]);
  writeFileSync(join(state, 'next'), JSON.stringify([{ ...phone, name: 'Changed', personal: true }]));
  renameSync(join(state, 'next'), file);
  await until(() => groups()[0]?.spec.attributes.name === 'Changed');
  assert.equal(groups()[0].spec.attributes.personal, 'true');
  const before = structuredClone(groups());
  writeFileSync(file, '{broken');
  await until(() => errors.length > 0);
  assert.deepEqual(groups(), before);
  const logged = errors.length;
  rmSync(file);
  await until(() => errors.length > logged);
  assert.deepEqual(groups(), before);
  writeFileSync(file, '[]');
  await until(() => groups().length === 0);
});

test('the set replaces only this plugin\'s groups, those an earlier version left without a key among them; a refused set is logged', async t => {
  const state = fixture(t), file = join(state, 'devices.json'), errors = [];
  const original = console.error;
  console.error = message => errors.push(message);
  t.after(async () => { await deactivate(); console.error = original; });
  const { coda, records } = recordsHost('testbed');
  const other = { owner: 'other', kind: 'coda/group@1', id: recordId('other', 'coda/group@1', phone.udid), key: phone.udid, status: {}, spec: { name: 'device:other', plugin: 'other', attributes: {}, unique: [] } };
  const entity = { owner: 'coda', kind: 'coda/group@1', id: '03acc3f8-6a6c-4f65-a90e-48f3af5aa3e5', status: {}, spec: { name: 'entity:03acc3f8-6a6c-4f65-a90e-48f3af5aa3e5', plugin: 'android', attributes: {}, unique: [] } };
  // What 1.x left: its own record, under the ID it made, without a key.
  const old = { owner: 'testbed', kind: 'coda/group@1', id: '5e0b7c1d-2f4a-4b68-9d3e-a1c7f0e28b46', status: {}, spec: { name: 'device:gone', plugin: 'testbed', attributes: {}, unique: [] } };
  for (const row of [other, entity, old]) records.set(`${row.kind}/${row.id}`, row);
  writeFileSync(file, JSON.stringify([phone]));
  await activated(coda, state, file);
  const mine = recordId('testbed', 'coda/group@1', phone.udid);
  assert.deepEqual(held(records, 'coda/group@1').map(row => row.id).sort(), [other.id, mine, entity.id].sort());
  assert.deepEqual([records.get(`coda/group@1/${other.id}`), records.get(`coda/group@1/${entity.id}`)], [other, entity]);
  // A key the host refuses (longer than 256): nothing changes, the refusal is logged.
  writeFileSync(file, JSON.stringify([{ ...phone, udid: 'U'.repeat(257) }]));
  await until(() => errors.length > 0);
  assert.match(errors[0], /^测试机归属声明失败：bad or repeated key/);
  assert.equal(records.get(`coda/group@1/${other.id}`), other);
  assert.ok(records.has(`coda/group@1/${mine}`));
});

test('find resolves remote devices and propagates missing/conflict errors', t => {
  const state = fixture(t), output = join(state, 'output');
  writeFileSync(join(state, 'devices.json'), '[]');
  writeFileSync(join(state, 'coda-resources'), `#!${process.execPath}\nif(process.argv[2] !== 'group-owner' || process.argv[3] !== 'device:phone') process.exit(9);\nif(process.env.CONFLICT) {console.error('conflict owner-a owner-b'); process.exit(1);}\nconsole.log(process.env.OWNER);\n`, { mode: 0o755 });
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
