// The recorder: every second the machine's TCP table read for connections that hang, every minute each target probed,
// each finding written to the log and given to whoever listens (the open pages). Settings are read again every minute.
// Nothing is blocked or changed: the table is the system's, the probes are requests of their own.
import { Tracker } from './tracker.mjs';
import { commandOf, interfaceOf, settle, sockets } from './sockets.mjs';
import { connectionFrom, tunDevice } from './mihomo.mjs';
import { probe } from './probe.mjs';
import { dayOf } from './store.mjs';
import { Summary, WEEK } from './summary.mjs';

export const SAMPLE = 1000, PROBE = 60_000;
// At most this many hangs a minute are written; past it they are counted, and the count written as the next minute starts.
const HANGS_A_MINUTE = 30;

export class Recorder {
  // `settings()`: `{ targets: { <name>: <url> }, hangSeconds, mihomo, secret }` as they are now.
  constructor({ log, settings, now = Date.now, readSockets = sockets, settleSocket = settle, command = commandOf, request = probe,
    ifaceOf = ip => interfaceOf(ip), mihomo = { tunDevice, connectionFrom }, sampleMs = SAMPLE, probeMs = PROBE, listen = () => {} }) {
    Object.assign(this, { log, settings, now, readSockets, settleSocket, command, request, ifaceOf, mihomo, sampleMs, probeMs, listen });
    this.tracker = new Tracker(); this.summary = new Summary(); this.current = {}; this.tun = null; this.pruned = null; this.unwritten = [];
    // The hangs written that have not ended: their ends are written whatever the page's summary keeps.
    this.open = new Set();
    this.status = { supported: true, mihomo: 'off', tun: null, unwritten: null, since: now() };
    this.timers = new Set(); this.stopped = false; this.minute = { start: 0, written: 0, dropped: 0 };
  }
  async start() {
    this.prune();
    // A hang the last recorder had not seen end, any the log keeps: what became of it while nothing recorded is not known,
    // and said so. Then the page's week.
    const unended = new Map();
    for (const e of this.log.read({ kinds: ['hang', 'hang-end'] })) if (e.kind === 'hang') unended.set(e.id, e); else unended.delete(e.id);
    for (const event of this.log.read({ from: this.now() - WEEK })) this.summary.add(event);
    for (const hang of unended.values()) this.write({ kind: 'hang-end', id: hang.id, at: this.now(), outcome: 'unknown' });
    await this.refresh();
    this.loop(() => this.sample(), this.sampleMs);
    this.loop(() => this.probeAll(), this.probeMs);
  }
  stop() { this.stopped = true; for (const timer of this.timers) clearTimeout(timer); this.timers.clear(); }
  // `work` again `ms` after each run ends, so that a slow one never runs twice at once; one that answers false is not run again.
  loop(work, ms) {
    const next = () => {
      if (this.stopped) return;
      const timer = setTimeout(async () => {
        this.timers.delete(timer);
        let again = true;
        try { again = (await work()) !== false; } catch (e) { console.error('网络记录出错：', e?.message ?? e); }
        if (again) next();
      }, ms);
      timer.unref?.();
      this.timers.add(timer);
    };
    next();
  }
  // The settings, and mihomo's TUN as it is now: what went out of it went through mihomo.
  async refresh() {
    this.current = await this.settings();
    this.tracker.hangMs = Math.max(1, this.current.hangSeconds ?? 3) * 1000;
    let mihomo = 'off';
    this.tun = null;
    if (this.current.mihomo) {
      try { this.tun = await this.mihomo.tunDevice(this.current.mihomo, this.current.secret); mihomo = 'ok'; } catch (e) { mihomo = e?.message ?? String(e); }
    }
    this.setStatus({ mihomo, tun: this.tun });
  }
  setStatus(changes) {
    const next = { ...this.status, ...changes };
    if (JSON.stringify(next) === JSON.stringify(this.status)) return;
    this.status = next;
    this.listen({ collection: 'status', id: 'recorder', object: this.status });
  }
  // An event written to the log, then shown. One the log does not take (the disk full) waits, those after it behind it in
  // turn, and is written as the log takes them again (`flush`, every reading); meanwhile the status says why.
  write(event) {
    this.unwritten.push(event);
    this.flush();
    const changed = this.summary.add(event);
    if (changed) this.listen({ ...changed, object: this.summary.get(changed.collection, changed.id) });
  }
  flush() {
    while (this.unwritten.length) {
      try { this.log.append(this.unwritten[0]); } catch (e) {
        this.setStatus({ unwritten: { count: this.unwritten.length, error: e?.code ?? e?.message ?? String(e) } });
        return;
      }
      this.unwritten.shift();
    }
    this.setStatus({ unwritten: null });
  }
  // The files past the days kept removed, once a day.
  prune() {
    const today = dayOf(this.now());
    if (this.pruned === today) return;
    this.pruned = today;
    this.log.prune(this.now());
  }
  viaTun(iface) { return this.tun ? iface === this.tun : null; }

  // One reading of the table; on a system without one we read, said once and not read again.
  async sample() {
    const list = await this.readSockets();
    if (!list) { this.setStatus({ supported: false }); return false; }
    if (this.unwritten.length) this.flush();
    const now = this.now(), { began, ended } = this.tracker.read(list, now);
    // The minute past settled first: what it did not write is counted in the log whether or not more hang now.
    if (now - this.minute.start >= 60_000) {
      if (this.minute.dropped) this.write({ kind: 'dropped', at: now, count: this.minute.dropped });
      this.minute = { start: now, written: 0, dropped: 0 };
    }
    for (const hang of began) {
      if (this.minute.written >= HANGS_A_MINUTE) { this.minute.dropped++; continue; }
      this.minute.written++;
      this.open.add(hang.id);
      this.write(await this.describe(hang, now));
    }
    for (const end of ended) if (this.open.delete(end.id)) this.write({ kind: 'hang-end', id: end.id, at: end.at, outcome: end.outcome });
  }
  // A hang as it is written: its process and what it was started with, both ends whole and the interface it goes out of,
  // whether that is mihomo's TUN, and whether mihomo took it.
  async describe({ id, since, socket }, now) {
    const settled = await this.settleSocket(socket);
    const event = { kind: 'hang', id, at: since, seen: now, process: settled.process, pid: settled.pid, command: await this.command(settled.pid),
      local: `${settled.local.ip}:${settled.local.port}`, remote: `${settled.remote.ip}:${settled.remote.port}`, iface: settled.iface ?? null,
      viaTun: this.viaTun(settled.iface ?? null) };
    if (this.current.mihomo) {
      try { event.mihomo = await this.mihomo.connectionFrom(this.current.mihomo, this.current.secret, settled.local.port); }
      catch (e) { event.mihomo = { error: e?.message ?? String(e) }; }
    }
    return event;
  }

  async probeAll() {
    await this.refresh();
    this.prune();
    const now = this.now();
    for (const change of this.summary.trim(now)) this.listen({ ...change, object: this.summary.get(change.collection, change.id) ?? null });
    await Promise.all(Object.entries(this.current.targets ?? {}).map(async ([target, url]) => {
      let result;
      try { result = await this.request(url); } catch (e) { result = { ok: false, phase: 'dns', error: e?.code ?? e?.message ?? String(e), ms: { total: 0 } }; }
      const iface = result.local ? this.ifaceOf(result.local) : null;
      this.write({ kind: 'probe', at: now, target, url, ...result, ...(iface ? { iface, viaTun: this.viaTun(iface) } : {}) });
    }));
  }
}
