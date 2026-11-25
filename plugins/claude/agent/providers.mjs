// The model services chosen in Coda (`claude.modelProviders`, Coda's docs/plugins.md「模型服务」): other plugins' services
// that speak Anthropic Messages, from CODA_MODEL_PROVIDERS. The models each lists (`<地址>/models`) join Claude's own, a group
// of the service's each (Coda's docs/agent-protocol.md「模型的分组」); a session on one runs Claude Code with its service as
// its API (`serviceSettings`), set for that session's process only.
import { readFileSync } from 'node:fs';
import { authOverrides } from './auth.mjs';
import { lastListed } from './last-listed.mjs';

export const SETTING = 'claude.modelProviders';
const log = text => process.stderr.write(`[claude-agent] ${text}\n`);
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
    if (service.api !== 'anthropic-messages') { log(`模型服务 ${ref} 讲 ${service.api}，Claude 只接 anthropic-messages 的`); return []; }
    let key;
    try { key = service.keyFile ? readFileSync(service.keyFile, 'utf8').trim() || undefined : undefined; }
    catch (e) { log(`读不到模型服务 ${ref} 的 Key：${e.message}`); }
    return [{ ref, title: service.title || ref, url: service.url, key }];
  });
}

// The models a service lists, asked as an Anthropic client asks (Coda's「检查可用模型」), or as it last listed them when
// it cannot be asked now (last-listed.mjs): `<服务>/<模型>`, named by the model, in the service's group. They have no
// effort to choose.
export async function serviceModels({ ref, title, url, key }, fetcher = fetch, state) {
  const listed = await lastListed(ref, async () => {
    const at = `${url.replace(/\/+$/, '')}/models?limit=1000`;
    const response = await fetcher(at, { headers: key ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } : {}, signal: AbortSignal.timeout(LIST_TIMEOUT) });
    if (!response.ok) throw new Error(`${at} 回答 ${response.status}`);
    const body = await response.json();
    // Only a list replaces the one kept: an answer of another shape is the service not answering.
    if (!Array.isArray(body?.data)) throw new Error(`${at} 的回答不是模型列表`);
    return body.data.filter(model => typeof model?.id === 'string' && model.id);
  }, state, log);
  return listed.map(model => ({ id: `${ref}/${model.id}`, name: model.id, efforts: [], model: model.id, service: ref, group: title }));
}

// The flag settings Claude Code runs a service's model with (above the machine's and the project's settings, its environment
// beneath them): the service as its API, a token of the service's own (`none` without one), and the model for every role,
// subagents' and background work's included. None of the machine's own ways to the API goes with it: an API key, a key
// helper, an OAuth token or custom headers would be sent to the service, a cloud provider's would take the requests away.
export function serviceSettings({ url, key }, model) {
  return { apiKeyHelper: '', env: { ...Object.fromEntries(authOverrides.map(name => [name, ''])), ANTHROPIC_BASE_URL: url, ANTHROPIC_AUTH_TOKEN: key ?? 'none',
    ANTHROPIC_MODEL: model, ANTHROPIC_DEFAULT_OPUS_MODEL: model, ANTHROPIC_DEFAULT_SONNET_MODEL: model, ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL: model } };
}

// The services' models, listed with Claude's own in the order the services are chosen: none of one that cannot list them
// now and never did (`state`: the plugin's state directory).
export async function listedModels(services, state) {
  return (await Promise.all(services.map(async service => {
    try { return await serviceModels(service, fetch, state); }
    catch (e) { log(`模型服务 ${service.ref} 列不出模型：${e.message}`); return []; }
  }))).flat();
}
