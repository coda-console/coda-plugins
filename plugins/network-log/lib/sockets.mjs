// The TCP sockets of this machine as the system's own table lists them, for every process and without privilege: macOS
// `netstat -anv`, Linux `ss -tanp`. Each with its state, both ends and its process. macOS cuts a long IPv6 address short in
// that table, so a socket found waiting is looked up again with `nettop`, which gives it whole and names its interface.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';

const run = (file, args, timeout = 5000) => new Promise((resolve, reject) =>
  execFile(file, args, { timeout, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(String(stdout))));
const SS = ['/usr/bin/ss', '/bin/ss', '/usr/sbin/ss', '/sbin/ss'].find(path => existsSync(path)) ?? 'ss';

// What a state is to the recorder: still connecting (the SYN sent, no answer), connected, or anything else.
const STATES = { SYN_SENT: 'connecting', 'SYN-SENT': 'connecting', ESTABLISHED: 'connected', ESTAB: 'connected' };
const state = name => STATES[name] ?? 'other';

// An end as macOS's tables write it: the port after the last dot (`192.168.31.120.57456`, `fd44::2.50916`); nettop writes
// IPv4 with a colon (`198.18.0.1:49791`).
export function darwinEnd(text) {
  const colon = /^(\d+\.\d+\.\d+\.\d+):(\d+)$/.exec(text);
  if (colon) return { ip: colon[1], port: Number(colon[2]) };
  const i = text.lastIndexOf('.');
  return { ip: text.slice(0, i), port: Number(text.slice(i + 1)) };
}
// An end as ss writes it: `192.168.1.6:58716`, `[2408:8207::1]:443`, `[fe80::1%enp14s0]:22`.
export function linuxEnd(text) {
  const m = /^\[?(.*?)\]?:(\d+|\*)$/.exec(text);
  return m ? { ip: m[1].replace(/%.*$/, ''), port: Number(m[2]) || 0 } : { ip: text, port: 0 };
}

// netstat -anv rows: proto, the two queues, local, foreign, state, four counters, `process:pid` (a name of at most 16
// characters, spaces and all), then hexadecimal fields. Listening sockets and those of no process are left out.
const NETSTAT = /^tcp\S*\s+\d+\s+\d+\s+(\S+)\s+(\S+)\s+([A-Z_]+)\s+\d+\s+\d+\s+\d+\s+\d+\s+(.*?):(\d+)\s+[0-9a-f]+\s/;
export function parseNetstat(text) {
  return text.split('\n').flatMap(line => {
    const m = NETSTAT.exec(line.trim());
    if (!m || m[2] === '*.*') return [];
    return [{ state: state(m[3]), local: darwinEnd(m[1]), remote: darwinEnd(m[2]), process: m[4].trim(), pid: Number(m[5]) }];
  });
}
// ss -Htanp rows: state, the two queues, local, peer, and for a process of this user `users:(("name",pid=…,fd=…))`.
const SS_ROW = /^(\S+)\s+\d+\s+\d+\s+(\S+)\s+(\S+)(?:\s+users:\(\("((?:[^"\\]|\\.)*)",pid=(\d+))?/;
export function parseSs(text) {
  return text.split('\n').flatMap(line => {
    const m = SS_ROW.exec(line.trim());
    if (!m || m[1] === 'LISTEN') return [];
    return [{ state: state(m[1]), local: linuxEnd(m[2]), remote: linuxEnd(m[3]), process: m[4] ?? null, pid: m[5] ? Number(m[5]) : null }];
  });
}
// nettop -L 1 -x rows of one process's flows: `time,tcp4 <local><-><remote>,<interface>,<state>,…`.
export function parseNettop(text) {
  return text.split('\n').flatMap(line => {
    const [, flow, iface, flowState] = line.split(',');
    const m = /^tcp[46] (\S+)<->(\S+)$/.exec(flow ?? '');
    if (!m || m[2] === '*.*') return [];
    return [{ local: darwinEnd(m[1]), remote: darwinEnd(m[2]), iface: iface || null, state: flowState ?? '' }];
  });
}

// This machine's TCP sockets now; null where the system has no table we read.
export async function sockets(platform = process.platform) {
  if (platform === 'darwin') return parseNetstat(await run('/usr/sbin/netstat', ['-anv', '-p', 'tcp']));
  if (platform === 'linux') return parseSs(await run(SS, ['-Htanp']));
  return null;
}

// A waiting socket as it is: on macOS its process's flows read again with nettop, the one with its local port taken whole
// with its interface; elsewhere (and when nettop says nothing of it) the interface whose address the local end has.
export async function settle(socket, platform = process.platform, interfaces = networkInterfaces()) {
  if (platform === 'darwin' && socket.pid) {
    try {
      const flows = parseNettop(await run('/usr/bin/nettop', ['-L', '1', '-m', 'tcp', '-n', '-x', '-p', String(socket.pid)], 10_000));
      const flow = flows.find(f => f.local.port === socket.local.port && f.remote.port === socket.remote.port);
      if (flow) return { ...socket, local: flow.local, remote: flow.remote, iface: flow.iface };
    } catch {}
  }
  return { ...socket, iface: interfaceOf(socket.local.ip, interfaces) };
}
// The interface an address is on; a cut-short IPv6 address (macOS's table) by the start it keeps.
export function interfaceOf(ip, interfaces = networkInterfaces()) {
  const all = Object.entries(interfaces).flatMap(([name, list]) => (list ?? []).map(each => ({ name, address: each.address.replace(/%.*$/, '') })));
  return (all.find(each => each.address === ip) ?? (ip.includes(':') && ip.length > 2 ? all.find(each => each.address.startsWith(ip)) : null))?.name ?? null;
}

// The command line a process was started with, cut to a line: what it was doing (`git-remote-https https://github.com/…`).
export async function commandOf(pid) {
  if (!pid) return null;
  try { return (await run('/bin/ps', ['-o', 'command=', '-p', String(pid)], 3000)).trim().replace(/\s+/g, ' ').slice(0, 400) || null; } catch { return null; }
}
