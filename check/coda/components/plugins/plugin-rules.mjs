// Plugins (docs/plugins.md): what Coda installs once for every project, the way VS Code installs an extension. A plugin
// is a directory with a VS Code style `package.json`, and the workflows it brings in `.coda/workflows/`. What it may write
// there is the schemas' to say (plugin-schema.mjs, schemas/): each key of `contributes` is a type with a JSON Schema of its
// own, and a manifest is right when it is of the types it names. This module reads one that is into what Coda keeps of it:
// its settings (`contributes.configuration`, declared in JSON Schema), with a value for every project (the plugin's
// settings) that a project may override, as user and workspace settings do in VS Code, which workflows read as `vars`
// (`=vars.…`); and what else it brings, each as its schema has it. Besides the schemas only two things are said here,
// both of the plugin's identity: the ID it has (its manifest's `id`, else its package name, else the one its npm name
// gives), and that its settings are named under it.
// A secret (`writeOnly`) is a text written and never read back, kept in a file beside the database and given to the
// plugin's processes as that file's path (`CODA_PLUGIN_SECRETS`).
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, normalize, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { settings as agentSettings } from '../session-config/commands.mjs';
import { requireCondition as check, ContractError } from '../../domain/errors.mjs';
import { isDuration } from '../../domain/duration.mjs';
import { AGENT_ID } from '../../domain/values.mjs';
import { agentDeclarations } from './agent-plugins.mjs';
import { checkCatalog, extensionsFor } from './plugin-extensions.mjs';
import { manifestProblem, TYPES, valueProblem } from './plugin-schema.mjs';
import { claims, COMMIT, INTEGRITY, NPM_VERSION, npmPluginId, repoAddress, sourcePath } from './plugin-source-rules.mjs';
import { readSkillDocument } from './skill-document.mjs';
import { executorLabels } from '../workflows/executor-labels.mjs';

const ID = /^[a-z][a-z0-9-]{0,39}$/;
// The domains of the events Coda publishes itself; a plugin's are of a domain of its own (schemas/events.json).
export const CODA_EVENT_DOMAINS = ['workflow', 'session', 'user'];
// Plugins that ship with Coda, as VS Code's built-in extensions ship with it: updated with Coda itself.
export const BUILTIN_DIR = fileURLToPath(new URL('../../resources/plugins/', import.meta.url));
// The package the backend runs from (the runtime clone's, or the release's), whose npm dependencies may be built-in plugins
// too (dependencyPlugins).
const PACKAGE_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
// What a plugin may contribute to Coda itself, the types schemas/plugin.json names; anything else in `contributes` is for
// a point another plugin declares to take it (the resources plugin's `panels`), refused when none does.
export const CONTRIBUTES = TYPES;
export const MODEL_PROVIDER = /^[a-z][a-z0-9-]{0,39}\/[a-z][a-z0-9-]{0,39}$/;
// How many model services a setting of several may name.
const MODEL_PROVIDERS_AT_MOST = 20;
// How many rows a list of them holds.
const ROWS_AT_MOST = 50;

// ---- Declarations ----
// A setting as Coda reads its declaration (schemas/setting.json): a scalar, a choice of several among fixed options
// (`options`), several model services (`format: coda-model-provider`, with the interfaces it takes), a list of rows
// (`rows`), a row of named columns (`columns`), or a table whose entries all share one declaration (`entries`, its row
// names `coda-agent-match` when `keys` says so). Option labels and descriptions are kept when there is one for each option.
// Its default is a value of it, checked as any value is (checkValue).
function setting(value, where) {
  const labels = list => Array.isArray(list) && value.enum && list.length === value.enum.length && list.every(d => typeof d === 'string');
  const out = { type: value.type, ...(value.format ? { format: value.format } : {}), ...(value.enum ? { enum: value.enum } : {}),
    ...(labels(value.enumItemLabels) ? { enumItemLabels: value.enumItemLabels } : {}), ...(labels(value.enumDescriptions) ? { enumDescriptions: value.enumDescriptions } : {}),
    ...(value.minimum !== undefined ? { minimum: value.minimum } : {}), ...(value.maximum !== undefined ? { maximum: value.maximum } : {}),
    ...(value.description !== undefined ? { description: value.description } : value.markdownDescription !== undefined ? { description: value.markdownDescription } : {}),
    ...(value.title !== undefined ? { title: value.title } : {}), ...(value.order !== undefined ? { order: value.order } : {}),
    ...(value.writeOnly ? { writeOnly: true } : {}),
    ...(value.modelKey !== undefined ? { modelKey: value.modelKey } : {}), ...(value.modelApi !== undefined ? { modelApi: value.modelApi } : {}) };
  if (value.type === 'array' && value.items.format === 'coda-model-provider') {
    out.format = 'coda-model-provider';
    if (value.items.modelApis) out.modelApis = [...new Set(value.items.modelApis)];
  } else if (value.type === 'array' && value.items.type === 'object') out.rows = setting(value.items, `${where}.items`);
  else if (value.type === 'array') out.options = value.items.anyOf.map(option => ({ value: option.const,
    ...(option.title ? { title: option.title } : {}), ...(option.description ? { description: option.description } : {}) }));
  else if (value.type === 'object' && value.properties) {
    out.columns = Object.fromEntries(Object.entries(value.properties).map(([name, column]) => [name, setting(column, `${where}.properties.${name}`)]));
    if (value.required?.length) out.required = [...value.required];
  } else if (value.type === 'object' && value.format !== 'coda-agent') {
    out.entries = setting(value.additionalProperties, `${where}.additionalProperties`);
    if (value.propertyNames) out.keys = 'coda-agent-match';
  }
  if (value.default !== undefined) out.default = checkValue(out, value.default, `${where} 的默认值`, 'invalid_plugin');
  return out;
}

