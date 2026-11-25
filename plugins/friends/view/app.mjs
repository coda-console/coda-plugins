// 好友页：各台电脑的 Accord 身份（Hero）、按电脑分节的好友列表与详情、添加好友。
// 页面不自己选机器：视图里有几台就都读，身份按公钥归组、好友按电脑分节（lib/view-members.mjs）；写操作发往它所在的那一台。
// Accord 的读写（coda/accord@1）都在这里按交互发起；「共享」（授给好友的、好友授给本机的远程执行、最近的操作）只经模块读写各台本机。
// 昵称、头像都由 Accord 公钥推出（nickname.mjs、avatar.mjs），没有可编辑的名片；
// 节点名等外来数据一律用 textContent / DOM API 渲染，从不拼 HTML 字符串。
import { accordStatusSummary, resolveAvatar } from '../lib/avatar.mjs';
import { checked, parseInvite } from '../lib/friends.mjs';
import { identityTitle } from '../lib/nickname.mjs';
import { friendSections, identities, listMembers } from '../lib/view-members.mjs';
import { fill, h, identiconSvg, svg } from './dom.mjs';

const ACCORD = 'coda/accord@1', LOCAL = { kind: ACCORD, id: 'local' };
const coda = window.coda;
const root = document.getElementById('root');
const STATUS_TEXT = { bound: '已互认', pending: '待互认', conflict: '密钥冲突' };
const MACHINE_KIND = 'remote-exec/machine@1';
const RECOVER_MS = 3000;
// 结果不明的撤销：连续读到这么多遍有效列表、授权仍可用，就不再自动重发。
const REVOKE_RETRIES = 3;
// 结果不明的授予：连续读到这么多遍有效列表、里面都没有这条授权，就回滚这一行，允许重试（持有方对同一目标的授予幂等）。
const GRANT_CONFIRMS = 3;

// 视图里的每台电脑（成员在页面生命周期内不变）各存一份数据；读不到的（unreachable）也在，只是不发请求。
const members = listMembers(coda).map(m => ({ ...m, entry: null, author: null, friends: [], loaded: false, accordProblem: null }));
const live = members.filter(m => !m.unreachable);
const multi = members.length > 1;
const state = { busy: new Set(), notice: new Map(), heroNotice: new Map(), detail: null, removing: null, menu: null };
const via = m => ({ machine: m.id });
const rowKey = (m, node) => `${m.id}\u0000${node}`;
function say(target, text, kind = 'hint') { target.className = kind; target.textContent = text; }

