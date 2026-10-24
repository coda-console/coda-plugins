// What the page and the command show of the log: the hangs of the last week, each with how it ended, newest first and at
// most HANGS of them; and each target's probes in buckets of ten minutes over the last week (`[start, probes, failed,
// slowest ms]`), with its latest result and its last failures.
export const BUCKET = 10 * 60_000, WEEK = 7 * 86_400_000, HANGS = 300, FAILURES = 20;

export class Summary {
  constructor() { this.hangs = new Map(); this.targets = new Map(); }
  // An event taken in; what changed of the summary (`{ collection, id }`), or null.
  add(event) {
    if (event.kind === 'hang') {
      this.hangs.set(event.id, { ...event, end: null });
      return { collection: 'hangs', id: event.id };
    }
    if (event.kind === 'hang-end') {
      const hang = this.hangs.get(event.id);
      if (!hang) return null;
      hang.end = { at: event.at, outcome: event.outcome };
      return { collection: 'hangs', id: event.id };
    }
    if (event.kind === 'probe') {
      let target = this.targets.get(event.target);
      if (!target) this.targets.set(event.target, target = { target: event.target, url: event.url, buckets: [], last: null, failures: [] });
      target.url = event.url;
      const start = Math.floor(event.at / BUCKET) * BUCKET;
      let bucket = target.buckets.at(-1);
      if (!bucket || bucket[0] !== start) target.buckets.push(bucket = [start, 0, 0, 0]);
      bucket[1]++;
      if (!event.ok) bucket[2]++;
      bucket[3] = Math.max(bucket[3], event.ms?.total ?? 0);
      target.last = probeLine(event);
      if (!event.ok) { target.failures.push(probeLine(event)); if (target.failures.length > FAILURES) target.failures.shift(); }
      return { collection: 'targets', id: event.target };
    }
    return null;
  }
  // What is older than a week let go, the hangs past HANGS too; what changed, as `add` says it (gone ones too).
  trim(now) {
    const changed = [];
    const hangs = [...this.hangs.values()].sort((a, b) => b.at - a.at);
    for (const [i, hang] of hangs.entries()) if (i >= HANGS || hang.at < now - WEEK) { this.hangs.delete(hang.id); changed.push({ collection: 'hangs', id: hang.id }); }
    for (const target of this.targets.values()) {
      const kept = target.buckets.filter(b => b[0] >= now - WEEK);
      if (kept.length !== target.buckets.length) { target.buckets = kept; changed.push({ collection: 'targets', id: target.target }); }
    }
    return changed;
  }
  get(collection, id) { return collection === 'hangs' ? this.hangs.get(id) : this.targets.get(id); }
  hangList() { return [...this.hangs.values()].sort((a, b) => b.at - a.at); }
}

// A probe as the summary keeps it: when, whether it reached, how far a failure got and why, and the phases' times.
export const probeLine = e => ({ at: e.at, ok: e.ok, ...(e.status ? { status: e.status } : {}), ...(e.ok ? {} : { phase: e.phase, error: e.error }),
  ms: e.ms, ...(e.address ? { address: e.address } : {}), ...(e.resolved ? { resolved: e.resolved } : {}), ...(e.iface ? { iface: e.iface, viaTun: e.viaTun ?? null } : {}) });

// The words for an outcome, a phase and an interface, shared by the page's and the command's text.
export const PHASES = { dns: '解析', connect: '建连', tls: 'TLS', response: '等回应' };
export const OUTCOMES = { connected: '连上了', gone: '放弃了' };
// How a hang ended in words; null while it has not.
export const endText = hang => !hang.end ? null : hang.end.outcome === 'unknown' ? '记录中断，结局未知'
  : `${seconds(hang.end.at - hang.at)}后${OUTCOMES[hang.end.outcome] ?? hang.end.outcome}`;
export const route = hang => hang.viaTun === true ? '经 mihomo' : hang.viaTun === false ? '没经过 mihomo' : null;
export const seconds = ms => ms >= 10_000 ? `${Math.round(ms / 1000)} 秒` : `${(ms / 1000).toFixed(1)} 秒`;
// A probe's phases each as long as it took: its times are kept as curl gives them, from the start (`dns`, `connect`, `tls`,
// `firstByte`), so a phase is what it adds to the one before it reached.
export function phaseDurations(ms = {}) {
  const out = [];
  let before = 0;
  for (const key of ['dns', 'connect', 'tls', 'firstByte']) if (ms[key] !== undefined) { out.push([key, ms[key] - before]); before = ms[key]; }
  return out;
}
