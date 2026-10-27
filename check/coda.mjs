// What the checker copies from Coda, in one place. Coda is the authority: its「读取来源」(PluginSources.readSource) reads a
// plugin with the same rules, and wins where the two differ. Each rule names where it came from in the Coda repository at
// CODA_COMMIT; a Coda PR that changes one of them changes this file too (docs/agent-protocol.md here is synced from the same
// commit, and test/protocol-copy.test.mjs keeps the two together).
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk';

// The Coda commit these rules were copied from (an empty current mode is none chosen).
export const CODA_COMMIT = '70381176e5cecd353fefe3674d7fdf25cf51abab';
// The ACP version Coda speaks: the SDK's (backend/package.json pins @agentclientprotocol/sdk 1.4.0, as package.json here).
export const ACP_PROTOCOL_VERSION = PROTOCOL_VERSION;

// ---- ACP (backend/src/adapters/acp.mjs) ----
// `initialize` as Coda sends it (AcpSession.initialize): no clientInfo, these capabilities.
export const clientCapabilities = () => ({
  elicitation: { form: {}, url: {} },
  session: { compaction: {}, configOptions: { boolean: {} } },
  _meta: { coda: { waits: {} } },
});
// Session instructions (AcpSession.takesInstructions, initialize): ACP's unstable `systemPrompt`, sent only to an agent that
// declares it, the same on `session/new` and `session/load`, in `append` mode, one text block (docs/agent-protocol.md「会话指令」).
export const takesInstructions = init => init?.agentCapabilities?.sessionCapabilities?.systemPrompt != null;
export const systemPrompt = text => ({ mode: 'append', content: [{ type: 'text', text }] });
// Steering (AcpSession.supportsSteering, steer; docs/agent-protocol.md「插话」): declared beside the capabilities; sent only
// while a turn of Coda's own is under way. `injected` joined it; `promptRequired` was not taken, the turn having ended;
// anything else Coda records as unknown.
export const STEERING = '_session/steering';
export const supportsSteering = init => init?._meta?.steering?.supported === true;
export const steeringParams = (sessionId, text) => ({ sessionId, prompt: [{ type: 'text', text }], _meta: { steering: { idleBehavior: 'promptRequired' } } });
export const STEERING_OUTCOMES = ['injected', 'promptRequired'];
// Failure categories and presentation (backend/src/domain/agent-failures.mjs).
export function agentFailure(error) {
  const failure = error?.data?._meta?.coda?.failure;
  if (!record(failure)) return null;
  return failure.kind === 'quota_exhausted' ||
    (failure.kind === 'service_unavailable' && ['accepted', 'not_accepted'].includes(failure.input)) ? failure : null;
}
export function agentErrorMessage(error) {
  const message = typeof error?.message === 'string' && error.message ? error.message : 'Agent 返回错误';
  const detail = typeof error?.data?.message === 'string' ? error.data.message.trim() : '';
  const text = detail && !message.includes(detail) ? `${message}\n\n${detail}` : message;
  return agentFailure(error)?.kind === 'quota_exhausted' && !text.startsWith('额度不足') ? `额度不足\n\n${text}` : text;
}
// Service retry policy (backend/src/application/prompt-recovery.mjs).
export function serviceFailure(error) {
  const failure = agentFailure(error);
  return failure?.kind === 'service_unavailable' ? failure : null;
}
// The former capacity/model-unavailable policy, shared by every agent that reports a service failure.
export const RETRY_DELAYS = [15_000, 30_000, 60_000];
export const continuationPrompt = '继续完成当前任务，沿用已有上下文和已完成的工作，从尚未完成的部分接着执行。';

// The agent refuses until it is signed in: ACP's auth_required (signedOut).
export const SIGNED_OUT = -32000;
// What Coda answers an agent request it has no handler for (the SDK's): Coda handles only approvals and forms.
export const METHOD_NOT_FOUND = -32601;
// What an agent may say of a wait of its own (validWait, verbatim); anything else Coda drops unread.
const record = value => value && typeof value === 'object' && !Array.isArray(value);
export const WAIT_STATES = new Set(['waiting', 'handling', 'done', 'failed', 'cancelled']);
const fits = (value, limit) => value === undefined || (typeof value === 'string' && value.length <= limit);
export const validWait = p => record(p) && typeof p.sessionId === 'string' && p.sessionId.length > 0 && p.sessionId.length <= 200
  && typeof p.waitId === 'string' && p.waitId.length > 0 && p.waitId.length <= 200 && WAIT_STATES.has(p.state)
  && fits(p.kind, 50) && fits(p.title, 500) && fits(p.detail, 4000) && fits(p.childSessionId, 200) && fits(p.model, 200) && fits(p.outputFile, 4096)
  && fits(p.toolCallId, 200)
  && [p.stoppable, p.recurring].every(flag => flag === undefined || typeof flag === 'boolean')
  && (p.at === undefined || (typeof p.at === 'string' && Number.isFinite(Date.parse(p.at))));
