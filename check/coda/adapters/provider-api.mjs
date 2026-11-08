// The plugin host's local API. A provider's own observations consume accepted objects serially per ID; the plugin chooses
// its own actions. `handle` keeps a plugin's operation handlers in `operations`, by kind and operation, for the protocols
// its manifest implements.
import { checkCreationReadOnly } from '../components/protocols/creation.mjs';
export function providerAPI({ call, watch, connection, plugin, operations, report = console.error }) {
  const observe = (kind, fn, scope = 'available') => watch(kind, fn, { scope });
  return {
    async resolve(ref, service) {
      const { resource, path } = await call('resolve', [ref, service]);
      const api = connection();
      return { resource, url: `${api.url}${path}`, headers: { authorization: `Bearer ${api.token}` } };
    },
    put: async object => { checkCreationReadOnly(object); return call('put', [object]); },
    update: (kind, id, spec, revision) => call('update', [kind, id, spec, revision]),
    setStatus: (kind, id, status, revision) => call('setStatus', [kind, id, status, revision]),
    delete: (kind, id) => call('delete', [kind, id]),
    publish: (kind, id, enabled = true) => call('publish', [kind, id, enabled]),
    observe,
    handle(kind, operation, handler) {
      if (typeof kind !== 'string' || !kind || typeof operation !== 'string' || !operation || typeof handler !== 'function')
        throw new TypeError('protocols.handle(协议名, 操作, handler)');
      if (!(plugin.protocolImplementations ?? []).includes(kind)) throw new TypeError(`插件 ${plugin.id} 没有实现 ${kind}`);
      const id = JSON.stringify([kind, operation]);
      if (operations.has(id)) throw new TypeError(`协议操作已登记：${kind}/${operation}`);
      operations.set(id, handler);
      return { dispose: () => { if (operations.get(id) === handler) operations.delete(id); } };
    },
    async control(kind, handler, scope = 'local') {
      if (typeof handler !== 'function') throw new TypeError('controller 须为函数');
      const pending = new Map(), running = new Set();
      let disposed = false;
      const subscription = await observe(kind, event => {
        pending.set(event.id, event);
        if (running.has(event.id)) return;
        running.add(event.id);
        void (async () => {
          try {
            while (!disposed && pending.has(event.id)) {
              const next = pending.get(event.id); pending.delete(event.id);
              try { await handler(next); } catch (error) { report('[protocol controller]', error); }
            }
          } finally { running.delete(event.id); }
        })();
      }, scope);
      return { dispose() { disposed = true; pending.clear(); subscription.dispose(); } };
    },
  };
}
