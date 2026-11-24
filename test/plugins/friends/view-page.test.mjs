import assert from 'node:assert/strict';
import { test } from 'node:test';
import { identiconPattern } from '../../../plugins/friends/lib/avatar.mjs';
import { FakeNode, deferred, flush, openPage } from '../view-dom.mjs';

const A = { id: 'a', name: 'A' }, B = { id: 'b', name: 'B' };
const AUTHOR = `ed25519:${'ab'.repeat(32)}`, CARD = 'friends/card';
const entry = { type: 'MODIFIED', entry: { spec: { author: AUTHOR }, status: { friends: [] } } };

// 严格多机的 window.coda：不指明 machine 的 postMessage 直接拒绝；记下每次发往哪台。
function strictCoda(page, { notes = { ok: true, value: {} }, silent, watch, call, records, machines = [A] } = {}) {
  const log = { sent: [], calls: [], queries: [], watches: [], on: {}, copied: [] };
  const coda = {
    machine: A, machines, getState: () => ({}), setState() {}, on(type, fn) { log.on[type] = fn; }, copy: async text => { log.copied.push(text); },
    toolbar: async () => {}, header: async () => {},
    async postMessage(msg, options) {
      if (!options?.machine) throw new Error('这一页有几台机器，postMessage 须指明 machine');
      log.sent.push({ msg, machine: options.machine });
      if (msg.type === 'notes.list' && options.machine !== silent) setImmediate(() => page.reply({ type: 'reply', rid: msg.rid, ...notes }, { id: options.machine }));
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

test('the add-friend dialog clears the auth key the moment it is submitted, then accepts and handshakes', async t => {
  const gate = deferred();
  const { page, log } = await open(t, { call: input => (input.control ? gate.promise : {}) });
  page.button('添加好友').fire('click');
  const invite = scrims(page)[2];
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
  page.all(n => n.attrs.placeholder === 'https://…', invite)[0].value = 'https://control.example';
  page.all(n => n.tag === 'input' && n.attrs.type === 'password', invite)[0].value = 'key';
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