// What a plugin tells a session's agent at once (docs/session-contracts.md「顺带告诉」): a text, at most this long.
const TELL_LIMIT = 4000;
export const checkTold = text => check(typeof text === 'string' && text.trim() && text.length <= TELL_LIMIT && !text.includes('\0'), 'invalid_input',
  `要告诉的话须为不超过 ${TELL_LIMIT} 字的文字`);
// The modes a composer can be put in (docs/plugins.md「输入框模式」, schemas/composer-modes.json), each with the composers
// that offer it (`in`, a session's by default) and whom what is sent is for (`agent`, the session's by default); its
// parameters read as settings are, and as written (JSON Schema), which its hooks are given (components/composer-modes).
const MODE_PLACES = ['session', 'new'];
const composerModes = (modes = []) => modes.map((m, i) => ({ id: m.id, title: m.title.trim(), icon: m.icon,
  ...(m.hint ? { hint: m.hint.trim() } : {}), ...(m.placeholder ? { placeholder: m.placeholder.trim() } : {}),
  ...(m.sendLabel ? { sendLabel: m.sendLabel.trim() } : {}), agent: m.agent ?? 'session', ...(m.trigger ? { trigger: m.trigger } : {}),
  in: m.in ? MODE_PLACES.filter(place => m.in.includes(place)) : ['session'],
  ...(m.parameters !== undefined ? { parameters: parametersOf(m.parameters, `contributes.composerModes[${i}].parameters`), schema: structuredClone(m.parameters) } : {}) }));
// A mode's parameters as read: each a setting, in the order written, which the clients show them in (JSON's objects keep
// none of their own there); what it cannot go without, `required`.
function parametersOf(value, where) {
  const ordered = fields => Object.fromEntries(Object.entries(fields).map(([name, spec], i) => [name, { ...spec, order: spec.order ?? i }]));
  const properties = Object.fromEntries(Object.entries(value.properties).map(([name, p], i) => {
    const read = setting(p, `${where}.properties.${name}`);
    return [name, { ...read, ...(read.rows ? { rows: { ...read.rows, columns: ordered(read.rows.columns) } } : {}), order: read.order ?? i }];
  }));
  return { properties, ...(value.required?.length ? { required: [...value.required] } : {}) };
}
// Parameters a mode's hook gives while it runs, checked against the same schema a manifest's are.
export function modeParameters(value, where) {
  const problem = valueProblem('composer-modes.json#/$defs/parameters', value, where);
  check(!problem, 'invalid_plugin', problem);
  return parametersOf(value, where);
}

