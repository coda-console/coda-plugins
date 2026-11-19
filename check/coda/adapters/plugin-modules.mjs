// The plugin host's modules (docs/plugins.md「插件宿主」): each plugin's that has a `main`, loaded the first time anything
// of it is needed, or when the backend says to, and given a `coda` of its own. What the runner (adapters/plugin-host-runner.mjs)
// runs over Node's IPC channel with the backend, and the test host (adapters/plugin-test-host.mjs) over a channel of its own:
// `send(message)` to the backend, `receive(message)` from it. `adopt(plugin, token)`: a plugin's `coda` made with no module
// loaded, for whoever holds it to activate a module with; `stop()`: each module loaded ends what it started (`deactivate`).
//
// From the backend: `start { api: { url }, parts }`, `activate { plugin, token }` (before anything else of the plugin's),
// `open { instance, plugin, view, context, caller }`, `query { plugin, request, deadline }`, `run { plugin, call }` and
// `resume { plugin, call }`, and `cancel { id, reason }` of any of them, `mode { plugin, mode, hook, context }` (a request
// each), and `message`, `callProgress { id, value }` (a `call`'s progress, by the request's ID), `context`, `close { instance, … }`, `changed { watch, events }`, `settingsChanged { plugin,
// settings }` (a notice, no answer: the plugin's own settings, as `Plugins.setSettings` wrote them), and `output`, `exited`
// of a process it started (adapters/process-relay.mjs). To it: `post { instance, message }`, `change { instance,
// collection, type, id, object }`, `unwatch { watch }`, `cancel { id }` of a `query` or a `question`, `progress { run,
// value }` of a `run`, `drained`, `kill` of a process, and the requests `environment { of, project }`, `settings`
// (the plugin's own, as they are now), `watch { collection, selector }`, `tell { session, text }`, `part { part, method,
// args }`, `provider { method, args }`, `serviceRegister { id, port, secret }`, `serviceUnregister { id }`, `query { record,
// operation, input, timeout, deadline }`, `call { record, operation, input, id, timeout, deadline, under, progress }`, `spawn { under, process, command, args, cwd, env, name }`, each with the
// module's `token`, by which the backend knows the plugin it is of, never by what it names; and `question { run,
// question }` and `input` of a process. A query's
// failure crosses as `failureOf` says it, as one that did nothing (`none`); a run's end, and a resume's, as its outcome, or a resume's as null when the
// module has none.
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pluginServices } from './plugin-stream-services.mjs';
import { pathToFileURL } from 'node:url';
import { callingAPI, canceled, codaError, failed, failureOf, givenUp, providerAPI, queryingAPI } from './provider-api.mjs';
import { queryId } from './plugin-command.mjs';

