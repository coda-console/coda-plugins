// `network-log`: what this machine's 网络记录 wrote over a while, for an agent (or anyone in a session) looking into a
// network problem: the connections that hung, and the probes that failed. Read from the plugin's log, nothing asked anew.
import { hostname } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Log } from '../lib/store.mjs';
import { PHASES, Summary, endText, phaseDurations, route, seconds } from '../lib/summary.mjs';

const HELP = `用法：network-log [时间段] [内容] [--json]
  时间段：--since <时长>，如 30m、2h、3d（默认 24h）；或 --from <时刻> [--to <时刻>]，如 2026-10-24T02:00（本机时区）
  内容：默认建连卡住与探测失败；--hangs 只看建连卡住；--probes 列出每次探测（含成功的）
  --json：每个记录一行 JSON，原样输出
记录：每秒看一次本机连接表，建连超过设置的秒数（默认 3 秒）的连接记一条；每分钟探测设置里的地址。保留 30 天。`;

export function parseArgs(args, now = Date.now()) {
  const options = { from: now - 86_400_000, to: now, only: null, json: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i], value = () => { if (i + 1 >= args.length) throw new Error(`${arg} 后面要跟一个值`); return args[++i]; };
    if (arg === '--help' || arg === '-h') return { help: true };
    else if (arg === '--since') options.from = now - duration(value());
    else if (arg === '--from') options.from = moment(value());
    else if (arg === '--to') options.to = moment(value());
    else if (arg === '--hangs' || arg === '--probes') options.only = arg.slice(2);
    else if (arg === '--json') options.json = true;
    else throw new Error(`不认识 ${arg}（network-log --help 看用法）`);
  }
  if (!(options.from <= options.to)) throw new Error('时间段的开始晚于结束');
  return options;
}
function duration(text) {
  const m = /^(\d+(?:\.\d+)?)(m|h|d)$/.exec(text);
  if (!m) throw new Error(`时长写成 30m、2h 或 3d：${text}`);
  return Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]];
}
function moment(text) {
  const at = Date.parse(text);
  if (Number.isNaN(at)) throw new Error(`读不懂时刻 ${text}：写成 2026-10-24T02:00`);
  return at;
}

const pad = n => String(n).padStart(2, '0');
const when = at => { const d = new Date(at); return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const ms = n => n >= 1000 ? seconds(n) : `${n} ms`;

// One hang in words: when, who, to where; how it went out and whether mihomo took it; how it ended; what was running.
export function hangText(hang, now) {
  const how = [hang.iface ? `网卡 ${hang.iface}${route(hang) ? `，${route(hang)}` : ''}` : '网卡不明'];
  if (hang.mihomo?.taken) how.push(`mihomo 收到了，去 ${hang.mihomo.to}${hang.mihomo.chains?.length ? `，经 ${[...hang.mihomo.chains].reverse().join(' → ')}` : ''}`);
  else if (hang.mihomo?.taken === false) how.push('mihomo 没收到这条连接');
  else if (hang.mihomo?.error) how.push(`问不到 mihomo：${hang.mihomo.error}`);
  how.push(endText(hang) ?? `记到 ${when(now)} 还在等（${seconds(now - hang.at)}）`);
  return [`  ${when(hang.at)}  ${hang.process ?? '进程不明'}${hang.pid ? `（pid ${hang.pid}）` : ''} → ${hang.remote}`, `    ${how.join('；')}`,
    ...(hang.command ? [`    ${hang.command}`] : [])].join('\n');
}
// One probe in words: when, how it went, its phases' times.
export function probeText(probe) {
  const phases = phaseDurations(probe.ms).map(([key, took]) => `${{ dns: '解析', connect: '建连', tls: 'TLS', firstByte: '首字节' }[key]} ${ms(took)}`);
  const outcome = probe.ok ? `通（${probe.status}）` : `${PHASES[probe.phase] ?? probe.phase}阶段失败：${probe.error}`;
  const where = probe.iface ? `，网卡 ${probe.iface}${route(probe) ? `，${route(probe)}` : ''}` : '';
  const to = probe.address ? `，${probe.address}${probe.resolved ? `（解析到 ${probe.resolved}）` : ''}` : probe.resolved ? `，解析到 ${probe.resolved}` : '';
  return `    ${when(probe.at)}  ${outcome}，共 ${ms(probe.ms?.total ?? 0)}${phases.length ? `（${phases.join('，')}）` : ''}${to}${where}`;
}

export function report(events, options, { now = Date.now(), machine = hostname() } = {}) {
  if (options.json) return events.map(e => JSON.stringify(e)).join('\n');
  const summary = new Summary();
  for (const event of events) summary.add(event);
  const lines = [`网络记录 · ${machine} · ${when(options.from)} 至 ${when(options.to)}`];
  if (options.only !== 'probes') {
    const hangs = summary.hangList().reverse(), dropped = events.filter(e => e.kind === 'dropped').reduce((n, e) => n + e.count, 0);
    lines.push('', hangs.length ? `建连卡住 ${hangs.length} 次${dropped ? `（另有 ${dropped} 次超过每分钟上限没记）` : ''}` : '建连卡住：没有');
    for (const hang of hangs) lines.push(hangText(hang, now));
  }
  if (options.only !== 'hangs') {
    const probes = events.filter(e => e.kind === 'probe'), targets = [...new Set(probes.map(p => p.target))];
    lines.push('', targets.length ? '定时探测' : '定时探测：这段时间没有记录');
    for (const target of targets) {
      const mine = probes.filter(p => p.target === target), failed = mine.filter(p => !p.ok);
      const slowest = Math.max(...mine.map(p => p.ms?.total ?? 0));
      lines.push(`  ${target}（${mine[0].url}）：${mine.length} 次，${failed.length ? `失败 ${failed.length} 次` : '都通'}，最慢 ${ms(slowest)}`);
      for (const probe of options.only === 'probes' ? mine : failed) lines.push(probeText(probe));
    }
  }
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) { console.log(HELP); process.exit(0); }
    if (!process.env.CODA_PLUGIN_STATE) throw new Error('没有 CODA_PLUGIN_STATE：这个命令由 Coda 的网络记录插件提供，在 Coda 的会话里运行');
    // How a hang of the while ended may be written after it: the ends read on to now.
    const events = new Log(join(process.env.CODA_PLUGIN_STATE, 'log')).read({ from: options.from })
      .filter(e => e.kind === 'hang-end' || e.at <= options.to);
    console.log(report(events, options));
  } catch (e) {
    console.error(`network-log：${e.message}`);
    process.exit(2);
  }
}