// The category it is listed under (docs/plugins.md「商店」): the first of its manifest's `categories`, as VS Code's are
// written; empty when it names none.
export const manifestCategory = manifest => Array.isArray(manifest?.categories) && typeof manifest.categories[0] === 'string' ? manifest.categories[0].trim().slice(0, 32) : '';
// A plugin as its directory declares it. `id` is the one its manifest says (for a package whose name cannot be one: a scoped
// package's, docs/plugins.md「插件的内容」), else its package name; a package from npm's without one, whatever npm calls it,
// the ID its name gives (docs/plugins.md「从 npm 安装」): its package.json is not changed, for what it imports of itself.
export function readPlugin(dir, source) {
  let manifest;
  try { manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')); }
  catch (e) { throw new ContractError('invalid_plugin', `${dir} 没有可读的 package.json：${e.message}`); }
  check(manifest && typeof manifest === 'object' && !Array.isArray(manifest), 'invalid_plugin', 'package.json 须为对象');
  const problem = manifestProblem(manifest, dir);
  check(!problem, 'invalid_plugin', problem);
  const named = manifest.id !== undefined;
  let id = named ? manifest.id : manifest.name;
  if (!named && source?.package && typeof manifest.name === 'string') try { id = npmPluginId(manifest.name); } catch {}
  check(typeof id === 'string' && ID.test(id), 'invalid_plugin', `package.json 的 ${named ? 'id' : 'name'} 只能用小写字母、数字和「-」`);
  const contributes = manifest.contributes ?? {}, configuration = contributes.configuration ?? {};
  const properties = Object.fromEntries(Object.entries(configuration.properties ?? {}).map(([key, value]) => {
    check(key.split('.')[0] === id, 'invalid_plugin', `设置名须以「${id}.」开头：${key}`);
    return [key, setting(value, key)];
  }));
  const files = sub => existsSync(join(dir, sub)) ? [...new Set(readdirSync(join(dir, sub)).map(f => /^(.+)\.bpmn$/.exec(f)?.[1]).filter(Boolean))].sort() : [];
  const required = configuration.required ?? [], activation = manifest.activationEvents ?? [], dependencies = manifest.extensionDependencies ?? [];
  const displayName = typeof manifest.displayName === 'string' ? manifest.displayName : id;
  // What it writes under keys of `contributes` that are none of Coda's: for the points other plugins declare (checkCatalog).
  const offers = Object.fromEntries(Object.entries(contributes).filter(([key]) => !TYPES.includes(key)));
  return { id, displayName, description: typeof manifest.description === 'string' ? manifest.description : '', version: String(manifest.version ?? ''),
    category: manifestCategory(manifest), source, dir, title: typeof configuration.title === 'string' ? configuration.title : displayName, properties,
    ...(manifest.main ? { main: posix.normalize(manifest.main) } : {}), ...(activation.includes('onStartupFinished') ? { startup: true } : {}),
    ...(required.length ? { required: [...required] } : {}), workflows: files('.coda/workflows'),
    capabilities: [...(contributes.capabilities ?? [])].sort(), services: [...(contributes.services ?? [])],
    groups: (contributes.groups ?? []).map(g => ({ name: g.name, capacity: g.capacity })),
    commands: (contributes.commands ?? []).map(c => ({ name: c.name, command: c.command })),
    ...(contributes.events?.length ? { events: contributes.events.map(e => ({ name: e.name, starts: e.starts !== false, ...(e.ends ? { ends: true } : {}) })) } : {}),
    gitCredentials: (contributes.gitCredentials ?? []).map(c => ({ url: c.url, command: c.command })),
    endpoints: (contributes.endpoints ?? []).map(e => ({ id: e.id, command: e.command, ...(e.checks ? { checks: e.checks } : {}) })),
    // The entry as one path in its directory (`./view/a.html`, `view//a.html` are `view/a.html`): the clients load it by that.
    views: (contributes.views ?? []).map(v => ({ id: v.id, title: v.title, entry: posix.normalize(v.entry), ...(v.in?.length ? { in: [...v.in] } : {}),
      ...(v.icon ? { icon: v.icon } : {}), ...(v.handles?.length ? { handles: [...v.handles] } : {}), ...(v.readout ? { readout: v.readout } : {}),
      ...(v.checkout ? { checkout: v.checkout } : {}) })),
    ...(contributes.composerModes?.length ? { composerModes: composerModes(contributes.composerModes) } : {}),
    ...(Object.keys(offers).length ? { offers } : {}),
    agents: agentDeclarations(contributes.agents, dir),
    dependencies: [...dependencies], extensionPoints: extensionPoints(contributes.extensionPoints),
    extensions: Object.entries(contributes.extensions ?? {}).map(([key, value]) => { const [plugin, point] = key.split('/'); return { plugin, point, command: value.command }; }),
    ...(contributes.instructions ? { instructions: contributes.instructions.trim() } : {}), ...(contributes.setup ? { setup: { command: contributes.setup.command } } : {}),
    ...(contributes.skills?.length ? { skills: skills(contributes.skills, dir) } : {}),
    ...(Object.keys(contributes.environment ?? {}).length ? { environment: Object.entries(contributes.environment).map(([name, value]) => ({ name, value })) } : {}),
    ...(contributes.path?.length ? { path: contributes.path.map(entry => pathEntry(entry)) } : {}),
    ...(contributes.mcpServers && Object.keys(contributes.mcpServers).length ? { mcpServers: Object.entries(contributes.mcpServers).map(([name, server]) => ({ name,
      command: server.command, args: [...(server.args ?? [])], env: Object.entries(server.env ?? {}).map(([variable, value]) => ({ name: variable, value })) })) } : {}),
    ...(contributes.modelProviders?.length ? { modelProviders: contributes.modelProviders.map(p => ({ id: p.id, title: p.title.trim(), api: p.api, url: p.url,
      ...(p.key ? { key: /^\$\{config:([^}]+)\}$/.exec(p.key)[1] } : {}) })) } : {}),
    ...(contributes.executors?.length ? { executors: contributes.executors.map(e => ({ id: e.id, title: e.title.trim(),
      labels: executorLabels(e.labels, `执行环境 ${e.id} 的 labels`, 'invalid_plugin'), command: e.command })) } : {}),
    ...(contributes.repositories ? { repositories: { command: contributes.repositories.command } } : {}) };
}
// Its extension points (schemas/extension-points.json), each with what it says of itself.
const extensionPoints = (raw = {}) => Object.fromEntries(Object.entries(raw).map(([name, value]) => [name, value.contributes === undefined
  ? { description: value.description } : { description: value.description, contributes: value.contributes, title: value.title, commands: { ...(value.commands ?? {}) } }]));
