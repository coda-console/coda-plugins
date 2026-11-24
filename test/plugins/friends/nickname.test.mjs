// 公钥昵称与尾号（lib/nickname.mjs）：测试向量取自 coda#3040（与基座的 AccordNickname 共用）；oldTag 只是对照，不实现。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nicknameOf, tailOf } from '../../../plugins/friends/lib/nickname.mjs';

const VECTORS = [
  { key: '0000000000000000000000000000000000000000000000000000000000000000', name: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    tail: '000000000000000000000000000000000000000000000000000000000000000000000000000000', shown: '0000' },
  { key: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', name: '',
    tail: '115792089237316195423570985008687907853269984665640564039457584007913129639935', shown: '9935' },
  { key: '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', name: 'aaggyqkgdobq2synhd',
    tail: '000001780731860627700044960722568376592200742329637303199754547598369979440671', shown: '0671' },
  { key: '66c8aec217cac5fa9829e4e314c2dfe6f3b3710cbf2c4b4df462c333565b4e27', name: 'zyv',
    tail: '046490486105048442293641588531420323991210115029903945753585556465004131864103', shown: '4103' },
  { key: '2e4b9cc2428beb7bff6a56c14d7304e472a23e890e91ef0a6b0b0380e89f9734', name: 'xs',
    tail: '020939986474356556387344986264546814587009115178813918053369159061515022604084', shown: '4084' },
  { key: '01ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', name: '',
    tail: '000904625697166532776746648320380374280103671755200316906558262375061821325311', shown: '5311' },
];

for (const { key, name, tail, shown } of VECTORS) {
  test(`nickname and tail of ${key.slice(0, 8)}…`, () => {
    const bytes = Buffer.from(key, 'hex');
    assert.equal(nicknameOf(bytes), name);
    assert.equal(tailOf(bytes), tail);
    assert.equal(tailOf(bytes).slice(-4), shown);
  });
}
