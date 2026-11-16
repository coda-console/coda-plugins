// The Antigravity manifest starts `agy acp` directly; the setup's decision (scripts/setup.mjs) against a stand-in `--version`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MINIMUM, needed } from '../../../plugins/antigravity/scripts/setup.mjs';
import { relaysInstructions } from '../relay.mjs';

test('the entry relays agy acp from ~/.local/bin and forwards Coda instructions unchanged', t =>
  relaysInstructions(t, 'antigravity', '.local/bin/agy', ['acp']));

test('setup installs a missing CLI, upgrades an old one, reports one that does not run, and keeps one that is new enough', () => {
  const run = (status, stdout = '', stderr = '') => () => ({ status, stdout, stderr });
  assert.equal(MINIMUM, '1.5.9');
  assert.equal(needed(null).action, 'install');
  assert.equal(needed('/bin/agy', run(127)).action, 'broken');
  assert.match(needed('/bin/agy', run(127)).reason, /无法运行（\/bin\/agy）/);
  assert.equal(needed('/bin/agy', run(0, 'agy\n')).action, 'upgrade');
  assert.equal(needed('/bin/agy', run(0, '1.5.8\n')).action, 'upgrade');
  assert.match(needed('/bin/agy', run(0, '1.5.8\n')).reason, /1\.5\.8 低于所需的 1\.5\.9/);
  assert.equal(needed('/bin/agy', run(0, '1.4.20\n')).action, 'upgrade');
  assert.equal(needed('/bin/agy', run(0, '', '0.9.99')).action, 'upgrade', 'a version printed on standard error is read too');
  assert.deepEqual(needed('/bin/agy', run(0, '1.5.9\n')), { action: 'none', version: '1.5.9' });
  assert.deepEqual(needed('/bin/agy', run(0, '1.10.0\n')), { action: 'none', version: '1.10.0' });
});
