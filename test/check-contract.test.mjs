// The copy of Coda's plugin contract is as Coda synced it: its files unedited, nothing added beside them, and the packages it
// needs at Coda's versions.
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { contractProblems } from '../scripts/check-contract.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)), temps = [];
after(() => { for (const dir of temps) rmSync(dir, { recursive: true, force: true }); });
// A copy of what the check reads, to change.
function copy() {
  const dir = mkdtempSync(join(tmpdir(), 'coda-plugin-contract-'));
  temps.push(dir);
  for (const path of ['check/coda', 'package.json']) cpSync(join(root, path), join(dir, path), { recursive: true });
  return dir;
}

test('the copy is as Coda synced it', () => {
  assert.deepEqual(contractProblems(), []);
});
test('an edited file, one gone, one added, or a package at another version is said', () => {
  const dir = copy(), pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  appendFileSync(join(dir, 'check/coda/domain/agent-protocol.mjs'), '\n// edited\n');
  rmSync(join(dir, 'check/coda/domain/errors.mjs'));
  writeFileSync(join(dir, 'check/coda/domain/mine.mjs'), '');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ ...pkg, dependencies: { ...pkg.dependencies, yaml: '0.0.1' } }));
  const problems = contractProblems(dir).join('\n');
  assert.match(problems, /check\/coda\/domain\/agent-protocol\.mjs 与 Coda 同步的不一样/);
  assert.match(problems, /check\/coda\/domain\/errors\.mjs 不见了/);
  assert.match(problems, /check\/coda\/domain\/mine\.mjs 不在 contract\.json 里/);
  assert.match(problems, /yaml 2\.9\.1（Coda 用的版本），现为 0\.0\.1/);
});
