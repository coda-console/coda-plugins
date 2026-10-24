// The 网络记录 plugin's probe against servers of the test's own: an answer reached with its phases timed, a port nothing
// listens on, a server that never answers, and a name the system's resolver looks up.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { probe } from '../../../plugins/network-log/lib/probe.mjs';

async function server(t, handle) {
  const made = createServer(handle);
  await new Promise(resolve => made.listen(0, '127.0.0.1', resolve));
  t.after(() => { made.closeAllConnections(); made.close(); });
  return made.address().port;
}

test('an answer is reached: its status, the phases up to its first byte, where it went and from where', async t => {
  const port = await server(t, (req, res) => { res.statusCode = 204; res.end(); });
  const result = await probe(`http://127.0.0.1:${port}/`);
  assert.equal(result.ok, true); assert.equal(result.status, 204);
  assert.equal(result.ms.dns, undefined, 'an address needs no lookup');
  assert.ok(result.ms.connect <= result.ms.firstByte && result.ms.firstByte <= result.ms.total);
  assert.equal(result.address, '127.0.0.1'); assert.equal(result.local, '127.0.0.1');
});

test('a port nothing listens on fails connecting, as the system says it', async t => {
  const port = await server(t, () => {});
  const free = await new Promise(resolve => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port: p } = s.address(); s.close(() => resolve(p)); }); });
  assert.notEqual(free, port);
  const result = await probe(`http://127.0.0.1:${free}/`);
  assert.deepEqual([result.ok, result.phase, result.error], [false, 'connect', 'ECONNREFUSED']);
});

test('a server that never answers fails waiting for the answer, once the time is up', async t => {
  const port = await server(t, () => {});
  const result = await probe(`http://127.0.0.1:${port}/`, { timeoutMs: 300 });
  assert.deepEqual([result.ok, result.phase, result.error], [false, 'response', 'TIMEOUT']);
  assert.ok(result.ms.total >= 300 && result.ms.connect !== undefined);
});

test('a name is looked up by the system first: the lookup timed, the address it gave kept', async t => {
  const port = await server(t, (req, res) => res.end('ok'));
  const result = await probe(`http://localhost:${port}/`);
  assert.equal(result.ok, true);
  assert.ok(result.ms.dns !== undefined && result.ms.dns <= result.ms.connect);
  assert.ok(['127.0.0.1', '::1'].includes(result.address));
});
