// Token 消耗榜页面：用量概览，和好友的消耗榜。数据都由模块（main.mjs）读好、算好，经页面消息送来；页面不直接读记录。
// 视图里有几台机器就都读，按人合并（lib/merge.mjs）：时间范围由页首选，机器范围由 App 的全局视图定，页面不自己选机器。
// 每一轮读取由页面按这台设备的当地时间定一组 from、to 发给每台：各台时区不同时，窗口也是同一段时间。
// 好友的昵称、模型名等外来文字只经 textContent / 文本节点渲染，从不拼进 innerHTML。
import { mergeBoards } from '../lib/merge.mjs';
import { rangeWindow } from '../lib/usage.mjs';

const coda = window.coda;
const root = document.getElementById('root');
const RANGES = [{ id: 'today', label: '今天' }, { id: '7d', label: '近 7 天' }, { id: '30d', label: '近 30 天' }];
const PARTS = [['input', '输入'], ['output', '输出'], ['cacheRead', '缓存读'], ['cacheWrite', '缓存写']];
const SAFE_COLOR = /^#[0-9a-fA-F]{6}$/;
// 好友插件的命名主题色，换成固定色值再用；#RRGGBB 原样用，其他一律不用。
const NAMED_COLORS = { blue: '#3b82f6', orange: '#f97316', green: '#22c55e', purple: '#a855f7', pink: '#ec4899', teal: '#14b8a6', gray: '#6b7280' };
const colorOf = value => (Object.hasOwn(NAMED_COLORS, value) ? NAMED_COLORS[value] : SAFE_COLOR.test(value ?? '') ? value : null);

const saved = coda.getState?.() ?? {};
let range = RANGES.find(r => r.id === saved?.range)?.id ?? null;
// 视图里的每台机器（成员在页面生命周期内不变）各存一份状态、数据和错误；读不到的（unreachable）也在，只是不发消息。
const members = (Array.isArray(coda.machines) ? coda.machines : [coda.machine]).filter(m => typeof m?.id === 'string' && m.id).map(m => ({
  id: m.id, name: m.name || m.id, unreachable: m.unreachable ? (m.unreachable === true ? '暂时连不上' : String(m.unreachable)) : null,
  status: null, statusFailure: null, board: null, failure: null, loading: false, acting: false, seq: 0,
}));
const live = members.filter(m => !m.unreachable);
const multi = members.length > 1;
let seq = 0, merged = null;
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
const send = (m, msg) => { Promise.resolve().then(() => coda.postMessage(msg, { machine: m.id })).catch(error => failed(m, msg, error)); };
// 发送失败按请求认：榜单只认当前那一次（旧的晚到不动新数据），状态读取和写操作的失败只落在各自的提示里，互不影响。
function failed(m, msg, error) {
  const text = error?.message ?? String(error);
  if (msg.type === 'board') {
    if (msg.id !== m.seq) return;
    m.loading = false; m.failure = text; m.board = null;
  } else {
    if (msg.type === 'hello') m.statusFailure = text; else m.acting = false;
    m.status = { ...(m.status ?? {}), notice: `发送失败：${text}` };
  }
  render();
}
function requestBoards() {
  if (!range) return;
  const { from, to } = rangeWindow(range, Date.now());
  for (const m of live) { m.loading = true; m.seq = ++seq; send(m, { type: 'board', range, from, to, id: m.seq }); }
  render();
}
function refresh() { for (const m of live) send(m, { type: 'hello' }); requestBoards(); }
const handlers = {
  status(m, d) {
    m.status = d; m.statusFailure = null; m.acting = false;
    if (!range) { range = RANGES.find(r => r.id === d.range)?.id ?? '7d'; declareHeader(); requestBoards(); }
    render();
  },
  board(m, d) {
    if (d.id !== m.seq) return;
    m.board = d; m.failure = null; m.loading = false; render();
  },
  error(m, d) {
    if (d.request === 'board') {   // 读榜单失败：这台算读不到，不留旧数据冒充完整的结果
      if (d.id === m.seq) { m.loading = false; m.failure = d.message; m.board = null; render(); }
      return;
    }
    if (d.request === 'hello') m.statusFailure = d.message;
    m.acting = false;
    m.status = { ...(m.status ?? {}), notice: d.message };
    render();
  },
};
addEventListener('message', event => {
  const d = event.data;
  if (!(d && typeof d === 'object' && typeof d.type === 'string')) return;
  const m = event.machine?.id ? members.find(one => one.id === event.machine.id) : members.length === 1 ? members[0] : null;
  if (m) handlers[d.type]?.(m, d);
});

