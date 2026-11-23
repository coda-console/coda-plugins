// 好友页：本机 Accord 身份与名片（Hero + 状态条）、编辑名片（含本地选图裁剪上传）、好友列表与详情、添加好友。
// Accord 的读写（coda/accord@1）都在这里按交互发起；备注只经模块存在本机。好友的昵称、备注、节点名等外来数据一律用
// textContent / DOM API 渲染，从不拼 HTML 字符串；头像图片地址只来自 resolveAvatar（经 readContentPointer 白名单校验）。
import { accordStatusSummary, blobUploadUrl, initialChar, resolveAvatar } from '../lib/avatar.mjs';
import { CARD_KIND, COLORS, cardFallbackNotice, checked, mergeFriendRows, mergeProfileAndCard, normalizeCardInput, normalizeContentPointer, parseInvite,
  readCardRecord, readProfileRecord, shortAuthor } from '../lib/friends.mjs';
import { createMachineBridge, pickMachine } from '../lib/view-machine.mjs';
import { createCropper } from './cropper.mjs';
import { fill, h, identiconSvg, svg } from './dom.mjs';

const ACCORD = 'coda/accord@1', LOCAL = { kind: ACCORD, id: 'local' };
const coda = window.coda;
const root = document.getElementById('root');
const COLOR_NAMES = { blue: '蓝', orange: '橙', green: '绿', purple: '紫', pink: '粉', teal: '青', gray: '灰' };
const STATUS_TEXT = { bound: '已互认', pending: '待互认', conflict: '密钥冲突' };
const MODES = [['photo', '照片'], ['identicon', '几何纹'], ['emoji', 'Emoji'], ['monogram', '字标']];
const EMOJIS = ['😀', '😎', '🦊', '🐱', '🐼', '🌿', '☕', '🎧', '🚀', '⚡', '🌙', '✨'];
const UPLOAD_ERRORS = { 404: '当前客户端还不支持上传头像，请升级 Coda 后再试', 413: '图片太大（超过 5 MiB），请换一张' };

const newState = () => ({ entry: null, author: null, friends: [], profiles: [], cards: [], notes: {}, loaded: false, problem: null, notesProblem: null,
  busy: new Set(), notice: new Map(), detail: null, removing: null, failedPhotos: new Set() });
const state = newState();
let currentMachine = pickMachine(coda, coda.getState?.()?.machine);
// 读写都发往当前选中的机器；单机时不指明。多步操作在入口取一次，之后不再读 currentMachine。
const via = () => (currentMachine ? { machine: currentMachine } : undefined);
// 头像图片的读写地址只在多机空间里带 machine。
const multiMachine = () => Array.isArray(coda.machines) && coda.machines.length > 1;
const blobMachine = () => (multiMachine() ? currentMachine : null);
// 每次选机自增（A → B → A 也不同）：旧机器的订阅回调、异步回写，凭它丢弃。
let selectionGen = 0;
// 编辑名片的会话代际：每次打开、关闭编辑弹层或切机自增；旧会话的发布做完后不碰新会话的弹层、按钮、提示和裁剪。
let editorGen = 0;
function say(target, text, kind = 'hint') { target.className = kind; target.textContent = text; }

// ---- 备注：经模块存在本机 ----
const pendingReplies = new Map();
let counter = 0;
const bridge = createMachineBridge({
  coda,
  getMachine: () => currentMachine,
  getEpoch: () => selectionGen,
  onMessage({ type, rid, ok, value, error }) {
    if (type !== 'reply') return;
    const wait = pendingReplies.get(rid);
    if (!wait) return;
    pendingReplies.delete(rid);
    if (ok) wait.resolve(value); else wait.reject(new Error(error));
  },
  onError(error, msg) {
    const wait = pendingReplies.get(msg.rid);
    if (!wait) return;
    pendingReplies.delete(msg.rid);
    wait.reject(new Error(`发送失败：${error?.message ?? error}`));
  },
});
function ask(type, input = {}) {
  const rid = `n${++counter}`, machine = currentMachine;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pendingReplies.delete(rid); reject(new Error('模块没有回应')); }, 10_000);
    pendingReplies.set(rid, { machine, resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
    bridge.send({ type, rid, ...input });
  });
}

