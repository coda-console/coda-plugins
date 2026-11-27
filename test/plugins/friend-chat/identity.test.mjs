import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { identiconPattern, isAuthor } from '@coda-console/protocol/accord';
import { dmConversationId, isConversationId, renderIdenticonPng, resolveAccordPeers } from '../../../plugins/friend-chat/lib/identity.mjs';
import { NO_NAME, SAKURA, XS_A, XS_B, ZYV, titleOf } from '../../helpers/accord-keys.mjs';

const key = n => `ed25519:${n.toString(16).padStart(2, '0').repeat(32)}`;
const [A, B, C, D] = [key(0x11), key(0x22), key(0x33), key(0x44)];

test('公钥格式与会话 ID 格式', () => {
  assert.ok(isAuthor(A));
  for (const bad of [undefined, 'ed25519:abc', `ed25519:${'A'.repeat(64)}`, `${A}0`, 5]) assert.equal(isAuthor(bad), false);
  assert.ok(isConversationId(`dm:${'a'.repeat(32)}`));
  assert.ok(isConversationId('grp:team_1-a'));
  for (const bad of [`dm:${'a'.repeat(31)}`, `dm:${'A'.repeat(32)}`, 'grp:', 'grp:-x', `grp:${'a'.repeat(65)}`, 'x:1', undefined]) assert.equal(isConversationId(bad), false);
});

function decodePng(png) {
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunks = [];
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at), type = png.toString('latin1', at + 4, at + 8);
    chunks.push({ type, data: png.subarray(at + 8, at + 8 + length) });
    at += 12 + length;
  }
  return chunks;
}

test('几何纹 PNG：合法的 8 位 RGB，同一公钥同一张', () => {
  const png = renderIdenticonPng(A);
  assert.ok(png instanceof Uint8Array);
  const chunks = decodePng(png);
  assert.deepEqual(chunks.map(c => c.type), ['IHDR', 'IDAT', 'IEND']);
  const { data: ihdr } = chunks[0];
  assert.deepEqual([ihdr.readUInt32BE(0), ihdr.readUInt32BE(4), ...ihdr.subarray(8)], [96, 96, 8, 2, 0, 0, 0]);
  const raw = inflateSync(chunks[1].data);
  assert.equal(raw.length, 96 * (1 + 96 * 3));
  const pixel = (x, y) => raw.subarray(y * 289 + 1 + x * 3, y * 289 + 4 + x * 3).toString('hex');
  assert.equal(pixel(0, 0), pixel(95, 95));
  const colors = new Set();
  for (let y = 0; y < 96; y++) {
    assert.equal(raw[y * 289], 0);
    for (let x = 0; x < 96; x++) colors.add(pixel(x, y));
  }
  assert.equal(colors.size, 2);
  assert.deepEqual(renderIdenticonPng(A), png);
  assert.notDeepEqual(renderIdenticonPng(B), png);
});

test('几何纹 PNG：格子点亮与好友页的 5×5 网格一致，size 可调并校验', () => {
  const png = renderIdenticonPng(B, { size: 35 });
  const chunks = decodePng(png);
  const raw = inflateSync(chunks[1].data), stride = 1 + 35 * 3;
  const pixel = (x, y) => raw.subarray(y * stride + 1 + x * 3, y * stride + 4 + x * 3).toString('hex');
  const background = pixel(0, 0);
  const grid = identiconPattern(B);
  for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) assert.equal(pixel(5 + c * 5 + 2, 5 + r * 5 + 2) !== background, grid[r][c]);
  for (const size of [6, 1025, 9.5, '96']) assert.throws(() => renderIdenticonPng(A, { size }), RangeError);
  assert.throws(() => renderIdenticonPng('bad'), TypeError);
});

// 好友页的几何纹只给格子（颜色随 currentColor），所以对照协议包 identiconPattern 的格子。
test('头像 PNG 与协议包的 5×5 几何纹逐格一致', () => {
  const samples = [A, B, `ed25519:${'0'.repeat(64)}`, `ed25519:${'f'.repeat(64)}`,
    ...Array.from({ length: 32 }, (_, i) => `ed25519:${createHash('sha256').update(`sample ${i}`).digest('hex')}`)];
  for (const author of samples) {
    const raw = inflateSync(decodePng(renderIdenticonPng(author, { size: 35 }))[1].data), stride = 1 + 35 * 3;
    const lit = (x, y) => raw.subarray(y * stride + 1 + x * 3, y * stride + 4 + x * 3).toString('hex') !== raw.subarray(1, 4).toString('hex');
    assert.deepEqual(Array.from({ length: 5 }, (_, r) => Array.from({ length: 5 }, (_, c) => lit(5 + c * 5 + 2, 5 + r * 5 + 2))), identiconPattern(author), author);
  }
});