// 开关、同步、撤回都发给每台（同步只发给开着分享的），各台各自回结果。
// 没连上的成员收不到：开关和撤回要写明它没有执行，撤回尤其要让人知道它已发布的记录没撤掉。
function act(message, targets, skipped = null) {
  for (const m of members) m.skipped = m.unreachable ? skipped : null;
  for (const m of targets) { m.acting = true; send(m, message); }
  render();
}
const setShare = on => act({ type: 'set-share', on }, live, `没连上，没有${on ? '开启' : '关闭'}分享`);
// 分享状态只有视图里每一台都已回报、且一样才合成一份（single）；有没回报或读不到的，不替它做主，按台列出。
const shareOf = () => {
  const known = live.filter(m => typeof m.status?.share === 'boolean');
  const on = known.filter(m => m.status.share === true);
  const single = known.length === members.length && (on.length === 0 || on.length === known.length);
  return { known, single, on: single && on.length > 0, any: on.length > 0 };
};

// ——— 顶栏 ———
let headerKey = '';
function declareHeader() {
  if (!range || headerKey === range) return;
  headerKey = range;
  try { coda.header({ text: null, segments: { items: RANGES, selected: range } })?.catch?.(() => {}); } catch {}
}
coda.on?.('header', ({ id }) => {
  if (!RANGES.some(r => r.id === id)) return;
  range = id; saveState();
  for (const m of members) m.board = null;
  requestBoards();
});
let toolbarKey = '';
function declareToolbar() {
  const { single, on } = shareOf(), key = single ? String(on) : 'unsettled';
  if (toolbarKey === key) return;
  toolbarKey = key;
  // 状态没定（有的没回报、读不到或各台不一样）时不给分享开关：开关只有开、关两种样子，哪种都是替没回报的电脑做主。
  try {
    coda.toolbar?.([{ id: 'refresh', kind: 'button', label: '刷新', icon: 'arrow.clockwise' },
      ...(single ? [{ id: 'share', kind: 'toggle', label: '分享', icon: 'person.2.fill', on }] : [])])?.catch?.(() => {});
  } catch {}
}
coda.on?.('toolbar', ({ id, on } = {}) => {
  if (id === 'refresh') refresh();
  else if (id === 'share' && shareOf().single) setShare(typeof on === 'boolean' ? on : !shareOf().on);
});

// 好友表变动或收到好友的新记录，Coda 通知一次，榜单跟着刷新；用量本身不会推送，另有定时刷新。
let again = null;
function later() { clearTimeout(again); again = setTimeout(refresh, 800); }
for (const m of live) {
  try { Promise.resolve(coda.watch('friends/social@1', ({ type }) => { if (type === 'MODIFIED') later(); }, { id: 'local' }, { machine: m.id })).catch(() => {}); } catch {}
}
const saveState = () => coda.setState?.({ range });
setInterval(() => { if (document.visibilityState !== 'hidden') requestBoards(); }, 60_000);

// ——— 画面 ———
const names = list => list.map(m => m.name).join('、');
const partial = () => (merged.incomplete ? h('span', { class: 'note' }, merged.problems.length ? '不完整' : '读取中…') : null);

