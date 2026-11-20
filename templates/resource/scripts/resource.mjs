#!/usr/bin/env node
// 「运行时间」资源类型的记录命令（`coda/resource@1` 的记录，清单的 contributes.records）：Coda 在启动、更新、设置改动、
// 动作之后与资源页打开、点「刷新」时运行它（清单里写 `every` 才另按周期运行）。标准输出是这个插件在这台机器上这一类的
// 整组记录：`[{ key, spec }]`，key 是类型 ID，spec.type 与它相同。`node` 是 Coda 后端自己的 Node；只用 Node 自带的模块。
// 读不懂的键会让这次写入失败；记录里没有说明性的字段，每个资源只有名字、读数、一行错误和按钮。
// 命令失败（退出 1，标准错误的最后一行写原因）就保留 Coda 已有的记录，不写空的。
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
// 按钮动作（scripts/act.mjs）记下的时刻，存在插件的状态目录里（CODA_PLUGIN_STATE，跨读取、跨版本保留）。
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
// 按钮调 `act` 操作（scripts/act.mjs）做 `mark`；confirm 是执行前问的话。
const buttons = [{ label: '记下此刻', action: 'mark', confirm: '记下此刻？\n之后显示距这次记下过了多久。' }];
process.stdout.write(JSON.stringify([{ key: 'uptime', spec: { type: 'uptime', title: '运行时间', resources: [{ values, buttons }] } }]));
