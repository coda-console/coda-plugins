import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { checkServiceId } from '../domain/plugin-services.mjs';

// One plugin's local handlers. Only connection metadata crosses the host's IPC, asked as the plugin (`ask`, with its token).
export function pluginServices(ask) {
  const services = new Map();
  let closed = false;
  async function register(id, handler) {
    if (closed) throw new Error('插件服务已关闭');
    checkServiceId(id);
    if (typeof handler !== 'function') throw new TypeError('services.register(id, handler)');
    if (services.has(id)) throw new TypeError(`服务已登记：${id}`);
    const secret = randomBytes(32).toString('hex'), expected = Buffer.from(`Bearer ${secret}`);
    const server = createServer(async (req, res) => {
      const auth = Buffer.from(req.headers.authorization ?? '');
      if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) { res.writeHead(401); res.end(); return; }
      let caller;
      try { caller = JSON.parse(Buffer.from(req.headers['x-coda-caller'] ?? '', 'base64url').toString()); }
      catch { res.writeHead(400); res.end(); return; }
      delete req.headers.authorization; delete req.headers['x-coda-caller'];
      try { await handler(req, res, Object.freeze(caller)); }
      catch (error) {
        console.error('插件流式服务出错：', error);
        if (!res.headersSent) { res.writeHead(500); res.end(); } else res.destroy();
      }
    });
    // Streams have no endpoint command deadline. The backend still bounds headers.
    server.requestTimeout = 0;
    const close = () => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); };
    services.set(id, close);
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      await ask('serviceRegister', { id, port: server.address().port, secret });
    } catch (error) { services.delete(id); await close(); throw error; }
    let disposed = false;
    return { async dispose() {
      if (disposed || closed) return;
      disposed = true;
      await ask('serviceUnregister', { id });
      services.delete(id);
      await close();
    } };
  }
  return { api: Object.freeze({ register }), async close(unregister = true) {
    closed = true;
    for (const [id, close] of services) {
      if (unregister) await ask('serviceUnregister', { id });
      await close();
    }
    services.clear();
  } };
}
