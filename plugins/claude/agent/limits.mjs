import { createHash } from 'node:crypto';
import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';

// The quota of the account Claude sessions run as, read from what the sessions themselves report. A setup token has no
// profile scope, so /usage cannot be asked with it; but the CLI sends a `rate_limit_event` whenever a window's rounded
// percentage or reset time moves, with the fraction of the window used and when it resets (SDKRateLimitInfo). Each
// session's entry (session.mjs) writes it to `limits.json` in this plugin's state; the「Claude」panel reads it
// (scripts/panel.mjs, docs/plugins.md「内置插件：Claude」).
// `unifiedWindows`, an internal field of newer CLIs, carries every window each time; the top-level fields, which every
// CLI sends, only the one that limits now.
const labels = { five_hour: '5 小时', seven_day: '7 天', seven_day_opus: 'Opus · 7 天', seven_day_sonnet: 'Sonnet · 7 天', seven_day_overage_included: 'Fable · 7 天' };
const used = fraction => Math.round(fraction * 100);

function reported(info) {
  const windows = info?.unifiedWindows && typeof info.unifiedWindows === 'object' ? { ...info.unifiedWindows } : {};
  if (info?.rateLimitType && !windows[info.rateLimitType]) windows[info.rateLimitType] = info;
  return Object.entries(windows);
}

// The latest each window was reported at, kept across restarts: events come only as a window moves, so a backend that
// started just now would otherwise show nothing until one does. A window past its reset is no longer known, not full:
// what was used since is not seen from here.
// The account they run as is kept beside them, as a hash of its email (`account`): what Coda's group view compares across
// machines, the email itself staying here. A session reports it as it starts (session.mjs); none where Claude runs on an
// API key or a cloud provider, or the login does not say.
export const accountHash = email => createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 32);
export class ClaudeSessionLimits {
  constructor({ path = null, now = Date.now } = {}) {
    this.path = path; this.now = now; this.windows = new Map(); this.account = null; this.stamp = null;
    this.read();
  }
  read() {
    if (!this.path) return;
    let stamp;
    try { stamp = statSync(this.path).mtimeMs; } catch { return; }
    if (stamp === this.stamp) return;
    this.stamp = stamp; this.windows = new Map(); this.account = null;
    try {
      const saved = JSON.parse(readFileSync(this.path, 'utf8'));
      for (const [key, w] of Object.entries(saved.windows)) this.take(key, w?.utilization, w?.resetsAt);
      if (typeof saved.account === 'string' && /^[0-9a-f]{32}$/.test(saved.account)) this.account = saved.account;
    }
    catch { /* Not readable now: read again when it next changes. */ this.stamp = null; }
  }
  known() { this.read(); return this.windows.size > 0; }
  take(key, utilization, resetsAt) {
    if (!Object.hasOwn(labels, key) || !(Number.isFinite(utilization) && utilization >= 0) || !(Number.isSafeInteger(resetsAt) && resetsAt > 0)) return false;
    const was = this.windows.get(key);
    if (was?.resetsAt === resetsAt && used(was.utilization) === used(utilization)) return false;
    this.windows.set(key, { utilization, resetsAt });
    return true;
  }
  // The account a session started as: kept when it is another one than before, which starts its windows afresh.
  noteAccount(email) {
    if (typeof email !== 'string' || !email.trim()) return;
    const account = accountHash(email);
    if (account === this.account) return;
    // Another account's windows say nothing of this one.
    if (this.account) this.windows = new Map();
    this.account = account;
    this.save();
  }
  observe(info) {
    let changed = false;
    for (const [key, w] of reported(info)) changed = this.take(key, w?.utilization, w?.resetsAt) || changed;
    if (changed) this.save();
  }
  save() {
    if (!this.path) return;
    try {
      // Every Claude session writes it: a temporary file of each writer's own.
      const temp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify({ version: 1, windows: Object.fromEntries(this.windows), ...(this.account ? { account: this.account } : {}) }), { mode: 0o600 });
      renameSync(temp, this.path);
    } catch { /* Not written: the next window that moves writes again. */ }
  }
  // The windows still to reset, in a fixed order: what is left of each and when it resets. None when all have passed.
  quota() {
    this.read();
    const now = this.now();
    return Object.keys(labels).flatMap(key => {
      const w = this.windows.get(key);
      return w && w.resetsAt * 1000 > now ? [{ id: key, label: labels[key], remainingPercent: Math.max(0, 100 - used(w.utilization)),
        resetsAt: new Date(w.resetsAt * 1000).toISOString() }] : [];
    });
  }
}