test('单聊会话 ID：对称、确定性、与成员有关', () => {
  const id = dmConversationId(A, B);
  assert.match(id, /^dm:[0-9a-f]{32}$/);
  assert.equal(dmConversationId(B, A), id);
  assert.notEqual(dmConversationId(A, C), id);
  assert.throws(() => dmConversationId(A, A), TypeError);
  assert.throws(() => dmConversationId(A, 'bad'), TypeError);
  assert.ok(isConversationId(id));
});

const accord = overrides => ({ spec: { author: A }, status: { certificate: { root: A, active: true }, friends: [] }, ...overrides });

test('准入：本机个人身份与签名能力', () => {
  assert.deepEqual(resolveAccordPeers(accord()), { selfRoot: A, canSign: true, friends: [] });
  for (const entry of [undefined, {}, { status: { certificate: null } }, { status: { certificate: { root: 'bad', active: true } } }]) {
    const out = resolveAccordPeers(entry);
    assert.equal(out.selfRoot, null);
    assert.equal(out.canSign, false);
    assert.equal(out.reason, '请先在「设置 › 身份」绑定个人身份');
  }
  const expired = resolveAccordPeers(accord({ status: { certificate: { root: A, active: false }, friends: [] } }));
  assert.deepEqual([expired.selfRoot, expired.canSign, expired.reason], [A, false, '本机签名证书已过期或未生效，打开客户端后自动续期']);
  const other = resolveAccordPeers(accord({ spec: { author: B } }));
  assert.deepEqual([other.selfRoot, other.canSign], [A, false]);
  assert.match(other.reason, /个人身份/);
});

test('准入：好友按公钥聚合多通道', () => {
  const channel = (author, extra) => ({ author, bound: true, conflict: false, certified: true, ...extra });
  const out = resolveAccordPeers(accord({ status: { certificate: { root: A, active: true }, friends: [
    channel(A), { node: 'x' }, channel('bad'), null,
    channel(B, { certified: false }), channel(B),
    channel(C, { certified: false }),
    channel(D, { bound: false, certified: false }), channel(D, { conflict: true }),
    channel(`ed25519:${'5'.repeat(64)}`, { conflict: true }),
    channel(`ed25519:${'6'.repeat(64)}`, { bound: false }),
  ] } }));
  const by = Object.fromEntries(out.friends.map(f => [f.author, f]));
  assert.equal(out.friends.length, 5);
  assert.equal(by[A], undefined);
  assert.deepEqual(by[B], { author: B, title: titleOf(B), eligible: true });
  assert.deepEqual([by[C].eligible, by[C].unreachableReason], [false, '对方还没有绑定个人身份']);
  assert.deepEqual([by[D].eligible, by[D].unreachableReason], [false, '双方还没有完成互认']);
  assert.deepEqual([by[`ed25519:${'5'.repeat(64)}`].eligible, by[`ed25519:${'5'.repeat(64)}`].unreachableReason], [false, '该好友的通道与已有记录冲突，请在「好友」页处理']);
  assert.equal(by[`ed25519:${'6'.repeat(64)}`].unreachableReason, '双方还没有完成互认');
});

test('准入：好友展示名 `昵称 #尾号`，无昵称给 8 位短码，同昵称同末 4 位尾号时本机身份与好友一起向左加位', () => {
  const channel = author => ({ author, bound: true, conflict: false, certified: true });
  const titles = (root, authors) => Object.fromEntries(resolveAccordPeers(accord({ status: { certificate: { root, active: true }, friends: authors.map(channel) } })).friends.map(f => [f.author, f.title]));
  assert.deepEqual(titles(A, [SAKURA, ZYV, NO_NAME]), { [SAKURA]: 'sakura #8283', [ZYV]: 'zyv #4103', [NO_NAME]: 'ffffffff' });
  assert.deepEqual(titles(A, [XS_A]), { [XS_A]: 'xs #4084' });
  assert.deepEqual(titles(A, [XS_A, XS_B]), { [XS_A]: 'xs #04084', [XS_B]: 'xs #14084' });
  assert.deepEqual(titles(XS_A, [XS_B]), { [XS_B]: 'xs #14084' }, '本机身份也在里面比');
});
