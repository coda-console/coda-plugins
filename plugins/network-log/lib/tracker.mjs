// Sockets seen connecting, one reading of the table after another. One still connecting `hangMs` after it was first seen
// is a hang, said once; it ends when the socket is connected or gone from the table (given up, or its process ended).
// First seen is when a reading first had it: the connection began at most one reading before.
import { randomUUID } from 'node:crypto';

const keyOf = s => `${s.pid ?? ''}|${s.local.ip}:${s.local.port}|${s.remote.ip}:${s.remote.port}`;

export class Tracker {
  constructor({ hangMs = 3000 } = {}) { this.hangMs = hangMs; this.seen = new Map(); }
  // One reading at `now`: those that began to hang, and of those hanging, the ones that ended and how.
  read(sockets, now) {
    const began = [], ended = [], current = new Map(sockets.map(s => [keyOf(s), s]));
    for (const [key, socket] of current) {
      if (socket.state !== 'connecting') continue;
      let entry = this.seen.get(key);
      if (!entry) this.seen.set(key, entry = { since: now, hung: null });
      if (!entry.hung && now - entry.since >= this.hangMs) {
        entry.hung = randomUUID();
        began.push({ id: entry.hung, since: entry.since, socket });
      }
    }
    for (const [key, entry] of this.seen) {
      const socket = current.get(key);
      if (socket?.state === 'connecting') continue;
      this.seen.delete(key);
      if (entry.hung) ended.push({ id: entry.hung, since: entry.since, at: now, outcome: socket?.state === 'connected' ? 'connected' : 'gone' });
    }
    return { began, ended };
  }
}
