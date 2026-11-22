import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { checkServiceId } from '../domain/plugin-services.mjs';
import { ContractError, statusOf } from '../domain/errors.mjs';
import { ANSWERED, bodyOf, firstBytes, openHttp, pickHeaders, REQUEST_HEADERS, RESPONSE_HEADERS } from './http-stream.mjs';
import { abortError, failed, failureOf } from './provider-api.mjs';

const packed = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const unpacked = header => JSON.parse(Buffer.from(header ?? '', 'base64url').toString());

// An exchange with a handler of a module's, as a web `Request` (its `url` from `at` and what it was asked) and its `ctx`
// give it, and the `Response` it gives written as it comes. It says that the answer is the handler's own (`ANSWERED`), which
// no header of the handler's does. Thrown before the first byte, from the handler or the body it gave, the failure is the
// answer instead, not marked; after it, the connection is broken off. `ctx.signal` goes off as the caller leaves before the
// answer is done.
async function answer(req, res, at, handler) {
  const gone = new AbortController();
  res.once('close', () => { if (!res.writableFinished) gone.abort(abortError()); });
  try {
    const context = { ...(req.headers['x-coda-record'] ? unpacked(req.headers['x-coda-record']) : {}), caller: unpacked(req.headers['x-coda-caller']), signal: gone.signal };
    const body = ['GET', 'HEAD'].includes(req.method) ? null : bodyOf(req);
    const request = new Request(`http://${at}${req.url}`, { method: req.method, headers: pickHeaders(req.headers, REQUEST_HEADERS), signal: gone.signal,
      ...(body ? { body, duplex: 'half' } : {}) });
    const response = await handler(request, context);
    if (!(response instanceof Response)) throw new TypeError('处理函数须返回 Response');
    const reader = response.body?.getReader();
    const left = () => { reader?.cancel(gone.signal.reason).catch(() => {}); };
    if (gone.signal.aborted) left(); else gone.signal.addEventListener('abort', left, { once: true });
    const first = await firstBytes(reader);
    if (gone.signal.aborted) return;
    res.writeHead(response.status, { ...pickHeaders(Object.fromEntries(response.headers), RESPONSE_HEADERS), [ANSWERED]: 'answered' });
    if (first.done) return void res.end();
    res.write(first.value);
    reader.releaseLock();
    await pipeline(Readable.fromWeb(response.body), res);
  } catch (error) {
    if (gone.signal.aborted) return;
    const said = failureOf(error);
    if (res.headersSent || said.code === 'handler_error') console.error('插件流式服务出错：', error);
    if (res.headersSent) return void res.destroy();
    res.writeHead(statusOf(said.code), { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ error: said }));
  }
}
// Asks a handler at its `connection` (`{ port, token }`): its own answer as a `Response`, or the failure it threw. `of`: the
// record and the parameters of a stream's. Broken off before it answered, its module gone or its registration disposed, it
// may have been done. The whole of a request's headers is let in again: what is said of it here repeats its query.
export function askHandler({ port, token }, { method, path, headers, body, caller, of, signal }) {
  return openHttp({ host: '127.0.0.1', port, method, path, signal, headers: { ...headers, authorization: `Bearer ${token}`,
    'x-coda-caller': packed(caller), ...(of ? { 'x-coda-record': packed(of) } : {}) } }, body, {
    own: res => res.headers[ANSWERED],
    refused: error => failed(error ?? { message: '插件没有回答' }),
    broken: () => new ContractError('interrupted', '插件在回答之前断开了', { effects: 'unknown' }),
  });
}

