// 好友页：本机 Accord 身份与名片、接受好友邀请、好友列表。Accord 的读写（coda/accord@1）都在这里按交互发起；
// 备注只经模块存在本机。好友的昵称、备注、节点名等外来数据一律用 textContent / DOM API 渲染，不进 innerHTML。
import { Bridge } from 'coda-view://lib/v1/bridge.js';
import { CARD_KIND, COLORS, cardFallbackNotice, checked, mergeFriendRows, mergeProfileAndCard, normalizeProfileInput, parseInvite, readCardRecord, readProfileRecord,
  shortAuthor } from '../lib/friends.mjs';

const ACCORD = 'coda/accord@1', LOCAL = { kind: ACCORD, id: 'local' };
const coda = window.coda, bridge = new Bridge();
const root = document.getElementById('root');
const COLOR_NAMES = { blue: '蓝', orange: '橙', green: '绿', purple: '紫', pink: '粉', teal: '青', gray: '灰' };
const STATUS_TEXT = { bound: '已互认', pending: '待互认', conflict: '密钥冲突' };

const h = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value); else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.flat().filter(c => c !== null && c !== undefined && c !== false));
  return node;
};

const state = { author: null, friends: [], profiles: [], cards: [], notes: {}, loaded: false, problem: null, editing: null, removing: null, busy: new Set(), notice: new Map() };

