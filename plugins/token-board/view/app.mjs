// Token 消耗榜页面：本机的用量概览，和好友的消耗榜。数据都由模块（main.mjs）读好、算好，经页面消息送来；页面不直接读记录。
// 好友的昵称、模型名等外来文字只经 textContent / 文本节点渲染，从不拼进 innerHTML。
import { Bridge } from 'coda-view://lib/v1/bridge.js';

const coda = window.coda, bridge = new Bridge();
const root = document.getElementById('root');
const RANGES = [{ id: 'today', label: '今天' }, { id: '7d', label: '近 7 天' }, { id: '30d', label: '近 30 天' }];
const PARTS = [['input', '输入'], ['output', '输出'], ['cacheRead', '缓存读'], ['cacheWrite', '缓存写']];
const SAFE_COLOR = /^#[0-9a-fA-F]{6}$/;
// 好友插件的命名主题色，换成固定色值再用；#RRGGBB 原样用，其他一律不用。
const NAMED_COLORS = { blue: '#3b82f6', orange: '#f97316', green: '#22c55e', purple: '#a855f7', pink: '#ec4899', teal: '#14b8a6', gray: '#6b7280' };
const colorOf = value => (Object.hasOwn(NAMED_COLORS, value) ? NAMED_COLORS[value] : SAFE_COLOR.test(value ?? '') ? value : null);

const saved = coda.getState?.() ?? {};
let range = RANGES.find(r => r.id === saved?.range)?.id ?? null;
let status = null, board = null, loading = false, seq = 0, acting = false;
const expanded = new Set();

const h = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value); else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.flat().filter(c => c !== null && c !== undefined && c !== false));
  return node;
};

// ——— 数字 ———
function tokens(n) {
  if (!Number.isFinite(n)) return '0';
  if (n < 1000) return String(n);
  for (const [size, unit] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) if (n >= size) { const v = n / size; return `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)}${unit}`; }
  return String(n);
}
const count = n => Number(n).toLocaleString('zh-CN');
const rangeLabel = () => RANGES.find(r => r.id === range)?.label ?? '';
const pad = n => String(n).padStart(2, '0');
const clock = at => { const d = new Date(at); return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };

// ——— 与模块通信 ———
function requestBoard() {
  if (!range) return;
  loading = true;
  bridge.send({ type: 'board', range, id: ++seq });
  render();
}
bridge.on('status', d => {
  status = d;
  if (!range) { range = RANGES.find(r => r.id === d.range)?.id ?? '7d'; declareHeader(); requestBoard(); }
  acting = false;
  render();
});
bridge.on('board', d => {
  if (d.id !== seq) return;
  board = d; loading = false; render();
});
bridge.on('error', d => { loading = false; acting = false; status = { ...(status ?? {}), notice: d.message }; render(); });

function act(message) { acting = true; render(); bridge.send(message); }
const setShare = on => act({ type: 'set-share', on });

// ——— 顶栏 ———
let headerKey = '';
function declareHeader() {
  if (!range || headerKey === range) return;
  headerKey = range;
  try { coda.header({ text: null, segments: { items: RANGES, selected: range } })?.catch?.(() => {}); } catch {}
}
coda.on?.('header', ({ id }) => {
  if (!RANGES.some(r => r.id === id)) return;
  range = id; coda.setState?.({ range: id }); board = null; requestBoard();
});
let toolbarKey = '';
function declareToolbar() {
  const key = String(status?.share);
  if (toolbarKey === key) return;
  toolbarKey = key;
  try {
    coda.toolbar?.([{ id: 'refresh', kind: 'button', label: '刷新', icon: 'arrow.clockwise' },
      { id: 'share', kind: 'toggle', label: '分享', icon: 'person.2.fill', on: status?.share === true }])?.catch?.(() => {});
  } catch {}
}
coda.on?.('toolbar', ({ id, on } = {}) => {
  if (id === 'refresh') { bridge.send({ type: 'hello' }); requestBoard(); }
  else if (id === 'share') setShare(typeof on === 'boolean' ? on : !status?.share);
});