// ---- 读本机 Accord ----
let reading = 0;
// profile 与 friends/card 各读各的：一种读不到或没有记录，不挡另一种。
async function readProfiles() {
  const mine = ++reading;
  const [profiles, cards] = await Promise.allSettled(['profile', CARD_KIND].map(kind => coda.query(LOCAL, 'records', { kind, limit: 200 }, via())));
  if (mine !== reading) return;
  if (profiles.status === 'fulfilled') state.profiles = profiles.value?.records ?? [];
  if (cards.status === 'fulfilled') state.cards = cards.value?.records ?? [];
  const failed = [profiles, cards].find(read => read.status === 'rejected');
  state.problem = failed ? `读不到好友名片：${failed.reason?.message ?? failed.reason}` : null;
  loadOwn();
  draw();
}
// 本机已发布的名片（Hero 展示它）；编辑弹层另有一份草稿，打开时从它拷贝。
const blankOwn = () => ({ name: '', emoji: '', color: 'blue', avatar: undefined });
const own = blankOwn();
const latestOwn = (records, read) => records.map(read).filter(p => p && p.author === state.author).sort((a, b) => b.version - a.version)[0];
// 与好友列表同一条合并规则（profile 写了的优先，缺的由 friends/card 补）；头像随名片带着，重新发布不会把它丢掉或带回已清除的。
function loadOwn() {
  const mine = mergeProfileAndCard(latestOwn(state.profiles, readProfileRecord), latestOwn(state.cards, readCardRecord));
  if (mine) Object.assign(own, { name: mine.name, emoji: mine.emoji ?? '', color: mine.color ?? 'blue', avatar: mine.avatarPresent ? mine.avatar : undefined });
}

let watching = null;
function onChange({ type, entry }) {
  if (type === 'DELETED' || !entry) return;
  state.entry = entry;
  state.author = entry.spec?.author ?? null;
  state.friends = entry.status?.friends ?? [];
  state.loaded = true;
  draw();
  readProfiles();
}
async function start() {
  const gen = selectionGen, opts = via();
  try { state.notes = await ask('notes.list'); state.notesProblem = null; }
  catch (e) { if (gen === selectionGen) { state.notesProblem = `读不到本地备注：${e.message}`; draw(); } }
  if (gen !== selectionGen) return;
  if (!watching) {
    let mine;
    try {
      mine = watching = Promise.resolve(coda.watch(ACCORD, entry => { if (gen === selectionGen) onChange(entry); }, { id: 'local' }, opts));
      await mine;
    } catch (e) { if (watching === mine) watching = null; if (gen === selectionGen) { state.problem = `读不到本机的好友信息：${e.message}`; state.loaded = true; } }
  }
  if (gen === selectionGen) draw();
}

// ---- 头像 ----
// 按 resolveAvatar 的描述画头像；图片加载失败记下地址、就地换成它的 fallback，重绘时不再试（点「刷新」清空重试）。
function avatar(desc, size) {
  const node = h('span', { 'aria-hidden': 'true' });
  const show = d => {
    if (d.kind === 'photo' && state.failedPhotos.has(d.url)) return show(d.fallback);
    node.className = `av ${size} k-${d.kind}`;
    if (d.kind === 'photo') node.replaceChildren(h('img', { src: d.url, alt: '', draggable: 'false', onerror: () => { state.failedPhotos.add(d.url); show(d.fallback); } }));
    else if (d.kind === 'identicon') node.replaceChildren(identiconSvg(d.grid));
    else node.textContent = d.kind === 'emoji' ? d.emoji : d.text;
  };
  show(desc);
  return node;
}
const ownAvatar = () => resolveAvatar({ avatar: own.avatar, emoji: own.emoji, author: state.author, name: own.name, machine: blobMachine() });
const rowAvatar = row => resolveAvatar({ avatar: row.avatar, emoji: row.emoji, author: row.author, name: row.title, machine: blobMachine() });
const cameraIcon = () => svg('svg', { viewBox: '0 0 24 24', width: 11, height: 11, fill: 'none', stroke: 'currentColor', 'stroke-width': 2.4, 'aria-hidden': 'true' },
  svg('path', { d: 'M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z' }), svg('circle', { cx: 12, cy: 13, r: 4 }));

// ---- 弹层：宽屏居中模态，窄屏底部抽屉；同一时间只开一个 ----
let openDialog = null;
function makeDialog({ title, close: closeLabel, onClose, foot }) {
  const heading = h('h3', {}, title), body = h('div', { class: 'dlg-body' });
  const panel = h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true' }, h('div', { class: 'grabber', 'aria-hidden': 'true' }),
    h('div', { class: 'dlg-head' }, heading, h('button', { class: 'btn quiet small', type: 'button', onclick: () => closeDialog() }, closeLabel)),
    body, foot ? h('div', { class: 'dlg-foot' }, foot) : null);
  const scrim = h('div', { class: 'scrim', onclick: e => { if (e.target === scrim) closeDialog(); } }, panel);
  scrim.hidden = true;
  return { scrim, heading, body, onClose };
}
function showDialog(dialog) {
  if (openDialog && openDialog !== dialog) closeDialog();
  dialog.scrim.hidden = false;
  openDialog = dialog;
  coda.scroll?.(false)?.catch(() => {});
}
function closeDialog() {
  const dialog = openDialog;
  if (!dialog) return;
  openDialog = null;
  dialog.scrim.hidden = true;
  dialog.onClose?.();
  coda.scroll?.(true)?.catch(() => {});
}
addEventListener('keydown', e => { if (e.key === 'Escape' && openDialog) closeDialog(); });