function render() {
  declareToolbar();
  const parts = members.flatMap(m => {
    const problem = m.unreachable ?? m.failure;
    return problem ? [{ machine: m, problem }] : m.board ? [{ machine: m, board: m.board }] : [{ machine: m, pending: true }];
  });
  merged = mergeBoards(parts);
  root.replaceChildren(h('div', { class: 'page' }, [notes(), controls(), local(), leaderboard()]));
}

function notes() {
  const lines = [], who = machine => (multi ? `${machine.name}：` : '');
  for (const { machine, reason, partial } of merged.problems) lines.push(partial ? `${machine.name}：${reason}，合计缺它的本机用量` : `${machine.name} 读不到：${reason}，合计不含这台`);
  for (const { machine, text } of merged.errors) lines.push(`${who(machine)}${text}`);
  for (const group of merged.locals) if (group.truncated) lines.push(`${multi ? `${names(group.machines)}：` : ''}本机用量太零碎，部分时段没能取全，合计可能偏少`);
  if (multi && merged.accord && merged.noAccord.length) lines.push(`${names(merged.noAccord)} 还没有 Accord 身份，它的用量不在榜里`);
  for (const m of live) {
    const state = m.status?.syncState ?? m.board?.syncState;
    if (m.status?.lastError) lines.push(`${who(m)}同步失败：${m.status.lastError}`);
    if (state === 'needs_cert') lines.push(`${who(m)}代签证书已过期，打开客户端续签后将自动补发统计`);
    if (state === 'paused') lines.push(`${who(m)}好友插件已暂停此类数据的对外发布`);
    if (state === 'no_gateway') lines.push(`${who(m)}未安装或未启用好友插件，暂只展示本机统计`);
  }
  return lines.length ? h('div', { class: 'notes' }, lines.map(line => h('p', { class: 'note' }, line))) : null;
}

function controls() {
  const { known, single, on, any } = shareOf(), acting = live.some(m => m.acting);
  const syncedAt = Math.max(0, ...known.map(m => m.status.lastSyncAt ?? 0));
  const notices = members.filter(m => m.status?.notice || m.skipped).map(m => h('p', { class: 'hint' }, `${multi ? `${m.name}：` : ''}${m.skipped ?? m.status.notice}`));
  const shareText = m => (m.unreachable ? `读不到分享状态：${m.unreachable}` : typeof m.status?.share !== 'boolean' ? (m.statusFailure ? `读取分享状态失败：${m.statusFailure}` : '还没取到分享状态')
    : m.status.share === true ? `正在分享${m.status.lastSyncAt ? `，上次同步 ${clock(m.status.lastSyncAt)}` : ''}` : '没有分享');
  const pill = single
    ? h('div', { class: 'pill' }, h('span', { class: on ? 'dot on' : 'dot' }), h('span', { class: 'strong' }, on ? '正在向好友分享每日汇总' : '没有向好友分享'))
    : h('div', { class: 'shares' }, members.map(m => h('div', { class: 'pill' }, h('span', { class: m.status?.share === true ? 'dot on' : 'dot' }),
      h('span', { class: 'strong' }, `${multi ? `${m.name}：` : ''}${shareText(m)}`))));
  return h('section', {},
    h('h2', {}, '分享'),
    h('div', { class: 'card' },
      pill,
      h('p', { class: 'hint' }, !single ? '各台的分享状态不一样，或有的还没取到；开启、关闭和撤回会对每台生效。'
        : on ? `每 10 分钟发布按日归档和最近 48 小时曲线，只含按 Agent 和模型的 Token 数与回合数。${syncedAt ? `上次同步 ${clock(syncedAt)}。` : ''}`
          : '开启后好友才看得到你的用量，你也才能和他们排名；关闭会撤回已发布的记录。'),
      notices,
      h('div', { class: 'controls' },
        ...(single
          ? [h('button', { class: on ? 'btn' : 'btn primary', disabled: acting || !known.length, onclick: () => setShare(!on) }, on ? '关闭分享' : '开启分享')]
          : [h('button', { class: 'btn primary', disabled: acting || !known.length, onclick: () => setShare(true) }, '开启分享'),
            h('button', { class: 'btn', disabled: acting || !known.length, onclick: () => setShare(false) }, '关闭分享')]),
        any ? h('button', { class: 'btn', disabled: acting, onclick: () => act({ type: 'sync' }, known.filter(m => m.status.share === true)) }, '立即同步') : null,
        h('button', { class: 'btn', disabled: acting, onclick: () => act({ type: 'withdraw' }, live, '没连上，没有撤回，它已发布的记录还在') }, '撤回已发布的记录'),
        h('button', { class: 'btn', disabled: live.some(m => m.loading), onclick: refresh }, live.some(m => m.loading) ? '刷新中…' : '刷新'))));
}

