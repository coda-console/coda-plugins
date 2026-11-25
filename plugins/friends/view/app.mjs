// 好友页：各台电脑的 Accord 身份（Hero）、按电脑分节的好友列表与详情、添加好友。
// 页面不自己选机器：视图里有几台就都读，身份按公钥归组、好友按电脑分节（lib/view-members.mjs）；写操作发往它所在的那一台。
// Accord 的读写（coda/accord@1）都在这里按交互发起。昵称、头像都由 Accord 公钥推出（nickname.mjs、avatar.mjs），没有可编辑的名片；
// 节点名等外来数据一律用 textContent / DOM API 渲染，从不拼 HTML 字符串。
import { accordStatusSummary, resolveAvatar } from '../lib/avatar.mjs';
import { checked, parseInvite } from '../lib/friends.mjs';
import { identityTitle } from '../lib/nickname.mjs';
import { friendSections, identities, listMembers } from '../lib/view-members.mjs';
import { fill, h, identiconSvg } from './dom.mjs';

const ACCORD = 'coda/accord@1', LOCAL = { kind: ACCORD, id: 'local' };
const coda = window.coda;
const root = document.getElementById('root');
const STATUS_TEXT = { bound: '已互认', pending: '待互认', conflict: '密钥冲突' };

// 视图里的每台电脑（成员在页面生命周期内不变）各存一份数据；读不到的（unreachable）也在，只是不发请求。
const members = listMembers(coda).map(m => ({ ...m, entry: null, author: null, friends: [], loaded: false, accordProblem: null }));
const live = members.filter(m => !m.unreachable);
const multi = members.length > 1;
const state = { busy: new Set(), notice: new Map(), heroNotice: new Map(), detail: null, removing: null };
const via = m => ({ machine: m.id });
const rowKey = (m, node) => `${m.id}\u0000${node}`;
function say(target, text, kind = 'hint') { target.className = kind; target.textContent = text; }

// ---- 读各台的 Accord ----
function onChange(m, { type, entry }) {
  if (type === 'DELETED' || !entry) return;
  m.entry = entry;
  m.author = entry.spec?.author ?? null;
  m.friends = entry.status?.friends ?? [];
  m.loaded = true;
  draw();
}
async function start(m) {
  try { await coda.watch(ACCORD, event => onChange(m, event), { id: 'local' }, via(m)); }
  catch (e) { m.accordProblem = `读不到本机的好友信息：${e.message}`; }
  draw();
}

// ---- 头像 ----
// 按 resolveAvatar 的描述画头像：公钥的几何纹，没有公钥时取首字。
function avatar(desc, size) {
  const node = h('span', { 'aria-hidden': 'true', class: `av ${size} k-${desc.kind}` });
  if (desc.kind === 'identicon') node.replaceChildren(identiconSvg(desc.grid)); else node.textContent = desc.text;
  return node;
}
const rowAvatar = row => resolveAvatar({ author: row.author, name: row.title });

// ---- 弹层：宽屏居中模态，窄屏底部抽屉；同一时间只开一个 ----
let openDialog = null;
function makeDialog({ title, close: closeLabel, onClose }) {
  const heading = h('h3', {}, title), body = h('div', { class: 'dlg-body' });
  const panel = h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true' }, h('div', { class: 'grabber', 'aria-hidden': 'true' }),
    h('div', { class: 'dlg-head' }, heading, h('button', { class: 'btn quiet small', type: 'button', onclick: () => closeDialog() }, closeLabel)),
    body);
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

