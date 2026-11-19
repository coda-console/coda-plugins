import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checked, mergeFriendRows, normalizeProfileInput, parseInvite, readProfileRecord, shortAuthor } from '../../../plugins/friends/lib/friends.mjs';

const KEY_A = `ed25519:${'a1b2c3d4'.padEnd(64, '0')}`, KEY_B = `ed25519:${'ffeeddcc'.padEnd(64, '1')}`;

test('parseInvite reads a JSON object and generates a short linkId when missing', () => {
  const invite = parseInvite(JSON.stringify({ control: ' https://c.example ', authKey: 'tskey-1', scope: 'room', peerNode: 'p1', ignored: 1 }));
  assert.equal(invite.control, 'https://c.example');
  assert.equal(invite.authKey, 'tskey-1');
  assert.equal(invite.scope, 'room');
  assert.equal(invite.peerNode, 'p1');
  assert.match(invite.linkId, /^f-[0-9a-f]{8}$/);
  assert.equal('ignored' in invite, false);
  assert.equal(parseInvite('{"control":"c","authKey":"k","linkId":"mine-1"}').linkId, 'mine-1');
});

test('parseInvite reads URLs and multi-line key=value text', () => {
  const url = parseInvite('coda-friend://x?control=https%3A%2F%2Fc.example&authKey=k1&linkId=L1&hostname=h');
  assert.deepEqual(url, { control: 'https://c.example', authKey: 'k1', linkId: 'L1', hostname: 'h' });
  const web = parseInvite('https://invite.example/join?authKey=k2&control=https://c2.example');
  assert.equal(web.control, 'https://c2.example');
  const host = parseInvite('coda-friend://c3.example/path?authKey=k3');
  assert.equal(host.control, 'https://c3.example/path');
  const lines = parseInvite('control = https://c4.example:8080/x\nauthKey: k4\n\npeer_node=n1\n随便一行');
  assert.equal(lines.control, 'https://c4.example:8080/x');
  assert.equal(lines.authKey, 'k4');
  assert.equal(lines.peerNode, 'n1');
});

test('parseInvite explains what is wrong, in Chinese', () => {
  assert.throws(() => parseInvite(''), /请先粘贴/);
  assert.throws(() => parseInvite('{bad'), /JSON/);
  assert.throws(() => parseInvite('[1]'), /对象/);
  assert.throws(() => parseInvite('{"authKey":"k"}'), /缺少 control/);
  assert.throws(() => parseInvite('{"control":"c"}'), /缺少 authKey/);
  assert.throws(() => parseInvite('{"control":"c","authKey":"   "}'), /缺少 authKey/);
  assert.throws(() => parseInvite('{"control":"c","authKey":"a\\u0000b"}'), /不合法的字符/);
  assert.throws(() => parseInvite('control=c\nauthKey=k\nlinkId=bad id!'), /linkId/);
  assert.throws(() => parseInvite(JSON.stringify({ control: 'c', authKey: 'k'.repeat(501) })), /太长/);
  assert.throws(() => checked({ control: 'c' }), /缺少 authKey/);
});

test('normalizeProfileInput strips control characters and enforces limits and the color list', () => {
  assert.deepEqual(normalizeProfileInput({ name: '  小\u0000明\n ', emoji: ' 🙂 ', color: 'teal' }), { name: '小明', emoji: '🙂', color: 'teal' });
  assert.deepEqual(normalizeProfileInput({ name: 'A', color: 'red' }), { name: 'A' });
  assert.throws(() => normalizeProfileInput({ name: ' \u0007 ' }), /不能为空/);
  assert.throws(() => normalizeProfileInput({ name: 'x'.repeat(41) }), /最多 40/);
  assert.equal(normalizeProfileInput({ name: 'x'.repeat(40) }).name.length, 40);
  assert.throws(() => normalizeProfileInput({ name: 'A', emoji: '123456789' }), /最多 8/);
});