// ---- 多台机器提供这页时，选看哪台 ----
const machineBar = h('nav', { class: 'machines', 'aria-label': '选择机器' });
function drawMachines() {
  const machines = Array.isArray(coda.machines) ? coda.machines : [];
  machineBar.hidden = machines.length < 2;
  fill(machineBar, ...(machines.length < 2 ? [] : machines.map(m => {
    if (m.unreachable) {
      const why = m.unreachable === true ? '暂时连不上' : String(m.unreachable);
      return h('button', { class: 'm-pill', type: 'button', disabled: true, title: `不可达：${why}`, 'aria-label': `${m.name || m.id}（不可达：${why}）` },
        h('span', { class: 'm-dot off' }), m.name || m.id, h('small', { class: 'm-why' }, '不可达'));
    }
    return h('button', { class: 'm-pill', type: 'button', 'aria-pressed': String(m.id === currentMachine), onclick: () => switchMachine(m.id) }, h('span', { class: 'm-dot' }), m.name || m.id);
  })));
}
function switchMachine(id) {
  if (id === currentMachine) return;
  currentMachine = id;
  selectionGen++;
  editorGen++;
  coda.setState?.({ machine: currentMachine });
  reading++;
  watching?.then(w => w?.dispose?.(), () => {});
  watching = null;
  for (const [rid, wait] of [...pendingReplies]) { pendingReplies.delete(rid); wait.reject(new Error('已切换机器')); }
  closeDialog();
  Object.assign(state, newState());
  Object.assign(own, blankOwn());
  editor.publish.disabled = false; invite.button.disabled = false;
  for (const target of [hero.message, editor.message, invite.message]) say(target, '');
  drawMachines();
  draw();
  start();
}

// ---- 我的名片：Hero 与状态条 ----
const hero = {
  card: h('section', { class: 'hero' }),
  avatar: h('button', { class: 'av-ring', type: 'button', 'aria-label': '更换头像', title: '更换头像', onclick: () => openEditor() }),
  name: h('h2', { class: 'hero-name selectable' }),
  key: h('button', { class: 'fp mono', type: 'button', onclick: copyKey }),
  lead: h('p', { class: 'hint' }),
  message: h('p', { class: 'hint' }),
  friends: h('div', { class: 'tile' }),
  cert: h('div', { class: 'tile' }),
};
hero.card.append(
  h('div', { class: 'banner' }, h('div', { class: 'banner-acts' },
    h('button', { class: 'pill', type: 'button', onclick: () => openEditor() }, '编辑名片'),
    h('button', { class: 'pill strong', type: 'button', onclick: () => showDialog(invite.dialog) }, '添加好友'))),
  h('div', { class: 'hero-body' },
    h('div', { class: 'hero-id' }, hero.avatar, h('div', { class: 'hero-names' }, h('div', { class: 'name-line' }, hero.name, h('span', { class: 'tag' }, '我的名片')), hero.key)),
    hero.lead, hero.message,
    h('div', { class: 'bento' }, hero.friends, hero.cert)));
