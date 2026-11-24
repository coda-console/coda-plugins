import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CARD_KIND, cardFallbackNotice, checked, mergeFriendRows, mergeProfileAndCard, normalizeCardInput, normalizeContentPointer, normalizeProfileInput, parseInvite, readCardRecord, readContentPointer, readProfileRecord,
  shortAuthor } from '../../../plugins/friends/lib/friends.mjs';

const KEY_A = `ed25519:${'a1b2c3d4'.padEnd(64, '0')}`, KEY_B = `ed25519:${'ffeeddcc'.padEnd(64, '1')}`;

const TOKEN = '"bindingToken":"b","peerNode":"p"';
test('parseInvite reads a JSON object and generates a short linkId when missing', () => {
  const invite = parseInvite(JSON.stringify({ control: ' https://c.example ', authKey: 'tskey-1', bindingToken: ' bt-1 ', scope: 'room', peerNode: 'p1', ignored: 1 }));
  assert.equal(invite.control, 'https://c.example');
  assert.equal(invite.bindingToken, 'bt-1');
  assert.equal(invite.authKey, 'tskey-1');
  assert.equal(invite.scope, 'room');
  assert.equal(invite.peerNode, 'p1');
  assert.match(invite.linkId, /^f-[0-9a-f]{8}$/);
  assert.equal('ignored' in invite, false);
  assert.equal(parseInvite(`{"control":"c","authKey":"k",${TOKEN},"linkId":"mine-1"}`).linkId, 'mine-1');
});

test('parseInvite reads URLs and multi-line key=value text', () => {
  const url = parseInvite('coda-friend://x?control=https%3A%2F%2Fc.example&authKey=k1&bindingToken=bt1&peerNode=p1&linkId=l1&hostname=h');
  assert.deepEqual(url, { control: 'https://c.example', authKey: 'k1', bindingToken: 'bt1', peerNode: 'p1', linkId: 'l1', hostname: 'h' });
  const web = parseInvite('https://invite.example/join?authKey=k2&bindingToken=bt2&peerNode=p2&control=https://c2.example');
  assert.equal(web.control, 'https://c2.example');
  const host = parseInvite('coda-friend://c3.example/path?authKey=k3&binding_token=bt3&peerNode=p3');
  assert.equal(host.control, 'https://c3.example/path');
  const lines = parseInvite('control = https://c4.example:8080/x\nauthKey: k4\nbindingToken = bt4\n\npeer_node=n1\n随便一行');
  assert.equal(lines.control, 'https://c4.example:8080/x');
  assert.equal(lines.authKey, 'k4');
  assert.equal(lines.peerNode, 'n1');
  assert.equal(lines.bindingToken, 'bt4');
  assert.equal(web.bindingToken, 'bt2');
  assert.equal(host.bindingToken, 'bt3');
});

