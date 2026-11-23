import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BLOB_MAX_BYTES, accordStatusSummary, blobReadUrl, blobUploadUrl, identiconPattern, initialChar, resolveAvatar } from '../../../plugins/friends/lib/avatar.mjs';

const OWNER = '123e4567-e89b-42d3-a456-426614174000';
const SHA = 'ab'.repeat(32);
const POINTER = { owner: OWNER, path: `content/${SHA}`, sha256: SHA, mime: 'image/png', size: 1024 };
const KEY_A = `ed25519:${'a1b2c3d4'.padEnd(64, '0')}`, KEY_B = `ed25519:${'ffeeddcc'.padEnd(64, '1')}`;

test('BLOB_MAX_BYTES is 5 MiB', () => assert.equal(BLOB_MAX_BYTES, 5 * 1024 * 1024));

test('blobReadUrl builds the read url and escapes the machine', () => {
  const base = `coda-view://blob/${OWNER}/content/${SHA}`;
  assert.equal(blobReadUrl(POINTER), base);
  assert.equal(blobReadUrl(POINTER, '  '), base);
  assert.equal(blobReadUrl(POINTER, 42), base);
  assert.equal(blobReadUrl(POINTER, ' mac mini&1 '), `${base}?coda-machine=mac%20mini%261`);
});

test('blobReadUrl rejects anything but a content pointer', () => {
  assert.equal(blobReadUrl({ ...POINTER, path: `uploads/${SHA}` }), null);
  assert.equal(blobReadUrl({ ...POINTER, owner: 'NOT-A-UUID' }), null);
  assert.equal(blobReadUrl({ ...POINTER, sha256: 'cd'.repeat(32) }), null);
  assert.equal(blobReadUrl('content/x'), null);
  assert.equal(blobReadUrl([POINTER]), null);
  assert.equal(blobReadUrl(null), null);
  assert.equal(blobReadUrl(undefined), null);
});

test('blobUploadUrl adds the machine only when given', () => {
  assert.equal(blobUploadUrl(), 'coda-view://blob/content');
  assert.equal(blobUploadUrl('   '), 'coda-view://blob/content');
  assert.equal(blobUploadUrl(' a/b c '), 'coda-view://blob/content?coda-machine=a%2Fb%20c');
});

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

test('resolveAvatar follows photo, emoji, identicon, monogram', () => {
  const url = `coda-view://blob/${OWNER}/content/${SHA}?coda-machine=m1`;
  const photo = resolveAvatar({ avatar: POINTER, emoji: '🐱', author: KEY_A, name: 'Alice', machine: 'm1' });
  assert.equal(photo.kind, 'photo');
  assert.equal(photo.url, url);
  assert.deepEqual(photo.fallback, { kind: 'emoji', emoji: '🐱' });
  assert.deepEqual(resolveAvatar({ avatar: POINTER, emoji: '🐱', author: KEY_A, name: 'Alice', photoFailed: true }), { kind: 'emoji', emoji: '🐱' });
  assert.deepEqual(resolveAvatar({ emoji: ' 🐱 ', author: KEY_A }), { kind: 'emoji', emoji: '🐱' });
  assert.deepEqual(resolveAvatar({ author: KEY_A, name: 'Alice' }), { kind: 'identicon', grid: identiconPattern(KEY_A), author: KEY_A });
  assert.deepEqual(resolveAvatar({ name: 'alice' }), { kind: 'monogram', text: 'A' });
  assert.deepEqual(resolveAvatar({ author: 'ed25519:xyz' }), { kind: 'monogram', text: '友' });
  assert.deepEqual(resolveAvatar(), { kind: 'monogram', text: '友' });
  assert.deepEqual(resolveAvatar({ fallback: '?' }), { kind: 'monogram', text: '?' });
});

test('resolveAvatar falls back past a photo that failed and ignores malformed pointers and long emoji', () => {
  const failed = resolveAvatar({ avatar: POINTER, author: KEY_A, photoFailed: true });
  assert.equal(failed.kind, 'identicon');
  assert.equal(resolveAvatar({ avatar: { ...POINTER, path: `uploads/${SHA}` }, name: 'bob' }).kind, 'monogram');
  assert.equal(resolveAvatar({ avatar: 'x', emoji: '123456789', name: 'bob' }).kind, 'monogram');
  assert.equal(resolveAvatar({ emoji: '12345678' }).kind, 'emoji');
});

test('resolveAvatar prefer controls monogram versus identicon only', () => {
  assert.equal(resolveAvatar({ author: KEY_A, name: 'Al', prefer: 'monogram' }).kind, 'monogram');
  assert.equal(resolveAvatar({ author: KEY_A, name: 'Al', prefer: 'identicon' }).kind, 'identicon');
  assert.equal(resolveAvatar({ author: KEY_A, name: 'Al', prefer: 'auto' }).kind, 'identicon');
  assert.equal(resolveAvatar({ emoji: '🐱', author: KEY_A, prefer: 'monogram' }).kind, 'emoji');
  assert.equal(resolveAvatar({ avatar: POINTER, prefer: 'monogram' }).kind, 'photo');
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
