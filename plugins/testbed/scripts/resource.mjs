#!/usr/bin/env node
// The `coda/resource@1` record of the「测试机」type (README.md), printed once: the test devices plugged into this Mac, each one
// registered here (scripts/registry.mjs), with who has it — its group device:<name>, as Coda says it is now
// (`CODA_GROUPS_STATE`) — and who waits. No device registered, nothing to show; a registration that cannot be read fails the
// command (exit 1, the reason, without the path of the file, on the last line of its standard error), which keeps the record
// Coda has: there is no login to offer for it.
import { devices } from './registry.mjs';

const { now, groups } = JSON.parse(process.env.CODA_GROUPS_STATE || '{"groups":[]}');

const VALUES = 8;
const clip = (text, n = 80) => text.length > n ? `${text.slice(0, n - 1)}…` : text;
const minutes = since => { const m = Math.max(0, Math.floor((now - since) / 60_000)); return m < 1 ? '不到 1 分钟' : m < 60 ? `${m} 分钟` : `${Math.floor(m / 60)} 小时 ${m % 60} 分钟`; };
const who = x => clip(`${x.title || x.workflow}${x.thread ? ` · ${x.thread}` : ''}`);

function read() {
  return devices().filter(d => d && typeof d.id === 'string').slice(0, 20).map(device => {
    const group = groups.find(g => g.name === `device:${device.id}`) ?? { holders: [], queue: [] };
    // The use that holds it first; commands a session borrowed it for after.
    const holders = [...group.holders].sort((a, b) => a.borrowed - b.borrowed || a.since - b.since);
    const values = [
      ...holders.map(h => ({ label: who(h), value: clip(h.leaving ? `正在收尾，${minutes(h.since)}` : h.borrowed ? `会话借用 ${minutes(h.since)}` : `使用中 ${minutes(h.since)}`) })),
      ...group.queue.map((w, i) => ({ label: who(w), value: `排第 ${i + 1} 位，等了 ${minutes(w.since)}` }))];
    // Its name and the name it is asked for by, where they differ.
    const name = device.name && device.name !== device.id ? `${device.name} · ${device.id}` : device.id;
    return { name: clip(name), values: values.length ? values.slice(0, VALUES) : [{ value: '空闲' }], buttons: [] };
  });
}
try { console.log(JSON.stringify([{ key: 'devices', spec: { type: 'devices', title: '测试机', resources: read() } }])); }
catch (error) { console.error(error.message.replace(/\S*devices\.json/g, 'devices.json').replace(/\s+/g, ' ')); process.exit(1); }
