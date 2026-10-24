// One request to a target, timed by phase as git and curl go: the system's resolver, a TCP connection of its own, TLS,
// then the first byte of the answer. Any answer is reached (its status kept); a failure says in which phase it came and
// what the system said (ENOTFOUND, ECONNRESET, a timeout …). Where it went: the address it connected to (`address`) — of
// several a name has, the one that took the connection — else the one the lookup gave first (`resolved`); and the local
// address it went out of, for its interface. The lookup is timed by wrapping it: a socket trying several addresses says
// nothing of it. `lookup` stands in for the system's resolver (tests).
import { lookup as systemLookup } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { performance } from 'node:perf_hooks';

export function probe(url, { timeoutMs = 15_000, lookup = systemLookup } = {}) {
  return new Promise(resolve => {
    const target = new URL(url), secure = target.protocol === 'https:';
    const start = performance.now(), ms = {}, took = () => Math.round(performance.now() - start);
    let phase = isIP(target.hostname.replace(/^\[|\]$/g, '')) ? 'connect' : 'dns', resolved = null, address = null, local = null, done = false;
    const finish = result => {
      if (done) return;
      done = true; clearTimeout(timer); request.destroy();
      ms.total = took();
      resolve({ ...result, ms, ...(address ? { address } : {}), ...(resolved && resolved !== address ? { resolved } : {}), ...(local ? { local } : {}) });
    };
    const timed = (hostname, options, callback) => lookup(hostname, options, (error, found, family) => {
      ms.dns = took();
      if (!error) { resolved = Array.isArray(found) ? found[0]?.address ?? null : found; phase = 'connect'; }
      callback(error, found, family);
    });
    const request = (secure ? https : http).request(target, { method: 'GET', agent: false, headers: { 'user-agent': 'coda-network-log' }, lookup: timed }, response => {
      ms.firstByte = took();
      finish({ ok: true, status: response.statusCode });
    });
    request.on('socket', socket => {
      socket.once('connect', () => { ms.connect = took(); local = socket.localAddress ?? null; address = socket.remoteAddress ?? null; phase = secure ? 'tls' : 'response'; });
      socket.once('secureConnect', () => { ms.tls = took(); phase = 'response'; });
    });
    request.on('error', error => finish({ ok: false, phase, error: error.code ?? error.message }));
    const timer = setTimeout(() => finish({ ok: false, phase, error: 'TIMEOUT' }), timeoutMs);
    request.end();
  });
}
