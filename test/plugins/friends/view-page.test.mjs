import assert from 'node:assert/strict';
import { test } from 'node:test';
import { identiconPattern } from '../../../plugins/friends/lib/avatar.mjs';
import { identityTitle } from '../../../plugins/friends/lib/nickname.mjs';
import { deferred, flush, openPage } from '../view-dom.mjs';

const A = { id: 'a', name: 'A' }, B = { id: 'b', name: 'B' }, C = { id: 'c', name: 'C' };
const AUTHOR = `ed25519:${'ab'.repeat(32)}`, ME2 = `ed25519:${'ef'.repeat(32)}`;
const FRIEND = `ed25519:${'12'.repeat(32)}`, OTHER = `ed25519:${'34'.repeat(32)}`, THIRD = `ed25519:${'56'.repeat(32)}`;
const SVG_NS = 'http://www.w3.org/2000/svg';
const entry = { type: 'MODIFIED', entry: { spec: { author: AUTHOR }, status: { friends: [] } } };
const accord = status => ({ type: 'MODIFIED', entry: { spec: { author: AUTHOR }, status: { friends: [], ...status } } });

// 严格多机的 window.coda：不指明 machine 的调用直接拒绝；记下每次发往哪台。页面不查询 Accord 记录、不发消息给模块，有就是回归。
function strictCoda({ watch, call, machines = [A] } = {}) {
  const log = { calls: [], watches: [], copied: [], queries: [], messages: [], toolbars: [] };
  const coda = {
    machine: A, machines, getState: () => ({}), setState() {}, on() {}, copy: async text => { log.copied.push(text); },
    toolbar: async items => { log.toolbars.push(items); }, header: async () => {},
    async postMessage(msg) { log.messages.push(msg); },
    watch(kind, cb, selector, options) { log.watches.push({ cb, machine: options?.machine }); return watch ? watch(options?.machine) : Promise.resolve({ dispose() {} }); },
    async query(target, op, params) { log.queries.push({ target, op, params }); return { records: [] }; },
    async call(target, op, input, options) {
      if (!options?.machine) throw new Error('这一页有几台机器，call 须指明 machine');
      log.calls.push({ op, input, machine: options.machine });
      return call ? call(input, options) : {};
    },
  };
  return { coda, log };
}
async function open(t, options) {
  const { coda, log } = strictCoda(options);
  const page = await openPage(t, 'plugins/friends/view/app.mjs', coda);
  await flush();
  return { page, log };
}

// 假 DOM 里 class 属性与 className 分开存：h() 写的是属性，页面后来改的是 className。
const cls = n => n.className || n.attrs.class || '';
const scrims = page => page.all(n => cls(n) === 'scrim'); // 好友详情、添加好友
const buttonIn = (page, node, label) => page.all(n => n.tag === 'button' && n.textContent === label, node)[0];
const tiles = page => page.all(n => n.tag === 'button' && cls(n).startsWith('f-tile'));
const heroes = page => page.all(n => n.tag === 'section' && cls(n).startsWith('hero'));
const sectionTitles = page => page.all(n => n.tag === 'h2' && cls(n) === 'sec').map(n => n.children[0]);
const addButtons = page => page.all(n => n.tag === 'button' && n.textContent === '添加好友');
const callsOf = (log, op) => log.calls.filter(c => c.op === op).map(c => [c.input, c.machine]);
const feed = (log, machine, status, author = AUTHOR) => log.watches.find(w => w.machine === machine).cb({ type: 'MODIFIED', entry: { spec: { author }, status: { friends: [], ...status } } });
const identiconCells = (page, node) => page.all(n => n.tag === 'rect', page.all(n => n.tag === 'svg', node)[0]).length;