// ---- 本机身份：每个身份一张 Hero ----
// 只有一台电脑时，Hero 上带这台的状态条和「添加好友」；几台时这两样都在各自的节里。
const CERT = {
  active: { dot: 'ok-dot', text: '可发布' },
  needs_cert: { dot: 'warn-dot', text: '需要证书', sub: '需绑定或续期代签证书：前往客户端「设置 › 身份」处理' },
  no_identity: { dot: 'off-dot', text: '未建身份', sub: '前往客户端「设置 › 身份」创建' },
};
const formatTime = ms => new Date(ms).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
function tile(label, value, sub, dot) {
  return h('div', { class: 'tile' }, h('span', { class: 'tile-k' }, label), h('span', { class: 'tile-v' }, dot ? h('span', { class: `dot ${dot}` }) : null, value), sub);
}
// 一台电脑的好友数与证书状态。
function statusTiles(m, rows) {
  if (!m.loaded) return h('div', { class: 'bento' }, tile('好友', '读取中…'), tile('身份', '读取中…'));
  const summary = accordStatusSummary(m.entry, rows), { bound, pending, conflict, total } = summary.friends, cert = CERT[summary.cert];
  const sub = summary.cert === 'active' ? (summary.certUntil ? `证书有效至 ${formatTime(summary.certUntil)}` : '可正常发布记录') : cert.sub;
  return h('div', { class: 'bento' },
    tile('好友', `${bound} 位已互认`, h('span', { class: 'tile-s' },
      conflict ? h('span', { class: 'badge conflict' }, `${conflict} 冲突`) : null,
      pending ? h('span', { class: 'badge pending' }, `${pending} 待互认`) : null,
      conflict || pending ? null : total ? '全部已互认' : '还没有好友')),
    tile('身份', cert.text, h('span', { class: 'tile-s' }, sub), cert.dot));
}
function drawHero(id, sections) {
  const { author, signer } = id, ready = Boolean(signer);
  const summary = accordStatusSummary(signer?.entry, []);
  const notice = state.heroNotice.get(author ?? '');
  const settled = members.every(m => m.loaded || m.unreachable || m.accordProblem);
  const name = author ? identityTitle(author) : !settled ? '读取中…' : ready ? '未建身份' : '读不到身份';
  const single = !multi && sections[0];
  return h('section', { class: 'hero' },
    h('div', { class: 'banner' }, h('div', { class: 'banner-acts' },
      single && !single.unreachable ? h('button', { class: 'pill strong', type: 'button', onclick: () => openInvite(single.member) }, '添加好友') : null)),
    h('div', { class: 'hero-body' },
      h('div', { class: 'hero-id' },
        h('span', { class: 'av-ring' }, avatar(resolveAvatar({ author, name }), 'lg')),
        h('div', { class: 'hero-names' }, h('div', { class: 'name-line' }, h('h2', { class: 'hero-name selectable' }, name), h('span', { class: 'tag' }, '我的身份')),
          h('button', { class: 'fp mono', type: 'button', disabled: !author, title: author ? '复制完整公钥' : '', onclick: () => copyKey(author),
          }, author ? `ed25519:${summary.short}… · 复制` : !ready ? (settled ? '读不到公钥' : '读取中…') : summary.cert === 'no_identity' ? '未建身份' : '未取得公钥'))),
      !author && ready && settled ? h('p', { class: 'hint' }, '这台电脑还没有 Accord 身份：前往客户端「设置 › 身份」创建后，好友才能认出你。') : null,
      notice ? h('p', { class: notice.kind }, notice.text) : null,
      single && !single.unreachable ? statusTiles(single.member, single.rows) : null));
}
async function copyKey(author) {
  try { await coda.copy(author); state.heroNotice.set(author, { kind: 'ok', text: '公钥已复制' }); } catch (e) { state.heroNotice.set(author, { kind: 'error', text: `复制失败：${e.message}` }); }
  draw();
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
// 接受邀请和随后的互认都发给打开它的那一节的电脑。
function openInvite(m) {
  if (invite.target !== m) say(invite.message, '');
  invite.target = m;
  invite.dialog.heading.textContent = multi ? `添加好友 · ${m.name}` : '添加好友';
  showDialog(invite.dialog);
}
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
  const target = invite.target, opts = via(target), show = (text, kind) => { if (invite.target === target) say(invite.message, text, kind); };
  invite.button.disabled = true;
  show('正在接受邀请，加入对方的通道…', 'progress');
  const peerNode = input.peerNode;
  let node;
  try {
    ({ node } = await coda.call(LOCAL, 'accept', input, opts));
  } catch (e) {
    input = null;
    invite.button.disabled = false;
    return show(`接受邀请失败：${e.message}。入网码已清空，请重新粘贴邀请再试`, 'error');
  }
  input = null;
  show('已加入通道，正在与对方互认…', 'progress');
  try {
    await coda.call(LOCAL, 'handshake', { node, ...(peerNode ? { peerNode } : {}) }, opts);
    show('好友已添加并完成互认', 'ok');
  } catch (e) { show(`已加入通道，但互认暂未完成（${e.message}）。可稍后在好友详情里点「重新互认」重试`, 'error'); }
  invite.button.disabled = false;
}

