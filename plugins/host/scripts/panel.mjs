// This environment's slots for simulators and heavy builds as a panel (README.md): the group host as
// Coda says it is now (`CODA_GROUPS_STATE`), how many it lets in (the setting host.capacity), who holds it and who waits. One
// holding it whole (清点模拟器) leaves no slot free.
const { now, groups } = JSON.parse(process.env.CODA_GROUPS_STATE || '{"groups":[]}');
const settings = JSON.parse(process.env.CODA_PLUGIN_SETTINGS || '{}');
const capacity = Number(settings['host.capacity']) || 1;
const host = groups.find(g => g.name === 'host') ?? { occupied: 0, holders: [], queue: [] };

const clip = (text, n = 80) => text.length > n ? `${text.slice(0, n - 1)}…` : text;
const minutes = since => { const m = Math.max(0, Math.floor((now - since) / 60_000)); return m < 1 ? '不到 1 分钟' : m < 60 ? `${m} 分钟` : `${Math.floor(m / 60)} 小时 ${m % 60} 分钟`; };
// Who: the run's title (or workflow), and the session it belongs to.
const who = x => clip(`${x.title || x.workflow}${x.thread ? ` · ${x.thread}` : ''}`);

const free = host.holders.some(h => h.exclusive) ? 0 : Math.max(0, capacity - host.occupied);
const items = [{ type: 'meter', label: '空闲名额', value: `${free} / ${capacity}`, fraction: free / capacity,
  note: host.queue.length ? `${host.queue.length} 个在排队` : '没有排队' }];
for (const h of host.holders.slice(0, 9))
  items.push({ type: 'stat', label: who(h), value: clip(`${h.leaving ? '正在收尾' : h.borrowed ? '借用中' : h.exclusive ? '占满' : '占用'} ${minutes(h.since)}`) });
for (const [i, w] of host.queue.slice(0, 9).entries())
  items.push({ type: 'stat', label: who(w), value: `排第 ${i + 1} 位，等了 ${minutes(w.since)}` });
const more = host.holders.length + host.queue.length - Math.min(host.holders.length, 9) - Math.min(host.queue.length, 9);
if (more > 0) items.push({ type: 'markdown', text: `还有 ${more} 个没列出` });
console.log(JSON.stringify({ items: [{ type: 'card', title: '构建与模拟器', subtitle: `这个实例同时允许 ${capacity} 个（设置「名额数」）`, items }] }));
