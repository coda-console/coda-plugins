import { createHash } from 'node:crypto';

// What the tests' own stand-in hosts of records (git's, grok-bot's) share: the host's ID of a record and the key it takes. A
// plugin's tests of concurrency groups use the plugin test host of check/coda instead (adapters/plugin-test-host.mjs).
// The host's ID of a record: a UUID from the backend, the plugin, the kind and the key, the same each time.
export function recordId(plugin, kind, key) {
  const b = createHash('sha256').update(JSON.stringify(['backend:test', plugin, kind, key])).digest().subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50; b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export const validKey = key => typeof key === 'string' && key.length > 0 && key.length <= 256;
