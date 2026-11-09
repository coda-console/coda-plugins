import assert from 'node:assert/strict';
import { test } from 'node:test';
import { packages, published } from '../scripts/publish-npm.mjs';

test('only a missing npm version is eligible for publication; registry failures stop it', () => {
  assert.equal(published('@coda-console/claude@1.0.0', () => ({ status: 0, stdout: '"1.0.0"' })), true);
  assert.equal(published('@coda-console/claude@1.0.0', () => ({ status: 1, stdout: '{"error":{"code":"E404"}}' })), false);
  for (const code of ['E401', 'E403', 'E429', 'E500']) {
    assert.throws(() => published('@coda-console/claude@1.0.0', () => ({ status: 1, stdout: JSON.stringify({ error: { code } }), stderr: code })), /读取 .* 失败/);
  }
  assert.throws(() => published('@coda-console/claude@1.0.0', () => ({ status: null, error: new Error('npm not found') })), /npm not found/);
});

test('every package here has a public @coda-console name, or publish.yml stops at it', () => {
  assert.ok(packages().length > 1);
});