export function pluginModules({ send }) {
  // This machine's Coda, as `start` gives it: its address only. Each module reaches it with its own plugin's token, given
  // with `activate` and kept in its own `coda` only.
  let api = null;
  // The parts of `coda` others provide (components/plugins/plugin-host.mjs provide), as `start` names them: each made of the
  // calls it asks by what its module exports (`make`).
  let parts = Promise.resolve([]);
  const loading = new Map(), instances = new Map(), asked = new Map(), watches = new Map();
  // The queries and doing calls being handled, by the backend's request: each called off with the reason the backend gives
  // (`cancel`).
  const cancels = new Map();
  // What a handler of a call is given beside its input (coda#2749 3.1): the call's ID, its record, its `signal`, which goes
  // off as the backend calls it off, its `deadline` (milliseconds on the backend's clock, or none), `query`, queries made
  // under it, and `spawn`, processes started for it, the backend's request `under` which the call came; a doing call's
  // handler (`run`, `resume`), `call` too, doing calls it makes (`doingOf`).
  const contextOf = ({ id, record, deadline }, signal, { querying, spawnFor }, under) =>
    ({ id, record, signal, deadline, query: querying.within(signal, deadline), spawn: spawnFor(under, signal) });
  const doingOf = (call, signal, made, under) => ({ ...contextOf(call, signal, made, under), call: made.calling.within(signal, call.deadline, under) });
  // The processes the modules started through the backend (`spawn`), by the key this host gave each, until they have
  // exited or the host stops.
  const processes = new Map();
  let nextProcess = 0;
  // A doing call handed to its operation's handler (`run`, `resume`), as `fn(handler, signal, made)` hands it, its
  // `signal` going off as the backend calls it off (`cancel`), or, `halted` (as `cancel`'s reason crosses), before the
  // handler is called.
  async function handling(plugin, call, id, fn, halted = null) {
    const controller = new AbortController();
    if (halted) controller.abort(canceled(halted));
    cancels.set(id, controller);
    try {
      const made = await activated(plugin);
      return await fn(made.operations.get(JSON.stringify([call.record.kind, call.operation])), controller.signal, made);
    } finally { cancels.delete(id); }
  }
  // How a doing call's handler ended it: completed with what it returned, as it crosses the channel, JSON (one that is not,
  // a BigInt, a cycle, fails as the handler's error, as anything it throws does, an error or not); failed as it threw
  // (`failureOf`); or, thrown the reason its `signal` went off with as the call was cancelled, cancelled.
  async function ending(handled, signal) {
    try { return { outcome: 'completed', result: JSON.parse(JSON.stringify(await handled()) ?? 'null') }; } catch (error) {
      return signal.aborted && error === signal.reason && error.name === 'AbortError' ? { outcome: 'canceled' } : { outcome: 'failed', error: failureOf(error) };
    }
  }
  // A module's collections (docs/plugins.md「集合」): names and IDs as the page takes them; a change at most as a message is,
  // measured as the backend measures what it passes on (components/plugins/plugin-host.mjs deliver).
  const NAME = /^[a-z][a-z0-9-]{0,39}$/, CHANGE_LIMIT = 128 * 1024;
  let next = 0;
  // Asked of the backend; given up on with `signal`, the backend is told to give it up too, and it fails with the signal's
  // reason (`givenUp`), as one that may have been done — a query as one that did nothing. What the backend says of how it goes (`callProgress`) is given to `progress`.
  const ask = (method, params, signal = null, progress = null) => new Promise((resolve, reject) => {
    const id = ++next;
    const given = () => {
      if (!asked.delete(id)) return;
      send({ method: 'cancel', params: { id } });
      reject(givenUp(signal, method === 'query' ? 'none' : 'unknown'));
    };
    const settled = fn => value => { signal?.removeEventListener('abort', given); fn(value); };
    asked.set(id, { resolve: settled(resolve), reject: settled(reject), progress });
    send({ id, method, params });
    signal?.addEventListener('abort', given, { once: true });
  });
  const fire = (listeners, value) => {
    for (const fn of listeners) {
      try { Promise.resolve(fn(value)).catch(e => console.error('插件出错：', e)); } catch (e) { console.error('插件出错：', e); }
    }
  };
  const listen = set => fn => { set.add(fn); return { dispose: () => set.delete(fn) }; };
  // One of Coda's collections, whole or as `selector` has it (a session's runs), watched once for each plugin (`plugin`)
  // however many of its modules' watchers watch it, asked with its token (`asks`): `fn` is given every object as `ADDED`
  // first, then each change. Done once the first are given. The last watcher gone, the backend stops reading it. A kind's
  // records (coda#2749 3.7, `{ scope?, id? }` as `list` takes them) are each told as an entry, as `get` and `list` give it
  // to the plugin (its own with their keys), by its ID: `{ type, id, entry }`.
  // A change as a watcher is told it: of a kind, its entry by the record's ID; the backend tells it by its holder's too.
  const told = (watched, type, id, object) => watched.entries ? { type, id: object.id, entry: object } : { type, id, object };
  async function watch(asks, plugin, name, fn, selector = null) {
    if (typeof name !== 'string' || typeof fn !== 'function') throw new TypeError('watch(集合, fn, 筛选?)');
    if (selector !== null && (typeof selector !== 'object' || Array.isArray(selector))) throw new TypeError('筛选须为对象');
    // Named as the backend names it.
    const key = JSON.stringify([name, selector, plugin]);
    let watched = watches.get(key);
    if (!watched) {
      watched = { objects: new Map(), listeners: new Set(), ready: null, entries: false };
      watched.ready = asks('watch', { collection: name, selector }).then(({ items, entries }) => {
        watched.entries = !!entries;
        for (const { id, object } of items) watched.objects.set(id, object);
      });
      watches.set(key, watched);
      watched.ready.catch(() => watches.delete(key));
    }
    await watched.ready;
    watched.listeners.add(fn);
    for (const [id, object] of watched.objects) fire([fn], told(watched, 'ADDED', id, object));
    return {
      dispose: () => {
        watched.listeners.delete(fn);
        if (watched.listeners.size || watches.get(key) !== watched) return;
        watches.delete(key);
        send({ method: 'unwatch', params: { watch: key } });
      },
    };
  }

  // A process the backend starts for a module (coda#2749 3.8, docs/plugins.md「起进程」), as Node's ChildProcess has the
  // most of it: `stdin` written to it, `stdout` and `stderr` read from it, as they cross the channel (adapters/
  // process-relay.mjs: what the module reads of each it says it has, `drained`, for the backend to send more), and
  // `exited`, its exit code and signal once both outputs have ended. The host stopping (its channel gone) ends its
  // outputs as they are and fails `exited` (`interrupted`): the backend ends the process. A named one (not `piped`) has
  // no streams, as a ChildProcess started with its stdio elsewhere: its output is in its log.
  function processHandle(key, piped) {
    let settle;
    const exited = new Promise((resolve, reject) => { settle = { resolve, reject }; });
    exited.catch(() => {});
    const output = name => {
      let owed = 0, ended = false;
      const drained = () => {
        if (!owed) return;
        send({ method: 'drained', params: { process: key, stream: name, bytes: owed } });
        owed = 0;
      };
      const stream = new Readable({ read: drained });
      return { stream, take(data) {
        if (ended) return;
        if (data === null) { ended = true; stream.push(null); return; }
        const chunk = Buffer.from(String(data), 'base64');
        owed += chunk.length;
        if (stream.push(chunk)) drained();
      } };
    };
    const outputs = piped ? { stdout: output('stdout'), stderr: output('stderr') } : {};
    const stdin = piped ? new Writable({
      write(chunk, _encoding, done) { ask('input', { process: key, data: chunk.toString('base64') }).then(() => done(), done); },
      final(done) { ask('input', { process: key, end: true }).then(() => done(), done); },
    }) : null;
    const value = { pid: null, stdin, stdout: outputs.stdout?.stream ?? null, stderr: outputs.stderr?.stream ?? null, exited,
      kill(signal = 'SIGTERM') { send({ method: 'kill', params: { process: key, signal } }); } };
    const over = () => {
      processes.delete(key);
      for (const each of Object.values(outputs)) each.take(null);
      stdin?.destroy();
    };
    const entry = {
      value,
      output(stream, data) { outputs[stream]?.take(data); },
      exit({ code = null, signal = null }) { over(); settle.resolve({ code, signal }); },
      interrupt() { over(); settle.reject(codaError('interrupted', '插件宿主停了，进程由后端收掉', { effects: 'unknown' })); },
    };
    processes.set(key, entry);
    return entry;
  }
  // `spawn(command, args?, { cwd, env, name }?)` of a plugin's: started by the backend with the plugin's processes'
  // environment (`env` added over it), for the call whose request is `under` (`ctx.spawn`) or for the module (`coda.spawn`,
  // `under` null), or, `name` given, as the process of that name the plugin's manifest declares (`contributes.processes`).
  // One for a call ends as `signal` goes off; a named one does not. Fails as the backend could not start it.
  const spawning = (asks, under, signal) => async (command, args = [], options = {}) => {
    if (typeof command !== 'string' || !command || !Array.isArray(args) || args.some(arg => typeof arg !== 'string') || !options || typeof options !== 'object') {
      throw new TypeError('spawn(命令, 参数?, { cwd, env, name }?)');
    }
    const { cwd = null, env = {}, name = null } = options, bound = name === null ? signal : null;
    bound?.throwIfAborted();
    const key = String(++nextProcess), entry = processHandle(key, name === null);
    try { entry.value.pid = (await asks('spawn', { under, process: key, command, args, cwd, env, name })).pid; }
    catch (error) { processes.delete(key); throw error; }
    if (bound) {
      const end = () => entry.value.kill();
      if (bound.aborted) end(); else bound.addEventListener('abort', end, { once: true });
      entry.value.exited.catch(() => {}).finally(() => bound.removeEventListener('abort', end));
    }
    return entry.value;
  };

  // What a plugin's module is given: this plugin's own, and the environment of another's it runs a command of; and the parts
  // others provide, each asking the backend under its name. `token`: this plugin's for this host process, brought with
  // every request it asks (`asks`).
  function codaFor(plugin, provided, token) {
    const views = new Map(), protocols = new Map(), operations = new Map();
    const asks = (method, params, signal = null, progress = null) => ask(method, { ...params, token }, signal, progress);
    const services = pluginServices(asks);
    const environment = (project = null, options = {}) => asks('environment', { of: options?.plugin ?? null, project });
    // The listeners of `settings.onChange`: this plugin's own settings only, told as they are written.
    const settingsChanges = new Set();
    // A query through the backend's unified call, the caller this plugin by its token.
    const querying = queryingAPI({ send: (request, signal) => asks('query', request, signal), plugin, operations });
    // A doing call through the call kernel, from this plugin's address (docs/plugins.md「做事的调用」).
    const calling = callingAPI((request, signal, progress) => asks('call', request, signal, progress));
    const spawnFor = (under, signal) => spawning(asks, under, signal);
    const watching = (name, fn, selector) => watch(asks, plugin.id, name, fn, selector);
    // The records this plugin holds (coda#2749 3.7), written one after another as the module said them, whatever became of
    // the one before: each answered once it is in this machine's record directory, or refused with its code.
    let writing = Promise.resolve();
    const write = (method, args) => {
      const written = writing.then(() => asks('provider', { method, args }));
      writing = written.catch(() => {});
      return written;
    };
    const coda = Object.freeze({
      plugin: Object.freeze({ id: plugin.id, path: plugin.path, state: plugin.state }),
      // Queries (docs/plugins.md「调用」): one of a protocol the plugin implements handled, one of its own processes' handled
      // (`self.handle`), one of any record's made, a failure said.
      handle: querying.handle, self: querying.self, query: querying.query, error: querying.error,
      // A doing call of any record's (docs/plugins.md「做事的调用」).
      call: calling.call,
      // A process of this module's own, until the module stops (docs/plugins.md「起进程」).
      spawn: spawnFor(null, null),
      services: services.api,
      // `put({ kind, key }, { spec, status?, labels? })` made or replaced (a status not given kept), answered with its entry,
      // `delete({ kind, key })`, and `replace(kind, entries)`, every one of a kind the plugin holds given (`[{ key, spec,
      // status?, labels? }]`), those it no longer gives gone, answered with the entries given, in their order: each named by
      // the plugin's own key, its ID the host's. `get({ kind, id })`, one record or null, and `list(kind, { scope?, id? })`,
      // the records of any kind, each an entry `{ owner, location, id, plugin, key?, local, spec, status, labels, version }`, `key`
      // only of this plugin's own here: read after what this module wrote before.
      get: record => writing.then(() => asks('provider', { method: 'getRecord', args: [record] })),
      list: (kind, filter) => writing.then(() => asks('provider', { method: 'listRecords', args: [kind, filter ?? null] })),
      put: (record, value) => write('putRecord', [record, value]),
      delete: record => write('deleteRecord', [record]),
      replace: (kind, entries) => write('replaceRecords', [kind, entries]),
      ...Object.fromEntries(provided.map(([name, make]) => [name, Object.freeze(make((method, args) => asks('part', { part: name, method, args })))])),
      views: Object.freeze({
        register(id, provider) {
          if (typeof id !== 'string' || typeof provider?.open !== 'function') throw new TypeError('views.register(视图 ID, { open(view) })');
          views.set(id, provider);
          return { dispose: () => { if (views.get(id) === provider) views.delete(id); } };
        },
      }),
      protocols: Object.freeze({
        ...providerAPI({ call: (method, args) => asks('provider', { method, args }), connection: () => api && { url: api.url, token } }),
        register(kind, key, handler) {
          if (typeof kind !== 'string' || !kind || typeof key !== 'string' || !key || typeof handler !== 'function') throw new TypeError('protocols.register(类型, key, handler)');
          const id = JSON.stringify([kind, key]);
          if (protocols.has(id)) throw new TypeError(`协议参与者已登记：${kind}/${key}`);
          protocols.set(id, handler);
          return { dispose: () => { if (protocols.get(id) === handler) protocols.delete(id); } };
        },
      }),
      // Something for a session's agent to know, told with its next turn (docs/session-contracts.md「顺带告诉」).
      tell: (session, text) => asks('tell', { session, text }),
      // This machine's Coda, as its clients reach it: GET without a body, POST with one.
      async api(path, body) {
        if (!api) throw new Error('Coda 还在启动，稍后再试');
        const response = await fetch(`${api.url}/v1/${String(path).replace(/^\/+/, '')}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const value = await response.json().catch(() => null);
        if (!response.ok) throw new Error(value?.error?.message ?? `Coda 回答 ${response.status}`);
        return value;
      },
      // What Coda gives every process of the plugin's (docs/plugins.md「插件进程的环境」), for one the module starts itself
      // (Node's child_process, as a VS Code extension starts its language server); `{ plugin }`, another installed plugin's,
      // for a command of its the module runs.
      environment,
      // This plugin's own settings (docs/plugins.md「设置」): as they are now, asked of the backend each time, and told to
      // `onChange` as they are written, while the module runs. Secrets are not among them.
      settings: Object.freeze({
        get: () => asks('settings', {}),
        onChange: listen(settingsChanges),
      }),
      // Coda's own collections, as a page watches the module's (`workflow-runs`: the runs this machine lists, or by a selector
      // a session's or a run's).
      watch: watching,
    });
    return { coda, views, protocols, operations, services, querying, calling, spawnFor, settingsChanges };
  }

  // Loaded once, as the backend activates it (`activate`, the first time anything of it is needed); what else comes for it
  // waits for the same. One that does not load is activated again, with another token.
  function load(plugin, token) {
    if (!loading.has(plugin.id)) {
      const loaded = (async () => {
        const made = codaFor(plugin, await parts, token);
        try {
          const module = await import(pathToFileURL(join(plugin.path, plugin.main)).href);
          if (typeof module.activate !== 'function') throw new Error(`${plugin.main} 没有导出 activate`);
          await module.activate(made.coda);
          return { ...made, module };
        } catch (error) { await made.services.close(); throw error; }
      })();
      loading.set(plugin.id, loaded);
      loaded.catch(() => loading.delete(plugin.id));
    }
    return loading.get(plugin.id);
  }
  const activated = plugin => loading.get(plugin.id) ?? Promise.reject(new Error(`插件 ${plugin.id} 还没有激活`));

  const handlers = {
    start(params) {
      api = params.api;
      parts = Promise.all(params.parts.map(async ({ name, module, make }) => [name, (await import(module))[make]]));
    },
    // A plugin's module, loaded the first time anything of it is needed, or as soon as the backend has started.
    async activate({ plugin, token }) { await load(plugin, token); },
    async open({ instance, plugin, view, context, caller }) {
      const { views } = await activated(plugin);
      const provider = views.get(view);
      if (!provider) throw new Error(`插件 ${plugin.id} 没有注册视图 ${view}`);
      const listeners = { message: new Set(), context: new Set(), close: new Set() }, collections = new Map();
      // A collection of the page's: each object set whole, the page told whether it is new, changed or gone.
      const collection = name => {
        if (typeof name !== 'string' || !NAME.test(name)) throw new TypeError('集合名是小写字母、数字和「-」，以字母开头，至多 40 个字符');
        if (!collections.has(name)) collections.set(name, new Map());
        const objects = collections.get(name);
        const tell = (type, id, object) => send({ method: 'change', params: { instance, collection: name, type, id, object } });
        const key = id => {
          if (typeof id !== 'string' || !id || id.length > 200) throw new TypeError('对象的 id 须为不超过 200 字的字符串');
          return id;
        };
        return Object.freeze({
          set(id, object) {
            key(id);
            if (!object || typeof object !== 'object' || Array.isArray(object)) throw new TypeError('对象须为 JSON 对象');
            const json = JSON.stringify(object);
            // Sized as its longest change, so that whatever it later is told as (changed, gone) reaches the page; refused
            // before it is kept, so that setting it again is no change it never sent.
            if (JSON.stringify({ change: { collection: name, type: 'MODIFIED', id, object } }).length > CHANGE_LIMIT) {
              throw new RangeError(`对象过大：连同集合名与 id 超过 ${CHANGE_LIMIT / 1024} KiB`);
            }
            if (!instances.has(instance) || objects.get(id) === json) return false;
            const type = objects.has(id) ? 'MODIFIED' : 'ADDED';
            objects.set(id, json);
            tell(type, id, JSON.parse(json));
            return true;
          },
          delete(id) {
            key(id);
            if (!instances.has(instance) || !objects.has(id)) return false;
            const json = objects.get(id);
            objects.delete(id);
            tell('DELETED', id, JSON.parse(json));
            return true;
          },
          get: id => objects.has(id) ? JSON.parse(objects.get(id)) : undefined,
          keys: () => [...objects.keys()],
        });
      };
      const value = {
        id: instance, view, context, caller: Object.freeze(caller ?? { local: true }),
        postMessage(message) {
          if (!instances.has(instance)) return false;
          send({ method: 'post', params: { instance, message } });
          return true;
        },
        onMessage: listen(listeners.message), onContext: listen(listeners.context), onClose: listen(listeners.close),
        collection,
      };
      instances.set(instance, { value, listeners });
      try { await provider.open(value); } catch (e) { instances.delete(instance); throw e; }
    },
    async contribute({ plugin, kind, key, object }) {
      const { protocols } = await activated(plugin);
      const handler = protocols.get(JSON.stringify([kind, key]));
      if (!handler) throw new Error(`插件 ${plugin.id} 没有协议参与者 ${kind}/${key}`);
      return handler(object, key);
    },
    // A query of a protocol the plugin implements (docs/plugins.md「调用」), by the unified call: its ID one of its caller's
    // (`parent`) and request ID. Not handled, nothing was handed to the module.
    async query({ plugin, request, deadline }, id) {
      const controller = new AbortController();
      cancels.set(id, controller);
      try {
        const made = await activated(plugin);
        const handler = made.operations.get(JSON.stringify([request?.record?.kind, request?.operation]));
        if (!handler) throw codaError('not_found', `插件 ${plugin.id} 没有实现 ${request?.record?.kind}/${request?.operation}`, { effects: 'none' });
        return await handler.run(request.input,
          contextOf({ id: queryId(request), record: request.record, deadline }, controller.signal, made, id));
      } finally { cancels.delete(id); }
    },
    // A doing call of a protocol the plugin implements (docs/plugins.md「做事的操作」), as the backend hosts it
    // (components/plugins/hosted-calls.mjs): `call` is `{ id, ref, record, operation, input, deadline }`, `ref` the call's on the call
    // kernel (`{ from, id }`), which the doing calls its handler makes are made by. Its handler is given
    // besides `progress`, said to the backend as it comes, and `ask`, answered as the backend passes the answer on (one at
    // a time, as the backend has it: components/plugins/hosted-calls.mjs `question`). It ends with the call's outcome (`ending`). Not handled, nothing was done.
    run({ plugin, call }, id) {
      return handling(plugin, call, id, async (handler, signal, made) => {
        if (!handler) return { outcome: 'failed', error: failureOf(codaError('not_found', `插件 ${plugin.id} 没有登记 ${call.record.kind}/${call.operation} 的处理函数`, { effects: 'none' })) };
        const ctx = { ...doingOf(call, signal, made, id),
          progress: value => send({ method: 'progress', params: { run: id, value } }),
          async ask(question) {
            signal.throwIfAborted();
            // Given up as the call is: with the reason it goes off with, the backend told (`cancel`). What listens for that
            // goes once the question is answered, the call's signal left as it was.
            let given;
            const off = new Promise((_, reject) => signal.addEventListener('abort', given = () => reject(signal.reason), { once: true }));
            try { return await Promise.race([off, ask('question', { run: id, question }, signal)]); } finally {
              signal.removeEventListener('abort', given);
            }
          } };
        return ending(() => handler.run(call.input, ctx), signal);
      });
    },
    // A doing call left by a host process that ended before its handler did (coda#2749 3.6), handed to its operation's
    // `resume` in this one: `call` is `{ id, ref, record, operation, input, deadline, progress, canceled, halted }`, `halted`
    // why its `ctx.signal` has gone off already (asked to be cancelled, or past its deadline, as `cancel`'s reason
    // crosses), or none. `resume` is given the call as `Interrupted` and a `ctx` as a query's handler is with `call`, and ends it as
    // `run` does; with none, null, for the backend to end it as it does then. Its `ctx.call` makes calls as the call's, as `run`'s
    // does: one made again by the same `id` is the one it made before the process ended.
    resume({ plugin, call }, id) {
      return handling(plugin, call, id, async (handler, signal, made) => {
        if (!handler?.resume) return null;
        const { id: callId, record, operation: op, input, progress, canceled } = call;
        return ending(() => handler.resume({ id: callId, record, op, input, progress, canceled, children: [] }, doingOf(call, signal, made, id)), signal);
      }, call.halted);
    },
    // Called off: a query is let go at once, its handler's answer, if one comes, dropped by the backend; a doing call is
    // given the time the backend gives it to end.
    cancel({ id, reason }) {
      const controller = cancels.get(id);
      cancels.delete(id);
      controller?.abort(canceled(reason));
    },
    // How a doing call the module made goes, as its callee says (`call`'s `progress`).
    callProgress({ id, value }) { asked.get(id)?.progress?.(value); },
    message({ instance, message }) {
      const shown = instances.get(instance);
      if (shown) fire(shown.listeners.message, message);
    },
    context({ instance, context }) {
      const shown = instances.get(instance);
      if (shown) { shown.value.context = context; fire(shown.listeners.context, context); }
    },
    // The plugin's settings were written: told to its module's listeners, once it has activated (one that did not has none).
    async settingsChanged({ plugin, settings }) {
      const made = await loading.get(plugin)?.catch(() => null);
      if (made) fire(made.settingsChanges, settings);
    },
    close({ instance }) {
      const shown = instances.get(instance);
      if (shown) { instances.delete(instance); fire(shown.listeners.close); }
    },
    // Of a process a module started: its output, and its end (adapters/process-relay.mjs).
    output({ process, stream, data, end }) { processes.get(process)?.output(stream, end ? null : data); },
    exited({ process, code, signal }) { processes.get(process)?.exit({ code, signal }); },
    // Coda's objects moved: each watcher told, in turn.
    changed({ watch: key, events }) {
      const watched = watches.get(key);
      if (!watched || !Array.isArray(events)) return;
      for (const event of events) {
        if (event.type === 'DELETED') watched.objects.delete(event.id); else watched.objects.set(event.id, event.object);
        fire(watched.listeners, told(watched, event.type, event.id, event.object));
      }
    },
  };

  async function receive(message) {
    if (!message || typeof message !== 'object') return;
    // An answer to what this host asked.
    if (!message.method) {
      const waiting = asked.get(message.id);
      asked.delete(message.id);
      if (message.error !== undefined) waiting?.reject(failed(message.error)); else waiting?.resolve(message.result);
      return;
    }
    const { id, method, params } = message;
    try {
      const handler = handlers[method];
      if (!handler) throw new Error(`插件宿主不认识 ${method}`);
      const result = await handler(params ?? {}, id);
      if (id !== undefined) send({ id, result: result ?? null });
    } catch (e) {
      if (id !== undefined) send({ id, error: method === 'query' ? failureOf(e, 'none') : String(e?.message ?? e) }); else console.error(e);
    }
  }
  // Each module loaded ends what it started that is not in the host's group (`deactivate`, as VS Code's), once; the
  // processes the backend started for them are the backend's to end, and their handles here end at once.
  let stopping = null;
  const stop = () => stopping ??= Promise.allSettled([...processes.values()].map(entry => entry.interrupt())
    .concat([...loading.values()].map(async loaded => {
    const { module, services, settingsChanges } = await loaded;
    settingsChanges.clear();
    await services.close(false);
    if (typeof module?.deactivate === 'function') await module.deactivate();
  })));
  function adopt(plugin, token) {
    const made = codaFor(plugin, [], token);
    loading.set(plugin.id, Promise.resolve(made));
    return made.coda;
  }
  return { receive, stop, adopt };
}