// ---- 共享：经各台的模块读写那台本机的持有方、调用方 ----
const pendingReplies = new Map();
let counter = 0;
// `late`：等不到回应时也不丢这条回复，晚到了就交给它（授予这类不能重发的写操作用）。
function ask(m, type, input = {}, late) {
  const rid = `n${++counter}`;
  return new Promise((resolve, reject) => {
    const settle = fn => v => { clearTimeout(timer); pendingReplies.delete(rid); fn(v); };
    const timer = setTimeout(() => {
      if (late) pendingReplies.get(rid).late = late; else pendingReplies.delete(rid);
      reject(new Error('模块没有回应'));
    }, 10_000);
    pendingReplies.set(rid, { machine: m.id, resolve: settle(resolve), reject: settle(reject) });
    Promise.resolve().then(() => coda.postMessage({ type, rid, ...input }, via(m))).catch(error => pendingReplies.get(rid)?.reject(Object.assign(new Error(`发送失败：${error?.message ?? error}`), { refused: true })));
  });
}
addEventListener('message', event => {
  const { type, rid, ok, value, error, effects } = event.data ?? {};
  const wait = type === 'reply' ? pendingReplies.get(rid) : null;
  if (!wait || (event.machine?.id && event.machine.id !== wait.machine)) return;
  // refused：确认什么也没写——模块明确回了错误且 effects 为 none，或消息根本没发出去（postMessage 抛错）；别的错误、超时都是结果不明。
  const failure = Object.assign(new Error(error), { refused: effects === 'none' });
  if (wait.late) { pendingReplies.delete(rid); wait.late(ok ? { value } : { failure }); } else if (ok) wait.resolve(value); else wait.reject(failure);
});

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
function makeDialog({ title, close: closeLabel, onClose, cancel = () => closeDialog() }) {
  const heading = h('h3', {}, title), body = h('div', { class: 'dlg-body' });
  const panel = h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true' }, h('div', { class: 'grabber', 'aria-hidden': 'true' }),
    h('div', { class: 'dlg-head' }, heading, h('button', { class: 'btn quiet small', type: 'button', onclick: () => cancel() }, closeLabel)),
    body);
  const scrim = h('div', { class: 'scrim', onclick: e => { if (e.target === scrim) cancel(); } }, panel);
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
// Escape 一次收一层：授予选择框，再是行尾菜单，再是弹层。
addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (picker.ctx) closePicker();
  else if (state.menu) { state.menu = null; draw(); }
  else if (openDialog) closeDialog();
});
addEventListener('click', () => { if (state.menu) { state.menu = null; draw(); } });

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
  peerNode: h('input', { type: 'text', autocomplete: 'off', placeholder: '可选', oninput: dropHidden }),
  message: h('p', { class: 'hint' }),
  button: h('button', { class: 'btn', type: 'button', onclick: submitInvite }, '接受邀请'),
  hidden: {},
};
// 各字段只在识别出一份邀请之后展开给用户核对：口令只随粘贴的邀请来，空表单手填交不出去。
const ASK_PASTE = '请粘贴对方给你的完整邀请';
invite.fields = h('div', { class: 'fields' },
  h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'control（入网地址）'), invite.control),
  h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'authKey（入网码）'), invite.authKey),
  h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'linkId'), invite.linkId),
  h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'scope'), invite.scope),
  h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'peerNode'), invite.peerNode));
invite.fields.hidden = true;
invite.dialog = makeDialog({ title: '添加好友', close: '关闭', onClose: resetGenerated });
// 接受邀请和随后的互认都发给打开它的那一节的电脑。
function openInvite(m) {
  if (invite.target !== m) say(invite.message, '');
  invite.target = m;
  invite.dialog.heading.textContent = multi ? `添加好友 · ${m.name}` : '添加好友';
  showDialog(invite.dialog);
}
// 上半「邀请对方」：说明、主按钮、结果区各有固定的位置，状态变化只换内容；下半「接受对方的邀请」不受它影响。
// 生成的邀请是凭据：只放在 generated.text 里显示这一次，不进 setState、存储或日志，关掉弹层就清掉。
const generated = { state: 'idle', text: '', error: '', copied: false, copyError: '', token: 0, timer: 0 };
const generate = {
  button: h('button', { class: 'btn', type: 'button', onclick: generateInvite }, '生成邀请'),
  result: h('div', { class: 'result', role: 'status', 'aria-live': 'polite' }),
};
const canInvite = () => typeof coda.inviteFriend === 'function';
function drawGenerated() {
  const s = canInvite() ? generated.state : 'na';
  generate.button.disabled = s === 'busy' || s === 'na';
  generate.button.textContent = s === 'done' ? '再生成一个' : s === 'fail' ? '重试' : '生成邀请';
  if (s === 'done') {
    const copy = h('button', { class: 'btn quiet small', type: 'button', onclick: copyInvite }, generated.copied ? '已复制' : '复制');
    return fill(generate.result, h('pre', { class: 'res-box code', 'aria-label': '好友邀请' }, generated.text),
      h('div', { class: 'copyrow' }, copy, generated.copyError ? h('span', { class: 'error' }, generated.copyError) : h('span', { class: 'secondary' }, '24 小时内有效，只能用一次')));
  }
  const text = { busy: '正在生成…', fail: generated.error, na: '请在 Coda 客户端里打开好友页来生成邀请' }[s];
  fill(generate.result, h('div', { class: s === 'fail' ? 'res-box err' : 'res-box' }, text));
}
async function generateInvite() {
  if (generated.state === 'busy' || !canInvite()) return;
  const mine = ++generated.token, target = invite.target;
  Object.assign(generated, { state: 'busy', text: '', error: '', copied: false, copyError: '' });
  drawGenerated();
  let outcome;
  try { outcome = { state: 'done', text: (await coda.inviteFriend({ machine: target.id })).text }; }
  // 在确认框里取消：回到空闲，不显示错误。
  catch (e) { outcome = e?.code === 'canceled' ? { state: 'idle' } : { state: 'fail', error: e?.message ?? String(e) }; }
  if (mine !== generated.token) return;
  Object.assign(generated, outcome);
  drawGenerated();
}
async function copyInvite() {
  clearTimeout(generated.timer);
  try { await coda.copy(generated.text); Object.assign(generated, { copied: true, copyError: '' }); }
  catch (e) { Object.assign(generated, { copied: false, copyError: `复制失败：${e.message}` }); }
  drawGenerated();
  generated.timer = setTimeout(() => { generated.copied = false; drawGenerated(); }, 1500);
}
function resetGenerated() {
  clearTimeout(generated.timer);
  Object.assign(generated, { state: 'idle', text: '', error: '', copied: false, copyError: '', token: generated.token + 1 });
  drawGenerated();
}
drawGenerated();
invite.dialog.body.append(
  h('section', { class: 'blk' }, h('h4', { class: 'sec' }, '邀请对方'),
    h('p', { class: 'hint' }, '生成一段邀请发给对方，对方在他的好友页粘贴'),
    h('div', { class: 'line' }, generate.button), generate.result),
  h('section', { class: 'blk' }, h('h4', { class: 'sec' }, '接受对方的邀请'), h('div', { class: 'stack' },
    h('p', { class: 'hint' }, ASK_PASTE), invite.paste, invite.fields,
    h('div', { class: 'line' }, invite.button), invite.message)));
