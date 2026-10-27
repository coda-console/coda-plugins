// The model services chosen in Coda (`opencode.modelProviders`) become native OpenCode providers, a separate one each, through
// the child process's inline config. OpenCode lists, selects and resumes their models itself; the machine's own providers and
// config files stay as they are.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parseTree } from 'jsonc-parser';
import { lastListed } from './last-listed.mjs';

export const SETTING = 'opencode.modelProviders';
const packages = { 'openai-completions': '@ai-sdk/openai-compatible', 'openai-responses': '@ai-sdk/openai', 'anthropic-messages': '@ai-sdk/anthropic' };
const log = text => process.stderr.write(`[opencode-agent] ${text}\n`);
const parse = text => { try { return JSON.parse(text || '{}'); } catch { return {}; } };

// The services chosen, in the order chosen. One not on this machine, speaking an API OpenCode is not given, or whose key
// cannot be read is left out.
export function chosenServices(env = process.env) {
  const refs = parse(env.CODA_PLUGIN_SETTINGS)?.[SETTING], provided = parse(env.CODA_MODEL_PROVIDERS);
  return (Array.isArray(refs) ? refs : []).flatMap(ref => {
    const service = provided?.[ref];
    if (!service?.url) { log(`模型服务 ${ref} 在这台机器上没有`); return []; }
    if (!Object.hasOwn(packages, service.api)) { log(`模型服务 ${ref} 的接口 ${service.api} 不受 OpenCode 插件支持`); return []; }
    let key;
    try { key = service.keyFile ? readFileSync(service.keyFile, 'utf8').trim() || undefined : undefined; }
    catch { log(`读不到模型服务 ${ref} 的 Key`); return []; }
    return [{ ref, title: service.title || ref, api: service.api, url: service.url, key }];
  });
}

// Provider IDs cannot contain '/', which OpenCode uses to split a provider from a model. Coda refs have two components
// made of letters, digits and hyphens, so '.' preserves their identity without colliding with a native provider name.
export const providerId = ref => `coda-${ref.replaceAll('/', '.')}`;

// Same endpoint and authentication as Coda's model check. Keep slash-containing model IDs intact and follow Anthropic's
// pagination, bounded by a single timeout and ten pages. Nothing from the machine's own API credentials is sent here.
// With the plugin's state directory, one that cannot list now lists as it last did (last-listed.mjs).
export const serviceModels = (service, fetcher = fetch, state) => lastListed(service.ref, () => askModels(service, fetcher), state, log);
async function askModels({ api, url, key }, fetcher) {
  const at = `${url.replace(/\/+$/, '')}/models`, anthropic = api === 'anthropic-messages';
  const headers = anthropic ? { 'anthropic-version': '2023-06-01', ...(key ? { 'x-api-key': key } : {}) }
    : key ? { Authorization: `Bearer ${key}` } : {};
  const models = new Map(), signal = AbortSignal.timeout(8000);
  let after;
  for (let page = 0; page < 10; page++) {
    const query = anthropic ? `?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ''}` : '';
    const response = await fetcher(at + query, { headers, signal });
    if (!response.ok) throw new Error(`模型列表回答 ${response.status}`);
    const body = await response.json();
    if (!Array.isArray(body?.data)) throw new Error('回答不是模型列表');
    for (const model of body.data) if (typeof model?.id === 'string' && model.id) models.set(model.id, model);
    if (!anthropic || !body.has_more || typeof body.last_id !== 'string' || !body.last_id || body.last_id === after) break;
    after = body.last_id;
  }
  return [...models.values()];
}

const positive = value => Number.isSafeInteger(value) && value > 0;
export function serviceProvider(service, models) {
  const url = service.url.replace(/\/+$/, '');
  return {
    name: service.title, npm: packages[service.api], env: [],
    // The Anthropic SDK takes a /v1 base, whereas Coda's Anthropic service address may be the API root.
    // An explicit placeholder prevents the SDK falling back to OPENAI_API_KEY / ANTHROPIC_API_KEY for a keyless service.
    options: { baseURL: service.api === 'anthropic-messages' && !url.endsWith('/v1') ? `${url}/v1` : url, apiKey: service.key ?? 'none' },
    models: Object.fromEntries(models.map(model => [model.id, {
      name: model.id,
      // /models commonly has no limits. OpenCode's default of zero would compact immediately; use conservative limits
      // unless the service supplies them. Do not guess image support or reasoning settings from a model's name.
      limit: { context: positive(model.context_length) ? model.context_length : 32768,
        output: positive(model.max_output_tokens) ? model.max_output_tokens : 4096 },
    }])),
  };
}

