import assert from 'node:assert/strict';
import { test } from 'node:test';
import { identityTitle, nicknameOf, shortAuthor, tailOf } from '../../../plugins/friends/lib/nickname.mjs';

const bytes = hex => Uint8Array.from(hex.match(/../g), pair => parseInt(pair, 16));
// coda#3040 的官方测试向量。
const VECTORS = [
  ['0'.repeat(64), 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '0'.padStart(78, '0'), '0000'],
  ['f'.repeat(64), '', '115792089237316195423570985008687907853269984665640564039457584007913129639935', '9935'],
  ['000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'aaggyqkgdobq2synhd', '000001780731860627700044960722568376592200742329637303199754547598369979440671', '0671'],
  ['66c8aec217cac5fa9829e4e314c2dfe6f3b3710cbf2c4b4df462c333565b4e27', 'zyv', '046490486105048442293641588531420323991210115029903945753585556465004131864103', '4103'],
  ['2e4b9cc2428beb7bff6a56c14d7304e472a23e890e91ef0a6b0b0380e89f9734', 'xs', '020939986474356556387344986264546814587009115178813918053369159061515022604084', '4084'],
  ['01' + 'ff'.repeat(31), '', '000904625697166532776746648320380374280103671755200316906558262375061821325311', '5311'],
];

for (const [hex, name, tail, shown] of VECTORS) {
  test(`coda#3040 vector ${hex.slice(0, 16)}…`, () => {
    const key = bytes(hex);
    assert.equal(nicknameOf(key), name);
    assert.equal(tailOf(key), tail);
    assert.equal(tailOf(key).slice(-4), shown);
    assert.equal(tailOf(key).length, 78);
  });
}

test('identityTitle shows nickname and tail for a valid key', () => {
  assert.equal(identityTitle(`ed25519:${VECTORS[3][0]}`), 'zyv #4103');
  assert.equal(identityTitle(`ed25519:${VECTORS[0][0]}`, 'node-1'), 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa #0000');
});

test('identityTitle falls back to the key short code when no nickname can be derived', () => {
  assert.equal(identityTitle(`ed25519:${'f'.repeat(64)}`, 'node-1'), 'ffffffff');
  assert.equal(identityTitle(`ed25519:${VECTORS[5][0]}`), '01ffffff');
});

test('identityTitle uses the node name when there is no valid key', () => {
  assert.equal(identityTitle(undefined, 'node-1'), 'node-1');
  assert.equal(identityTitle(null, 'node-1'), 'node-1');
  assert.equal(identityTitle('ed25519:xyz', 'node-1'), 'node-1');
  assert.equal(identityTitle(`ed25519:${'A'.repeat(64)}`, 'node-1'), 'node-1', 'only lowercase hex counts');
  assert.equal(identityTitle(undefined), '');
});

test('shortAuthor is the first 8 hex digits of a valid key, else empty', () => {
  assert.equal(shortAuthor(`ed25519:${'ab12cd34'.padEnd(64, '0')}`), 'ab12cd34');
  assert.equal(shortAuthor('ed25519:xyz'), '');
  assert.equal(shortAuthor(undefined), '');
});
