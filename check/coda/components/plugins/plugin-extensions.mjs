// How one plugin builds on another (docs/plugins.md「依赖与扩展点」): it names the plugins it needs (`extensionDependencies`), and
// may plug into a point one of them declares for it (`contributes.extensionPoints` there, `contributes.extensions` here).
// Coda checks the names and hands each plugin what is plugged into its points, as declared: what passes between the two
// is the extended plugin's own contract, which Coda neither reads nor shapes. A point may instead take what any plugin
// writes under a key of its `contributes` (`contributes` there, as the resources plugin's `panels`): of the schema the point
// declares, kept as written, for the declaring plugin to read, only the commands in it listed where installing confirms them.
import { CORE_PROTOCOLS } from '@coda-console/protocol/protocol';
import { pointProblem, valueProblem } from '@coda-console/protocol/validate';
import { requireCondition as check } from '../../domain/errors.mjs';

const code = 'invalid_plugin';

// The point that takes what is written under this key of `contributes`, with the plugin declaring it, or null.
export function offerPoint(plugins, key) {
  for (const plugin of plugins.values()) for (const [point, declared] of Object.entries(plugin.extensionPoints ?? {}))
    if (declared.contributes === key) return { plugin, point, declared };
  return null;
}
// The commands in what a plugin writes for a point (`raw`), each with what it is for, as installing it confirms them:
// `<title>「<the thing's title, ID or place>」的<label>`, and the keys a `*` stood for. How many things it writes.
export function offeredCommands(raw, declared) {
  const items = Array.isArray(raw) ? raw.map((value, i) => [typeof value?.title === 'string' ? value.title : typeof value?.id === 'string' ? value.id : String(i + 1), value])
    : raw && typeof raw === 'object' ? Object.entries(raw) : [];
  const commands = [];
  const walk = (value, rest, stood, label, name) => {
    if (!rest.length) {
      if (typeof value === 'string' && value.trim()) commands.push({ label: `${declared.title}「${name}」的${label}${stood.length ? ` ${stood.join(' ')}` : ''}`, command: value });
      return;
    }
    if (!value || typeof value !== 'object') return;
    const [head, ...tail] = rest;
    if (head === '*') for (const [key, next] of Object.entries(value)) walk(next, tail, [...stood, key], label, name);
    else if (Object.hasOwn(value, head)) walk(value[head], tail, stood, label, name);
  };
  for (const [name, item] of items) for (const [path, label] of Object.entries(declared.commands ?? {})) walk(item, path.split('.'), [], label, name);
  return { count: items.length, commands };
}
// The catalog as a whole: every plugin needed is there, nothing needs itself round about, every point plugged into is
// one its plugin declares, what is written under a key of `contributes` not Coda's own a point takes, and every operation a
// plugin's commands implement is one of its protocol's definition, Coda's own or a plugin's here.
export function checkCatalog(plugins) {
  for (const plugin of plugins.values()) {
    for (const id of plugin.dependencies) check(plugins.has(id), code, `插件 ${plugin.id} 依赖的 ${id} 不在 Coda 里`);
    for (const e of plugin.extensions) check(Object.hasOwn(plugins.get(e.plugin).extensionPoints, e.point), code,
      `插件 ${plugin.id} 接的 ${e.plugin}/${e.point} 不是 ${e.plugin} 声明的扩展点`);
    const operation = operationProblem(plugin, plugins);
    check(!operation, code, operation);
    const problem = offerProblem(plugin, plugins);
    check(!problem, code, `插件 ${plugin.id}：${problem}`);
  }
  const visiting = new Set(), done = new Set();
  const visit = (id, path) => {
    if (done.has(id)) return;
    check(!visiting.has(id), code, `插件互相依赖：${[...path, id].join(' → ')}`);
    visiting.add(id);
    for (const next of plugins.get(id).dependencies) visit(next, [...path, id]);
    visiting.delete(id); done.add(id);
  };
  for (const id of plugins.keys()) visit(id, []);
  return plugins;
}
// Why an operation a plugin's commands implement is not of its protocol's definition, Coda's own or a plugin's in
// `plugins` (the catalog beside it), or null.
export function operationProblem(plugin, plugins) {
  for (const { kind, commands } of plugin.protocolImplementations ?? []) {
    const definition = Object.values(CORE_PROTOCOLS).find(one => one.name === kind)
      ?? [...plugins.values()].flatMap(other => other.protocols ?? []).find(one => one.name === kind);
    const missing = Object.keys(commands).find(operation => !Object.hasOwn(definition?.operations ?? {}, operation));
    if (missing) return `插件 ${plugin.id} 用命令实现的 ${kind} 没有操作 ${missing}`;
  }
  return null;
}
// A protocol's definition as this machine has it with `plugins` (the catalog): one of Coda's (namespace coda), a core
// protocol of the protocol package or one Coda's components registered (`defined`: kind → its registered type, with the
// title and permission groups it was registered with), else the one a plugin of the catalog defines; none without one.
export function protocolDefinition(kind, plugins, defined) {
  if (kind.startsWith('coda/')) return CORE_PROTOCOLS[kind] ?? defined(kind);
  return [...plugins.values()].flatMap(plugin => plugin.protocols ?? []).find(one => one.name === kind);
}
// Why a permission group a plugin uses (docs/plugins.md「用到的权限」) is not one of its protocol's definition in `plugins`
// (the catalog once it is installed) or Coda's (`defined`), or null.
export function usesProblem(plugin, plugins, defined) {
  for (const [kind, groups] of Object.entries(plugin.uses ?? {})) {
    const definition = protocolDefinition(kind, plugins, defined);
    if (!definition) return `插件 ${plugin.id} 用到的协议 ${kind} 不在这台机器上，也不随它一起装`;
    const missing = groups.find(group => !Object.hasOwn(definition.permissions ?? {}, group));
    if (missing) return `插件 ${plugin.id} 用到的协议 ${kind} 没有权限组 ${missing}`;
  }
  return null;
}
// Why a plugin installing `id` installs uses a permission group `catalog` (the catalog once they are installed) or Coda
// (`defined`) does not define, or null: it, and what it needs this machine has not installed (`installed`: the installed
// rows by ID), as reading it and installing it both say. The plugins installed already are not checked again: what they
// use is theirs to answer for (docs/plugins.md「用到的权限」). One needed and nowhere is said missing, not here.
export function installingUsesProblem(catalog, installed, id, defined) {
  for (const each of withDependencies(catalog, id)) {
    if ((each !== id && installed.has(each)) || !catalog.has(each)) continue;
    const problem = usesProblem(catalog.get(each), catalog, defined);
    if (problem) return problem;
  }
  return null;
}
// Why plugin `plugin` (its catalog entry) may not reach kind `kind` as `need` says — an operation of it (`{ operation }`),
// a stream of its records (`{ stream }`), or reading its records (`'read'`; writing them is the implementer's alone) —
// `definition` its protocol's (`protocolDefinition`), or null (docs/plugins.md「用到的权限」). The plugin that implements or
// defines the kind may; any other, a built-in one too, only by a group of the kind's it uses that has the operation or the
// stream, or reads its records. An operation or a stream in no group is open to no plugin.
export function usesRefusal(plugin, kind, need, definition) {
  if ((plugin.protocols ?? []).some(one => one.name === kind) || (plugin.protocolImplementations ?? []).some(one => one.kind === kind)) return null;
  const groups = Object.entries(definition?.permissions ?? {}), used = new Set(plugin.uses?.[kind] ?? []);
  const covers = ([, group]) => typeof need === 'string' ? group[need] === true
    : need.stream !== undefined ? (group.streams ?? []).includes(need.stream) : (group.operations ?? []).includes(need.operation);
  if (groups.some(entry => used.has(entry[0]) && covers(entry))) return null;
  const what = typeof need === 'string' ? `读 ${kind} 的记录` : need.stream !== undefined ? `读 ${kind} 的流 ${need.stream}` : `调 ${kind} 的操作 ${need.operation}`;
  const group = groups.find(covers)?.[0];
  return group ? `插件 ${plugin.id} 要${what}，须在清单的 uses 里写 ${kind} 的权限组 ${group}`
    : `插件 ${plugin.id} 不能${what}：它不在 ${kind} 的任何权限组里，不对插件开放`;
}
// Why what a plugin writes under the keys of `contributes` not Coda's own cannot be taken here (`plugins`: the catalog
// beside it), or null: no point takes one of them, or what it writes is not of the schema the point declares.
export function offerProblem(plugin, plugins) {
  const others = new Map([...plugins, [plugin.id, plugin]]), offers = Object.entries(plugin.offers ?? {});
  const unknown = offers.map(([key]) => key).filter(key => !offerPoint(others, key));
  if (unknown.length) return `contributes 里的 ${unknown.join('、')} 不是 Coda 的类型，也没有插件的扩展点声明它`;
  for (const [key, value] of offers) {
    const { schema } = offerPoint(others, key).declared;
    const problem = schema !== undefined ? pointProblem(schema, value, `contributes.${key}`, plugin.dir) : null;
    if (problem) return problem;
  }
  return null;
}
// What installing a plugin installs: what it needs, before it, then it.
export function withDependencies(catalog, id) {
  const order = [], seen = new Set();
  const visit = at => {
    if (seen.has(at)) return;
    seen.add(at);
    for (const next of catalog.get(at)?.dependencies ?? []) visit(next);
    order.push(at);
  };
  visit(id);
  return order;
}
// A channel restriction is the target backend's, never the client's. An unknown channel cannot satisfy an explicit list.
// The store reads registry metadata; installation reads the package itself. Both use the same schema and rule.
export function pluginChannelProblem(plugin, channel) {
  if (plugin.coda === undefined) return null;
  const problem = valueProblem('plugin.json#/properties/coda', plugin.coda, 'coda');
  if (problem) return problem;
  const channels = plugin.coda.channels;
  if (!channels || channels.includes(channel)) return null;
  const names = channels.map(value => value === 'preview' ? '预览版' : '正式版').join('或');
  return `此插件仅支持 Coda ${names}后端${channel ? '' : '，当前后端没有发布通道记录'}`;
}
// The same dependency closure used by installation, after resolving each dependency to its actual local or source version.
export function catalogChannelProblem(catalog, id, channel) {
  for (const each of withDependencies(catalog, id)) {
    const plugin = catalog.get(each), problem = plugin && pluginChannelProblem(plugin, channel);
    if (problem) return each === id ? problem : `${each}：${problem}`;
  }
  return null;
}
// The installed plugins that need this one, directly or through another, by ID.
export function dependents(catalog, installed, id) {
  const found = new Set();
  for (let grew = true; grew;) {
    grew = false;
    for (const plugin of catalog.values()) {
      if (!installed.has(plugin.id) || found.has(plugin.id)) continue;
      if (plugin.dependencies.some(d => d === id || found.has(d))) { found.add(plugin.id); grew = true; }
    }
  }
  return [...found].sort();
}
// What installed plugins plug into this plugin's points, by point, in plugin ID order: each one's command, its directory,
// the directory it keeps its state in (`stateDir`) and its settings for every project (`settingsOf`), for the extended
// plugin to run it as its own contract says, the command answering by its own settings.
export function extensionsFor(catalog, installed, id, stateDir = () => null, settingsOf = () => null) {
  const points = {};
  for (const plugin of [...catalog.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    if (!installed.has(plugin.id)) continue;
    for (const e of plugin.extensions) {
      if (e.plugin !== id || !Object.hasOwn(catalog.get(id)?.extensionPoints ?? {}, e.point)) continue;
      const state = stateDir(plugin.id), settings = settingsOf(plugin.id);
      (points[e.point] ??= []).push({ plugin: plugin.id, command: e.command, path: plugin.dir, ...(state ? { state } : {}), ...(settings ? { settings } : {}) });
    }
  }
  return points;
}
