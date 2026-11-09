// The Codex entry's registry against its locked Codex (scripts/check-codex-protocol.mjs): everything the app-server can say is
// registered, so a PR that upgrades @openai/codex fails here until what the new Codex adds is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import registry from '../../../plugins/codex/agent/registry.json' with { type: 'json' };

const script = fileURLToPath(new URL('../../../scripts/check-codex-protocol.mjs', import.meta.url));
const check = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

test('everything the locked Codex\'s app-server can say is registered', () => {
  const { status, stdout, stderr } = check();
  assert.equal(status, 0, stderr);
  assert.match(stdout, /^Codex \d+\.\d+\.\d+ 的 app-server 都登记了/);
});

test('what is not registered fails the check, listed', t => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-registry-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { 'item:sleep': _, 'item:agentMessage.delivery=async': __, 'request:currentTime/read': ___, ...rest } = registry;
  writeFileSync(join(dir, 'registry.json'), JSON.stringify(rest));
  const { status, stderr } = check(join(dir, 'registry.json'));
  assert.equal(status, 1);
  assert.deepEqual(stderr.trim().split('\n').slice(1), ['item:sleep', 'item:agentMessage.delivery=async', 'request:currentTime/read']);
});
