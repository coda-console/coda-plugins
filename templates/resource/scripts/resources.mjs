// 「运行时间」资源类型的取数命令：Coda 在打开资源页或点「刷新」时用 `sh -c` 运行它，标准输出就是资源的 JSON
// （docs/plugins.md「资源」）。`node` 是 Coda 后端自己的 Node；只用 Node 自带的模块。
// 读不懂的键会让这次读取失败；格式里没有说明性的字段，每个资源只有名字、读数、一行错误和按钮。
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { cpus, loadavg, uptime } from 'node:os';
import { join } from 'node:path';

// `uptime` 的负载在 macOS 写作「load averages: 1.2 1.3 1.4」，在 Linux 写作「load average: 1.2, 1.3, 1.4」；读不到就用 Node 的。
function loads() {
  try {
    const line = execFileSync('uptime', { encoding: 'utf8', timeout: 5000 });
    const found = /load averages?:\s*([\d.]+),?\s+([\d.]+),?\s+([\d.]+)/.exec(line);
    if (found) return found.slice(1, 4).map(Number);
  } catch {}
  return loadavg();
}
const since = seconds => {
  const days = Math.floor(seconds / 86400), hours = Math.floor(seconds % 86400 / 3600), minutes = Math.floor(seconds % 3600 / 60);
  return days ? `${days} 天 ${hours} 小时` : hours ? `${hours} 小时 ${minutes} 分钟` : `${minutes} 分钟`;
};
// 按钮动作记下的时刻，存在插件的状态目录里（CODA_PLUGIN_STATE，跨读取、跨版本保留）。
function marked() {
  try { return JSON.parse(readFileSync(join(process.env.CODA_PLUGIN_STATE, 'mark.json'), 'utf8')).at; } catch { return null; }
}

const [one] = loads(), cores = cpus().length, up = uptime(), mark = marked();
// 这台机器的东西只有一个资源，不写名字，也不写身份（identity 留给账号这类在几台机器上是同一个的）。
// 条一律画「还剩多少」：这里是 CPU 按 1 分钟负载算的余量；不知道比例时不写 fraction。读数带的时刻（time）写在数值后面。
const values = [
  { label: 'CPU 余量', value: `${one.toFixed(2)} / ${cores} 核`, fraction: Math.round(Math.max(0, Math.min(1, 1 - one / cores)) * 1000) / 1000 },
  { label: '已开机', value: since(up), time: new Date(Date.now() - up * 1000).toISOString() },
  ...(mark ? [{ label: '距上次记下', value: since((Date.now() - Date.parse(mark)) / 1000) }] : []),
];
process.stdout.write(JSON.stringify({ resources: [{ values, actions: [{ label: '记下此刻', action: 'mark' }] }] }));
