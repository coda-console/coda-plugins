// The one clock deadlines go off by (issue #720「可靠计时」): whatever is due at a time asks it, and it keeps a single
// timer, for the earliest. `now` is the backend's clock (tests move it), read again whenever the timer goes off; what is
// due by then is called, the rest waits on.
export class Clock {
  constructor(now = Date.now) { this.now = now; this.due = new Set(); this.timer = null; this.armed = null; }
  // Calls `fn` once `now()` has reached `time`; returns what cancels it.
  at(time, fn) {
    const entry = { time, fn };
    this.due.add(entry); this.arm();
    return () => { if (this.due.delete(entry)) this.arm(); };
  }
  // Calls `fn` once `ms` have passed on this clock; Infinity never comes. Returns what cancels it.
  after(ms, fn) { return Number.isFinite(ms) ? this.at(this.now() + ms, fn) : () => {}; }
  arm() {
    let next = null;
    for (const { time } of this.due) if (next === null || time < next) next = time;
    if (next === this.armed) return;
    clearTimeout(this.timer); this.armed = next;
    if (next === null) return;
    // A timer waits at most about 24 days; one due later is looked at again then.
    this.timer = setTimeout(() => this.fire(), Math.min(Math.max(0, next - this.now()) + 1, 2 ** 31 - 1));
    this.timer.unref?.();
  }
  // What is due by now goes off; then the next is asked of the timer. Also when the clock was moved (tests set `now`).
  fire() {
    this.armed = null;
    const now = this.now();
    for (const entry of [...this.due]) {
      if (entry.time > now || !this.due.delete(entry)) continue;
      try { entry.fn(); } catch (e) { console.error('到期处理失败', e); }
    }
    this.arm();
  }
  close() { clearTimeout(this.timer); this.due.clear(); this.armed = null; }
}

// A limit of `ms` from `started` that does not count while paused (the job's, while its script waits on an agent): `due()`
// is when it comes, null while paused; what was spent paused moves it on.
export class Limit {
  constructor(started, ms) { this.started = started; this.ms = ms; this.pausedAt = null; this.spent = 0; }
  // Told at `now` whether the time is paused; returns whether that changed anything.
  pause(paused, now) {
    if (paused === (this.pausedAt !== null)) return false;
    if (paused) this.pausedAt = now; else { this.spent += now - this.pausedAt; this.pausedAt = null; }
    return true;
  }
  due() { return this.pausedAt === null ? this.started + this.ms + this.spent : null; }
}
