// The 网络记录 page: the machines' connections that hung and their targets' probes over the while chosen, from the modules'
// collections (Coda's docs/plugins.md「集合」), each object with its machine, a page of several machines put together.
import { PHASES, endText, route, seconds } from '../lib/summary.mjs';

const coda = window.coda;
const root = document.getElementById('root');
const RANGES = [{ id: '1h', label: '1 小时', ms: 3_600_000, cells: 6 }, { id: '24h', label: '24 小时', ms: 86_400_000, cells: 24 },
  { id: '7d', label: '7 天', ms: 7 * 86_400_000, cells: 28 }];
const store = { hangs: new Map(), targets: new Map(), status: new Map() };
let range = RANGES.find(r => r.id === coda.getState()?.range) ?? RANGES[1];

const h = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value); else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.flat().filter(c => c !== null && c !== undefined && c !== false));
  return node;
};
const pad = n => String(n).padStart(2, '0');
const when = at => { const d = new Date(at); return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const several = () => coda.machines.length > 1;
const machineName = id => coda.machines.find(m => m.id === id)?.name ?? '';

// One drawing for however many changes came together; `watch` gives what the bridge holds already as it is called.
let pending = false;
function schedule() { if (!pending) { pending = true; requestAnimationFrame(() => { pending = false; render(); }); } }
for (const name of Object.keys(store)) {
  coda.watch(name, ({ type, machine, id, object }) => {
    const key = `${machine.id}\n${id}`;
    if (type === 'DELETED') store[name].delete(key); else store[name].set(key, { machine, object });
    schedule();
  });
}
// The time goes on: a hang still waiting counts up, the while chosen moves.
setInterval(schedule, 5000);

function render() {
  const now = Date.now(), from = now - range.ms, scrollTop = root.scrollTop;
  root.replaceChildren(h('div', { class: 'page' }, toolbar(), problems(), hangsSection(from, now), probesSection(from, now)));
  root.scrollTop = scrollTop;
}

function toolbar() {
  return h('div', { class: 'ranges', role: 'tablist' }, RANGES.map(r => h('button', { class: r === range ? 'range on' : 'range', role: 'tab', 'aria-selected': String(r === range),
    onclick: () => { range = r; coda.setState({ range: r.id }); render(); } }, r.label)));
}

// What keeps a machine from being read or recorded: unreachable, a system without a table to read, mihomo not answering.
function problems() {
  const lines = [];
  for (const machine of coda.machines) if (machine.unreachable) lines.push(`读不到 ${machine.name}：${machine.unreachable}`);
  for (const { machine, object } of store.status.values()) {
    const who = several() ? `${machine.name}：` : '';
    if (object.supported === false) lines.push(`${who}这台的系统不支持读连接表，只做定时探测`);
    if (object.mihomo && object.mihomo !== 'ok' && object.mihomo !== 'off') lines.push(`${who}问不到 mihomo（${object.mihomo}），记不了连接有没有经过它`);
    if (object.unwritten) lines.push(`${who}记录写不进磁盘（${object.unwritten.error}），${object.unwritten.count} 条先留在内存里，能写时补上`);
  }
  return lines.length ? h('div', { class: 'notes' }, lines.map(line => h('p', { class: 'note' }, line))) : null;
}

function hangsSection(from, now) {
  const hangs = [...store.hangs.values()].filter(({ object }) => object.at >= from).sort((a, b) => b.object.at - a.object.at);
  return h('section', {}, h('h2', {}, '建连卡住', hangs.length ? h('span', { class: 'count' }, String(hangs.length)) : null),
    hangs.length ? h('ul', { class: 'list' }, hangs.map(({ machine, object }) => hangRow(machine, object, now)))
      : h('p', { class: 'empty' }, `${range.label}内没有卡住的连接`));
}
function hangRow(machine, hang, now) {
  const ended = endText(hang) ?? `还在等，已 ${seconds(now - hang.at)}`;
  const tags = [hang.iface ? h('span', { class: hang.viaTun === false ? 'tag warn' : 'tag' }, `${hang.iface}${route(hang) ? ` · ${route(hang)}` : ''}`) : h('span', { class: 'tag' }, '网卡不明'),
    hang.mihomo?.taken === false ? h('span', { class: 'tag warn' }, 'mihomo 没收到') : null,
    hang.mihomo?.taken ? h('span', { class: 'tag' }, `mihomo 收到了${hang.mihomo.chains?.length ? ` · ${hang.mihomo.chains[0]}` : ''}`) : null,
    h('span', { class: hang.end ? 'tag' : 'tag warn' }, ended)];
  return h('li', { class: 'row' },
    h('div', { class: 'line' }, h('span', { class: 'time' }, when(hang.at)), several() ? h('span', { class: 'machine' }, machine.name) : null,
      h('span', { class: 'strong truncate' }, hang.process ?? '进程不明')),
    h('div', { class: 'line' }, h('span', { class: 'mono selectable' }, `→ ${hang.remote}`)),
    h('div', { class: 'tags' }, tags),
    hang.command ? h('div', { class: 'command mono selectable' }, hang.command) : null);
}

function probesSection(from, now) {
  const targets = [...store.targets.values()].sort((a, b) => machineName(a.machine.id).localeCompare(machineName(b.machine.id)) || a.object.target.localeCompare(b.object.target));
  return h('section', {}, h('h2', {}, '定时探测'),
    targets.length ? h('ul', { class: 'list' }, targets.map(({ machine, object }) => targetRow(machine, object, from, now)))
      : h('p', { class: 'empty' }, '还没有探测记录：插件每分钟探测设置里的地址'));
}
function targetRow(machine, target, from, now) {
  const buckets = target.buckets.filter(b => b[0] + 600_000 > from), total = buckets.reduce((n, b) => n + b[1], 0), failed = buckets.reduce((n, b) => n + b[2], 0);
  const cell = range.ms / range.cells, cells = Array.from({ length: range.cells }, (_, i) => {
    const start = now - range.ms + i * cell, inside = buckets.filter(b => b[0] + 600_000 > start && b[0] < start + cell);
    const n = inside.reduce((s, b) => s + b[1], 0), f = inside.reduce((s, b) => s + b[2], 0);
    return h('span', { class: `cell ${!n ? 'none' : !f ? 'ok' : f === n ? 'bad' : 'some'}`, title: `${when(start)} 起：${n ? `${n} 次，失败 ${f} 次` : '没有记录'}` });
  });
  const failures = target.failures.filter(f => f.at >= from).slice(-3).reverse();
  return h('li', { class: 'row' },
    h('div', { class: 'line' }, h('span', { class: `dot ${target.last?.ok ? 'ok' : 'bad'}` }), h('span', { class: 'strong truncate' }, target.target),
      several() ? h('span', { class: 'machine' }, machine.name) : null, h('span', { class: 'spacer' }),
      h('span', { class: failed ? 'secondary warn-text' : 'secondary' }, total ? (failed ? `失败 ${failed} / ${total}` : `${total} 次都通`) : '没有记录')),
    h('div', { class: 'strip' }, cells),
    failures.map(f => h('div', { class: 'failure' }, h('span', { class: 'time' }, when(f.at)),
      h('span', { class: 'selectable' }, `${PHASES[f.phase] ?? f.phase}阶段失败：${f.error}${f.ms?.total ? `（${seconds(f.ms.total)}）` : ''}`))));
}

render();