const CERT = {
  active: { dot: 'ok-dot', text: '可发布' },
  needs_cert: { dot: 'warn-dot', text: '需要证书', sub: '需绑定或续期代签证书：前往客户端「设置 › 身份」处理后再发布名片' },
  no_identity: { dot: 'off-dot', text: '未建身份', sub: '前往客户端「设置 › 身份」创建' },
};
const formatTime = ms => new Date(ms).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
function tile(node, label, value, sub, dot) {
  fill(node, h('span', { class: 'tile-k' }, label), h('span', { class: 'tile-v' }, dot ? h('span', { class: `dot ${dot}` }) : null, value), sub);
}
function drawHero(shown) {
  hero.card.className = `hero c-${own.color}`;
  hero.avatar.replaceChildren(avatar(ownAvatar(), 'lg'), h('span', { class: 'cam' }, cameraIcon()));
  hero.name.textContent = own.name || (state.loaded ? '还没有名片' : '读取中…');
  hero.lead.textContent = own.name || !state.loaded ? '' : '点「编辑名片」设置昵称、头像和主题色，好友就能认出你。名片对所有人公开。';
  hero.lead.hidden = !hero.lead.textContent;
  const summary = accordStatusSummary(state.entry, shown);
  hero.key.disabled = !state.author;
  hero.key.textContent = state.author ? `ed25519:${summary.short}… · 复制` : !state.loaded ? '读取中…' : summary.cert === 'no_identity' ? '未建身份' : '未取得公钥';
  hero.key.title = state.author ? '复制完整公钥' : '';
  if (!state.loaded) {
    tile(hero.friends, '好友', '读取中…');
    tile(hero.cert, '身份', '读取中…');
    return;
  }
  const { bound, pending, conflict, total } = summary.friends;
  tile(hero.friends, '好友', `${bound} 位已互认`, h('span', { class: 'tile-s' },
    conflict ? h('span', { class: 'badge conflict' }, `${conflict} 冲突`) : null,
    pending ? h('span', { class: 'badge pending' }, `${pending} 待互认`) : null,
    conflict || pending ? null : total ? '全部已互认' : '还没有好友'));
  const cert = CERT[summary.cert];
  const sub = summary.cert === 'active' ? (summary.certUntil ? `证书有效至 ${formatTime(summary.certUntil)}` : '名片可正常发布') : cert.sub;
  tile(hero.cert, '身份', cert.text, h('span', { class: 'tile-s' }, sub), cert.dot);
}
async function copyKey() {
  if (!state.author) return;
  const gen = selectionGen;
  try { await coda.copy(state.author); if (gen === selectionGen) say(hero.message, '公钥已复制', 'ok'); } catch (e) { if (gen === selectionGen) say(hero.message, `复制失败：${e.message}`, 'error'); }
}

// ---- 编辑名片 ----
// 草稿：mode 决定头像怎么发；avatar 是沿用的已有图片指针（清除照片后为 null），新选的图在 cropper 里。
const draft = { name: '', color: 'blue', mode: 'identicon', emoji: '', avatar: null };
const preview = { canvas: h('canvas', { class: 'preview-canvas', width: 144, height: 144 }) };
const cropper = createCropper({ onChange: () => { if (draft.mode === 'photo' && cropper.ready) mirrorCrop(); } });
function mirrorCrop() {
  const ctx = preview.canvas.getContext('2d');
  ctx.clearRect(0, 0, 144, 144);
  ctx.drawImage(cropper.canvas, 0, 0, 144, 144);
}
const editor = {
  dialog: null,
  preview: h('div', { class: 'mini-card' }),
  modes: h('div', { class: 'seg', role: 'group', 'aria-label': '头像类型' }),
  file: h('input', { type: 'file', accept: 'image/*', onchange: pickFile }),
  photo: h('div', { class: 'pane' }),
  emoji: h('input', { type: 'text', maxlength: '8', placeholder: '自定义 Emoji（1–8 字）', autocomplete: 'off', oninput: e => { draft.emoji = e.target.value; syncEditor(); } }),
  emojis: h('div', { class: 'emoji-grid' }),
  other: h('p', { class: 'hint' }),
  name: h('input', { type: 'text', maxlength: '40', placeholder: '昵称（1–40 字）', autocomplete: 'off', oninput: e => { draft.name = e.target.value; syncPreview(); } }),
  swatches: h('div', { class: 'swatches', role: 'group', 'aria-label': '主题色' }),
  message: h('p', { class: 'hint' }),
  publish: h('button', { class: 'btn', type: 'button', onclick: publishCard }, '发布名片'),
};
editor.file.hidden = true;
editor.emojiPane = h('div', { class: 'pane' }, editor.emojis, editor.emoji);
editor.dialog = makeDialog({ title: '编辑名片', close: '取消', onClose: () => { editorGen++; cropper.clear(); },
  foot: [editor.message, h('span', { class: 'spacer' }), editor.publish] });
editor.dialog.body.append(h('div', { class: 'ed-cols' },
  h('div', { class: 'ed-preview' }, editor.preview, h('p', { class: 'hint center' }, '实时预览 · 好友看到的效果')),
  h('div', { class: 'ed-controls' },
    h('span', { class: 'lbl' }, '头像'), editor.modes, editor.file, editor.photo, editor.emojiPane, editor.other,
    h('label', { class: 'field' }, h('span', { class: 'lbl' }, '昵称'), editor.name),
    h('div', { class: 'field' }, h('span', { class: 'lbl' }, '主题色'), editor.swatches))));