function local() {
  const loading = live.some(m => m.loading), blocks = merged.locals.map(group => h('div', { class: 'group' }, multi ? caption(group) : null, usageBody(group)));
  const body = blocks.length ? blocks : h('p', { class: 'empty' }, loading ? '读取中…' : '还没有数据');
  return h('section', {}, h('h2', {}, multi ? '用量' : '本机', h('span', { class: 'secondary' }, rangeLabel()), partial()), body);
}
// 一块用量的标题：同一身份的几台相加就写明合了哪几台；视图里有几个身份时再写是谁的。
function caption(group) {
  const entry = merged.locals.length > 1 ? merged.entries.find(e => e.author === group.author) : null;
  const who = entry ? `${entry.name ?? `${entry.shortId}…`} · ` : '';
  return h('p', { class: 'hint' }, `${who}${group.machines.length > 1 ? '合计 · ' : ''}${names(group.machines)}`);
}
function usageBody(mine) {
  return !mine.totalTokens && !mine.turns ? h('p', { class: 'empty' }, `${rangeLabel()}没有用量`)
    : h('div', { class: 'card' },
      h('div', { class: 'big num' }, tokens(mine.totalTokens)),
      h('div', { class: 'secondary' }, `Token · ${count(mine.turns)} 个回合${mine.reportedTurns < mine.turns ? `，其中 ${count(mine.turns - mine.reportedTurns)} 个没有上报用量` : ''}`),
      stack(mine),
      h('div', { class: 'parts' }, PARTS.map(([key, label]) => h('div', { class: 'part' }, h('span', { class: 'secondary' }, label), h('span', { class: 'num strong' }, tokens(mine[key]))))),
      modelBars(mine.models, mine.totalTokens));
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
  if (!merged.readable) content = h('p', { class: 'empty' }, live.some(m => m.loading) ? '读取中…' : '');
  else if (!merged.accord) content = h('p', { class: 'empty' }, multi ? '这些机器都还没有 Accord 身份，暂时没有好友榜。' : '这台机器还没有 Accord 身份，暂时没有好友榜。');
  else {
    const others = merged.entries.filter(e => !e.self);
    content = [
      !merged.friends ? h('p', { class: 'empty' }, '还没有好友。添加好友并让他们开启分享后，这里会出现你们的消耗榜。') : null,
      h('ul', { class: 'list' }, merged.entries.map(entry)),
      others.length && !others.some(e => e.shared) ? h('p', { class: 'hint' }, '好友们还没有分享用量。') : null,
      merged.truncated.friends ? h('p', { class: 'note' }, '好友的记录太多，只取到了其中一部分，榜单可能不全。') : null,
      merged.truncated.profiles ? h('p', { class: 'note' }, '好友名片太多，只取到了其中一部分，有些人可能显示成密钥短码。') : null];
  }
  return h('section', {}, h('h2', {}, '熟人榜', h('span', { class: 'secondary' }, rangeLabel()), partial()), content);
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

for (const m of live) send(m, { type: 'hello' });
if (range) { declareHeader(); requestBoards(); }
render();
