// The test devices plugged into this Mac as a panel (README.md): each one registered here
// (scripts/registry.mjs), with who has it — its group device:<name>, as Coda says it is now (`CODA_GROUPS_STATE`) — and who
// waits. No device registered, nothing to show.
import { devices } from './registry.mjs';

const { now, groups } = JSON.parse(process.env.CODA_GROUPS_STATE || '{"groups":[]}');
let list;
try { list = devices(); } catch (error) {
  console.log(JSON.stringify({ items: [{ type: 'error', text: error.message.slice(0, 200) }] })); process.exit(0);
}

const clip = (text, n = 80) => text.length > n ? `${text.slice(0, n - 1)}…` : text;
const minutes = since => { const m = Math.max(0, Math.floor((now - since) / 60_000)); return m < 1 ? '不到 1 分钟' : m < 60 ? `${m} 分钟` : `${Math.floor(m / 60)} 小时 ${m % 60} 分钟`; };
const who = x => clip(`${x.title || x.workflow}${x.thread ? ` · ${x.thread}` : ''}`);

const items = list.filter(d => d && typeof d.id === 'string').slice(0, 20).map(device => {
  const group = groups.find(g => g.name === `device:${device.id}`) ?? { holders: [], queue: [] };
  const rows = [];
  // The use that holds it first; commands a session borrowed it for after.
  const holders = [...group.holders].sort((a, b) => a.borrowed - b.borrowed || a.since - b.since);
  if (!holders.length) rows.push({ type: 'stat', label: '状态', value: '空闲' });
  for (const h of holders.slice(0, 8))
    rows.push({ type: 'stat', label: who(h), value: clip(h.leaving ? `正在收尾，${minutes(h.since)}` : h.borrowed ? `会话借用 ${minutes(h.since)}` : `使用中 ${minutes(h.since)}`) });
  for (const [i, w] of group.queue.slice(0, 8).entries())
    rows.push({ type: 'stat', label: who(w), value: `排第 ${i + 1} 位，等了 ${minutes(w.since)}` });
  return { type: 'card', title: clip(device.name || device.id, 40), subtitle: clip(device.id), items: rows };
});
console.log(JSON.stringify({ items }));