// The directories it puts on the PATH of what starts in a project it applies to: one of its own (relative, as a Skill's),
// or one in its state on the backend (`${CODA_PLUGIN_STATE}/…`), which its setup may make.
function pathEntry(entry) {
  const state = /^\$\{CODA_PLUGIN_STATE\}(\/.*)?$/.exec(entry);
  const relative = normalize(state ? `.${state[1] ?? ''}` : entry).replace(/\/$/, '');
  if (state) return relative === '.' ? '${CODA_PLUGIN_STATE}' : `\${CODA_PLUGIN_STATE}/${relative}`;
  return relative;
}
// Whether a plugin chooses model services (a setting, or a column of a table's rows, of format `coda-model-provider`): its
// processes are told those of this machine (CODA_MODEL_PROVIDERS).
export const choosesModelProviders = plugin => Object.values(plugin.properties).some(spec => spec.format === 'coda-model-provider'
  || spec.entries?.format === 'coda-model-provider' || Object.values(spec.entries?.columns ?? {}).some(column => column.format === 'coda-model-provider'));
// A model service of a plugin as its settings for every project make it (resolveSettings): its address with what it names
// filled in, none while a setting it names has no value or it comes to nothing.
export function modelProviderAddress(provider, values) {
  const url = filler({}, values)(provider.url);
  return url && url.trim() ? url.trim() : null;
}
// A plugin's environment variables and PATH as they are for one project: its settings there (`settings`), its directory and
// its state on this backend (`state`, null without one). A value naming a setting with none, or its state without one, is
// not given; nor is a directory in a state there is not.
const PLACE = /\$\{([^}]*)\}/g;
// A value with what it names filled in, or null when one of them has none.
const filler = (places, settings) => value => {
  let missing = false;
  const filled = value.replace(PLACE, (_, place) => {
    const setting = /^config:(.+)$/.exec(place)?.[1], found = setting ? settings[setting] : places[place];
    if (found === null || found === undefined) missing = true;
    return String(found ?? '');
  });
  return missing ? null : filled;
};
export function launchValues(plugin, settings, state) {
  const fill = filler({ CODA_PLUGIN_PATH: plugin.dir, CODA_PLUGIN_STATE: state }, settings);
  return { variables: (plugin.environment ?? []).map(({ name, value }) => ({ name, value: fill(value) })).filter(each => each.value !== null),
    path: (plugin.path ?? []).map(entry => entry.startsWith('${') ? fill(entry) : join(plugin.dir, entry)).filter(Boolean) };
}
// A plugin's MCP servers as they are for one project, as ACP has them (`env` a list of names and values): what each runs with
// what it names filled in, given what every process of the plugin is (`base`, components/plugins/plugins.mjs env) and the
// variables it declares, as `launchValues` gives them. One naming its state on a backend without one is not given.
export function mcpValues(plugin, settings, state, base) {
  const fill = filler({ CODA_PLUGIN_PATH: plugin.dir, CODA_PLUGIN_STATE: state, CODA_NODE: process.execPath }, settings);
  return (plugin.mcpServers ?? []).flatMap(server => {
    const command = fill(server.command), args = server.args.map(fill);
    if (command === null || args.includes(null)) return [];
    const env = { ...base };
    for (const { name, value } of server.env) { const filled = fill(value); if (filled !== null) env[name] = filled; }
    return [{ name: server.name, command, args, env: Object.entries(env).map(([name, value]) => ({ name, value })) }];
  });
}
// The Agent Skills it brings (docs/plugins.md「Skills」): directories of its own, each with its SKILL.md, named after the
// directory as the agents find them. They are laid into the working copy of each project it applies to.
export const SKILL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
function skills(raw, dir) {
  return raw.map(path => {
    const relative = normalize(path).replace(/\/+$/, ''), name = relative.split('/').at(-1);
    const skill = { name, path: join(dir, relative) };
    // Descriptions are for browsing only; a missing or unreadable document is explained when opened.
    try { skill.description = readSkillDocument({ dir, skills: [skill] }, name).description; } catch { /* Keep the declaration. */ }
    return skill;
  });
}
// The plugins Coda ships: those in `dir`, which come from nowhere else, and its npm dependencies that are plugins
// (`dependencies`), each with where it comes from, which a version from that same place may stand in for (docs/plugins.md
// 「内置插件的来源」).
export function builtinPlugins(dir = BUILTIN_DIR, dependencies = dir === BUILTIN_DIR ? dependencyPlugins() : new Map()) {
  const plugins = new Map((existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : []).filter(d => d.isDirectory()).map(d => {
    const plugin = readPlugin(join(dir, d.name), { kind: 'builtin' });
    return [plugin.id, plugin];
  }));
  for (const [id, plugin] of dependencies) {
    check(!plugins.has(id), 'invalid_plugin', `插件 ${id} 同时存在于资源目录与 npm 依赖`);
    plugins.set(id, plugin);
  }
  // An agent, a group and Git's credentials for an address are one plugin's (components/plugins/plugin-source-rules.mjs claims).
  const owner = new Map();
  for (const plugin of plugins.values()) for (const claim of claims(plugin)) {
    check(!owner.has(claim), 'invalid_plugin', `插件 ${owner.get(claim)} 与 ${plugin.id} 都声明了 ${claim}`);
    owner.set(claim, plugin.id);
  }
  return checkCatalog(plugins);
}
// A direct npm dependency declaring `contributes` is a bundled plugin (docs/plugins.md「npm 依赖中的插件」). npm installs its
// files and dependencies; where it comes from is what the dependency pins: a version of a package from the registry, with
// the integrity package-lock.json has of its tarball and the repository directory the package says it is published from,
// or a commit of a Git repository. Installed from the start, unless `coda.optionalPlugins` of the backend's package.json
// names it.
export function dependencyPlugins(root = PACKAGE_ROOT) {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')), plugins = new Map();
  const optional = new Set(manifest.coda?.optionalPlugins ?? []);
  let lock;
  for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
    const dir = join(root, 'node_modules', name), pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    if (!Object.hasOwn(pkg, 'contributes')) continue;
    let source;
    if (typeof spec === 'string' && NPM_VERSION.test(spec)) {
      lock ??= JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')).packages ?? {};
      const integrity = lock[`node_modules/${name}`]?.integrity;
      check(typeof integrity === 'string' && INTEGRITY.test(integrity), 'invalid_plugin', `package-lock.json 里没有插件依赖 ${name} 的 sha512 完整性摘要`);
      source = { kind: 'builtin', package: name, tag: 'latest', version: spec, integrity, ...publishedFrom(pkg.repository) };
    } else {
      const git = typeof spec === 'string' && /^git\+(.+)#([^#]+)$/.exec(spec);
      check(git && COMMIT.test(git[2]), 'invalid_plugin', `插件依赖 ${name} 须写一个版本号，或用 Git 仓库地址与完整提交号固定版本`);
      source = { kind: 'builtin', repo: repoAddress(git[1]), path: '', commit: git[2] };
    }
    const plugin = readPlugin(dir, source);
    check(!plugins.has(plugin.id), 'invalid_plugin', `多个 npm 依赖声明了插件 ${plugin.id}`);
    plugins.set(plugin.id, { ...plugin, defaultInstalled: !optional.has(name) });
  }
  return plugins;
}
// The repository directory a package says it is published from (`repository`: its address, and `directory` in it), as a
// source names one; nothing where it says none Coda reads.
export function publishedFrom(repository) {
  const url = typeof repository === 'string' ? repository : repository?.url;
  try { return { repo: repoAddress(typeof url === 'string' ? url.replace(/^git\+/, '') : ''), path: sourcePath(repository?.directory ?? '') }; }
  catch (e) { if (e.code !== 'invalid_input') throw e; return {}; }
}