// 好友表变动或收到好友的新记录，Coda 通知一次，榜单跟着刷新；用量本身不会推送，另有定时刷新。
let again = null;
function later() { clearTimeout(again); again = setTimeout(() => { bridge.send({ type: 'hello' }); requestBoard(); }, 800); }
try {
  Promise.resolve(coda.watch('friends/social@1', ({ type }) => { if (type === 'MODIFIED') later(); }, { id: 'local' })).catch(() => {});
} catch {}
setInterval(() => { if (document.visibilityState !== 'hidden') requestBoard(); }, 60_000);

// ——— 画面 ———
function render() {
  declareToolbar();
  const children = [notes(), controls(), local(), leaderboard()];
  root.replaceChildren(h('div', { class: 'page' }, children));
}

function notes() {
  const lines = [];
  if (board?.errors?.length) lines.push(...board.errors);
  if (board?.truncated?.usage) lines.push('本机用量太零碎，部分时段没能取全，合计可能偏少');
  if (status?.lastError) lines.push(`同步失败：${status.lastError}`);
  if ((status?.syncState ?? board?.syncState) === 'needs_cert') lines.push('代签证书已过期，打开客户端续签后将自动补发统计');
  if ((status?.syncState ?? board?.syncState) === 'paused') lines.push('好友插件已暂停此类数据的对外发布');
  if ((status?.syncState ?? board?.syncState) === 'no_gateway') lines.push('未安装或未启用好友插件，暂只展示本机统计');
  return lines.length ? h('div', { class: 'notes' }, lines.map(line => h('p', { class: 'note' }, line))) : null;
}

function controls() {
  const on = status?.share === true;
  return h('section', {},
    h('h2', {}, '分享'),
    h('div', { class: 'card' },
      h('div', { class: 'pill' }, h('span', { class: on ? 'dot on' : 'dot' }), h('span', { class: 'strong' }, on ? '正在向好友分享每日汇总' : '没有向好友分享')),
      h('p', { class: 'hint' }, on
        ? `每 10 分钟发布按日归档和最近 48 小时曲线，只含按 Agent 和模型的 Token 数与回合数。${status?.lastSyncAt ? `上次同步 ${clock(status.lastSyncAt)}。` : ''}`
        : '开启后好友才看得到你的用量，你也才能和他们排名；关闭会撤回已发布的记录。'),
      status?.notice ? h('p', { class: 'hint' }, status.notice) : null,
      h('div', { class: 'controls' },
        h('button', { class: on ? 'btn' : 'btn primary', disabled: acting || !status, onclick: () => setShare(!on) }, on ? '关闭分享' : '开启分享'),
        on ? h('button', { class: 'btn', disabled: acting, onclick: () => act({ type: 'sync' }) }, '立即同步') : null,
        h('button', { class: 'btn', disabled: acting, onclick: () => act({ type: 'withdraw' }) }, '撤回已发布的记录'),
        h('button', { class: 'btn', disabled: loading, onclick: () => { bridge.send({ type: 'hello' }); requestBoard(); } }, loading ? '刷新中…' : '刷新'))));
}

function local() {
  const mine = board?.local;
  const body = !mine ? h('p', { class: 'empty' }, loading ? '读取中…' : '还没有数据')
    : !mine.totalTokens && !mine.turns ? h('p', { class: 'empty' }, `${rangeLabel()}没有用量`)
      : h('div', { class: 'card' },
        h('div', { class: 'big num' }, tokens(mine.totalTokens)),
        h('div', { class: 'secondary' }, `Token · ${count(mine.turns)} 个回合${mine.reportedTurns < mine.turns ? `，其中 ${count(mine.turns - mine.reportedTurns)} 个没有上报用量` : ''}`),
        stack(mine),
        h('div', { class: 'parts' }, PARTS.map(([key, label]) => h('div', { class: 'part' }, h('span', { class: 'secondary' }, label), h('span', { class: 'num strong' }, tokens(mine[key]))))),
        modelBars(mine.models, mine.totalTokens));
  return h('section', {}, h('h2', {}, '本机', h('span', { class: 'secondary' }, rangeLabel())), body);
}

