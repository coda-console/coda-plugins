// Token 消耗榜页面：目录聚合视图，只读目录里本插件的记录（协议 token-board/usage@1），不给模块发消息，不逐台读。
// 不带 machine 的 `coda.watch` 把视图里各台的记录都给了：本机用量、这台的状态、镜像来的好友记录；第一次 watch 给完才画第一屏，
// 之后只在记录变化时重画（合到一帧）。时间窗按看页面这台设备的当地时间，用 rangeWindow 算；每次打开都从「今天」开始。
// 分享开关是对每台的状态记录调 `set-share`。模型名等外来文字只经 textContent / 文本节点渲染，从不拼进 innerHTML。
import { summarize } from '../lib/merge.mjs';
import { cleanText, rangeWindow } from '../lib/usage.mjs';

const coda = window.coda;
const root = document.getElementById('root');
const KIND = 'token-board/usage@1';
const RANGES = [{ id: 'today', label: '今天' }, { id: '7d', label: '近 7 天' }, { id: '30d', label: '近 30 天' }];
const PARTS = [['input', '输入'], ['output', '输出'], ['cacheRead', '缓存读'], ['cacheWrite', '缓存写']];
const TOP_MODELS = 5;
// 撤回没做完、又不是出错时，等的是什么。
const UNFINISHED = { needs_cert: '等代签证书续签', queued: '已排队，等好友网关处理', no_identity: '这台还没有好友身份', paused: '好友插件暂停了发布' };