// ---- Its processes ----
// What Coda gives each process it runs for a plugin (docs/plugins.md「插件进程的环境」) — its agents', its panels', the steps
// of its workflows, the commands it puts on sessions' PATH —, beside the environment the process runs in: Coda's own Node,
// the plugin's directory and its state on this backend (`stateDir(id)`, none without one), its settings as they apply
// (`settings`), what installed plugins plug into its points and where the plugins it depends on are, whose files (an npm
// package one of them brings) it may use, none of either when there is none; the files its secrets set there are in
// (`secrets`, by setting), none when none is; whether this backend is its environment's own (`arbiter`); and the PATH
// without Coda's own directories, for what it hands to a program that is not Coda's (`userPath`, adapters/installation.mjs).
export const PLUGIN_VARIABLES = ['CODA_NODE', 'CODA_ARBITER', 'CODA_PLUGIN_PATH', 'CODA_PLUGIN_STATE', 'CODA_PLUGIN_SETTINGS', 'CODA_PLUGIN_SECRETS',
  'CODA_PLUGIN_EXTENSIONS', 'CODA_PLUGIN_DEPENDENCIES', 'CODA_MODEL_PROVIDERS', 'CODA_USER_PATH'];
// `providers`: the model services of this machine, for a plugin that chooses them (choosesModelProviders); none for any other.
export function pluginEnv({ catalog, installed, id, stateDir = () => null, settingsOf = () => null, settings, secrets = {}, providers = null, arbiter = false, userPath = null }) {
  const plugin = catalog.get(id), state = stateDir(id), points = extensionsFor(catalog, installed, id, stateDir, settingsOf);
  return { CODA_NODE: process.execPath, CODA_PLUGIN_PATH: plugin.dir, ...(state ? { CODA_PLUGIN_STATE: state } : {}),
    ...(userPath !== null ? { CODA_USER_PATH: userPath } : {}),
    CODA_PLUGIN_SETTINGS: JSON.stringify(settings), ...(Object.keys(secrets).length ? { CODA_PLUGIN_SECRETS: JSON.stringify(secrets) } : {}),
    ...(providers ? { CODA_MODEL_PROVIDERS: JSON.stringify(providers) } : {}),
    ...(Object.keys(points).length ? { CODA_PLUGIN_EXTENSIONS: JSON.stringify(points) } : {}),
    ...(plugin.dependencies.length ? { CODA_PLUGIN_DEPENDENCIES: JSON.stringify(Object.fromEntries(plugin.dependencies.map(d => [d, catalog.get(d).dir]))) } : {}),
    ...(arbiter ? { CODA_ARBITER: '1' } : {}) };
}
// What such a process inherits, cleared of what Coda gives it as a plugin's: it never takes another plugin's for its own.
export const cleared = base => Object.fromEntries(Object.entries(base).filter(([name]) => !PLUGIN_VARIABLES.includes(name)));