// hostname、peerPort、bindingToken（一次性口令）只随识别出的那份邀请，不进输入框：手改入网地址或入网码就是另一份邀请了，
// 连粘贴区的原文一起丢掉，免得再从原文里解析出旧邀请；口令只交给邀请指定的那台，改 peerNode 同理；改 linkId、scope 不算。
function dropHidden() { invite.hidden = {}; invite.paste.value = ''; }
// 粘贴区没有识别出邀请（清空了或识别不了）：上次识别出的字段不再属于它，清掉并收起。
function closeFields() {
  for (const name of ['control', 'authKey', 'linkId', 'scope', 'peerNode']) invite[name].value = '';
  invite.fields.hidden = true;
}
function parsePaste() {
  invite.hidden = {};
  const text = invite.paste.value;
  if (!text.trim()) { closeFields(); return say(invite.message, '', 'hint'); }
  try {
    const found = parseInvite(text);
    for (const name of ['control', 'authKey', 'scope', 'peerNode']) if (found[name]) invite[name].value = found[name];
    if (found.linkId && !/^f-[0-9a-f]{8}$/.test(found.linkId)) invite.linkId.value = found.linkId;
    invite.hidden = { hostname: found.hostname ?? '', peerPort: found.peerPort, bindingToken: found.bindingToken };
    invite.fields.hidden = false;
    say(invite.message, '已识别邀请，核对后点「接受邀请」', 'ok');
  } catch (e) {
    // 提交时报的是这份的解析错误。
    closeFields();
    say(invite.message, e.message, 'error');
  }
}
function clearInvite() {
  invite.paste.value = '';
  closeFields();
  invite.hidden = {};
}
async function submitInvite() {
  let input;
  try {
    input = checked({ control: invite.control.value, authKey: invite.authKey.value, linkId: invite.linkId.value, scope: invite.scope.value,
      peerNode: invite.peerNode.value, hostname: invite.hidden.hostname, peerPort: invite.hidden.peerPort, bindingToken: invite.hidden.bindingToken });
  } catch (e) {
    // 什么也没粘贴、字段也没展开：请对方的完整邀请。当前粘贴识别成功了（口令只在这时记着）、或没有粘贴，就以字段为准，校验不过只报错；
    // 粘贴了却还没识别成功，才按粘贴原文再解析一次，成不了就报它的错。
    if (invite.fields.hidden && !invite.paste.value.trim()) return say(invite.message, ASK_PASTE, 'error');
    if (invite.hidden.bindingToken || !invite.paste.value.trim()) return say(invite.message, e.message, 'error');
    try { input = parseInvite(invite.paste.value); } catch (pasted) { return say(invite.message, pasted.message, 'error'); }
  }
  // 入网码和一次性口令是凭据：取出后立刻清空所有输入框和记着的口令，不写进任何存储或日志。
  clearInvite();
  const target = invite.target, opts = via(target), show = (text, kind) => { if (invite.target === target) say(invite.message, text, kind); };
  invite.button.disabled = true;
  show('正在接受邀请，加入对方的通道…', 'progress');
  const peerNode = input.peerNode;
  let node;
  try {
    // 先发出调用，立刻放掉页面手里的入参（含口令），再等结果。
    const pending = coda.call(LOCAL, 'accept', input, opts);
    input = null;
    ({ node } = await pending);
  } catch (e) {
    input = null;
    invite.button.disabled = false;
    return show(`接受邀请失败：${e.message}。入网码和口令已清空，请重新粘贴邀请再试`, 'error');
  }
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
  dialog: makeDialog({ title: '好友', close: '完成', onClose: () => { state.detail = null; state.removing = null; state.menu = null; closePicker(); } }),
  card: h('div'),
  info: h('dl', { class: 'facts' }),
  share: h('section', { class: 'share' }),
  actions: h('div', { class: 'actions split' }),
  notice: h('div'),
};
detail.dialog.body.append(h('div', { class: 'stack' }, detail.card, detail.info, detail.share, detail.actions, detail.notice));
const detailRow = () => state.detail && sectionRows(state.detail.member).find(row => row.node === state.detail.node);
function openDetail(m, row) {
  state.detail = { member: m, node: row.node, key: rowKey(m, row.node) }; state.removing = null; state.menu = null;
  shareOf(m).opsOpen = false;
  drawDetail();
  showDialog(detail.dialog);
  loadShare(m, row);
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
  drawShare(m, row);
  fill(detail.notice,
    row.status === 'conflict' ? h('p', { class: 'warn-box' }, '对方的密钥与之前互认的不一致，可能换了设备或身份。确认是本人后可「重新互认」，否则建议移除。') : null,
    notice ? h('p', { class: notice.kind }, notice.text) : null);
}