// The one local HTTP service of a plugin host's process, listening once its first handler is registered: each handler of
// `coda.serve` and `coda.stream` is asked with a secret of its own, which says which it is.
export function handlerServer() {
  const handlers = new Map();
  let listening = null;
  const server = createServer({ maxHeaderSize: 128 * 1024 }, (req, res) => {
    const found = handlers.get(/^Bearer (.*)$/.exec(req.headers.authorization ?? '')?.[1]);
    if (!found) { res.writeHead(401); res.end(); return; }
    found.open.add(res);
    res.once('close', () => found.open.delete(res));
    answer(req, res, found.at, found.handler);
  });
  // Streams have no endpoint command deadline. The backend still bounds headers.
  server.requestTimeout = 0;
  return {
    async add(at, handler) {
      await (listening ??= new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }));
      const secret = randomBytes(32).toString('hex'), open = new Set();
      handlers.set(secret, { at, handler, open });
      // Its exchanges under way are broken off; the others' go on.
      return { port: server.address().port, secret, end() { handlers.delete(secret); for (const res of open) res.destroy(); } };
    },
    close() { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); },
  };
}

// One plugin's local handlers. Only connection metadata crosses the host's IPC, asked as the plugin (`ask`, with its token).
// `server`: its process's (`handlerServer`).
export function pluginServices(ask, plugin = {}, server = handlerServer()) {
  const registered = new Map();
  let closed = false;
  // Registered under `key`, told the backend as what `said` names it: where it listens as `open()` says, until `end()`.
  async function hold(key, method, said, open, end) {
    if (closed) throw new Error('插件服务已关闭');
    if (registered.has(key)) throw new TypeError(`已登记：${key}`);
    const held = { end, withdraw: () => ask(`${method}Unregister`, said) };
    registered.set(key, held);
    try {
      const at = await open();
      if (closed) throw new Error('插件服务已关闭');
      await ask(`${method}Register`, { ...said, ...at });
    } catch (error) { registered.delete(key); await end(); throw error; }
    let disposed = false;
    return { async dispose() {
      if (disposed || closed) return;
      disposed = true;
      await held.withdraw();
      registered.delete(key);
      await end();
    } };
  }
  async function register(id, handler) {
    checkServiceId(id);
    if (typeof handler !== 'function') throw new TypeError('services.register(id, handler)');
    const secret = randomBytes(32).toString('hex'), expected = Buffer.from(`Bearer ${secret}`);
    const server = createServer(async (req, res) => {
      const auth = Buffer.from(req.headers.authorization ?? '');
      if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) { res.writeHead(401); res.end(); return; }
      let caller;
      try { caller = unpacked(req.headers['x-coda-caller']); }
      catch { res.writeHead(400); res.end(); return; }
      delete req.headers.authorization; delete req.headers['x-coda-caller'];
      try { await handler(req, res, Object.freeze(caller)); }
      catch (error) {
        console.error('插件流式服务出错：', error);
        if (!res.headersSent) { res.writeHead(500); res.end(); } else res.destroy();
      }
    });
    server.requestTimeout = 0;
    return hold(id, 'service', { id }, async () => {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      return { port: server.address().port, secret };
    }, () => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  }
  // A handler the process's server asks, as `said` names it.
  function handled(key, said, at, handler) {
    let connection;
    return hold(key, 'handler', said, async () => {
      connection = await server.add(at, handler);
      return { port: connection.port, secret: connection.secret };
    }, () => connection?.end());
  }
  // `(request, { caller, signal }) => Response`, of a service of the plugin's own.
  async function serve(id, handler) {
    checkServiceId(id);
    if (typeof handler !== 'function') throw new TypeError('serve(id, handler)');
    return handled(id, { service: id }, 'service', handler);
  }
  // `(request, { record, input, caller, signal }) => Response`, of a stream of the records the plugin holds of a protocol it
  // implements; the backend refuses one the protocol's definition does not have.
  async function stream(kind, name, handler) {
    if (typeof kind !== 'string' || !kind || typeof name !== 'string' || !name || typeof handler !== 'function') throw new TypeError('stream(协议名, 流名, handler)');
    if (!(plugin.protocolImplementations ?? []).includes(kind)) throw new TypeError(`插件 ${plugin.id} 没有实现 ${kind}`);
    return handled(JSON.stringify([kind, name]), { kind, name }, 'stream', handler);
  }
  return { api: Object.freeze({ register }), serve, stream, async close(unregister = true) {
    closed = true;
    for (const { end, withdraw } of registered.values()) {
      if (unregister) await withdraw();
      await end();
    }
    registered.clear();
  } };
}