const modeOf = card => (card.avatar ? 'photo' : !card.emoji ? 'identicon' : card.emoji === initialChar(card.name, '') ? 'monogram' : 'emoji');
function openEditor() {
  editorGen++;
  cropper.clear();
  editor.publish.disabled = false;
  Object.assign(draft, { name: own.name, color: own.color, mode: modeOf(own), emoji: own.emoji, avatar: own.avatar ?? null });
  editor.name.value = draft.name;
  editor.emoji.value = draft.mode === 'emoji' ? draft.emoji : '';
  if (draft.mode !== 'emoji') draft.emoji = '';
  say(editor.message, '');
  syncEditor();
  showDialog(editor.dialog);
}
function draftAvatar() {
  const author = state.author, name = draft.name;
  if (draft.mode === 'photo') return resolveAvatar({ avatar: draft.avatar, emoji: own.emoji, author, name, machine: blobMachine() });
  if (draft.mode === 'emoji') return resolveAvatar({ emoji: draft.emoji, author, name });
  if (draft.mode === 'monogram') return { kind: 'monogram', text: initialChar(name) };
  return resolveAvatar({ author, name });
}
function syncPreview() {
  const fresh = draft.mode === 'photo' && cropper.ready;
  editor.preview.className = `mini-card c-${draft.color}`;
  editor.preview.replaceChildren(h('div', { class: 'banner small' }),
    h('div', { class: 'mini-body' },
      h('span', { class: 'av-ring md' }, fresh ? h('span', { class: 'av md k-photo' }, preview.canvas) : avatar(draftAvatar(), 'md')),
      h('div', { class: 'mini-name truncate' }, draft.name.trim() || '未命名'),
      state.author ? h('div', { class: 'mono secondary' }, `@${shortAuthor(state.author)}`) : null));
  if (fresh) mirrorCrop();
  if (draft.mode === 'monogram') editor.other.textContent = `以昵称首字「${initialChar(draft.name)}」作头像，昵称改了它跟着变。`;
}
function syncEditor() {
  editor.modes.replaceChildren(...MODES.map(([mode, label]) => h('button', { type: 'button', 'aria-pressed': String(draft.mode === mode), onclick: () => { draft.mode = mode; syncEditor(); } }, label)));
  editor.photo.hidden = draft.mode !== 'photo';
  editor.emojiPane.hidden = draft.mode !== 'emoji';
  editor.other.hidden = draft.mode !== 'identicon' && draft.mode !== 'monogram';
  editor.other.textContent = draft.mode === 'identicon' ? (state.author ? '由你的公钥确定性生成的 5×5 几何纹，换设备也一样。' : '取得身份后按公钥生成几何纹；现在先以昵称首字代替。') : '';
  const choose = h('button', { class: 'btn quiet small', type: 'button', onclick: () => editor.file.click() }, cropper.ready || draft.avatar ? '换一张' : '选择图片');
  const clear = cropper.ready || draft.avatar ? h('button', { class: 'btn danger small', type: 'button', onclick: clearPhoto }, '清除照片') : null;
  fill(editor.photo, ...(cropper.ready
    ? [cropper.box, h('div', { class: 'zoom-row' }, h('span', { class: 'secondary' }, '缩放'), cropper.zoom, cropper.zoomText),
      h('div', { class: 'actions' }, choose, h('button', { class: 'btn quiet small', type: 'button', onclick: () => cropper.reset() }, '重置裁切'), clear),
      h('p', { class: 'hint' }, '拖动图片调整位置；发布时导出 512×512 的正方形头像。')]
    : [h('p', { class: 'hint' }, draft.avatar ? '正在使用已发布的照片。' : '从本机选一张图片，裁剪成正方形头像。'), h('div', { class: 'actions' }, choose, clear)]));
  editor.emojis.replaceChildren(...EMOJIS.map(mark => h('button', { type: 'button', class: 'emoji-opt', 'aria-label': `Emoji ${mark}`, 'aria-pressed': String(draft.emoji === mark),
    onclick: () => { draft.emoji = mark; editor.emoji.value = mark; syncEditor(); } }, mark)));
  editor.swatches.replaceChildren(...COLORS.map(color => h('button', { class: `swatch c-${color}`, type: 'button', 'aria-label': `主题色：${COLOR_NAMES[color]}`, 'aria-pressed': String(draft.color === color),
    onclick: () => { draft.color = color; syncEditor(); } })));
  syncPreview();
}
function pickFile(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  say(editor.message, '');
  cropper.load(file).then(loaded => { if (loaded) { draft.mode = 'photo'; syncEditor(); } }, error => { say(editor.message, error.message, 'error'); syncEditor(); });
}
function clearPhoto() {
  cropper.clear();
  draft.avatar = null;
  draft.mode = 'identicon';
  syncEditor();
}
// 发布用的名片字段：原名片有图而这次不用照片，就显式写 avatar: null 清除；照片模式没换图就沿用已有指针，不重复上传。
function draftFields() {
  const fields = { name: draft.name, color: draft.color }, drop = own.avatar ? null : undefined;
  if (draft.mode === 'photo') {
    if (!cropper.ready && !draft.avatar) throw new Error('请先选择一张图片，或换用其他头像类型');
    return { ...fields, emoji: own.emoji, avatar: cropper.ready ? undefined : draft.avatar };
  }
  if (draft.mode === 'emoji') {
    if (!draft.emoji.trim()) throw new Error('请选一个或输入一个 Emoji');
    return { ...fields, emoji: draft.emoji, avatar: drop };
  }
  // 字标不扩协议：把昵称首字写进 emoji，双方都按 emoji 显示。
  return { ...fields, emoji: draft.mode === 'monogram' ? initialChar(draft.name, '') : undefined, avatar: drop };
}
async function uploadAvatar(blob, machine) {
  let response;
  try { response = await fetch(blobUploadUrl(machine), { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob }); }
  catch (e) { throw new Error(`头像上传失败（网络错误：${e.message}）`); }
  if (!response.ok) throw new Error(UPLOAD_ERRORS[response.status] ?? `头像上传失败（HTTP ${response.status}）`);
  const { owner, path, sha256, mime, size, name } = await response.json();
  return normalizeContentPointer({ owner, path, sha256, mime, size, name });
}
// 发 profile；绑定了代签证书时 profile 须由客户端根签，这里发不了：改发可代签的社交名片 friends/card，好友一样看得到。
async function publishBody(body, opts, author, live) {
  try {
    await coda.call(LOCAL, 'publish', { kind: 'profile', id: 'self', body, audience: ['public'] }, opts);
    return '名片已发布，好友会看到它';
  } catch (e) {
    if (e?.code !== 'forbidden') throw e;
    await coda.call(LOCAL, 'publish', { kind: CARD_KIND, id: 'self', body, audience: ['public'] }, opts);
    // 缓存的 state.profiles 可能还没读完或读失败了：现查一次本机作者的根签 profile，查不出来就不承诺。已切机就不必查了。
    if (!live()) return null;
    let rooted = null;
    try { rooted = ((await coda.query(LOCAL, 'records', { kind: 'profile', author, limit: 1 }, opts))?.records ?? []).some(record => readProfileRecord(record)); } catch { /* 按没读出来提示 */ }
    return cardFallbackNotice(rooted);
  }
}
// 上传与发布都绑定入口时的机器与代际：途中切了机，仍在原机器做完，但不往新机器的页面写任何状态。
async function publishCard() {
  const upload = draft.mode === 'photo' && cropper.ready;
  let body;
  try { body = normalizeCardInput(draftFields()); } catch (e) { return say(editor.message, e.message, 'error'); }
  const gen = selectionGen, session = editorGen, opts = via(), machine = blobMachine(), author = state.author, live = () => gen === selectionGen;
  const current = () => live() && session === editorGen;
  editor.publish.disabled = true;
  try {
    if (upload) {
      say(editor.message, '正在处理图片…', 'progress');
      const blob = await cropper.export();
      if (current()) say(editor.message, '正在上传头像…', 'progress');
      body = { ...body, avatar: await uploadAvatar(blob, machine) };
    }
    if (current()) say(editor.message, '正在发布…', 'progress');
    const notice = await publishBody(body, opts, author, live);
    if (live()) readProfiles();
    if (current()) {
      // 关弹层会让会话代际自增，所以先恢复按钮。
      editor.publish.disabled = false;
      closeDialog();
      say(hero.message, notice, 'ok');
    }
  } catch (e) { if (current()) say(editor.message, `没有发布成功：${e.message}`, 'error'); }
  if (current()) editor.publish.disabled = false;
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
invite.dialog = makeDialog({ title: '添加好友', close: '关闭' });
invite.dialog.body.append(h('div', { class: 'stack' },
  h('p', { class: 'hint' }, '暂需由对方提供 friend 角色入网码，后续将支持客户端一键生成邀请。'),
  invite.paste,
  h('details', {}, h('summary', {}, '分字段填写'), h('div', { class: 'fields' },
    h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'control（入网地址）'), invite.control),
    h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'authKey（入网码）'), invite.authKey),
    h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'linkId'), invite.linkId),
    h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'scope'), invite.scope),
    h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'peerNode'), invite.peerNode))),
  h('div', { class: 'line' }, invite.button), invite.message));
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
  const gen = selectionGen, opts = via(), live = () => gen === selectionGen;
  invite.button.disabled = true;
  say(invite.message, '正在接受邀请，加入对方的通道…', 'progress');
  const peerNode = input.peerNode;
  let node;
  try {
    ({ node } = await coda.call(LOCAL, 'accept', input, opts));
  } catch (e) {
    input = null;
    if (!live()) return;
    invite.button.disabled = false;
    return say(invite.message, `接受邀请失败：${e.message}。入网码已清空，请重新粘贴邀请再试`, 'error');
  }
  input = null;
  if (live()) say(invite.message, '已加入通道，正在与对方互认…', 'progress');
  try {
    await coda.call(LOCAL, 'handshake', { node, ...(peerNode ? { peerNode } : {}) }, opts);
    if (live()) say(invite.message, '好友已添加并完成互认', 'ok');
  } catch (e) { if (live()) say(invite.message, `已加入通道，但互认暂未完成（${e.message}）。可稍后在好友详情里点「重新互认」重试`, 'error'); }
  if (live()) invite.button.disabled = false;
}

