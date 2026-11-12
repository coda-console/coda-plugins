// The OpenCode entry relays `opencode acp` with Coda's input unchanged; the setup's decision (scripts/setup.mjs) against a stand-in `--version`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MINIMUM, needed } from '../../../plugins/opencode/scripts/setup.mjs';
import { relaysInstructions } from '../relay.mjs';

test('the entry relays opencode acp from ~/.opencode/bin and forwards Coda instructions unchanged', t =>
  relaysInstructions(t, 'opencode', '.opencode/bin/opencode', ['acp']));

test('setup installs a missing or broken OpenCode, upgrades one older than Coda\'s contract needs (OpenCode 1 among them), and keeps a newer one', () => {
  const run = (status, stdout = '') => () => ({ status, stdout, stderr: '' });
  assert.equal(MINIMUM, '2.1.4');
  assert.equal(needed(null).action, 'install');
  assert.equal(needed('/bin/opencode', run(1)).action, 'install');
  // OpenCode 1 says nothing of a model service's wait.
  assert.deepEqual(needed('/bin/opencode', run(0, '1.19.4\n')), { action: 'upgrade', reason: 'OpenCode CLI 1.19.4 低于所需的 2.1.4' });
  assert.deepEqual(needed('/bin/opencode', run(0, 'opencode v2.1.3\n')), { action: 'upgrade', reason: 'OpenCode CLI 2.1.3 低于所需的 2.1.4' });
  assert.equal(needed('/bin/opencode', run(0, 'dev\n')).action, 'upgrade');
  // OpenCode 2 says its version as `opencode v2.1.4`.
  assert.deepEqual(needed('/bin/opencode', run(0, 'opencode v2.1.4\n')), { action: 'none', version: '2.1.4' });
  assert.deepEqual(needed('/bin/opencode', run(0, 'opencode v2.3.0\n')), { action: 'none', version: '2.3.0' });
});