// ---- Values ----
// `coda-agent-match`: `*` for every session, else agent, model and effort from the left, joined by `|`; each level is
// chosen only after the one before it, so two rows are never equally specific.
export function agentMatch(key) {
  if (key === '*') return { agent: null, model: null, effort: null };
  const parts = typeof key === 'string' ? key.split('|') : [];
  if (!(parts.length >= 1 && parts.length <= 3 && AGENT_ID.test(parts[0]) && parts.every(p => p.length > 0 && p.length <= 200 && !/[\0\n]/.test(p)))) return null;
  return { agent: parts[0], model: parts[1] ?? null, effort: parts[2] ?? null };
}
export const matchSpecificity = key => key === '*' ? 0 : key.split('|').length;
// The most specific row whose levels all equal the session's.
export function pickMatch(entries, session) {
  return Object.keys(entries).map(key => [key, agentMatch(key)]).filter(([, m]) => m &&
    (!m.agent || m.agent === session?.agent) && (!m.model || m.model === session?.model) && (!m.effort || m.effort === session?.effort))
    .sort((a, b) => matchSpecificity(b[0]) - matchSpecificity(a[0]))[0]?.[0] ?? null;
}
// Whether the agent it names is installed is asked where it is used (a review, a step): a setting stays readable while a
// plugin it names is uninstalled.
function agentValue(value, where, code) {
  check(value && typeof value === 'object' && !Array.isArray(value) && typeof value.agent === 'string' && AGENT_ID.test(value.agent), code,
    `${where} 须为 Agent 组合，并指明 Agent`);
  const { agent, ...rest } = value;
  try { return { agent, ...agentSettings(rest) }; } catch (e) { throw new ContractError(code, `${where}：${e.message}`); }
}
// A value as the declaration allows it; returns it normalised.
export function checkValue(spec, value, where, code = 'invalid_input') {
  if (spec.format === 'coda-agent') return agentValue(value, where, code);
  // A whole row, as a table's default has it: its secrets are only ever written one by one, never declared.
  if (spec.columns) {
    check(value && typeof value === 'object' && !Array.isArray(value), code, `${where}须为一行`);
    for (const name of spec.required ?? []) check(Object.hasOwn(value, name) || spec.columns[name].default !== undefined, code, `${where}缺「${spec.columns[name].title ?? name}」`);
    return Object.fromEntries(Object.entries(value).map(([name, v]) => {
      check(own(spec.columns, name) && !spec.columns[name].writeOnly, code, `${where}没有可以这样写的「${name}」：不是本行的列，或是密文`);
      return [name, checkValue(spec.columns[name], v, `${where}「${name}」`, code)];
    }));
  }
  if (spec.type === 'boolean') { check(typeof value === 'boolean', code, `${where}须为开或关`); return value; }
  // Rows in the order written, taken whole: a column not written is its default, as a table's row is resolved (rowValue),
  // so that one a row cannot go without is there.
  if (spec.type === 'array' && spec.rows) {
    check(Array.isArray(value) && value.length <= ROWS_AT_MOST, code, `${where}须为至多 ${ROWS_AT_MOST} 行`);
    const defaults = Object.entries(spec.rows.columns).filter(([, column]) => column.default !== undefined);
    return value.map((row, i) => {
      const checked = checkValue(spec.rows, row, `${where}第 ${i + 1} 行`, code);
      return { ...Object.fromEntries(defaults.map(([name, column]) => [name, column.default])), ...checked };
    });
  }
  // Model services, each once, in the order chosen: one named may be of a plugin not installed (yet), as a single one may.
  if (spec.type === 'array' && spec.format === 'coda-model-provider') {
    check(Array.isArray(value) && value.length <= MODEL_PROVIDERS_AT_MOST && value.every(v => typeof v === 'string' && MODEL_PROVIDER.test(v)), code,
      `${where}须为至多 ${MODEL_PROVIDERS_AT_MOST} 个「插件/服务」，如 cliproxy/cliproxy`);
    return [...new Set(value)];
  }
  // The chosen options, each once, in the declaration's order.
  if (spec.type === 'array') {
    const allowed = spec.options.map(o => o.value);
    check(Array.isArray(value) && value.every(v => typeof v === 'string'), code, `${where}须为选中的几项`);
    const unknown = value.filter(v => !allowed.includes(v));
    check(!unknown.length, code, `${where}只能从这些里选：${allowed.join('、')}（没有 ${unknown.join('、')}）`);
    return allowed.filter(v => value.includes(v));
  }
  if (spec.type === 'integer' || spec.type === 'number') {
    check(typeof value === 'number' && Number.isFinite(value) && (spec.type === 'number' || Number.isInteger(value)), code, `${where}须为${spec.type === 'integer' ? '整数' : '数字'}`);
    check((spec.minimum === undefined || value >= spec.minimum) && (spec.maximum === undefined || value <= spec.maximum), code,
      `${where}须在 ${spec.minimum ?? '-∞'}–${spec.maximum ?? '∞'} 之间`);
  } else if (spec.type === 'string') {
    check(typeof value === 'string' && value.length <= 20000 && !value.includes('\0'), code, `${where}须为文本`);
    check(spec.format !== 'duration' || isDuration(value), code, `${where}须为 ISO 8601 时长，如 P30D、PT6H`);
    // Empty is none chosen; a repository is kept as written, once Git could be given it.
    check(spec.format !== 'coda-directory' || value === '' || value.startsWith('/'), code, `${where}须为绝对目录`);
    if (spec.format === 'coda-repo' && value !== '') try { repoAddress(value); } catch (e) { throw new ContractError(code, `${where}：${e.message}`); }
    // Empty is none chosen; one named may be of a plugin not installed (yet), as an Agent's may.
    check(spec.format !== 'coda-model-provider' || value === '' || MODEL_PROVIDER.test(value), code, `${where}须为「插件/服务」，如 cliproxy/cliproxy`);
  }
  else if (spec.type === 'object') {
    check(value && typeof value === 'object' && !Array.isArray(value), code, `${where}须为表格`);
    return Object.fromEntries(Object.entries(value).map(([k, v]) => {
      check(spec.keys !== 'coda-agent-match' || agentMatch(k), code, `${where}的「${k}」不是有效的作者`);
      return [k, checkValue(spec.entries, v, `${where}「${k}」`, code)];
    }));
  }
  check(!spec.enum || spec.enum.includes(value), code, `${where}只能是：${spec.enum?.join('、')}`);
  return value;
}
// A stored setting: `{ value }`; a table stores its rows that way, each by key, `null` removing a row the declaration's
// default has.
function stored(spec, item, where) {
  check(item && typeof item === 'object' && !Array.isArray(item) && 'value' in item && Object.keys(item).length === 1, 'invalid_input', `${where} 须为 { value }`);
  return { value: checkValue(spec, item.value, where) };
}
// Applies a patch of settings to what is stored. A key set to null goes back to what is below it; a table is patched
// row by row (`{ entries: { key: item | null } }`), where a plugin's null removes a default row and a project's restores
// the plugin's row. A secret is stored only as set (`{ secret: true }`): its text, or null for one cleared, goes to
// `secrets`, for the caller to keep in its file.
export function patchSettings(plugin, current, patch, { project = false, secrets = {} } = {}) {
  check(patch && typeof patch === 'object' && !Array.isArray(patch), 'invalid_input', '需要设置');
  const next = structuredClone(current ?? {});
  for (const [key, item] of Object.entries(patch)) {
    const spec = plugin.properties[key];
    check(spec, 'invalid_input', `插件 ${plugin.id} 没有设置 ${key}`);
    if (item === null) { delete next[key]; if (spec.writeOnly || spec.entries?.columns) secrets[key] = null; continue; }
    if (spec.writeOnly) {
      check(item && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length === 1 && typeof item.value === 'string' && item.value !== '',
        'invalid_input', `${key} 是密文，须为 { value }：不空的文本`);
      secrets[key] = checkValue(spec, item.value, key);
      next[key] = { secret: true };
    } else if (spec.entries) {
      check(item && typeof item === 'object' && Object.keys(item).length === 1 && item.entries && typeof item.entries === 'object', 'invalid_input', `${key} 须为 { entries }`);
      const rows = { ...(next[key]?.entries ?? {}) };
      for (const [row, value] of Object.entries(item.entries)) {
        check(spec.keys !== 'coda-agent-match' || agentMatch(row), 'invalid_input', `「${row}」不是有效的作者`);
        if (value === null) {
          if (project || !Object.hasOwn(spec.default ?? {}, row)) delete rows[row]; else put(rows, row, null);
          if (spec.entries.columns) put(secrets[key] ??= {}, row, null);
        } else if (spec.entries.columns) {
          const table = secrets[key] ??= {};
          put(rows, row, storedRow(spec.entries, own(rows, row), value, `${key}「${row}」`, own(table, row) ?? put(table, row, {})));
        } else put(rows, row, stored(spec.entries, value, `${key}「${row}」`));
      }
      if (Object.keys(rows).length) next[key] = { entries: rows }; else delete next[key];
    } else next[key] = stored(spec, item, key);
  }
  return next;
}
// A table's row is named by any text, and a row's column by a name a JavaScript object may have of its own (`constructor`,
// `toString`, `__proto__`): such a name is still only that row or column, read only when it is the object's own and
// written as the object's own property, never through what every object inherits.
const own = (object, key) => object && Object.hasOwn(object, key) ? object[key] : undefined;
const put = (object, key, value) => { Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true }); return value; };
// A row of columns as a patch leaves it at its layer (`{ value: { 列: 值 | null } }`): what it names over what the layer had,
// null clearing a column; a secret column's text goes to `secrets` (null when cleared) and is stored only as set. The row's
// required columns are there after it.
function storedRow(spec, current, item, where, secrets) {
  check(item && typeof item === 'object' && Object.keys(item).length === 1 && item.value && typeof item.value === 'object' && !Array.isArray(item.value),
    'invalid_input', `${where} 须为 { value: { 列: 值 } }`);
  const next = { ...(current?.value ?? {}) };
  for (const [name, value] of Object.entries(item.value)) {
    const column = own(spec.columns, name);
    check(column, 'invalid_input', `${where}没有「${name}」这一列`);
    if (value === null) { delete next[name]; if (column.writeOnly) put(secrets, name, null); continue; }
    if (column.writeOnly) {
      check(typeof value === 'string' && value !== '', 'invalid_input', `${where}「${name}」是密文，须为不空的文本`);
      put(secrets, name, checkValue(column, value, `${where}「${name}」`));
      put(next, name, { secret: true });
    } else put(next, name, checkValue(column, value, `${where}「${name}」`));
  }
  for (const name of spec.required ?? []) check(Object.hasOwn(next, name) || spec.columns[name].default !== undefined, 'invalid_input', `${where}缺「${spec.columns[name].title ?? name}」`);
  return { value: next };
}
// A row as it is resolved: every column, its default for one not written, a secret's null.
const rowValue = (spec, stored) => Object.fromEntries(Object.entries(spec.columns).map(([name, column]) =>
  [name, column.writeOnly ? null : own(stored, name) ?? column.default ?? null]));
