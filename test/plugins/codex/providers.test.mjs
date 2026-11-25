// The model service chosen for Codex (plugins/codex/agent/providers.mjs): which one, what it lists, and a turn on one of its
// models running on the session moved to the service as codex-acp moves it for `providers/set`. The patch is held against
// the locked codex-acp, and the real entry runs against the fixture app-server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { ServiceModels, chosenServices, servedCodexModels, serviceModels, serviceReference } from '../../../plugins/codex/agent/providers.mjs';
import { resolveFrom } from '../plugin.mjs';
import { pluginEnv } from '../command.mjs';

const bundle = await readFile(resolveFrom('codex', '@agentclientprotocol/codex-acp'), 'utf8');
const magpie = { plugin: 'magpie', title: 'Magpie · OpenAI Responses', api: 'openai-responses', url: 'http://127.0.0.1:3425/v1' };
const provided = (services, chosen = Object.keys(services)) => ({ CODA_PLUGIN_SETTINGS: JSON.stringify({ 'codex.modelProviders': chosen }), CODA_MODEL_PROVIDERS: JSON.stringify(services) });

test('the services chosen are those of this machine that speak the Responses API, in the order chosen, each key read from its file', t => {
  const dir = mkdtempSync(join(tmpdir(), 'coda-codex-providers-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(chosenServices({}), [], 'none chosen');
  assert.deepEqual(chosenServices({ CODA_PLUGIN_SETTINGS: JSON.stringify({ 'codex.modelProviders': 'magpie/responses' }) }), [], 'one written before it was several is none');
  writeFileSync(join(dir, 'key'), 'sk-service\n');
  // Codex no longer speaks Chat Completions (`wire_api = "chat"` is refused).
  assert.deepEqual(chosenServices(provided({ 'magpie/responses': { ...magpie, keyFile: join(dir, 'key') }, 'cliproxy/cliproxy': { ...magpie, api: 'openai-completions' },
    'space/s-proxy': { ...magpie, title: 'rig · Proxy', url: 'http://127.0.0.1:4000/v1' } }, ['space/s-proxy', 'gone/x', 'cliproxy/cliproxy', 'magpie/responses'])), [
    { ref: 'space/s-proxy', title: 'rig · Proxy', url: 'http://127.0.0.1:4000/v1', key: undefined },
    { ref: 'magpie/responses', title: 'Magpie · OpenAI Responses', url: 'http://127.0.0.1:3425/v1', key: 'sk-service' }], 'one not on this machine, or of another API, is left out');
});

test('its models are listed as Codex\'s model list has them, named by the model, in the service\'s group', async () => {
  const asked = [];
  const fetcher = async (url, { headers }) => { asked.push([url, headers]); return Response.json({ data: [{ id: 'deepseek/deepseek-v4-pro' }, { id: '' }] }); };
  assert.deepEqual(await serviceModels({ ref: 'magpie/responses', title: 'Magpie · OpenAI Responses', url: 'http://127.0.0.1:3425/v1/' }, fetcher), [{
    id: 'magpie/responses/deepseek/deepseek-v4-pro', model: 'deepseek/deepseek-v4-pro', displayName: 'deepseek/deepseek-v4-pro',
    description: '', hidden: false, isDefault: false, supportedReasoningEfforts: [], defaultReasoningEffort: 'medium', inputModalities: ['text', 'image'], serviceTiers: [],
    codaService: 'magpie/responses', codaGroup: 'Magpie · OpenAI Responses' }]);
  await serviceModels({ ref: 'x/y', title: 'X', url: 'https://example.com/v1', key: 'sk' }, fetcher);
  assert.deepEqual(asked, [['http://127.0.0.1:3425/v1/models', {}], ['https://example.com/v1/models', { Authorization: 'Bearer sk' }]]);
  await assert.rejects(serviceModels({ ref: 'x/y', title: 'X', url: 'https://example.com/v1' }, async () => Response.json({ error: { message: 'upstream' } })), /不是模型列表/);
  // Listed once a process; one that cannot list now adds none.
  const services = new ServiceModels([{ ref: 'x/y', title: 'X', url: 'http://127.0.0.1:1' }]);
  assert.deepEqual(await services.list(), []);
  assert.equal(services.list(), services.list());
});

test('with the plugin\'s state directory, a service that cannot list now lists as it last did', async t => {
  const state = mkdtempSync(join(tmpdir(), 'coda-codex-state-'));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const service = { ref: 'space/s-magpie', title: 'macmini · Magpie · OpenAI Responses', url: 'http://127.0.0.1:1' };
  const listed = async fetcher => (await new ServiceModels([service], fetcher, state).list()).map(m => [m.id, m.codaGroup]);
  const alpha = [['space/s-magpie/fake/alpha', 'macmini · Magpie · OpenAI Responses']];
  assert.deepEqual(await listed(async () => Response.json({ data: [{ id: 'fake/alpha' }] })), alpha);
  // An answer that is not a list is the service not answering: what it last listed stays, for a failure after it too.
  assert.deepEqual(await listed(async () => Response.json({ error: { message: 'upstream unavailable' } })), alpha);
  assert.deepEqual(await listed(fetch), alpha);
  // A list, an empty one too, replaces it.
  assert.deepEqual(await listed(async () => Response.json({ data: [] })), []);
  assert.deepEqual(await listed(fetch), []);
});

test('several services: their models a group each after Codex\'s own, in the order chosen; a turn on one\'s model moves the session to that one', async () => {
  const lists = { 'http://a/v1/models': ['fake/alpha'], 'http://b/v1/models': ['fake/beta'] };
  const services = new ServiceModels([{ ref: 'b/responses', title: 'B', url: 'http://b/v1' }, { ref: 'a/responses', title: 'A', url: 'http://a/v1', key: 'sk-a' }],
    async url => Response.json({ data: lists[url].map(id => ({ id })) }));
  await services.list();
  const options = [{ value: 'fake', name: 'Fake' }, { value: 'b/responses/fake/beta', name: 'fake/beta' }, { value: 'a/responses/fake/alpha', name: 'fake/alpha' }];
  assert.deepEqual(services.grouped(options).map(g => [g.group, g.name, g.options.map(o => o.value)]),
    [['codex', 'Codex', ['fake']], ['b/responses', 'B', ['b/responses/fake/beta']], ['a/responses', 'A', ['a/responses/fake/alpha']]]);
  assert.deepEqual(services.grouped(options.slice(0, 1)), options.slice(0, 1), 'Codex\'s alone stay one plain list');
  const moves = [], state = { currentModelId: 'b/responses/fake/beta' };
  const server = { sessions: new Map([['s', state]]), codexAcpClient: { appServerClient: { threadRead: async () => ({ thread: {} }) } },
    setProvider: async p => moves.push([p.baseUrl, p.headers]), disableProvider: async () => moves.push(['Codex']) };
  const turn = async model => { state.currentModelId = model; await services.move(server, { sessionId: 's', prompt: [] }); };
  await turn('b/responses/fake/beta'); await turn('a/responses/fake/alpha'); await turn('a/responses/fake/alpha'); await turn('fake');
  assert.deepEqual(moves, [['http://b/v1', {}], ['http://a/v1', { Authorization: 'Bearer sk-a' }], ['Codex']], 'another of the same service moves nothing');
});

test('what Codex says of the service\'s models it does not know is not said in the session; the rest is', async () => {
  const services = new ServiceModels([{ ref: 'magpie/responses', title: 'M', url: 'http://x' }], async () => Response.json({ data: [{ id: 'fake/alpha' }] }));
  await services.list();
  assert.equal(services.wire('magpie/responses/fake/alpha'), 'fake/alpha');
  assert.equal(services.wire('gpt-5.5'), 'gpt-5.5');
  assert.equal(services.quiet({ message: 'Model metadata for `fake/alpha` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.' }), true);
  assert.equal(services.quiet({ message: 'This session was recorded with model `fake/alpha` but is resuming with `gpt-6.1-sol`. Consider switching back.' }), true);
  assert.equal(services.quiet({ message: 'This session was recorded with model `gpt-5.5` but is resuming with `fake/alpha`. Consider switching back.' }), true);
  assert.equal(services.quiet({ message: 'Model metadata for `gpt-9` not found.' }), false);
  assert.equal(services.quiet({ message: 'Falling back from WebSockets to HTTPS transport.' }), false);
});

test('the service an injected address belongs to is its resource reference, of a model interface and a UUID; any other shape is none', () => {
  const id = '6F1A7C52-0d3b-4e8a-9a41-2b7d5c0e9f13';
  assert.equal(serviceReference(`http://127.0.0.1:3425/resources/openai-responses/${id}/v1`), `coda://openai-responses/${id.toLowerCase()}`);
  assert.equal(serviceReference(`http://127.0.0.1:3425/resources/openai-responses/${id}`), `coda://openai-responses/${id.toLowerCase()}`);
  for (const url of [`http://127.0.0.1:3425/resources/openai-responses/${id}x/v1`, `http://127.0.0.1:3425/resources/machines/${id}/v1`, 'http://127.0.0.1:3425/resources/openai-responses/not-a-uuid/v1',
    `http://127.0.0.1:3425/other/resources/openai-responses/${id}`, 'http://127.0.0.1:3425/v1', 'not a url', '', undefined]) assert.equal(serviceReference(url), null, String(url));
});

test('a turn is bound to the service its model is of and the model asked at its dispatch, and a prompt that sends no model request has none', async () => {
  const id = '6f1a7c52-0d3b-4e8a-9a41-2b7d5c0e9f13';
  const services = new ServiceModels([{ ref: 'a/responses', title: 'A', url: `http://127.0.0.1:3425/resources/openai-responses/${id}/v1` }, { ref: 'b/responses', title: 'B', url: 'http://b/v1' }],
    async () => Response.json({ data: [{ id: 'group/ds-flash' }] }));
  await services.list();
  const usage = { totalTokens: 12, inputTokens: 5, outputTokens: 7 }, state = { currentModelId: 'gpt-5.5' };
  // A server the route moves the session on, as the one of the move test above.
  const server = { sessions: new Map([['s', state]]), codexAcpClient: { appServerClient: { threadRead: async () => ({ thread: {} }) } },
    setProvider: async () => {}, disableProvider: async () => {} };
  const route = async model => { state.currentModelId = model; assert.equal(await services.route(server, { sessionId: 's', prompt: [] }), false); };
  const dispatch = async model => { await route(model); services.bind(state, model); };
  const reply = () => services.usage(state, usage);
  await dispatch('a/responses/group/ds-flash');
  assert.deepEqual(reply(), { ...usage, service: `coda://openai-responses/${id}`, asked: 'group/ds-flash' });
  await dispatch('b/responses/group/ds-flash');
  assert.equal(reply(), usage, 'no valid reference: neither');
  await dispatch('gpt-5.5');
  assert.equal(reply(), usage, 'Codex\'s own: neither');
  await dispatch('a/responses/group/ds-flash');
  // The next prompt starts unbound: if it sends no model request (a command), what the turn before was bound to is not its own.
  await route('a/responses/group/ds-flash');
  assert.equal(reply(), usage);
  assert.equal(services.usage(state, null), null);
});

test('the patch applies to the locked codex-acp, and fails loudly once it changes', () => {
  const served = servedCodexModels(bundle);
  assert.ok(served.startsWith('import { services as codaServices } from '), 'its own executable header gone');
  for (const added of ['return [...models, ...await codaServices.list()];', 'if (await codaServices.route(this, params)) return { stopReason: "cancelled" };',
    'codaServices.cancel(params.sessionId);', 'model: codaServices.wire(modelId.model),',
    'if (codaServices.quiet(notification.params)) return null;', 'options: codaServices.grouped(options),']) assert.equal(served.split(added).length, 2, added);
  assert.equal(served.split('codaServices.usage(sessionState, this.buildPromptUsage(sessionState.lastTokenUsage))').length, 5, 'every answer of a prompt');
  assert.equal(served.split('codaServices.bind(sessionState, modelId.model);').length, 2, 'the dispatch of a model request');
  const checked = spawnSync(process.execPath, ['--check', '--input-type=module'], { input: served, encoding: 'utf8' });
  assert.equal(checked.status, 0, checked.stderr);
  assert.throws(() => servedCodexModels(bundle.replace('      model: modelId.model,\n      serviceTier\n', '      model: modelId.model,\n')), /no longer matches/);
});

// The real entry against the fixture app-server, with the service (listing `fake/alpha`, a key of its own) chosen.
async function entryOnService(t, env = {}, path = '/v1', clientCapabilities = {}) {
  const root = mkdtempSync(join(tmpdir(), 'coda-codex-service-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const server = createServer((_, response) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data: [{ id: 'fake/alpha' }] })); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}${path}`;
  writeFileSync(join(root, 'key'), 'sk-service');
  // The fixture's first turn in a state directory dies; here it has died already.
  writeFileSync(join(root, 'died'), '');
  const codex = join(root, 'codex');
  writeFileSync(codex, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fileURLToPath(new URL('./app-server-fixture.mjs', import.meta.url)))}\n`);
  chmodSync(codex, 0o755);
  const entry = fileURLToPath(new URL('../../../plugins/codex/agent/entry.mjs', import.meta.url));
  const child = spawn(process.execPath, [entry], { cwd: root, stdio: ['pipe', 'pipe', 'ignore'],
    env: pluginEnv('codex', { CODEX_PATH: codex, FAKE_CODEX_STATE: root, CODEX_HOME: join(root, 'home'),
      ...provided({ 'magpie/responses': { ...magpie, url, keyFile: join(root, 'key') } }), ...env }) });
  t.after(() => child.kill('SIGKILL'));
  const out = [];
  let rest = '', next = 0;
  child.stdout.setEncoding('utf8').on('data', chunk => {
    const lines = (rest + chunk).split('\n'); rest = lines.pop();
    for (const line of lines) out.push(JSON.parse(line));
  });
  const request = async (method, params) => {
    const id = `coda-${++next}`;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    for (let i = 0; i < 2000; i++) { const answer = out.find(m => m.id === id && !m.method); if (answer) return answer; await delay(5); }
    throw new Error(`${method} 没有回答`);
  };
  const read = name => existsSync(join(root, name)) ? readFileSync(join(root, name), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  await request('initialize', { protocolVersion: 1, clientCapabilities });
  const opened = (await request('session/new', { cwd: root, mcpServers: [], systemPrompt: { mode: 'append', content: [{ type: 'text', text: '# Coda' }] } })).result;
  return { url, root, opened, request,
    cancel: () => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: opened.sessionId } })}\n`),
    set: value => request('session/set_config_option', { sessionId: opened.sessionId, configId: 'model', value }),
    prompt: text => request('session/prompt', { sessionId: opened.sessionId, prompt: [{ type: 'text', text }] }),
    // The session's own: not the ephemeral thread and structured turn codex-acp titles the session with.
    threads: () => read('threads.ndjson').filter(t => !t.params.ephemeral), turns: () => read('prompts.ndjson').filter(p => !p.outputSchema) };
}

test('through the real entry: a turn on the service\'s model runs on the session moved to the service, and one on Codex\'s own moves it back', async t => {
  const { url, opened, set, prompt, threads, turns } = await entryOnService(t);
  const models = opened.configOptions.find(o => o.category === 'model');
  assert.deepEqual(models.options.map(g => [g.group, g.name, g.options.map(o => [o.value, o.name])]), [['codex', 'Codex', [['fake', 'Fake']]],
    ['magpie/responses', 'Magpie · OpenAI Responses', [['magpie/responses/fake/alpha', 'fake/alpha']]]]);
  const chosen = (await set('magpie/responses/fake/alpha')).result.configOptions;
  assert.equal(chosen.find(o => o.category === 'model').currentValue, 'magpie/responses/fake/alpha');
  assert.equal(chosen.find(o => o.category === 'thought_level'), undefined, 'no effort to choose');
  assert.deepEqual(threads().map(t => t.method), ['thread/start'], 'chosen, nothing moves yet');
  // Nothing said in the thread yet: it is named by what it is first told, then resumed on the service, with Coda's instructions.
  assert.equal((await prompt('  hello\nthere ')).result.stopReason, 'end_turn');
  const [named, moved] = threads().slice(1);
  assert.deepEqual([named.method, named.params.name], ['thread/name/set', 'hello there']);
  assert.deepEqual([moved.method, moved.params.threadId, moved.params.modelProvider, moved.params.developerInstructions], ['thread/resume', opened.sessionId, 'custom-gateway', '# Coda']);
  assert.deepEqual(moved.params.config.model_providers['custom-gateway'], { name: 'User-provided gateway', base_url: url, wire_api: 'responses',
    http_headers: { 'X-Client-Feature-ID': 'codex', Authorization: 'Bearer sk-service' } });
  assert.equal(turns().at(-1).model, 'fake/alpha', 'named as the service names it');
  // Another turn on it moves nothing; Codex's own model moves the session back to Codex's provider.
  await prompt('again');
  assert.equal(threads().length, 3);
  await set('fake');
  await prompt('native');
  const back = threads().at(-1);
  assert.deepEqual([threads().length, back.method, back.params.modelProvider, back.params.developerInstructions, back.params.config.model_providers],
    [4, 'thread/resume', 'openai', '# Coda', undefined]);
  assert.equal(turns().at(-1).model, 'fake');
});

test('through the real entry: a turn says the service and model it was sent on, and a `/status` after switching models says none, whichever model is chosen', async t => {
  const id = '6f1a7c52-0d3b-4e8a-9a41-2b7d5c0e9f13';
  const { set, prompt } = await entryOnService(t, { FAKE_CODEX_TOKENS: '1' }, `/resources/openai-responses/${id}/v1`);
  const told = { totalTokens: 30, inputTokens: 15, cachedReadTokens: 5, cachedWriteTokens: 0, outputTokens: 10, thoughtTokens: 2 };
  const used = async text => (await prompt(text)).result.usage;
  await set('magpie/responses/fake/alpha');
  assert.deepEqual(await used('hello'), { ...told, service: `coda://openai-responses/${id}`, asked: 'fake/alpha' });
  // Codex's own model, then `/status` on the service's model chosen after it: it sent no model request, so it has no usage to say.
  await set('fake');
  assert.deepEqual(await used('native'), told);
  await set('magpie/responses/fake/alpha');
  assert.equal(await used('/status'), null, 'the model chosen after is not the one the usage was of');
  // And the other way: the service's turn, then `/status` on Codex's own.
  assert.deepEqual(await used('again'), { ...told, service: `coda://openai-responses/${id}`, asked: 'fake/alpha' });
  await set('fake');
  assert.equal(await used('/status'), null);
});

test('through the real entry: a turn of several model calls says all of them, and the turn after a move of the session says only what it used since', async t => {
  const { root, set, prompt } = await entryOnService(t, { FAKE_CODEX_TOKENS: '3' });
  const used = async text => (await prompt(text)).result.usage;
  const calls = { totalTokens: 90, inputTokens: 45, cachedReadTokens: 15, cachedWriteTokens: 0, outputTokens: 30, thoughtTokens: 6 };
  await set('magpie/responses/fake/alpha');
  assert.deepEqual(await used('hello'), calls, 'an address of no reference says no service');
  // Between the turns the thread's count grows by what this process was not told of (used elsewhere), and Codex tells the count again before the next turn
  // (as it does when a thread is resumed): that only moves what the count is taken from, and the turn says its own calls, not the 100000 beside them.
  const kept = join(root, 'tokens.json'), tokens = JSON.parse(readFileSync(kept, 'utf8'));
  for (const key of ['totalTokens', 'inputTokens']) tokens.total[key] += 100000;
  writeFileSync(kept, JSON.stringify(tokens));
  writeFileSync(join(root, 'snapshot.json'), JSON.stringify(tokens.total));
  await set('fake');
  assert.deepEqual(await used('native'), calls);
  assert.equal(await used('/status'), null);
});

// What the host sends in `initialize` (Coda's backend/src/domain/agent-protocol.mjs `clientCapabilities`) has no `subagents`: the subagents' events reach codex-acp
// as the session's own. Native subagent sessions are what a client that declares `subagents` has: their first events are held back until their session is made.
for (const [name, capabilities] of [['the capabilities the host sends', { elicitation: { form: {}, url: {} }, session: { compaction: {}, configOptions: { boolean: {} } }, _meta: { coda: { waits: {}, remote: {}, unrecognized: {} } } }],
  ['native subagent sessions', { subagents: {} }]]) {
  test(`through the real entry, on ${name}: the usage of a subagent is the parent turn's that it came in, once`, async t => {
    const { prompt } = await entryOnService(t, { FAKE_CODEX_TOKENS: '1' }, '/v1', capabilities);
    const own = { totalTokens: 30, inputTokens: 15, cachedReadTokens: 5, cachedWriteTokens: 0, outputTokens: 10, thoughtTokens: 2 };
    assert.deepEqual((await prompt('hello')).result.usage, own);
    assert.deepEqual((await prompt('run a subagent')).result.usage, { totalTokens: 60, inputTokens: 30, cachedReadTokens: 10, cachedWriteTokens: 0, outputTokens: 20, thoughtTokens: 4 }, 'its own and the subagent\'s');
    // Two of the subagent's notifications told before its session is made, and handled again once it is: counted once.
    assert.deepEqual((await prompt('staged children')).result.usage, { totalTokens: 90, inputTokens: 45, cachedReadTokens: 15, cachedWriteTokens: 0, outputTokens: 30, thoughtTokens: 6 }, 'its own and the subagent\'s 60, not more');
    // The subagent's turn began and counted twice before its parent told of it, and once after: all of it, once.
    assert.deepEqual((await prompt('early children')).result.usage, { totalTokens: 120, inputTokens: 60, cachedReadTokens: 20, cachedWriteTokens: 0, outputTokens: 40, thoughtTokens: 8 }, 'its own 30 and the subagent\'s 90');
    assert.deepEqual((await prompt('again')).result.usage, own);
  });
}

test('through the real entry: a turn stopped while the session moves to the service ends cancelled, its input not given', async t => {
  // The move is held where it reads the thread, until the stop has come.
  const { root, request, set, prompt, cancel, turns } = await entryOnService(t, { FAKE_CODEX_HOLD: 'thread/read' });
  await set('magpie/responses/fake/alpha');
  const stopped = prompt('hello');
  for (let i = 0; i < 400 && !existsSync(join(root, 'held')); i++) await delay(5);
  // The entry reads what it is sent in order: a request answered after the stop says the stop was read before it.
  cancel();
  assert.equal((await request('coda/barrier', {})).error?.code, -32601);
  writeFileSync(join(root, 'release'), '');
  assert.equal((await stopped).result?.stopReason, 'cancelled');
  assert.equal(turns().length, 0, 'the input of a stopped turn is not given');
  assert.equal((await prompt('again')).result?.stopReason, 'end_turn');
  assert.equal(turns().at(-1).model, 'fake/alpha', 'the next turn runs on the service');
});

test('through the real entry: a move whose resume fails fails its turn, and the next turn moves the session again', async t => {
  const { set, prompt, threads, turns } = await entryOnService(t, { FAKE_CODEX_FAIL_ONCE: 'thread/resume' });
  await set('magpie/responses/fake/alpha');
  const failed = await prompt('hello');
  assert.match(failed.error?.message ?? '', /Failed to resume 1 session/);
  assert.equal(turns().length, 0, 'no turn on a thread not resumed');
  assert.equal((await prompt('again')).result?.stopReason, 'end_turn');
  assert.deepEqual(threads().filter(t => t.method === 'thread/resume').map(t => t.params.modelProvider), ['custom-gateway', 'custom-gateway']);
  assert.equal(turns().at(-1).model, 'fake/alpha');
  // Back on Codex's own after it: moved back as well.
  await set('fake'); await prompt('native');
  assert.deepEqual([threads().at(-1).params.modelProvider, turns().at(-1).model], ['openai', 'fake']);
});

test('through the real entry: a move whose restarted Codex does not start fails its turn, and the next moves the session on a Codex that does', async t => {
  // The second initialize: that of the app-server started again for the move.
  const { set, prompt, threads, turns } = await entryOnService(t, { FAKE_CODEX_FAIL_ONCE: 'initialize#2' });
  await set('magpie/responses/fake/alpha');
  const failed = await prompt('hello');
  assert.match(failed.error?.message ?? '', /initialize failed/);
  assert.equal(turns().length, 0, 'no turn on a Codex that did not start');
  // Back on Codex's own, as well as on to the service again.
  await set('fake');
  assert.equal((await prompt('native')).result?.stopReason, 'end_turn');
  assert.deepEqual([threads().at(-1).method, threads().at(-1).params.modelProvider, turns().at(-1).model], ['thread/resume', 'openai', 'fake']);
  await set('magpie/responses/fake/alpha');
  assert.equal((await prompt('service')).result?.stopReason, 'end_turn');
  assert.deepEqual([threads().at(-1).params.modelProvider, turns().at(-1).model], ['custom-gateway', 'fake/alpha']);
});