// ---- 共享：授给这位好友的远程执行、好友授给本机的、最近的操作 ----
// 授权按机器存在各台本机的持有方里，所以这一节读的、写的都是详情所在的那一台（节标题写明是哪台）。
// 本地先行：授予、撤销先改界面，进行中只显示在那一行的状态位置；模块明确拒绝（refused）就回滚、原因写在那一行；
// 超时、发不出去这类结果不明的，保持本机的选择，后台每隔几秒重读授权恢复。
const SHARE_STATUS = {
  available: ['可用', 'bound'], target_off: ['目标已关闭', 'pending'], target_missing: ['目标不在了', 'pending'], no_identity: ['读不出本机身份', 'pending'],
  granting: ['授予中', 'busy'], revoking: ['撤销中', 'busy'], machine_changed: ['已停用', 'pending'], grantee_changed: ['已停用', 'pending'],
};
const PROXY_STATUS = {
  available: ['可用', 'bound'], off: ['TA 那边没开远程执行', 'pending'], channel: ['和 TA 的通道断了', 'pending'],
  author: ['本机身份变了，请 TA 重新授予', 'pending'], sign: ['本机没有可用的签名证书', 'pending'],
};
// 授出的范围不让选，由对方的身份决定：个人身份授给他名下的机器，机器身份只授给那一台；基座还没给 certified 时不写。
const scopeNote = certified => (certified === true ? '授给这个人名下的机器' : certified === false ? '只授给对方那一台机器' : null);
const shareOf = m => (m.share ??= { grants: null, problem: null, corrupt: null, clock: 0, writes: 0, touched: 0, reread: false, pending: [], revoking: new Map(), theirs: new Map(), ops: new Map(), targets: null, targetsProblem: null, opsOpen: false, timer: null });
const certifiedOf = (m, row) => m.friends.find(friend => friend.node === row.node)?.certified;
const mergeGrant = (sh, made) => { const all = sh.grants ?? []; sh.grants = all.some(g => g.grant === made.grant) ? all.map(g => (g.grant === made.grant ? made : g)) : [...all, made]; };
// 已撤的不显示；撤销中的（名下的调用还在取消）显示。
const visibleGrant = g => g.status === 'revoking' || (g.status !== 'revoked' && g.revokedAt === undefined);

