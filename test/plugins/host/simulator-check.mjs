// Opt-in native check of 清点模拟器's removeSimulator against the real simctl: creates one unbooted iPhone in an isolated device
// set. Not a *.test.mjs, so never part of npm test; run it on a Mac inside a simulator slot, e.g. with run-held (what 模拟器):
// node --test test/plugins/host/simulator-check.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeSimulator } from '../../../plugins/host/scripts/clean-simulators.mjs';

test('real simctl deletes an isolated simulator and treats repeated deletion as complete', async t => {
  execFileSync(process.env.HOST_SIM_BIN || 'host-sim', ['check', '--kind', 'simulator'], { stdio: 'inherit' });
  const set = await mkdtemp(join(tmpdir(), 'coda-set-'));
  let udid;
  t.after(async () => {
    try { if (udid) await removeSimulator({ udid, set }); }
    finally { await rm(set, { recursive: true, force: true }); }
  });
  const type = JSON.parse(execFileSync('xcrun', ['simctl', 'list', 'devicetypes', '-j'], { encoding: 'utf8' })).devicetypes
    .find(d => /iPhone/.test(d.name)).identifier;
  udid = execFileSync('xcrun', ['simctl', '--set', set, 'create', 'coda-slot-check', type], { encoding: 'utf8' }).trim();
  const listed = () => Object.values(JSON.parse(execFileSync('xcrun', ['simctl', '--set', set, 'list', 'devices', '-j'],
    { encoding: 'utf8' })).devices).flat().some(device => device.udid === udid);
  assert.equal(listed(), true);
  await removeSimulator({ udid, set });
  assert.equal(listed(), false);
  await removeSimulator({ udid, set });
});
