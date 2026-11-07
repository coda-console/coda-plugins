// This environment's slots for simulators and heavy builds as a resource (README.md): the group host as Coda says it is now
// (`CODA_GROUPS_STATE`), how many it lets in (the setting host.capacity), who holds it and who waits, as many as a resource
// has values. One holding it whole (清点模拟器) leaves no slot free.
const { now, groups } = JSON.parse(process.env.CODA_GROUPS_STATE || '{"groups":[]}');
const settings = JSON.parse(process.env.CODA_PLUGIN_SETTINGS || '{}');
const capacity = Number(settings['host.capacity']) || 1;
const host = groups.find(g => g.name === 'host') ?? { occupied: 0, holders: [], queue: [] };
const VALUES = 8;

const clip = (text, n = 80) => text.length > n ? `${text.slice(0, n - 1)}…` : text;
const minutes = since => { const m = Math.max(0, Math.floor((now - since) / 60_000)); return m < 1 ? '不到 1 分钟' : m < 60 ? `${m} 分钟` : `${Math.floor(m / 60)} 小时 ${m % 60} 分钟`; };
// Who: the run's title (or workflow), and the session it belongs to.
const who = x => clip(`${x.title || x.workflow}${x.thread ? ` · ${x.thread}` : ''}`);

const free = host.holders.some(h => h.exclusive) ? 0 : Math.max(0, capacity - host.occupied);
const values = [{ label: '空闲', value: `${free} / ${capacity}`, fraction: free / capacity },
  ...host.holders.map(h => ({ label: who(h), value: clip(`${h.leaving ? '正在收尾' : h.borrowed ? '借用中' : h.exclusive ? '占满' : '占用'} ${minutes(h.since)}`) })),
  ...host.queue.map((w, i) => ({ label: who(w), value: `排第 ${i + 1} 位，等了 ${minutes(w.since)}` }))];
console.log(JSON.stringify({ resources: [{ values: values.slice(0, VALUES) }] }));
