import assert from 'node:assert/strict';
import { test } from 'node:test';
import { identityTitles, shortAuthor } from '@coda-console/protocol/accord';
import { certStateOf, checked, mergeFriendRows as mergeRows, parseInvite } from '../../../plugins/friends/lib/friends.mjs';
import { NO_NAME, XS_A, XS_B, titleOf } from '../../helpers/accord-keys.mjs';

const mergeFriendRows = (friends, extraAuthors = []) => mergeRows(friends, { titles: identityTitles([...extraAuthors, ...friends.map(friend => friend.author)]), shortAuthor });
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

test('mergeFriendRows builds rows only from the friend table, titles them from the key, and sorts conflicts, pending, then bound', () => {
  const friends = [
    { node: 'n-bound', mode: 'm', scope: 's', author: KEY_A, bound: true, createdAt: 1, updatedAt: 10, peerNode: 'p1' },
    { node: 'n-pending', mode: 'm', scope: 's', author: null, bound: false, createdAt: 1, updatedAt: 20 },
    { node: 'n-conflict', mode: 'm', scope: 's', author: KEY_B, bound: true, conflict: true, createdAt: 1, updatedAt: 5 },
    { node: 'n-bound2', mode: 'm', scope: 's', author: KEY_B.replace('f', 'e'), bound: true, createdAt: 1, updatedAt: 30 },
  ];
  const rows = mergeFriendRows(friends);
  assert.deepEqual(rows.map(r => r.node), ['n-conflict', 'n-pending', 'n-bound2', 'n-bound']);
  const bound = rows.find(r => r.node === 'n-bound');
  assert.deepEqual(bound, { node: 'n-bound', author: KEY_A, short: 'a1b2c3d4', status: 'bound', peerNode: 'p1', scope: 's', updatedAt: 10, title: titleOf(KEY_A, 'n-bound') });
  assert.match(bound.title, /^[a-z0-9]{2,36} #\d{4}$/);
  assert.equal(rows[0].status, 'conflict');
  assert.equal(rows[1].title, 'n-pending', 'a pending friend with no key shows its node name');
  for (const row of rows) for (const dropped of ['note', 'profileName', 'emoji', 'color', 'avatar']) assert.ok(!(dropped in row), dropped);
});

test('mergeFriendRows falls back to the key short code when no nickname can be derived, and is empty without friends', () => {
  const rows = mergeFriendRows([{ node: 'n1', author: NO_NAME, bound: true }]);
  assert.equal(rows[0].title, 'ffffffff');
  assert.deepEqual(mergeFriendRows([]), []);
});

test('mergeFriendRows lengthens the tail of friends whose nickname and last 4 digits collide, also against extra authors', () => {
  const friends = [{ node: 'n1', author: XS_A, bound: true }, { node: 'n2', author: XS_B, bound: true }];
  assert.deepEqual(mergeFriendRows(friends).map(r => [r.node, r.title]), [['n1', 'xs #04084'], ['n2', 'xs #14084']]);
  assert.deepEqual(mergeFriendRows(friends.slice(0, 1)).map(r => r.title), ['xs #4084']);
  assert.deepEqual(mergeFriendRows(friends.slice(0, 1), [XS_B]).map(r => r.title), ['xs #04084'], 'the other author is the self or a friend elsewhere');
  assert.deepEqual(mergeFriendRows([...friends, { node: 'n3', bound: false }]).map(r => [r.node, r.title]), [['n3', 'n3'], ['n1', 'xs #04084'], ['n2', 'xs #14084']]);
});

test('certStateOf reads the certificate when the host writes one, else the author', () => {
  assert.equal(certStateOf({ status: { certificate: null } }), 'no_identity');
  assert.equal(certStateOf({ status: { certificate: { active: true } } }), 'active');
  assert.equal(certStateOf({ status: { certificate: {} } }), 'needs_cert');
  assert.equal(certStateOf({ spec: { author: KEY_A }, status: {} }), 'active');
  assert.equal(certStateOf(undefined), 'no_identity');
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