// The value of an item, and where it came from. A secret has no value here, only the layer it is set in; whatever else is
// stored for one (before the plugin made it a secret) is none.
function read(item, spec, from) {
  if (!item) return null;
  if (spec.writeOnly) return item.secret === true ? { value: null, from } : null;
  if (!('value' in item)) return null;
  // Of options chosen once, those the plugin has no more are not chosen; a value stored before the setting was a choice is none.
  if (spec.type === 'array' && spec.format === 'coda-model-provider')
    return Array.isArray(item.value) ? { value: item.value.filter(v => typeof v === 'string' && MODEL_PROVIDER.test(v)), from } : null;
  if (spec.type === 'array' && spec.options) return Array.isArray(item.value) ? { value: spec.options.map(o => o.value).filter(v => item.value.includes(v)), from } : null;
  return { value: item.value, from };
}
// Every setting of a plugin for one project (or for every project, without one): project over plugin over default.
// A table merges row by row, as VS Code merges object settings across user and workspace. A secret's value is null:
// `secrets` says which layer of those set has it, whose file its processes read; for a table of rows, by row and column.
export function resolveSettings(plugin, pluginStored = {}, projectStored = {}) {
  const values = {}, sources = {}, secrets = {};
  for (const [key, spec] of Object.entries(plugin.properties)) {
    if (spec.entries) {
      const rows = {}, from = {};
      for (const [row, value] of Object.entries(spec.default ?? {})) { put(rows, row, value); put(from, row, { from: 'default' }); }
      for (const [layer, store] of [['plugin', pluginStored], ['project', projectStored]])
        for (const [row, item] of Object.entries(store[key]?.entries ?? {})) {
          if (item === null) { delete rows[row]; delete from[row]; continue; }
          const got = read(item, spec.entries, layer);
          if (got) { put(rows, row, got.value); put(from, row, { from: layer }); }
        }
      if (spec.entries.columns) for (const row of Object.keys(rows)) {
        const set = Object.keys(spec.entries.columns).filter(name => own(rows[row], name)?.secret === true);
        if (set.length) put(secrets[key] ??= {}, row, Object.fromEntries(set.map(name => [name, from[row].from])));
        put(rows, row, rowValue(spec.entries, rows[row]));
      }
      values[key] = rows; sources[key] = { from: projectStored[key] ? 'project' : pluginStored[key] ? 'plugin' : 'default', entries: from };
      continue;
    }
    const got = read(projectStored[key], spec, 'project') ?? read(pluginStored[key], spec, 'plugin');
    values[key] = got ? got.value : spec.default ?? null;
    sources[key] = got ? { from: got.from } : { from: 'default' };
    if (got && spec.writeOnly) secrets[key] = got.from;
  }
  return { values, sources, secrets };
}
// The required settings (`contributes.configuration.required`) with no value as they are resolved (resolveSettings): none, an
// empty text, a table without rows, a secret not set.
export const missingSettings = (plugin, { values, secrets }) => (plugin.required ?? []).filter(key => {
  const spec = plugin.properties[key], value = values[key];
  if (spec.writeOnly) return !Object.hasOwn(secrets, key);
  if (spec.entries) return !value || !Object.keys(value).length;
  return value === null || value === undefined || value === '';
});
// What a plugin's command says in place of running while settings it requires have no value (docs/plugins.md「必填」).
export const missingNotice = (plugin, missing) =>
  `${plugin.displayName} 缺少设置：${missing.map(key => plugin.properties[key].title ?? key).join('、')}。在 Coda 的「设置 › 插件 › ${plugin.displayName}」里填写`;
// What clients are shown of stored settings: a secret only as set, whatever an older version of the plugin stored for it.
export const shownSettings = (plugin, stored = {}) =>
  Object.fromEntries(Object.entries(stored ?? {}).filter(([key, item]) => !plugin.properties[key]?.writeOnly || item?.secret === true));
// `vars` for a workflow: a plugin's settings by their dotted names.
export function varsContext(values = {}) {
  const vars = {};
  for (const [key, value] of Object.entries(values)) {
    const parts = key.split('.'); let at = vars;
    for (const part of parts.slice(0, -1)) at = at[part] = at[part] && typeof at[part] === 'object' && !Array.isArray(at[part]) ? at[part] : {};
    at[parts.at(-1)] = value;
  }
  return vars;
}