// The model a session runs with, as Coda reads it (catalog().current.model): every turn Coda configures first, and refuses
// a session whose agent names none (configure: 「适配器未报告实际模型」).
export function currentModel(session) {
  const model = session?.configOptions?.find?.(x => x?.category === 'model');
  return model?.currentValue ?? session?.models?.currentModelId;
}
// docs/agent-protocol.md「Agent 活动」规则 3: a turn the user stops ends within this, or Coda closes the agent's process group.
export const CANCEL_LIMIT = 30_000;
// adapters/session-host.mjs `close`: Coda stops an agent with SIGTERM to its process group, and SIGKILL this long after.
export const TERM_GRACE = 800;
// adapters/acp.mjs `open` and application/option-cache.mjs: opening a session (initialize, session/new or session/load) may take this.
export const OPEN_LIMIT = 60_000;

// ---- What every process Coda runs for a plugin is given (backend/src/components/plugins/plugin-rules.mjs pluginEnv, cleared) ----
// Its agents', its panels' and the commands it brings alike: Coda's own Node, the plugin's directory, its state, its settings,
// what is plugged into its points (none here: the checker installs nothing beside it), where the plugins it depends on are
// (`dependencies`, by ID), and CODA_ARBITER only for an instance's own backend, which the checker is not. What a process
// inherits is cleared of them first, those it is given only sometimes too (its secrets' files, the model services, the PATH
// without Coda's directories): it never takes another plugin's for its own.
export const PLUGIN_VARIABLES = ['CODA_NODE', 'CODA_ARBITER', 'CODA_PLUGIN_PATH', 'CODA_PLUGIN_STATE', 'CODA_PLUGIN_SETTINGS', 'CODA_PLUGIN_SECRETS',
  'CODA_PLUGIN_EXTENSIONS', 'CODA_PLUGIN_DEPENDENCIES', 'CODA_MODEL_PROVIDERS', 'CODA_USER_PATH'];
export const pluginEnv = ({ pluginDir, stateDir, settings = {}, dependencies = {} }) => ({ CODA_NODE: process.execPath, CODA_PLUGIN_PATH: pluginDir,
  CODA_PLUGIN_STATE: stateDir, CODA_PLUGIN_SETTINGS: JSON.stringify(settings),
  ...(Object.keys(dependencies).length ? { CODA_PLUGIN_DEPENDENCIES: JSON.stringify(dependencies) } : {}) });
export const cleared = base => Object.fromEntries(Object.entries(base).filter(([name]) => !PLUGIN_VARIABLES.includes(name)));
// How Coda starts an agent (domain/agents.mjs launch, adapters/session-host.mjs): `sh -c` in its own process group, standard
// error unread, the session's environment plus its plugin's.
// A panel's command (application/panels.mjs env): no session's ID, the backend's `node` first on the PATH, and the
// concurrency groups in use as it starts (`{ now, groups }`; none here).
export const THREAD_ENV = 'CODA_THREAD_ID';
export const groupsState = () => JSON.stringify({ now: Date.now(), groups: [] });

// ---- Manifests (backend/src/domain/plugins.mjs, agent-plugins.mjs, panels.mjs, plugin-extensions.mjs) ----
export const PLUGIN_ID = /^[a-z][a-z0-9-]{0,39}$/;
export const AGENT_ID = /^[a-z][a-z0-9-]{0,39}$/;
export const PANEL_ID = /^[a-z][a-z0-9-]{0,63}$/;
export const POINT = /^[a-z][a-z0-9-]{0,39}$/;
export const SETTING_KEY = /^[a-z][a-z0-9-]*(\.[a-z][A-Za-z0-9]*)+$/;
// The string formats a setting may have, beside `coda-agent` and `coda-agent-match` (backend/src/components/plugins/plugin-rules.mjs
// STRING_FORMATS): a duration, a repository, a directory of the machine, a model service another plugin provides
// (`<插件>/<服务>`, MODEL_PROVIDER), and the address of one.
export const STRING_FORMATS = ['duration', 'coda-repo', 'coda-directory', 'coda-model-provider', 'coda-model-url'];
export const MODEL_PROVIDER = /^[a-z][a-z0-9-]{0,39}\/[a-z][a-z0-9-]{0,39}$/;
export const CAPABILITY = /^[a-z][a-z0-9-]{0,63}$/;
// What a plugin may contribute to Coda itself (backend/src/components/plugins/plugin-rules.mjs CONTRIBUTES).
export const CONTRIBUTES = ['configuration', 'capabilities', 'instructions', 'agents', 'extensionPoints', 'extensions', 'groups', 'events', 'commands', 'gitCredentials',
  'repositories', 'services', 'setup', 'skills', 'environment', 'path', 'endpoints', 'mcpServers', 'views', 'modelProviders', 'executors'];