// ---- 好友详情：重新互认、移除都发给这一行所在的电脑 ----
// 不同电脑上的 node 可能相同，忙碌与提示按（电脑, node）记。
const sectionRows = m => friendSections([m])[0].rows;

async function handshake(m, row) {
  const key = rowKey(m, row.node);
  state.busy.add(key); state.notice.set(key, { kind: 'progress', text: '正在互认…' }); draw();
  let notice;
  try { await coda.call(LOCAL, 'handshake', { node: row.node, ...(row.peerNode ? { peerNode: row.peerNode } : {}) }, via(m)); notice = { kind: 'ok', text: '互认完成' }; }
  catch (e) { notice = { kind: 'error', text: `互认失败：${e.message}` }; }
  state.notice.set(key, notice); state.busy.delete(key); draw();
}
async function remove(m, row) {
  const key = rowKey(m, row.node);
  state.busy.add(key); state.notice.set(key, { kind: 'progress', text: '正在移除…' }); draw();
  let failure = null;
  try { await coda.call(LOCAL, 'remove', { node: row.node }, via(m)); }
  catch (e) { failure = { kind: 'error', text: `移除失败：${e.message}` }; }
  state.busy.delete(key);
  if (failure) state.notice.set(key, failure);
  else {
    state.notice.delete(key); state.removing = null;
    if (state.detail?.key === key) closeDialog();
  }
  draw();
}
const detail = {
  dialog: makeDialog({ title: '好友', close: '完成', onClose: () => { state.detail = null; state.removing = null; } }),
  card: h('div'),
  info: h('dl', { class: 'facts' }),
  actions: h('div', { class: 'actions split' }),
  notice: h('div'),
};
detail.dialog.body.append(h('div', { class: 'stack' }, detail.card, detail.info, detail.actions, detail.notice));
const detailRow = () => state.detail && sectionRows(state.detail.member).find(row => row.node === state.detail.node);
function openDetail(m, row) {
  state.detail = { member: m, node: row.node, key: rowKey(m, row.node) }; state.removing = null;
  drawDetail();
  showDialog(detail.dialog);
}
function fact(label, ...value) { return [h('dt', {}, label), h('dd', { class: 'selectable' }, ...value)]; }
async function copyFriendKey(m, row) {
  const key = rowKey(m, row.node);
  try { await coda.copy(row.author); state.notice.set(key, { kind: 'ok', text: '公钥已复制' }); }
  catch (e) { state.notice.set(key, { kind: 'error', text: `复制失败：${e.message}` }); }
  draw();
}
function drawDetail() {
  const row = detailRow(), { member: m, key } = state.detail;
  if (!row) return;
  const busy = state.busy.has(key), notice = state.notice.get(key);
  detail.dialog.heading.textContent = multi ? `${row.title} · ${m.name}` : row.title;
  detail.card.replaceChildren(h('div', { class: 'mini-card' }, h('div', { class: 'banner small' }),
    h('div', { class: 'mini-body row' }, h('span', { class: 'av-ring lg' }, avatar(rowAvatar(row), 'lg')),
      h('div', { class: 'mini-names' }, h('div', { class: 'mini-name truncate selectable' }, row.title)),
      h('span', { class: `badge ${row.status}` }, STATUS_TEXT[row.status]))));
  detail.info.replaceChildren(
    ...fact('公钥', row.author ? h('span', { class: 'mono key-full' }, row.author) : h('span', { class: 'secondary' }, '密钥未互认'),
      row.author ? h('button', { class: 'btn quiet small', type: 'button', onclick: () => copyFriendKey(m, row) }, '复制公钥') : null),
    ...fact('节点', h('span', { class: 'mono' }, row.peerNode ?? row.node)),
    ...fact('连接', STATUS_TEXT[row.status]));
  detail.actions.replaceChildren(...(state.removing === key
    ? [h('span', { class: 'secondary' }, '移除后不再同步这位好友，确定吗？'), h('span', { class: 'spacer' }),
      h('button', { class: 'btn danger small', type: 'button', disabled: busy, onclick: () => remove(m, row) }, '确认移除'),
      h('button', { class: 'btn quiet small', type: 'button', onclick: () => { state.removing = null; draw(); } }, '再想想')]
    : [h('button', { class: 'btn quiet small', type: 'button', disabled: busy, onclick: () => handshake(m, row) }, '重新互认'), h('span', { class: 'spacer' }),
      h('button', { class: 'btn danger small', type: 'button', disabled: busy, onclick: () => { state.removing = key; draw(); } }, '移除好友…')]));
  fill(detail.notice,
    row.status === 'conflict' ? h('p', { class: 'warn-box' }, '对方的密钥与之前互认的不一致，可能换了设备或身份。确认是本人后可「重新互认」，否则建议移除。') : null,
    notice ? h('p', { class: notice.kind }, notice.text) : null);
}

