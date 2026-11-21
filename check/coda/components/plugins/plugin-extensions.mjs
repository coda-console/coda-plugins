// How one plugin builds on another (docs/plugins.md「依赖与扩展点」): it names the plugins it needs (`extensionDependencies`),
// and Coda checks the names: each is there, and none needs itself round about.
import { CORE_PROTOCOLS } from '@coda-console/protocol/protocol';
import { valueProblem } from '@coda-console/protocol/validate';
import { requireCondition as check } from '../../domain/errors.mjs';
import { payloadProblem } from '../protocols/protocol-events.mjs';
import { LOCAL_KINDS } from '../protocols/record-rules.mjs';

const code = 'invalid_plugin';

// The catalog as a whole: every plugin needed is there, nothing needs itself round about, and every operation a plugin's
// commands implement is one of its protocol's definition, Coda's own or a plugin's here.
export function checkCatalog(plugins) {
  for (const plugin of plugins.values()) {
    for (const id of plugin.dependencies) check(plugins.has(id), code, `插件 ${plugin.id} 依赖的 ${id} 不在 Coda 里`);
    const operation = operationProblem(plugin, plugins);
    check(!operation, code, operation);
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
// protocol of the protocol package or one of Coda's own (`defined`: kind → its definition, application/host-protocols.mjs),
// else the one a plugin of the catalog defines; none without one.
export function protocolDefinition(kind, plugins, defined) {
  if (kind.startsWith('coda/')) return CORE_PROTOCOLS[kind] ?? defined(kind);
  return [...plugins.values()].flatMap(plugin => plugin.protocols ?? []).find(one => one.name === kind);
}
// What of the protocols a plugin uses (docs/plugins.md「用到的权限」) neither its definition in `plugins` (the catalog beside
// it) nor Coda's (`defined`) has: the protocol (`{ protocol }`), or one of its permission groups (`{ protocol, group }`);
// null when they have all of it.
export function usesMissing(plugin, plugins, defined) {
  for (const [kind, groups] of Object.entries(plugin.uses ?? {})) {
    const definition = protocolDefinition(kind, plugins, defined);
    if (!definition) return { protocol: kind };
    const group = groups.find(each => !Object.hasOwn(definition.permissions ?? {}, each));
    if (group) return { protocol: kind, group };
  }
  return null;
}
// The first protocol a plugin implements (`protocolImplementations`) that neither it, `plugins` (the catalog beside it) nor
// Coda (`defined`) defines, as `{ protocol }`; null when all are here.
export function implementsMissing(plugin, plugins, defined) {
  const found = (plugin.protocolImplementations ?? []).find(({ kind }) => !(plugin.protocols ?? []).some(one => one.name === kind) && !protocolDefinition(kind, plugins, defined));
  return found ? { protocol: found.kind } : null;
}
// This Coda's API Level (docs/plugins.md「兼容」): what it offers plugins, counted. A manifest's `engines.coda` names the least
// a plugin needs; one naming none needs 0, which any Coda has.
export const API_LEVEL = 9;
// The API Level a package's registry metadata asks for in its `engines`: a positive integer, or its digits as text (what
// npm's registry may make of one); undefined when it asks for none, null when it is anything else. A manifest read from
// its directory has the schema's shape (plugin-rules.mjs readPlugin).
export function wantedLevel(engines) {
  const value = engines?.coda;
  if (value === undefined) return undefined;
  if (Number.isInteger(value) && value >= 1) return value;
  return typeof value === 'string' && /^[1-9][0-9]{0,8}$/.test(value) ? Number(value) : null;
}
// The keys of `contributes` Coda once read and no longer does: a manifest still writing one was made for what Coda took away.
const RETIRED_CONTRIBUTES = ['endpoints', 'groups', 'events', 'resources', 'panels', 'extensionPoints', 'extensions'];
// Those of them `contributes` writes, a manifest's or a version's registry metadata: what either is read with as its `retired`.
export const retiredContributes = contributes => RETIRED_CONTRIBUTES.filter(key => Object.hasOwn(contributes ?? {}, key));
// Whether a plugin runs on this machine (docs/plugins.md「兼容」): the one judgment reading a source, installing, the store and
// the catalog take. Null when it does; else what it needs (`need`), what is missing (`missing`) and why, as the user is
// told (`error`). `host`: this machine — its API Level (`level`), its backend's channel, the catalog beside the plugin and
// Coda's own protocols (`defined`, as usesMissing takes them). A Level above this Coda's is Coda's to catch up with
// (`coda`); short of that, a channel it is not for, a key of `contributes` Coda retired, or a protocol or permission group
// it uses or a protocol it implements that is not here, is the plugin's to update (`update`): Coda no longer offers what it
// was made for.
export function compatibility(plugin, { catalog = new Map(), defined = () => null, ...here }) {
  const own = ownIncompatibility(plugin, here);
  if (own) return own;
  const used = usesMissing(plugin, catalog, defined), missing = used ?? implementsMissing(plugin, catalog, defined);
  if (!missing) return null;
  const { protocol, group } = missing, coda = protocol.startsWith('coda/');
  const error = group ? (coda ? `本机的 Coda 已不提供 ${protocol} 的权限组 ${group}，插件需要更新` : `协议 ${protocol} 已没有权限组 ${group}，插件需要更新`)
    : coda ? `本机的 Coda 已不提供协议 ${protocol}，插件需要更新` : `${used ? '用到' : '实现'}的协议 ${protocol} 不在这台机器上，也不随它一起装`;
  return { need: 'update', missing, error };
}
// What of that a plugin answers by itself, whatever else is here: the API Level it needs, the channels it is for, the keys of
// `contributes` Coda retired it still writes (`retired`).
export function ownIncompatibility(plugin, { level = API_LEVEL, channel = null }) {
  const wanted = plugin.engines?.coda ?? 0;
  if (wanted > level) return { need: 'coda', missing: { level: wanted }, error: `这个版本要 Coda API Level ≥ ${wanted}（本机 ${level}），请先升级 Coda` };
  const retired = plugin.retired?.[0];
  if (retired) return { need: 'update', missing: { contribution: retired }, error: `本机的 Coda 已不提供 contributes.${retired}，插件需要更新` };
  const channelProblem = pluginChannelProblem(plugin, channel);
  return channelProblem ? { need: 'update', missing: { channel }, error: channelProblem } : null;
}
// The same for installing `id`, `here` this machine but for the catalog (`catalog`: the catalog once it and what comes along are installed; `installed`: the
// installed rows by ID): it, and what it needs that this machine has not installed, that one named. Those installed
// already are the catalog's to judge (components/plugins/plugins.mjs refresh). One needed and nowhere is said missing, not here.
export function installingIncompatibility(catalog, installed, id, here) {
  for (const each of withDependencies(catalog, id)) {
    if ((each !== id && installed.has(each)) || !catalog.has(each)) continue;
    const found = compatibility(catalog.get(each), { ...here, catalog });
    if (found) return each === id ? found : { ...found, error: `${each}：${found.error}` };
  }
  return null;
}
// Whether plugin `plugin` (its catalog entry) defines kind `kind` or implements it: what it may reach of it and the events it may publish.
export const ownsProtocol = (plugin, kind) =>
  (plugin.protocols ?? []).some(one => one.name === kind) || (plugin.protocolImplementations ?? []).some(one => one.kind === kind);
// What an event is about: `<kind>:<ID>`, at most 500 characters.
const SUBJECT = /^(?=.{3,500}$)[a-z][a-z0-9_-]*:\S+$/;
// Why plugin `plugin` (its catalog entry) may not publish (by `how`: publish-event, coda event) event `name`
// about `subject`, saying `payload`, or null — `event` the event of that name on this machine (components/protocols/
// protocol-events.mjs), or none: it is one of a protocol the plugin defines or implements and not Coda's own (`codaOnly`:
// application/host-protocols.mjs; a plugin implementing coda/thread@1 publishes no session's), about a subject it names (not a
// session's: `thread:` is Coda's), saying a JSON object its payload schema has, no more than 100 KB of it and nothing of
// `coda` (Coda's, beside it in a run). Where it is published is the backend's to check, as the backend checks the rest.
export function publishedProblem(how, plugin, event, { name, subject, payload }) {
  if (!event || !ownsProtocol(plugin, event.kind)) return `插件 ${plugin.id} 定义或实现的协议里没有事件 ${name}`;
  if (event.codaOnly) return `插件 ${plugin.id} 不能发布事件 ${name}：它是 Coda 自己的协议 ${event.kind} 的，只由 Coda 发布`;
  if (typeof subject !== 'string' || !SUBJECT.test(subject) || subject.startsWith('thread:'))
    return `${how} 的 subject 须为「<种类>:<标识>」（如 pull_request:<地址>），不超过 500 个字符；thread: 是会话的，由 Coda 发布`;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return `${how} 的 payload 须为 JSON 对象`;
  if (JSON.stringify(payload).length > 100_000) return `${how} 的 payload 不能超过 100 KB`;
  if (Object.hasOwn(payload, 'coda')) return `${how} 的 payload 顶层不能有 coda，那是 Coda 的`;
  const problem = payloadProblem(event, payload);
  return problem && `${how} 的 payload ${problem}`;
}
// The events plugin `plugin` (its catalog entry) subscribes to: those of the event groups it uses of the protocols this
// machine has with `plugins` (the catalog) and Coda's own (`defined`, as `protocolDefinition` takes them). What its module
// may handle (`coda.on`), as the backend delivers them (./plugin-events.mjs) and the plugin host for a plugin's tests has it.
export function subscribed(plugin, plugins, defined) {
  return Object.entries(plugin.uses ?? {}).flatMap(([kind, groups]) => {
    const permissions = protocolDefinition(kind, plugins, defined)?.permissions ?? {};
    return groups.flatMap(group => permissions[group]?.events ?? []);
  });
}
// Why plugin `plugin` (its catalog entry) may not reach kind `kind` as `need` says — an operation of it (`{ operation }`),
// a stream of its records (`{ stream }`), or reading its records (`'read'`; writing them is the implementer's alone) —
// `definition` its protocol's (`protocolDefinition`), or null (docs/plugins.md「用到的权限」). The plugin that implements or
// defines the kind may, but for a kind Coda alone keeps (record-rules.mjs `LOCAL_KINDS`: its records Coda's own, no
// plugin's), which a plugin saying it implements it does not make its; any other, a built-in one too, only by a group of
// the kind's it uses that has the operation or the stream, or reads its records. An operation or a stream in no group is
// open to no plugin. `owned` false: by its uses alone, implementing or defining the kind not counted.
export function usesRefusal(plugin, kind, need, definition, owned = true) {
  if (owned && !LOCAL_KINDS.has(kind) && ownsProtocol(plugin, kind)) return null;
  const groups = Object.entries(definition?.permissions ?? {}), used = new Set(plugin.uses?.[kind] ?? []);
  const covers = ([, group]) => typeof need === 'string' ? group[need] === true
    : need.stream !== undefined ? (group.streams ?? []).includes(need.stream) : (group.operations ?? []).includes(need.operation);
  if (groups.some(entry => used.has(entry[0]) && covers(entry))) return null;
  const what = typeof need === 'string' ? `读 ${kind} 的记录` : need.stream !== undefined ? `读 ${kind} 的流 ${need.stream}` : `调 ${kind} 的操作 ${need.operation}`;
  const group = groups.find(covers)?.[0];
  return group ? `插件 ${plugin.id} 要${what}，须在清单的 uses 里写 ${kind} 的权限组 ${group}`
    : `插件 ${plugin.id} 不能${what}：它不在 ${kind} 的任何权限组里，不对插件开放`;
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
// The store reads registry metadata; installation reads the package itself. Both judge it so (compatibility).
export function pluginChannelProblem(plugin, channel) {
  if (plugin.coda === undefined) return null;
  const problem = valueProblem('plugin.json#/properties/coda', plugin.coda, 'coda');
  if (problem) return problem;
  const channels = plugin.coda.channels;
  if (!channels || channels.includes(channel)) return null;
  const names = channels.map(value => value === 'preview' ? '预览版' : '正式版').join('或');
  return `此插件仅支持 Coda ${names}后端${channel ? '' : '，当前后端没有发布通道记录'}`;
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