let range = 'today';
let ready = false, queued = false, loadError = null;
let states = [], failures = [], acting = false, showAll = false;
const records = new Map();   // `<持有方>\n<记录 ID>` → 目录条目
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
const rangeLabel = () => RANGES.find(r => r.id === range).label;
const pad = n => String(n).padStart(2, '0');
const clock = at => { const d = new Date(at); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

// ——— 读记录 ———
// 现有的先全部给完（await 到），再画第一屏；之后的变化合到一帧里重画。
function changed() {
  if (!ready || queued) return;
  queued = true;
  (globalThis.requestAnimationFrame ?? queueMicrotask)(() => { queued = false; render(); });
}
Promise.resolve(coda.watch(KIND, ({ type, entry }) => {
  const key = `${entry.owner}\n${entry.id}`;
  if (type === 'DELETED') records.delete(key); else records.set(key, entry);
  changed();
})).catch(error => { loadError = error?.message ?? String(error); }).then(() => { ready = true; render(); });
// 跨过午夜后「今天」要跟着变：按当前时刻重算窗口，不读任何东西。
setInterval(changed, 60_000);

// ——— 顶栏与工具栏 ———
try { coda.header({ text: null, segments: { items: RANGES, selected: range } })?.catch?.(() => {}); } catch {}
coda.on?.('header', ({ id }) => {
  if (!RANGES.some(r => r.id === id)) return;
  range = id; showAll = false;
  render();
});
let toolbarKey = '';
function declareToolbar() {
  const on = states.length > 0 && states.every(state => state.share), key = states.length ? String(on) : 'none';
  if (toolbarKey === key) return;
  toolbarKey = key;
  try { coda.toolbar?.(states.length ? [{ id: 'share', kind: 'toggle', label: '分享', icon: 'person.2.fill', on }] : [])?.catch?.(() => {}); } catch {}
}
coda.on?.('toolbar', ({ id, on } = {}) => { if (id === 'share' && !acting) setShare(typeof on === 'boolean' ? on : !states.every(state => state.share)); });

// 对视图里每台的状态记录调 set-share；失败的写在页脚，记录没变，开关回到记录说的样子。
async function setShare(on) {
  const targets = states;
  acting = true; failures = [];
  await Promise.all(targets.map(state => Promise.resolve().then(() => coda.call({ kind: KIND, id: state.id }, 'set-share', { on })).catch(() => { failures.push(state.machine); })));
  acting = false; toolbarKey = '';
  render();
}

// ——— 画面 ———
function render() {
  const { from, to } = rangeWindow(range, Date.now());
  const board = summarize([...records.values()], { from, to });
  states = board.states;
  declareToolbar();
  root.replaceChildren(h('div', { class: 'page' }, [mine(board.mine), leaderboard(board.board), footer()]));
}

function mine(total) {
  const body = !total.totalTokens && !total.turns ? h('p', { class: 'empty' }, `${rangeLabel()}没有用量`) : h('div', { class: 'card' },
    h('div', { class: 'big num' }, tokens(total.totalTokens), h('small', {}, 'Token')),
    h('div', { class: 'sub' }, `${count(total.turns)} 个回合`),
    stack(total),
    legend(total),
    modelList(total.models, total.totalTokens, 'local', showAll ? Infinity : TOP_MODELS));
  return h('section', {}, h('h2', {}, total.machines.length ? `我 · ${total.machines.join('、')}` : '我'), body);
}

function stack(c) {
  if (!c.totalTokens) return null;
  return h('div', { class: 'stack' }, PARTS.map(([key]) => { const s = h('span', { class: `c-${key}` }); s.style.width = `${(c[key] / c.totalTokens) * 100}%`; return s; }));
}

const legend = c => h('div', { class: 'legend' }, PARTS.map(([key, label]) => h('div', {}, h('span', {}, h('i', { class: `c-${key}` }), label), h('b', { class: 'num' }, tokens(c[key])))));

// 型号行都能点开：回合、占比、缓存命中、四项 Token，按 Agent、设备（「我」且不止一台有用量）、请求来源（有区分价值时）拆开。
// 请求来源：只有一个请求项、它的 asked 就是型号名、又没有服务时不列（和型号名同名，没有信息）。
const hasItems = m => m.items.length > 1 || m.items.some(item => (item.asked ?? m.model) !== m.model || (item.api && item.api !== m.model));
// 型号名、asked、Agent、机器名是身份或外来文字，原样存取；清洗只在显示时做。
const shown = text => cleanText(text, 200) ?? '?';
const percent = value => (value < 0.1 ? '<0.1%' : `${value.toFixed(1)}%`);
const usedBy = c => `${tokens(c.totalTokens)} · ${count(c.turns)} 回合`;
const section = (title, rows) => h('div', { class: 'sect' }, h('div', { class: 'sect-title' }, title), h('ul', { class: 'items' }, rows.map(([name, note, c]) => h('li', { class: 'bar-line' },
  h('span', { class: 'truncate' }, name), note ? h('span', { class: 'secondary truncate' }, note) : null, h('span', { class: 'spacer' }), h('span', { class: 'num secondary' }, usedBy(c))))));
function modelDetail(m, total) {
  const cacheBase = m.input + m.cacheRead + m.cacheWrite;
  const facts = [`${count(m.turns)} 回合`, total > 0 && m.totalTokens > 0 ? `占 ${percent((m.totalTokens / total) * 100)}` : null, m.cacheRead > 0 && cacheBase > 0 ? `缓存命中 ${percent((m.cacheRead / cacheBase) * 100)}` : null].filter(Boolean);
  const agents = (m.agents ?? []).filter(a => a.agent != null && a.agent !== '_');
  const direct = m.items.some(item => item.api);
  return h('div', { class: 'mdetail' },
    h('div', { class: 'facts secondary num' }, facts.join(' · ')), stack(m), legend(m),
    agents.length ? section('Agent', agents.map(a => [shown(a.agent), null, a])) : null,
    m.machines?.length > 1 ? section('设备', m.machines.map(x => [shown(x.machine), null, x])) : null,
    hasItems(m) ? section('请求来源', m.items.map(item => { const name = item.asked ?? m.model; return [shown(name), item.api ? (item.api !== name ? item.api : null) : direct ? '直连' : null, item]; })) : null);
}
function modelList(models, total, scope, limit) {
  if (!models?.length) return null;
  const rows = models.slice(0, limit).map(m => {
    const fill = h('span', {}), key = `${scope}|${m.model}`, open = expanded.has(key);
    fill.style.width = `${total ? Math.max(1, Math.round((m.totalTokens / total) * 100)) : 0}%`;
    return h('li', {},
      h('button', { class: 'bar-head', 'aria-expanded': open ? 'true' : 'false', onclick: () => { if (open) expanded.delete(key); else expanded.add(key); render(); } },
        h('div', { class: 'bar-line' }, h('span', { class: 'truncate' }, shown(m.model)), h('span', { class: 'spacer' }), h('span', { class: 'num secondary' }, tokens(m.totalTokens)), h('span', { class: 'chev', 'aria-hidden': 'true' })), h('div', { class: 'bar' }, fill)),
      open ? modelDetail(m, total) : null);
  });
  return h('ul', { class: 'models' }, rows, models.length > limit ? h('button', { class: 'more', onclick: () => { showAll = true; render(); } }, `展开全部 ${models.length} 个型号`) : null);
}

function leaderboard({ friends, entries, unshared }) {
  if (!friends) return h('section', {}, h('h2', {}, '好友榜'), h('p', { class: 'empty' }, '还没有好友。加了好友、对方也开着分享，就能在这里比一比。'));
  return h('section', {},
    h('h2', {}, '好友榜'),
    h('div', { class: 'list' }, entries.map(entry)),
    unshared ? h('p', { class: 'empty small' }, `还有 ${unshared} 位好友没有分享`) : null);
}

function entry(e) {
  const open = expanded.has(e.author);
  return h('div', { class: e.self ? 'row me' : 'row' },
    h('button', { 'aria-expanded': open ? 'true' : 'false', onclick: () => { if (open) expanded.delete(e.author); else expanded.add(e.author); render(); } },
      h('span', { class: 'rank num' }, String(e.rank)),
      h('span', { class: 'who' }, h('span', { class: 'n' }, h('span', { class: 'truncate' }, e.displayId), e.self ? h('span', { class: 'tag' }, '我') : null), h('span', { class: 's num' }, `${count(e.turns)} 个回合`)),
      h('span', { class: 'amt num' }, tokens(e.totalTokens))),
    open ? h('div', { class: 'detail' }, e.models.length ? modelList(e.models, e.totalTokens, e.author, Infinity) : h('p', { class: 'empty' }, '没有模型明细')) : null);
}

// 页脚一行灰字；只有要人处理的（证书过期、同步出错、开关没改成）另写一行。
function footer() {
  const lines = [];
  if (loadError) lines.push([`读不到记录：${loadError}`, true]);
  if (states.some(state => state.share && state.syncState === 'needs_cert')) lines.push(['代签证书已过期，打开 Coda 续签后自动补发', true]);
  for (const state of states) if (state.error) lines.push([`${state.machine} 同步出错：${state.error}`, true]);
  for (const machine of failures) lines.push([`${machine} 没连上，没有改`, true]);
  // 关了分享，撤回确认完成才能说好友看不到；没完成的写原因，出错的写是哪台。
  const pending = [...new Set(states.filter(state => state.withdrawal).map(state => `${state.withdrawal.state === 'error' ? `${state.machine} ` : ''}已关闭分享，已发布的记录还没撤回完：${UNFINISHED[state.withdrawal.state] ?? state.withdrawal.error}`))];
  for (const line of pending) lines.push([line, true]);
  const on = states.filter(state => state.share);
  if (on.length) { const at = Math.max(...on.map(state => state.lastSyncAt ?? 0)); lines.push([`正在向好友分享${at ? ` · ${clock(at)} 已同步` : ''}`, false]); }
  else if (states.length && !pending.length) lines.push(['没有分享，好友看不到你的用量', false]);
  return h('div', { class: 'foot' }, lines.map(([text, warn]) => h('span', { class: warn ? 'warn' : null }, text)));
}
