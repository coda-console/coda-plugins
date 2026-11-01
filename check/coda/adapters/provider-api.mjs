// The plugin host's local API. Controllers consume accepted objects serially per ID; they choose their own actions.
export function providerAPI({ call, watch, report = console.error }) {
  const observe = (kind, fn, scope = 'available') => watch(`provider:${kind}`, fn, { scope });
  return {
    define: definition => call('define', [definition]),
    put: object => call('put', [object]),
    update: (kind, id, spec, revision) => call('update', [kind, id, spec, revision]),
    setStatus: (kind, id, status, revision) => call('setStatus', [kind, id, status, revision]),
    delete: (kind, id) => call('delete', [kind, id]),
    publish: (kind, id, enabled = true) => call('publish', [kind, id, enabled]),
    observe,
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
