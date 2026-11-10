import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

export function mailbox() {
  const values = [], readers = [];
  return { push: value => readers.length ? readers.shift()(value) : values.push(value), next: () => values.length ? Promise.resolve(values.shift()) : new Promise(resolve => readers.push(resolve)) };
}
export async function http(t, handler) {
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const text = Buffer.concat(chunks).toString();
      await handler(request, response, text ? JSON.parse(text) : undefined);
    } catch (error) { response.writeHead(500); response.end(JSON.stringify({ error: { message: error.message } })); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}
export function temporary(t) {
  const root = mkdtempSync(join(tmpdir(), 'grok-bot-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
export function fakeClock() {
  const timers = new Map(), listeners = [];
  let now = Date.now();
  return { now: () => now, untilTimer(ms) {
    if ([...timers.values()].some(t => t.ms === ms)) return Promise.resolve();
    return new Promise(resolve => listeners.push({ ms, resolve }));
  }, setTimeout(fn, ms) { const id = Symbol(); timers.set(id, { fn, ms, at: now + ms });
      for (const listener of listeners.splice(0)) if (listener.ms === ms) listener.resolve(); else listeners.push(listener);
      return id; }, clearTimeout(id) { timers.delete(id); },
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now && timers.delete(id)) timer.fn();
    },
    expire() { for (const [id, timer] of [...timers]) if (timers.delete(id)) timer.fn(); }, get size() { return timers.size; } };
}
