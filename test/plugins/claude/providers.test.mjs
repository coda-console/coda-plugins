// The model service chosen for Claude (plugins/claude/agent/providers.mjs): which one, what it lists, what a session on it runs with.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chosenServices, listedModels, serviceModels, serviceReference, serviceSettings } from '../../../plugins/claude/agent/providers.mjs';

const provided = (services, chosen = Object.keys(services)) => ({ CODA_PLUGIN_SETTINGS: JSON.stringify({ 'claude.modelProviders': chosen }), CODA_MODEL_PROVIDERS: JSON.stringify(services) });
const magpie = { plugin: 'magpie', title: 'Magpie · Anthropic', api: 'anthropic-messages', url: 'http://127.0.0.1:3425' };

test('the services chosen are those of this machine that speak Anthropic Messages, in the order chosen, each key read from its file', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'coda-claude-providers-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.deepEqual(chosenServices({}), [], 'none chosen');
  assert.deepEqual(chosenServices({ CODA_PLUGIN_SETTINGS: JSON.stringify({ 'claude.modelProviders': [] }) }), [], '「不用」');
  assert.deepEqual(chosenServices({ CODA_PLUGIN_SETTINGS: JSON.stringify({ 'claude.modelProviders': 'magpie/anthropic' }) }), [], 'one written before it was several is none');
  await writeFile(join(dir, 'key'), 'sk-service\n');
  const services = { 'magpie/anthropic': magpie, 'space/s-proxy': { ...magpie, title: 'rig · Proxy', url: 'http://127.0.0.1:4000', keyFile: join(dir, 'key') },
    'magpie/openai': { ...magpie, api: 'openai-completions' } };
  assert.deepEqual(chosenServices(provided(services, ['space/s-proxy', 'gone/x', 'magpie/openai', 'magpie/anthropic'])), [
    { ref: 'space/s-proxy', title: 'rig · Proxy', url: 'http://127.0.0.1:4000', key: 'sk-service' },
    { ref: 'magpie/anthropic', title: 'Magpie · Anthropic', url: 'http://127.0.0.1:3425', key: undefined }], 'one not on this machine, or of another API, is left out');
});

test('its models are listed as an Anthropic client asks, named by the model, in the service\'s group', async () => {
  const asked = [];
  const fetcher = async (url, { headers }) => {
    asked.push([url, headers]);
    return Response.json({ data: [{ id: 'deepseek/deepseek-v4-pro', display_name: 'DeepSeek V4 Pro' }, { id: '' }, { name: 'no id' }], has_more: false });
  };
  const models = await serviceModels({ ref: 'magpie/anthropic', title: 'Magpie · Anthropic', url: 'http://127.0.0.1:3425/' }, fetcher);
  assert.deepEqual(models, [{ id: 'magpie/anthropic/deepseek/deepseek-v4-pro', name: 'deepseek/deepseek-v4-pro', efforts: [], model: 'deepseek/deepseek-v4-pro',
    service: 'magpie/anthropic', group: 'Magpie · Anthropic' }]);
  await serviceModels({ ref: 'x/y', title: 'X', url: 'https://example.com', key: 'sk' }, fetcher);
  assert.deepEqual(asked, [['http://127.0.0.1:3425/models?limit=1000', {}],
    ['https://example.com/models?limit=1000', { 'x-api-key': 'sk', 'anthropic-version': '2023-06-01' }]]);
  await assert.rejects(serviceModels({ ref: 'x/y', title: 'X', url: 'https://example.com' }, async () => new Response('', { status: 401 })), /回答 401/);
  await assert.rejects(serviceModels({ ref: 'x/y', title: 'X', url: 'https://example.com' }, async () => Response.json({ error: { message: 'upstream' } })), /不是模型列表/);
  // A service that cannot list now adds none, and the others' still come, and the session opens with Claude's own.
  assert.deepEqual(await listedModels([{ ref: 'x/y', title: 'X', url: 'http://127.0.0.1:1' }]), []);
  assert.deepEqual(await listedModels([]), []);
});

test('with the plugin\'s state directory, a service that cannot list now lists as it last did, in its group as titled now', async t => {
  const state = await mkdtemp(join(tmpdir(), 'coda-claude-state-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const service = { ref: 'space/s-magpie', title: 'macmini · Magpie · Anthropic', url: 'http://127.0.0.1:1' };
  const listed = [{ id: 'space/s-magpie/deepseek/deepseek-v4-pro', name: 'deepseek/deepseek-v4-pro', efforts: [], model: 'deepseek/deepseek-v4-pro',
    service: 'space/s-magpie', group: 'macmini · Magpie · Anthropic' }];
  assert.deepEqual(await serviceModels(service, async () => Response.json({ data: [{ id: 'deepseek/deepseek-v4-pro' }] }), state), listed);
  // An answer that is not a list is the service not answering: what it last listed stays, for a failure after it too.
  assert.deepEqual(await serviceModels(service, async () => Response.json({ error: { message: 'upstream unavailable' } }), state), listed);
  assert.deepEqual(await listedModels([service], state), listed);
  // A list, an empty one too, replaces it.
  assert.deepEqual(await serviceModels(service, async () => Response.json({ data: [] }), state), []);
  assert.deepEqual(await listedModels([service], state), []);
});

test('a session on a service\'s model runs Claude Code with the service as its API and that model for every role, none of the machine\'s credentials with it', () => {
  const cleared = { ANTHROPIC_API_KEY: '', ANTHROPIC_CUSTOM_HEADERS: '', CLAUDE_CODE_OAUTH_TOKEN: '', CLAUDE_CODE_OAUTH_REFRESH_TOKEN: '', CLAUDE_CODE_OAUTH_SCOPES: '',
    CLAUDE_CODE_USE_BEDROCK: '', CLAUDE_CODE_USE_VERTEX: '', CLAUDE_CODE_USE_FOUNDRY: '' };
  assert.deepEqual(serviceSettings({ url: 'http://127.0.0.1:3425' }, 'deepseek/deepseek-v4-pro'), { apiKeyHelper: '', env: { ...cleared,
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:3425', ANTHROPIC_AUTH_TOKEN: 'none', ANTHROPIC_MODEL: 'deepseek/deepseek-v4-pro', ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek/deepseek-v4-pro',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek/deepseek-v4-pro', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek/deepseek-v4-pro', CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek/deepseek-v4-pro' } });
  assert.equal(serviceSettings({ url: 'https://example.com', key: 'sk' }, 'm').env.ANTHROPIC_AUTH_TOKEN, 'sk');
});

test('the service an injected address belongs to is its resource reference, of a model interface and a UUID; any other shape is none', () => {
  const id = '6F1A7C52-0d3b-4e8a-9a41-2b7d5c0e9f13';
  assert.equal(serviceReference(`http://127.0.0.1:3425/resources/anthropic-messages/${id}`), `coda://anthropic-messages/${id.toLowerCase()}`);
  assert.equal(serviceReference(`http://127.0.0.1:3425/resources/openai-responses/${id}/v1`), `coda://openai-responses/${id.toLowerCase()}`);
  for (const url of [`http://127.0.0.1:3425/resources/openai-responses/${id}x/v1`, `http://127.0.0.1:3425/resources/machines/${id}/v1`, `http://127.0.0.1:3425/resources/openai-responses/not-a-uuid/v1`,
    `http://127.0.0.1:3425/other/resources/openai-responses/${id}`, 'http://127.0.0.1:3425/v1', 'not a url', '', undefined]) assert.equal(serviceReference(url), null, String(url));
});