test('readProfileRecord cleans what a friend sent and never trusts it', () => {
  const record = (body, over = {}) => ({ author: KEY_A, kind: 'profile', id: 'self', version: 5, body, local: false, ...over });
  assert.deepEqual(readProfileRecord(record({ name: ' <b>Bob</b>\u0000 ', emoji: '🐱', color: 'pink' })), { author: KEY_A, version: 5, name: '<b>Bob</b>', emoji: '🐱', color: 'pink' });
  assert.deepEqual(readProfileRecord(record({ name: 'Bob', emoji: 'x'.repeat(9), color: 'javascript:alert(1)' })), { author: KEY_A, version: 5, name: 'Bob' });
  assert.equal(readProfileRecord(record({ name: '' })), null);
  assert.equal(readProfileRecord(record({ name: 'x'.repeat(41) })), null);
  assert.equal(readProfileRecord(record({ name: 5 })), null);
  assert.equal(readProfileRecord(record(null)), null);
  assert.equal(readProfileRecord(record({ name: 'Bob' }, { kind: 'other' })), null);
  assert.equal(readProfileRecord(record({ name: 'Bob' }, { id: 'x' })), null);
});

test('shortAuthor shows 8 characters after ed25519:', () => {
  assert.equal(shortAuthor(KEY_A), 'a1b2c3d4');
  assert.equal(shortAuthor('nope'), '');
  assert.equal(shortAuthor(null), '');
});

test('mergeFriendRows puts the local note first, uses the latest profile, and sorts conflicts, pending, then bound', () => {
  const friends = [
    { node: 'n-bound', mode: 'm', scope: 's', author: KEY_A, bound: true, createdAt: 1, updatedAt: 10, peerNode: 'p1' },
    { node: 'n-pending', mode: 'm', scope: 's', author: null, bound: false, createdAt: 1, updatedAt: 20 },
    { node: 'n-conflict', mode: 'm', scope: 's', author: KEY_B, bound: true, conflict: true, createdAt: 1, updatedAt: 5 },
    { node: 'n-bound2', mode: 'm', scope: 's', author: KEY_B.replace('f', 'e'), bound: true, createdAt: 1, updatedAt: 30 },
  ];
  const profile = (author, version, body) => ({ author, kind: 'profile', id: 'self', version, body, local: false });
  const rows = mergeFriendRows({ friends,
    profiles: [profile(KEY_A, 1, { name: 'Old' }), profile(KEY_A, 3, { name: 'New', emoji: '🦊', color: 'orange' }), profile(KEY_A, 2, { name: 'Mid' }), profile(KEY_B, 1, { name: 'Eve' })],
    notes: { 'n-bound': '老王', [KEY_B]: '备用' } });
  assert.deepEqual(rows.map(r => r.node), ['n-conflict', 'n-pending', 'n-bound2', 'n-bound']);
  const bound = rows.find(r => r.node === 'n-bound');
  assert.equal(bound.title, '老王');
  assert.equal(bound.profileName, 'New');
  assert.equal(bound.emoji, '🦊');
  assert.equal(bound.color, 'orange');
  assert.equal(bound.status, 'bound');
  assert.equal(bound.short, 'a1b2c3d4');
  const conflict = rows[0];
  assert.equal(conflict.status, 'conflict');
  assert.equal(conflict.note, '备用', 'a note kept by key still applies');
  assert.equal(conflict.title, '备用');
});

test('mergeFriendRows falls back without a profile or note, and ignores bad notes keys', () => {
  const rows = mergeFriendRows({ friends: [{ node: 'n1', mode: 'm', scope: 's', author: null, bound: false, createdAt: 0, updatedAt: 0 },
    { node: 'n2', mode: 'm', scope: 's', author: KEY_A, bound: true, createdAt: 0, updatedAt: 0 }], notes: JSON.parse('{"__proto__":"x","constructor":"y"}') });
  assert.equal(rows.find(r => r.node === 'n1').title, 'n1');
  assert.equal(rows.find(r => r.node === 'n2').title, '好友 a1b2c3d4');
  assert.equal(rows.find(r => r.node === 'n2').color, 'gray');
  assert.deepEqual(mergeFriendRows(), []);
});
