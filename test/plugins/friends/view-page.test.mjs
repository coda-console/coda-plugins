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

// 严格多机的 window.coda：不指明 machine 的调用直接拒绝；记下每次发往哪台。页面不查询 Accord 记录；给模块的消息只有「共享」一节的。
// 「共享」一节读写持有方的消息默认都答空；`share` 按消息类型换成自己的答复（返回值就是 value，抛错是明确的拒绝，永不返回是没有回应）。
const SHARE = { 'grants.list': () => ({ grants: [] }), 'proxies.list': () => [], 'ledger.list': () => [], 'grants.targets': () => [] };
function strictCoda(page, { silent, sendFail, watch, call, machines = [A], share = {}, inviteFriend, copy, friendNodes, removeFriendNode } = {}) {
  const log = { sent: [], calls: [], watches: [], copied: [], queries: [], toolbars: [], states: [], invites: [], nodes: [] };
  const coda = {
    machine: A, machines, getState: () => ({}), setState(state) { log.states.push(state); }, on() {},
    copy: async text => { if (copy) await copy(text); log.copied.push(text); },
    ...(friendNodes ? { friendNodes: async options => { log.nodes.push(['friendNodes', options]); return friendNodes(options); } } : {}),
    ...(removeFriendNode ? { removeFriendNode: async options => { log.nodes.push(['removeFriendNode', options]); return removeFriendNode(options); } } : {}),
    ...(inviteFriend ? { inviteFriend: async options => { log.invites.push(options); return inviteFriend(options); } } : {}),
    toolbar: async items => { log.toolbars.push(items); }, header: async () => {},
    async postMessage(msg, options) {
      if (!options?.machine) throw new Error('这一页有几台机器，postMessage 须指明 machine');
      if (sendFail?.(msg)) throw new Error('桥不可用');
      log.sent.push({ msg, machine: options.machine });
      const answer = { ...SHARE, ...share }[msg.type];
      if (answer && options.machine !== silent) setImmediate(async () => {
        let reply;
        try { reply = { ok: true, value: await answer(msg, options.machine) }; } catch (e) { reply = { ok: false, error: e.message, effects: e.effects, code: e.code }; }
        page.reply({ type: 'reply', rid: msg.rid, ...reply }, { id: options.machine });
      });
    },
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
// 页面要在 coda 之前建好 reply，所以先占位再接上。
async function open(t, options) {
  const holder = {};
  const { coda, log } = strictCoda({ reply: (...args) => holder.page.reply(...args) }, options);
  holder.page = await openPage(t, 'plugins/friends/view/app.mjs', coda);
  await flush();
  return { page: holder.page, log };
}

// 假 DOM 里 class 属性与 className 分开存：h() 写的是属性，页面后来改的是 className。
const cls = n => n.className || n.attrs.class || '';
const scrims = page => page.all(n => cls(n) === 'scrim'); // 好友详情、添加好友、授予选择框
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

test('the page reads only the local Accord entry: it asks for no profile or card records, sends no module messages until a friend detail opens, and has no refresh toolbar', async t => {
  const { page, log } = await open(t);
  log.watches[0].cb(accord({ friends: [{ node: 'n1', author: FRIEND, bound: true }] }));
  await flush();
  assert.deepEqual(log.queries, []);
  assert.deepEqual(log.sent, []);
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

// 添加好友弹层的接受表单：粘贴区与分字段的输入框。邀请带一次性口令 bindingToken，口令不进任何输入框。
const TOKEN_TEXT = 'bt-once-7f3a91c2d0e8';
const inviteJson = (extra = {}) => JSON.stringify({ control: 'https://control.example', authKey: 'tskey-secret', bindingToken: TOKEN_TEXT, peerNode: 'node-5d2a8f', ...extra });
const acceptForm = (page, scrim) => ({
  paste: page.all(n => n.tag === 'textarea', scrim)[0],
  control: page.all(n => n.attrs.placeholder === 'https://…', scrim)[0],
  authKey: page.all(n => n.tag === 'input' && n.attrs.type === 'password', scrim)[0],
  peerNode: page.all(n => n.tag === 'input' && n.attrs.placeholder === '可选', scrim)[0],
  inputs: page.all(n => n.tag === 'input', scrim), // 粘贴区装着用户自己贴的整份邀请，另外断言它提交后是空的

  submit: buttonIn(page, scrim, '接受邀请'),
});
const pasteInvite = (form, text) => { form.paste.value = text; form.paste.fire('input'); };
// 后端的替身：照 main 上的规则，bindingToken 缺 peerNode 时拒。
const backend = (accept = () => ({ node: 'n9' })) => input => {
  if (input.control === undefined) return {};
  if (input.bindingToken && !input.peerNode) throw Object.assign(new Error('invalid_input'), { effects: 'none' });
  return accept(input);
};
const everywhere = (page, log, form) => [page.text(), ...form.inputs.map(n => n.value), JSON.stringify(log.states), JSON.stringify(log.sent), JSON.stringify(log.copied)].join('\n');

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
  const form = acceptForm(page, invite);
  pasteInvite(form, inviteJson());
  assert.equal(form.authKey.value, 'tskey-secret', 'the paste is recognized into the fields');
  form.submit.fire('click');
  assert.equal(form.authKey.value, '', 'cleared before anything is awaited');
  assert.equal(form.paste.value, '');
  gate.resolve({ node: 'n9' });
  await flush();
  assert.deepEqual(log.calls.map(c => c.op), ['accept', 'handshake']);
  assert.equal(log.calls[0].input.authKey, 'tskey-secret');
  assert.deepEqual(log.calls[1].input, { node: 'n9', peerNode: 'node-5d2a8f' });
  assert.ok(invite.textContent.includes('好友已添加并完成互认'));
  page.dispatch('keydown', { key: 'Escape' });
  assert.equal(invite.hidden, true);
  page.button('添加好友').fire('click');
  invite.fire('click');
  assert.equal(invite.hidden, true, 'a click on the backdrop closes it');
});

test('accept carries the invite\'s bindingToken to the local backend, and afterwards it is nowhere: not in the form, the page or its state', async t => {
  const gate = deferred();
  const { page, log } = await open(t, { call: backend(() => gate.promise) });
  page.button('添加好友').fire('click');
  const invite = scrims(page)[1], form = acceptForm(page, invite);
  pasteInvite(form, inviteJson({ scope: 'coda-tailnet/https://control.example', hostname: 'h1', peerPort: 8443 }));
  assert.ok(invite.textContent.includes('已识别邀请'));
  assert.ok(!everywhere(page, log, form).includes(TOKEN_TEXT), 'the recognized invite does not show the token, and no box holds it');
  form.submit.fire('click');
  assert.equal(form.paste.value, '');
  assert.ok(!everywhere(page, log, form).includes(TOKEN_TEXT), 'gone before the call has answered');
  gate.resolve({ node: 'n9' });
  await flush();
  const accept = log.calls.find(c => c.op === 'accept');
  assert.deepEqual([accept.input.bindingToken, accept.input.peerNode, accept.input.control, accept.input.authKey, accept.input.hostname, accept.input.peerPort],
    [TOKEN_TEXT, 'node-5d2a8f', 'https://control.example', 'tskey-secret', 'h1', 8443]);
  assert.deepEqual(log.calls.filter(c => c.op === 'handshake').map(c => c.input), [{ node: 'n9', peerNode: 'node-5d2a8f' }], 'the handshake does not carry the token');
  assert.ok(invite.textContent.includes('好友已添加并完成互认'));
  assert.ok(!everywhere(page, log, form).includes(TOKEN_TEXT));
  // 交出后再点一次：口令已经不在，不会再交出一次。
  form.submit.fire('click');
  await flush();
  assert.equal(log.calls.filter(c => c.op === 'accept').length, 1);
  assert.ok(invite.textContent.includes('请粘贴对方给你的完整邀请'));
});

test('when accept fails the token is cleared and not shown in the error either, and it is not handed out a second time', async t => {
  let fail = true;
  const { page, log } = await open(t, { call: backend(() => { if (fail) throw new Error('forbidden'); return { node: 'n9' }; }) });
  page.button('添加好友').fire('click');
  const invite = scrims(page)[1], form = acceptForm(page, invite);
  pasteInvite(form, inviteJson());
  form.submit.fire('click');
  await flush();
  assert.ok(invite.textContent.includes('接受邀请失败：forbidden'));
  assert.equal(form.paste.value, '');
  assert.ok(!everywhere(page, log, form).includes(TOKEN_TEXT));
  assert.equal(form.authKey.value, '');
  fail = false;
  form.submit.fire('click');
  await flush();
  assert.equal(log.calls.filter(c => c.op === 'accept').length, 1, 'a second click has no token to hand out');
  assert.ok(invite.textContent.includes('请粘贴对方给你的完整邀请'));
  pasteInvite(form, inviteJson({ bindingToken: 'bt-second' }));
  form.submit.fire('click');
  await flush();
  assert.deepEqual(log.calls.filter(c => c.op === 'accept').map(c => c.input.bindingToken), [TOKEN_TEXT, 'bt-second']);
});

test('a paste without a bindingToken, or with one but no peerNode, is refused with the reason and nothing is sent', async t => {
  const { page, log } = await open(t, { call: backend() });
  page.button('添加好友').fire('click');
  const invite = scrims(page)[1], form = acceptForm(page, invite);
  pasteInvite(form, JSON.stringify({ control: 'https://control.example', authKey: 'tskey-secret', peerNode: 'p' }));
  assert.ok(invite.textContent.includes('邀请缺少 bindingToken（一次性口令），请让对方重新生成邀请'));
  form.submit.fire('click');
  await flush();
  assert.ok(invite.textContent.includes('邀请缺少 bindingToken（一次性口令），请让对方重新生成邀请'));
  pasteInvite(form, JSON.stringify({ control: 'https://control.example', authKey: 'tskey-secret', bindingToken: TOKEN_TEXT }));
  assert.ok(invite.textContent.includes('peerNode'));
  assert.ok(!invite.textContent.includes(TOKEN_TEXT));
  form.submit.fire('click');
  await flush();
  assert.ok(invite.textContent.includes('peerNode') && !invite.textContent.includes(TOKEN_TEXT));
  assert.deepEqual(log.calls, []);
});

test('an empty form offers no field-by-field entry and asks for the whole invite; a recognized paste opens the fields and is accepted', async t => {
  const { page, log } = await open(t, { call: backend() });
  page.button('添加好友').fire('click');
  const invite = scrims(page)[1], form = acceptForm(page, invite), fields = page.all(n => cls(n) === 'fields', invite)[0];
  assert.ok(!invite.textContent.includes('分字段填写') && !page.all(n => n.tag === 'details' || n.tag === 'summary', invite).length, 'no entry for filling the fields by hand');
  assert.equal(fields.hidden, true);
  assert.ok(invite.textContent.includes('请粘贴对方给你的完整邀请'));
  assert.ok(!page.all(n => n.tag === 'input' && /口令|token/i.test(n.attrs.placeholder ?? ''), invite).length, 'there is no box for the token');
  form.submit.fire('click');
  await flush();
  assert.deepEqual(log.calls, []);
  assert.equal(invite.textContent.match(/请粘贴对方给你的完整邀请/g).length, 2, 'submitting the empty form asks for the invite');
  pasteInvite(form, inviteJson());
  assert.equal(fields.hidden, false, 'the recognized invite opens the fields to check');
  assert.equal(form.control.value, 'https://control.example');
  form.submit.fire('click');
  await flush();
  assert.equal(log.calls.find(c => c.op === 'accept').input.bindingToken, TOKEN_TEXT);
  assert.equal(fields.hidden, true, 'closed again once handed out');
  // 粘贴区有内容、还没识别：提交时再解析一次，口令随这份邀请。
  form.paste.value = inviteJson({ bindingToken: 'bt-unparsed' });
  form.submit.fire('click');
  await flush();
  assert.deepEqual(log.calls.filter(c => c.op === 'accept').map(c => c.input.bindingToken), [TOKEN_TEXT, 'bt-unparsed']);
});

test('a new paste replaces the old token, and editing the control address or the auth key drops it', async t => {
  const { page, log } = await open(t, { call: backend() });
  page.button('添加好友').fire('click');
  const invite = scrims(page)[1], form = acceptForm(page, invite);
  const accepted = () => log.calls.filter(c => c.op === 'accept').map(c => c.input.bindingToken);
  pasteInvite(form, inviteJson({ bindingToken: 'bt-old' }));
  pasteInvite(form, inviteJson({ bindingToken: 'bt-new' }));
  form.submit.fire('click');
  await flush();
  assert.deepEqual(accepted(), ['bt-new']);
  // 手改入网地址：另一份邀请，旧口令不再交出（输入框里的旧邀请也不会被当成手填的再读一遍）。
  pasteInvite(form, inviteJson({ bindingToken: 'bt-edit-control' }));
  form.control.value = 'https://other.example';
  form.control.fire('input');
  form.submit.fire('click');
  await flush();
  assert.deepEqual(accepted(), ['bt-new'], 'nothing was handed out');
  assert.ok(invite.textContent.includes('邀请缺少 bindingToken（一次性口令），请让对方重新生成邀请'));
  // 手改入网码同理。
  pasteInvite(form, inviteJson({ bindingToken: 'bt-edit-key' }));
  form.authKey.value = 'tskey-other';
  form.authKey.fire('input');
  form.submit.fire('click');
  await flush();
  assert.deepEqual(accepted(), ['bt-new']);
  assert.ok(!everywhere(page, log, form).includes('bt-edit-control') && !everywhere(page, log, form).includes('bt-edit-key'));
  // 改 peerNode：口令只该交给邀请指定的那一台，口令与粘贴原文一起丢掉，新节点拿不到旧口令。
  pasteInvite(form, inviteJson({ bindingToken: 'bt-same' }));
  form.peerNode.value = 'node-other';
  form.peerNode.fire('input');
  assert.equal(form.paste.value, '');
  form.submit.fire('click');
  await flush();
  assert.deepEqual(accepted(), ['bt-new'], 'nothing was handed out');
  assert.ok(invite.textContent.includes('邀请缺少 bindingToken（一次性口令），请让对方重新生成邀请'));
  assert.ok(!everywhere(page, log, form).includes('bt-same'));
});

test('editing the control address or the auth key drops the pasted text and the token with it: clearing both fields cannot bring the old invite back', async t => {
  const { page, log } = await open(t, { call: backend() });
  page.button('添加好友').fire('click');
  const invite = scrims(page)[1], form = acceptForm(page, invite);
  for (const edited of ['control', 'authKey']) {
    pasteInvite(form, inviteJson());
    form[edited].value = 'changed';
    form[edited].fire('input');
    assert.equal(form.paste.value, '', `${edited}: the pasted text is gone`);
  }
  pasteInvite(form, inviteJson());
  form.control.value = '';
  form.control.fire('input');
  form.authKey.value = '';
  form.authKey.fire('input');
  form.submit.fire('click');
  await flush();
  assert.deepEqual(log.calls, [], 'nothing is parsed out of the old text and sent');
  assert.ok(!everywhere(page, log, form).includes(TOKEN_TEXT));
});

test('once a paste is recognized into the fields the fields rule: a field that fails validation is reported and the pasted text is not submitted instead', async t => {
  const { page, log } = await open(t, { call: backend() });
  page.button('添加好友').fire('click');
  const invite = scrims(page)[1], form = acceptForm(page, invite);
  const linkId = page.all(n => n.tag === 'input' && n.attrs.placeholder === '留空自动生成', invite)[0];
  pasteInvite(form, inviteJson());
  form.peerNode.value = '';
  form.submit.fire('click');
  await flush();
  assert.deepEqual(log.calls, []);
  assert.ok(invite.textContent.includes('peerNode'));
  pasteInvite(form, inviteJson());
  linkId.value = 'Bad ID!';
  form.submit.fire('click');
  await flush();
  assert.deepEqual(log.calls, []);
  assert.ok(invite.textContent.includes('linkId'));
  assert.ok(!everywhere(page, log, form).includes(TOKEN_TEXT));
  linkId.value = 'mine-1';
  form.submit.fire('click');
  await flush();
  assert.deepEqual(log.calls.filter(c => c.op === 'accept').map(c => c.input.linkId), ['mine-1'], 'fixing the field lets the same invite through');
});

test('a new paste that is not recognized drops the fields of the last one, and submitting reports this paste\'s own error', async t => {
  const { page, log } = await open(t, { call: backend() });
  page.button('添加好友').fire('click');
  const invite = scrims(page)[1], form = acceptForm(page, invite);
  pasteInvite(form, inviteJson());
  assert.equal(form.control.value, 'https://control.example');
  pasteInvite(form, JSON.stringify({ control: 'https://other.example', authKey: 'tskey-other', bindingToken: TOKEN_TEXT }));
  assert.deepEqual([form.control.value, form.authKey.value, form.peerNode.value], ['', '', ''], 'the last invite\'s fields are gone');
  form.submit.fire('click');
  await flush();
  assert.deepEqual(log.calls, [], 'neither the old nor the new invite is sent');
  assert.ok(invite.textContent.includes('peerNode') && !invite.textContent.includes('缺少 control'));
  assert.ok(!everywhere(page, log, form).includes(TOKEN_TEXT));
});

test('while the accept call is pending the page holds no token: not in the form, the text or its state', async t => {
  const gate = deferred();
  const { page, log } = await open(t, { call: backend(() => gate.promise) });
  page.button('添加好友').fire('click');
  const invite = scrims(page)[1], form = acceptForm(page, invite);
  pasteInvite(form, inviteJson());
  form.submit.fire('click');
  await flush();
  assert.equal(log.calls.filter(c => c.op === 'accept').length, 1, 'the call is out and unanswered');
  assert.ok(invite.textContent.includes('正在接受邀请'));
  assert.ok(!everywhere(page, log, form).includes(TOKEN_TEXT));
  gate.reject(new Error('boom'));
  await flush();
  assert.ok(!everywhere(page, log, form).includes(TOKEN_TEXT));
});

test('re-handshake from the friend detail only calls handshake with the node: no accept, no token, no invite asked for again', async t => {
  const { page, log } = await open(t, { call: backend() });
  page.button('添加好友').fire('click');
  const invite = scrims(page)[1], form = acceptForm(page, invite);
  pasteInvite(form, inviteJson());
  form.submit.fire('click');
  await flush();
  page.dispatch('keydown', { key: 'Escape' });
  log.calls.length = 0;
  log.watches[0].cb(accord({ friends: [{ node: 'n9', author: FRIEND, bound: false, peerNode: 'node-5d2a8f' }] }));
  await flush();
  tiles(page)[0].fire('click');
  const detail = scrims(page)[0];
  buttonIn(page, detail, '重新互认').fire('click');
  await flush();
  assert.deepEqual(log.calls.map(c => [c.op, c.input, c.machine]), [['handshake', { node: 'n9', peerNode: 'node-5d2a8f' }, 'a']]);
  assert.ok(!everywhere(page, log, form).includes(TOKEN_TEXT));
  assert.equal(form.paste.value, '', 'and the invite form was not asked to be filled again');
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
  pasteInvite(acceptForm(page, invite), inviteJson());
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

// ---- 添加好友：邀请对方与接受对方的邀请 ----

const INVITE = '{"control":"https://control.example","authKey":"hskey-auth-secret","scope":"coda-tailnet/https://control.example","peerNode":"node-5d2a8f"}';
const isVisible = scrim => scrim.hidden === false;
// 持有方明确拒绝（什么也没写），与「不确定写没写」的错误不同。
const refusal = message => Object.assign(new Error(message), { effects: 'none' });
const bridgeError = (code, message) => Object.assign(new Error(message), { code });
const blocksOf = (page, scrim) => page.all(n => n.tag === 'section' && cls(n) === 'blk', scrim);

test('the add-friend dialog has the two blocks in fixed places: whatever the generate state, the invite block keeps its slots and the accept form is not touched', async t => {
  let outcome = () => new Promise(() => {});
  const { page, log } = await open(t, { inviteFriend: () => outcome() });
  page.button('添加好友').fire('click');
  const invite = scrims(page)[1];
  const [top, bottom] = blocksOf(page, invite);
  assert.deepEqual(top.children.map(n => n.textContent.slice(0, 8)).slice(0, 2), ['邀请对方', '生成一段邀请发给']);
  assert.equal(bottom.children[0].textContent, '接受对方的邀请');
  assert.ok(!invite.textContent.includes('后续将支持客户端一键生成邀请'), 'the old sentence is gone');
  const slots = () => top.children.map(n => `${n.tag}.${cls(n)}`), acceptSnapshot = [...bottom.children], generate = page.button('生成邀请'), result = top.children[3];
  const idleSlots = slots();
  const stable = () => {
    assert.deepEqual(slots(), idleSlots, 'the invite block keeps its slots');
    assert.deepEqual(blocksOf(page, invite), [top, bottom], 'the two blocks are the same two nodes');
    assert.ok(bottom.children.length === acceptSnapshot.length && bottom.children.every((n, i) => n === acceptSnapshot[i]), 'the accept form is untouched');
    assert.equal(top.children[3], result, 'the result area is one node whose content changes');
    assert.ok(page.all(n => n === generate, top).length === 1, 'and so is the one button');
  };
  stable();
  assert.equal(generate.disabled, false);
  assert.equal(result.textContent, '');

  // 生成中：按钮禁用，结果区写「正在生成…」（确认框由客户端弹）。
  const first = deferred();
  outcome = () => first.promise;
  generate.fire('click');
  stable();
  assert.deepEqual([generate.disabled, generate.textContent, result.textContent], [true, '生成邀请', '正在生成…']);
  generate.fire('click');
  assert.equal(log.invites.length, 1, 'a second click while generating does nothing');
  // 已生成：整段邀请，一行「复制」和有效期；按钮变「再生成一个」。
  first.resolve({ text: INVITE, expires: 1795600000000, machine: 'a', space: 's' });
  await flush();
  stable();
  assert.deepEqual([generate.disabled, generate.textContent], [false, '再生成一个']);
  assert.ok(result.textContent.includes(INVITE) && result.textContent.includes('24 小时内有效，只能用一次'));
  assert.ok(buttonIn(page, result, '复制'));
  // 失败：结果区写错误消息，按钮「重试」。
  outcome = () => Promise.reject(bridgeError('service_unavailable', '控制服务器没有应答'));
  generate.fire('click');
  await flush();
  stable();
  assert.deepEqual([generate.disabled, generate.textContent, result.textContent], [false, '重试', '控制服务器没有应答']);
  assert.ok(!page.text().includes('hskey-auth-secret'), 'a new try drops the old invite');
  // 在确认框里取消：回到空闲，不显示错误。
  outcome = () => Promise.reject(bridgeError('canceled', '已取消'));
  generate.fire('click');
  await flush();
  stable();
  assert.deepEqual([generate.disabled, generate.textContent, result.textContent], [false, '生成邀请', '']);
  assert.deepEqual(log.invites, [{ machine: 'a' }, { machine: 'a' }, { machine: 'a' }], 'asks for the machine of the section it was opened from');
});

test('without window.coda.inviteFriend the generate button is disabled and says to open the page in the Coda client', async t => {
  const { page, log } = await open(t);
  page.button('添加好友').fire('click');
  const invite = scrims(page)[1], [top] = blocksOf(page, invite);
  const generate = page.button('生成邀请');
  assert.equal(generate.disabled, true);
  assert.equal(top.children[3].textContent, '请在 Coda 客户端里打开好友页来生成邀请');
  generate.fire('click');
  await flush();
  assert.deepEqual(log.invites, []);
  assert.equal(generate.disabled, true);
});

test('the generated invite is shown once: copied through coda.copy, kept in no page state, and gone when the dialog closes, even for a result that arrives after', async t => {
  let outcome = () => Promise.resolve({ text: INVITE });
  const { page, log } = await open(t, { inviteFriend: () => outcome() });
  page.button('添加好友').fire('click');
  const invite = scrims(page)[1], [top] = blocksOf(page, invite);
  page.button('生成邀请').fire('click');
  await flush();
  assert.ok(top.textContent.includes(INVITE));
  buttonIn(page, top, '复制').fire('click');
  await flush();
  assert.deepEqual(log.copied, [INVITE]);
  assert.ok(buttonIn(page, top, '已复制'));
  assert.deepEqual(log.states, [], 'setState is never called');
  page.dispatch('keydown', { key: 'Escape' });
  assert.equal(invite.hidden, true);
  assert.ok(!page.text().includes('hskey-auth-secret'), 'closed: the invite is gone from the page');
  page.button('添加好友').fire('click');
  assert.equal(top.children[3].textContent, '');
  assert.equal(page.button('生成邀请').textContent, '生成邀请');

  // 生成还没回来就关掉弹层：迟到的结果不再显示。
  const late = deferred();
  outcome = () => late.promise;
  page.button('生成邀请').fire('click');
  page.dispatch('keydown', { key: 'Escape' });
  late.resolve({ text: INVITE });
  await flush();
  page.button('添加好友').fire('click');
  assert.ok(!page.text().includes('hskey-auth-secret'));
  assert.equal(top.children[3].textContent, '');
  assert.deepEqual(log.states, []);
});

// ---- 好友详情里的「共享」 ----

const GRANT_KIND = 'remote-exec/machine@1';
const grantRow = (grant, over = {}) => ({ grant, friend: FRIEND, target: { kind: GRANT_KIND, id: `rx-${grant}`, name: `机器 ${grant}` }, createdAt: 1, status: 'available', ...over });
const TARGETS = [{ id: 'rx-1', name: '书房的 Mac mini', os: 'Darwin 24.2.0', user: 'leavan', available: true, restrictHint: true }, { id: 'rx-2', name: '阳台的树莓派', os: 'Debian 12', user: 'pi', available: false, restrictHint: false },
  { id: 'rx-3', name: '车库的 Linux', os: 'Ubuntu 24.04', user: 'coda', available: true, restrictHint: false }];
// 打开好友详情（好友在第一台上、已绑定），返回详情与授予选择框。
async function openShare(t, { certified = true, ...options } = {}) {
  const { page, log } = await open(t, options);
  log.watches[0].cb(accord({ friends: [{ node: 'n1', author: FRIEND, bound: true, ...(certified === 'absent' ? {} : { certified }) }] }));
  await flush();
  tiles(page)[0].fire('click');
  await flush();
  return { page, log, detail: scrims(page)[0], picker: scrims(page)[2] };
}
const listRows = (page, node) => page.all(n => n.tag === 'li' && cls(n) === 'g-row', node);
const badgeOf = (page, row) => page.all(n => cls(n).startsWith('badge'), row)[0].textContent;
const kebabOf = (page, row) => page.all(n => n.tag === 'button' && cls(n) === 'kebab', row)[0];
const slotsOfRow = row => row.children.map(n => `${n.tag}.${cls(n).split(' ')[0]}`);
const sentOf = (log, type) => log.sent.filter(s => s.msg.type === type);
// 选机器后出范围表单；「整台机器」是默认，点「授予」才发（整台机器走原来的先显示授予中）。
const confirmButton = (page, picker, label = '授予') => page.all(n => n.tag === 'button' && n.textContent === label, picker)[0];
const grantOn = (page, picker, name) => { chooseTarget(page, picker, name).fire('click'); confirmButton(page, picker).fire('click'); };
const chooseTarget = (page, picker, name) => page.all(n => n.tag === 'button' && cls(n) === 'pick' && n.textContent.startsWith(name), picker)[0];
// 超过 1 秒的定时器（模块回应的 10 秒期限、后台恢复的间隔）交给测试手动拨。
function stubTimers(t) {
  const real = globalThis.setTimeout, timers = [];
  globalThis.setTimeout = (fn, ms, ...args) => (ms >= 1000 ? (timers.push({ fn, ms }), { unref() {} }) : real(fn, ms, ...args));
  t.after(() => { globalThis.setTimeout = real; });
  return { has: ms => timers.some(one => one.ms === ms), fire: ms => { const [one] = timers.splice(timers.findLastIndex(x => x.ms === ms), 1); one.fn(); } };
}

test('the sharing section sits above the re-handshake / remove row and is titled with the machine; both lists and the operations have their own empty text', async t => {
  const { page, detail } = await openShare(t);
  const stack = page.all(n => cls(n) === 'stack', detail)[0], order = stack.children.map(cls);
  assert.ok(order.includes('share') && order.includes('actions split'));
  assert.equal(order.indexOf('share') + 1, order.indexOf('actions split'), 'right above the action row');
  const share = stack.children[order.indexOf('share')], actions = stack.children[order.indexOf('actions split')];
  assert.deepEqual(page.all(n => n.tag === 'button', actions).map(n => n.textContent), ['重新互认', '移除好友…']);
  assert.deepEqual(page.all(n => n.tag === 'button' && ['重新互认', '移除好友…'].includes(n.textContent), share), []);
  assert.equal(share.children[0].textContent, '共享 · A', 'the machine is named, also when there is only one');
  for (const part of ['我授给 TA', 'TA 授给我', '还没有授给 TA 的东西', 'TA 还没有授给你东西', '最近的操作']) assert.ok(share.textContent.includes(part), part);
});

test('the granting dialog starts by only picking a record (the scope comes after the choice): the line under each row follows the friend\'s identity (person, machine, or unknown: none)', async t => {
  for (const [certified, line] of [[true, '授给这个人名下的机器'], [false, '只授给对方那一台机器'], [null, null], ['absent', null]]) {
    const { page, picker } = await openShare(t, { certified, share: { 'grants.targets': () => TARGETS } });
    assert.equal(isVisible(picker), false);
    page.button('授予…').fire('click');
    await flush();
    assert.equal(isVisible(picker), true);
    assert.deepEqual(page.all(n => ['select', 'input', 'option', 'textarea'].includes(n.tag) || n.attrs['aria-pressed'] !== undefined || n.attrs.type === 'radio', picker), [], 'nothing to choose but the record');
    const rows = page.all(n => n.tag === 'button' && cls(n) === 'pick', picker);
    assert.equal(rows.length, 3);
    for (const row of rows) assert.equal(row.textContent.includes('授给这个人名下的机器') || row.textContent.includes('只授给对方那一台机器'), line !== null, `${certified}: ${row.textContent}`);
    if (line) assert.ok(rows.every(row => row.textContent.includes(line)));
    assert.ok(rows[0].textContent.includes('书房的 Mac mini') && rows[0].textContent.includes('Darwin 24.2.0 · leavan'));
    assert.ok('disabled' in rows[1].attrs && rows[1].textContent.includes('远程执行没打开'));
    assert.ok(!('disabled' in rows[0].attrs));
    page.dispatch('keydown', { key: 'Escape' });
    assert.equal(isVisible(picker), false, 'Escape closes only the picker');
    assert.equal(isVisible(scrims(page)[0]), true, 'the friend detail stays');
  }
});

test('granting shows the row granting at once; the answer settles it, a refusal rolls it back with the reason on that row', async t => {
  const gate = deferred();
  let grant = () => gate.promise;
  const { page, log, detail, picker } = await openShare(t, { share: { 'grants.targets': () => TARGETS, 'grants.grant': () => grant() } });
  page.button('授予…').fire('click');
  await flush();
  grantOn(page, picker, '书房的 Mac mini');
  assert.equal(isVisible(picker), false, 'the picker closes with the click');
  let [row] = listRows(page, detail);
  assert.equal(listRows(page, detail).length, 1);
  assert.ok(row.textContent.includes('书房的 Mac mini') && row.textContent.includes('授给这个人名下的机器'));
  assert.equal(badgeOf(page, row), '授予中');
  assert.ok('disabled' in kebabOf(page, row).attrs, 'busy: nothing to press, and it says so on the row');
  await flush();
  assert.deepEqual(sentOf(log, 'grants.grant').map(s => [s.msg.friend, s.msg.target, s.machine]), [[FRIEND, { kind: GRANT_KIND, id: 'rx-1' }, 'a']]);
  gate.resolve(grantRow('g1', { target: { kind: GRANT_KIND, id: 'rx-1', name: '书房的 Mac mini' } }));
  await flush();
  [row] = listRows(page, detail);
  assert.equal(badgeOf(page, row), '可用');
  assert.ok(!('disabled' in kebabOf(page, row).attrs));
  // 已授出的，选择框里不能再选。
  page.button('授予…').fire('click');
  await flush();
  assert.ok(chooseTarget(page, picker, '书房的 Mac mini').textContent.includes('已授给 TA') && 'disabled' in chooseTarget(page, picker, '书房的 Mac mini').attrs);
  const refuse = deferred();
  grant = () => refuse.promise;
  page.dispatch('keydown', { key: 'Escape' });
  page.button('授予…').fire('click');
  await flush();
  grantOn(page, picker, '车库的 Linux');
  await flush();
  refuse.reject(refusal('这位不是已绑定好友通道的好友'));
  await flush();
  assert.deepEqual(listRows(page, detail).map(row => badgeOf(page, row)), ['可用', '未授予']);
  const denied = () => listRows(page, detail)[1];
  assert.ok(denied().textContent.includes('这位不是已绑定好友通道的好友'), 'the reason is on that row');
  assert.ok(!listRows(page, detail)[0].textContent.includes('这位不是'), 'the other row is left alone');
  assert.ok(!('disabled' in kebabOf(page, denied()).attrs));
  kebabOf(page, denied()).fire('click');
  page.all(n => n.tag === 'button' && n.attrs.role === 'menuitem' && n.textContent === '移除', detail)[0].fire('click');
  assert.deepEqual(listRows(page, detail).map(row => badgeOf(page, row)), ['可用']);
});

test('revoking changes the row to revoking at once with no confirmation; a refusal puts it back with the reason; the grant goes once the holder says it is revoked', async t => {
  const timers = stubTimers(t);
  let revoke = () => Promise.reject(refusal('没有授权 g1')), listed = [grantRow('g1'), grantRow('g2', { status: 'target_off' })];
  const { page, log, detail } = await openShare(t, { share: { 'grants.list': () => ({ grants: listed }), 'grants.revoke': () => revoke() } });
  const rows = () => listRows(page, detail);
  assert.deepEqual(rows().map(row => badgeOf(page, row)), ['可用', '目标已关闭']);
  const kebab = kebabOf(page, rows()[0]);
  assert.equal(kebab.attrs['aria-label'], '更多操作：机器 g1');
  kebab.fire('click');
  const item = () => page.all(n => n.tag === 'button' && n.attrs.role === 'menuitem' && n.textContent.startsWith('撤销'), rows()[0])[0];
  assert.ok(item().textContent.includes('撤销') && item().textContent.includes('同时取消对方正在跑的调用'), 'the menu item explains it');
  item().fire('click');
  // 这一刻（还没有任何回应）就是撤销中；没有确认框。
  assert.equal(badgeOf(page, rows()[0]), '撤销中');
  assert.ok('disabled' in kebabOf(page, rows()[0]).attrs);
  assert.deepEqual(scrims(page).filter(isVisible), [detail], 'no confirmation dialog');
  assert.ok(!page.text().includes('确认撤销'));
  await flush();
  assert.deepEqual(sentOf(log, 'grants.revoke').map(s => [s.msg.grant, s.machine]), [['g1', 'a']]);
  // 被明确拒绝：回到原来的状态，原因写在这一行，别的行不动。
  assert.equal(badgeOf(page, rows()[0]), '可用');
  assert.ok(rows()[0].textContent.includes('没有授权 g1') && !rows()[1].textContent.includes('没有授权'));
  // 再撤一次，这回成功：持有方说撤销中（名下的调用还在取消），行保持撤销中，直到读到已撤。
  revoke = () => ({ ...grantRow('g1'), status: 'revoking', revokedAt: 5 });
  kebabOf(page, rows()[0]).fire('click');
  item().fire('click');
  await flush();
  assert.equal(badgeOf(page, rows()[0]), '撤销中');
  assert.ok(!rows()[0].textContent.includes('没有授权 g1'), 'the old reason is gone');
  listed = [{ ...grantRow('g1'), status: 'revoked', revokedAt: 5 }, grantRow('g2', { status: 'target_off' })];
  assert.ok(timers.has(3000), 'it keeps reading in the background while something is revoking');
  timers.fire(3000);
  await flush();
  assert.deepEqual(rows().map(row => row.textContent.includes('机器 g2')), [true]);
});

test('a grant with no answer stays granting and keeps its target taken: a list that does not show it yet is not a refusal, no second grant goes out, and a late answer or the list settles it', async t => {
  const timers = stubTimers(t);
  let listed = [], late = deferred();
  const { page, log, detail, picker } = await openShare(t, { share: { 'grants.targets': () => TARGETS, 'grants.list': () => ({ grants: listed }), 'grants.grant': () => late.promise } });
  const grant = async name => {
    page.button('授予…').fire('click');
    await flush();
    grantOn(page, picker, name);
    await flush();
    timers.fire(10_000);
    await flush();
  };
  await grant('车库的 Linux');
  const badges = () => listRows(page, detail).map(row => badgeOf(page, row));
  assert.deepEqual(badges(), ['授予中'], 'the local choice stays');
  // 读不到它：不算被拒，仍是授予中，目标仍占着，也发不出第二笔。
  timers.fire(3000);
  await flush();
  assert.deepEqual(badges(), ['授予中']);
  assert.ok(timers.has(3000), 'it keeps looking');
  page.button('授予…').fire('click');
  await flush();
  const taken = chooseTarget(page, picker, '车库的 Linux');
  assert.ok('disabled' in taken.attrs && taken.textContent.includes('已授给 TA'));
  taken.fire('click');
  await flush();
  assert.equal(sentOf(log, 'grants.grant').length, 1, 'no second grant while the first has no outcome');
  // 回应晚到了：就是它的结果。
  late.resolve(grantRow('g9', { target: { kind: GRANT_KIND, id: 'rx-3', name: '车库的 Linux' } }));
  await flush();
  assert.deepEqual(badges(), ['可用']);
  page.dispatch('keydown', { key: 'Escape' });
  // 回应迟迟不来、但持有方那边已经有了：读到就是授出了。
  late = deferred();
  await grant('书房的 Mac mini');
  assert.deepEqual(badges(), ['可用', '授予中']);
  listed = [grantRow('g9', { target: { kind: GRANT_KIND, id: 'rx-3', name: '车库的 Linux' } }), grantRow('g8', { target: { kind: GRANT_KIND, id: 'rx-1', name: '书房的 Mac mini' } })];
  timers.fire(3000);
  await flush();
  assert.deepEqual(badges(), ['可用', '可用']);
  assert.ok(!timers.has(3000), 'nothing left to recover');
});

test('a late refusal ends a granting that had no answer, with the reason on its row; a retry replaces the failure with one row and clears it once confirmed', async t => {
  const timers = stubTimers(t);
  let grant = () => late.promise, late = deferred();
  const { page, detail, picker } = await openShare(t, { share: { 'grants.targets': () => TARGETS, 'grants.grant': () => grant() } });
  const choose = async () => {
    page.button('授予…').fire('click');
    await flush();
    grantOn(page, picker, '车库的 Linux');
    await flush();
  };
  await choose();
  timers.fire(10_000);
  await flush();
  late.reject(refusal('这位不是已绑定好友通道的好友'));
  await flush();
  const rows = () => listRows(page, detail);
  assert.deepEqual(rows().map(row => badgeOf(page, row)), ['未授予']);
  assert.ok(rows()[0].textContent.includes('这位不是已绑定好友通道的好友'));
  // 重试：还是只有一行；确认成功后旧的失败也不在了。
  const retry = deferred();
  grant = () => retry.promise;
  await choose();
  assert.deepEqual(rows().map(row => [badgeOf(page, row), row.textContent.includes('这位不是')]), [['授予中', false]], 'one row, the old failure replaced');
  retry.resolve(grantRow('g7', { target: { kind: GRANT_KIND, id: 'rx-3', name: '车库的 Linux' } }));
  await flush();
  assert.deepEqual(rows().map(row => [badgeOf(page, row), row.textContent.includes('这位不是')]), [['可用', false]]);
  assert.ok(!detail.textContent.includes('未授予'));
});

test('a grant whose message could not be sent is a plain failure: the row rolls back with the reason, the target is selectable again, and the retry goes out', async t => {
  const timers = stubTimers(t);
  let broken = true;
  const { page, log, detail, picker } = await openShare(t, { sendFail: msg => broken && msg.type === 'grants.grant', share: { 'grants.targets': () => TARGETS, 'grants.grant': () => grantRow('g5', { target: { kind: GRANT_KIND, id: 'rx-3', name: '车库的 Linux' } }) } });
  const choose = async () => {
    page.button('授予…').fire('click');
    await flush();
    grantOn(page, picker, '车库的 Linux');
    await flush();
  };
  await choose();
  const rows = () => listRows(page, detail);
  assert.deepEqual(rows().map(row => badgeOf(page, row)), ['未授予']);
  assert.ok(rows()[0].textContent.includes('发送失败：桥不可用'));
  assert.ok(!timers.has(3000), 'nothing to recover: it did not reach the holder');
  page.button('授予…').fire('click');
  await flush();
  assert.ok(!('disabled' in chooseTarget(page, picker, '车库的 Linux').attrs), 'the target can be chosen again');
  page.dispatch('keydown', { key: 'Escape' });
  broken = false;
  await choose();
  assert.equal(sentOf(log, 'grants.grant').length, 1, 'only the retry reached the holder');
  assert.deepEqual(rows().map(row => badgeOf(page, row)), ['可用']);
});

test('a grant with no answer stays granting through the first lists that do not show it; after three such lists it rolls back with the reason, the target is selectable again, and the retry leaves the holder with one grant', async t => {
  const timers = stubTimers(t);
  const held = [];
  let listed = [], lost = true;
  const { page, log, detail, picker } = await openShare(t, { share: { 'grants.targets': () => TARGETS, 'grants.list': () => ({ grants: [...held, ...listed] }),
    'grants.grant': () => {
      if (lost) return deferred().promise;
      // 持有方对同一目标的授予幂等：已有就给回那一条。
      if (!held.length) held.push(grantRow('g8', { target: { kind: GRANT_KIND, id: 'rx-3', name: '车库的 Linux' } }));
      return held[0];
    } } });
  const choose = async () => {
    page.button('授予…').fire('click');
    await flush();
    grantOn(page, picker, '车库的 Linux');
    await flush();
  };
  await choose();
  timers.fire(10_000);
  await flush();
  const rows = () => listRows(page, detail);
  for (let round = 0; round < 2; round++) {
    timers.fire(3000);
    await flush();
  }
  assert.deepEqual(rows().map(row => badgeOf(page, row)), ['授予中']);
  assert.ok(timers.has(3000), 'it keeps looking');
  page.button('授予…').fire('click');
  await flush();
  const taken = chooseTarget(page, picker, '车库的 Linux');
  assert.ok('disabled' in taken.attrs && taken.textContent.includes('已授给 TA'));
  taken.fire('click');
  await flush();
  assert.equal(sentOf(log, 'grants.grant').length, 1, 'no second grant while it may still land');
  // 第三遍列表仍没有它：回滚，写明原因，不再轮询。
  timers.fire(3000);
  await flush();
  assert.deepEqual(rows().map(row => [badgeOf(page, row), row.textContent.includes('没有确认授予成功，请重试')]), [['未授予', true]]);
  assert.ok(!timers.has(3000), 'polling stopped');
  // 目标重新可选，重试发出；持有方那边只有一条。
  page.button('授予…').fire('click');
  await flush();
  assert.ok(!('disabled' in chooseTarget(page, picker, '车库的 Linux').attrs), 'the target can be chosen again');
  page.dispatch('keydown', { key: 'Escape' });
  lost = false;
  await choose();
  assert.equal(sentOf(log, 'grants.grant').length, 2, 'the retry went out');
  assert.deepEqual(rows().map(row => badgeOf(page, row)), ['可用']);
  assert.deepEqual(held.map(row => row.grant), ['g8'], 'one grant on the holder');
});

test('a grant rolled back as not confirmed that did land afterwards: the next list shows it available only, the not-granted row is gone', async t => {
  const timers = stubTimers(t);
  let listed = [];
  const { page, detail, picker } = await openShare(t, { share: { 'grants.targets': () => TARGETS, 'grants.list': () => ({ grants: listed }), 'grants.grant': () => deferred().promise } });
  page.button('授予…').fire('click');
  await flush();
  grantOn(page, picker, '车库的 Linux');
  await flush();
  timers.fire(10_000);
  await flush();
  const rows = () => listRows(page, detail);
  for (let round = 0; round < 3; round++) {
    timers.fire(3000);
    await flush();
  }
  assert.deepEqual(rows().map(row => badgeOf(page, row)), ['未授予']);
  listed = [grantRow('g8', { target: { kind: GRANT_KIND, id: 'rx-3', name: '车库的 Linux' } })];
  // 回滚后不再轮询；再打开这位好友，读到列表。
  page.dispatch('keydown', { key: 'Escape' });
  await flush();
  tiles(page)[0].fire('click');
  await flush();
  assert.deepEqual(rows().map(row => badgeOf(page, row)), ['可用']);
});

test('a revoke whose message could not be sent is a plain failure: the row is usable again with the reason, and is not retried in the background', async t => {
  const timers = stubTimers(t);
  let broken = true;
  const { page, log, detail } = await openShare(t, { sendFail: msg => broken && msg.type === 'grants.revoke', share: { 'grants.list': () => ({ grants: [grantRow('g1')] }), 'grants.revoke': () => ({ ...grantRow('g1'), status: 'revoking', revokedAt: 5 }) } });
  const rows = () => listRows(page, detail);
  kebabOf(page, rows()[0]).fire('click');
  const item = () => page.all(n => n.tag === 'button' && n.attrs.role === 'menuitem' && n.textContent.startsWith('撤销'), rows()[0])[0];
  item().fire('click');
  await flush();
  assert.equal(badgeOf(page, rows()[0]), '可用');
  assert.ok(rows()[0].textContent.includes('发送失败：桥不可用'));
  assert.ok(!('disabled' in kebabOf(page, rows()[0]).attrs));
  assert.ok(!timers.has(3000));
  broken = false;
  kebabOf(page, rows()[0]).fire('click');
  item().fire('click');
  await flush();
  assert.equal(sentOf(log, 'grants.revoke').length, 1);
  assert.equal(badgeOf(page, rows()[0]), '撤销中');
});

test('a revoke with no outcome is resent only a few times while the list keeps showing the grant usable; then it stops, says it is unconfirmed, and can be revoked again by hand', async t => {
  const timers = stubTimers(t);
  let revoked = 0;
  const { page, detail } = await openShare(t, { share: { 'grants.list': () => ({ grants: [grantRow('g1')] }), 'grants.revoke': () => { revoked++; throw new Error('写盘时出错'); } } });
  const rows = () => listRows(page, detail);
  const revoke = async () => {
    kebabOf(page, rows()[0]).fire('click');
    page.all(n => n.tag === 'button' && n.attrs.role === 'menuitem' && n.textContent.startsWith('撤销'), rows()[0])[0].fire('click');
    await flush();
  };
  await revoke();
  assert.equal(badgeOf(page, rows()[0]), '撤销中');
  for (let round = 0; round < 3; round++) {
    timers.fire(3000);
    await flush();
  }
  assert.equal(revoked, 3, 'the cap stops the automatic resending');
  assert.equal(badgeOf(page, rows()[0]), '可用');
  assert.ok(rows()[0].textContent.includes('撤销没有确认'));
  assert.ok(!('disabled' in kebabOf(page, rows()[0]).attrs), 'it can be revoked by hand');
  assert.ok(!timers.has(3000), 'nothing left to recover');
  // 手动再撤：重新开始计数。
  await revoke();
  assert.equal(revoked, 4);
  assert.equal(badgeOf(page, rows()[0]), '撤销中');
  assert.ok(timers.has(3000), 'the retry is followed again');
});

test('a revoke whose error does not say nothing was written stays revoking and is checked against the holder, never rolled back to usable', async t => {
  const timers = stubTimers(t);
  let listed = [grantRow('g1')], revoked = 0;
  const { page, log, detail } = await openShare(t, { share: { 'grants.list': () => ({ grants: listed }), 'grants.revoke': () => { revoked++; throw new Error('写盘时出错'); } } });
  const badges = () => listRows(page, detail).map(row => badgeOf(page, row));
  kebabOf(page, listRows(page, detail)[0]).fire('click');
  page.all(n => n.tag === 'button' && n.attrs.role === 'menuitem' && n.textContent.startsWith('撤销'), detail)[0].fire('click');
  await flush();
  assert.deepEqual(badges(), ['撤销中']);
  assert.ok(!detail.textContent.includes('写盘时出错'), 'not shown as a refusal');
  // 核对：持有方那边还可用，就再发一次；已经在撤销中，就不用再发。
  timers.fire(3000);
  await flush();
  assert.equal(revoked, 2, 'still usable at the holder: sent again');
  assert.deepEqual(badges(), ['撤销中']);
  listed = [{ ...grantRow('g1'), status: 'revoking', revokedAt: 5 }];
  timers.fire(3000);
  await flush();
  assert.equal(revoked, 2, 'already revoking at the holder: not sent again');
  assert.deepEqual(badges(), ['撤销中']);
  listed = [{ ...grantRow('g1'), status: 'revoked', revokedAt: 5 }];
  timers.fire(3000);
  await flush();
  assert.deepEqual(badges(), []);
  assert.equal(sentOf(log, 'grants.revoke').length, 2);
});

test('a list that was asked before a write and arrives after it does not overwrite the confirmed grant or revoke; it is read again', async t => {
  let hold = null, reads = 0, listed = [grantRow('g1')];
  const { page, detail, picker } = await openShare(t, { share: { 'grants.targets': () => TARGETS,
    'grants.list': () => { reads++; return hold ? hold.promise : { grants: listed }; },
    'grants.grant': () => { listed = [...listed, grantRow('g2', { target: { kind: GRANT_KIND, id: 'rx-3', name: '车库的 Linux' } })]; return listed[1]; },
    'grants.revoke': () => { listed = listed.map(g => (g.grant === 'g1' ? { ...g, status: 'revoked', revokedAt: 5 } : g)); return listed[0]; } } });
  const badges = () => listRows(page, detail).map(row => badgeOf(page, row));
  const reopen = async () => { page.button('完成').fire('click'); tiles(page)[0].fire('click'); await flush(); };
  assert.deepEqual(badges(), ['可用']);
  // 授予：列表在授予之前发出，授予确认了它才回来，回来的是旧的。
  hold = deferred();
  await reopen();
  page.button('授予…').fire('click');
  await flush();
  grantOn(page, picker, '车库的 Linux');
  await flush();
  assert.deepEqual(badges(), ['可用', '可用']);
  const before = reads;
  hold.resolve({ grants: [grantRow('g1')] });
  hold = null;
  await flush();
  assert.deepEqual(badges(), ['可用', '可用'], 'the old list did not wipe the confirmed grant');
  assert.equal(reads, before + 1, 'and it was read again');
  // 撤销：同样，撤掉的不会被旧列表读回来。
  hold = deferred();
  await reopen();
  kebabOf(page, listRows(page, detail)[0]).fire('click');
  page.all(n => n.tag === 'button' && n.attrs.role === 'menuitem' && n.textContent.startsWith('撤销'), detail)[0].fire('click');
  await flush();
  assert.deepEqual(badges(), ['可用'], 'g1 is gone, g2 stays');
  const latest = reads;
  hold.resolve({ grants: [grantRow('g1'), grantRow('g2', { target: { kind: GRANT_KIND, id: 'rx-3', name: '车库的 Linux' } })] });
  hold = null;
  await flush();
  assert.deepEqual(badges(), ['可用'], 'the revoked one stays gone');
  assert.equal(reads, latest + 1);
});

test('a holder fault is shown as a fault: no empty text, no granting, and the list is not used to settle a pending grant', async t => {
  const timers = stubTimers(t);
  let list = () => ({ grants: [] });
  const { page, detail, picker } = await openShare(t, { share: { 'grants.targets': () => TARGETS, 'grants.list': () => list(), 'grants.grant': () => new Promise(() => {}) } });
  page.button('授予…').fire('click');
  await flush();
  grantOn(page, picker, '车库的 Linux');
  await flush();
  timers.fire(10_000);
  await flush();
  list = () => ({ corrupt: true, grants: [] });
  timers.fire(3000);
  await flush();
  assert.ok(detail.textContent.includes('持有方出了故障'));
  assert.ok(!detail.textContent.includes('还没有授给 TA 的东西'));
  assert.ok('disabled' in page.button('授予…').attrs, 'no granting');
  assert.ok(timers.has(3000), 'the pending grant is still being looked after');
  list = () => ({ grants: [grantRow('g9', { target: { kind: GRANT_KIND, id: 'rx-3', name: '车库的 Linux' } })] });
  timers.fire(3000);
  await flush();
  assert.ok(!detail.textContent.includes('持有方出了故障'));
  assert.deepEqual(listRows(page, detail).map(row => badgeOf(page, row)), ['可用']);
  assert.ok(!('disabled' in page.button('授予…').attrs));
});

test('a grant read as revoking when the detail opens is followed until its state changes', async t => {
  const timers = stubTimers(t);
  let listed = [{ ...grantRow('g1'), status: 'revoking', revokedAt: 5 }];
  const { page, detail } = await openShare(t, { share: { 'grants.list': () => ({ grants: listed }) } });
  assert.deepEqual(listRows(page, detail).map(row => badgeOf(page, row)), ['撤销中']);
  assert.ok(timers.has(3000), 'the recovery timer is on from the read itself');
  timers.fire(3000);
  await flush();
  assert.ok(timers.has(3000), 'still revoking: it keeps going');
  listed = [{ ...grantRow('g1'), status: 'revoked', revokedAt: 5 }];
  timers.fire(3000);
  await flush();
  assert.deepEqual(listRows(page, detail), []);
  assert.ok(!timers.has(3000), 'and stops');
});

test('rows keep one shape in every state: the info, one badge, and one slot at the end that is the menu button for what can be revoked', async t => {
  const gate = deferred();
  const { page, detail, picker } = await openShare(t, { share: { 'grants.targets': () => TARGETS, 'grants.grant': () => gate.promise, 'grants.list': () => ({ grants: [grantRow('g1'), grantRow('g2', { status: 'target_off' }), grantRow('g3', { status: 'revoking', revokedAt: 1 })] }),
    'proxies.list': () => [{ key: 'k1', grant: 'p1', holder: FRIEND, name: '客厅的 Linux@小周', os: 'linux', user: 'u', status: 'available' }, { key: 'k2', grant: 'p2', holder: FRIEND, name: '工作室的 Mac@小周', os: 'm', user: 'u', status: 'off' }] } });
  page.button('授予…').fire('click');
  await flush();
  grantOn(page, picker, '车库的 Linux');
  const mine = listRows(page, detail).slice(0, 4);
  assert.deepEqual(mine.map(row => badgeOf(page, row)), ['可用', '目标已关闭', '撤销中', '授予中']);
  const shapes = mine.map(row => slotsOfRow(row).join(' '));
  assert.ok(shapes.every(shape => shape === 'div.g-info span.badge button.kebab'), shapes.join(' | '));
  assert.ok(mine.every(row => page.all(n => n.tag === 'button', row).length === 1), 'only one button at the end of a row');
  await flush();
  gate.reject(new Error('不行'));
  await flush();
  assert.equal(slotsOfRow(listRows(page, detail)[3]).join(' '), 'div.g-info span.badge button.kebab', 'a refused one too');
  const theirs = listRows(page, detail).slice(4);
  assert.deepEqual(theirs.map(row => [page.all(n => cls(n).startsWith('g-name'), row)[0].textContent, badgeOf(page, row)]), [['客厅的 Linux@小周', '可用'], ['工作室的 Mac@小周', 'TA 那边没开远程执行']]);
  assert.ok(theirs.every(row => slotsOfRow(row).join(' ') === 'div.g-info span.badge span.kebab-slot'), 'what I cannot act on keeps the slot, with no button');
});

test('the recent operations are folded by default and read only when opened, as a summary: time, kind, command, outcome and duration', async t => {
  const ROWS = [
    { v: 1, at: Date.UTC(2026, 10, 24, 6, 32), request: 'r1', friend: FRIEND, grant: 'g1', target: { kind: GRANT_KIND, id: 'rx-1', name: 'box' }, op: 'exec', command: { summary: 'ls -la ~/projects', sha256: 'a'.repeat(64) }, outcome: 'completed', exitCode: 0, ms: 400 },
    { v: 1, at: Date.UTC(2026, 10, 24, 3, 8), request: 'r2', friend: FRIEND, grant: 'g1', target: { kind: GRANT_KIND, id: 'rx-1', name: 'box' }, op: 'exec', command: { summary: 'brew upgrade', sha256: 'b'.repeat(64) }, outcome: 'completed', exitCode: 1, ms: 38_000 },
    { v: 1, at: Date.UTC(2026, 10, 23, 13, 45), friend: FRIEND, outcome: 'rejected', code: 'no_grant', count: 3 }];
  const { page, log, detail } = await openShare(t, { share: { 'ledger.list': () => ROWS } });
  const folded = () => page.all(n => n.tag === 'details' && cls(n) === 'ops', detail)[0];
  assert.equal(folded().attrs.open, undefined, 'folded');
  assert.deepEqual(sentOf(log, 'ledger.list'), [], 'nothing read yet');
  assert.ok(!detail.textContent.includes('ls -la'));
  folded().open = true;
  folded().fire('toggle');
  await flush();
  assert.deepEqual(sentOf(log, 'ledger.list').map(s => [s.msg.friend, s.msg.limit, s.machine]), [[FRIEND, 20, 'a']]);
  assert.notEqual(folded().attrs.open, undefined, 'a redraw keeps it open');
  const text = folded().textContent;
  for (const part of ['ls -la ~/projects', '成功', '0.4 秒', 'brew upgrade', '失败（退出码 1）', '38 秒', 'no_grant × 3', '被拒绝', '完整记录：coda self ledger.list']) assert.ok(text.includes(part), part);
  assert.equal(page.all(n => cls(n) === 'op', folded()).length, 3);
});

test('the sharing section follows the machine of the friend row: titled with it, read from it and written to it, with each machine\'s own grants', async t => {
  const { page, log } = await open(t, { machines: [A, B], share: { 'grants.list': (msg, machine) => ({ grants: machine === 'a' ? [grantRow('ga')] : [grantRow('gb')] }), 'grants.revoke': () => grantRow('gb', { status: 'revoking', revokedAt: 1 }) } });
  const friend = { node: 'n1', author: FRIEND, bound: true, certified: true };
  feed(log, 'a', { friends: [friend] });
  feed(log, 'b', { friends: [friend] });
  await flush();
  tiles(page)[1].fire('click');
  await flush();
  const detail = scrims(page)[0];
  assert.equal(page.all(n => n.tag === 'h4' && n.textContent.startsWith('共享'), detail)[0].textContent, '共享 · B');
  assert.deepEqual(listRows(page, detail).map(row => row.textContent.includes('机器 gb')), [true]);
  assert.ok(!detail.textContent.includes('机器 ga'));
  assert.deepEqual(sentOf(log, 'grants.list').map(s => s.machine), ['b']);
  kebabOf(page, listRows(page, detail)[0]).fire('click');
  page.all(n => n.tag === 'button' && n.attrs.role === 'menuitem' && n.textContent.startsWith('撤销'), detail)[0].fire('click');
  await flush();
  assert.deepEqual(sentOf(log, 'grants.revoke').map(s => [s.msg.grant, s.machine]), [['gb', 'b']]);
  page.button('完成').fire('click');
  tiles(page)[0].fire('click');
  await flush();
  assert.equal(page.all(n => n.tag === 'h4' && n.textContent.startsWith('共享'), detail)[0].textContent, '共享 · A');
  assert.deepEqual(listRows(page, detail).map(row => row.textContent.includes('机器 ga')), [true]);
  assert.ok(!detail.textContent.includes('机器 gb'));
});

test('a list error that arrives after a write is dropped like a stale list: it does not hide the confirmed grant, and the list is read again', async t => {
  let hold = null, reads = 0, listed = [grantRow('g1')];
  const { page, detail, picker } = await openShare(t, { share: { 'grants.targets': () => TARGETS,
    'grants.list': () => { reads++; return hold ? hold.promise : { grants: listed }; },
    'grants.grant': () => { listed = [...listed, grantRow('g2', { target: { kind: GRANT_KIND, id: 'rx-3', name: '车库的 Linux' } })]; return listed[1]; } } });
  hold = deferred();
  page.button('完成').fire('click');
  tiles(page)[0].fire('click');
  await flush();
  page.button('授予…').fire('click');
  await flush();
  grantOn(page, picker, '车库的 Linux');
  await flush();
  const before = reads;
  hold.reject(new Error('读超时'));
  hold = null;
  await flush();
  assert.deepEqual(listRows(page, detail).map(row => badgeOf(page, row)), ['可用', '可用'], 'the confirmed grant is still shown');
  assert.ok(!detail.textContent.includes('读不到授权'));
  assert.equal(reads, before + 1, 'read again');
});

test('when a holder fault is found the open granting dialog closes, and a grant submitted from it afterwards is not sent', async t => {
  const timers = stubTimers(t);
  let list = () => ({ grants: [{ ...grantRow('g1'), status: 'revoking', revokedAt: 5 }] });
  const { page, log, picker } = await openShare(t, { share: { 'grants.targets': () => TARGETS, 'grants.list': () => list() } });
  page.button('授予…').fire('click');
  await flush();
  const row = chooseTarget(page, picker, '车库的 Linux');
  assert.equal(isVisible(picker), true);
  list = () => ({ corrupt: 'grants.json', grants: [] });
  timers.fire(3000);
  await flush();
  assert.equal(isVisible(picker), false, 'closed by the fault');
  row.fire('click');
  await flush();
  assert.deepEqual(sentOf(log, 'grants.grant'), [], 'a stale click sends nothing');
  page.button('授予…').fire('click');
  await flush();
  assert.ok(chooseTarget(page, picker, '车库的 Linux').textContent.includes('持有方出了故障'), 'and if it is opened anyway every row is disabled');
  assert.ok('disabled' in chooseTarget(page, picker, '车库的 Linux').attrs);
});

test('the recovery loop starts the next round only when this one has read and retried: a slow retry is the only one in flight, never a third revoke', async t => {
  const timers = stubTimers(t);
  let broken = false;
  const { page, log, detail } = await openShare(t, { share: { 'grants.list': () => { if (broken) throw new Error('读不到'); return { grants: [grantRow('g1')] }; }, 'grants.revoke': () => new Promise(() => {}) } });
  kebabOf(page, listRows(page, detail)[0]).fire('click');
  page.all(n => n.tag === 'button' && n.attrs.role === 'menuitem' && n.textContent.startsWith('撤销'), detail)[0].fire('click');
  await flush();
  timers.fire(10_000);
  await flush();
  assert.equal(sentOf(log, 'grants.revoke').length, 1);
  timers.fire(3000);
  await flush();
  assert.equal(sentOf(log, 'grants.revoke').length, 2, 'one retry, still usable at the holder');
  assert.ok(!timers.has(3000), 'no next round while the retry is in flight');
  assert.equal(sentOf(log, 'grants.revoke').length, 2);
  timers.fire(10_000);
  await flush();
  assert.ok(timers.has(3000), 'the retry ended: now the next round is scheduled');
  // 这一轮没读到有效列表就不重发。
  broken = true;
  const reads = sentOf(log, 'grants.list').length;
  timers.fire(3000);
  await flush();
  assert.equal(sentOf(log, 'grants.list').length, reads + 1);
  assert.equal(sentOf(log, 'grants.revoke').length, 2, 'no valid list, no retry');
});

// ---- 网络节点：分节入口、抽屉、网络节点待移除 ----
const netEntries = page => page.all(n => n.tag === 'button' && n.attrs['aria-label'] === '网络节点');
const netNode = (node, name, state, extra = {}) => ({ node, name, online: false, attributed: false, state, ...extra });
const netRead = (nodes, extra = {}) => ({ machine: 'a', space: '家里', network: { name: 'coda-home', kind: 'headscale' }, complete: true, unreadable: [], nodes, ...extra });
const netError = (code, message = code, effects = 'none') => Object.assign(new Error(message), { code, effects });
const SINCE = Date.UTC(2026, 10, 24, 6, 30);
const fmtTime = ms => new Date(ms).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const gRows = (page, node) => page.all(n => n.tag === 'li' && cls(n).startsWith('g-row'), node);
const rowWith = (page, node, text) => gRows(page, node).find(row => row.textContent.includes(text));
const isDisabled = node => 'disabled' in node.attrs;
const netBlock = page => page.all(n => cls(n) === 'netblock')[0];
// status 按电脑 ID 给；页面按各台 Accord 记录里的 networkRemovals 显示待移除。
async function openNetPage(t, { machines = [A], status = {}, ...options } = {}) {
  const { page, log } = await open(t, { machines, ...options });
  for (const m of machines.filter(x => !x.unreachable)) feed(log, m.id, status[m.id] ?? {});
  await flush();
  return { page, log };
}
async function openDrawer(page, index = 0) {
  netEntries(page)[index].fire('click');
  await flush();
  return scrims(page)[3];
}
const removal = (node, since = SINCE) => ({ node, since });

test('without window.coda.friendNodes there is no network entry and no pending-removal block, even when networkRemovals is not empty', async t => {
  const { page } = await openNetPage(t, { machines: [A, B], status: { a: { networkRemovals: [removal('41')] }, b: { networkRemovals: [removal('42')] } } });
  assert.deepEqual(netEntries(page), []);
  assert.equal(netBlock(page), undefined);
  assert.ok(!page.text().includes('待移除'));
  // 只有 removeFriendNode 也不算有这块能力。
  const only = await openNetPage(t, { removeFriendNode: () => ({}), status: { a: { networkRemovals: [removal('41')] } } });
  assert.deepEqual(netEntries(only.page), []);
  assert.equal(netBlock(only.page), undefined);
});

test('with friendNodes each reachable section has an icon entry at the end of its heading row; one machine puts it on the Friends row; nothing is called on open or on receiving removals', async t => {
  const { page, log } = await openNetPage(t, { machines: [A, B, { id: 'c', name: 'C', unreachable: '离线' }], friendNodes: () => netRead([]), status: { a: { networkRemovals: [removal('41')] } } });
  const entries = netEntries(page);
  assert.equal(entries.length, 2, 'the unreachable section has none');
  for (const entry of entries) assert.deepEqual([entry.attrs.title, cls(entry), entry.children[0].namespaceURI, isDisabled(entry)], ['网络节点', 'kebab', SVG_NS, false]);
  const heads = page.all(n => n.tag === 'h2' && cls(n) === 'sec');
  assert.deepEqual(heads.map(head => head.children.includes(entries[0]) || head.children.includes(entries[1])), [true, true, false]);
  assert.ok(cls(heads[0].children.at(-2)).includes('spacer') && heads[0].children.at(-1) === entries[0]);
  assert.deepEqual(log.nodes, [], 'opening the page and receiving removals never calls friendNodes');

  const single = await openNetPage(t, { friendNodes: () => netRead([]) });
  const [entry] = netEntries(single.page);
  assert.equal(entry.parentNode, undefined);
  const [head] = single.page.all(n => n.tag === 'h2' && cls(n) === 'sec');
  assert.equal(head.children[0], '好友');
  assert.equal(head.children.at(-1), entry);
  assert.equal(netBlock(single.page), undefined, 'no removals, no block');
});

test('pending removals show under the friend list with the node ID when no name has been read, and offer a retry; they are per section', async t => {
  const { page } = await openNetPage(t, { machines: [A, B], friendNodes: () => netRead([]), status: { a: { friends: [{ node: 'n1', author: FRIEND, bound: true }], networkRemovals: [removal('41'), removal('44', SINCE + 1)] } } });
  const blocks = page.all(n => cls(n) === 'netblock');
  assert.equal(blocks.length, 1, 'only the section that has removals');
  const block = blocks[0];
  assert.equal(page.all(n => n.tag === 'h3' && cls(n) === 'sub-head', block)[0].textContent, '网络节点待移除2');
  const rows = gRows(page, block);
  assert.deepEqual(rows.map(row => cls(row)), ['g-row', 'g-row']);
  assert.ok(rows[0].textContent.includes('节点 41') && rows[0].textContent.includes(`${fmtTime(SINCE)} 移除`));
  assert.ok(page.all(n => cls(n).includes('mono'), rows[0]).length);
  assert.deepEqual(rows.map(row => buttonIn(page, row, '重试')?.attrs.class), ['btn quiet small', 'btn quiet small']);
  const section = page.all(n => n.tag === 'section').find(n => n.children.includes(block));
  assert.ok(section.children.indexOf(block) > section.children.findIndex(n => cls(n) === 'friends'), 'below the friend list');
});

test('the drawer reads once for its machine, groups the leftovers, leaves out friends, and shows network, presence and state', async t => {
  const gate = deferred();
  const lastSeen = '2026-11-23T06:02:00Z', numericSeen = Date.UTC(2026, 10, 20, 8, 5);
  const nodes = [
    netNode('41', 'mei-iphone', 'pending', { attributed: true, lastSeen }),
    netNode('42', 'kept-laptop', 'friend', { attributed: true, online: true, heldBy: ['a'] }),
    netNode('44', 'ipad-7c1e', 'candidate', { attributed: true, lastSeen: numericSeen }),
    netNode('47', 'rob-laptop', 'candidate', { attributed: true, online: true, inviteOpen: true }),
    netNode('29', 'DESKTOP-4KQ2', 'candidate', { lastSeen: 'bad' }),
    netNode('33', 'localhost', 'candidate', { online: true }),
  ];
  const { page, log } = await openNetPage(t, { machines: [A, B], friendNodes: () => gate.promise });
  netEntries(page)[1].fire('click');
  const drawer = scrims(page)[3];
  assert.equal(drawer.hidden, false);
  assert.deepEqual(log.nodes, [['friendNodes', { machine: 'b' }]]);
  assert.equal(drawer.children[0].children[1].children[0].textContent, '网络节点 · B');
  assert.equal(buttonIn(page, drawer, '完成').textContent, '完成');
  assert.equal(page.all(n => cls(n) === 'empty', drawer)[0].textContent, '正在读取…');
  assert.equal(buttonIn(page, drawer, '重新读取'), undefined, 'no manual read button');
  gate.resolve(netRead(nodes));
  await flush();
  assert.equal(log.nodes.length, 1);
  assert.deepEqual(page.all(n => cls(n) === 'tag', drawer).map(n => n.textContent), ['Headscale']);
  assert.ok(drawer.textContent.includes('coda-home'));
  const heads = page.all(n => n.tag === 'h4' && cls(n) === 'sub-head', drawer);
  assert.deepEqual(heads.map(n => n.textContent), ['本空间邀请带入的3', '归属未确认2']);
  assert.deepEqual(heads.map(n => cls(n.children[0])), ['dot ok-dot', 'dot warn-dot']);
  const rows = gRows(page, drawer);
  assert.deepEqual(rows.map(row => cls(row)), ['g-row stripe attr', 'g-row stripe attr', 'g-row stripe attr', 'g-row stripe unk', 'g-row stripe unk']);
  assert.ok(!drawer.textContent.includes('kept-laptop'), 'friends do not go in the drawer');
  const meta = row => page.all(n => cls(n) === 'g-sub meta', row)[0];
  assert.equal(meta(rows[0]).textContent, `${fmtTime(Date.parse(lastSeen))} 离线 · 已断交`);
  assert.equal(cls(meta(rows[0]).children[0]), 'dot off-dot');
  assert.equal(meta(rows[1]).textContent, `${fmtTime(numericSeen)} 离线 · 未完成互认`, 'a millisecond lastSeen works too');
  assert.equal(meta(rows[2]).textContent, '在线 · 未完成互认');
  assert.equal(cls(meta(rows[2]).children[0]), 'dot ok-dot');
  assert.equal(meta(rows[3]).textContent, '离线 · 未完成互认', 'a lastSeen that cannot be parsed is left out');
  assert.equal(meta(rows[4]).textContent, '在线 · 未完成互认');
  assert.ok(!drawer.textContent.includes('已互认'), 'it says 未完成互认, never 未互认 on its own');
  // 邀请待用：只有徽标，没有删除。
  assert.deepEqual([...rows.map(row => Boolean(buttonIn(page, row, '删除')))], [true, true, false, true, true]);
  assert.equal(page.all(n => cls(n) === 'badge pending', rows[2])[0].textContent, '邀请待用');
  // Escape 收起。
  page.dispatch('keydown', { key: 'Escape' });
  assert.equal(drawer.hidden, true);
});

test('with one machine the drawer is titled 网络节点, a Tailscale network is labeled, and an empty list says there are no leftovers', async t => {
  const { page } = await openNetPage(t, { friendNodes: () => netRead([netNode('52', 'a-friend', 'friend', { heldBy: ['a'] })], { network: { name: 'tailnet.example', kind: 'tailscale' } }) });
  const drawer = await openDrawer(page);
  assert.equal(drawer.children[0].children[1].children[0].textContent, '网络节点');
  assert.deepEqual(page.all(n => cls(n) === 'tag', drawer).map(n => n.textContent), ['Tailscale']);
  assert.ok(drawer.textContent.includes('tailnet.example') && drawer.textContent.includes('没有残留节点'));
  assert.deepEqual(page.all(n => n.tag === 'h4', drawer), []);
});

test('delete goes to the section\'s machine; success or effects some removes the row silently, canceled leaves it silent, other errors say why on the row', async t => {
  const nodes = [netNode('44', 'ipad', 'candidate', { attributed: true }), netNode('45', 'phone', 'candidate'), netNode('46', 'tablet', 'candidate'), netNode('48', 'watch', 'candidate')];
  const outcomes = {
    44: () => ({ node: '44', removed: true }), 45: () => { throw netError('service_unavailable', '节点已删，待移除记录没结清，下次查看好友节点时会补上', 'some'); },
    46: () => { throw netError('canceled'); }, 48: () => { throw netError('invalid_state', 'rob-mac 还认着它', 'none'); },
  };
  const { page, log } = await openNetPage(t, { machines: [A, B], friendNodes: () => netRead(nodes), removeFriendNode: ({ node }) => outcomes[node](), status: { b: { networkRemovals: [removal('44'), removal('46')] } } });
  const drawer = await openDrawer(page, 1);
  const press = async name => { buttonIn(page, rowWith(page, drawer, name), '删除').fire('click'); await flush(); };
  await press('ipad');
  assert.deepEqual(log.nodes.at(-1), ['removeFriendNode', { machine: 'b', node: '44' }]);
  assert.equal(rowWith(page, drawer, 'ipad'), undefined, 'success: the row is gone');
  assert.equal(gRows(page, netBlock(page)).length, 1, 'and so is its pending removal, though networkRemovals did not change');
  await press('phone');
  assert.deepEqual(log.nodes.at(-1), ['removeFriendNode', { machine: 'b', node: '45' }]);
  assert.equal(rowWith(page, drawer, 'phone'), undefined, 'effects some: the node is deleted');
  assert.ok(!drawer.textContent.includes('没结清'), 'no message for it');
  await press('tablet');
  const tablet = rowWith(page, drawer, 'tablet');
  assert.ok(tablet && !page.all(n => cls(n).includes('error'), tablet).length, 'canceled leaves the row, with no text');
  assert.ok(buttonIn(page, tablet, '删除') && !isDisabled(buttonIn(page, tablet, '删除')));
  assert.equal(tablet.textContent, 'tablet离线 · 未完成互认删除');
  await press('watch');
  const watch = rowWith(page, drawer, 'watch');
  assert.equal(page.all(n => cls(n) === 'g-sub error', watch)[0].textContent, 'rob-mac 还认着它');
  assert.ok(buttonIn(page, watch, '删除'));
  assert.deepEqual(log.nodes.map(c => c[1].machine), ['b', 'b', 'b', 'b', 'b']);
});

test('a delete shows 正在删除… on its row while it is in flight', async t => {
  const gate = deferred();
  const { page } = await openNetPage(t, { friendNodes: () => netRead([netNode('44', 'ipad', 'candidate')]), removeFriendNode: () => gate.promise });
  const drawer = await openDrawer(page);
  buttonIn(page, drawer, '删除').fire('click');
  await flush();
  const row = rowWith(page, drawer, 'ipad');
  assert.equal(page.all(n => cls(n) === 'badge busy', row)[0].textContent, '正在删除…');
  assert.equal(buttonIn(page, row, '删除'), undefined);
  gate.resolve({ node: '44', removed: true });
  await flush();
  assert.equal(rowWith(page, drawer, 'ipad'), undefined);
});

test('an incomplete read names the unreadable machines, disables every delete, and 重新读取 reads again', async t => {
  const reads = [
    netRead([netNode('44', 'ipad', 'candidate', { attributed: true }), netNode('45', 'phone', 'candidate')], { complete: false, unreadable: [{ machine: 'r', name: 'rig' }, { machine: 'x', name: 'x1' }] }),
    netRead([netNode('44', 'ipad', 'candidate', { attributed: true }), netNode('45', 'phone', 'candidate')]),
  ];
  const { page, log } = await openNetPage(t, { friendNodes: () => reads.shift() });
  const drawer = await openDrawer(page);
  const note = page.all(n => cls(n) === 'note-box', drawer)[0];
  assert.ok(note.textContent.startsWith('rig、x1 读不到，暂时不能删除'));
  const deletes = () => page.all(n => n.tag === 'button' && n.textContent === '删除', drawer);
  assert.equal(deletes().length, 2);
  assert.ok(deletes().every(isDisabled));
  buttonIn(page, note, '重新读取').fire('click');
  await flush();
  assert.equal(log.nodes.filter(c => c[0] === 'friendNodes').length, 2);
  assert.equal(page.all(n => cls(n) === 'note-box', drawer).length, 0);
  assert.ok(deletes().every(n => !isDisabled(n)));
});

test('a read that fails: canceled quietly closes the drawer, not_found says where to remove and marks the machine, any other error shows its message with 重新读取', async t => {
  const answers = [() => { throw netError('canceled'); }, () => { throw netError('service_unavailable', '控制服务器没有应答'); }, () => netRead([])];
  const { page, log } = await openNetPage(t, { friendNodes: () => answers.shift()(), status: { a: { networkRemovals: [removal('41')] } } });
  const drawer = await openDrawer(page);
  assert.equal(drawer.hidden, true, 'canceled: closed, nothing said');
  assert.ok(!page.text().includes('读不到') && !page.text().includes('canceled'));
  assert.ok(buttonIn(page, netBlock(page), '重试'), 'canceled does not mark the machine');
  await openDrawer(page);
  assert.equal(drawer.hidden, false);
  assert.equal(page.all(n => cls(n) === 'error selectable', drawer)[0].textContent, '控制服务器没有应答');
  buttonIn(page, drawer, '重新读取').fire('click');
  await flush();
  assert.ok(drawer.textContent.includes('没有残留节点'));
  assert.equal(log.nodes.length, 3);
});

test('without network credentials (not_found) the drawer says to remove elsewhere, and the pending rows lose their retry for that machine only', async t => {
  const { page, log } = await openNetPage(t, { machines: [A, B], friendNodes: ({ machine }) => { throw netError('not_found', machine === 'a' ? '没有凭据' : '另一个'); },
    status: { a: { networkRemovals: [removal('41')] }, b: { networkRemovals: [removal('41')] } } });
  const blocks = () => page.all(n => cls(n) === 'netblock');
  assert.equal(blocks().length, 2);
  const drawer = await openDrawer(page, 0);
  assert.equal(page.all(n => cls(n) === 'empty', drawer)[0].textContent, '需在有网络凭据的设备上移除');
  assert.ok(!drawer.textContent.includes('没有凭据'), 'not the raw message');
  const [first, second] = blocks();
  assert.equal(buttonIn(page, first, '重试'), undefined);
  assert.equal(gRows(page, first)[0].textContent, '节点 41需在有网络凭据的设备上移除');
  assert.ok(buttonIn(page, second, '重试'), 'the other machine still has its retry');
  assert.equal(log.nodes.length, 1);
});

test('retry reads first and only then removes; the row takes the node name, and the result lands on the row without a prompt', async t => {
  const { page, log } = await openNetPage(t, { machines: [A, B], friendNodes: () => netRead([netNode('41', 'mei-iphone', 'pending', { attributed: true })]), removeFriendNode: () => ({ node: '41', removed: true }),
    status: { a: { networkRemovals: [removal('41')] }, b: { networkRemovals: [removal('41')] } } });
  buttonIn(page, page.all(n => cls(n) === 'netblock')[0], '重试').fire('click');
  await flush();
  assert.deepEqual(log.nodes, [['friendNodes', { machine: 'a' }], ['removeFriendNode', { machine: 'a', node: '41' }]]);
  assert.equal(page.all(n => cls(n) === 'netblock').length, 1, 'removed: gone though networkRemovals did not change');
  assert.ok(page.all(n => cls(n) === 'netblock')[0].textContent.includes('节点 41'), 'names are kept per machine: B still has no name for 41');
  assert.ok(!page.all(n => cls(n) === 'netblock')[0].textContent.includes('mei-iphone'));
});

test('retry shows the node name after a read that still leaves the node; a held node says which machines hold it and is not deleted', async t => {
  const state = { read: netRead([netNode('41', 'mei-iphone', 'friend', { heldBy: ['b', 'zz'] })]) };
  const { page, log } = await openNetPage(t, { machines: [A, B], friendNodes: () => state.read, removeFriendNode: () => ({ removed: true }), status: { a: { networkRemovals: [removal('41')] } } });
  buttonIn(page, netBlock(page), '重试').fire('click');
  await flush();
  const row = gRows(page, netBlock(page))[0];
  assert.ok(row.textContent.startsWith('mei-iphone'), 'the name replaces 节点 41');
  assert.equal(page.all(n => cls(n) === 'g-sub error', row)[0].textContent, 'B 等 2 台还认着它，先在那几台上移除好友', 'only part of them can be named: the count is of all');
  assert.deepEqual(log.nodes.map(c => c[0]), ['friendNodes']);
  state.read = netRead([netNode('41', 'mei-iphone', 'friend', { heldBy: ['a', 'b'] })]);
  buttonIn(page, netBlock(page), '重试').fire('click');
  await flush();
  assert.equal(page.all(n => cls(n) === 'g-sub error', netBlock(page))[0].textContent, 'A、B 还认着它，先在那几台上移除好友');
  state.read = netRead([netNode('41', 'mei-iphone', 'friend', { heldBy: ['unknown'] })]);
  buttonIn(page, netBlock(page), '重试').fire('click');
  await flush();
  assert.equal(page.all(n => cls(n) === 'g-sub error', netBlock(page))[0].textContent, '还有后端认着它，先在那台上移除好友');
  state.read = netRead([netNode('41', 'mei-iphone', 'friend', { heldBy: ['unknown', 'zz'] })]);
  buttonIn(page, netBlock(page), '重试').fire('click');
  await flush();
  assert.equal(page.all(n => cls(n) === 'g-sub error', netBlock(page))[0].textContent, '还有后端认着它，先在那几台上移除好友');
  assert.deepEqual(log.nodes.map(c => c[0]), ['friendNodes', 'friendNodes', 'friendNodes', 'friendNodes']);
});

test('two removals held by B: retrying the second keeps the first one\'s hold notice, and a node with no notice still shows its removal time', async t => {
  const held = { read: netRead([netNode('41', 'mei-iphone', 'friend', { heldBy: ['b'] }), netNode('44', 'ipad', 'friend', { heldBy: ['b'] }), netNode('50', 'watch', 'friend', { heldBy: ['b'] })]) };
  const { page } = await openNetPage(t, { machines: [A, B], friendNodes: () => held.read, status: { a: { networkRemovals: [removal('41'), removal('44'), removal('50', SINCE + 1)] } } });
  const retryRow = async i => { buttonIn(page, gRows(page, netBlock(page))[i], '重试').fire('click'); await flush(); };
  const subs = () => gRows(page, netBlock(page)).map(row => page.all(n => cls(n).startsWith('g-sub'), row)[0].textContent);
  await retryRow(0);
  await retryRow(1);
  assert.deepEqual(subs(), ['B 还认着它，先在那台上移除好友', 'B 还认着它，先在那台上移除好友', `${fmtTime(SINCE + 1)} 移除`]);
  // 之后 B 放手了：已有提示的行跟着新结果清掉，没点过的行仍是移除时间。
  held.read = netRead([netNode('41', 'mei-iphone', 'candidate'), netNode('44', 'ipad', 'friend', { heldBy: ['a'] }), netNode('50', 'watch', 'friend', { heldBy: ['b'] })]);
  await retryRow(2);
  assert.deepEqual(subs(), [`${fmtTime(SINCE)} 移除`, 'A 还认着它，先在那台上移除好友', 'B 还认着它，先在那台上移除好友']);
});

test('a failed read on retry is not kept once a later read succeeds: neither the drawer row nor the pending row shows it, while a failed delete stays', async t => {
  const reads = [() => { throw netError('service_unavailable', '控制服务器没有应答'); }, () => netRead([netNode('41', 'mei-iphone', 'candidate'), netNode('44', 'ipad', 'candidate')])];
  const { page } = await openNetPage(t, { friendNodes: () => reads.shift()(), removeFriendNode: ({ node }) => { throw netError('invalid_state', `${node} 删不掉`); }, status: { a: { networkRemovals: [removal('41'), removal('44')] } } });
  buttonIn(page, gRows(page, netBlock(page))[0], '重试').fire('click');
  await flush();
  assert.ok(gRows(page, netBlock(page))[0].textContent.includes('控制服务器没有应答'));
  const drawer = await openDrawer(page);
  assert.ok(!gRows(page, netBlock(page))[0].textContent.includes('控制服务器没有应答'), 'the pending row');
  assert.ok(!drawer.textContent.includes('控制服务器没有应答'), 'the drawer row');
  buttonIn(page, rowWith(page, drawer, 'ipad'), '删除').fire('click');
  await flush();
  assert.ok(gRows(page, netBlock(page))[1].textContent.includes('44 删不掉'), 'a failed delete is not cleared by reads');
});

test('retry on an incomplete read says who cannot be read and does not delete; a node that is gone from a complete read is treated as removed without a delete', async t => {
  const state = { read: netRead([netNode('41', 'mei-iphone', 'pending')], { complete: false, unreadable: [{ machine: 'r', name: 'rig' }] }) };
  const { page, log } = await openNetPage(t, { friendNodes: () => state.read, removeFriendNode: () => ({ removed: true }), status: { a: { networkRemovals: [removal('41'), removal('50')] } } });
  buttonIn(page, gRows(page, netBlock(page))[0], '重试').fire('click');
  await flush();
  assert.equal(page.all(n => cls(n) === 'g-sub error', netBlock(page))[0].textContent, 'rig 读不到，暂时不能移除');
  state.read = netRead([], { complete: false, unreadable: [{ machine: 'r', name: 'rig' }] });
  buttonIn(page, gRows(page, netBlock(page))[1], '重试').fire('click');
  await flush();
  assert.equal(gRows(page, netBlock(page)).length, 2, 'not found but incomplete: it may be held by one we cannot read');
  state.read = netRead([]);
  buttonIn(page, gRows(page, netBlock(page))[1], '重试').fire('click');
  await flush();
  assert.equal(gRows(page, netBlock(page)).length, 1, 'complete and gone: removed');
  assert.deepEqual(log.nodes.map(c => c[0]), ['friendNodes', 'friendNodes', 'friendNodes'], 'removeFriendNode is never called');
});

test('retry errors: canceled and not_found leave nothing on the row (not_found drops the retry), other errors and a failed delete show their message', async t => {
  const reads = [() => { throw netError('canceled'); }, () => { throw netError('service_unavailable', '控制服务器没有应答'); }, () => netRead([netNode('41', 'mei-iphone', 'candidate')])];
  const { page, log } = await openNetPage(t, { friendNodes: () => reads.shift()(), removeFriendNode: () => { throw netError('invalid_state', 'rig 还认着它'); }, status: { a: { networkRemovals: [removal('41')] } } });
  const retry = () => buttonIn(page, netBlock(page), '重试');
  retry().fire('click');
  await flush();
  assert.equal(gRows(page, netBlock(page))[0].textContent, `节点 41${fmtTime(SINCE)} 移除重试`);
  retry().fire('click');
  await flush();
  assert.ok(gRows(page, netBlock(page))[0].textContent.includes('控制服务器没有应答'));
  assert.ok(retry(), 'a failed read can be retried');
  retry().fire('click');
  await flush();
  assert.ok(gRows(page, netBlock(page))[0].textContent.includes('rig 还认着它'));
  assert.deepEqual(log.nodes.map(c => c[0]), ['friendNodes', 'friendNodes', 'friendNodes', 'removeFriendNode']);
  assert.equal(page.all(n => n.tag === 'button' && n.textContent === '重试').length, 1, 'a failed attempt can be retried');
});

test('retry hitting not_found on the read, or on the delete, marks the machine without credentials', async t => {
  const first = await openNetPage(t, { friendNodes: () => netRead([netNode('41', 'x', 'candidate')]), removeFriendNode: () => { throw netError('not_found'); }, status: { a: { networkRemovals: [removal('41')] } } });
  buttonIn(first.page, netBlock(first.page), '重试').fire('click');
  await flush();
  assert.equal(buttonIn(first.page, netBlock(first.page), '重试'), undefined);
  assert.equal(gRows(first.page, netBlock(first.page))[0].textContent, 'x需在有网络凭据的设备上移除');
});

test('a successful read clears the machine\'s no-credentials mark, so the retry comes back', async t => {
  const reads = [() => { throw netError('not_found'); }, () => netRead([netNode('41', 'x', 'candidate')])];
  const { page } = await openNetPage(t, { friendNodes: () => reads.shift()(), status: { a: { networkRemovals: [removal('41')] } } });
  buttonIn(page, netBlock(page), '重试').fire('click');
  await flush();
  assert.equal(buttonIn(page, netBlock(page), '重试'), undefined);
  assert.ok(netBlock(page).textContent.includes('需在有网络凭据的设备上移除'));
  await openDrawer(page);
  assert.ok(buttonIn(page, netBlock(page), '重试'));
  assert.ok(!netBlock(page).textContent.includes('需在有网络凭据的设备上移除'));
});

test('a successful read clears what an earlier read blocked the row for, but not a failed delete', async t => {
  const reads = [netRead([netNode('41', 'x', 'candidate')], { complete: false, unreadable: [{ machine: 'r', name: 'rig' }] }), netRead([netNode('41', 'x', 'friend', { heldBy: ['a'] })]),
    netRead([netNode('41', 'x', 'candidate')]), netRead([netNode('41', 'x', 'candidate')]), netRead([netNode('41', 'x', 'candidate')])];
  const { page, log } = await openNetPage(t, { friendNodes: () => reads.shift(), removeFriendNode: () => { throw netError('invalid_state', 'rig 还认着它'); }, status: { a: { networkRemovals: [removal('41')] } } });
  const retry = async () => { buttonIn(page, netBlock(page), '重试').fire('click'); await flush(); };
  const hint = () => page.all(n => cls(n) === 'g-sub error', netBlock(page))[0]?.textContent;
  await retry();
  assert.equal(hint(), 'rig 读不到，暂时不能移除');
  await retry();
  assert.equal(hint(), 'A 还认着它，先在那台上移除好友');
  const drawer = await openDrawer(page);
  assert.equal(hint(), undefined, 'the drawer read is complete and the node is no longer a friend');
  assert.ok(!isDisabled(buttonIn(page, rowWith(page, drawer, 'x'), '删除')));
  await retry();
  assert.equal(hint(), 'rig 还认着它', 'a failed delete stays');
  await openDrawer(page);
  assert.equal(hint(), 'rig 还认着它', 'a successful read does not clear a delete error');
  assert.deepEqual(log.nodes.map(c => c[0]), ['friendNodes', 'friendNodes', 'friendNodes', 'friendNodes', 'removeFriendNode', 'friendNodes']);
});

test('only one friend-node operation is in flight: while one runs every entry, delete, retry and re-read is disabled and extra clicks send nothing', async t => {
  const gate = deferred();
  const nodes = [netNode('44', 'ipad', 'candidate'), netNode('45', 'phone', 'candidate')];
  const { page, log } = await openNetPage(t, { machines: [A, B], friendNodes: () => netRead(nodes), removeFriendNode: () => gate.promise,
    status: { a: { networkRemovals: [removal('41')] }, b: { networkRemovals: [removal('42')] } } });
  const drawer = await openDrawer(page, 0);
  buttonIn(page, rowWith(page, drawer, 'ipad'), '删除').fire('click');
  await flush();
  const [pageRoot] = page.all(n => cls(n) === 'page');
  const all = () => [...netEntries(page), ...page.all(n => n.tag === 'button' && ['删除', '重试'].includes(n.textContent), pageRoot)];
  const inDrawer = () => page.all(n => n.tag === 'button' && n.textContent === '删除', drawer);
  assert.ok(all().length >= 4 && inDrawer().length === 1);
  assert.ok([...all(), ...inDrawer(), buttonIn(page, drawer, '重新读取')].filter(Boolean).every(isDisabled), 'every other button is disabled');
  for (const button of [...all(), ...inDrawer()]) button.fire('click');
  await flush();
  assert.deepEqual(log.nodes.map(c => c[0]), ['friendNodes', 'removeFriendNode'], 'no second call');
  // 抽屉关掉后，结果照常落下，抽屉不会重新打开。
  buttonIn(page, drawer, '完成').fire('click');
  assert.equal(drawer.hidden, true);
  gate.resolve({ node: '44', removed: true });
  await flush();
  assert.equal(drawer.hidden, true);
  assert.ok(all().every(n => !isDisabled(n)));
  const again = await openDrawer(page, 0);
  assert.ok(rowWith(page, again, 'ipad'), 'a node the read still lists shows again, whatever was recorded as removed');
  assert.ok(rowWith(page, again, 'phone'));
  // 读的时候同样互斥。
  const slow = deferred();
  const second = await openNetPage(t, { friendNodes: () => slow.promise, status: { a: { networkRemovals: [removal('41')] } } });
  buttonIn(second.page, netBlock(second.page), '重试').fire('click');
  assert.ok([...netEntries(second.page), ...second.page.all(n => n.tag === 'button' && n.textContent === '重试')].every(isDisabled));
  assert.equal(second.page.all(n => cls(n) === 'badge busy', netBlock(second.page))[0].textContent, '正在移除…');
  netEntries(second.page)[0].fire('click');
  assert.equal(second.log.nodes.length, 1);
  slow.resolve(netRead([]));
  await flush();
});

test('node names and messages are shown as text, never as markup', async t => {
  const name = '<b>evil</b><img src=x onerror=alert(1)>';
  const { page } = await openNetPage(t, { friendNodes: () => netRead([netNode('44', name, 'candidate', { attributed: true })], { network: { name: '<i>net</i>', kind: 'headscale' } }), removeFriendNode: () => { throw netError('invalid_state', '<u>no</u>'); },
    status: { a: { networkRemovals: [removal('44')] } } });
  const drawer = await openDrawer(page);
  assert.ok(drawer.textContent.includes(name) && drawer.textContent.includes('<i>net</i>'));
  buttonIn(page, rowWith(page, drawer, 'evil'), '删除').fire('click');
  await flush();
  assert.ok(drawer.textContent.includes('<u>no</u>'));
  assert.ok(netBlock(page).textContent.includes(name), 'the pending row takes the name read in the drawer');
  assert.deepEqual(page.all(n => ['b', 'i', 'u', 'img'].includes(n.tag)), []);
});

test('the granting dialog lists another machine of the space by its name next to this one, granting it sends its record; its grant reads as offline or unreachable while it is', async t => {
  const targets = [{ id: 'rx-1', name: '书房的 Mac mini', os: 'macOS 15.2', user: 'leavan', available: true, local: true },
    { id: 'rx-b', name: '车库的 Linux', os: 'Ubuntu 24.04', user: 'coda', available: true, local: false }];
  const { page, log, detail, picker } = await openShare(t, { share: { 'grants.targets': () => targets,
    'grants.grant': () => grantRow('gb', { target: { kind: GRANT_KIND, id: 'rx-b', name: '车库的 Linux' } }),
    'grants.list': () => ({ grants: [grantRow('g1', { status: 'target_offline' }), grantRow('g2', { status: 'target_unreachable' })] }) } });
  assert.deepEqual(listRows(page, detail).map(row => badgeOf(page, row)), ['目标离线', '读不到目标']);
  page.button('授予…').fire('click');
  await flush();
  assert.deepEqual(page.all(n => n.tag === 'button' && cls(n) === 'pick', picker).map(row => row.textContent.split('macOS')[0].split('Ubuntu')[0]), ['书房的 Mac mini', '车库的 Linux']);
  grantOn(page, picker, '车库的 Linux');
  await flush();
  assert.deepEqual(sentOf(log, 'grants.grant').map(s => s.msg.target), [{ kind: GRANT_KIND, id: 'rx-b' }]);
});

// ---- 授予与修改范围 ----

const isOff = n => n.disabled === true || 'disabled' in n.attrs;
const radioOf = (page, picker, label) => page.all(n => n.tag === 'input' && n.attrs.type === 'radio', page.all(n => n.tag === 'label' && n.textContent.startsWith(label), picker)[0])[0];
const pathInputs = (page, picker) => page.all(n => n.tag === 'input' && n.attrs.type === 'text', picker);
const accessSelects = (page, picker) => page.all(n => n.tag === 'select', picker);
const hintOf = (page, picker) => page.all(n => n.tag === 'p' && cls(n) === 'hint' && n.attrs.role === 'status', picker)[0];
const warnOf = (page, picker) => page.all(n => cls(n) === 'warn-box', picker)[0];
// 选了机器、出了表单（默认「整台机器」）。
async function openForm(t, share = {}, options = {}) {
  const ctx = await openShare(t, { share: { 'grants.targets': () => TARGETS, ...share }, ...options });
  ctx.page.button('授予…').fire('click');
  await flush();
  chooseTarget(ctx.page, ctx.picker, '书房的 Mac mini').fire('click');
  return ctx;
}
// 切到「仅限目录」，填成 rows：[[路径, 'rw' | 'ro']]。
function fillDirs(page, picker, rows) {
  if (radioOf(page, picker, '仅限目录').checked !== true && !('checked' in radioOf(page, picker, '仅限目录').attrs)) radioOf(page, picker, '仅限目录').fire('change');
  while (pathInputs(page, picker).length < rows.length) confirmButton(page, picker, '添加目录').fire('click');
  while (pathInputs(page, picker).length > rows.length) confirmButton(page, picker, '删除').fire('click');
  rows.forEach(([path, access], i) => {
    const input = pathInputs(page, picker)[i], select = accessSelects(page, picker)[i];
    input.value = path; input.fire('input');
    select.value = access; select.fire('change');
  });
}
const DIRS = { dirs: [{ path: '/Users/me/work', access: 'rw' }, { path: '/Users/me/docs/a very long folder name/that keeps going/and going', access: 'ro' }] };
const dirRows = DIRS.dirs.map(dir => [dir.path, dir.access]);

test('the scope form: whole machine is selected by default with its note, confirming it grants as before with no restrict, and the machine can be changed', async t => {
  const { page, log, picker } = await openForm(t);
  assert.equal(picker.textContent.includes('书房的 Mac mini') && picker.textContent.includes('Darwin 24.2.0 · leavan'), true, 'the machine is named');
  assert.ok(picker.textContent.includes('整台机器') && picker.textContent.includes('等同于登录这台机器上的这个账号'));
  assert.ok('checked' in radioOf(page, picker, '整台机器').attrs && !('checked' in radioOf(page, picker, '仅限目录').attrs));
  assert.deepEqual(pathInputs(page, picker), [], 'no directory list for the whole machine');
  assert.equal(confirmButton(page, picker, '授予').disabled, false);
  // 换一台机器：回到列表，再选一台，范围重置。
  radioOf(page, picker, '仅限目录').fire('change');
  assert.equal(pathInputs(page, picker).length, 1);
  confirmButton(page, picker, '换一台机器').fire('click');
  assert.equal(page.all(n => cls(n) === 'pick', picker).length, 3);
  chooseTarget(page, picker, '车库的 Linux').fire('click');
  assert.ok(picker.textContent.includes('车库的 Linux') && 'checked' in radioOf(page, picker, '整台机器').attrs && pathInputs(page, picker).length === 0);
  confirmButton(page, picker, '换一台机器').fire('click');
  chooseTarget(page, picker, '书房的 Mac mini').fire('click');
  assert.ok('checked' in radioOf(page, picker, '整台机器').attrs, 'back on the whole machine after choosing again');
  confirmButton(page, picker, '授予').fire('click');
  assert.equal(isVisible(picker), false, 'the whole-machine grant keeps its old behaviour: the picker closes and the row says granting');
  await flush();
  const [sent] = sentOf(log, 'grants.grant');
  assert.deepEqual(sent.msg.target, { kind: GRANT_KIND, id: 'rx-1' });
  assert.ok(!('restrict' in sent.msg));
});

test('a restricted grant sends the directories, shows progress until the target answers, takes no second submit or close meanwhile, then closes and the row shows the scope', async t => {
  const gate = deferred();
  const { page, log, detail, picker } = await openForm(t, { 'grants.grant': () => gate.promise });
  fillDirs(page, picker, dirRows);
  assert.equal(confirmButton(page, picker, '授予').disabled, false);
  confirmButton(page, picker, '授予').fire('click');
  assert.ok(confirmButton(page, picker, '正在探测…').disabled, 'the confirm button is the progress and cannot be pressed');
  assert.ok(picker.textContent.includes('最多约 30 秒'));
  assert.ok(pathInputs(page, picker).every(isOff) && isOff(radioOf(page, picker, '整台机器')) && isOff(confirmButton(page, picker, '添加目录')) && isOff(confirmButton(page, picker, '换一台机器')));
  confirmButton(page, picker, '正在探测…').fire('click');
  page.dispatch('keydown', { key: 'Escape' });
  page.button('取消').fire('click');
  await flush();
  assert.equal(isVisible(picker), true, 'it cannot be closed while the answer is awaited');
  assert.deepEqual(sentOf(log, 'grants.grant').map(s => [s.msg.friend, s.msg.target, s.msg.restrict, s.machine]), [[FRIEND, { kind: GRANT_KIND, id: 'rx-1' }, DIRS, 'a']], 'sent once, with the rows as typed');
  assert.deepEqual(listRows(page, detail), [], 'no optimistic row for a restricted grant');
  gate.resolve(grantRow('g1', { target: { kind: GRANT_KIND, id: 'rx-1', name: '书房的 Mac mini' }, restrict: DIRS }));
  await flush();
  assert.equal(isVisible(picker), false);
  const [row] = listRows(page, detail);
  assert.equal(badgeOf(page, row), '可用');
  const summary = page.all(n => n.tag === 'summary', row)[0];
  assert.equal(summary.textContent, '仅限目录 · /Users/me/work（读写）等 2 个');
  assert.equal(page.all(n => n.tag === 'details', row)[0].attrs.open, undefined, 'folded');
  // 点开看全部目录与各自的读写；重画后仍开着。
  const details = () => page.all(n => n.tag === 'details' && cls(n) === 'scope', listRows(page, detail)[0])[0];
  details().open = true;
  details().fire('toggle');
  feed(log, 'a', { friends: [{ node: 'n1', author: FRIEND, bound: true }] });
  assert.notEqual(details().attrs.open, undefined);
  assert.deepEqual(page.all(n => n.tag === 'li', details()).map(n => n.textContent), [`读写${DIRS.dirs[0].path}`, `只读${DIRS.dirs[1].path}`]);
  assert.equal(page.all(n => n.tag === 'button', row).length, 1, 'the row keeps its one button');
});

test('a grant for the whole machine shows 整台机器 on its row; the validation holds the confirm button back with what is missing, and sends nothing', async t => {
  const { page, log, detail, picker } = await openShare(t, { share: { 'grants.targets': () => TARGETS, 'grants.list': () => ({ grants: [grantRow('g1')] }) } });
  assert.ok(listRows(page, detail)[0].textContent.includes('整台机器'));
  page.button('授予…').fire('click');
  await flush();
  chooseTarget(page, picker, '书房的 Mac mini').fire('click');
  // 空：一行还没填路径。
  radioOf(page, picker, '仅限目录').fire('change');
  assert.ok(confirmButton(page, picker, '授予').disabled);
  assert.equal(hintOf(page, picker).textContent, '第 1 行还没填路径');
  // 没有任何行。
  confirmButton(page, picker, '删除').fire('click');
  assert.equal(hintOf(page, picker).textContent, '至少要有一个目录');
  assert.ok(confirmButton(page, picker, '授予').disabled);
  // 相对路径。
  confirmButton(page, picker, '添加目录').fire('click');
  const input = () => pathInputs(page, picker)[0];
  input().value = 'work/docs'; input().fire('input');
  assert.equal(hintOf(page, picker).textContent, '第 1 行：要填目标机上的绝对路径，以 / 开头');
  assert.ok(confirmButton(page, picker, '授予').disabled);
  // 全是只读：没有读写行。
  input().value = '/Users/me/work'; input().fire('input');
  accessSelects(page, picker)[0].value = 'ro'; accessSelects(page, picker)[0].fire('change');
  assert.equal(hintOf(page, picker).textContent, '至少要有一个「读写」的目录');
  assert.ok(confirmButton(page, picker, '授予').disabled);
  // 路径太长。
  accessSelects(page, picker)[0].value = 'rw'; accessSelects(page, picker)[0].fire('change');
  input().value = `/${'长'.repeat(400)}`; input().fire('input');
  assert.ok(hintOf(page, picker).textContent.includes('路径太长'));
  // 超过 50 行。
  fillDirs(page, picker, Array.from({ length: 51 }, (_, i) => [`/d/${i}`, 'rw']));
  assert.equal(hintOf(page, picker).textContent, '最多 50 个目录，现在有 51 个');
  assert.ok(confirmButton(page, picker, '授予').disabled);
  confirmButton(page, picker, '授予').fire('click');
  // 50 行、有读写、都是绝对路径：可以了。
  confirmButton(page, picker, '删除').fire('click');
  assert.equal(hintOf(page, picker).hidden, true);
  assert.equal(confirmButton(page, picker, '授予').disabled, false);
  await flush();
  assert.deepEqual(sentOf(log, 'grants.grant'), [], 'nothing was sent for any invalid form');
  // 输入框不因别处的重画而重建（打字时不丢焦点）。
  const kept = input();
  feed(log, 'a', { friends: [{ node: 'n1', author: FRIEND, bound: true }] });
  assert.equal(input(), kept);
});

test('restricting is greyed out for a machine that is not a Mac, with the reason; the choice resets when another machine is chosen', async t => {
  const { page, picker } = await openForm(t);
  assert.equal(isOff(radioOf(page, picker, '仅限目录')), false, 'a Mac can choose it');
  radioOf(page, picker, '仅限目录').fire('change');
  fillDirs(page, picker, [['/Users/me/work', 'rw']]);
  confirmButton(page, picker, '换一台机器').fire('click');
  chooseTarget(page, picker, '车库的 Linux').fire('click');
  assert.ok(isOff(radioOf(page, picker, '仅限目录')));
  const text = page.all(n => n.tag === 'label' && n.textContent.startsWith('仅限目录'), picker)[0].textContent;
  assert.ok(text.includes('第一期只支持 macOS 的机器') && text.includes('Ubuntu 24.04'), text);
  assert.ok('checked' in radioOf(page, picker, '整台机器').attrs && pathInputs(page, picker).length === 0);
  confirmButton(page, picker, '换一台机器').fire('click');
  chooseTarget(page, picker, '书房的 Mac mini').fire('click');
  assert.ok(!('checked' in radioOf(page, picker, '仅限目录').attrs) && pathInputs(page, picker).length === 0, 'what was typed for the first machine is gone');
});

const coded = (code, message) => Object.assign(new Error(message), { code, effects: 'none' });

test('each probe failure is explained by its code, the form stays open with what was typed, and a directory error points at its row', async t => {
  const FAILS = [
    ['sandbox_unsupported', '目标机不支持受限执行', ['不能用「仅限目录」', 'macOS']],
    ['restrict_unsupported', '目标机上的远程执行版本太旧', ['版本太旧', '0.2.0']],
    ['restrict_dir_not_found', `${DIRS.dirs[1].path}：不存在`, ['第 2 行', DIRS.dirs[1].path, '不存在'], 1],
    ['restrict_dir_not_a_directory', '/Users/me/work：不是目录', ['第 1 行', '不是目录'], 0],
    ['restrict_protected', '/Users/me/work 与受保护的 ~/.ssh 重叠，不能授出', ['第 1 行', '受保护的位置', '~/.ssh'], 0],
    ['sandbox_failed', '沙箱起不来', ['沙箱起不来']],
    ['target_offline', '目标机离线', ['离线']],
    ['target_unreachable', '读不到目标', ['读不到目标机']],
    ['target_missing', '目标不在了', ['记录不在了']],
    ['target_changed', '目标变了', ['重新选']],
    ['timeout', '30 秒没回应', ['30 秒内没有回应']],
    ['restrict_too_large', '太大', ['范围太大']],
    ['already_granted', '已经授给这位好友一条（授权号 g9），范围不同', ['修改范围…']],
    ['disabled', '远程执行没打开', ['远程执行没打开']],
    ['made_up_code', '后端新加的码', ['没有成功（made_up_code）']],
  ];
  for (const [code, message, parts, row] of FAILS) {
    const { page, log, picker } = await openForm(t, { 'grants.grant': () => { throw coded(code, `没有授出：${message}`); } });
    fillDirs(page, picker, dirRows);
    confirmButton(page, picker, '授予').fire('click');
    await flush();
    assert.equal(isVisible(picker), true, `${code}: the form stays`);
    const warn = warnOf(page, picker);
    for (const part of parts) assert.ok(warn.textContent.includes(part), `${code}: ${part} in ${warn.textContent}`);
    assert.ok(warn.textContent.includes(`没有授出：${message}`), `${code}: the backend's words are shown as detail`);
    assert.deepEqual(pathInputs(page, picker).map(n => n.value), DIRS.dirs.map(dir => dir.path), `${code}: what was typed is kept`);
    assert.deepEqual(accessSelects(page, picker).map(n => n.value), ['rw', 'ro']);
    assert.deepEqual(page.all(n => cls(n).startsWith('dir-row'), picker).map(n => cls(n).includes('bad')), [0, 1].map(i => i === row), `${code}: the row`);
    assert.equal(confirmButton(page, picker, '授予').disabled, false, `${code}: it can be sent again`);
    assert.deepEqual(listRows(page, scrims(page)[0]), [], `${code}: nothing was created`);
    // 原样再点一次：照样发出（表单没有因为失败卡住）。
    confirmButton(page, picker, '授予').fire('click');
    await flush();
    assert.equal(sentOf(log, 'grants.grant').length, 2, code);
  }
});

const MAC = { kind: GRANT_KIND, id: 'rx-1', name: '书房的 Mac mini' };
// 仅限目录的授予，页面等满 45 秒没有回应：表单关掉，那一行是待确认（带着想授的范围）。
async function restrictedTimeout(t, share) {
  const timers = stubTimers(t), late = deferred(), listed = { grants: [] };
  const ctx = await openForm(t, { 'grants.grant': () => late.promise, 'grants.list': () => listed, ...share });
  fillDirs(ctx.page, ctx.picker, dirRows);
  confirmButton(ctx.page, ctx.picker, '授予').fire('click');
  assert.ok(timers.has(45_000), 'the page waits longer than the 10 seconds of a plain call: the probe has up to 30');
  timers.fire(45_000);
  await flush();
  return { ...ctx, timers, late, listed, badges: () => listRows(ctx.page, ctx.detail).map(row => badgeOf(ctx.page, row)) };
}

test('a restricted grant with no answer in time closes the form and waits on its row as 待确认 with the scope it asked for; no second submit is possible', async t => {
  const { page, log, detail, picker, badges } = await restrictedTimeout(t);
  assert.equal(isVisible(picker), false);
  assert.deepEqual(badges(), ['待确认']);
  const [row] = listRows(page, detail);
  assert.ok(row.textContent.includes('书房的 Mac mini') && row.textContent.includes('授予待确认') && row.textContent.includes('仅限目录 · /Users/me/work（读写）等 2 个'));
  assert.ok('disabled' in kebabOf(page, row).attrs);
  page.button('授予…').fire('click');
  await flush();
  const taken = chooseTarget(page, picker, '书房的 Mac mini');
  assert.ok('disabled' in taken.attrs && taken.textContent.includes('已授给 TA'), 'the target stays taken');
  assert.equal(sentOf(log, 'grants.grant').length, 1);
});

test('a restricted grant\'s late success is taken as its result and the list is read again; a late refusal says why on the row; the list alone settles it too', async t => {
  // 晚到的成功。
  let one = await restrictedTimeout(t);
  const before = sentOf(one.log, 'grants.list').length;
  one.listed.grants = [grantRow('g1', { target: MAC, restrict: DIRS })];
  one.late.resolve(one.listed.grants[0]);
  await flush();
  assert.deepEqual(one.badges(), ['可用']);
  assert.ok(listRows(one.page, one.detail)[0].textContent.includes('仅限目录 · /Users/me/work'));
  assert.ok(sentOf(one.log, 'grants.list').length > before, 'the list is refreshed');
  // 晚到的明确失败：写在那一行，可以移除。
  one = await restrictedTimeout(t);
  one.late.reject(coded('restrict_dir_not_found', `${DIRS.dirs[1].path}：不存在`));
  await flush();
  assert.deepEqual(one.badges(), ['未授予']);
  assert.ok(listRows(one.page, one.detail)[0].textContent.includes('第 2 行') && listRows(one.page, one.detail)[0].textContent.includes('不存在'));
  // 回应一直不来，列表里已经有了。
  one = await restrictedTimeout(t);
  one.listed.grants = [grantRow('g1', { target: MAC, restrict: DIRS })];
  one.timers.fire(3000);
  await flush();
  assert.deepEqual(one.badges(), ['可用']);
  // 回应一直不来，连续几遍列表都没有：回滚，可以重试。
  one = await restrictedTimeout(t);
  for (let i = 0; i < 3; i++) { one.timers.fire(3000); await flush(); }
  assert.deepEqual(one.badges(), ['未授予']);
  assert.ok(listRows(one.page, one.detail)[0].textContent.includes('没有确认授予成功'));
});

test('a send that never left is a plain failure on the form, not a pending row', async t => {
  const { page, picker, detail } = await openForm(t, {}, { sendFail: msg => msg.type === 'grants.grant' });
  fillDirs(page, picker, dirRows);
  confirmButton(page, picker, '授予').fire('click');
  await flush();
  assert.ok(warnOf(page, picker).textContent.includes('没有发出：发送失败：桥不可用'));
  assert.deepEqual(listRows(page, detail), []);
});

// 改范围，页面等满 45 秒没有回应：授权行待确认，仍显示原范围。
async function modifyTimeout(t, { to = { dirs: [DIRS.dirs[0], { path: '/Users/me/notes', access: 'ro' }] }, share } = {}) {
  const timers = stubTimers(t), late = deferred(), state = { grants: [grantRow('g1', { target: MAC, restrict: DIRS })] };
  const ctx = await openShare(t, { share: { 'grants.targets': () => TARGETS, 'grants.list': () => ({ grants: state.grants }), 'grants.restrict': () => late.promise, ...share } });
  kebabOf(ctx.page, listRows(ctx.page, ctx.detail)[0]).fire('click');
  page_item(ctx.page, ctx.detail, '修改范围…').fire('click');
  await flush();
  pathInputs(ctx.page, ctx.picker)[1].value = to.dirs[1].path; pathInputs(ctx.page, ctx.picker)[1].fire('input');
  confirmButton(ctx.page, ctx.picker, '保存范围').fire('click');
  timers.fire(45_000);
  await flush();
  return { ...ctx, timers, late, state, to, badges: () => listRows(ctx.page, ctx.detail).map(row => badgeOf(ctx.page, row)), row: () => listRows(ctx.page, ctx.detail)[0] };
}
const page_item = (page, node, label) => page.all(n => n.tag === 'button' && n.attrs.role === 'menuitem' && n.textContent === label, node)[0];

test('a scope change with no answer in time shows its row as 待确认 on the old scope, takes no other action on it, and the late success updates the scope and the list', async t => {
  const one = await modifyTimeout(t);
  assert.equal(isVisible(one.picker), false);
  assert.deepEqual(one.badges(), ['待确认']);
  assert.ok(one.row().textContent.includes('范围改动待确认') && one.row().textContent.includes('仅限目录 · /Users/me/work（读写）等 2 个'));
  assert.ok('disabled' in kebabOf(one.page, one.row()).attrs);
  const before = sentOf(one.log, 'grants.list').length;
  one.state.grants = [grantRow('g1', { target: MAC, restrict: one.to })];
  one.late.resolve({ ...one.state.grants[0] });
  await flush();
  assert.deepEqual(one.badges(), ['可用']);
  assert.ok(sentOf(one.log, 'grants.list').length > before);
  const text = page => page.all(n => n.tag === 'summary', one.row())[0].textContent;
  assert.equal(text(one.page), '仅限目录 · /Users/me/work（读写）等 2 个');
  const details = one.page.all(n => n.tag === 'details' && cls(n) === 'scope', one.row())[0];
  assert.deepEqual(one.page.all(n => n.tag === 'li', details).map(n => n.textContent), ['读写/Users/me/work', '只读/Users/me/notes'], 'the new scope, not the old one');
});

test('a scope change that gets no answer is settled by a late refusal on its row, by the list showing the new scope, or after three lists that do not: still the old scope, can be changed again', async t => {
  // 晚到的明确拒绝。
  let one = await modifyTimeout(t);
  one.late.reject(coded('restrict_protected', '/Users/me/notes 与受保护的 ~/.ssh 重叠'));
  await flush();
  assert.deepEqual(one.badges(), ['可用']);
  assert.ok(one.row().textContent.includes('受保护的位置'));
  assert.ok(!('disabled' in kebabOf(one.page, one.row()).attrs));
  // 列表里已经是想要的范围。
  one = await modifyTimeout(t);
  one.state.grants = [grantRow('g1', { target: MAC, restrict: one.to })];
  one.timers.fire(3000);
  await flush();
  assert.deepEqual(one.badges(), ['可用']);
  assert.ok(!one.row().textContent.includes('待确认'));
  // 连续几遍都不是：写明没确认，仍是原范围。
  one = await modifyTimeout(t);
  for (let i = 0; i < 3; i++) { one.timers.fire(3000); await flush(); }
  assert.deepEqual(one.badges(), ['可用']);
  assert.ok(one.row().textContent.includes('没有确认范围改成功'));
  assert.ok(!('disabled' in kebabOf(one.page, one.row()).attrs));
  assert.ok(one.row().textContent.includes('仅限目录 · /Users/me/work（读写）等 2 个'));
});

test('修改范围… is on the menu of a grant that is still in use only; the form is the grant form with the machine fixed and the scope filled in, and it asks grants.restrict', async t => {
  const gate = deferred();
  const mac = { kind: GRANT_KIND, id: 'rx-1', name: '书房的 Mac mini' };
  const list = [grantRow('g1', { target: mac, restrict: DIRS }), grantRow('g2', { status: 'target_off' }), grantRow('g3', { status: 'target_missing' }), grantRow('g4', { status: 'machine_changed' }),
    grantRow('g5', { status: 'revoking', revokedAt: 1 }), grantRow('g6', { status: 'available', target: { ...mac, id: 'rx-3', name: '车库的 Linux' } })];
  const { page, log, detail, picker } = await openShare(t, { share: { 'grants.targets': () => TARGETS, 'grants.list': () => ({ grants: list }), 'grants.restrict': () => gate.promise } });
  const menuOf = i => { kebabOf(page, listRows(page, detail)[i]).fire('click'); return page.all(n => n.tag === 'button' && n.attrs.role === 'menuitem', listRows(page, detail)[i]).map(n => n.textContent); };
  assert.deepEqual(menuOf(0).map(label => label.slice(0, 5)), ['修改范围…', '撤销同时取']);
  assert.deepEqual([1, 2, 3, 4, 5].map(i => menuOf(i).map(label => label.slice(0, 2))), [['修改', '撤销'], ['撤销'], ['撤销'], ['撤销'], ['修改', '撤销']], 'ended, stopped and revoking ones have no 修改范围…');
  kebabOf(page, listRows(page, detail)[0]).fire('click');
  page.all(n => n.tag === 'button' && n.attrs.role === 'menuitem' && n.textContent === '修改范围…', listRows(page, detail)[0])[0].fire('click');
  await flush();
  assert.equal(isVisible(picker), true);
  assert.equal(picker.children[0].children[1].children[0].textContent, '修改范围');
  assert.ok(picker.textContent.includes('书房的 Mac mini'));
  assert.equal(page.all(n => n.tag === 'button' && n.textContent === '换一台机器', picker).length, 0, 'the machine cannot be changed');
  assert.ok('checked' in radioOf(page, picker, '仅限目录').attrs);
  assert.deepEqual(pathInputs(page, picker).map(n => n.value), DIRS.dirs.map(dir => dir.path));
  assert.deepEqual(accessSelects(page, picker).map(n => n.value), ['rw', 'ro']);
  // 改一行、保存：请求是 grants.restrict，带授权号与新范围。
  pathInputs(page, picker)[1].value = '/Users/me/notes'; pathInputs(page, picker)[1].fire('input');
  confirmButton(page, picker, '保存范围').fire('click');
  assert.ok(confirmButton(page, picker, '正在探测…').disabled);
  await flush();
  assert.deepEqual(sentOf(log, 'grants.restrict').map(s => [s.msg.grant, s.msg.restrict, s.machine]), [['g1', { dirs: [DIRS.dirs[0], { path: '/Users/me/notes', access: 'ro' }] }, 'a']]);
  gate.resolve({ ...list[0], restrict: { dirs: [DIRS.dirs[0], { path: '/Users/me/notes', access: 'ro' }] } });
  await flush();
  assert.equal(isVisible(picker), false);
  assert.equal(page.all(n => n.tag === 'summary', listRows(page, detail)[0])[0].textContent, '仅限目录 · /Users/me/work（读写）等 2 个');
});

test('modifying to the whole machine sends restrict null, adding a scope to a whole-machine grant works, and a failure is explained in the same form', async t => {
  const answers = [];
  const mac = { kind: GRANT_KIND, id: 'rx-1', name: '书房的 Mac mini' }, linux = { kind: GRANT_KIND, id: 'rx-3', name: '车库的 Linux' };
  const list = [grantRow('g1', { target: mac, restrict: DIRS }), grantRow('g2', { target: linux })];
  const { page, log, detail, picker } = await openShare(t, { share: { 'grants.targets': () => TARGETS, 'grants.list': () => ({ grants: list }), 'grants.restrict': msg => answers.shift()(msg) } });
  const edit = i => { kebabOf(page, listRows(page, detail)[i]).fire('click'); page.all(n => n.tag === 'button' && n.textContent === '修改范围…', listRows(page, detail)[i])[0].fire('click'); };
  // 改回整台机器。
  answers.push(msg => ({ ...list[0], restrict: undefined }));
  edit(0);
  await flush();
  radioOf(page, picker, '整台机器').fire('change');
  assert.deepEqual(pathInputs(page, picker), []);
  confirmButton(page, picker, '保存范围').fire('click');
  await flush();
  assert.equal(sentOf(log, 'grants.restrict')[0].msg.restrict, null);
  assert.equal(isVisible(picker), false);
  assert.ok(page.all(n => n.tag === 'span', listRows(page, detail)[0]).some(n => n.textContent === '整台机器'));
  // 整台机器的授权不在 Mac 上：「仅限目录」灰着，原因写明。
  edit(1);
  await flush();
  assert.ok(isOff(radioOf(page, picker, '仅限目录')) && picker.textContent.includes('第一期只支持 macOS 的机器'));
  page.dispatch('keydown', { key: 'Escape' });
  // 同样的授权在 Mac 上：加上范围，目标机拒绝，错误留在表单里。
  list[1] = grantRow('g2', { target: mac });
  answers.push(() => { throw coded('restrict_dir_not_found', `${DIRS.dirs[0].path}：不存在`); });
  feed(log, 'a', { friends: [{ node: 'n1', author: FRIEND, bound: true }] });
  page.dispatch('keydown', { key: 'Escape' });
  page.button('完成').fire('click');
  tiles(page)[0].fire('click');
  await flush();
  edit(1);
  await flush();
  fillDirs(page, picker, dirRows);
  confirmButton(page, picker, '保存范围').fire('click');
  await flush();
  assert.equal(isVisible(picker), true);
  assert.ok(warnOf(page, picker).textContent.includes('第 1 行') && warnOf(page, picker).textContent.includes('不存在'));
  assert.deepEqual(pathInputs(page, picker).map(n => n.value), DIRS.dirs.map(dir => dir.path));
});

test('what they granted me and the recent operations show the scope: whole machine or restricted, with the directories one tap away', async t => {
  const ROWS = [
    { v: 1, at: Date.UTC(2026, 10, 24, 6, 32), request: 'r1', friend: FRIEND, grant: 'g1', target: { kind: GRANT_KIND, id: 'rx-1', name: 'box' }, op: 'exec', command: { summary: 'ls', sha256: 'a'.repeat(64) }, outcome: 'completed', exitCode: 0, restrict: DIRS, ms: 400 },
    { v: 1, at: Date.UTC(2026, 10, 24, 3, 8), request: 'r2', friend: FRIEND, grant: 'g1', target: { kind: GRANT_KIND, id: 'rx-1', name: 'box' }, op: 'exec', command: { summary: 'pwd', sha256: 'b'.repeat(64) }, outcome: 'completed', exitCode: 0, ms: 38_000 }];
  const { page, detail } = await openShare(t, { share: { 'ledger.list': () => ROWS,
    'proxies.list': () => [{ key: 'k1', grant: 'p1', holder: FRIEND, name: '客厅的 Linux@小周', os: 'linux', user: 'u', status: 'available' },
      { key: 'k2', grant: 'p2', holder: FRIEND, name: '工作室的 Mac@小周', os: 'darwin', user: 'u', status: 'available', restrict: DIRS }] } });
  const theirs = listRows(page, detail).slice(0);
  assert.equal(theirs.length, 2);
  assert.ok(theirs[0].textContent.includes('整台机器') && !theirs[0].textContent.includes('仅限目录'));
  assert.ok(theirs[1].textContent.includes('仅限目录 · /Users/me/work（读写）等 2 个'));
  const more = page.all(n => n.tag === 'details' && cls(n) === 'scope', theirs[1])[0];
  assert.deepEqual(page.all(n => n.tag === 'li', more).map(n => n.textContent), [`读写${DIRS.dirs[0].path}`, `只读${DIRS.dirs[1].path}`]);
  const ops = page.all(n => n.tag === 'details' && cls(n) === 'ops', detail)[0];
  ops.open = true;
  ops.fire('toggle');
  await flush();
  const lines = page.all(n => cls(n) === 'op', detail);
  assert.equal(lines.length, 2);
  assert.ok(lines[0].textContent.includes('仅限目录 · 2 个'), 'the restricted call is marked');
  assert.deepEqual(page.all(n => n.tag === 'li', page.all(n => n.tag === 'details', lines[0])[0]).map(n => n.textContent), [`读写${DIRS.dirs[0].path}`, `只读${DIRS.dirs[1].path}`]);
  assert.ok(!lines[1].textContent.includes('仅限目录') && page.all(n => n.tag === 'details', lines[1]).length === 0, 'a whole-machine call has no mark');
});

test('the wording about what a restricted command can reach is not absolute, and the protected-location advice is to pick directories that do not overlap them', async t => {
  const { page, picker } = await openForm(t, { 'grants.grant': () => { throw coded('restrict_protected', '/Users/me/work 与受保护的 ~/.ssh 重叠，不能授出'); } });
  const text = page.all(n => n.tag === 'label' && n.textContent.startsWith('仅限目录'), picker)[0].textContent;
  assert.ok(text.includes('只能读写下面列出的目录') && text.includes('系统运行所需的只读路径') && text.includes('临时目录'), text);
  assert.ok(!text.includes('其余文件读写不到') && !text.includes('只看得到'));
  fillDirs(page, picker, dirRows);
  confirmButton(page, picker, '授予').fire('click');
  await flush();
  const warn = warnOf(page, picker).textContent;
  assert.ok(warn.includes('不重叠') && warn.includes('包含') && warn.includes('~/.ssh'), warn);
  assert.ok(!warn.includes('子目录') && !warn.includes('里面具体'), 'no advice to pick a directory inside a protected location');
});
