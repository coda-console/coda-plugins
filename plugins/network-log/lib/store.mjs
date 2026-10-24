// The log: one JSON line an event, one file a day by this machine's date (`2026-10-25.jsonl`) in the plugin's state
// directory, the files of the last `days` days kept. A line that does not read is left out, the rest stand.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const pad = n => String(n).padStart(2, '0');
export const dayOf = at => { const d = new Date(at); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

export class Log {
  constructor(dir, { days = 30 } = {}) { this.dir = dir; this.days = days; }
  append(event) {
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(join(this.dir, `${dayOf(event.at)}.jsonl`), `${JSON.stringify(event)}\n`);
  }
  // The events from `from` to `to` (milliseconds), in the order they were written.
  read({ from = 0, to = Infinity } = {}) {
    if (!existsSync(this.dir)) return [];
    const first = dayOf(from), last = Number.isFinite(to) ? dayOf(to) : '9999-12-31';
    return readdirSync(this.dir).map(name => FILE.exec(name)?.[1]).filter(day => day && day >= first && day <= last).sort().flatMap(day =>
      readFileSync(join(this.dir, `${day}.jsonl`), 'utf8').split('\n').flatMap(line => {
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