function loadShare(m, row) {
  readGrants(m);
  if (!row.author) return;
  readTheirs(m, row);
  if (shareOf(m).opsOpen) readOps(m, row);
}
// 授权的读与写在同一台机器上按顺序记版本：写开始、结束都记一笔；写之前（或写还没结束时）发出的列表，晚到就丢掉，没有写在途时再读一次，
// 免得迟到的旧列表盖掉已确认的授予或撤销。
const beginWrite = sh => { sh.writes++; sh.touched = ++sh.clock; };
function endWrite(m) {
  const sh = shareOf(m);
  sh.writes--; sh.touched = ++sh.clock;
  if (!sh.writes && sh.reread) readGrants(m);
}
// 给回这一遍读到的有效列表；没读到（失败、晚到的旧结果、持有方故障）给回 null。`round`：恢复循环里的这一遍，读完不另排下一轮。
async function readGrants(m, round = false) {
  const sh = shareOf(m), issued = ++sh.clock, clean = sh.writes === 0;
  sh.reread = false;
  let read, failure;
  try { read = await ask(m, 'grants.list'); } catch (e) { failure = e; }
  // 先看版本，再看成败：写之前发出的列表，晚到的结果与晚到的错误都不算数。
  if (!clean || sh.touched > issued) { sh.reread = true; if (!sh.writes) readGrants(m); return null; }
  if (failure) { sh.problem = `读不到授权：${failure.message}`; draw(); return null; }
  sh.problem = null; sh.corrupt = read.corrupt || null;
  // 持有方的授权数据读不出来时，列表是空的但不是真的空：不拿它改显示，也不用它判断待确认的操作；已打开的授予选择框关掉。
  if (sh.corrupt) {
    if (picker.ctx?.m === m) closePicker();
  } else {
    sh.grants = read.grants;
    // 授予：读到了就是授出了；读不到不算被拒，等这笔操作有确定的结果（回应晚到、或读到）。
    sh.pending = sh.pending.filter(p => (p.state !== 'granting' && !p.expired) || !read.grants.some(g => g.friend === p.friend && g.target.id === p.target.id && g.revokedAt === undefined));
    // 结果不明的授予：列表连续读到上限遍都没有它，就当没授出，这一行回滚、目标重新可选。
    for (const p of sh.pending) {
      if (p.state !== 'granting' || !p.unknown || (p.misses = (p.misses ?? 0) + 1) < GRANT_CONFIRMS) continue;
      Object.assign(p, { state: 'denied', reason: '没有确认授予成功，请重试', unknown: false, expired: true });
    }
    // 结果不明的撤销：读到已撤或在撤销中就是核对完了，留下的是仍可用的，由恢复循环再发一次。
    for (const [grant, one] of sh.revoking) if (one.unknown && !read.grants.some(g => g.grant === grant && visibleGrant(g) && g.status !== 'revoking')) sh.revoking.delete(grant);
  }
  draw();
  if (!round) recover(m);
  return sh.corrupt ? null : read.grants;
}
async function readTheirs(m, row) {
  const sh = shareOf(m);
  try { sh.theirs.set(row.author, { rows: await ask(m, 'proxies.list', { friend: row.author }) }); }
  catch (e) { sh.theirs.set(row.author, { problem: `读不到 TA 授给你的：${e.message}` }); }
  draw();
}
async function readOps(m, row) {
  const sh = shareOf(m);
  try { sh.ops.set(row.author, { rows: await ask(m, 'ledger.list', { friend: row.author, limit: 20 }) }); }
  catch (e) { sh.ops.set(row.author, { problem: `读不到操作记录：${e.message}` }); }
  draw();
}
// 还有要恢复的（结果不明的授予与撤销、读到的撤销中）就隔几秒来一轮，直到状态变化。一轮 = 读一遍列表，读到有效列表、且结果不明的撤销
// 对应的授权仍可用，才重发；读和重发都结束了才排下一轮（所以同一授权的撤销不会有两个在途重试）。
function recover(m) {
  const sh = shareOf(m);
  const need = sh.pending.some(p => p.unknown) || [...sh.revoking.values()].some(r => r.unknown) || (sh.grants ?? []).some(g => g.status === 'revoking');
  if (!need || sh.timer) return;
  sh.timer = setTimeout(async () => {
    if (await readGrants(m, true)) {
      for (const [grant, one] of sh.revoking) {
        if (!one.unknown) continue;
        // 授权仍可用的有效列表已连续读到上限遍：不再自动重发，写明没确认，这一行回到可手动再撤。
        if ((one.reads = (one.reads ?? 0) + 1) >= REVOKE_RETRIES) sh.revoking.set(grant, { error: '撤销没有确认，可再撤一次' });
        else await sendRevoke(m, grant);
      }
    }
    sh.timer = null;
    draw();
    recover(m);
  }, RECOVER_MS);
  sh.timer?.unref?.();
}
async function sendRevoke(m, grant) {
  const sh = shareOf(m), reads = sh.revoking.get(grant)?.reads;
  beginWrite(sh);
  try { mergeGrant(sh, await ask(m, 'grants.revoke', { grant })); sh.revoking.delete(grant); }
  catch (e) { sh.revoking.set(grant, e.refused ? { error: e.message } : { unknown: true, reads }); }
  endWrite(m);
}
async function revokeGrant(m, g) {
  const sh = shareOf(m);
  state.menu = null;
  sh.revoking.set(g.grant, {});
  draw();
  await sendRevoke(m, g.grant);
  recover(m);
  draw();
}
// 同一好友、同一目标的本地操作只留一条：重试替掉原来的失败，确认成功就清掉。结果不明的（回应超时）不重发，
// 它的回应晚到了照样接住；读到了、或回应晚到之前这一行一直是「授予中」，目标一直占着。
async function grantTo(m, row, target) {
  const sh = shareOf(m);
  if (sh.corrupt) return;
  const one = { friend: row.author, target: { id: target.id, name: target.name }, state: 'granting' };
  sh.pending = [...sh.pending.filter(p => !(p.friend === one.friend && p.target.id === target.id)), one];
  closePicker();
  draw();
  const settle = (outcome, failure) => {
    if (!sh.pending.includes(one)) return;
    if (outcome) { mergeGrant(sh, outcome); sh.pending = sh.pending.filter(p => p !== one); } else if (failure.refused) Object.assign(one, { state: 'denied', reason: failure.message, unknown: false });
    else one.unknown = true;
  };
  beginWrite(sh);
  try { settle(await ask(m, 'grants.grant', { friend: row.author, target: { kind: MACHINE_KIND, id: target.id } }, late => {
    beginWrite(sh); settle(late.value, late.failure); endWrite(m); draw();
  })); } catch (e) { settle(null, e); recover(m); }
  endWrite(m);
  draw();
}

