import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accordStatusSummary, identiconPattern, initialChar, resolveAvatar } from '../../../plugins/friends/lib/avatar.mjs';

const KEY_A = `ed25519:${'a1b2c3d4'.padEnd(64, '0')}`, KEY_B = `ed25519:${'ffeeddcc'.padEnd(64, '1')}`;

test('identiconPattern is a deterministic, mirrored 5x5 grid that is never empty or full', () => {
  const grid = identiconPattern(KEY_A);
  assert.deepEqual(identiconPattern(KEY_A), grid);
  assert.equal(grid.length, 5);
  for (const row of grid) {
    assert.equal(row.length, 5);
    row.forEach((cell, c) => { assert.equal(typeof cell, 'boolean'); assert.equal(cell, row[4 - c]); });
  }
  const keys = Array.from({ length: 200 }, (_, i) => `ed25519:${i.toString(16).padStart(64, 'f')}`).concat(['x', '友', 'ed25519:short']);
  for (const key of keys) {
    const active = identiconPattern(key).flat().filter(Boolean).length;
    assert.ok(active > 0 && active < 25, key);
  }
});

test('identiconPattern tells different keys apart', () => {
  assert.notDeepEqual(identiconPattern(KEY_A), identiconPattern(KEY_B));
  const seen = new Set(Array.from({ length: 100 }, (_, i) => JSON.stringify(identiconPattern(`ed25519:${i.toString(16).padStart(64, '0')}`))));
  assert.ok(seen.size > 50);
});

test('initialChar takes the first character', () => {
  assert.equal(initialChar('小明'), '小');
  assert.equal(initialChar('alice'), 'A');
  assert.equal(initialChar('  \u0007bob'), 'B');
  assert.equal(initialChar('🐱 cat'), '🐱');
  assert.equal(initialChar('   '), '友');
  assert.equal(initialChar(undefined, '?'), '?');
});

test('resolveAvatar draws the identicon of a valid key, else the first character of the name', () => {
  assert.deepEqual(resolveAvatar({ author: KEY_A, name: 'Alice' }), { kind: 'identicon', grid: identiconPattern(KEY_A), author: KEY_A });
  assert.deepEqual(resolveAvatar({ name: 'alice' }), { kind: 'monogram', text: 'A' });
  assert.deepEqual(resolveAvatar({ author: 'ed25519:xyz', name: 'node-1' }), { kind: 'monogram', text: 'N' });
  assert.deepEqual(resolveAvatar({ author: 'ed25519:xyz' }), { kind: 'monogram', text: '友' });
  assert.deepEqual(resolveAvatar(), { kind: 'monogram', text: '友' });
  assert.deepEqual(resolveAvatar({ fallback: '?' }), { kind: 'monogram', text: '?' });
});

test('resolveAvatar has no photo or emoji branch any more', () => {
  const desc = resolveAvatar({ avatar: { owner: 'x' }, emoji: '🐱', author: KEY_A, name: 'Al' });
  assert.equal(desc.kind, 'identicon');
  assert.equal(resolveAvatar({ avatar: { owner: 'x' }, emoji: '🐱', name: 'Al' }).kind, 'monogram');
});

test('accordStatusSummary derives the certificate state like certStateOf', () => {
  const spec = { author: KEY_A };
  assert.equal(accordStatusSummary({ spec, status: { certificate: null } }).cert, 'no_identity');
  assert.equal(accordStatusSummary({ spec, status: { certificate: { active: false } } }).cert, 'needs_cert');
  assert.equal(accordStatusSummary({ spec, status: { certificate: {} } }).cert, 'needs_cert');
  assert.equal(accordStatusSummary({ spec, status: { certificate: { active: true } } }).cert, 'active');
  assert.equal(accordStatusSummary({ spec, status: {} }).cert, 'active');
  assert.equal(accordStatusSummary({ spec }).cert, 'active');
  assert.equal(accordStatusSummary({ status: {} }).cert, 'no_identity');
  assert.equal(accordStatusSummary(undefined).cert, 'no_identity');
});

test('accordStatusSummary reports author, short code, expiry and friend counts', () => {
  const rows = [{ status: 'bound' }, { status: 'bound' }, { status: 'pending' }, { status: 'conflict' }];
  const summary = accordStatusSummary({ spec: { author: KEY_A }, status: { certificate: { active: true, until: 1900000000000 } } }, rows);
  assert.deepEqual(summary, { cert: 'active', author: KEY_A, short: 'a1b2c3d4', certUntil: 1900000000000,
    friends: { total: 4, bound: 2, pending: 1, conflict: 1 } });
  assert.equal(accordStatusSummary({ status: { certificate: { active: true, expiresAt: 5 } } }).certUntil, 5);
  assert.equal(accordStatusSummary({ status: { certificate: { active: true, until: 'x', expiresAt: 7 } } }).certUntil, 7);
  assert.equal(accordStatusSummary({ status: { certificate: { active: true, until: -1 } } }).certUntil, null);
  assert.deepEqual(accordStatusSummary(null), { cert: 'no_identity', author: null, short: '', certUntil: null, friends: { total: 0, bound: 0, pending: 0, conflict: 0 } });
});
