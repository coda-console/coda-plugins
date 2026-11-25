// The model services chosen in Coda (`codex.modelProviders`, Coda's docs/plugins.md「模型服务」): other plugins' services
// that speak the OpenAI Responses API (Codex no longer speaks Chat Completions), from CODA_MODEL_PROVIDERS. The models each
// lists (`<地址>/models`) join Codex's own, a group of the service's each (Coda's docs/agent-protocol.md「模型的分组」). Codex
// binds a thread to one model provider, so a turn on another provider's model first moves the session there the way
// codex-acp moves it for ACP's `providers/set` and `providers/disable`: its app-server starts again with that service as the
// provider of its OpenAI slot (or without one), and the session's thread is resumed on it. The machine's Codex
// configuration is not touched.
import { existsSync, readFileSync } from 'node:fs';
import { carriedInstructions } from './instructions.mjs';
import { lastListed } from './last-listed.mjs';

export const SETTING = 'codex.modelProviders';
const log = text => process.stderr.write(`[codex-agent] ${text}\n`);
const parse = text => { try { return JSON.parse(text || '{}'); } catch { return {}; } };
const LIST_TIMEOUT = 8000;

// The resource reference (`coda://<接口种类>/<UUID>`) of the model service an address Coda injected is, from its
// `…/resources/<接口种类>/<UUID><路径>` (Coda's docs/plugins.md「模型服务」); null for an address of another shape.
export function serviceReference(url) {
  let path;
  try { path = new URL(url).pathname; } catch { return null; }
  const found = /^\/resources\/(openai-completions|openai-responses|anthropic-messages|openai-speech)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i.exec(path);
  return found ? `coda://${found[1]}/${found[2].toLowerCase()}` : null;
}

// The services chosen, in the order chosen: each its address, title and key (read from the file Coda keeps it in). One not
// on this machine, or speaking another API, is left out.
export function chosenServices(env = process.env) {
  const refs = parse(env.CODA_PLUGIN_SETTINGS)[SETTING], provided = parse(env.CODA_MODEL_PROVIDERS);
  return (Array.isArray(refs) ? refs : []).flatMap(ref => {
    const service = provided[ref];
    if (!service?.url) { log(`模型服务 ${ref} 在这台机器上没有`); return []; }
    if (service.api !== 'openai-responses') { log(`模型服务 ${ref} 讲 ${service.api}，Codex 只接 openai-responses 的`); return []; }
    let key;
    try { key = service.keyFile ? readFileSync(service.keyFile, 'utf8').trim() || undefined : undefined; }
    catch (e) { log(`读不到模型服务 ${ref} 的 Key：${e.message}`); }
    return [{ ref, title: service.title || ref, url: service.url, key }];
  });
}

// The models a service lists, or last listed when it cannot be asked now (last-listed.mjs), as Codex's model list has
// them (app-server `model/list`): `<服务>/<模型>`, named by the model, with no effort or speed to choose; `codaService` and
// `codaGroup` say whose they are, for the session's move and the model's group.
export async function serviceModels({ ref, title, url, key }, fetcher = fetch, state) {
  const listed = await lastListed(ref, async () => {
    const at = `${url.replace(/\/+$/, '')}/models`;
    const response = await fetcher(at, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(LIST_TIMEOUT) });
    if (!response.ok) throw new Error(`${at} 回答 ${response.status}`);
    const body = await response.json();
    // Only a list replaces the one kept: an answer of another shape is the service not answering.
    if (!Array.isArray(body?.data)) throw new Error(`${at} 的回答不是模型列表`);
    return body.data.filter(model => typeof model?.id === 'string' && model.id);
  }, state, log);
  return listed.map(model => ({
    id: `${ref}/${model.id}`, model: model.id, displayName: model.id, description: '', hidden: false, isDefault: false,
    supportedReasoningEfforts: [], defaultReasoningEffort: 'medium', inputModalities: ['text', 'image'], serviceTiers: [],
    codaService: ref, codaGroup: title }));
}

