// How one plugin builds on another (docs/plugins.md「依赖与扩展点」): it names the plugins it needs (`extensionDependencies`), and
// may plug into a point one of them declares for it (`contributes.extensionPoints` there, `contributes.extensions` here).
// Coda checks the names and hands each plugin what is plugged into its points, as declared: what passes between the two
// is the extended plugin's own contract, which Coda neither reads nor shapes. A point may instead take what any plugin
// writes under a key of its `contributes` (`contributes` there, as the resources plugin's `panels`): kept as written, for
// the declaring plugin to read, only the commands in it listed where installing confirms them.
import { requireCondition as check } from '../../domain/errors.mjs';

const ID = /^[a-z][a-z0-9-]{0,39}$/;
const POINT = /^[a-z][a-z0-9-]{0,39}$/;
const DESCRIPTION = 200, COMMAND = 4000, TITLE = 20, LABEL = 40;
// A key of `contributes` a point takes, and where in each thing written there a command is (`*`: every key, or element).
const OFFER = /^[a-z][A-Za-z0-9]{0,39}$/, PATH = /^(\*|[A-Za-z][A-Za-z0-9]{0,39})(\.(\*|[A-Za-z][A-Za-z0-9]{0,39})){0,7}$/;
const code = 'invalid_plugin';
const object = (value, where) => check(value && typeof value === 'object' && !Array.isArray(value), code, `${where} 须为对象`);
const keys = (value, allowed, where) => {
  const extra = Object.keys(value).filter(k => !allowed.includes(k));
  check(!extra.length, code, `${where} 里有 Coda 不支持的键：${extra.join('、')}`);
};
const line = (value, max, where) => {
  check(typeof value === 'string' && value.trim() && [...value].length <= max && !/[\0\r\n]/.test(value), code, `${where} 须为不超过 ${max} 字的一行文本`);
  return value;
};

// `extensionDependencies` (VS Code's name: `dependencies` is npm's): the IDs of the plugins this one needs installed, which installing it installs first.
export function dependencyDeclarations(raw, self) {
  if (raw === undefined) return [];
  check(Array.isArray(raw) && raw.every(id => typeof id === 'string' && ID.test(id)) && new Set(raw).size === raw.length, code,
    'extensionDependencies 须为插件 ID 的数组，不重复');
  check(!raw.includes(self), code, 'extensionDependencies 不能写自己');
  return [...raw];
}
// `contributes.extensionPoints`: name → `{ description }`, what others may plug in here; with `contributes`, the key of
// `contributes` any plugin writes it under (none of Coda's own, `reserved`), what one thing written there is called
// (`title`), and where in each a command is, with what it is for (`commands`: path → label).
export function extensionPointDeclarations(raw, reserved = []) {
  if (raw === undefined) return {};
  object(raw, 'contributes.extensionPoints');
  // A key is one point's, of this plugin as of any other (plugin-source-rules.mjs claims).
  const taken = new Map();
  return Object.fromEntries(Object.entries(raw).map(([name, value]) => {
    const where = `contributes.extensionPoints.${name}`;
    check(POINT.test(name), code, `${where}：扩展点名只能用小写字母、数字和「-」，以字母开头`);
    object(value, where); keys(value, value.contributes === undefined ? ['description'] : ['description', 'contributes', 'title', 'commands'], where);
    const description = line(value.description, DESCRIPTION, `${where} 的 description`);
    if (value.contributes === undefined) return [name, { description }];
    check(typeof value.contributes === 'string' && OFFER.test(value.contributes), code, `${where} 的 contributes 须为字母和数字组成、以小写字母开头的键名`);
    check(!reserved.includes(value.contributes), code, `${where} 的 contributes：${value.contributes} 是 Coda 自己的贡献`);
    check(!taken.has(value.contributes), code, `${where} 的 contributes：${value.contributes} 已由扩展点 ${taken.get(value.contributes)} 声明`);
    taken.set(value.contributes, name);
    const commands = value.commands ?? {};
    object(commands, `${where} 的 commands`);
    for (const [path, label] of Object.entries(commands)) {
      check(PATH.test(path), code, `${where} 的 commands：${path} 须为以「.」连接的键名或「*」`);
      line(label, LABEL, `${where} 的 commands.${path}`);
    }
    return [name, { description, contributes: value.contributes, title: line(value.title, TITLE, `${where} 的 title`), commands: { ...commands } }];
  }));
}
// What a plugin writes under the keys of `contributes` that are not Coda's own (`reserved`), as written: each for the
// point that takes it, which the catalog checks there is (checkCatalog).
export function offerDeclarations(contributes = {}, reserved = []) {
  const offers = Object.entries(contributes ?? {}).filter(([key]) => !reserved.includes(key));
  for (const [key] of offers) check(OFFER.test(key), code, `contributes 里有 Coda 不支持的贡献：${key}`);
  return Object.fromEntries(offers);
}
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
// `contributes.extensions`: `<plugin>/<point>` → `{ command }`, plugged into a point of a plugin it depends on.
export function extensionDeclarations(raw, dependencies) {
  if (raw === undefined) return [];
  object(raw, 'contributes.extensions');
  return Object.entries(raw).map(([key, value]) => {
    const where = `contributes.extensions.${key}`, [plugin, point, ...rest] = key.split('/');
    check(ID.test(plugin ?? '') && POINT.test(point ?? '') && !rest.length, code, `${where}：须写成「插件 ID/扩展点名」`);
    check(dependencies.includes(plugin), code, `${where}：只能接所依赖的插件的扩展点，先把 ${plugin} 写进 extensionDependencies`);
    object(value, where); keys(value, ['command'], where);
    return { plugin, point, command: line(value.command, COMMAND, `${where} 的 command`) };
  });
}

// The catalog as a whole: every plugin needed is there, nothing needs itself round about, every point plugged into is
// one its plugin declares, and what is written under a key of `contributes` not Coda's own a point takes.
export function checkCatalog(plugins) {
  for (const plugin of plugins.values()) {
    for (const id of plugin.dependencies) check(plugins.has(id), code, `插件 ${plugin.id} 依赖的 ${id} 不在 Coda 里`);
    for (const e of plugin.extensions) check(Object.hasOwn(plugins.get(e.plugin).extensionPoints, e.point), code,
      `插件 ${plugin.id} 接的 ${e.plugin}/${e.point} 不是 ${e.plugin} 声明的扩展点`);
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
// Why what a plugin writes under the keys of `contributes` not Coda's own cannot be taken here (`plugins`: the catalog
// beside it), or null: no point takes one of them.
export function offerProblem(plugin, plugins) {
  const others = new Map([...plugins, [plugin.id, plugin]]);
  const unknown = Object.keys(plugin.offers ?? {}).filter(key => !offerPoint(others, key));
  return unknown.length ? `contributes 里有 Coda 不支持的贡献：${unknown.join('、')}` : null;
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
