// One request to a target, timed by phase as git and curl go: the system's resolver, a TCP connection of its own, TLS,
// then the first byte of the answer. Any answer is reached (its status kept); a failure says in which phase it came and
// what the system said (ENOTFOUND, ECONNRESET, a timeout …). Where it went out of: the local address, for its interface.
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { performance } from 'node:perf_hooks';

export function probe(url, { timeoutMs = 15_000 } = {}) {
  return new Promise(resolve => {
    const target = new URL(url), secure = target.protocol === 'https:';
    const start = performance.now(), ms = {}, took = () => Math.round(performance.now() - start);
    let phase = isIP(target.hostname.replace(/^\[|\]$/g, '')) ? 'connect' : 'dns', address = null, local = null, done = false;
    const finish = result => {
      if (done) return;
      done = true; clearTimeout(timer); request.destroy();
      ms.total = took();
      resolve({ ...result, ms, ...(address ? { address } : {}), ...(local ? { local } : {}) });
    };
    const request = (secure ? https : http).request(target, { method: 'GET', agent: false, headers: { 'user-agent': 'coda-network-log' } }, response => {
      ms.firstByte = took();
      finish({ ok: true, status: response.statusCode });
    });
    request.on('socket', socket => {
      socket.once('lookup', (error, found) => { ms.dns = took(); if (!error) { address = found; phase = 'connect'; } });
      socket.once('connect', () => { ms.connect = took(); local = socket.localAddress ?? null; address ??= socket.remoteAddress ?? null; phase = secure ? 'tls' : 'response'; });
      socket.once('secureConnect', () => { ms.tls = took(); phase = 'response'; });
    });
    request.on('error', error => finish({ ok: false, phase, error: error.code ?? error.message }));
    const timer = setTimeout(() => finish({ ok: false, phase, error: 'TIMEOUT' }), timeoutMs);
    request.end();
  });
}
