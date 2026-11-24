// 好友页按成员读数据的纯逻辑：成员列表、按身份合并名片、按电脑分节。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { friendSections, identities, listMembers } from '../../../plugins/friends/lib/view-members.mjs';

const KEY = n => `ed25519:${String(n).repeat(64)}`;
const ME = KEY(1), OTHER_ME = KEY(2), PAL = KEY(3);
const rec = (author, name, version, kind = 'profile') => ({ kind, id: 'self', author, version, body: { name } });
const member = (id, over = {}) => ({ id, name: id.toUpperCase(), unreachable: null, entry: { spec: { author: ME }, status: { certificate: { active: true } } }, author: ME,
  friends: [], profiles: [], cards: [], notes: {}, loaded: true, ...over });

test('listMembers keeps the view order, drops duplicates and ids that are not strings, and words the unreachable reason', () => {
  const coda = { machines: [{ id: 'a', name: 'Mac' }, { id: 'a', name: 'dup' }, { name: 'no id' }, { id: 'b' }, { id: 'c', name: 'nas', unreachable: '离线 3 小时' }, { id: 'd', unreachable: true }] };
  assert.deepEqual(listMembers(coda), [
    { id: 'a', name: 'Mac', unreachable: null }, { id: 'b', name: 'b', unreachable: null },
    { id: 'c', name: 'nas', unreachable: '离线 3 小时' }, { id: 'd', name: 'd', unreachable: '暂时连不上' }]);
  assert.deepEqual(listMembers({ machine: { id: 'solo', name: 'Solo' } }), [{ id: 'solo', name: 'Solo', unreachable: null }]);
});

test('two machines of one identity make one card, taken from the one with the higher record version', () => {
  const a = member('a', { profiles: [rec(ME, '旧名', 3)] }), b = member('b', { profiles: [rec(ME, '新名', 5)] });
  const [one, ...more] = identities([a, b]);
  assert.equal(more.length, 0);
  assert.deepEqual([one.author, one.card.name, one.card.from], [ME, '新名', 'b']);
  assert.deepEqual(one.members.map(m => m.id), ['a', 'b']);
  // 顺序反过来结果一样；profile 写了的字段优先于 friends/card，哪怕后者的版本更高。
  assert.equal(identities([b, a])[0].card.name, '新名');
  const viaCard = member('c', { cards: [rec(ME, '社交名片', 9, 'friends/card')] });
  assert.equal(identities([a, viaCard])[0].card.name, '旧名');
});

test('profile and friends/card are compared by their own versions, then merged: a shared profile version does not hide a newer card', () => {
  const body = { name: '我' };
  const a = member('a', { profiles: [rec(ME, '我', 10)], cards: [{ ...rec(ME, '我', 2, 'friends/card'), body: { ...body, color: 'blue' } }] });
  const b = member('b', { profiles: [rec(ME, '我', 10)], cards: [{ ...rec(ME, '我', 3, 'friends/card'), body: { ...body, color: 'green' } }] });
  assert.equal(identities([a, b])[0].card.color, 'green');
  assert.equal(identities([b, a])[0].card.color, 'green');
});

test('the avatar comes from the machine that supplied the record it was taken from', () => {
  const pointer = { owner: '123e4567-e89b-42d3-a456-426614174000', path: `content/${'cd'.repeat(32)}`, sha256: 'cd'.repeat(32) };
  const a = member('a', { profiles: [rec(ME, '我', 4)] });
  const b = member('b', { cards: [{ ...rec(ME, '我', 7, 'friends/card'), body: { name: '我', avatar: pointer } }] });
  assert.equal(identities([a, b])[0].card.from, 'b');
  assert.equal(identities([a, b])[0].card.avatar.sha256, pointer.sha256);
});

