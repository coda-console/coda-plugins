// 好友页按成员读数据的纯逻辑：成员列表、按身份归组、按电脑分节。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { friendSections, identities, listMembers, memberTitles } from '../../../plugins/friends/lib/view-members.mjs';
import { XS_A, XS_B, titleOf } from '../../helpers/accord-keys.mjs';

const KEY = n => `ed25519:${String(n).repeat(64)}`;
const ME = KEY(1), OTHER_ME = KEY(2), PAL = KEY(3);
const member = (id, over = {}) => ({ id, name: id.toUpperCase(), unreachable: null, entry: { spec: { author: ME }, status: { certificate: { active: true } } }, author: ME,
  friends: [], loaded: true, ...over });

test('listMembers keeps the view order, drops duplicates and ids that are not strings, and words the unreachable reason', () => {
  const coda = { machines: [{ id: 'a', name: 'Mac' }, { id: 'a', name: 'dup' }, { name: 'no id' }, { id: 'b' }, { id: 'c', name: 'nas', unreachable: '离线 3 小时' }, { id: 'd', unreachable: true }] };
  assert.deepEqual(listMembers(coda), [
    { id: 'a', name: 'Mac', unreachable: null }, { id: 'b', name: 'b', unreachable: null },
    { id: 'c', name: 'nas', unreachable: '离线 3 小时' }, { id: 'd', name: 'd', unreachable: '暂时连不上' }]);
  assert.deepEqual(listMembers({ machine: { id: 'solo', name: 'Solo' } }), [{ id: 'solo', name: 'Solo', unreachable: null }]);
});

test('machines of one identity make one group, in view order, whichever machine read first', () => {
  const [one, ...more] = identities([member('a'), member('b')]);
  assert.equal(more.length, 0);
  assert.deepEqual([one.author, one.members.map(m => m.id)], [ME, ['a', 'b']]);
  assert.deepEqual(Object.keys(one).sort(), ['author', 'members', 'signer'], 'no card is merged any more');
  assert.deepEqual(identities([member('b'), member('a')])[0].members.map(m => m.id), ['b', 'a']);
});

test('machines of different identities make one group each, in the order they first appear', () => {
  const found = identities([member('a'), member('b', { author: OTHER_ME }), member('c')]);
  assert.deepEqual(found.map(i => [i.author, i.members.map(m => m.id)]), [[ME, ['a', 'c']], [OTHER_ME, ['b']]]);
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

test('each machine gets its own section, in view order, with its own friends; the same friend on two machines shows twice', () => {
  const friend = node => ({ node, author: PAL, bound: true });
  const a = member('a', { friends: [friend('n1')] });
  const b = member('b', { friends: [friend('n1'), { node: 'n2', author: KEY(4) }] });
  const lonely = member('c');
  const sections = friendSections([a, b, lonely]);
  assert.deepEqual(sections.map(s => s.title), ['A', 'B', 'C']);
  assert.deepEqual(sections[0].rows.map(r => r.node), ['n1']);
  assert.deepEqual(sections[1].rows.map(r => r.node).sort(), ['n1', 'n2']);
  assert.deepEqual(sections[2].rows, []);
  assert.equal(sections[0].member, a);
  assert.equal(sections[0].rows[0].title, titleOf(PAL, 'n1'), 'titled from the key');
});

test('titles are worked out once for every identity on the page: a friend of one machine collides with the self or a friend of another', () => {
  const a = member('a', { author: XS_A, friends: [{ node: 'n1', author: PAL, bound: true }] }), b = member('b', { author: ME, friends: [{ node: 'n2', author: XS_B, bound: true }] });
  assert.deepEqual(friendSections([a, b]).map(s => s.rows.map(r => r.title)), [[titleOf(PAL)], ['xs #14084']]);
  assert.deepEqual([...memberTitles([a, b])].map(([author, title]) => [author, title]).filter(([, title]) => title.startsWith('xs')), [[XS_A, 'xs #04084'], [XS_B, 'xs #14084']]);
  assert.deepEqual(friendSections([b]).map(s => s.rows.map(r => r.title)), [['xs #4084']], 'alone it needs no extra digits');
  const c = member('c', { author: ME, friends: [{ node: 'n3', author: XS_A, bound: true }, { node: 'n4', author: XS_B, bound: true }] });
  assert.deepEqual(friendSections([c, a])[0].rows.map(r => r.title).sort(), ['xs #04084', 'xs #14084']);
});

test('with a single member there is no section title', () => {
  assert.deepEqual(friendSections([member('a')]).map(s => s.title), [null]);
});

test('an unreachable member keeps its section with the reason and no rows, and the others are unaffected', () => {
  const down = member('b', { unreachable: '离线 3 小时', loaded: false, friends: [{ node: 'x', author: PAL, bound: true }] });
  const sections = friendSections([member('a', { friends: [{ node: 'n1', author: PAL, bound: true }] }), down]);
  assert.deepEqual(sections.map(s => [s.title, s.unreachable, s.rows.length]), [['A', null, 1], ['B', '离线 3 小时', 0]]);
});

test('channels of one author on a machine make one row there; the same friend on another machine is still its own row in its own section', () => {
  const two = [{ node: 'link:1', author: PAL, bound: true, updatedAt: 1 }, { node: 'node:p', author: PAL, bound: true, updatedAt: 2 }];
  const sections = friendSections([member('a', { friends: two }), member('b', { friends: [two[0]] })]);
  assert.deepEqual(sections.map(s => s.rows.map(r => [r.node, r.channels.map(c => c.node)])), [[['node:p', ['node:p', 'link:1']]], [['link:1', ['link:1']]]]);
});