// ---- 好友列表与详情 ----
const list = h('div');
const countBadge = h('span', { class: 'count' });
function rows() { return mergeFriendRows({ friends: state.friends, profiles: state.profiles, cards: state.cards, notes: state.notes }); }

async function handshake(row) {
  const gen = selectionGen, opts = via();
  state.busy.add(row.node); state.notice.set(row.node, { kind: 'progress', text: '正在互认…' }); draw();
  let notice;
  try { await coda.call(LOCAL, 'handshake', { node: row.node, ...(row.peerNode ? { peerNode: row.peerNode } : {}) }, opts); notice = { kind: 'ok', text: '互认完成' }; }
  catch (e) { notice = { kind: 'error', text: `互认失败：${e.message}` }; }
  if (gen !== selectionGen) return;
  state.notice.set(row.node, notice); state.busy.delete(row.node); draw();
}
async function remove(row) {
  const gen = selectionGen, opts = via();
  state.busy.add(row.node); state.notice.set(row.node, { kind: 'progress', text: '正在移除…' }); draw();
  let failure = null;
  try { await coda.call(LOCAL, 'remove', { node: row.node }, opts); }
  catch (e) { failure = { kind: 'error', text: `移除失败：${e.message}` }; }
  if (gen !== selectionGen) return;
  state.busy.delete(row.node);
  if (failure) state.notice.set(row.node, failure);
  else {
    state.notice.delete(row.node); state.removing = null;
    if (state.detail === row.node) closeDialog();
  }
  draw();
}
async function saveNote(row, text) {
  const gen = selectionGen;
  state.busy.add(row.node); state.notice.set(row.node, { kind: 'progress', text: '正在保存备注…' }); draw();
  let saved, failure;
  try { saved = await ask(text.trim() ? 'notes.set' : 'notes.delete', { node: row.node, note: text }); }
  catch (e) { failure = { kind: 'error', text: `备注没存下：${e.message}` }; }
  if (gen !== selectionGen) return;
  state.busy.delete(row.node);
  if (failure) state.notice.set(row.node, failure);
  else {
    state.notes = saved;
    state.notice.set(row.node, { kind: 'ok', text: text.trim() ? '备注已保存' : '备注已清空' });
    if (state.detail === row.node) detail.note.value = rows().find(r => r.node === row.node)?.note ?? '';
  }
  draw();
}