// The services a process has (Coda runs one session a process), listed once, as its session opens.
export class ServiceModels {
  // `on`: the service the session runs on, null on Codex's own (where it opens), undefined when a move to one or another
  // failed partway: codex-acp sets its gateway before the thread is resumed on it, so that is no sign of either, and keeps
  // its old client, closed, when the app-server it started again does not start.
  // `state`: the plugin's state directory, where what each service last listed is kept.
  constructor(services = chosenServices(), fetcher = fetch, state = null) { Object.assign(this, { services, fetcher, state }); this.models = []; this.on = null; }
  // Theirs in the order the services are chosen: none of one that cannot list them now and never did.
  list() {
    return this.listed ??= Promise.all(this.services.map(service => serviceModels(service, this.fetcher, this.state)
      .catch(e => { log(`模型服务 ${service.ref} 列不出模型：${e.message}`); return []; }))).then(lists => (this.models = lists.flat()));
  }
  served(model) { return this.models.find(m => m.id === model) ?? null; }
  // The model select's options (codex-acp's, of Codex's models and the services'), grouped by where they come from once a
  // service's are among them: Codex's own, then each service's under its title. Codex's alone are one plain list.
  grouped(options) {
    if (!options.some(option => this.served(option.value))) return options;
    const groups = [{ group: 'codex', name: 'Codex', options: [] }];
    for (const option of options) {
      const served = this.served(option.value), id = served?.codaService ?? 'codex';
      let group = groups.find(g => g.group === id);
      if (!group) groups.push(group = { group: id, name: served.codaGroup, options: [] });
      group.options.push(option);
    }
    return groups.filter(g => g.options.length);
  }
  // What a turn names to Codex: the service's own name for one of its models.
  wire(model) { return this.served(model)?.model ?? model; }
  // The model a turn is sent on, bound to its session at that dispatch: the service its address says (as Coda injected it) and the model
  // asked of it, as Coda's docs/plugins.md「Coda 的用量记录」 has them; none for a model of Codex's own or an address of another shape.
  bind(sessionState, model) {
    const served = this.served(model), service = served && serviceReference(this.services.find(s => s.ref === served.codaService)?.url);
    sessionState.codaRequested = service ? { service, asked: served.model } : null;
  }
  // The `usage` a prompt answers with, with what its turn was bound to. An answer of a prompt that sent no model request (a command such
  // as `/status`, whose usage codex-acp repeats from the turn before) has none, and says nothing of any model.
  usage(sessionState, usage) { return usage && sessionState.codaRequested ? { ...usage, ...sessionState.codaRequested } : usage; }
  // A stop that comes while a turn waits on the move has no turn of codex-acp's to interrupt yet: it is the waiting turn's,
  // which ends cancelled with its input not given (`route` says so).
  cancel(sessionId) { if (this.moving === sessionId) this.stopped = true; }
  async route(server, params) {
    const state = server.sessions.get(params.sessionId);
    if (state) state.codaRequested = null;
    this.moving = params.sessionId; this.stopped = false;
    try { await this.move(server, params); } finally { this.moving = null; }
    return this.stopped;
  }
  // Before a turn of codex-acp's `server`: the session on the provider of its model, its thread resumed with Coda's
  // instructions as it was opened. A thread nothing was said in yet is not written down, and would not be resumed after the
  // restart: naming it, by what it is first told, writes it. A move that failed is made again from the restart, on which
  // codex-acp has a client again; the thread was written down before it.
  async move(server, { sessionId, prompt }) {
    const state = server.sessions.get(sessionId);
    if (!state) return;
    const served = this.served(state.currentModelId.replace(/\[[^\]]*\]$/, ''));
    const service = served ? this.services.find(s => s.ref === served.codaService) : null, wanted = service?.ref ?? null;
    if (this.on === wanted) return;
    if (this.on !== undefined) {
      const client = server.codexAcpClient.appServerClient;
      const { thread } = await client.threadRead({ threadId: sessionId });
      if (thread.path && !existsSync(thread.path)) await client.threadSetName({ threadId: sessionId, name: firstWords(prompt) });
    }
    this.on = undefined;
    await carriedInstructions(() => service ? server.setProvider({ providerId: 'openai', apiType: 'openai', baseUrl: service.url,
      headers: service.key ? { Authorization: `Bearer ${service.key}` } : {} }) : server.disableProvider({ providerId: 'openai' }));
    this.on = wanted;
  }
  // Codex knows nothing of the service's models: that it runs one on fallback metadata, or resumes a session last on one
  // with another model (Coda sets the session's model before each turn), is no news to say in the session.
  quiet({ message } = {}) {
    const named = /^Model metadata for `(.+?)` not found|^This session was recorded with model `(.+?)` but is resuming with `(.+?)`/.exec(message ?? '');
    return !!named && named.slice(1).some(model => model && this.models.some(m => m.model === model));
  }
}
const firstWords = prompt => Array.from((prompt ?? []).filter(b => b.type === 'text').map(b => b.text).join(' ').replace(/\s+/g, ' ').trim()).slice(0, 80).join('') || 'Coda';