const dots = () => svg('svg', { viewBox: '0 0 24 24', width: 18, height: 18, fill: 'currentColor', 'aria-hidden': 'true' },
  svg('circle', { cx: 5, cy: 12, r: 2 }), svg('circle', { cx: 12, cy: 12, r: 2 }), svg('circle', { cx: 19, cy: 12, r: 2 }));
const emptyRow = text => h('li', { class: 'empty g-empty' }, text);
// 一行：名称与说明、状态、行尾只有一个菜单按钮（没有菜单的行也留着这个槽，列对得齐）。
function shareRow({ key, name, sub, subKind, badge, busy, menu }) {
  const open = state.menu === key;
  return h('li', { class: 'g-row', 'aria-busy': busy ? 'true' : null },
    h('div', { class: 'g-info' }, h('span', { class: 'g-name truncate' }, name), sub ? h('span', { class: `g-sub truncate${subKind === 'error' ? ' error' : ''}` }, sub) : null),
    h('span', { class: `badge ${badge[1]}` }, badge[0]),
    menu ? h('button', { class: 'kebab', type: 'button', 'aria-label': `更多操作：${name}`, 'aria-haspopup': 'menu', 'aria-expanded': String(open), disabled: busy,
      onclick: e => { e.stopPropagation?.(); state.menu = open ? null : key; draw(); } }, dots()) : h('span', { class: 'kebab-slot', 'aria-hidden': 'true' }),
    open && menu ? h('div', { class: 'menu', role: 'menu' }, h('button', { type: 'button', role: 'menuitem', class: menu.danger ? 'danger' : '',
      onclick: e => { e.stopPropagation?.(); menu.run(); } }, menu.label, menu.note ? h('span', { class: 'menu-note' }, menu.note) : null)) : null);
}
function drawShare(m, row) {
  const sh = shareOf(m), scope = scopeNote(certifiedOf(m, row));
  const mine = [
    ...(sh.grants ?? []).filter(g => g.friend === row.author && visibleGrant(g)).map(g => {
      const local = sh.revoking.get(g.grant), busy = g.status === 'revoking' || (local && !local.error);
      return shareRow({ key: `g:${g.grant}`, name: g.target.name ?? g.target.id, sub: local?.error ?? scope, subKind: local?.error ? 'error' : null,
        badge: busy ? SHARE_STATUS.revoking : SHARE_STATUS[g.status] ?? ['已失效', 'pending'], busy,
        menu: { label: '撤销', note: '同时取消对方正在跑的调用', danger: true, run: () => revokeGrant(m, g) } });
    }),
    ...sh.pending.filter(p => p.friend === row.author).map(p => shareRow({ key: `p:${p.target.id}`, name: p.target.name, sub: p.state === 'denied' ? p.reason : scope, subKind: p.state === 'denied' ? 'error' : null,
      badge: p.state === 'denied' ? ['未授予', 'conflict'] : SHARE_STATUS.granting, busy: p.state === 'granting',
      menu: { label: '移除', run: () => { sh.pending = sh.pending.filter(one => one !== p); state.menu = null; draw(); } } })),
  ];
  const their = sh.theirs.get(row.author);
  const theirRows = (their?.rows ?? []).map(proxy => shareRow({ key: `t:${proxy.key}`, name: proxy.name, badge: PROXY_STATUS[proxy.status] ?? ['不可用', 'pending'] }));
  const ops = sh.ops.get(row.author);
  const canGrant = row.status === 'bound' && Boolean(row.author) && sh.grants !== null && !sh.corrupt;
  fill(detail.share,
    h('h4', {}, `共享 · ${m.name}`),
    h('div', {}, h('div', { class: 'sub-head' }, '我授给 TA', h('span', { class: 'spacer' }),
      h('button', { class: 'btn quiet small', type: 'button', disabled: !canGrant, 'aria-label': '授予远程执行', onclick: () => openPicker(m, row) }, '授予…')),
    h('ul', { class: 'glist' }, sh.problem ? h('li', { class: 'error g-empty' }, sh.problem) : sh.corrupt ? h('li', { class: 'error g-empty' }, `持有方出了故障：授权数据读不出来${typeof sh.corrupt === 'string' ? `（${sh.corrupt}）` : ''}，暂时不能授予和撤销`) : sh.grants === null ? emptyRow('正在读取…') : mine.length ? mine : emptyRow('还没有授给 TA 的东西'))),
    h('div', {}, h('div', { class: 'sub-head' }, 'TA 授给我'),
      h('ul', { class: 'glist' }, their?.problem ? h('li', { class: 'error g-empty' }, their.problem) : !their ? emptyRow(row.author ? '正在读取…' : 'TA 还没有授给你东西')
        : theirRows.length ? theirRows : emptyRow('TA 还没有授给你东西'))),
    h('details', { class: 'ops', open: sh.opsOpen, ontoggle: e => {
      if (e.target.open === sh.opsOpen) return;
      sh.opsOpen = e.target.open;
      if (sh.opsOpen && row.author) readOps(m, row);
    } }, h('summary', {}, '最近的操作'),
    h('div', { class: 'ops-list' }, ops?.problem ? h('p', { class: 'error' }, ops.problem) : !ops ? h('p', { class: 'empty' }, row.author ? '正在读取…' : '还没有操作记录')
      : ops.rows.length ? [...ops.rows.map(opRow), h('p', { class: 'hint' }, '完整记录：coda self ledger.list')] : h('p', { class: 'empty' }, '还没有操作记录'))));
}
// 操作记录的摘要：时间、操作、命令摘要、结局、耗时。
const duration = ms => (ms < 10_000 ? `${(ms / 1000).toFixed(1)} 秒` : ms < 60_000 ? `${Math.round(ms / 1000)} 秒` : `${Math.round(ms / 60_000)} 分钟`);
function outcomeOf(row) {
  if (row.outcome === 'rejected') return ['被拒绝', 'conflict'];
  if (row.outcome === 'canceled') return ['已取消', 'pending'];
  if (row.outcome === 'failed') return [`失败（${row.code ?? '未知'}）`, 'conflict'];
  if (row.exitCode === undefined || row.exitCode === 0) return ['成功', 'bound'];
  return [row.exitCode === null ? '失败' : `失败（退出码 ${row.exitCode}）`, 'conflict'];
}
function opRow(row) {
  const [label, kind] = outcomeOf(row), rejected = row.outcome === 'rejected';
  return h('div', { class: 'op' },
    h('div', { class: 'op-top' }, h('span', { class: 'op-time' }, formatTime(row.at)), h('span', { class: 'tag' }, rejected ? '请求' : '执行'), h('span', { class: 'spacer' }),
      h('span', { class: `badge ${kind}` }, label), h('span', { class: 'dur' }, rejected ? '—' : duration(row.ms))),
    h('div', { class: 'op-cmd truncate selectable' }, rejected ? `${row.code}${row.count > 1 ? ` × ${row.count}` : ''}` : row.command.summary));
}

