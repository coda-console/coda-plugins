import assert from 'node:assert/strict';
import { test } from 'node:test';
import { packages, publish, published } from '../scripts/publish-npm.mjs';

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

test('npm saying the version already exists counts as published; any other publish failure stops the release', t => {
  t.mock.method(process.stdout, 'write', () => true);
  t.mock.method(process.stderr, 'write', () => true);
  const spec = '@coda-console/claude@1.0.0', fail = stderr => () => ({ status: 1, stdout: '', stderr });
  let called;
  assert.equal(publish(spec, '/pkg', (...args) => { called = args; return { status: 0, stdout: '+ ok', stderr: '' }; }), false);
  assert.deepEqual(called, ['npm', ['publish', '--access=public', '--ignore-scripts', '--registry=https://registry.npmjs.org'], { cwd: '/pkg', encoding: 'utf8' }]);
  assert.equal(publish(spec, '/pkg', fail('npm error code E409\nnpm error 409 Conflict - PUT https://registry.npmjs.org/@coda-console%2fplugin-check - Cannot publish over previously staged version "0.8.7".')), true);
  assert.equal(publish(spec, '/pkg', fail('npm error code E403\nnpm error You cannot publish over the previously published versions: 1.0.0.')), true);
  for (const stderr of ['npm error code ENEEDAUTH', 'npm error code E500', 'npm error code E403\nnpm error 403 Forbidden - You do not have permission', 'npm error code E409\nnpm error 409 Conflict - something else'])
    assert.throws(() => publish(spec, '/pkg', fail(stderr)), /发布 .* 失败/);
  assert.throws(() => publish(spec, '/pkg', () => ({ status: null, error: new Error('npm not found') })), /npm not found/);
});