test('the hero shows the key-derived nickname, the identicon and the key code, with no card editing, and the status strip shows the counts and certificate', async t => {
  const { page, log } = await open(t);
  assert.ok(heroes(page)[0].textContent.includes('读取中…'));
  const friends = [{ node: 'n1', author: FRIEND, bound: true }, { node: 'n2', author: OTHER }, { node: 'n3', author: THIRD, conflict: true }];
  log.watches[0].cb(accord({ certificate: { active: true, until: Date.UTC(2030, 0, 2, 3, 4) }, friends }));
  await flush();
  const [hero] = heroes(page);
  for (const part of [identityTitle(AUTHOR), '我的身份', 'ed25519:abababab', '1 位已互认', '1 冲突', '1 待互认', '可发布', '证书有效至']) assert.ok(hero.textContent.includes(part), part);
  assert.match(identityTitle(AUTHOR), / #\d{4}$/);
  const icon = page.all(n => n.tag === 'svg', hero)[0];
  assert.equal(icon.namespaceURI, SVG_NS);
  assert.equal(identiconCells(page, hero), identiconPattern(AUTHOR).flat().filter(Boolean).length);
  assert.equal(cls(page.all(n => cls(n).startsWith('av '), hero)[0]), 'av lg k-identicon');
  for (const gone of ['编辑名片', '更换头像', '还没有名片']) assert.ok(!page.text().includes(gone), gone);
  assert.deepEqual(page.all(n => n.tag === 'input' && ['file', 'text'].includes(n.attrs.type) && !n.attrs.placeholder), []);
  buttonIn(page, hero, 'ed25519:abababab… · 复制').fire('click');
  await flush();
  assert.deepEqual(log.copied, [AUTHOR]);
  assert.ok(heroes(page)[0].textContent.includes('公钥已复制'));

  log.watches[0].cb(accord({ certificate: { active: false } }));
  await flush();
  for (const part of ['需要证书', '代签证书', '0 位已互认', '还没有好友']) assert.ok(heroes(page)[0].textContent.includes(part), part);
  log.watches[0].cb({ type: 'MODIFIED', entry: { spec: {}, status: { certificate: null, friends: [] } } });
  await flush();
  const text = heroes(page)[0].textContent;
  assert.ok(text.includes('未建身份') && text.includes('设置 › 身份') && text.includes('还没有 Accord 身份'));
  assert.ok(!text.includes('ed25519:') && !text.includes('还没有名片'));
});

test('the page reads only the local Accord entry: it asks for no profile or card records, sends no module messages, and has no refresh toolbar', async t => {
  const { page, log } = await open(t);
  log.watches[0].cb(accord({ friends: [{ node: 'n1', author: FRIEND, bound: true }] }));
  await flush();
  assert.deepEqual(log.queries, []);
  assert.deepEqual(log.messages, []);
  assert.deepEqual(log.toolbars, []);
  assert.equal(tiles(page).length, 1);
});

test('a friend is titled by the nickname of their key and gets its identicon, built as SVG nodes; a pending friend without a key shows the node name and a first-character mark', async t => {
  const { page, log } = await open(t);
  log.watches[0].cb(accord({ friends: [{ node: 'n1', author: FRIEND, bound: true }, { node: 'qing-mac', bound: false, updatedAt: 1 }] }));
  await flush();
  const [pending, bound] = tiles(page);
  assert.ok(bound.textContent.includes(identityTitle(FRIEND)) && bound.textContent.includes('@12121212') && bound.textContent.includes('已互认'));
  const icon = page.all(n => n.tag === 'svg', bound)[0];
  assert.equal(icon.namespaceURI, SVG_NS);
  const cells = page.all(n => n.tag === 'rect', icon);
  assert.equal(cells.length, identiconPattern(FRIEND).flat().filter(Boolean).length);
  assert.ok(cells.every(cell => cell.namespaceURI === SVG_NS));
  assert.deepEqual(page.all(n => n.tag === 'img', bound), []);
  assert.ok(pending.textContent.includes('qing-mac') && pending.textContent.includes('密钥未互认') && pending.textContent.includes('待互认'));
  assert.equal(page.all(n => cls(n) === 'av sm k-monogram', pending)[0].textContent, 'Q');
  assert.deepEqual(page.all(n => n.tag === 'img'), []);
});

test('the friend detail shows the derived nickname, identicon, full key and status, re-handshakes, and removes only after a second confirmation; it has no note field', async t => {
  const { page, log } = await open(t);
  log.watches[0].cb(accord({ friends: [{ node: 'n1', author: FRIEND, bound: true, peerNode: 'qing-mac' }] }));
  await flush();
  tiles(page)[0].fire('click');
  const detail = scrims(page)[0];
  assert.equal(detail.hidden, false);
  for (const part of [identityTitle(FRIEND), FRIEND, 'qing-mac', '已互认']) assert.ok(detail.textContent.includes(part), part);
  assert.equal(identiconCells(page, detail), identiconPattern(FRIEND).flat().filter(Boolean).length);
  for (const gone of ['本机备注', '保存', '清空', '原名']) assert.ok(!detail.textContent.includes(gone), gone);
  assert.deepEqual(page.all(n => n.tag === 'input', detail), []);
  buttonIn(page, detail, '复制公钥').fire('click');
  await flush();
  assert.deepEqual(log.copied, [FRIEND]);

  buttonIn(page, detail, '重新互认').fire('click');
  await flush();
  assert.deepEqual(log.calls.map(c => [c.op, c.input, c.machine]), [['handshake', { node: 'n1', peerNode: 'qing-mac' }, 'a']]);
  assert.ok(detail.textContent.includes('互认完成'));

  buttonIn(page, detail, '移除好友…').fire('click');
  assert.ok(!log.calls.some(c => c.op === 'remove'), 'one click does not remove');
  buttonIn(page, detail, '再想想').fire('click');
  assert.ok(!detail.textContent.includes('确认移除'));
  buttonIn(page, detail, '移除好友…').fire('click');
  buttonIn(page, detail, '确认移除').fire('click');
  await flush();
  assert.deepEqual(log.calls.filter(c => c.op === 'remove').map(c => [c.input.node, c.machine]), [['n1', 'a']]);
  assert.equal(detail.hidden, true);
});

test('a conflicting friend is flagged in the detail, and a failed handshake says why', async t => {
  const { page, log } = await open(t, { call: () => { throw new Error('对方不在线'); } });
  log.watches[0].cb(accord({ friends: [{ node: 'n1', author: FRIEND, bound: true, conflict: true }] }));
  await flush();
  tiles(page)[0].fire('click');
  const detail = scrims(page)[0];
  assert.ok(detail.textContent.includes('密钥与之前互认的不一致'));
  buttonIn(page, detail, '重新互认').fire('click');
  await flush();
  assert.ok(detail.textContent.includes('互认失败：对方不在线'));
});

test('the add-friend dialog clears the auth key the moment it is submitted, then accepts and handshakes', async t => {
  const gate = deferred();
  const { page, log } = await open(t, { call: input => (input.control ? gate.promise : {}) });
  page.button('添加好友').fire('click');
  const invite = scrims(page)[1];
  assert.equal(invite.hidden, false);
  const authKey = page.all(n => n.tag === 'input' && n.attrs.type === 'password', invite)[0];
  page.all(n => n.attrs.placeholder === 'https://…', invite)[0].value = 'https://control.example';
  authKey.value = 'tskey-secret';
  buttonIn(page, invite, '接受邀请').fire('click');
  assert.equal(authKey.value, '', 'cleared before anything is awaited');
  gate.resolve({ node: 'n9' });
  await flush();
  assert.deepEqual(log.calls.map(c => c.op), ['accept', 'handshake']);
  assert.equal(log.calls[0].input.authKey, 'tskey-secret');
  assert.deepEqual(log.calls[1].input, { node: 'n9' });
  assert.ok(invite.textContent.includes('好友已添加并完成互认'));
  page.dispatch('keydown', { key: 'Escape' });
  assert.equal(invite.hidden, true);
  page.button('添加好友').fire('click');
  invite.fire('click');
  assert.equal(invite.hidden, true, 'a click on the backdrop closes it');
});

test('a pasted invite is recognised and accepted with its fields', async t => {
  const { page, log } = await open(t, { call: input => (input.control ? { node: 'n7' } : {}) });
  page.button('添加好友').fire('click');
  const invite = scrims(page)[1];
  const paste = page.all(n => n.tag === 'textarea', invite)[0];
  paste.value = JSON.stringify({ control: 'https://c.example', authKey: 'k', linkId: 'link-1', peerNode: 'p1' });
  paste.fire('input');
  assert.ok(invite.textContent.includes('已识别邀请'));
  buttonIn(page, invite, '接受邀请').fire('click');
  await flush();
  assert.deepEqual(callsOf(log, 'accept'), [[{ control: 'https://c.example', authKey: 'k', linkId: 'link-1', peerNode: 'p1' }, 'a']]);
  assert.deepEqual(callsOf(log, 'handshake'), [[{ node: 'n7', peerNode: 'p1' }, 'a']]);
});

// ---- 视图里有几台：页面都读，身份按公钥归组，好友按电脑分节 ----

test('every reachable machine is read, with its machine named; the page keeps no machine choice and shows no machine bar', async t => {
  const { page, log } = await open(t, { machines: [A, B, { id: 'c', name: 'C', unreachable: '离线 3 小时' }] });
  assert.deepEqual(log.watches.map(w => w.machine), ['a', 'b']);
  assert.deepEqual(page.all(n => n.tag === 'nav'), []);
  assert.deepEqual(page.all(n => n.tag === 'button' && n.attrs['aria-pressed'] !== undefined), []);
});

test('two machines of one identity show one hero; machines of two identities show one hero each', async t => {
  const { page, log } = await open(t, { machines: [A, B] });
  feed(log, 'a', {});
  feed(log, 'b', {});
  await flush();
  assert.equal(heroes(page).length, 1);
  assert.ok(heroes(page)[0].textContent.includes(identityTitle(AUTHOR)));
  feed(log, 'b', {}, ME2);
  await flush();
  assert.deepEqual(heroes(page).map(hero => [AUTHOR, ME2].find(author => hero.textContent.includes(identityTitle(author)))), [AUTHOR, ME2]);
});

test('the friends are split by machine, titled with the machine name; the same friend on two machines shows once per section', async t => {
  const { page, log } = await open(t, { machines: [A, B, C] });
  const friend = { node: 'n1', author: FRIEND, bound: true };
  feed(log, 'a', { friends: [friend] });
  feed(log, 'b', { friends: [friend, { node: 'n2', author: OTHER }] });
  feed(log, 'c', {});
  await flush();
  assert.deepEqual(sectionTitles(page), ['A', 'B', 'C']);
  const [a, b, c] = page.all(n => n.tag === 'section' && !cls(n).startsWith('hero'));
  assert.deepEqual([a, b, c].map(section => page.all(n => n.tag === 'button' && cls(n).startsWith('f-tile'), section).length), [1, 2, 0]);
  assert.equal(addButtons(page).length, 3, 'every machine, even one without friends, has its own add-friend');
  assert.ok(!c.textContent.includes('还没有好友') && !c.textContent.includes('位已互认'), 'a machine with no friends has only its add-friend');
  assert.deepEqual(page.all(n => n.tag === 'button', c).map(n => n.textContent), ['添加好友']);
  assert.ok(!a.textContent.includes('位已互认'), 'and nothing needs attention on A, so no status strip');
  assert.ok(b.textContent.includes('1 位已互认') && b.textContent.includes('1 待互认'), 'B has a pending friend, so its own strip shows');
});

test('a machine that cannot be read says why in its own section, with no add-friend, and the others carry on', async t => {
  const { page, log } = await open(t, { machines: [A, B, { id: 'c', name: 'C', unreachable: '离线 3 小时' }] });
  feed(log, 'a', { friends: [{ node: 'n1', author: FRIEND, bound: true }] });
  feed(log, 'b', {});
  await flush();
  assert.deepEqual(sectionTitles(page), ['A', 'B', 'C']);
  assert.ok(page.text().includes('C 读不到：离线 3 小时'));
  assert.equal(addButtons(page).length, 2);
  assert.equal(tiles(page).length, 1);
});

test('a machine whose Accord cannot be read says only why in its section, and the other shows normally', async t => {
  const { page, log } = await open(t, { machines: [A, B], watch: machine => (machine === 'a' ? Promise.reject(new Error('boom')) : Promise.resolve({ dispose() {} })) });
  feed(log, 'b', { friends: [{ node: 'n1', author: FRIEND, bound: true }] });
  await flush();
  const [a, b] = page.all(n => n.tag === 'section' && !cls(n).startsWith('hero'));
  assert.ok(a.textContent.includes('A：读不到本机的好友信息：boom'));
  assert.deepEqual(page.all(n => n.tag === 'button', a), [], 'no add-friend, no status strip, no friends on the failed machine');
  assert.ok(!a.textContent.includes('还没有好友') && !a.textContent.includes('位已互认'));
  assert.equal(page.all(n => n.tag === 'button' && n.textContent === '添加好友', b).length, 1);
  assert.equal(tiles(page).length, 1);
  assert.equal(heroes(page).length, 1, 'the failed machine takes no part in the grouping');
});

test('when every machine\'s Accord cannot be read, the hero and its key line both say so instead of staying on loading', async t => {
  const { page } = await open(t, { machines: [A, B], watch: () => Promise.reject(new Error('boom')) });
  await flush();
  const [hero] = heroes(page);
  assert.equal(heroes(page).length, 1);
  assert.ok(hero.textContent.includes('读不到身份') && hero.textContent.includes('读不到公钥'));
  assert.ok(!hero.textContent.includes('读取中…'));
});

test('with one machine there is no machine title and the add-friend and status stay on the hero', async t => {
  const { page, log } = await open(t, { machines: [A] });
  feed(log, 'a', {});
  await flush();
  assert.deepEqual(sectionTitles(page), ['好友']);
  assert.ok(!page.text().includes('读不到：'));
  assert.equal(addButtons(page).length, 1);
  assert.equal(addButtons(page)[0].attrs.class, 'pill strong');
  assert.ok(heroes(page)[0].textContent.includes('添加好友') && heroes(page)[0].textContent.includes('0 位已互认'));
});

test('an invite accepted in a section, and the handshake after it, go to that section\'s machine only', async t => {
  const { page, log } = await open(t, { machines: [A, B], call: input => (input.control ? { node: 'n9' } : {}) });
  feed(log, 'a', {});
  feed(log, 'b', {});
  await flush();
  addButtons(page)[1].fire('click');
  const invite = scrims(page)[1];
  assert.ok(invite.textContent.includes('添加好友 · B'));
  page.all(n => n.attrs.placeholder === 'https://…', invite)[0].value = 'https://control.example';
  page.all(n => n.tag === 'input' && n.attrs.type === 'password', invite)[0].value = 'key';
  buttonIn(page, invite, '接受邀请').fire('click');
  await flush();
  assert.deepEqual(log.calls.map(c => [c.op, c.machine]), [['accept', 'b'], ['handshake', 'b']]);
  assert.ok(invite.textContent.includes('好友已添加并完成互认'));
});

test('a friend\'s re-handshake and removal go to the machine of the row, even when the other machine has the same node', async t => {
  const { page, log } = await open(t, { machines: [A, B] });
  const friend = { node: 'n1', author: FRIEND, bound: true, peerNode: 'qing-mac' };
  feed(log, 'a', { friends: [friend] });
  feed(log, 'b', { friends: [friend] });
  await flush();
  assert.equal(tiles(page).length, 2);
  tiles(page)[1].fire('click');
  const detail = scrims(page)[0];
  assert.ok(detail.textContent.includes('B'));
  buttonIn(page, detail, '重新互认').fire('click');
  await flush();
  assert.deepEqual(callsOf(log, 'handshake'), [[{ node: 'n1', peerNode: 'qing-mac' }, 'b']]);
  buttonIn(page, detail, '移除好友…').fire('click');
  buttonIn(page, detail, '确认移除').fire('click');
  await flush();
  assert.deepEqual(callsOf(log, 'remove'), [[{ node: 'n1' }, 'b']]);
});