export const services = new ServiceModels(chosenServices(), fetch, process.env.CODA_PLUGIN_STATE);
const patches = [
  // Codex's models, then the services'.
  ['    } while (cursor);\n    return models;\n  }', '    } while (cursor);\n    return [...models, ...await codaServices.list()];\n  }', 1],
  // Listed in groups once a service's are among them.
  ['    currentValue: currentBaseModelId,\n    options,\n', '    currentValue: currentBaseModelId,\n    options: codaServices.grouped(options),\n', 1],
  // A turn first moves the session to the provider of its model, and names the model as that provider does.
  ['  async prompt(params, signal, onTurnStarted) {\n    if (this.providerUpdate !== null) {',
    '  async prompt(params, signal, onTurnStarted) {\n    if (await codaServices.route(this, params)) return { stopReason: "cancelled" };\n    if (this.providerUpdate !== null) {', 1],
  // A stop while the session moves is the moving turn's.
  ['  async cancel(params) {\n    const sessionState = this.sessions.get(params.sessionId);',
    '  async cancel(params) {\n    codaServices.cancel(params.sessionId);\n    const sessionState = this.sessions.get(params.sessionId);', 1],
  // The model a turn is sent on is bound to the session, and the usage a prompt answers with says it.
  ['      sessionState.lastTokenUsage = null;\n      ensurePendingTurnStart();\n      const sendPromptPromise', '      codaServices.bind(sessionState, modelId.model);\n      sessionState.lastTokenUsage = null;\n      ensurePendingTurnStart();\n      const sendPromptPromise', 1],
  ['this.buildPromptUsage(sessionState.lastTokenUsage)', 'codaServices.usage(sessionState, this.buildPromptUsage(sessionState.lastTokenUsage))', 4],
  ['      model: modelId.model,\n      serviceTier\n    }, onTurnStarted);', '      model: codaServices.wire(modelId.model),\n      serviceTier\n    }, onTurnStarted);', 1],
  ['      case "warning":\n        return this.createWarningEvent(notification.params);',
    '      case "warning":\n        if (codaServices.quiet(notification.params)) return null;\n        return this.createWarningEvent(notification.params);', 1],
];
// Fails loudly once the locked adapter changes.
export function servedCodexModels(source) {
  for (const [before, after, count] of patches) {
    if (source.split(before).length !== count + 1) throw new Error('codex-acp model service patch no longer matches the locked adapter');
    source = source.replaceAll(before, after);
  }
  return `import { services as codaServices } from ${JSON.stringify(import.meta.url)};\n${source.replace(/^#![^\n]*\n/, '')}`;
}