function stack(c) {
  if (!c.totalTokens) return null;
  return h('div', { class: 'stack' }, PARTS.map(([key]) => { const s = h('span', { class: `c-${key}` }); s.style.width = `${(c[key] / c.totalTokens) * 100}%`; return s; }));
}

function modelBars(models, total) {
  if (!models?.length) return null;
  return h('ul', { class: 'bars' }, models.slice(0, 8).map(m => {
    const fill = h('span', {});
    fill.style.width = `${total ? Math.max(1, Math.round((m.totalTokens / total) * 100)) : 0}%`;
    return h('li', {}, h('div', { class: 'bar-line' }, h('span', { class: 'truncate' }, m.model), h('span', { class: 'spacer' }), h('span', { class: 'num secondary' }, tokens(m.totalTokens))), h('div', { class: 'bar' }, fill));
  }));
}

function leaderboard() {
  let content;
  if (!board) content = h('p', { class: 'empty' }, loading ? '读取中…' : '');
  else if (!board.accord) content = h('p', { class: 'empty' }, '这台机器还没有 Accord 身份，暂时没有好友榜。');
  else {
    const others = board.entries.filter(e => !e.self);
    content = [
      board.friendCount === 0 ? h('p', { class: 'empty' }, '还没有好友。添加好友并让他们开启分享后，这里会出现你们的消耗榜。') : null,
      h('ul', { class: 'list' }, board.entries.map(entry)),
      others.length && !others.some(e => e.shared) ? h('p', { class: 'hint' }, '好友们还没有分享用量。') : null,
      board.truncated?.friends ? h('p', { class: 'note' }, '好友的记录太多，只取到了其中一部分，榜单可能不全。') : null,
      board.truncated?.profiles ? h('p', { class: 'note' }, '好友名片太多，只取到了其中一部分，有些人可能显示成密钥短码。') : null];
  }
  return h('section', {}, h('h2', {}, '熟人榜', h('span', { class: 'secondary' }, rangeLabel())), content);
}

function entry(e) {
  const open = expanded.has(e.author);
  const name = e.name ?? `${e.shortId}…`;
  const avatar = h('span', { class: 'avatar' }, e.emoji ?? '👤');
  const color = colorOf(e.color);
  if (color) avatar.style.background = `color-mix(in srgb, ${color} 28%, transparent)`;
  const sub = !e.shared ? '还没有分享' : e.totalTokens || e.turns ? `${tokens(e.input)} 入 · ${tokens(e.output)} 出 · 缓存 ${tokens(e.cacheRead + e.cacheWrite)} · ${count(e.turns)} 回合` : `${rangeLabel()}没有用量`;
  return h('li', { class: 'row' },
    h('button', { class: 'head', 'aria-expanded': open ? 'true' : 'false', onclick: () => { if (open) expanded.delete(e.author); else expanded.add(e.author); render(); } },
      h('span', { class: 'rank num' }, String(e.rank)), avatar,
      h('span', { class: 'who' }, h('span', { class: 'line' }, h('span', { class: 'strong truncate' }, name), e.self ? h('span', { class: 'me' }, '我') : null), h('span', { class: 'secondary truncate' }, sub)),
      h('span', { class: 'amount' }, h('span', { class: 'strong num' }, tokens(e.totalTokens)))),
    open ? h('div', { class: 'detail' }, e.models.length
      ? [h('div', { class: 'secondary' }, `${e.name ? `${e.shortId}… · ` : ''}共 ${count(e.totalTokens)} Token`), modelBars(e.models, e.totalTokens)]
      : h('p', { class: 'empty' }, '没有模型明细')) : null);
}

bridge.send({ type: 'hello' });
if (range) { declareHeader(); requestBoard(); }
render();
