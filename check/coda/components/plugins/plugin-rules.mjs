// Plugins (docs/plugins.md): what Coda installs once for every project, the way VS Code installs an extension. A plugin
// is a directory with a VS Code style `package.json` whose `contributes.configuration` declares its settings in JSON
// Schema, and the workflows it brings in `.coda/workflows/`; the capabilities it brings (`contributes.capabilities`, in
// `.coda/capabilities/`: run only when called), a few words for agents (`contributes.instructions`), panels for the
// resources page (`contributes.panels`, the resources plugin's point, kept as written), agents (`contributes.agents`, components/plugins/agent-plugins.mjs),
// concurrency groups (`contributes.groups`), the events it publishes (`contributes.events`), what it gives what starts in a project it applies to — commands
// (`contributes.commands`), environment variables (`contributes.environment`), directories on the PATH (`contributes.path`)
// and Agent Skills (`contributes.skills`) —, requests clients send it (`contributes.endpoints`, components/plugins/endpoints.mjs),
// pages the clients open (`contributes.views`, components/plugins/views.mjs)
// and what makes a machine ready for it once the user installs or updates it (`contributes.setup`); the plugins it
// needs (`extensionDependencies`) and the points it declares or plugs into (components/plugins/plugin-extensions.mjs). Its settings have a value for every project (the plugin's
// settings) that a project may override, as user and workspace settings do in VS Code. Workflows read the result as
// `vars` (`=vars.…`).
// Nothing here is Coda's own invention but a few string formats: `coda-agent`, what a new session is started with
// (agent, model, effort, fast mode, approval mode), `coda-agent-match`, which sessions a row applies to, and `coda-repo`
// and `coda-directory`, a repository and a directory of the machine, which clients fill in with the same chooser a project
// is added with. JSON Schema's own `format: duration` (an ISO 8601 duration) is checked as such, and its `writeOnly` marks a
// secret: a text written and never read back, kept in a file beside the database and given to the plugin's processes as
// that file's path (`CODA_PLUGIN_SECRETS`).
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { basename, join, normalize, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { settings as agentSettings } from '../session-config/commands.mjs';
import { requireCondition as check, ContractError } from '../../domain/errors.mjs';
import { isDuration } from '../../domain/duration.mjs';
import { MODEL_APIS, isModelApi } from './model-protocols.mjs';
import { AGENT_ID } from '../../domain/values.mjs';
import { agentDeclarations } from './agent-plugins.mjs';
import { checkCatalog, dependencyDeclarations, extensionDeclarations, extensionPointDeclarations, extensionsFor, offerDeclarations } from './plugin-extensions.mjs';
import { claims, COMMIT, INTEGRITY, NPM_VERSION, npmPluginId, repoAddress, sourcePath } from './plugin-source-rules.mjs';
import { readSkillDocument } from './skill-document.mjs';
import { executorLabels } from '../workflows/executor-labels.mjs';

// A setting's name: the plugin's id, then letters and digits after each dot.
const KEY = /^[a-z][a-z0-9-]*(\.[a-z][A-Za-z0-9]*)+$/;
const ID = /^[a-z][a-z0-9-]{0,39}$/;
const NAME = /^[a-z][a-z0-9-]{0,63}$/;
// An event's name, `<域>.<名>` as Coda's own are (session.facts); the domains of Coda's own no plugin publishes in.
const EVENT = /^(?=.{3,100}$)[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
// The domains of the events Coda publishes itself; a plugin's are of a domain of its own.
export const CODA_EVENT_DOMAINS = ['workflow', 'session', 'user'];
// What a plugin tells every agent of a project that has it, kept short: it is in every session's instructions.
export const INSTRUCTIONS_LIMIT = 200;
// An environment variable's name, as a plugin gives one (`contributes.environment`).
export const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Plugins that ship with Coda, as VS Code's built-in extensions ship with it: updated with Coda itself.
export const BUILTIN_DIR = fileURLToPath(new URL('../../resources/plugins/', import.meta.url));
// The package the backend runs from (the runtime clone's, or the release's), whose npm dependencies may be built-in plugins
// too (dependencyPlugins).
const PACKAGE_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
// What a plugin may contribute to Coda itself; anything else in `contributes` is for a point another plugin declares to
// take it (the resources plugin's `panels`), refused when none does, as any other way of writing Coda cannot read.
export const CONTRIBUTES = ['configuration', 'capabilities', 'instructions', 'agents', 'extensionPoints', 'extensions', 'groups', 'events', 'commands', 'gitCredentials',
  'repositories', 'services', 'setup', 'skills', 'environment', 'path', 'endpoints', 'mcpServers', 'views', 'modelProviders', 'executors'];
// The string formats a setting may have, beside `coda-agent` (an object) and `coda-agent-match` (a table's row names):
// `coda-model-provider` names a model service another plugin provides (docs/plugins.md「模型服务」); `coda-model-url` is the
// address of one, its Key and API in fields beside it (`modelKey`, `modelApi`), which Coda checks (「检查可用模型」).
const STRING_FORMATS = ['duration', 'coda-repo', 'coda-directory', 'coda-model-provider', 'coda-model-url'];
export const MODEL_PROVIDER = /^[a-z][a-z0-9-]{0,39}\/[a-z][a-z0-9-]{0,39}$/;
// How many model services a setting of several may name.
const MODEL_PROVIDERS_AT_MOST = 20;
// A command's name, as a shell finds it on the PATH; Coda's own come first and are no plugin's.
const COMMAND = /^[a-z][a-z0-9-]{0,39}$/, CODA_COMMANDS = ['coda-run', 'coda-event', 'coda-resources'];
// Where in the clients a view may stay (docs/plugins.md「视图」): beside a session.
export const VIEW_PLACES = ['side', 'page'];
// What a view's entry in the clients can show (docs/plugins.md「视图」): a count the clients keep themselves, not one the
// plugin reports. A page's beside its title — `workflow-runs`: the runs going on, or waiting on the user; `machines`: the
// view's machines and which answer —, a view beside sessions' above the composer — `changes`: what the session changed
// in its worktree.
export const VIEW_READOUTS = ['workflow-runs', 'machines', 'changes'];
// Which sessions a view beside sessions is for, by where they work (docs/plugins.md「视图」): `worktree`, only those in a
// worktree of their own.
export const VIEW_CHECKOUTS = ['worktree'];
// When else than its views' opening the plugin host loads a plugin's module (docs/plugins.md「插件宿主」).
const ACTIVATION_EVENTS = ['onStartupFinished'];
// What a view may take over opening (`handles`): the kind of a Coda reference, as `coda://<kind>/…` names it.
export const REFERENCE_KIND = /^[a-z][a-z0-9-]{0,39}$/;
// An SF Symbol's name, as a view's icon is given.
const SYMBOL = /^[a-z0-9]+(\.[a-z0-9]+)*$/;

// ---- Declarations ----
// The JSON Schema Coda reads: a scalar, a choice of several among fixed options (an array of `items.anyOf` constants, as a
// form's multi-select), several model services (an array of `items` of format `coda-model-provider`, which the
// machine's model services are offered for), or an object whose entries all share one schema (VS Code shows such a setting as a table): a single
// value, an Agent combination, or a row of named columns, each a single value, secrets among them (docs/plugins.md「类型」). Anything else is refused when the plugin is read, not ignored. `level`: what is read, a
// setting, a table's entry, or a column of its rows.
const COLUMN = /^[a-z][A-Za-z0-9]{0,39}$/, OPTION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
function schema(value, where, level = 'setting') {
  check(value && typeof value === 'object' && !Array.isArray(value), 'invalid_plugin', `${where} 须为 JSON Schema 对象`);
  const known = ['type', 'default', 'description', 'markdownDescription', 'title', 'enum', 'enumDescriptions', 'minimum', 'maximum', 'format', 'order',
    ...{ setting: ['additionalProperties', 'propertyNames', 'writeOnly', 'modelKey', 'modelApi', 'items', 'uniqueItems'], entry: ['properties', 'required'],
      column: ['writeOnly', 'modelKey', 'modelApi'] }[level]];
  check(level !== 'column' || value.type !== 'object', 'invalid_plugin', `${where}：一列只能是单个值`);
  check(level !== 'entry' || value.type !== 'object' || value.format === 'coda-agent' || value.properties !== undefined, 'invalid_plugin',
    `${where}：表格的每一项只能是单个值、Agent 组合，或 properties 写明的 1–20 列`);
  check(value.type !== 'array' || level === 'setting', 'invalid_plugin', `${where}：多选只能是插件的一项设置，不能放进表格`);
  const extra = Object.keys(value).filter(k => !known.includes(k));
  check(!extra.length, 'invalid_plugin', `${where} 里有 Coda 不支持的键：${extra.join('、')}`);
  check((value.properties === undefined && value.required === undefined) || (value.type === 'object' && value.format === undefined), 'invalid_plugin',
    `${where}：只有一行几列时才写 properties 与 required`);
  // A secret is a text of its own, with nothing to fall back on: what it is cannot be shown, so neither offered nor defaulted.
  check(value.writeOnly === undefined || typeof value.writeOnly === 'boolean', 'invalid_plugin', `${where} 的 writeOnly 须为开或关`);
  check(!value.writeOnly || (value.type === 'string' && value.format === undefined && value.enum === undefined && value.default === undefined),
    'invalid_plugin', `${where}：密文设置（writeOnly）只能是没有 format、enum 与默认值的文本`);
  const agent = value.format === 'coda-agent';
  check(['boolean', 'integer', 'number', 'string', 'object', 'array'].includes(value.type), 'invalid_plugin', `${where} 的 type 不受支持：${value.type}`);
  check((value.items === undefined && value.uniqueItems === undefined) || value.type === 'array', 'invalid_plugin', `${where}：只有多选（type: array）才写 items 与 uniqueItems`);
  check(value.format === undefined || agent || value.format === 'coda-agent-match' || STRING_FORMATS.includes(value.format), 'invalid_plugin', `${where} 的 format 不受支持：${value.format}`);
  check(!agent || value.type === 'object', 'invalid_plugin', `${where}：coda-agent 是对象`);
  check(!STRING_FORMATS.includes(value.format) || value.type === 'string', 'invalid_plugin', `${where}：${value.format} 是文本`);
  check(value.enum === undefined || (Array.isArray(value.enum) && value.enum.length && ['string', 'integer', 'number'].includes(value.type)), 'invalid_plugin', `${where} 的 enum 无效`);
  check((value.modelKey === undefined && value.modelApi === undefined) || value.format === 'coda-model-url', 'invalid_plugin',
    `${where}：modelKey 与 modelApi 只写在 coda-model-url 的地址上`);
  const out = { type: value.type, ...(value.format ? { format: value.format } : {}), ...(value.enum ? { enum: value.enum } : {}),
    ...(value.minimum !== undefined ? { minimum: value.minimum } : {}), ...(value.maximum !== undefined ? { maximum: value.maximum } : {}),
    ...(typeof value.description === 'string' ? { description: value.description } : typeof value.markdownDescription === 'string' ? { description: value.markdownDescription } : {}),
    ...(typeof value.title === 'string' ? { title: value.title } : {}), ...(Number.isFinite(value.order) ? { order: value.order } : {}),
    ...(value.writeOnly ? { writeOnly: true } : {}),
    ...(value.modelKey !== undefined ? { modelKey: value.modelKey } : {}), ...(value.modelApi !== undefined ? { modelApi: value.modelApi } : {}) };
  if (value.type === 'array' && value.items?.format === 'coda-model-provider') {
    // Several model services (docs/plugins.md「类型」): each `<plugin>/<id>`, chosen among those the machine offers;
    // `modelApis` the interfaces its plugin takes, the only ones offered for it.
    const items = value.items;
    check(value.format === undefined && value.minimum === undefined && value.maximum === undefined, 'invalid_plugin', `${where}：多个模型服务不写 format、minimum 与 maximum`);
    check(value.uniqueItems === undefined || value.uniqueItems === true, 'invalid_plugin', `${where}：多个模型服务的 uniqueItems 只能是 true`);
    check(Object.keys(items).every(k => ['type', 'format', 'modelApis'].includes(k)) && items.type === 'string', 'invalid_plugin',
      `${where}：多个模型服务写 items: { type: string, format: coda-model-provider, modelApis }`);
    check(items.modelApis === undefined || (Array.isArray(items.modelApis) && items.modelApis.length >= 1 && items.modelApis.length <= 10
      && items.modelApis.every(isModelApi)), 'invalid_plugin', `${where}.items.modelApis 须为 1–10 个接口名，取 ${MODEL_APIS.join('、')}`);
    out.format = 'coda-model-provider';
    if (items.modelApis) out.modelApis = [...new Set(items.modelApis)];
  } else if (value.type === 'array') {
    // A choice of several: each option a constant of its own, with what the client shows for it; chosen ones kept in this order.
    check(value.format === undefined && value.minimum === undefined && value.maximum === undefined, 'invalid_plugin', `${where}：多选不写 format、minimum 与 maximum`);
    check(value.uniqueItems === undefined || value.uniqueItems === true, 'invalid_plugin', `${where}：多选的 uniqueItems 只能是 true（每项至多选一次）`);
    const items = value.items, options = items?.anyOf;
    check(items && typeof items === 'object' && !Array.isArray(items) && Object.keys(items).every(k => k === 'anyOf') && Array.isArray(options)
      && options.length >= 1 && options.length <= 50, 'invalid_plugin', `${where}：多选写 items: { anyOf: [{ const, title, description }] }，1–50 项`);
    out.options = options.map((option, i) => {
      check(option && typeof option === 'object' && !Array.isArray(option) && Object.keys(option).every(k => ['const', 'title', 'description'].includes(k))
        && typeof option.const === 'string' && OPTION.test(option.const), 'invalid_plugin',
        `${where}.items.anyOf[${i}] 须为 { const, title, description }，const 只用字母、数字和「._-」`);
      check(['title', 'description'].every(k => option[k] === undefined || (typeof option[k] === 'string' && option[k].length <= 400)), 'invalid_plugin',
        `${where}.items.anyOf[${i}] 的 title 与 description 须为不超过 400 字的文字`);
      return { value: option.const, ...(option.title ? { title: option.title } : {}), ...(option.description ? { description: option.description } : {}) };
    });
    check(new Set(out.options.map(o => o.value)).size === out.options.length, 'invalid_plugin', `${where}：多选的 const 不能重复`);
  } else if (value.type === 'object' && !agent && level === 'entry') {
    // A row of columns: each a single value, the row's `required` ones always there (given, or by their default).
    const columns = value.properties;
    check(columns && typeof columns === 'object' && !Array.isArray(columns) && Object.keys(columns).length >= 1 && Object.keys(columns).length <= 20,
      'invalid_plugin', `${where}：表格的每一项只能是单个值、Agent 组合，或 properties 写明的 1–20 列`);
    out.columns = Object.fromEntries(Object.entries(columns).map(([name, column]) => {
      check(COLUMN.test(name), 'invalid_plugin', `${where} 的列名只用字母和数字，以小写字母开头：${name}`);
      return [name, schema(column, `${where}.properties.${name}`, 'column')];
    }));
    const required = value.required ?? [];
    check(Array.isArray(required) && required.every(name => typeof name === 'string' && Object.hasOwn(out.columns, name)) && new Set(required).size === required.length,
      'invalid_plugin', `${where}.required 须为本行的列名，不重复`);
    modelFields(out.columns, `${where} 的列`);
    if (required.length) out.required = [...required];
  } else if (value.type === 'object' && !agent) {
    out.entries = schema(value.additionalProperties ?? invalidPlugin(`${where} 需要 additionalProperties`), `${where}.additionalProperties`, 'entry');
    if (value.propertyNames !== undefined) {
      check(value.propertyNames && Object.keys(value.propertyNames).every(k => k === 'format') && value.propertyNames.format === 'coda-agent-match',
        'invalid_plugin', `${where}.propertyNames 只支持 format: coda-agent-match`);
      out.keys = 'coda-agent-match';
    }
  }
  if (value.default !== undefined) out.default = checkValue(out, value.default, `${where} 的默认值`, 'invalid_plugin');
  return out;
}
const invalidPlugin = message => { throw new ContractError('invalid_plugin', message); };
// A group of fields (a row's columns, or a plugin's single settings) has at most one model address (docs/plugins.md
// 「检查可用模型」), its Key a secret field of the group and its API a text field of it.
function modelFields(fields, where) {
  const urls = Object.entries(fields).filter(([, field]) => field.format === 'coda-model-url');
  check(urls.length <= 1, 'invalid_plugin', `${where}里至多一个 coda-model-url`);
  for (const [name, field] of urls) {
    check(field.modelKey === undefined || (typeof field.modelKey === 'string' && Object.hasOwn(fields, field.modelKey) && fields[field.modelKey].writeOnly),
      'invalid_plugin', `${where}「${name}」的 modelKey 须为同组的密文`);
    check(field.modelApi === undefined || (typeof field.modelApi === 'string' && Object.hasOwn(fields, field.modelApi) && fields[field.modelApi].type === 'string'
      && !fields[field.modelApi].writeOnly), 'invalid_plugin', `${where}「${name}」的 modelApi 须为同组的文本`);
  }
}

// The category it is listed under (docs/plugins.md「商店」): the first of its manifest's `categories`, as VS Code's are
// written; empty when it names none. Not checked: readPlugin does that.
export const manifestCategory = manifest => Array.isArray(manifest?.categories) && typeof manifest.categories[0] === 'string' ? manifest.categories[0].trim().slice(0, 32) : '';
// A plugin as its directory declares it. `id` is the one its manifest says (for a package whose name cannot be one: a scoped
// package's, docs/plugins.md「插件的内容」), else its package name; a package from npm's without one, whatever npm calls it,
// the ID its name gives (docs/plugins.md「从 npm 安装」): its package.json is not changed, for what it imports of itself.
export function readPlugin(dir, source) {
  let manifest;
  try { manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')); }
  catch (e) { throw new ContractError('invalid_plugin', `${dir} 没有可读的 package.json：${e.message}`); }
  const named = manifest?.id !== undefined;
  if (named) manifest = { ...manifest, name: manifest.id };
  else if (source?.package && typeof manifest?.name === 'string') try { manifest = { ...manifest, name: npmPluginId(manifest.name) }; } catch {}
  check(typeof manifest.name === 'string' && ID.test(manifest.name), 'invalid_plugin', `package.json 的 ${named ? 'id' : 'name'} 只能用小写字母、数字和「-」`);
  check(manifest.contributes === undefined || (manifest.contributes && typeof manifest.contributes === 'object' && !Array.isArray(manifest.contributes)),
    'invalid_plugin', 'contributes 须为对象');
  const offers = offerDeclarations(manifest.contributes, CONTRIBUTES);
  check(manifest.categories === undefined || (Array.isArray(manifest.categories) && manifest.categories.every(c => typeof c === 'string')),
    'invalid_plugin', 'categories 须为文本的数组');
  const configuration = manifest.contributes?.configuration ?? {};
  const properties = configuration.properties ?? {};
  check(properties && typeof properties === 'object', 'invalid_plugin', 'contributes.configuration.properties 须为对象');
  const declared = Object.fromEntries(Object.entries(properties).map(([key, value]) => {
    check(KEY.test(key) && key.split('.')[0] === manifest.name, 'invalid_plugin', `设置名须以「${manifest.name}.」开头，只用字母和数字：${key}`);
    return [key, schema(value, key)];
  }));
  modelFields(Object.fromEntries(Object.entries(declared).filter(([, spec]) => spec.type !== 'object')), '单值设置');
  // The settings it cannot work without (docs/plugins.md「必填」), as JSON Schema says it: their names, beside `properties`.
  const required = configuration.required ?? [];
  check(Array.isArray(required) && required.every(key => typeof key === 'string' && Object.hasOwn(declared, key)) && new Set(required).size === required.length,
    'invalid_plugin', 'contributes.configuration.required 须为本插件声明过的设置名的数组，不重复');
  const files = sub => existsSync(join(dir, sub)) ? [...new Set(readdirSync(join(dir, sub)).map(f => /^(.+)\.bpmn$/.exec(f)?.[1]).filter(Boolean))].sort() : [];
  const workflows = files('.coda/workflows');
  // Each capability it lists has its file, and every file there is listed: what it brings is what it says.
  const listed = manifest.contributes?.capabilities ?? [];
  check(Array.isArray(listed) && listed.every(name => typeof name === 'string' && NAME.test(name)) && new Set(listed).size === listed.length, 'invalid_plugin',
    'contributes.capabilities 须为能力名的数组（小写字母、数字和「-」，以字母开头），不重复');
  const capabilities = [...listed].sort(), found = files('.coda/capabilities');
  check(capabilities.length === found.length && capabilities.every((name, i) => name === found[i]), 'invalid_plugin',
    `contributes.capabilities 与 .coda/capabilities/ 里的文件不一致：列出 ${capabilities.join('、') || '无'}，文件 ${found.join('、') || '无'}`);
  const both = capabilities.filter(name => workflows.includes(name));
  check(!both.length, 'invalid_plugin', `${both.join('、')} 既是流程又是能力`);
  // Its module the plugin host runs (docs/plugins.md「插件宿主」), as VS Code's `main`: a JavaScript file in its directory.
  const main = manifest.main;
  check(main === undefined || (typeof main === 'string' && /\.m?js$/.test(main) && !main.startsWith('/') && !normalize(main).split('/').includes('..')
    && existsSync(join(dir, main)) && statSync(join(dir, main)).isFile()), 'invalid_plugin', 'main 须是插件目录里的 .js 或 .mjs 文件');
  // When the host loads that module, as VS Code's `activationEvents`: the first time one of its views opens, as by default,
  // or as soon as the backend has started (`onStartupFinished`), for one that works with no view open.
  const activation = manifest.activationEvents ?? [];
  check(Array.isArray(activation) && activation.every(e => ACTIVATION_EVENTS.includes(e)) && new Set(activation).size === activation.length
    && (!activation.length || main), 'invalid_plugin', `activationEvents 须为 ${ACTIVATION_EVENTS.join('、')} 组成的数组，不重复，且插件须有 main`);
  const instructions = manifest.contributes?.instructions;
  check(instructions === undefined || (typeof instructions === 'string' && instructions.trim() && [...instructions].length <= INSTRUCTIONS_LIMIT), 'invalid_plugin',
    `contributes.instructions 须为不超过 ${INSTRUCTIONS_LIMIT} 字的说明`);
  // The concurrency groups it brings (docs/plugins.md「并发组」): a name any process may take, and the setting of its own that
  // says how many the group lets in at once (an integer).
  const groups = manifest.contributes?.groups ?? [];
  check(Array.isArray(groups) && groups.every(g => g && typeof g === 'object' && Object.keys(g).every(k => ['name', 'capacity'].includes(k))
    && typeof g.name === 'string' && /^\S{1,100}$/.test(g.name) && declared[g.capacity]?.type === 'integer')
    && new Set(groups.map(g => g.name)).size === groups.length, 'invalid_plugin',
  'contributes.groups 须为 { name, capacity } 的数组：name 为 1–100 个非空白字符、不重复，capacity 是本插件声明的整数设置');
  // The events it publishes (docs/plugins.md「事件」): a name a workflow subscribes to, whether one starts the workflows
  // subscribed to it (`starts`, as by default) or only reaches the runs going for its subject, and whether it ends its subject
  // (`ends`: a pull request closed), which a run re-run after it is told again.
  const events = manifest.contributes?.events ?? [];
  check(Array.isArray(events) && events.length <= 50 && events.every(e => e && typeof e === 'object' && Object.keys(e).every(k => ['name', 'starts', 'ends'].includes(k))
    && typeof e.name === 'string' && EVENT.test(e.name) && !CODA_EVENT_DOMAINS.includes(e.name.split('.')[0])
    && ['starts', 'ends'].every(k => e[k] === undefined || typeof e[k] === 'boolean'))
    && new Set(events.map(e => e.name)).size === events.length, 'invalid_plugin',
  `contributes.events 须为 { name, starts?, ends? } 的数组，至多 50 个：name 是「<域>.<名>」（小写字母、数字和「_」，以字母开头，不超过 100 个字符，不重复，域不能是 Coda 自己的 ${CODA_EVENT_DOMAINS.join('、')}），starts、ends 是真假值`);
  // The commands it puts on the PATH of what starts in a project it applies to (docs/plugins.md「命令」): a name, and what
  // runs for it (by `sh`, given the arguments; adapters/launch.mjs writeCommands).
  const commands = manifest.contributes?.commands ?? [];
  check(Array.isArray(commands) && commands.every(c => c && typeof c === 'object' && Object.keys(c).every(k => ['name', 'command'].includes(k))
    && typeof c.name === 'string' && COMMAND.test(c.name) && !CODA_COMMANDS.includes(c.name)
    && typeof c.command === 'string' && c.command.trim() && c.command.length <= 4000 && !/[\0\r\n]/.test(c.command))
    && new Set(commands.map(c => c.name)).size === commands.length, 'invalid_plugin',
  `contributes.commands 须为 { name, command } 的数组：name 是命令名（小写字母、数字和「-」，以字母开头，不重复，不能是 Coda 自己的 ${CODA_COMMANDS.join('、')}），command 是一行命令`);
  // The requests clients may send it (docs/plugins.md「端点」): an id, and what answers one (by `sh`, the request on its
  // standard input; components/plugins/endpoints.mjs); one may say which of its settings it checks (`checks`), beside which
  // clients offer to check what is filled in (docs/plugins.md「设置的检查」), one endpoint a setting.
  const endpoints = manifest.contributes?.endpoints ?? [];
  check(Array.isArray(endpoints) && endpoints.length <= 20 && endpoints.every(e => e && typeof e === 'object' && Object.keys(e).every(k => ['id', 'command', 'checks'].includes(k))
    && typeof e.id === 'string' && COMMAND.test(e.id)
    && typeof e.command === 'string' && e.command.trim() && e.command.length <= 4000 && !/[\0\r\n]/.test(e.command)
    && (e.checks === undefined || (typeof e.checks === 'string' && Object.hasOwn(declared, e.checks))))
    && new Set(endpoints.map(e => e.id)).size === endpoints.length
    && new Set(endpoints.filter(e => e.checks).map(e => e.checks)).size === endpoints.filter(e => e.checks).length, 'invalid_plugin',
  'contributes.endpoints 须为 { id, command, checks? } 的数组，至多 20 个：id 是小写字母、数字和「-」，以字母开头，不重复；command 是一行命令；checks 是本插件声明的设置名，一个设置至多一个端点检查');
  // The pages the clients open for it (docs/plugins.md「视图」): an id, what the window or page is called, the HTML file
  // in its directory the client starts it from, in a sandbox, where in the clients it stays, with its icon there, and the
  // references it opens in place of the client (`handles`, as a VS Code custom editor takes the files of its type).
  const views = manifest.contributes?.views ?? [];
  check(Array.isArray(views) && views.length <= 10 && views.every(v => v && typeof v === 'object' && Object.keys(v).every(k => ['id', 'title', 'entry', 'in', 'icon', 'handles', 'readout', 'checkout'].includes(k))
    && typeof v.id === 'string' && COMMAND.test(v.id)
    && typeof v.title === 'string' && v.title.trim() && [...v.title].length <= 40 && !/[\0\r\n]/.test(v.title)
    && typeof v.entry === 'string' && /\.html$/.test(v.entry) && !v.entry.startsWith('/') && !normalize(v.entry).split('/').includes('..')
    && (v.in === undefined || (Array.isArray(v.in) && v.in.every(place => VIEW_PLACES.includes(place)) && new Set(v.in).size === v.in.length))
    && (v.icon === undefined || (typeof v.icon === 'string' && v.icon.length <= 100 && SYMBOL.test(v.icon)))
    && (v.handles === undefined || (Array.isArray(v.handles) && v.handles.length <= 8 && v.handles.every(k => typeof k === 'string' && REFERENCE_KIND.test(k))
      && new Set(v.handles).size === v.handles.length))
    && (v.readout === undefined || VIEW_READOUTS.includes(v.readout)) && (v.checkout === undefined || VIEW_CHECKOUTS.includes(v.checkout)))
    && new Set(views.map(v => v.id)).size === views.length, 'invalid_plugin',
  `contributes.views 须为 { id, title, entry, in?, icon?, handles? } 的数组，至多 10 个：id 是小写字母、数字和「-」，以字母开头，不重复；title 是不超过 40 字的一行；entry 是插件目录里的 .html 文件；in 是它常驻的位置（${VIEW_PLACES.join('、')}），不重复；icon 是 SF Symbol 的名字；handles 是它接管打开的引用种类（如 workflow-runs），至多 8 个，不重复；readout 是它的读数（${VIEW_READOUTS.join('、')}）；checkout 是它只给哪种工作位置的会话（${VIEW_CHECKOUTS.join('、')}）`);
  const handled = views.flatMap(v => v.handles ?? []);
  check(new Set(handled).size === handled.length, 'invalid_plugin', 'contributes.views：同一种引用只能由一个视图接管');
  for (const v of views) {
    const at = join(dir, v.entry);
    check(existsSync(at) && statSync(at).isFile(), 'invalid_plugin', `视图 ${v.id} 的 ${v.entry} 不存在`);
  }
  // The addresses it gives Git's credentials for (docs/plugins.md「Git 凭据」): an `https://` host, and what runs as Git's
  // credential helper for it (by `sh`, given Git's arguments; adapters/launch.mjs writeCredentialHelpers).
  const gitCredentials = manifest.contributes?.gitCredentials ?? [];
  check(Array.isArray(gitCredentials) && gitCredentials.every(c => c && typeof c === 'object' && Object.keys(c).every(k => ['url', 'command'].includes(k))
    && typeof c.url === 'string' && /^https:\/\/[a-z0-9.-]+(:\d+)?$/.test(c.url)
    && typeof c.command === 'string' && c.command.trim() && c.command.length <= 4000 && !/[\0\r\n]/.test(c.command))
    && new Set(gitCredentials.map(c => c.url)).size === gitCredentials.length, 'invalid_plugin',
  'contributes.gitCredentials 须为 { url, command } 的数组：url 是 https:// 加小写主机名（可带端口，不带路径），不重复；command 是一行命令');
  // The bundled services it turns on (docs/supervisor.md「独立服务进程」): one no installed plugin names does not run.
  const services = manifest.contributes?.services ?? [];
  check(Array.isArray(services) && services.every(id => typeof id === 'string' && NAME.test(id)) && new Set(services).size === services.length,
    'invalid_plugin', 'contributes.services 须为服务 ID 的数组，不重复');
  // The repositories it can list for a client choosing one (docs/plugins.md「仓库来源」): one command, run by `sh` as a
  // panel's is, printing them (components/plugins/repositories.mjs).
  const repositories = manifest.contributes?.repositories;
  check(repositories === undefined || (repositories && typeof repositories === 'object' && !Array.isArray(repositories) && Object.keys(repositories).every(k => k === 'command')
    && typeof repositories.command === 'string' && repositories.command.trim() && repositories.command.length <= 4000 && !/[\0\r\n]/.test(repositories.command)),
  'invalid_plugin', 'contributes.repositories 须为 { command }：command 是一行命令');
  // What makes this machine ready for it (docs/plugins.md「准备运行环境」): one command, run by `sh` as a panel's is
  // (components/plugins/plugin-setup.mjs) when the user installs or updates it.
  const setup = manifest.contributes?.setup;
  check(setup === undefined || (setup && typeof setup === 'object' && !Array.isArray(setup) && Object.keys(setup).every(k => k === 'command')
    && typeof setup.command === 'string' && setup.command.trim() && setup.command.length <= 4000 && !/[\0\r\n]/.test(setup.command)),
  'invalid_plugin', 'contributes.setup 须为 { command }：command 是一行命令');
  const skills = skillDeclarations(manifest.contributes?.skills, dir);
  const environment = environmentDeclarations(manifest.contributes?.environment, declared), path = pathDeclarations(manifest.contributes?.path, dir);
  const modelProviders = modelProviderDeclarations(manifest.contributes?.modelProviders, declared);
  const executors = executorDeclarations(manifest.contributes?.executors);
  const mcpServers = mcpDeclarations(manifest.contributes?.mcpServers, declared);
  const dependencies = dependencyDeclarations(manifest.extensionDependencies, manifest.name);
  return { id: manifest.name, displayName: typeof manifest.displayName === 'string' ? manifest.displayName : manifest.name,
    description: typeof manifest.description === 'string' ? manifest.description : '', version: String(manifest.version ?? ''), category: manifestCategory(manifest),
    source, dir, title: typeof configuration.title === 'string' ? configuration.title : manifest.displayName ?? manifest.name, properties: declared,
    ...(main ? { main: posix.normalize(main) } : {}), ...(activation.includes('onStartupFinished') ? { startup: true } : {}),
    ...(required.length ? { required: [...required] } : {}), workflows,
    capabilities, services: [...services], groups: groups.map(g => ({ name: g.name, capacity: g.capacity })), commands: commands.map(c => ({ name: c.name, command: c.command })),
    ...(events.length ? { events: events.map(e => ({ name: e.name, starts: e.starts !== false, ...(e.ends ? { ends: true } : {}) })) } : {}),
    gitCredentials: gitCredentials.map(c => ({ url: c.url, command: c.command })),
    endpoints: endpoints.map(e => ({ id: e.id, command: e.command, ...(e.checks ? { checks: e.checks } : {}) })),
    // The entry as one path in its directory (`./view/a.html`, `view//a.html` are `view/a.html`): the clients load it by that.
    views: views.map(v => ({ id: v.id, title: v.title, entry: posix.normalize(v.entry), ...(v.in?.length ? { in: [...v.in] } : {}), ...(v.icon ? { icon: v.icon } : {}),
      ...(v.handles?.length ? { handles: [...v.handles] } : {}), ...(v.readout ? { readout: v.readout } : {}),
      ...(v.checkout ? { checkout: v.checkout } : {}) })),
    // What it writes for another plugin's points, as written (components/plugins/plugin-extensions.mjs offerDeclarations).
    ...(Object.keys(offers).length ? { offers } : {}),
    agents: agentDeclarations(manifest.contributes?.agents, dir),
    dependencies, extensionPoints: extensionPointDeclarations(manifest.contributes?.extensionPoints, CONTRIBUTES),
    extensions: extensionDeclarations(manifest.contributes?.extensions, dependencies),
    ...(instructions ? { instructions: instructions.trim() } : {}), ...(setup ? { setup: { command: setup.command } } : {}), ...(skills.length ? { skills } : {}),
    ...(environment.length ? { environment } : {}), ...(path.length ? { path } : {}), ...(mcpServers.length ? { mcpServers } : {}),
    ...(modelProviders.length ? { modelProviders } : {}), ...(executors.length ? { executors } : {}),
    ...(repositories ? { repositories: { command: repositories.command } } : {}) };
}
// The environment variables it gives what starts in a project it applies to (docs/plugins.md「变量与 PATH」): each a value
// written out, which may name one of its own settings of a single value (`${config:<设置名>}`, as it is for the project),
// its directory (`${CODA_PLUGIN_PATH}`) or its state on the backend (`${CODA_PLUGIN_STATE}`). The PATH is `contributes.path`'s
// to say; Coda's own variables, and the shells' hooks it sets, are not a plugin's to give.
const RESERVED_VARIABLE = /^(PATH|ZDOTDIR|BASH_ENV|CODA_.*|BASH_FUNC_.*)$/;
const PLACE = /\$\{([^}]*)\}/g;
const PLUGIN_PLACES = ['CODA_PLUGIN_PATH', 'CODA_PLUGIN_STATE'];
// `where`: what declares them, for what Coda says of one it cannot read (an MCP server's `env` is written the same way).
function environmentDeclarations(raw, declared, where = 'contributes.environment') {
  if (raw === undefined) return [];
  check(raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length <= 100, 'invalid_plugin',
    `${where} 须为「变量名 → 值」的对象，不超过 100 个`);
  return Object.entries(raw).map(([name, value]) => {
    check(VARIABLE.test(name) && !RESERVED_VARIABLE.test(name), 'invalid_plugin',
      `${where} 的变量名只用字母、数字和「_」，不以数字开头，也不能是 PATH、ZDOTDIR、BASH_ENV 或 CODA_ 开头的：${name}`);
    check(typeof value === 'string' && value.length <= 4096 && !value.includes('\0'), 'invalid_plugin', `${where} 的 ${name} 须为不超过 4096 字的文字`);
    for (const [, place] of value.matchAll(PLACE)) {
      const setting = /^config:(.+)$/.exec(place)?.[1];
      check(PLUGIN_PLACES.includes(place) || (setting && ['string', 'number', 'integer', 'boolean'].includes(declared[setting]?.type)), 'invalid_plugin',
        `${where} 的 ${name} 引用了 \${${place}}：只能是 config:<本插件的单值设置>、CODA_PLUGIN_PATH 或 CODA_PLUGIN_STATE`);
      // A variable is seen by all that starts there and by whatever prints the environment: a secret is read from its file.
      check(!declared[setting]?.writeOnly, 'invalid_plugin', `${where} 的 ${name} 引用了密文设置 ${setting}：密文不进环境变量，插件的进程从 CODA_PLUGIN_SECRETS 给的文件读`);
    }
    return { name, value };
  });
}
// The MCP servers it gives the agents of a project it applies to (docs/plugins.md「MCP 服务器」), by name, as Claude Code's
// `.mcp.json` has them: a program the agent starts and talks to on its standard input and output (`command` and its
// `args`, not run by a shell), given the variables `env` names, written as `contributes.environment`'s. What it runs may name
// the plugin's directory, its state on the backend and the backend's own Node; a server's settings reach it through `env`.
const MCP_PLACES = ['CODA_PLUGIN_PATH', 'CODA_PLUGIN_STATE', 'CODA_NODE'];
function mcpDeclarations(raw, declared) {
  if (raw === undefined) return [];
  check(raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length <= 20, 'invalid_plugin',
    'contributes.mcpServers 须为「服务器名 → { command, args, env }」的对象，不超过 20 个');
  return Object.entries(raw).map(([name, server]) => {
    const where = `contributes.mcpServers 的 ${name}`;
    check(NAME.test(name) && name.length <= 40 && name !== 'coda', 'invalid_plugin',
      `contributes.mcpServers 的服务器名只用小写字母、数字和「-」，以字母开头，至多 40 个字符，不能是 Coda 自己的 coda：${name}`);
    check(server && typeof server === 'object' && !Array.isArray(server) && Object.keys(server).every(k => ['type', 'command', 'args', 'env'].includes(k))
      && (server.type === undefined || server.type === 'stdio'), 'invalid_plugin', `${where} 须为 { command, args, env }：现在只支持由 Agent 在本机启动的服务器（stdio）`);
    const word = (value, label) => {
      check(typeof value === 'string' && value && value.length <= 4096 && !/[\0\r\n]/.test(value), 'invalid_plugin', `${where} 的 ${label} 须为一行不超过 4096 字的文字`);
      for (const [, place] of value.matchAll(PLACE)) check(MCP_PLACES.includes(place), 'invalid_plugin',
        `${where} 的 ${label} 引用了 \${${place}}：只能是 CODA_PLUGIN_PATH、CODA_PLUGIN_STATE 或 CODA_NODE，设置经 env 交给它`);
      return value;
    };
    const args = server.args ?? [];
    check(Array.isArray(args) && args.length <= 100, 'invalid_plugin', `${where} 的 args 须为不超过 100 项的数组`);
    return { name, command: word(server.command, 'command'), args: args.map((arg, i) => word(arg, `args[${i}]`)),
      env: environmentDeclarations(server.env, declared, `${where} 的 env`) };
  });
}
// The model services it provides (docs/plugins.md「模型服务」), for another plugin to choose by `<plugin>/<id>` with a setting of
// format `coda-model-provider`, neither needing the other: what it is called, the API it speaks, and where it is — an address
// written out that may name its own settings of a single value (`${config:…}`), and its key, one of its own secrets.
function modelProviderDeclarations(raw, declared) {
  if (raw === undefined) return [];
  check(Array.isArray(raw) && raw.length <= 10, 'invalid_plugin', 'contributes.modelProviders 须为不超过 10 项的数组');
  const providers = raw.map((p, i) => {
    const where = `contributes.modelProviders[${i}]`;
    check(p && typeof p === 'object' && !Array.isArray(p) && Object.keys(p).every(k => ['id', 'title', 'api', 'url', 'key'].includes(k)), 'invalid_plugin',
      `${where} 须为 { id, title, api, url, key? }`);
    check(typeof p.id === 'string' && COMMAND.test(p.id), 'invalid_plugin', `${where} 的 id 只用小写字母、数字和「-」，以字母开头`);
    check(typeof p.title === 'string' && p.title.trim() && [...p.title].length <= 40 && !/[\0\r\n]/.test(p.title), 'invalid_plugin', `${where} 的 title 须为不超过 40 字的一行`);
    check(isModelApi(p.api), 'invalid_plugin', `${where} 的 api 须为 Coda 认得的接口：${MODEL_APIS.join('、')}`);
    check(typeof p.url === 'string' && p.url && p.url.length <= 4096 && !/[\0\r\n]/.test(p.url), 'invalid_plugin', `${where} 的 url 须为一行地址`);
    for (const [, place] of p.url.matchAll(PLACE)) {
      const setting = /^config:(.+)$/.exec(place)?.[1];
      check(setting && ['string', 'number', 'integer'].includes(declared[setting]?.type) && !declared[setting].writeOnly, 'invalid_plugin',
        `${where} 的 url 只能引用本插件的单值设置（\${config:<设置名>}，不能是密文）`);
    }
    const key = p.key === undefined ? null : /^\$\{config:([^}]+)\}$/.exec(p.key)?.[1];
    check(p.key === undefined || (key && declared[key]?.writeOnly), 'invalid_plugin', `${where} 的 key 须为 \${config:<本插件的密文设置>}`);
    return { id: p.id, title: p.title.trim(), api: p.api, url: p.url, ...(key ? { key } : {}) };
  });
  check(new Set(providers.map(p => p.id)).size === providers.length, 'invalid_plugin', 'contributes.modelProviders 的 id 不能重复');
  return providers;
}
// The executors it offers this machine's script steps (docs/plugins.md「执行环境」): what each is called, the labels it has
// (as `coda:runsOn` writes them), and its hook — one command, run by `sh` as a panel's is, that the step's runner calls for
// each part of the job (resources/workflow-executor.mjs).
function executorDeclarations(raw) {
  if (raw === undefined) return [];
  check(Array.isArray(raw) && raw.length <= 10, 'invalid_plugin', 'contributes.executors 须为不超过 10 项的数组');
  const executors = raw.map((e, i) => {
    const where = `contributes.executors[${i}]`;
    check(e && typeof e === 'object' && !Array.isArray(e) && Object.keys(e).every(k => ['id', 'title', 'labels', 'command'].includes(k)), 'invalid_plugin',
      `${where} 须为 { id, title, labels, command }`);
    check(typeof e.id === 'string' && COMMAND.test(e.id), 'invalid_plugin', `${where} 的 id 只用小写字母、数字和「-」，以字母开头`);
    check(typeof e.title === 'string' && e.title.trim() && [...e.title].length <= 40 && !/[\0\r\n]/.test(e.title), 'invalid_plugin', `${where} 的 title 须为不超过 40 字的一行`);
    const labels = executorLabels(e.labels, `${where} 的 labels`, 'invalid_plugin');
    check(labels.length, 'invalid_plugin', `${where} 的 labels 至少要有一个标签`);
    check(typeof e.command === 'string' && e.command.trim() && e.command.length <= 4000 && !/[\0\r\n]/.test(e.command), 'invalid_plugin', `${where} 的 command 须为一行命令`);
    return { id: e.id, title: e.title.trim(), labels, command: e.command };
  });
  check(new Set(executors.map(e => e.id)).size === executors.length, 'invalid_plugin', 'contributes.executors 的 id 不能重复');
  return executors;
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
// The directories it puts on the PATH of what starts in a project it applies to: one of its own (relative, as a Skill's),
// or one in its state on the backend (`${CODA_PLUGIN_STATE}/…`), which its setup may make.
function pathDeclarations(raw, dir) {
  if (raw === undefined) return [];
  check(Array.isArray(raw) && raw.length <= 20, 'invalid_plugin', 'contributes.path 须为不超过 20 项的目录数组');
  return raw.map(entry => {
    check(typeof entry === 'string' && entry && !/[\0:\n]/.test(entry), 'invalid_plugin', `contributes.path 的每项须为一个目录：${entry}`);
    const state = /^\$\{CODA_PLUGIN_STATE\}(\/.*)?$/.exec(entry);
    const relative = normalize(state ? `.${state[1] ?? ''}` : entry).replace(/\/$/, '');
    check(!relative.startsWith('/') && !relative.split('/').includes('..') && !entry.includes('${', state ? 2 : 0), 'invalid_plugin',
      `contributes.path 的每项须为插件目录里的相对路径，或 \${CODA_PLUGIN_STATE} 下的目录：${entry}`);
    if (state) return relative === '.' ? '${CODA_PLUGIN_STATE}' : `\${CODA_PLUGIN_STATE}/${relative}`;
    let found;
    try { found = statSync(join(dir, relative)); } catch { found = null; }
    check(relative !== '.' && found?.isDirectory(), 'invalid_plugin', `contributes.path 的目录不在插件里：${entry}`);
    return relative;
  });
}
// A plugin's environment variables and PATH as they are for one project: its settings there (`settings`), its directory and
// its state on this backend (`state`, null without one). A value naming a setting with none, or its state without one, is
// not given; nor is a directory in a state there is not.
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
function skillDeclarations(raw, dir) {
  if (raw === undefined) return [];
  check(Array.isArray(raw) && raw.length <= 100, 'invalid_plugin', 'contributes.skills 须为不超过 100 项的目录数组');
  const found = raw.map(path => {
    const relative = typeof path === 'string' ? normalize(path).replace(/\/$/, '') : '';
    check(relative && !relative.startsWith('/') && !relative.split('/').includes('..') && relative !== '.', 'invalid_plugin',
      `contributes.skills 的每项须为插件目录里的相对路径：${path}`);
    const name = basename(relative);
    check(SKILL.test(name), 'invalid_plugin', `Skill 目录名只能用字母、数字、「.」「_」「-」：${path}`);
    let file;
    try { file = statSync(join(dir, relative, 'SKILL.md')); } catch { file = null; }
    check(file?.isFile(), 'invalid_plugin', `Skill 目录里没有 SKILL.md：${path}`);
    const skill = { name, path: join(dir, relative) };
    // Descriptions are for browsing only; a missing or unreadable document is explained when opened.
    try { skill.description = readSkillDocument({ dir, skills: [skill] }, name).description; } catch { /* Keep the declaration. */ }
    return skill;
  });
  const names = found.map(skill => skill.name);
  check(new Set(names).size === names.length, 'invalid_plugin', `contributes.skills 里有同名的 Skill：${names.filter((n, i) => names.indexOf(n) !== i).join('、')}`);
  return found;
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
  if (spec.type === 'array') return Array.isArray(item.value) ? { value: spec.options.map(o => o.value).filter(v => item.value.includes(v)), from } : null;
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