const detail = {
  dialog: makeDialog({ title: '好友', close: '完成', onClose: () => { state.detail = null; state.removing = null; } }),
  card: h('div'),
  info: h('dl', { class: 'facts' }),
  note: h('input', { type: 'text', maxlength: '40', placeholder: '备注名（只存在本机，不会发给好友）', autocomplete: 'off',
    onkeydown: e => { if (e.key === 'Enter') noteAction(row => saveNote(row, detail.note.value)); } }),
  noteButtons: h('div', { class: 'line' }),
  actions: h('div', { class: 'actions split' }),
  notice: h('div'),
};
detail.dialog.body.append(h('div', { class: 'stack' }, detail.card, detail.info,
  h('div', { class: 'field' }, h('span', { class: 'lbl' }, '本机备注'), h('div', { class: 'line nowrap' }, detail.note, detail.noteButtons)),
  detail.actions, detail.notice));
const detailRow = () => rows().find(row => row.node === state.detail);
function noteAction(run) { const row = detailRow(); if (row && !state.busy.has(row.node)) run(row); }
function openDetail(row) {
  state.detail = row.node; state.removing = null;
  detail.note.value = row.note;
  drawDetail();
  showDialog(detail.dialog);
}
function fact(label, ...value) { return [h('dt', {}, label), h('dd', { class: 'selectable' }, ...value)]; }
async function copyFriendKey(row) {
  const gen = selectionGen;
  try { await coda.copy(row.author); if (gen === selectionGen) { state.notice.set(row.node, { kind: 'ok', text: '公钥已复制' }); draw(); } }
  catch (e) { if (gen === selectionGen) { state.notice.set(row.node, { kind: 'error', text: `复制失败：${e.message}` }); draw(); } }
}
function drawDetail() {
  const row = detailRow();
  if (!row) return;
  const busy = state.busy.has(row.node), notice = state.notice.get(row.node);
  detail.dialog.heading.textContent = row.title;
  detail.card.replaceChildren(h('div', { class: `mini-card c-${row.color}` }, h('div', { class: 'banner small' }),
    h('div', { class: 'mini-body row' }, h('span', { class: 'av-ring lg' }, avatar(rowAvatar(row), 'lg')),
      h('div', { class: 'mini-names' }, h('div', { class: 'mini-name truncate selectable' }, row.title),
        row.note && row.profileName ? h('div', { class: 'secondary truncate selectable' }, `原名 ${row.profileName}`) : null),
      h('span', { class: `badge ${row.status}` }, STATUS_TEXT[row.status]))));
  detail.info.replaceChildren(
    ...fact('公钥', row.author ? h('span', { class: 'mono key-full' }, row.author) : h('span', { class: 'secondary' }, '密钥未互认'),
      row.author ? h('button', { class: 'btn quiet small', type: 'button', onclick: () => copyFriendKey(row) }, '复制公钥') : null),
    ...fact('节点', h('span', { class: 'mono' }, row.peerNode ?? row.node)),
    ...fact('连接', STATUS_TEXT[row.status]));
  fill(detail.noteButtons,
    h('button', { class: 'btn small', type: 'button', disabled: busy, onclick: () => noteAction(r => saveNote(r, detail.note.value)) }, '保存'),
    row.note ? h('button', { class: 'btn quiet small', type: 'button', disabled: busy, onclick: () => noteAction(r => saveNote(r, '')) }, '清空') : null);
  detail.actions.replaceChildren(...(state.removing === row.node
    ? [h('span', { class: 'secondary' }, '移除后不再同步这位好友，确定吗？'), h('span', { class: 'spacer' }),
      h('button', { class: 'btn danger small', type: 'button', disabled: busy, onclick: () => remove(row) }, '确认移除'),
      h('button', { class: 'btn quiet small', type: 'button', onclick: () => { state.removing = null; draw(); } }, '再想想')]
    : [h('button', { class: 'btn quiet small', type: 'button', disabled: busy, onclick: () => handshake(row) }, '重新互认'), h('span', { class: 'spacer' }),
      h('button', { class: 'btn danger small', type: 'button', disabled: busy, onclick: () => { state.removing = row.node; draw(); } }, '移除好友…')]));
  fill(detail.notice,
    row.status === 'conflict' ? h('p', { class: 'warn-box' }, '对方的密钥与之前互认的不一致，可能换了设备或身份。确认是本人后可「重新互认」，否则建议移除。') : null,
    notice ? h('p', { class: notice.kind }, notice.text) : null);
}