function friendTile(m, row) {
  return h('li', {}, h('button', { class: 'f-tile', type: 'button', 'aria-label': `${row.title}，${STATUS_TEXT[row.status]}`, onclick: () => openDetail(m, row) },
    avatar(rowAvatar(row), 'sm'),
    h('span', { class: 'f-info' }, h('span', { class: 'f-name truncate' }, row.title), h('span', { class: 'f-meta truncate' }, row.short ? `@${row.short}` : '密钥未互认')),
    h('span', { class: `badge ${row.status}` }, STATUS_TEXT[row.status])));
}

// 每台电脑一节；只有一台时没有节标题，也不重复画身份卡上已有的状态条和「添加好友」。
function drawSection({ member: m, title, unreachable, rows }) {
  const down = !unreachable ? null : m.unreachable ? `${m.name} 读不到：${unreachable}` : `${multi ? `${m.name}：` : ''}${unreachable}`;
  const summary = !unreachable && m.loaded ? accordStatusSummary(m.entry, rows) : null;
  // 几台时状态条只在有需要提示的状态（证书有问题、待互认、冲突）时出；只有一台时状态条在身份卡上。
  const attention = summary && (summary.cert !== 'active' || summary.friends.pending || summary.friends.conflict);
  const empty = !m.loaded ? '正在读取…' : '还没有好友。点上方「添加好友」，粘贴对方发来的邀请即可。';
  return h('section', {},
    h('h2', { class: 'sec' }, title ?? '好友', unreachable ? null : h('span', { class: 'count', hidden: !rows.length }, String(rows.length))),
    down ? h('p', { class: 'error selectable' }, down) : [
      multi && attention ? statusTiles(m, rows) : null,
      multi ? h('div', { class: 'line' }, h('button', { class: 'pill strong', type: 'button', onclick: () => openInvite(m) }, '添加好友')) : null,
      rows.length ? h('ul', { class: 'friends' }, rows.map(row => friendTile(m, row))) : multi && m.loaded ? null : h('p', { class: 'empty' }, empty)]);
}

const page = h('div', { class: 'page' });
function draw() {
  const sections = friendSections(members);
  const ids = identities(live);
  if (!ids.length) ids.push({ author: null, signer: null, members: [] });
  fill(page, ids.map(id => drawHero(id, sections)), sections.map(drawSection));
  if (state.detail) { if (detailRow()) drawDetail(); else closeDialog(); }
}

root.replaceChildren(page, detail.dialog.scrim, invite.dialog.scrim);
draw();

coda.header({ text: '好友' }).catch(() => {});
for (const m of live) start(m);
