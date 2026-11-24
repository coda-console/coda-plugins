import assert from 'node:assert/strict';
import { test } from 'node:test';
import { identiconPattern } from '../../../plugins/friends/lib/avatar.mjs';
import { FakeNode, deferred, flush, openPage } from '../view-dom.mjs';

const A = { id: 'a', name: 'A' }, B = { id: 'b', name: 'B' };
const AUTHOR = `ed25519:${'ab'.repeat(32)}`, CARD = 'friends/card';
const entry = { type: 'MODIFIED', entry: { spec: { author: AUTHOR }, status: { friends: [] } } };

// 严格多机的 window.coda：不指明 machine 的 postMessage 直接拒绝；记下每次发往哪台。
// 「共享」一节读写持有方的消息默认都答空；`share` 按消息类型换成自己的答复（返回值就是 value，抛错是明确的拒绝，永不返回是没有回应）。
const SHARE = { 'grants.list': () => ({ grants: [] }), 'proxies.list': () => [], 'ledger.list': () => [], 'grants.targets': () => [] };
function strictCoda(page, { notes = { ok: true, value: {} }, silent, sendFail, watch, call, records, machines = [A], share = {}, inviteFriend, copy } = {}) {
  const log = { sent: [], calls: [], queries: [], watches: [], on: {}, copied: [], states: [], invites: [] };
  const coda = {
    machine: A, machines, getState: () => ({}), setState(state) { log.states.push(state); }, on(type, fn) { log.on[type] = fn; },
    copy: async text => { if (copy) await copy(text); log.copied.push(text); },
    ...(inviteFriend ? { inviteFriend: async options => { log.invites.push(options); return inviteFriend(options); } } : {}),
    toolbar: async () => {}, header: async () => {},
    async postMessage(msg, options) {
      if (!options?.machine) throw new Error('这一页有几台机器，postMessage 须指明 machine');
      if (sendFail?.(msg)) throw new Error('桥不可用');
      log.sent.push({ msg, machine: options.machine });
      if (msg.type === 'notes.list' && options.machine !== silent) setImmediate(() => page.reply({ type: 'reply', rid: msg.rid, ...notes }, { id: options.machine }));
      const answer = { ...SHARE, ...share }[msg.type];
      if (answer && options.machine !== silent) setImmediate(async () => {
        let reply;
        try { reply = { ok: true, value: await answer(msg, options.machine) }; } catch (e) { reply = { ok: false, error: e.message, effects: e.effects }; }
        page.reply({ type: 'reply', rid: msg.rid, ...reply }, { id: options.machine });
      });
    },
    watch(kind, cb, selector, options) { log.watches.push({ cb, machine: options?.machine }); return watch ? watch(options?.machine) : Promise.resolve({ dispose() {} }); },
    async query(target, op, params, options) { log.queries.push({ params, machine: options?.machine }); return { records: records ? records(params, options?.machine) : [] }; },
    async call(target, op, input, options) { log.calls.push({ op, input, machine: options?.machine }); return call ? call(input, options) : {}; },
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

test('a notes.list that fails is shown at once, and a later successful profile read does not clear it', async t => {
  const gate = deferred();
  const { page, log } = await open(t, { notes: { ok: false, error: 'boom' }, watch: () => gate.promise });
  assert.ok(page.text().includes('读不到本地备注：boom'), 'visible before the watch has answered');
  gate.resolve({ dispose() {} });
  await flush();
  log.watches[0].cb(entry);
  await flush();
  assert.ok(page.text().includes('ed25519:abababab'), 'the profile read went through');
  assert.ok(page.text().includes('读不到本地备注：boom'));
});

// ---- Hero、头像、编辑名片、详情与添加好友 ----

const SVG_NS = 'http://www.w3.org/2000/svg';
const OWNER = '123e4567-e89b-42d3-a456-426614174000', SHA = 'cd'.repeat(32);
const POINTER = { owner: OWNER, path: `content/${SHA}`, sha256: SHA, mime: 'image/webp', size: 1024 };
const FRIEND = `ed25519:${'12'.repeat(32)}`, OTHER = `ed25519:${'34'.repeat(32)}`, THIRD = `ed25519:${'56'.repeat(32)}`;
const card = (author, body, kind = 'profile') => ({ kind, id: 'self', author, version: 1, body });
const accord = status => ({ type: 'MODIFIED', entry: { spec: { author: AUTHOR }, status: { friends: [], ...status } } });
// 假 DOM 里 class 属性与 className 分开存：h() 写的是属性，页面后来改的是 className。
const cls = n => n.className || n.attrs.class || '';
const scrims = page => page.all(n => cls(n) === 'scrim'); // 编辑名片、好友详情、添加好友
const buttonIn = (page, node, label) => page.all(n => n.tag === 'button' && n.textContent === label, node)[0];
const nameInput = page => page.all(n => n.tag === 'input' && n.attrs.placeholder?.startsWith('昵称'))[0];
const tiles = page => page.all(n => n.tag === 'button' && cls(n).startsWith('f-tile'));

// 选图、画布、上传用到的浏览器 API 换成可控的：Image 读完就 load，objectURL 记下建了、收了哪些，fetch 交给 upload。
function browser(t, { upload } = {}) {
  const log = { created: [], revoked: [], fetches: [] };
  const saved = { Image: globalThis.Image, fetch: globalThis.fetch, create: URL.createObjectURL, revoke: URL.revokeObjectURL, encode: FakeNode.encode };
  globalThis.Image = class { naturalWidth = 800; naturalHeight = 600; set src(url) { setImmediate(() => this.onload()); } };
  let n = 0;
  URL.createObjectURL = () => { const url = `blob:fake/${++n}`; log.created.push(url); return url; };
  URL.revokeObjectURL = url => { log.revoked.push(url); };
  globalThis.fetch = async (url, init) => { log.fetches.push({ url, ...init }); return upload ? upload(url, init) : { ok: true, status: 200, json: async () => POINTER }; };
  t.after(() => {
    if (saved.Image) globalThis.Image = saved.Image; else delete globalThis.Image;
    globalThis.fetch = saved.fetch; URL.createObjectURL = saved.create; URL.revokeObjectURL = saved.revoke; FakeNode.encode = saved.encode;
  });
  return log;
}
async function chooseImage(page) {
  const input = page.all(n => n.tag === 'input' && n.attrs.type === 'file')[0];
  input.files = [new Blob(['png'], { type: 'image/png' })];
  input.fire('change');
  await flush();
}
async function editWithNewPhoto(page, name = '小明') {
  page.button('编辑名片').fire('click');
  nameInput(page).fire('input', { target: { value: name } });
  await chooseImage(page);
  return scrims(page)[0];
}

test('the hero and the status strip show the real card, friend counts and certificate state', async t => {
  const { page, log } = await open(t, { records: params => (params.kind === 'profile' ? [card(AUTHOR, { name: '小明', color: 'green', emoji: '🐱' })] : []) });
  const heroOf = () => page.all(n => n.tag === 'section' && cls(n).startsWith('hero'))[0];
  assert.ok(heroOf().textContent.includes('读取中…'));
  const friends = [{ node: 'n1', author: FRIEND, bound: true }, { node: 'n2', author: OTHER }, { node: 'n3', author: THIRD, conflict: true }];
  log.watches[0].cb(accord({ certificate: { active: true, until: Date.UTC(2030, 0, 2, 3, 4) }, friends }));
  await flush();
  assert.equal(cls(heroOf()), 'hero c-green');
  for (const part of ['小明', '我的名片', 'ed25519:abababab', '1 位已互认', '1 冲突', '1 待互认', '可发布', '证书有效至']) assert.ok(heroOf().textContent.includes(part), part);
  assert.equal(page.all(n => n.className === 'av lg k-emoji', heroOf())[0].textContent, '🐱');
  buttonIn(page, heroOf(), 'ed25519:abababab… · 复制').fire('click');
  await flush();
  assert.deepEqual(log.copied, [AUTHOR]);
  assert.ok(heroOf().textContent.includes('公钥已复制'));

  log.watches[0].cb(accord({ certificate: { active: false } }));
  await flush();
  for (const part of ['需要证书', '代签证书', '0 位已互认', '还没有好友']) assert.ok(heroOf().textContent.includes(part), part);
  log.watches[0].cb({ type: 'MODIFIED', entry: { spec: {}, status: { certificate: null, friends: [] } } });
  await flush();
  assert.ok(heroOf().textContent.includes('未建身份') && heroOf().textContent.includes('设置 › 身份'));
  assert.ok(!heroOf().textContent.includes('ed25519:'));
});

test('a friend photo loads from coda-view://blob, falls back once it fails, and retries on refresh', async t => {
  const { page, log } = await open(t, { records: params => (params.kind === CARD ? [card(FRIEND, { name: '阿青', emoji: '🌿', avatar: POINTER }, CARD)] : []) });
  const status = accord({ friends: [{ node: 'n1', author: FRIEND, bound: true, peerNode: 'qing-mac' }] });
  log.watches[0].cb(status);
  await flush();
  const url = `coda-view://blob/${OWNER}/content/${SHA}`;
  const images = () => page.all(n => n.tag === 'img').map(n => n.attrs.src);
  assert.deepEqual(images(), [url]);
  page.all(n => n.tag === 'img')[0].fire('error');
  assert.deepEqual(images(), []);
  assert.equal(page.all(n => n.className === 'av sm k-emoji', tiles(page)[0])[0].textContent, '🌿');
  log.watches[0].cb(status);
  await flush();
  assert.deepEqual(images(), [], 'a redraw does not try the failed photo again');
  log.on.toolbar({ id: 'refresh' });
  await flush();
  assert.deepEqual(images(), [url]);
});

test('a friend without photo or emoji gets the identicon of their key, built as SVG nodes', async t => {
  const { page, log } = await open(t, { records: params => (params.kind === 'profile' ? [card(FRIEND, { name: '阿木' })] : []) });
  log.watches[0].cb(accord({ friends: [{ node: 'n1', author: FRIEND, bound: true }] }));
  await flush();
  const [tile] = tiles(page);
  assert.ok(tile.textContent.includes('阿木') && tile.textContent.includes('@12121212') && tile.textContent.includes('已互认'));
  const icon = page.all(n => n.tag === 'svg', tile)[0];
  assert.equal(icon.namespaceURI, SVG_NS);
  const cells = page.all(n => n.tag === 'rect', icon);
  assert.equal(cells.length, identiconPattern(FRIEND).flat().filter(Boolean).length);
  assert.ok(cells.every(cell => cell.namespaceURI === SVG_NS));
  assert.deepEqual(page.all(n => n.tag === 'img', tile), []);
});

test('editing the card uploads the 512×512 crop and publishes the pointer it got back', async t => {
  const browserLog = browser(t);
  const { page, log } = await open(t);
  log.watches[0].cb(entry);
  await flush();
  const editor = await editWithNewPhoto(page);
  assert.equal(editor.hidden, false);
  assert.equal(page.all(n => n.className === 'crop-box', editor).length, 1);
  buttonIn(page, editor, '发布名片').fire('click');
  await flush();
  assert.equal(browserLog.fetches.length, 1);
  const [upload] = browserLog.fetches;
  assert.deepEqual([upload.url, upload.method, upload.headers['Content-Type'], upload.body.type], ['coda-view://blob/content', 'POST', 'image/webp', 'image/webp']);
  assert.deepEqual(log.calls.map(c => [c.input.kind, c.machine]), [['profile', 'a']]);
  assert.deepEqual(log.calls[0].input.body, { name: '小明', color: 'blue', avatar: POINTER });
  assert.equal(editor.hidden, true, 'the editor closes once published');
  assert.equal(buttonIn(page, editor, '发布名片').disabled, false, 'and its button is ready for next time');
  assert.ok(page.text().includes('名片已发布'));
  assert.deepEqual(browserLog.revoked, browserLog.created, 'the object URL is released');
});

test('without a WebP encoder the crop goes up as JPEG, at a lower quality when the first is too big', async t => {
  const browserLog = browser(t);
  const encoded = [];
  FakeNode.encode = (type, quality) => {
    encoded.push([type, quality]);
    if (type === 'image/webp') return new Blob(['png'], { type: 'image/png' });
    return new Blob([new Uint8Array(quality > 0.8 ? 5 * 1024 * 1024 + 1 : 2048)], { type });
  };
  const { page, log } = await open(t);
  log.watches[0].cb(entry);
  await flush();
  buttonIn(page, await editWithNewPhoto(page), '发布名片').fire('click');
  await flush();
  assert.deepEqual(encoded, [['image/webp', 0.86], ['image/jpeg', 0.86], ['image/jpeg', 0.72]]);
  assert.equal(browserLog.fetches[0].headers['Content-Type'], 'image/jpeg');
  assert.equal(browserLog.fetches[0].body.size, 2048);
});

test('renaming keeps the published photo without uploading again; clearing the photo publishes avatar: null', async t => {
  const browserLog = browser(t);
  const { page, log } = await open(t, { records: params => (params.kind === 'profile' ? [card(AUTHOR, { name: '小明', emoji: '🐱', avatar: POINTER })] : []) });
  log.watches[0].cb(entry);
  await flush();
  const hero = page.all(n => n.tag === 'section' && n.className.startsWith('hero'))[0];
  assert.equal(page.all(n => n.tag === 'img', hero)[0].attrs.src, `coda-view://blob/${OWNER}/content/${SHA}`);
  page.button('编辑名片').fire('click');
  nameInput(page).fire('input', { target: { value: '小明同学' } });
  page.button('发布名片').fire('click');
  await flush();
  assert.deepEqual(browserLog.fetches, []);
  assert.deepEqual(log.calls[0].input.body, { name: '小明同学', emoji: '🐱', color: 'blue', avatar: POINTER });

  page.button('编辑名片').fire('click');
  page.button('清除照片').fire('click');
  page.button('发布名片').fire('click');
  await flush();
  assert.deepEqual(log.calls[1].input.body, { name: '小明', color: 'blue', avatar: null });
  assert.deepEqual(browserLog.fetches, []);
});

test('the emoji and monogram modes publish through emoji and drop an old photo', async t => {
  browser(t);
  const { page, log } = await open(t, { records: params => (params.kind === 'profile' ? [card(AUTHOR, { name: 'alice', avatar: POINTER })] : []) });
  log.watches[0].cb(entry);
  await flush();
  page.button('编辑名片').fire('click');
  page.button('Emoji').fire('click');
  page.button('🦊').fire('click');
  page.button('发布名片').fire('click');
  await flush();
  assert.deepEqual(log.calls[0].input.body, { name: 'alice', emoji: '🦊', color: 'blue', avatar: null });
  page.button('编辑名片').fire('click');
  page.button('字标').fire('click');
  page.button('发布名片').fire('click');
  await flush();
  assert.deepEqual(log.calls[1].input.body, { name: 'alice', emoji: 'A', color: 'blue', avatar: null });
});

test('a failed upload says why and keeps the editor, the crop and the name as they were', async t => {
  let respond = () => ({ ok: false, status: 413 });
  const browserLog = browser(t, { upload: () => respond() });
  const { page, log } = await open(t);
  log.watches[0].cb(entry);
  await flush();
  const editor = await editWithNewPhoto(page);
  const publish = buttonIn(page, editor, '发布名片');
  const errorText = () => page.all(n => n.className === 'error', editor)[0]?.textContent ?? '';
  publish.fire('click');
  await flush();
  assert.ok(errorText().includes('图片太大'), errorText());
  respond = () => ({ ok: false, status: 404 });
  publish.fire('click');
  await flush();
  assert.ok(errorText().includes('不支持上传头像'), errorText());
  respond = () => { throw new TypeError('Load failed'); };
  publish.fire('click');
  await flush();
  assert.ok(errorText().includes('网络错误'), errorText());
  assert.deepEqual(log.calls, [], 'nothing was published');
  assert.equal(editor.hidden, false);
  assert.equal(page.all(n => n.className === 'crop-box', editor).length, 1);
  assert.deepEqual(browserLog.revoked, []);
  assert.equal(publish.disabled, false);
  publish.fire('click');
  respond = () => ({ ok: true, status: 200, json: async () => POINTER });
  await flush();
  assert.deepEqual(log.calls[0].input.body, { name: '小明', color: 'blue', avatar: POINTER }, 'the kept edit still publishes');
});

test('a publish still running when the editor is cancelled and reopened leaves the new draft alone', async t => {
  const gate = deferred();
  const browserLog = browser(t);
  const { page, log } = await open(t, { call: input => (input.kind === 'profile' ? gate.promise : {}) });
  log.watches[0].cb(entry);
  await flush();
  page.button('编辑名片').fire('click');
  nameInput(page).fire('input', { target: { value: '旧草稿' } });
  const editor = scrims(page)[0], publish = buttonIn(page, editor, '发布名片');
  publish.fire('click');
  await flush();
  assert.equal(publish.disabled, true);
  buttonIn(page, editor, '取消').fire('click');
  assert.equal(editor.hidden, true);
  page.button('编辑名片').fire('click');
  assert.equal(publish.disabled, false, 'the new session can publish at once');
  nameInput(page).fire('input', { target: { value: '新草稿' } });
  await chooseImage(page);
  gate.resolve({});
  await flush();
  assert.equal(editor.hidden, false, 'the old publish does not close the reopened editor');
  assert.equal(page.all(n => n.className === 'crop-box', editor).length, 1, 'nor clear its new crop');
  assert.deepEqual(browserLog.revoked, []);
  assert.equal(publish.disabled, false);
  assert.deepEqual(page.all(n => ['progress', 'ok', 'error'].includes(n.className)), [], 'and writes no message');
  publish.fire('click');
  await flush();
  assert.deepEqual(log.calls.map(c => c.input.body.name), ['旧草稿', '新草稿']);
  assert.deepEqual(log.calls[1].input.body.avatar, POINTER);
});

test('the friend detail edits the local note, re-handshakes, and removes only after a second confirmation', async t => {
  const { page, log } = await open(t, { records: params => (params.kind === 'profile' ? [card(FRIEND, { name: '阿青' })] : []) });
  log.watches[0].cb(accord({ friends: [{ node: 'n1', author: FRIEND, bound: true, peerNode: 'qing-mac' }] }));
  await flush();
  tiles(page)[0].fire('click');
  const detail = scrims(page)[1];
  assert.equal(detail.hidden, false);
  for (const part of [FRIEND, 'qing-mac', '已互认']) assert.ok(detail.textContent.includes(part), part);
  buttonIn(page, detail, '复制公钥').fire('click');
  await flush();
  assert.deepEqual(log.copied, [FRIEND]);

  const note = page.all(n => n.tag === 'input' && n.attrs.placeholder?.startsWith('备注名'), detail)[0];
  note.value = '老青';
  note.fire('keydown', { key: 'Enter' });
  await flush();
  const set = log.sent.find(s => s.msg.type === 'notes.set');
  assert.deepEqual([set.machine, set.msg.node, set.msg.note], ['a', 'n1', '老青']);
  page.reply({ type: 'reply', rid: set.msg.rid, ok: true, value: { n1: '老青' } }, { id: 'a' });
  await flush();
  assert.ok(detail.textContent.includes('备注已保存'));
  assert.ok(tiles(page)[0].textContent.includes('老青') && tiles(page)[0].textContent.includes('阿青'));

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

test('the add-friend dialog clears the auth key the moment it is submitted, then accepts and handshakes', async t => {
  const gate = deferred();
  const { page, log } = await open(t, { call: input => (input.control ? gate.promise : {}) });
  page.button('添加好友').fire('click');
  const invite = scrims(page)[2];
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
  const invite = scrims(page)[2], form = acceptForm(page, invite);
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
  assert.ok(invite.textContent.includes('缺少'));
});

test('when accept fails the token is cleared and not shown in the error either, and it is not handed out a second time', async t => {
  let fail = true;
  const { page, log } = await open(t, { call: backend(() => { if (fail) throw new Error('forbidden'); return { node: 'n9' }; }) });
  page.button('添加好友').fire('click');
  const invite = scrims(page)[2], form = acceptForm(page, invite);
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
  assert.ok(invite.textContent.includes('邀请缺少'));
  pasteInvite(form, inviteJson({ bindingToken: 'bt-second' }));
  form.submit.fire('click');
  await flush();
  assert.deepEqual(log.calls.filter(c => c.op === 'accept').map(c => c.input.bindingToken), [TOKEN_TEXT, 'bt-second']);
});

test('a paste without a bindingToken, or with one but no peerNode, is refused with the reason and nothing is sent', async t => {
  const { page, log } = await open(t, { call: backend() });
  page.button('添加好友').fire('click');
  const invite = scrims(page)[2], form = acceptForm(page, invite);
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

test('filling the fields by hand has no token to give: it is refused, but a paste that was not recognized yet is still read on submit', async t => {
  const { page, log } = await open(t, { call: backend() });
  page.button('添加好友').fire('click');
  const invite = scrims(page)[2], form = acceptForm(page, invite);
  form.control.value = 'https://control.example';
  form.authKey.value = 'tskey-secret';
  form.peerNode.value = 'node-5d2a8f';
  form.submit.fire('click');
  await flush();
  assert.deepEqual(log.calls, []);
  assert.ok(invite.textContent.includes('邀请缺少 bindingToken（一次性口令），请让对方重新生成邀请'));
  assert.ok(!page.all(n => n.tag === 'input' && /口令|token/i.test(n.attrs.placeholder ?? ''), invite).length, 'there is no box for the token');
  // 粘贴区有内容、输入框里没有手填：提交时再解析一次，口令随这份邀请。
  form.control.value = ''; form.authKey.value = ''; form.peerNode.value = '';
  form.paste.value = inviteJson();
  form.submit.fire('click');
  await flush();
  assert.equal(log.calls.find(c => c.op === 'accept').input.bindingToken, TOKEN_TEXT);
});

test('a new paste replaces the old token, and editing the control address or the auth key drops it', async t => {
  const { page, log } = await open(t, { call: backend() });
  page.button('添加好友').fire('click');
  const invite = scrims(page)[2], form = acceptForm(page, invite);
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
  const invite = scrims(page)[2], form = acceptForm(page, invite);
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
  const invite = scrims(page)[2], form = acceptForm(page, invite);
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
  const invite = scrims(page)[2], form = acceptForm(page, invite);
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
  const invite = scrims(page)[2], form = acceptForm(page, invite);
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
  const invite = scrims(page)[2], form = acceptForm(page, invite);
  pasteInvite(form, inviteJson());
  form.submit.fire('click');
  await flush();
  page.dispatch('keydown', { key: 'Escape' });
  log.calls.length = 0;
  log.watches[0].cb(accord({ friends: [{ node: 'n9', author: FRIEND, bound: false, peerNode: 'node-5d2a8f' }] }));
  await flush();
  tiles(page)[0].fire('click');
  const detail = scrims(page)[1];
  buttonIn(page, detail, '重新互认').fire('click');
  await flush();
  assert.deepEqual(log.calls.map(c => [c.op, c.input, c.machine]), [['handshake', { node: 'n9', peerNode: 'node-5d2a8f' }, 'a']]);
  assert.ok(!everywhere(page, log, form).includes(TOKEN_TEXT));
  assert.equal(form.paste.value, '', 'and the invite form was not asked to be filled again');
});

// ---- 视图里有几台：页面都读，名片按身份合并，好友按电脑分节 ----

const C = { id: 'c', name: 'C' };
const ME2 = `ed25519:${'ef'.repeat(32)}`;
const feed = (log, machine, status, author = AUTHOR) => log.watches.find(w => w.machine === machine).cb({ type: 'MODIFIED', entry: { spec: { author }, status: { friends: [], ...status } } });
const versioned = (author, body, version, kind = 'profile') => ({ kind, id: 'self', author, version, body });
const heroes = page => page.all(n => n.tag === 'section' && cls(n).startsWith('hero'));
const sectionTitles = page => page.all(n => n.tag === 'h2' && cls(n) === 'sec').map(n => n.children[0]);
const addButtons = page => page.all(n => n.tag === 'button' && n.textContent === '添加好友');
const callsOf = (log, op) => log.calls.filter(c => c.op === op).map(c => [c.input, c.machine]);

test('every reachable machine is read, with its machine named; the page keeps no machine choice and shows no machine bar', async t => {
  const saved = [];
  const { page, log } = await open(t, { machines: [A, B, { id: 'c', name: 'C', unreachable: '离线 3 小时' }] });
  assert.deepEqual(log.sent.map(s => [s.msg.type, s.machine]), [['notes.list', 'a'], ['notes.list', 'b']]);
  assert.deepEqual(log.watches.map(w => w.machine), ['a', 'b']);
  assert.deepEqual(page.all(n => n.tag === 'nav'), []);
  assert.deepEqual(page.all(n => n.tag === 'button' && n.attrs['aria-pressed'] !== undefined && ['A', 'B', 'C'].includes(n.textContent)), []);
  assert.deepEqual(saved, []);
});

test('two machines of one identity show one card: the one with the higher record version', async t => {
  const { page, log } = await open(t, { machines: [A, B], records: (params, machine) => (params.kind === 'profile'
    ? [versioned(AUTHOR, { name: machine === 'a' ? '旧名' : '新名' }, machine === 'a' ? 3 : 5)] : []) });
  feed(log, 'a', {});
  feed(log, 'b', {});
  await flush();
  assert.equal(heroes(page).length, 1);
  assert.ok(heroes(page)[0].textContent.includes('新名') && !page.text().includes('旧名'));
  assert.equal(page.all(n => n.tag === 'button' && n.textContent === '编辑名片').length, 1);
});

test('machines of two identities show one card each', async t => {
  const { page, log } = await open(t, { machines: [A, B], records: (params, machine) => (params.kind === 'profile'
    ? [versioned(machine === 'a' ? AUTHOR : ME2, { name: machine === 'a' ? '甲' : '乙' }, 1)] : []) });
  feed(log, 'a', {});
  feed(log, 'b', {}, ME2);
  await flush();
  assert.deepEqual(heroes(page).map(hero => ['甲', '乙'].find(name => hero.textContent.includes(name))), ['甲', '乙']);
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
  const { page, log } = await open(t, { machines: [A, B], watch: machine => (machine === 'a' ? Promise.reject(new Error('boom')) : Promise.resolve({ dispose() {} })),
    records: (params, machine) => (params.kind === 'profile' ? [card(AUTHOR, { name: machine === 'a' ? '甲' : '乙' })] : []) });
  feed(log, 'b', { friends: [{ node: 'n1', author: FRIEND, bound: true }] });
  await flush();
  const [a, b] = page.all(n => n.tag === 'section' && !cls(n).startsWith('hero'));
  assert.ok(a.textContent.includes('A：读不到本机的好友信息：boom'));
  assert.deepEqual(page.all(n => n.tag === 'button', a), [], 'no add-friend, no status strip, no friends on the failed machine');
  assert.ok(!a.textContent.includes('还没有好友') && !a.textContent.includes('位已互认'));
  assert.equal(page.all(n => n.tag === 'button' && n.textContent === '添加好友', b).length, 1);
  assert.equal(tiles(page).length, 1);
  assert.equal(heroes(page).length, 1, 'the failed machine takes no part in the card grouping');
  assert.ok(heroes(page)[0].textContent.includes('乙') && !page.text().includes('甲'));
  log.on.toolbar({ id: 'refresh' });
  await flush();
  const [freshA] = page.all(n => n.tag === 'section' && !cls(n).startsWith('hero'));
  assert.notEqual(freshA, a, 'the refresh redrew the sections');
  assert.ok(freshA.textContent.includes('读不到本机的好友信息：boom'), 'a successful card read does not clear the subscription error');
});

test('when every machine\'s Accord cannot be read, the card and its key line both say so instead of staying on loading', async t => {
  const { page } = await open(t, { machines: [A, B], watch: () => Promise.reject(new Error('boom')) });
  await flush();
  const [hero] = heroes(page);
  assert.equal(heroes(page).length, 1);
  assert.ok(hero.textContent.includes('读不到名片') && hero.textContent.includes('读不到公钥'));
  assert.ok(!hero.textContent.includes('读取中…'));
});

test('with one machine there is no machine title and the add-friend and status stay on the card', async t => {
  const { page, log } = await open(t, { machines: [A] });
  feed(log, 'a', {});
  await flush();
  assert.deepEqual(sectionTitles(page), ['好友']);
  assert.ok(!page.text().includes('A'.repeat(1) + '：') && !page.text().includes('读不到：'));
  assert.equal(addButtons(page).length, 1);
  assert.equal(page.all(n => n.tag === 'button' && n.textContent === '添加好友')[0].attrs.class, 'pill strong');
  assert.ok(heroes(page)[0].textContent.includes('添加好友') && heroes(page)[0].textContent.includes('0 位已互认'));
});

test('editing the card publishes to one machine only: the first of the identity that can sign; the photo goes up to it too', async t => {
  const browserLog = browser(t);
  const { page, log } = await open(t, { machines: [A, B] });
  feed(log, 'a', { certificate: { active: false } });
  feed(log, 'b', { certificate: { active: true } });
  await flush();
  const editor = await editWithNewPhoto(page);
  buttonIn(page, editor, '发布名片').fire('click');
  await flush();
  assert.deepEqual(log.calls.map(c => [c.input.kind, c.machine]), [['profile', 'b']]);
  assert.equal(browserLog.fetches.length, 1);
  assert.equal(browserLog.fetches[0].url, 'coda-view://blob/content?coda-machine=b');
});

test('editing the card with every machine able to sign goes to the first in the view, and only to it', async t => {
  browser(t);
  const { page, log } = await open(t, { machines: [A, B] });
  feed(log, 'a', { certificate: { active: true } });
  feed(log, 'b', { certificate: { active: true } });
  await flush();
  page.button('编辑名片').fire('click');
  nameInput(page).fire('input', { target: { value: '小明' } });
  page.button('发布名片').fire('click');
  await flush();
  assert.deepEqual(log.calls.map(c => c.machine), ['a']);
});

test('an invite accepted in a section, and the handshake after it, go to that section\'s machine only', async t => {
  const { page, log } = await open(t, { machines: [A, B], call: input => (input.control ? { node: 'n9' } : {}) });
  feed(log, 'a', {});
  feed(log, 'b', {});
  await flush();
  addButtons(page)[1].fire('click');
  const invite = scrims(page)[2];
  assert.ok(invite.textContent.includes('添加好友 · B'));
  pasteInvite(acceptForm(page, invite), inviteJson());
  buttonIn(page, invite, '接受邀请').fire('click');
  await flush();
  assert.deepEqual(log.calls.map(c => [c.op, c.machine]), [['accept', 'b'], ['handshake', 'b']]);
  assert.ok(invite.textContent.includes('好友已添加并完成互认'));
});

test('a friend\'s note, re-handshake and removal go to the machine of the row, even when the other machine has the same node', async t => {
  const { page, log } = await open(t, { machines: [A, B] });
  const friend = { node: 'n1', author: FRIEND, bound: true, peerNode: 'qing-mac' };
  feed(log, 'a', { friends: [friend] });
  feed(log, 'b', { friends: [friend] });
  await flush();
  assert.equal(tiles(page).length, 2);
  tiles(page)[1].fire('click');
  const detail = scrims(page)[1];
  assert.ok(detail.textContent.includes('B'));
  const note = page.all(n => n.tag === 'input' && n.attrs.placeholder?.startsWith('备注名'), detail)[0];
  note.value = '老青';
  buttonIn(page, detail, '保存').fire('click');
  await flush();
  const set = log.sent.find(s => s.msg.type === 'notes.set');
  assert.deepEqual([set.machine, set.msg.node, set.msg.note], ['b', 'n1', '老青']);
  page.reply({ type: 'reply', rid: set.msg.rid, ok: true, value: { n1: '老青' } }, { id: 'b' });
  await flush();
  assert.ok(tiles(page)[1].textContent.includes('老青'));
  assert.ok(!tiles(page)[0].textContent.includes('老青'), 'A has its own notes');
  buttonIn(page, detail, '重新互认').fire('click');
  await flush();
  assert.deepEqual(callsOf(log, 'handshake'), [[{ node: 'n1', peerNode: 'qing-mac' }, 'b']]);
  buttonIn(page, detail, '移除好友…').fire('click');
  buttonIn(page, detail, '确认移除').fire('click');
  await flush();
  assert.deepEqual(callsOf(log, 'remove'), [[{ node: 'n1' }, 'b']]);
});

test('a notes reply from the wrong machine does not settle another machine\'s request', async t => {
  const { page, log } = await open(t, { machines: [A, B], silent: 'a' });
  const asked = log.sent.find(s => s.machine === 'a').msg;
  page.reply({ type: 'reply', rid: asked.rid, ok: true, value: { n1: '串线' } }, { id: 'b' });
  await flush();
  assert.equal(log.watches.filter(w => w.machine === 'a').length, 0, 'A is still waiting for its own reply');
  page.reply({ type: 'reply', rid: asked.rid, ok: true, value: { n1: 'A 的备注' } }, { id: 'a' });
  await flush();
  feed(log, 'a', { friends: [{ node: 'n1', author: FRIEND, bound: true }] });
  await flush();
  assert.ok(tiles(page)[0].textContent.includes('A 的备注') && !page.text().includes('串线'));
});

test('each machine\'s refresh re-reads its own cards', async t => {
  const { log } = await open(t, { machines: [A, B] });
  feed(log, 'a', {});
  feed(log, 'b', {});
  await flush();
  log.queries.length = 0;
  log.on.toolbar({ id: 'refresh' });
  await flush();
  assert.deepEqual(log.queries.map(q => q.machine).sort(), ['a', 'a', 'b', 'b']);
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
  const invite = scrims(page)[2];
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
  const invite = scrims(page)[2], [top] = blocksOf(page, invite);
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
  const invite = scrims(page)[2], [top] = blocksOf(page, invite);
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
const TARGETS = [{ id: 'rx-1', name: '书房的 Mac mini', os: 'macOS 15.2', user: 'leavan', available: true }, { id: 'rx-2', name: '阳台的树莓派', os: 'Debian 12', user: 'pi', available: false },
  { id: 'rx-3', name: '车库的 Linux', os: 'Ubuntu 24.04', user: 'coda', available: true }];
// 打开好友详情（好友在第一台上、已绑定），返回详情与授予选择框。
async function openShare(t, { certified = true, ...options } = {}) {
  const { page, log } = await open(t, options);
  log.watches[0].cb(accord({ friends: [{ node: 'n1', author: FRIEND, bound: true, ...(certified === 'absent' ? {} : { certified }) }] }));
  await flush();
  tiles(page)[0].fire('click');
  await flush();
  return { page, log, detail: scrims(page)[1], picker: scrims(page)[3] };
}
const listRows = (page, node) => page.all(n => n.tag === 'li' && cls(n) === 'g-row', node);
const badgeOf = (page, row) => page.all(n => cls(n).startsWith('badge'), row)[0].textContent;
const kebabOf = (page, row) => page.all(n => n.tag === 'button' && cls(n) === 'kebab', row)[0];
const slotsOfRow = row => row.children.map(n => `${n.tag}.${cls(n).split(' ')[0]}`);
const sentOf = (log, type) => log.sent.filter(s => s.msg.type === type);
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

test('the granting dialog only picks records: no scope choice, the line under each row follows the friend\'s identity (person, machine, or unknown: none)', async t => {
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
    assert.ok(rows[0].textContent.includes('书房的 Mac mini') && rows[0].textContent.includes('macOS 15.2 · leavan'));
    assert.ok('disabled' in rows[1].attrs && rows[1].textContent.includes('远程执行没打开'));
    assert.ok(!('disabled' in rows[0].attrs));
    page.dispatch('keydown', { key: 'Escape' });
    assert.equal(isVisible(picker), false, 'Escape closes only the picker');
    assert.equal(isVisible(scrims(page)[1]), true, 'the friend detail stays');
  }
});

test('granting shows the row granting at once; the answer settles it, a refusal rolls it back with the reason on that row', async t => {
  const gate = deferred();
  let grant = () => gate.promise;
  const { page, log, detail, picker } = await openShare(t, { share: { 'grants.targets': () => TARGETS, 'grants.grant': () => grant() } });
  page.button('授予…').fire('click');
  await flush();
  chooseTarget(page, picker, '书房的 Mac mini').fire('click');
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
  chooseTarget(page, picker, '车库的 Linux').fire('click');
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
  const item = () => page.all(n => n.tag === 'button' && n.attrs.role === 'menuitem', rows()[0])[0];
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
    chooseTarget(page, picker, name).fire('click');
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
    chooseTarget(page, picker, '车库的 Linux').fire('click');
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
    chooseTarget(page, picker, '车库的 Linux').fire('click');
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

test('a grant with no answer is never rolled back by lists that do not show it: it stays granting, its target stays taken, and no second grant is sent until the list shows it', async t => {
  const timers = stubTimers(t);
  let listed = [];
  const { page, log, detail, picker } = await openShare(t, { share: { 'grants.targets': () => TARGETS, 'grants.list': () => ({ grants: listed }), 'grants.grant': () => deferred().promise } });
  page.button('授予…').fire('click');
  await flush();
  chooseTarget(page, picker, '车库的 Linux').fire('click');
  await flush();
  timers.fire(10_000);
  await flush();
  const rows = () => listRows(page, detail);
  for (let round = 0; round < 6; round++) {
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
  assert.equal(sentOf(log, 'grants.grant').length, 1, 'no second grant while the first has no outcome');
  // 列表里出现它，才算授出。
  listed = [grantRow('g8', { target: { kind: GRANT_KIND, id: 'rx-3', name: '车库的 Linux' } })];
  timers.fire(3000);
  await flush();
  assert.deepEqual(rows().map(row => badgeOf(page, row)), ['可用']);
});

test('a revoke whose message could not be sent is a plain failure: the row is usable again with the reason, and is not retried in the background', async t => {
  const timers = stubTimers(t);
  let broken = true;
  const { page, log, detail } = await openShare(t, { sendFail: msg => broken && msg.type === 'grants.revoke', share: { 'grants.list': () => ({ grants: [grantRow('g1')] }), 'grants.revoke': () => ({ ...grantRow('g1'), status: 'revoking', revokedAt: 5 }) } });
  const rows = () => listRows(page, detail);
  kebabOf(page, rows()[0]).fire('click');
  const item = () => page.all(n => n.tag === 'button' && n.attrs.role === 'menuitem', rows()[0])[0];
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
    page.all(n => n.tag === 'button' && n.attrs.role === 'menuitem', rows()[0])[0].fire('click');
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
  page.all(n => n.tag === 'button' && n.attrs.role === 'menuitem', detail)[0].fire('click');
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
  chooseTarget(page, picker, '车库的 Linux').fire('click');
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
  page.all(n => n.tag === 'button' && n.attrs.role === 'menuitem', detail)[0].fire('click');
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
  chooseTarget(page, picker, '车库的 Linux').fire('click');
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
  chooseTarget(page, picker, '车库的 Linux').fire('click');
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
  assert.deepEqual(theirs.map(row => [row.children[0].textContent, badgeOf(page, row)]), [['客厅的 Linux@小周', '可用'], ['工作室的 Mac@小周', 'TA 那边没开远程执行']]);
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
  const detail = scrims(page)[1];
  assert.equal(page.all(n => n.tag === 'h4' && n.textContent.startsWith('共享'), detail)[0].textContent, '共享 · B');
  assert.deepEqual(listRows(page, detail).map(row => row.textContent.includes('机器 gb')), [true]);
  assert.ok(!detail.textContent.includes('机器 ga'));
  assert.deepEqual(sentOf(log, 'grants.list').map(s => s.machine), ['b']);
  kebabOf(page, listRows(page, detail)[0]).fire('click');
  page.all(n => n.tag === 'button' && n.attrs.role === 'menuitem', detail)[0].fire('click');
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
  chooseTarget(page, picker, '车库的 Linux').fire('click');
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
  page.all(n => n.tag === 'button' && n.attrs.role === 'menuitem', detail)[0].fire('click');
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