// The keys of `contributes` points of the plugins Coda ships take (Coda's docs/plugins.md「写在 contributes 里的扩展点」): the
// resources plugin's `panels`. Anything else is said, not refused: Coda may have added it since this copy.
export const POINT_KEYS = ['panels'];
// What only a plugin Coda ships may contribute, one installed from a repository or npm being refused it
// (backend/src/components/plugins/plugin-source-rules.mjs catalogProblem): the clients do not show these in the confirmation yet.
export const BUILTIN_ONLY = { gitCredentials: '只有 Coda 自带的插件能提供 Git 凭据', repositories: '只有 Coda 自带的插件能提供仓库列表' };
// The bundled services a plugin turns on (`contributes.services`, docs/supervisor.md「独立服务进程」): their IDs.
export const SERVICE = /^[a-z][a-z0-9-]{0,63}$/;
// A command a plugin puts on every session's and step's PATH (`contributes.commands`): its name, as a shell finds it, which
// may not be one of Coda's own; what runs for it, one line.
export const COMMAND = /^[a-z][a-z0-9-]{0,39}$/;
export const CODA_COMMANDS = ['coda-run', 'coda-event'];
// An event a plugin publishes (`contributes.events`, Coda's docs/plugins.md「事件」): `<域>.<名>`, in no domain of Coda's own;
// whether it starts the workflows subscribed to it (`starts`), and whether it ends its subject (`ends`: a run re-run after it
// is told it again).
export const EVENT = /^(?=.{3,100}$)[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
export const CODA_EVENT_DOMAINS = ['workflow', 'session', 'user'];
export const EVENT_LIMIT = 50;
export const COMMAND_LIMIT = 4000;
// A plugin's setup action (`contributes.setup`): `{ command }`, one line as a panel's command is; it may install software, so
// the checker reads it and does not run it.
export const SETUP_KEYS = ['command'];
export const INSTRUCTIONS_LIMIT = 200;
export const ICON_LIMIT = 32 * 1024;
export const AGENT_LIMITS = { displayName: 40, modeTitle: 10, modeUnset: 20, modeNote: 100, modeId: 200, setupHint: 200, command: 4000, configFiles: 16, path: 1000 };
export const PANEL_LIMITS = { title: 40, command: 4000, confirm: 200, note: 200 };

// ---- From a repository (backend/src/domain/plugin-sources.mjs) ----
export const SIZE_LIMIT = 10 * 1024 * 1024;
export const SEGMENT = /^[A-Za-z0-9._-]+$/;
export const DEPTH = 2;
// A plugin's npm dependencies come with its package-lock.json, naming the same (manifestProblem): Coda installs them with
// `npm ci` in the plugin's version directory.
export const NPM = ['dependencies', 'optionalDependencies'];
export const NPM_LOCK = 'package-lock.json';
// Those kept in `plugins/<id>` here that Coda ships as npm dependencies, `@coda-console/<id>` (docs/plugins.md「内置插件的来源」):
// a version of the same package may be installed over Coda's. Other sources may use the same ID once the built-in plugin is
// uninstalled; only the target backend can check its installed state (builtinProblem).
export const BUILTIN_HERE = ['claude', 'codex', 'codex-accounts', 'grok', 'kimi', 'opencode', 'review'];
export const BUILTIN_SCOPE = '@coda-console/';
// An agent, a concurrency group and a command are one plugin's (catalogProblem, claims). Those the built-in plugins declare, by
// plugin; and `claude`, the agent ID sessions from before #1069 still store (docs/plugins.md「Agent」).
export const BUILTIN_AGENTS = { 'claude-sdk': 'claude', codex: 'codex', grok: 'grok', kimi: 'kimi', opencode: 'opencode', claude: 'claude' };
export const BUILTIN_GROUPS = { host: 'host' };
export const BUILTIN_COMMANDS = { 'host-sim': 'host' };

// ---- Panels (backend/src/domain/panels.mjs, application/panels.mjs) ----
export const ITEM_TYPES = ['card', 'meter', 'stat', 'markdown', 'button', 'error'];
export const OUTPUT_LIMIT = 64 * 1024;
export const ARGS_LIMIT = 4 * 1024;
export const ITEM_LIMITS = { items: 50, cardItems: 20, label: 80, identity: 200, markdown: 4000, error: 500, confirm: 200 };
// A reading is stopped past this (docs/plugins.md「面板」).
export const PANEL_READ_LIMIT = 30_000;
