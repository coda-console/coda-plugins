// The module level: the plugin's `main` loaded by Coda's own `coda` (the test host, check/coda/adapters/plugin-test-host.mjs),
// activated, and what it registered set against what the manifest says it implements. Runs between the manifest and the Agent
// handshake, for a plugin with a `main`.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createTestHost } from './coda/adapters/plugin-test-host.mjs';
import { closing, temporary } from './leftovers.mjs';

// How long `activate` may take before the check gives up on it.
export const ACTIVATE_LIMIT = 10_000;

const firstLine = e => String(e?.stack ?? e).split('\n')[0];

// The members of `coda` the test host has no backend for, each with the failure the test host answers it with (the code, and the
// text): the same member failing otherwise is the module's own (an argument it gave, a handler it wrote).
export const NOT_PROVIDED = {
  watch: { message: '测试宿主没有后端，不答 watch' },
  'services.register': { message: '测试宿主没有后端，不答 serviceRegister' },
  tell: { message: '测试宿主没有后端，不答 tell' },
  api: { message: 'Coda 还在启动，稍后再试' },
  environment: { message: '测试宿主没有后端，不答 environment' },
  'protocols.resolve': { message: '测试宿主没有后端，不答 provider' },
  'protocols.upload': { message: '测试宿主没有后端，不答 provider' },
  'pluginSetup.retry': { code: 'unsupported', message: '测试宿主不提供 coda.pluginSetup' },
};

// `coda` as the module is given it, each function noting which member each error it ends with came out of (the first, when it is
// passed on): the member that ended the module's `activate` tells a refusal of `coda.on` and a missing backend from the
// module's own failure.
function traced(coda, thrown) {
  const wrap = (object, path) => Object.fromEntries(Object.entries(object).map(([key, value]) => {
    const member = path ? `${path}.${key}` : key;
    if (typeof value === 'function') return [key, (...args) => {
      const fail = error => { if (!thrown.has(error)) thrown.set(error, member); throw error; };
      try { const result = value.apply(object, args); return result instanceof Promise ? result.catch(fail) : result; } catch (error) { return fail(error); }
    }];
    return [key, value && typeof value === 'object' ? wrap(value, member) : value];
  }));
  return wrap(coda, '');
}

// Gives `work` `limit` milliseconds, then fails with it.
function within(work, limit) {
  let timer;
  return Promise.race([work, new Promise((_, reject) => { timer = setTimeout(reject, limit, new Error(`${limit / 1000} 秒没完成`)); })]).finally(() => clearTimeout(timer));
}

// `checked`: the plugin as the manifest level read it (manifest.mjs checkManifest). `limit`: how long `activate` and `deactivate`
// may each take.
export async function checkModule({ checked, say, note, limit = ACTIVATE_LIMIT }) {
  const { plugin } = checked, main = plugin.main;
  const state = temporary('coda-plugin-check-state-');
  // Others' definitions of the protocols it uses, for the event groups its `coda.on` may name.
  const protocols = Object.keys(plugin.uses ?? {}).filter(kind => !plugin.protocols?.some(one => one.name === kind)).map(checked.definitionOf).filter(Boolean);
  const host = createTestHost({ plugin: { id: plugin.id, path: plugin.dir, state: state.dir, protocols: plugin.protocols,
    protocolImplementations: plugin.protocolImplementations, processes: plugin.processes, uses: plugin.uses }, settings: checked.settings, protocols });
  const done = closing(() => host.close());
  const thrown = new Map();
  try {
    let module;
    try { module = await import(pathToFileURL(join(plugin.dir, main)).href); }
    catch (e) { return say.fail('module.load', `main ${main} 加载不了：${firstLine(e)}`); }
    if (typeof module.activate !== 'function') return say.fail('module.activate', `main ${main} 没有导出 activate(coda)`);
    let activated = false;
    try {
      await within(module.activate(traced(host.coda, thrown)), limit);
      activated = true;
    } catch (e) {
      const from = thrown.get(e), lacking = NOT_PROVIDED[from];
      if (from === 'on' && e.code === 'forbidden') say.fail('module.events', `coda.on 订了不在自己事件组里的事件：${e.message}`);
      else if (lacking && e.code === lacking.code && e.message === lacking.message) {
        note.info('note.host', `模块用到测试宿主不提供的能力 coda.${from}，模块一级只验到这里`);
        say.warn('module.registered', `未完成核对：模块用到测试宿主不提供的能力 coda.${from}，登记的操作没有拿去与清单比对`);
      } else say.fail('module.activate', `activate 失败：${firstLine(e)}`);
    }
    if (activated) {
      say.pass('module.activate', `activate 完成：${main}`);
      compare(checked, host.registered(), say);
    }
    // As Coda's host ends a module before it goes: what it started ends with it.
    try { await within(module.deactivate?.(), limit); } catch (e) { say.fail('module.deactivate', `deactivate 失败：${firstLine(e)}`); }
  } finally { done(); await host.close(); state.remove(); }
}

// What the manifest says it implements against what the module registered, both ways: an operation not implemented by a command
// is the module's to register (but for those only Coda answers); one registered that the definition lacks is no operation of the
// protocol. (A protocol the manifest does not implement is refused by the test host as the module registers: it fails `activate`.)
function compare({ plugin, definitionOf }, { operations }, say) {
  const registered = new Set(operations.map(({ kind, operation }) => `${kind} ${operation}`));
  let problems = 0, incomplete = false;
  for (const { kind, commands } of plugin.protocolImplementations ?? []) {
    const definition = definitionOf(kind);
    if (!definition) { incomplete = true; say.warn('module.registered', `未完成核对：协议 ${kind} 的定义不在本地，查不了模块登记了它的哪些操作`); continue; }
    // `codaOnly`: Coda's own protocol's operation that Coda alone answers.
    for (const [operation, { codaOnly }] of Object.entries(definition.operations ?? {}))
      if (!codaOnly && !Object.hasOwn(commands, operation) && !registered.has(`${kind} ${operation}`)) { problems++; say.fail('module.unregistered', `清单写了实现 ${kind} 的操作 ${operation}，模块没登记（coda.handle）`); }
  }
  for (const { kind, operation } of operations) {
    const definition = definitionOf(kind);
    if (definition && !Object.hasOwn(definition.operations ?? {}, operation)) { problems++; say.fail('module.unlisted', `模块登记了 ${kind} 的操作 ${operation}，协议定义里没有这个操作`); }
  }
  if (!problems && !incomplete) say.pass('module.registered', `模块登记了 ${operations.length} 个操作，与清单一致`);
}
