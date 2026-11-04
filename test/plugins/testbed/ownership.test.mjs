import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { activate, deactivate } from '../../../plugins/testbed/main.mjs';

const phone = { id: 'phone', name: 'Phone', udid: 'UDID', note: 'local runner required' };
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'testbed-ownership-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
async function until(check) {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await setTimeout(10);
  }
  assert.fail('file change not observed');
}

test('declarations follow atomic replacements; invalid/missing registration preserves ownership; [] revokes', async t => {
  const state = fixture(t), file = join(state, 'devices.json'), calls = [], errors = [];
  const original = console.error;
  console.error = message => errors.push(message);
  t.after(async () => { await deactivate(); console.error = original; });
  writeFileSync(file, JSON.stringify([phone]));
  await activate({ plugin: { state }, resources: { declareGroups: async groups => calls.push(groups) } });
  assert.deepEqual(calls[0], [{ name: 'device:phone', attributes: { name: phone.name, udid: phone.udid, note: phone.note }, unique: ['udid'] }]);
  writeFileSync(join(state, 'next'), JSON.stringify([{ ...phone, name: 'Changed' }]));
  renameSync(join(state, 'next'), file);
  await until(() => calls.at(-1)[0]?.attributes.name === 'Changed');
  let count = calls.length;
  writeFileSync(file, '{broken');
  await until(() => errors.length > 0);
  assert.equal(calls.length, count);
  const logged = errors.length;
  rmSync(file);
  await until(() => errors.length > logged);
  assert.equal(calls.length, count);
  writeFileSync(file, '[]');
  await until(() => calls.at(-1).length === 0);
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
