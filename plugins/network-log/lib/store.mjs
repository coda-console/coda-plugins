// The log: one JSON line an event, one file a day by this machine's date (`2026-10-25.jsonl`) in the plugin's state
// directory, the files of the last `days` days kept. A line that does not read is left out, the rest stand. A write that
// failed partway (the disk full, the process ended) leaves part of a line: before a file is first written to here, and
// after a write to it failed, it is cut back to its last whole line, so that the next line starts on a line of its own.
// `appendFile` stands in for the system's (tests).
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, truncateSync } from 'node:fs';
import { join } from 'node:path';

const pad = n => String(n).padStart(2, '0');
export const dayOf = at => { const d = new Date(at); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

export class Log {
  constructor(dir, { days = 30, appendFile = appendFileSync } = {}) { this.dir = dir; this.days = days; this.appendFile = appendFile; this.whole = new Set(); }
  append(event) {
    mkdirSync(this.dir, { recursive: true });
    const file = join(this.dir, `${dayOf(event.at)}.jsonl`);
    if (!this.whole.has(file)) { endAtLine(file); this.whole.add(file); }
    try { this.appendFile(file, `${JSON.stringify(event)}\n`); } catch (e) { this.whole.delete(file); throw e; }
  }
  // The events from `from` to `to` (milliseconds), in the order they were written; with `kinds`, only those, the lines of
  // others not read (each line starts with its kind).
  read({ from = 0, to = Infinity, kinds = null } = {}) {
    if (!existsSync(this.dir)) return [];
    const first = dayOf(from), last = Number.isFinite(to) ? dayOf(to) : '9999-12-31';
    return readdirSync(this.dir).map(name => FILE.exec(name)?.[1]).filter(day => day && day >= first && day <= last).sort().flatMap(day =>
      readFileSync(join(this.dir, `${day}.jsonl`), 'utf8').split('\n').flatMap(line => {
        if (kinds && !kinds.some(kind => line.startsWith(`{"kind":"${kind}"`))) return [];
        try { const event = JSON.parse(line); return event.at >= from && event.at <= to ? [event] : []; } catch { return []; }
      }));
  }
  // The files of days before the last `days` removed.
  prune(now = Date.now()) {
    if (!existsSync(this.dir)) return;
    const oldest = dayOf(now - (this.days - 1) * 86_400_000);
    for (const name of readdirSync(this.dir)) {
      const day = FILE.exec(name)?.[1];
      if (day && day < oldest) rmSync(join(this.dir, name), { force: true });
    }
  }
}

// A file cut back to its last whole line, if it ends partway through one.
function endAtLine(file) {
  let bytes;
  try { bytes = readFileSync(file); } catch { return; }
  if (bytes.length && bytes[bytes.length - 1] !== 0x0a) truncateSync(file, bytes.lastIndexOf(0x0a) + 1);
}