// OpenCode expands {env:...} and {file:...} on the config text BEFORE parsing JSON. Only the generated data is quoted this
// way: escaping '{' within JSON string tokens preserves their literal value without exposing an interpolation template.
export const literalJSON = value => JSON.stringify(value).replace(/"(?:\\.|[^"\\])*"/g, token => token.replaceAll('{', '\\u007b'));

export function configObject(text, envExpanded = false) {
  // Same-length placeholders let JSONC parse unquoted templates; offsets still refer to the untouched source. OpenCode
  // expands env once, then files, so file paths can contain env templates. Keep that whole file token together; a value
  // supplied by env cannot introduce another unquoted env template.
  const syntax = text.replace(/"(?:\\.|[^"\\])*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|\{env:[^}]+\}|\{file:(?:\{env:[^}]+\}|[^}])+\}/g,
    token => token.startsWith('{') && !(envExpanded && token.startsWith('{env:')) ? `"${' '.repeat(token.length - 2)}"` : token);
  const errors = [], root = parseTree(syntax, errors, { allowTrailingComma: true });
  if (errors.length) throw new SyntaxError(`OPENCODE_CONFIG_CONTENT 不是有效的 JSONC（位置 ${errors[0].offset}）`);
  if (root?.type !== 'object') throw new SyntaxError('OPENCODE_CONFIG_CONTENT 必须是 JSONC 对象');
  // Keep raw strings/templates, but normalize JSONC for older OpenCode. Parsing and re-stringifying values would turn
  // the user's deliberately escaped \u007b into an active template.
  const render = node => node.type === 'object' ? `{${node.children.map(render).join(',')}}`
    : node.type === 'array' ? `[${node.children.map(render).join(',')}]`
    : node.type === 'property' ? node.children.map(render).join(':') : text.slice(node.offset, node.offset + node.length);
  const named = (node, key) => node.children[0].value === key;
  return {
    get(key) { const node = root.children.findLast(node => named(node, key)); return node && render(node.children[1]); },
    set(key, value) { return `{${[...root.children.filter(node => !named(node, key)).map(render), `${literalJSON(key)}:${value}`].join(',')}}`; },
  };
}

function inlineProvider(text, id, provider, env) {
  const config = configObject(text), source = config.get('provider') ?? '{}';
  const variable = /^\{env:([^}]+)\}$/.exec(source);
  const value = configObject(variable ? env[variable[1]] || '' : source, !!variable).set(id, literalJSON(provider));
  if (!variable) return { OPENCODE_CONFIG_CONTENT: config.set('provider', value) };
  // Retain one env pass, followed by native file expansion. A child-only variable leaves the original variable and all
  // other config entry points unchanged, and does not recursively expand templates inside the provider object.
  const name = `CODA_OPENCODE_PROVIDER_${randomUUID().replaceAll('-', '_')}`;
  return { [name]: value, OPENCODE_CONFIG_CONTENT: config.set('provider', `{env:${name}}`) };
}

// The chosen services' providers by ID, each named by its service's title (groups.mjs).
export const serviceNames = services => Object.fromEntries(services.map(service => [providerId(service.ref), service.title]));

export async function providerEnvironment(env = process.env, fetcher = fetch, services = chosenServices(env)) {
  const listed = await Promise.all(services.map(async service => {
    try { return [service, await serviceModels(service, fetcher, env.CODA_PLUGIN_STATE)]; }
    catch (error) { log(`模型服务 ${service.ref} 列不出模型：${error.message}`); return [service, []]; }
  }));
  // Invalid user configuration still fails clearly, without echoing config contents (which may include credentials).
  return listed.filter(([, models]) => models.length).reduce((at, [service, models]) => ({ ...at,
    ...inlineProvider(at.OPENCODE_CONFIG_CONTENT || '{}', providerId(service.ref), serviceProvider(service, models), at) }), env);
}