function friendTile(row) {
  const secondary = [row.note && row.profileName ? row.profileName : null, row.short ? `@${row.short}` : '密钥未互认'].filter(Boolean).join(' · ');
  return h('li', {}, h('button', { class: `f-tile c-${row.color}`, type: 'button', 'aria-label': `${row.title}，${STATUS_TEXT[row.status]}`, onclick: () => openDetail(row) },
    avatar(rowAvatar(row), 'sm'),
    h('span', { class: 'f-info' }, h('span', { class: 'f-name truncate' }, row.title), h('span', { class: 'f-meta truncate' }, secondary)),
    h('span', { class: `badge ${row.status}` }, STATUS_TEXT[row.status])));
}

const problem = h('p', { class: 'error selectable' });
function draw() {
  const problems = [state.notesProblem, state.problem].filter(Boolean).join('；');
  problem.textContent = problems;
  problem.hidden = !problems;
  const shown = rows();
  drawHero(shown);
  countBadge.textContent = String(shown.length);
  countBadge.hidden = !shown.length;
  list.replaceChildren(shown.length ? h('ul', { class: 'friends' }, shown.map(friendTile))
    : h('p', { class: 'empty' }, state.loaded ? '还没有好友。点上方「添加好友」，粘贴对方发来的邀请即可。' : '正在读取…'));
  if (state.detail !== null) { if (detailRow()) drawDetail(); else closeDialog(); }
}

root.replaceChildren(h('div', { class: 'page' }, machineBar, problem, hero.card,
  h('section', {}, h('h2', { class: 'sec' }, '好友', countBadge), list)),
  editor.dialog.scrim, detail.dialog.scrim, invite.dialog.scrim);
drawMachines();
syncEditor();
draw();

coda.on('toolbar', ({ id } = {}) => { if (id === 'refresh') { state.failedPhotos.clear(); draw(); readProfiles(); } });
coda.toolbar([{ id: 'refresh', label: '刷新', icon: 'arrow.clockwise', kind: 'button' }]).catch(() => {});
coda.header({ text: '好友' }).catch(() => {});
start();