test('parseInvite explains what is wrong, in Chinese', () => {
  assert.throws(() => parseInvite(''), /请先粘贴/);
  assert.throws(() => parseInvite('{bad'), /JSON/);
  assert.throws(() => parseInvite('[1]'), /对象/);
  assert.throws(() => parseInvite('{"authKey":"k"}'), /缺少 control/);
  assert.throws(() => parseInvite('{"control":"c"}'), /缺少 authKey/);
  assert.throws(() => parseInvite('{"control":"c","authKey":"   "}'), /缺少 authKey/);
  assert.throws(() => parseInvite('{"control":"c","authKey":"a\\u0000b"}'), /不合法的字符/);
  assert.throws(() => parseInvite('control=c\nauthKey=k\nbindingToken=b\npeerNode=p\nlinkId=bad id!'), /linkId/);
  for (const bad of ['Upper', 'a.b', '-x', '_x', 'a'.repeat(65)]) assert.throws(() => parseInvite(JSON.stringify({ control: 'c', authKey: 'k', bindingToken: 'b', peerNode: 'p', linkId: bad })), /linkId/, bad);
  assert.equal(parseInvite(JSON.stringify({ control: 'c', authKey: 'k', bindingToken: 'b', peerNode: 'p', linkId: `a${'b'.repeat(63)}` })).linkId.length, 64);
  assert.throws(() => parseInvite(JSON.stringify({ control: 'c', authKey: 'k'.repeat(501), bindingToken: 'b', peerNode: 'p' })), /太长/);
  assert.throws(() => checked({ control: 'c' }), /缺少 authKey/);
  assert.throws(() => parseInvite('{"control":"c","authKey":"k","peerNode":"p"}'), /邀请缺少 bindingToken（一次性口令），请让对方重新生成邀请/);
  assert.throws(() => parseInvite('{"control":"c","authKey":"k","bindingToken":"  "}'), /邀请缺少 bindingToken（一次性口令），请让对方重新生成邀请/);
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
  assert.deepEqual(readProfileRecord(record({ name: ' <b>Bob</b>\u0000 ', emoji: '🐱', color: 'pink' })), { author: KEY_A, version: 5, name: '<b>Bob</b>', emoji: '🐱', color: 'pink', avatar: null, avatarPresent: false });
  assert.deepEqual(readProfileRecord(record({ name: 'Bob', emoji: 'x'.repeat(9), color: 'javascript:alert(1)' })), { author: KEY_A, version: 5, name: 'Bob', avatar: null, avatarPresent: false });
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

const OWNER = '0123abcd-4567-89ef-0123-456789abcdef', HASH = 'ab'.repeat(32), HASH2 = 'cd'.repeat(32);
const pointer = (over = {}) => ({ owner: OWNER, path: `content/${HASH}`, sha256: HASH, ...over });

test('parseInvite and checked take an optional peerPort under its aliases and a scope up to 520 characters', () => {
  assert.equal(parseInvite(JSON.stringify({ control: 'c', authKey: 'k', bindingToken: 'b', peerNode: 'p', peerPort: 41641 })).peerPort, 41641);
  assert.equal(parseInvite(JSON.stringify({ control: 'c', authKey: 'k', bindingToken: 'b', peerNode: 'p', peer_port: '8443' })).peerPort, 8443);
  assert.equal(parseInvite('coda-friend://c.example?authKey=k&bindingToken=b&peerNode=p&peerport=1').peerPort, 1);
  assert.equal(parseInvite('control=c\nauthKey=k\nbindingToken=b\npeerNode=p\npeer_port = 65535').peerPort, 65535);
  assert.equal('peerPort' in parseInvite('{"control":"c","authKey":"k","bindingToken":"b","peerNode":"p"}'), false, 'no peerPort is given when there was none');
  assert.equal(checked({ control: 'c', authKey: 'k', bindingToken: 'b', peerNode: 'p', peerPort: 22 }).peerPort, 22);
  assert.equal('peerPort' in checked({ control: 'c', authKey: 'k', bindingToken: 'b', peerNode: 'p', peerPort: '' }), false);
  for (const bad of [0, 65536, -1, 1.5, '12a', 'x', '1e3', true, [443], ['443'], { port: 443 }, [], 443n]) assert.throws(() => checked({ control: 'c', authKey: 'k', bindingToken: 'b', peerNode: 'p', peerPort: bad }), /peerPort/, String(bad));
  assert.throws(() => parseInvite('{"control":"c","authKey":"k","bindingToken":"b","peerNode":"p","peerPort":70000}'), /peerPort/);
  assert.equal(parseInvite(JSON.stringify({ control: 'c', authKey: 'k', bindingToken: 'b', peerNode: 'p', scope: 's'.repeat(520) })).scope.length, 520);
  assert.throws(() => parseInvite(JSON.stringify({ control: 'c', authKey: 'k', bindingToken: 'b', peerNode: 'p', scope: 's'.repeat(521) })), /scope 太长（最多 520 字）/);
});

test('normalizeContentPointer takes only content/<sha256> pointers whose sha256 matches, and returns a clean copy', () => {
  assert.deepEqual(normalizeContentPointer(pointer()), pointer());
  const full = normalizeContentPointer(pointer({ mime: 'image/png', size: 5 * 1024 * 1024, name: ' 头像\u0000.png ' }));
  assert.deepEqual(full, pointer({ mime: 'image/png', size: 5 * 1024 * 1024, name: '头像.png' }));
  const input = pointer();
  assert.notEqual(normalizeContentPointer(input), input);
  for (const [what, bad, message] of [
    ['uploads', pointer({ path: `uploads/${OWNER}` }), /path/],
    ['service', pointer({ path: 'plugins/friends/services/x/a.png' }), /path/],
    ['upper case', pointer({ path: `content/${HASH.toUpperCase()}`, sha256: HASH.toUpperCase() }), /path/],
    ['63 hex', pointer({ path: `content/${HASH.slice(1)}`, sha256: HASH.slice(1) }), /path/],
    ['65 hex', pointer({ path: `content/${HASH}a`, sha256: `${HASH}a` }), /path/],
    ['traversal', pointer({ path: `content/../${HASH}` }), /path/],
    ['extra segment', pointer({ path: `content/${HASH}/x` }), /path/],
    ['sha mismatch', pointer({ sha256: HASH2 }), /sha256/],
    ['no sha', { owner: OWNER, path: `content/${HASH}` }, /sha256/],
    ['bad owner', pointer({ owner: OWNER.toUpperCase() }), /owner/],
    ['too big', pointer({ size: 5 * 1024 * 1024 + 1 }), /size/],
    ['negative size', pointer({ size: -1 }), /size/],
    ['bad mime', pointer({ mime: 'png' }), /mime/],
    ['long mime', pointer({ mime: `image/${'x'.repeat(123)}` }), /mime/],
    ['empty name', pointer({ name: ' \u0007 ' }), /name/],
    ['long name', pointer({ name: 'n'.repeat(201) }), /name/],
    ['extra key', pointer({ url: 'https://x' }), /不认识的字段：url/],
    ['array', [], /对象/],
  ]) {
    assert.throws(() => normalizeContentPointer(bad), message, what);
    assert.equal(readContentPointer(bad), null, what);
  }
  assert.equal(readContentPointer(null), null);
  assert.equal(readContentPointer('content/x'), null);
  assert.deepEqual(readContentPointer(pointer({ size: 10 })), pointer({ size: 10 }));
});

test('normalizeCardInput keeps a valid avatar, keeps null as clearing it, and refuses a bad pointer', () => {
  assert.deepEqual(normalizeCardInput({ name: 'A', avatar: pointer() }), { name: 'A', avatar: pointer() });
  assert.deepEqual(normalizeCardInput({ name: 'A', avatar: null }), { name: 'A', avatar: null });
  assert.deepEqual(normalizeCardInput({ name: 'A', emoji: '🙂', color: 'green' }), { name: 'A', emoji: '🙂', color: 'green' });
  assert.throws(() => normalizeCardInput({ name: 'A', avatar: pointer({ path: `uploads/${OWNER}` }) }), /path/);
  assert.throws(() => normalizeCardInput({ name: '' }), /不能为空/);
  assert.equal(normalizeProfileInput, normalizeCardInput);
});

test('readCardRecord reads friends/card records like profiles, and an avatar only when it is a valid pointer', () => {
  const record = (body, over = {}) => ({ author: KEY_A, kind: CARD_KIND, id: 'self', version: 2, body, ...over });
  assert.deepEqual(readCardRecord(record({ name: 'Bob', avatar: pointer() })), { author: KEY_A, version: 2, name: 'Bob', avatar: pointer(), avatarPresent: true });
  assert.deepEqual(readCardRecord(record({ name: 'Bob', avatar: pointer({ path: 'uploads/x' }) })), { author: KEY_A, version: 2, name: 'Bob', avatar: null, avatarPresent: false });
  assert.deepEqual(readCardRecord(record({ name: 'Bob' })), { author: KEY_A, version: 2, name: 'Bob', avatar: null, avatarPresent: false }, 'no avatar written');
  assert.deepEqual(readCardRecord(record({ name: 'Bob', avatar: null })), { author: KEY_A, version: 2, name: 'Bob', avatar: null, avatarPresent: true }, 'an avatar cleared on purpose');
  assert.equal(readCardRecord(record({ name: 'Bob' }, { kind: 'profile' })), null);
  assert.equal(readProfileRecord(record({ name: 'Bob' })), null);
  assert.deepEqual(readProfileRecord(record({ name: 'Bob', avatar: pointer() }, { kind: 'profile' })).avatar, pointer());
});

test('mergeFriendRows takes each field from the profile first and the friends/card second, and gives an avatar or null', () => {
  const friends = [KEY_A, KEY_B, KEY_B.replace('f', 'e'), KEY_B.replace('f', 'd')].map((author, i) => ({ node: `n${i}`, scope: 's', author, bound: true, updatedAt: 10 - i }));
  const rec = (kind, author, version, body) => ({ author, kind, id: 'self', version, body });
  const rows = mergeFriendRows({ friends,
    profiles: [rec('profile', KEY_A, 1, { name: '只名片' }), rec('profile', KEY_B, 1, { name: 'P 名', emoji: '🐱' }),
      rec('profile', friends[3].author, 1, { name: '坏头像', avatar: { owner: OWNER, path: 'uploads/x' } })],
    cards: [rec(CARD_KIND, KEY_B, 1, { name: 'C 旧', color: 'teal' }), rec(CARD_KIND, KEY_B, 4, { name: 'C 名', emoji: '🐶', color: 'pink', avatar: pointer() }),
      rec(CARD_KIND, friends[2].author, 1, { name: '只社交', emoji: '🦊', color: 'green', avatar: pointer({ size: 3 }) }),
      rec(CARD_KIND, friends[3].author, 1, { name: 'x', avatar: { ...pointer(), sha256: HASH2 } }), rec('profile', KEY_A, 9, { name: 'wrong kind in cards' })],
    notes: {} });
  const by = node => rows.find(r => r.node === node);
  assert.deepEqual([by('n0').profileName, by('n0').avatar, by('n0').color], ['只名片', null, 'gray'], 'only a profile');
  assert.deepEqual([by('n1').profileName, by('n1').emoji, by('n1').color, by('n1').avatar], ['P 名', '🐱', 'pink', pointer()], 'profile first, the latest card fills the rest');
  assert.deepEqual([by('n2').profileName, by('n2').title, by('n2').emoji, by('n2').color, by('n2').avatar], ['只社交', '只社交', '🦊', 'green', pointer({ size: 3 })], 'only a card');
  assert.deepEqual([by('n3').profileName, by('n3').avatar], ['坏头像', null], 'a bad avatar on either record is just null');
  assert.deepEqual(Object.keys(by('n0')).sort(), ['author', 'avatar', 'color', 'emoji', 'node', 'note', 'peerNode', 'profileName', 'scope', 'short', 'status', 'title', 'updatedAt']);
  assert.equal(mergeFriendRows({ friends: friends.slice(0, 1), profiles: [] })[0].avatar, null, 'the old call without cards still works');
});

test('normalizeCardInput writes avatar: null only when the avatar is cleared on purpose', () => {
  assert.equal('avatar' in normalizeCardInput({ name: 'A' }), false);
  assert.equal('avatar' in normalizeProfileInput({ name: 'A', avatar: undefined }), false);
  assert.deepEqual(normalizeProfileInput({ name: 'A', avatar: null }), { name: 'A', avatar: null });
});

test('mergeProfileAndCard keeps what the root-signed profile set, fills the rest from the card, and takes the profile avatar whenever it wrote one', () => {
  const rec = (kind, body) => (kind === 'profile' ? readProfileRecord : readCardRecord)({ author: KEY_A, kind, id: 'self', version: 1, body });
  const card = rec(CARD_KIND, { name: '新名', emoji: '🐶', color: 'pink', avatar: pointer() });
  assert.equal(mergeProfileAndCard(undefined, undefined), null);
  assert.deepEqual(mergeProfileAndCard(undefined, card), { name: '新名', emoji: '🐶', color: 'pink', avatar: pointer(), avatarPresent: true }, 'only a card');
  assert.deepEqual(mergeProfileAndCard(rec('profile', { name: '根名', color: 'blue' }), card), { name: '根名', emoji: '🐶', color: 'blue', avatar: pointer(), avatarPresent: true },
    'an existing profile keeps its fields over a newer card, the card fills only what it left out');
  assert.deepEqual(mergeProfileAndCard(rec('profile', { name: '根名', avatar: null }), card).avatar, null, 'a profile that cleared its avatar is not given the card one back');
  assert.deepEqual(mergeProfileAndCard(rec('profile', { name: '根名', avatar: { owner: 'x' } }), card).avatar, pointer(), 'a broken profile avatar falls back to the card');
  assert.deepEqual(mergeProfileAndCard(rec('profile', { name: '根名', avatar: pointer({ size: 1 }) }), card).avatar, pointer({ size: 1 }));
  assert.deepEqual(mergeProfileAndCard(rec('profile', { name: '根名' }), rec(CARD_KIND, { name: 'x', avatar: null })), { name: '根名', emoji: undefined, color: undefined, avatar: null, avatarPresent: true });
  assert.deepEqual(mergeProfileAndCard(rec('profile', { name: '根名' }), undefined), { name: '根名', emoji: undefined, color: undefined, avatar: null, avatarPresent: false });
});

test('mergeFriendRows uses the same rule: a profile clearing its avatar hides the card avatar, and an existing profile name wins over a newer card', () => {
  const rec = (kind, version, body) => ({ author: KEY_A, kind, id: 'self', version, body });
  const friends = [{ node: 'n', scope: 's', author: KEY_A, bound: true, updatedAt: 0 }];
  const [row] = mergeFriendRows({ friends, profiles: [rec('profile', 1, { name: '根名', avatar: null })], cards: [rec(CARD_KIND, 9, { name: '新名', emoji: '🐶', avatar: pointer() })] });
  assert.deepEqual([row.profileName, row.title, row.emoji, row.avatar], ['根名', '根名', '🐶', null]);
});

test('cardFallbackNotice says friends see the new card only when there is surely no root-signed profile, and promises nothing when it is unknown', () => {
  assert.match(cardFallbackNotice(false), /好友会看到它/);
  assert.equal(cardFallbackNotice(true), '社交名片已保存，但你已有根私钥签名的名片，昵称等已有项仍以根签名为准（未设项由社交名片补充）');
  assert.doesNotMatch(cardFallbackNotice(true), /好友会看到它/);
  for (const unknown of [null, undefined]) {
    assert.equal(cardFallbackNotice(unknown), '社交名片已保存；若你曾用根私钥发布过名片，昵称等已有项仍以根签名为准');
    assert.doesNotMatch(cardFallbackNotice(unknown), /好友会看到它/);
  }
});

test('parseInvite and checked take bindingToken in every paste format and in the field form, and refuse a token without peerNode', () => {
  const want = { control: 'https://c.example', authKey: 'k', bindingToken: 'bt-secret', peerNode: 'p' };
  assert.equal(parseInvite(JSON.stringify({ control: 'c', authKey: 'k', peerNode: 'p', binding_token: 'bt-secret' })).bindingToken, 'bt-secret');
  assert.equal(parseInvite(JSON.stringify({ control: 'c', authKey: 'k', peerNode: 'p', bindingtoken: 'bt-secret' })).bindingToken, 'bt-secret');
  assert.equal(parseInvite('coda-friend://x?control=https%3A%2F%2Fc.example&authKey=k&bindingToken=bt-secret&peerNode=p').bindingToken, 'bt-secret');
  assert.equal(parseInvite('control=https://c.example\nauthKey=k\nbindingToken: bt-secret\npeerNode=p').bindingToken, 'bt-secret');
  assert.equal(parseInvite('control=c&authKey=k&bindingToken=bt-secret&peerNode=p').bindingToken, 'bt-secret');
  assert.equal(checked(want).bindingToken, 'bt-secret');
  assert.throws(() => checked({ control: 'c', authKey: 'k', peerNode: 'p' }), /邀请缺少 bindingToken（一次性口令），请让对方重新生成邀请/);
  assert.throws(() => checked({ control: 'c', authKey: 'k', bindingToken: 'bt-secret' }), /peerNode/);
  assert.throws(() => parseInvite('{"control":"c","authKey":"k","bindingToken":"bt-secret"}'), /peerNode/);
  assert.throws(() => parseInvite('control=c\nauthKey=k\nbindingToken=bt-secret'), /peerNode/);
  assert.throws(() => parseInvite('coda-friend://x?control=c&authKey=k&bindingToken=bt-secret'), /peerNode/);
  assert.throws(() => checked({ ...want, peerNode: '  ' }), /peerNode/);
  assert.equal(checked({ ...want, bindingToken: 't'.repeat(200) }).bindingToken.length, 200);
  assert.throws(() => checked({ ...want, bindingToken: 't'.repeat(201) }), /bindingToken 太长（最多 200 字）/);
  assert.throws(() => checked({ ...want, bindingToken: 'a\0b' }), /bindingToken 含有不合法的字符/);
  assert.throws(() => parseInvite('{"control":"c","authKey":"k","peerNode":"p","bindingToken":"a\\u0000b"}'), /bindingToken 含有不合法的字符/);
  for (const bad of [123, true, ['x'], { a: 1 }]) assert.throws(() => parseInvite(JSON.stringify({ control: 'c', authKey: 'k', peerNode: 'p', bindingToken: bad })), /bindingToken 须是文本/, JSON.stringify(bad));
  assert.equal(parseInvite(JSON.stringify({ control: 'c', authKey: 'k', peerNode: 5, bindingToken: 'b' })).peerNode, '5', 'the other fields keep their own handling');
});
