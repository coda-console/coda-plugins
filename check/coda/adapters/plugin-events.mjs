// A module's events (docs/plugins.md「事件」), as its `coda` has them (adapters/plugin-modules.mjs): `emit` publishes one of a
// protocol its plugin defines or implements, through the backend, which knows the plugin by the module's token (`asks`);
// `on` handles one its plugin subscribes to (`plugin.events`, the events of the event groups it uses, as the backend reckons
// them: components/plugins/plugin-events.mjs `subscribed`), as the backend delivers it (`deliver`). A handler that throws
// is said in the log, and is not handed the event again.
import { codaError } from './provider-api.mjs';

export function pluginEvents(plugin, asks, fire) {
  const subscribed = new Set(plugin.events ?? []), handlers = new Map();
  return {
    api: {
      // `emit(name, data, { subject, project })`: published once the backend has checked it, what is handed on after not
      // waited for; refused with its code, nothing published.
      async emit(name, data, { subject, project } = {}) {
        if (typeof name !== 'string' || typeof subject !== 'string' || typeof project !== 'string') throw new TypeError('emit(事件名, data, { subject, project })');
        await asks('emit', { name, data, subject, project });
      },
      // `on(name, fn)`: `fn` given each event of the name delivered (`{ name, kind, subject, project, data, publisher }`)
      // until it is disposed, or the module stops.
      on(name, fn) {
        if (typeof name !== 'string' || typeof fn !== 'function') throw new TypeError('on(事件名, fn)');
        if (!subscribed.has(name)) throw codaError('forbidden', `插件 ${plugin.id} 没有订事件 ${name}：须在清单的 uses 里写含有它的事件组`, { effects: 'none' });
        // Each its own, however often the same `fn` is.
        const entry = { fn, disposed: false };
        if (!handlers.has(name)) handlers.set(name, new Set());
        handlers.get(name).add(entry);
        return { dispose: () => { entry.disposed = true; handlers.get(name)?.delete(entry); } };
      },
    },
    // An event the backend delivers: to each handler of its name as it comes, once, but one disposed meanwhile; not to one
    // added meanwhile.
    deliver(event) {
      for (const entry of [...handlers.get(event?.name) ?? []]) if (!entry.disposed) fire([entry.fn], event);
    },
    // The names of the events it has handlers of now.
    names() { return [...handlers].filter(([, entries]) => entries.size).map(([name]) => name); },
    // The module stopped: its handlers go.
    clear() { handlers.clear(); },
  };
}