// ---- 备注：经模块存在本机 ----
const pendingReplies = new Map();
let counter = 0;
bridge.on('reply', ({ rid, ok, value, error }) => {
  const wait = pendingReplies.get(rid);
  if (!wait) return;
  pendingReplies.delete(rid);
  if (ok) wait.resolve(value); else wait.reject(new Error(error));
});
function ask(type, input = {}) {
  const rid = `n${++counter}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pendingReplies.delete(rid); reject(new Error('模块没有回应')); }, 10_000);
    pendingReplies.set(rid, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
    bridge.send({ type, rid, ...input });
  });
}

// ---- 读本机 Accord ----
let reading = 0;
// profile 与 friends/card 各读各的：一种读不到或没有记录，不挡另一种。
async function readProfiles() {
  const mine = ++reading;
  const [profiles, cards] = await Promise.allSettled(['profile', CARD_KIND].map(kind => coda.query(LOCAL, 'records', { kind, limit: 200 })));
  if (mine !== reading) return;
  if (profiles.status === 'fulfilled') state.profiles = profiles.value?.records ?? [];
  if (cards.status === 'fulfilled') state.cards = cards.value?.records ?? [];
  const failed = [profiles, cards].find(read => read.status === 'rejected');
  state.problem = failed ? `读不到好友名片：${failed.reason?.message ?? failed.reason}` : null;
  if (!own.touched) loadOwn();
  draw();
}
const own = { touched: false, name: '', emoji: '', color: 'blue', avatar: undefined };
const latestOwn = (records, read) => records.map(read).filter(p => p && p.author === state.author).sort((a, b) => b.version - a.version)[0];
// 本机名片：与好友列表同一条合并规则（profile 写了的优先，缺的由 friends/card 补）；头像随表单带着，重新发布不会把它丢掉或带回已清除的。
function loadOwn() {
  const mine = mergeProfileAndCard(latestOwn(state.profiles, readProfileRecord), latestOwn(state.cards, readCardRecord));
  if (!mine) return;
  Object.assign(own, { name: mine.name, emoji: mine.emoji ?? '', color: mine.color ?? 'blue', avatar: mine.avatarPresent ? mine.avatar : undefined });
  syncOwnForm();
}

let watched = false;
function onChange({ type, entry }) {
  if (type === 'DELETED' || !entry) return;
  state.author = entry.spec?.author ?? null;
  state.friends = entry.status?.friends ?? [];
  state.loaded = true;
  draw();
  readProfiles();
}
async function start() {
  try { state.notes = await ask('notes.list'); } catch (e) { state.problem = `读不到本地备注：${e.message}`; }
  if (!watched) {
    watched = true;
    try { await coda.watch(ACCORD, onChange, { id: 'local' }); }
    catch (e) { watched = false; state.problem = `读不到本机的好友信息：${e.message}`; state.loaded = true; }
  }
  draw();
}

// ---- 我的身份与名片 ----
const ownForm = {
  name: h('input', { type: 'text', maxlength: '40', placeholder: '昵称（1–40 字）', autocomplete: 'off', oninput: e => { own.touched = true; own.name = e.target.value; } }),
  emoji: h('input', { type: 'text', placeholder: '头像 Emoji（可选）', autocomplete: 'off', oninput: e => { own.touched = true; own.emoji = e.target.value; } }),
  swatches: h('div', { class: 'swatches' }),
  message: h('p', { class: 'hint' }),
  button: h('button', { class: 'btn', type: 'button', onclick: publishProfile }, '发布名片'),
};
function syncOwnForm() {
  ownForm.name.value = own.name; ownForm.emoji.value = own.emoji;
  ownForm.swatches.replaceChildren(...COLORS.map(color => h('button', { class: `swatch c-${color}`, type: 'button', 'aria-label': `主题色：${COLOR_NAMES[color]}`, 'aria-pressed': String(own.color === color),
    onclick: () => { own.touched = true; own.color = color; syncOwnForm(); } })));
}
function say(target, text, kind = 'hint') { target.className = kind; target.textContent = text; }
async function publishProfile() {
  let body;
  try { body = normalizeProfileInput(own); } catch (e) { return say(ownForm.message, e.message, 'error'); }
  ownForm.button.disabled = true;
  say(ownForm.message, '正在发布…', 'progress');
  try {
    try {
      await coda.call(LOCAL, 'publish', { kind: 'profile', id: 'self', body, audience: ['public'] });
      say(ownForm.message, '名片已发布，好友会看到它', 'ok');
    } catch (e) {
      // 绑定了代签证书时 profile 须由客户端根签，这里发不了：改发可代签的社交名片 friends/card，好友一样看得到。
      if (e?.code !== 'forbidden') throw e;
      await coda.call(LOCAL, 'publish', { kind: CARD_KIND, id: 'self', body, audience: ['public'] });
      // 缓存的 state.profiles 可能还没读完或读失败了：现查一次本机作者的根签 profile，查不出来就不承诺。
      let rooted = null;
      try { rooted = ((await coda.query(LOCAL, 'records', { kind: 'profile', author: state.author, limit: 1 }))?.records ?? []).some(record => readProfileRecord(record)); } catch { /* 按没读出来提示 */ }
      say(ownForm.message, cardFallbackNotice(rooted), 'ok');
    }
    readProfiles();
  } catch (e) { say(ownForm.message, `没有发布成功：${e.message}`, 'error'); }
  ownForm.button.disabled = false;
}
const identity = { key: h('span', { class: 'key mono selectable' }), copy: h('button', { class: 'btn quiet small', type: 'button', onclick: copyKey }, '复制公钥'), message: h('p', { class: 'hint' }) };
async function copyKey() {
  if (!state.author) return;
  try { await coda.copy(state.author); say(identity.message, '公钥已复制', 'ok'); } catch (e) { say(identity.message, `复制失败：${e.message}`, 'error'); }
}

// ---- 添加好友 ----
const invite = {
  paste: h('textarea', { placeholder: '粘贴邀请：JSON、coda-friend:// 链接，或多行 control=… / authKey=…', autocomplete: 'off', spellcheck: 'false', oninput: parsePaste }),
  control: h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: 'https://…', oninput: dropHidden }),
  authKey: h('input', { type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: '入网码，提交后立即清空', oninput: dropHidden }),
  linkId: h('input', { type: 'text', autocomplete: 'off', placeholder: '留空自动生成' }),
  scope: h('input', { type: 'text', autocomplete: 'off', placeholder: '留空用本机空间' }),
  peerNode: h('input', { type: 'text', autocomplete: 'off', placeholder: '可选' }),
  message: h('p', { class: 'hint' }),
  button: h('button', { class: 'btn', type: 'button', onclick: submitInvite }, '接受邀请'),
  hidden: {},
};
// hostname、peerPort 只随识别出的那份邀请：手改入网地址或入网码就是另一份邀请了，丢掉；改 linkId、scope、peerNode 不算。
function dropHidden() { invite.hidden = {}; }
function parsePaste() {
  invite.hidden = {};
  const text = invite.paste.value;
  if (!text.trim()) return say(invite.message, '', 'hint');
  try {
    const found = parseInvite(text);
    for (const name of ['control', 'authKey', 'scope', 'peerNode']) if (found[name]) invite[name].value = found[name];
    if (found.linkId && !/^f-[0-9a-f]{8}$/.test(found.linkId)) invite.linkId.value = found.linkId;
    invite.hidden = { hostname: found.hostname ?? '', peerPort: found.peerPort };
    say(invite.message, '已识别邀请，核对后点「接受邀请」', 'ok');
  } catch (e) { say(invite.message, e.message, 'error'); }
}
function clearInvite() {
  for (const name of ['paste', 'control', 'authKey', 'linkId', 'scope', 'peerNode']) invite[name].value = '';
  invite.hidden = {};
}
async function submitInvite() {
  let input;
  try {
    input = checked({ control: invite.control.value, authKey: invite.authKey.value, linkId: invite.linkId.value, scope: invite.scope.value,
      peerNode: invite.peerNode.value, hostname: invite.hidden.hostname, peerPort: invite.hidden.peerPort });
  } catch (e) {
    // 只填了粘贴区、还没有识别出来：再试着从粘贴区解析一次。
    try { input = parseInvite(invite.paste.value); } catch { return say(invite.message, e.message, 'error'); }
  }
  // 入网码是凭据：取出后立刻清空所有输入框，不写进任何存储或日志。
  clearInvite();
  invite.button.disabled = true;
  say(invite.message, '正在接受邀请，加入对方的通道…', 'progress');
  const peerNode = input.peerNode;
  let node;
  try {
    ({ node } = await coda.call(LOCAL, 'accept', input));
  } catch (e) { input = null; invite.button.disabled = false; return say(invite.message, `接受邀请失败：${e.message}。入网码已清空，请重新粘贴邀请再试`, 'error'); }
  input = null;
  say(invite.message, '已加入通道，正在与对方互认…', 'progress');
  try {
    await coda.call(LOCAL, 'handshake', { node, ...(peerNode ? { peerNode } : {}) });
    say(invite.message, '好友已添加并完成互认', 'ok');
  } catch (e) { say(invite.message, `已加入通道，但互认暂未完成（${e.message}）。可稍后在好友列表点「互认」重试`, 'error'); }
  invite.button.disabled = false;
}

// ---- 好友列表 ----
const list = h('div');
const countBadge = h('span', { class: 'count' });
function rows() { return mergeFriendRows({ friends: state.friends, profiles: state.profiles, cards: state.cards, notes: state.notes }); }

async function handshake(row) {
  state.busy.add(row.node); state.notice.set(row.node, { kind: 'progress', text: '正在互认…' }); draw();
  try { await coda.call(LOCAL, 'handshake', { node: row.node, ...(row.peerNode ? { peerNode: row.peerNode } : {}) }); state.notice.set(row.node, { kind: 'ok', text: '互认完成' }); }
  catch (e) { state.notice.set(row.node, { kind: 'error', text: `互认失败：${e.message}` }); }
  state.busy.delete(row.node); draw();
}
async function remove(row) {
  state.busy.add(row.node); state.notice.set(row.node, { kind: 'progress', text: '正在移除…' }); draw();
  try { await coda.call(LOCAL, 'remove', { node: row.node }); state.notice.delete(row.node); state.removing = null; }
  catch (e) { state.notice.set(row.node, { kind: 'error', text: `移除失败：${e.message}` }); }
  state.busy.delete(row.node); draw();
}
async function saveNote(row, text) {
  state.editing = null;
  try { state.notes = await ask(text.trim() ? 'notes.set' : 'notes.delete', { node: row.node, note: text }); state.notice.delete(row.node); }
  catch (e) { state.notice.set(row.node, { kind: 'error', text: `备注没存下：${e.message}` }); }
  draw();
}

function friendRow(row) {
  const busy = state.busy.has(row.node), notice = state.notice.get(row.node);
  const avatar = h('div', { class: `avatar c-${row.color}`, 'aria-hidden': 'true' }, row.emoji || [...(row.note || row.profileName || '友')][0]);
  const names = h('div', { class: 'who' },
    h('span', { class: 'title truncate selectable' }, row.title),
    row.note && row.profileName ? h('span', { class: 'secondary truncate selectable' }, row.profileName) : null,
    h('span', { class: 'secondary mono truncate selectable' }, [row.short ? `ed25519:${row.short}` : '密钥未互认', row.peerNode ?? row.node].join(' · ')));
  const head = h('div', { class: 'line' }, avatar, names, h('span', { class: `badge ${row.status}` }, STATUS_TEXT[row.status]));
  let body;
  if (state.editing === row.node) {
    const input = h('input', { type: 'text', maxlength: '40', value: row.note, placeholder: '备注名（只存在本机，不会发给好友）', autocomplete: 'off',
      onkeydown: e => { if (e.key === 'Enter') saveNote(row, input.value); else if (e.key === 'Escape') { state.editing = null; draw(); } } });
    body = h('div', { class: 'line' }, input,
      h('button', { class: 'btn small', type: 'button', onclick: () => saveNote(row, input.value) }, '保存'),
      h('button', { class: 'btn quiet small', type: 'button', onclick: () => { state.editing = null; draw(); } }, '取消'));
    queueMicrotask(() => input.focus());
  } else if (state.removing === row.node) {
    body = h('div', { class: 'actions' }, h('span', { class: 'secondary' }, '移除后不再同步这位好友，确定吗？'),
      h('button', { class: 'btn danger small', type: 'button', disabled: busy, onclick: () => remove(row) }, '确认移除'),
      h('button', { class: 'btn quiet small', type: 'button', onclick: () => { state.removing = null; draw(); } }, '取消'));
  } else {
    body = h('div', { class: 'actions' },
      h('button', { class: 'btn quiet small', type: 'button', onclick: () => { state.editing = row.node; draw(); } }, row.note ? '改备注' : '备注'),
      h('button', { class: 'btn quiet small', type: 'button', disabled: busy, onclick: () => handshake(row) }, '互认'),
      h('button', { class: 'btn danger small', type: 'button', disabled: busy, onclick: () => { state.removing = row.node; draw(); } }, '移除'));
  }
  return h('li', { class: 'row' }, head, body, notice ? h('p', { class: notice.kind }, notice.text) : null);
}

const problem = h('p', { class: 'error selectable' });
function draw() {
  problem.textContent = state.problem ?? '';
  problem.hidden = !state.problem;
  identity.key.textContent = state.author ? `ed25519:${shortAuthor(state.author)}…` : state.loaded ? '未取得' : '读取中…';
  identity.copy.disabled = !state.author;
  const shown = rows();
  countBadge.textContent = String(shown.length);
  countBadge.hidden = !shown.length;
  list.replaceChildren(shown.length ? h('ul', { class: 'list' }, shown.map(friendRow))
    : h('p', { class: 'empty' }, state.loaded ? '还没有好友。在上面粘贴对方发来的邀请即可添加。' : '正在读取…'));
}

root.replaceChildren(h('div', { class: 'page' }, problem,
  h('section', {}, h('h2', {}, '我的身份与名片'), h('div', { class: 'card' },
    h('div', { class: 'line identity' }, h('span', { class: 'secondary' }, '本机公钥'), identity.key, h('span', { class: 'spacer' }), identity.copy), identity.message,
    h('div', { class: 'fields' }, h('label', { class: 'field' }, h('span', {}, '昵称'), ownForm.name), h('label', { class: 'field' }, h('span', {}, '头像'), ownForm.emoji)),
    h('div', { class: 'field' }, h('span', { class: 'secondary' }, '主题色'), ownForm.swatches),
    h('div', { class: 'line' }, ownForm.button), ownForm.message,
    h('p', { class: 'hint' }, '名片对所有人公开，只含昵称、头像和主题色。'))),
  h('section', {}, h('h2', {}, '添加好友'), h('div', { class: 'card' },
    h('p', { class: 'hint' }, '暂需由对方提供 friend 角色入网码，后续将支持客户端一键生成邀请。'),
    invite.paste,
    h('details', {}, h('summary', {}, '分字段填写'), h('div', { class: 'fields' },
      h('label', { class: 'field' }, h('span', {}, 'control（入网地址）'), invite.control),
      h('label', { class: 'field' }, h('span', {}, 'authKey（入网码）'), invite.authKey),
      h('label', { class: 'field' }, h('span', {}, 'linkId'), invite.linkId),
      h('label', { class: 'field' }, h('span', {}, 'scope'), invite.scope),
      h('label', { class: 'field' }, h('span', {}, 'peerNode'), invite.peerNode))),
    h('div', { class: 'line' }, invite.button), invite.message)),
  h('section', {}, h('h2', {}, '好友', countBadge), list)));
syncOwnForm();
draw();

function refresh() { readProfiles(); }
coda.on('toolbar', ({ id } = {}) => { if (id === 'refresh') refresh(); });
coda.toolbar([{ id: 'refresh', label: '刷新', icon: 'arrow.clockwise', kind: 'button' }]).catch(() => {});
coda.header({ text: '好友' }).catch(() => {});
start();