test('equal versions keep the earlier machine in the view; machines without a card do not blank it', () => {
  const a = member('a', { profiles: [rec(ME, '甲', 4)] }), b = member('b', { profiles: [rec(ME, '乙', 4)] }), none = member('c');
  assert.equal(identities([a, b])[0].card.name, '甲');
  assert.equal(identities([none, b, a])[0].card.name, '乙');
  assert.equal(identities([none])[0].card, null);
});

test('machines of different identities make one card each, in the order they first appear', () => {
  const a = member('a', { profiles: [rec(ME, '我', 1)] });
  const b = member('b', { author: OTHER_ME, profiles: [rec(OTHER_ME, '另一个我', 8)] });
  const c = member('c', { profiles: [rec(ME, '我', 2)] });
  const found = identities([a, b, c]);
  assert.deepEqual(found.map(i => [i.author, i.card.name, i.members.map(m => m.id)]), [[ME, '我', ['a', 'c']], [OTHER_ME, '另一个我', ['b']]]);
  // 一台的名片库里别的作者的记录（好友的）不算它自己的名片。
  assert.equal(identities([member('d', { profiles: [rec(PAL, '好友', 99)] })])[0].card, null);
});

test('machines that are unread, or have no identity, do not join the others', () => {
  const none = member('n', { author: null, entry: { spec: {}, status: { certificate: null } } });
  assert.deepEqual(identities([member('a', { loaded: false }), none]).map(i => [i.author, i.members.map(m => m.id)]), [[null, ['n']]]);
});

test('a machine whose Accord could not be read is shown as such, with no rows', () => {
  const sections = friendSections([member('a', { loaded: false, accordProblem: '读不到本机的好友信息：boom' }), member('b')]);
  assert.deepEqual(sections.map(s => [s.unreachable, s.rows.length]), [['读不到本机的好友信息：boom', 0], [null, 0]]);
});

test('the signer is the first machine of the identity whose certificate can sign, else the first', () => {
  const stale = { spec: { author: ME }, status: { certificate: { active: false } } };
  const a = member('a', { entry: stale }), b = member('b'), c = member('c');
  assert.equal(identities([a, b, c])[0].signer.id, 'b');
  assert.equal(identities([c, b, a])[0].signer.id, 'c');
  assert.equal(identities([a, member('d', { entry: stale })])[0].signer.id, 'a');
});

test('each machine gets its own section, in view order, with its own friends and notes; the same friend on two machines shows twice', () => {
  const friend = node => ({ node, author: PAL, bound: true });
  const a = member('a', { friends: [friend('n1')], profiles: [rec(PAL, '阿青', 1)], notes: { n1: '老青' } });
  const b = member('b', { friends: [friend('n1'), { node: 'n2', author: KEY(4) }], profiles: [rec(PAL, '阿青', 1)] });
  const lonely = member('c');
  const sections = friendSections([a, b, lonely]);
  assert.deepEqual(sections.map(s => s.title), ['A', 'B', 'C']);
  assert.deepEqual(sections[0].rows.map(r => [r.node, r.title]), [['n1', '老青']]);
  assert.deepEqual(sections[1].rows.map(r => [r.node, r.title]).sort(), [['n1', '阿青'], ['n2', '好友 44444444']]);
  assert.deepEqual(sections[2].rows, []);
  assert.equal(sections[0].member, a);
  assert.equal(sections[1].rows.find(r => r.node === 'n1').note, '', 'the note is A\'s own');
});

test('with a single member there is no section title', () => {
  assert.deepEqual(friendSections([member('a')]).map(s => s.title), [null]);
});

test('an unreachable member keeps its section with the reason and no rows, and the others are unaffected', () => {
  const down = member('b', { unreachable: '离线 3 小时', loaded: false, friends: [{ node: 'x', author: PAL, bound: true }] });
  const sections = friendSections([member('a', { friends: [{ node: 'n1', author: PAL, bound: true }] }), down]);
  assert.deepEqual(sections.map(s => [s.title, s.unreachable, s.rows.length]), [['A', null, 1], ['B', '离线 3 小时', 0]]);
});