// 授予选择框：叠在好友详情上，只选要授出的记录，不选范围；每行下面的小字是对方身份决定的范围。
const picker = { dialog: makeDialog({ title: '授予远程执行', close: '取消', cancel: () => closePicker() }), ctx: null, list: h('ul', { class: 'glist' }) };
picker.dialog.body.append(picker.list);
function openPicker(m, row) {
  picker.ctx = { m, row };
  picker.dialog.scrim.hidden = false;
  drawPicker();
  const sh = shareOf(m);
  ask(m, 'grants.targets').then(targets => { sh.targets = targets; sh.targetsProblem = null; }, e => { sh.targetsProblem = `读不到本机的远程执行记录：${e.message}`; }).then(drawPicker);
}
function closePicker() {
  picker.ctx = null;
  picker.dialog.scrim.hidden = true;
}
function drawPicker() {
  if (!picker.ctx) return;
  const { m, row } = picker.ctx, sh = shareOf(m), scope = scopeNote(certifiedOf(m, row));
  const taken = new Set([...(sh.grants ?? []).filter(g => g.friend === row.author && visibleGrant(g)).map(g => g.target.id), ...sh.pending.filter(p => p.friend === row.author && p.state !== 'denied').map(p => p.target.id)]);
  fill(picker.list, sh.targetsProblem ? h('li', { class: 'error g-empty' }, sh.targetsProblem) : sh.targets === null ? emptyRow('正在读取…')
    : sh.targets.length ? sh.targets.map(target => {
      const why = sh.corrupt ? '持有方出了故障' : !target.available ? '远程执行没打开' : taken.has(target.id) ? '已授给 TA' : '';
      return h('li', {}, h('button', { class: 'pick', type: 'button', disabled: Boolean(why), onclick: () => { if (!why) grantTo(m, row, target); } },
        h('span', { class: 'g-info' }, h('span', { class: 'g-name truncate' }, target.name), h('span', { class: 'g-sub truncate' }, `${target.os} · ${target.user}`), scope ? h('span', { class: 'g-sub truncate' }, scope) : null),
        why ? h('span', { class: 'why' }, why) : null));
    }) : emptyRow('本机没有可授出的远程执行记录'));
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
  drawPicker();
}

picker.dialog.scrim.hidden = true;
root.replaceChildren(page, detail.dialog.scrim, invite.dialog.scrim, picker.dialog.scrim);
draw();

coda.header({ text: '好友' }).catch(() => {});
for (const m of live) start(m);
