// Opt-in real CLI check, using only a local HTTP fixture and isolated OpenCode directories:
// OPENCODE_TEST_BINARY=/absolute/path/to/opencode node --test test/plugins/opencode/native.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentProcess } from '../../../check/process.mjs';
import { pluginDir } from '../plugin.mjs';

const binary = process.env.OPENCODE_TEST_BINARY;
const manifest = JSON.parse(readFileSync(join(pluginDir('opencode'), 'package.json'), 'utf8'));

// Both streaming turns and non-streaming background requests get valid, deterministic answers. No tools are requested.
function answer(response, path, body) {
  const text = 'Fixture answer', model = body.model;
  const message = { id: 'msg_test', type: 'message', role: 'assistant', model, content: [{ type: 'text', text }],
    stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 2 } };
  const output = { id: 'msg_test', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
  const result = { id: 'resp_test', object: 'response', created_at: 1, status: 'completed', model, output: [output],
    usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } };
  if (!body.stream) {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(path.endsWith('/messages') ? message : path.endsWith('/responses') ? result
      : { id: 'chat_test', object: 'chat.completion', created: 1, model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }));
    return;
  }
  response.setHeader('content-type', 'text/event-stream');
  const event = data => response.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
  if (path.endsWith('/messages')) {
    event({ type: 'message_start', message: { ...message, content: [], stop_reason: null } });
    event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
    event({ type: 'content_block_stop', index: 0 });
    event({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } });
    event({ type: 'message_stop' });
  } else if (path.endsWith('/responses')) {
    event({ type: 'response.created', response: { ...result, status: 'in_progress', output: [] } });
    event({ type: 'response.output_item.added', output_index: 0, item: { ...output, status: 'in_progress', content: [] } });
    event({ type: 'response.content_part.added', item_id: output.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    event({ type: 'response.output_text.delta', item_id: output.id, output_index: 0, content_index: 0, delta: text });
    event({ type: 'response.output_text.done', item_id: output.id, output_index: 0, content_index: 0, text });
    event({ type: 'response.output_item.done', output_index: 0, item: output });
    event({ type: 'response.completed', response: result });
  } else {
    for (const choice of [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }, { index: 0, delta: {}, finish_reason: 'stop' }])
      response.write(`data: ${JSON.stringify({ id: 'chat_test', object: 'chat.completion.chunk', created: 1, model, choices: [choice] })}\n\n`);
    response.write('data: [DONE]\n\n');
  }
  response.end();
}

const cases = ['openai-completions', 'openai-responses', 'anthropic-messages'].flatMap(api => [true, false].map(keyed => ({ api, keyed })));
cases.push(...['env', 'file', 'jsonc', 'unquoted', 'provider-template', 'config-template'].map(regression => ({ api: 'openai-completions', keyed: false, regression })));
for (const { api, keyed, regression } of cases)
  test(`real OpenCode: ${regression ?? api} (${keyed ? 'service key' : 'keyless'}) models, turn, native model switch and process resume`,
    { skip: !binary, timeout: 120_000 }, async t => {
    const root = mkdtempSync(join(tmpdir(), 'coda-opencode-native-')), agents = [], requests = [];
    t.after(async () => { for (const agent of agents) { await agent.terminate(1000); agent.kill(); } rmSync(root, { recursive: true, force: true }); });
    mkdirSync(join(root, '.opencode/bin'), { recursive: true });
    symlinkSync(binary, join(root, '.opencode/bin/opencode'));
    writeFileSync(join(root, 'key'), 'fixture-service-key');
    const privateFile = join(root, 'private.txt');
    writeFileSync(privateFile, 'synthetic-file-secret');
    const model = regression === 'env' ? 'vendor/{env:OPENAI_API_KEY}'
      : regression === 'file' ? `vendor/{file:${privateFile}}`
      : regression === 'provider-template' ? 'vendor/{env:OPENAI_API_KEY}/{file:private.txt}' : 'vendor/test-model';
    const server = createServer(async (request, response) => {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const body = raw ? JSON.parse(raw) : {};
      requests.push({ path: request.url, headers: request.headers, body });
      if (request.method === 'GET') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ data: [{ id: model }] })); return;
      }
      answer(response, request.url, body);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const url = `http://127.0.0.1:${server.address().port}`, id = `coda-fixture.service/${model}`;
    const nativeConfig = { $schema: 'https://opencode.ai/config.json', model: 'fixture/native', small_model: 'fixture/native', autoupdate: false,
      provider: { fixture: { npm: '@ai-sdk/openai-compatible', options: { baseURL: `${url}/native/v1`, apiKey: 'fixture-native-key' },
        models: { native: { name: 'Native fixture', limit: { context: 32768, output: 4096 } } } } } };
    writeFileSync(join(root, 'opencode.json'), JSON.stringify(nativeConfig));
    if (regression === 'provider-template') {
      mkdirSync(join(root, 'custom-dir'));
      for (const [file, name] of [['custom.jsonc', 'from-file'], ['custom-dir/opencode.json', 'from-dir']])
        writeFileSync(join(root, file), JSON.stringify({ $schema: nativeConfig.$schema, provider: {
          fixture: { models: { [name]: { name, limit: { context: 32768, output: 4096 } } } },
        } }));
    }
    const open = () => {
      const updates = [];
      const agent = new AgentProcess({ command: manifest.contributes.agents[0].command, cwd: root,
        env: { PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'),
          XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'),
          OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true', OPENCODE_DISABLE_MODELS_FETCH: 'true',
          OPENAI_API_KEY: 'unrelated-native-secret', ANTHROPIC_API_KEY: 'unrelated-native-secret', ANTHROPIC_AUTH_TOKEN: 'unrelated-native-secret',
          ...(regression === 'jsonc' ? { OPENCODE_TEST_USER_KEY: 'user-config-key', OPENCODE_CONFIG_CONTENT:
            `{ // User's inline overrides still expand; comments and trailing commas are valid.\n "provider": { "fixture": { "options": {
              "apiKey": "{env:OPENCODE_TEST_USER_KEY}", "headers": { "x-user-file": "{file:${privateFile}}", },
            }, }, }, }` } : {}),
          ...(regression === 'unquoted' ? { OPENCODE_TEST_AUTOUPDATE: 'false', OPENCODE_TEST_CONTEXT: '65536', OPENCODE_TEST_OUTPUT: '1024',
            OPENCODE_CONFIG_CONTENT: `{ // OpenCode expands these before parsing their boolean/number types.\n
              "autoupdate": {env:OPENCODE_TEST_AUTOUPDATE}, "provider": { "fixture": { "models": { "native": { "limit": {
                "context": {env:OPENCODE_TEST_CONTEXT}, "output": {env:OPENCODE_TEST_OUTPUT},
              }, }, }, }, }, }` } : {}),
          ...(regression === 'provider-template' ? {
            REVIEW_PROVIDER: JSON.stringify({ fixture: { ...nativeConfig.provider.fixture, options: {
              ...nativeConfig.provider.fixture.options, apiKey: 'provider-template-key',
              headers: { 'x-literal': '{env:OPENAI_API_KEY}', 'x-user-file': '{file:private.txt}' },
            } } }),
            OPENCODE_CONFIG_CONTENT: '{"provider":{env:REVIEW_PROVIDER}}',
            OPENCODE_CONFIG: join(root, 'custom.jsonc'), OPENCODE_CONFIG_DIR: join(root, 'custom-dir'),
          } : {}),
          ...(regression === 'config-template' ? {
            ALL_CONFIG: JSON.stringify({ autoupdate: false, provider: { fixture: { ...nativeConfig.provider.fixture, options: {
              ...nativeConfig.provider.fixture.options, apiKey: 'config-template-key',
              headers: { 'x-literal': '{env:OPENAI_API_KEY}', 'x-user-file': '{file:private.txt}' },
            } } } }), OPENCODE_CONFIG_CONTENT: '{env:ALL_CONFIG}',
          } : {}),
          CODA_NODE: process.execPath, CODA_PLUGIN_PATH: pluginDir('opencode'),
          CODA_PLUGIN_SETTINGS: JSON.stringify({ 'opencode.modelProviders': ['fixture/service'] }),
          CODA_MODEL_PROVIDERS: JSON.stringify({ 'fixture/service': { api, title: 'Service fixture', url: api === 'anthropic-messages' ? url : `${url}/v1`, ...(keyed ? { keyFile: join(root, 'key') } : {}) } }) },
        onMessage: m => updates.push(m) });
      agents.push(agent);
      const request = async (method, params) => {
        const reply = await agent.request(method, params, { timeout: 45_000 });
        assert.equal(reply.error, undefined, JSON.stringify(reply.error) + agent.stderr);
        return reply.result;
      };
      return { agent, request, updates };
    };
    const first = open();
    await first.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    const session = await first.request('session/new', { cwd: root, mcpServers: [] });
    const modelOption = session.configOptions?.find(option => option.category === 'model');
    const flatten = options => options.flatMap(option => option.options ? flatten(option.options) : [option.value]);
    const models = modelOption ? flatten(modelOption.options) : session.models?.availableModels.map(model => model.modelId);
    assert.ok(models?.includes(id), JSON.stringify(session));
    assert.ok(models.includes('fixture/native'));
    // Grouped by provider: the service's under its title, each model named alone.
    if (modelOption) {
      const group = modelOption.options.find(option => option.options?.some(choice => choice.value === id));
      assert.deepEqual([group?.name, group?.options.find(choice => choice.value === id)?.name], ['Service fixture', id.slice(id.indexOf('/') + 1)]);
    }
    if (regression === 'provider-template') {
      assert.ok(models.includes('fixture/from-file'));
      assert.ok(models.includes('fixture/from-dir'));
    }
    const prompt = async (client, modelId) => {
      await client.request(modelOption ? 'session/set_config_option' : 'session/set_model', modelOption
        ? { sessionId: session.sessionId, configId: modelOption.id, value: modelId } : { sessionId: session.sessionId, modelId });
      const start = client.updates.length;
      assert.equal((await client.request('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'Say hello.' }] })).stopReason, 'end_turn');
      // An update may reach the client just after the prompt's reply.
      const answered = () => client.updates.slice(start).some(m => m.params?.update?.content?.text?.includes('Fixture answer'));
      for (let i = 0; i < 100 && !answered(); i++) await delay(10);
      assert.ok(answered(), JSON.stringify(client.updates.slice(start)) + client.agent.stderr);
    };
    await prompt(first, id);
    await prompt(first, 'fixture/native');
    await first.agent.terminate(1000); first.agent.kill();
    const resumed = open();
    await resumed.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    await resumed.request('session/load', { sessionId: session.sessionId, cwd: root, mcpServers: [] });
    await prompt(resumed, id);
    const turns = requests.filter(r => r.body.model === model);
    assert.equal(turns.length, 2);
    const endpoint = api === 'anthropic-messages' ? '/v1/messages' : api === 'openai-responses' ? '/v1/responses' : '/v1/chat/completions';
    assert.ok(turns.every(r => r.path === endpoint), JSON.stringify(turns.map(r => r.path)));
    const key = keyed ? 'fixture-service-key' : 'none';
    for (const turn of turns) {
      assert.equal(api === 'anthropic-messages' ? turn.headers['x-api-key'] : turn.headers.authorization,
        api === 'anthropic-messages' ? key : `Bearer ${key}`);
      assert.ok(!JSON.stringify(turn.headers).includes('unrelated-native-secret'));
      assert.ok(!JSON.stringify(turn).includes('synthetic-file-secret'));
    }
    assert.ok(requests.some(r => r.path === '/native/v1/chat/completions' && r.body.model === 'native'));
    if (regression === 'jsonc') {
      const native = requests.find(r => r.path === '/native/v1/chat/completions');
      assert.equal(native.headers.authorization, 'Bearer user-config-key');
      assert.equal(native.headers['x-user-file'], 'synthetic-file-secret');
    }
    if (regression === 'unquoted') {
      const native = requests.find(r => r.path === '/native/v1/chat/completions' && r.body.max_completion_tokens !== undefined);
      assert.equal(native?.body.max_completion_tokens, 1024);
    }
    if (['provider-template', 'config-template'].includes(regression)) {
      const native = requests.find(r => r.path === '/native/v1/chat/completions');
      assert.equal(native.headers.authorization, `Bearer ${regression}-key`);
      assert.equal(native.headers['x-literal'], '{env:OPENAI_API_KEY}');
      assert.equal(native.headers['x-user-file'], 'synthetic-file-secret');
    }
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'opencode.json'), 'utf8')), nativeConfig);
  });

// OpenCode sits out a Retry-After of an hour for up to 15 minutes, saying so in its ACP (plugins/opencode/agent/retries.mjs):
// the entry ends the turn with the service's reason. The service stands in by what each turn asks last (`answers`, given
// how often that was asked before: the wait it asks for in seconds, `subagent` for a call of OpenCode's subagent tool, null
// for an answer); what OpenCode asks without its tools (the session's title) is answered.
async function retrying(t, answers, config = {}) {
  const root = mkdtempSync(join(tmpdir(), 'coda-opencode-retry-')), turns = [], updates = [];
  let agent;
  t.after(async () => { if (agent) { await agent.terminate(1000); agent.kill(); } rmSync(root, { recursive: true, force: true }); });
  mkdirSync(join(root, '.opencode/bin'), { recursive: true });
  symlinkSync(binary, join(root, '.opencode/bin/opencode'));
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : {}, messages = body.messages ?? [];
    const asked = JSON.stringify(messages.filter(m => m.role === 'user').at(-1) ?? '');
    const turn = body.stream && body.tools?.length ? Object.keys(answers).find(word => asked.includes(word)) : undefined;
    const occurrence = turns.filter(t => t === turn).length;
    if (turn !== undefined) turns.push(turn);
    const said = turn === undefined ? null : await answers[turn](occurrence, body);
    if (said === 'subagent' || said?.tool) {
      const call = { index: 0, id: `call_${turn}_${occurrence}`, type: 'function', function: { name: said.tool ?? 'subagent',
        arguments: JSON.stringify(said.input ?? { agent: 'general', description: 'Probe task', prompt: 'Child, please.' }) } };
      response.setHeader('content-type', 'text/event-stream');
      for (const choice of [{ index: 0, delta: { role: 'assistant', tool_calls: [call] }, finish_reason: null }, { index: 0, delta: {}, finish_reason: 'tool_calls' }])
        response.write(`data: ${JSON.stringify({ id: 'chat_subagent', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [choice] })}\n\n`);
      response.end('data: [DONE]\n\n'); return;
    }
    if (said === null) { answer(response, request.url, body); return; }
    if (said?.error) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: said.error, type: 'invalid_request_error' } })); return;
    }
    response.writeHead(429, { 'content-type': 'application/json', 'retry-after': String(said) });
    response.end(JSON.stringify({ error: { message: '用量窗口已满，明天 17:42 重置', type: 'rate_limit_error', code: null } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  writeFileSync(join(root, 'opencode.json'), JSON.stringify({ $schema: 'https://opencode.ai/config.json', model: 'fixture/native', small_model: 'fixture/native', autoupdate: false, ...config,
    provider: { fixture: { npm: '@ai-sdk/openai-compatible', options: { baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'fixture-key' },
      models: { native: { name: 'Native fixture', limit: { context: 32768, output: 4096 }, tool_call: true } } } } }));
  agent = new AgentProcess({ command: manifest.contributes.agents[0].command, cwd: root,
    env: { PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'),
      XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'), OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true', OPENCODE_DISABLE_MODELS_FETCH: 'true',
      CODA_NODE: process.execPath, CODA_PLUGIN_PATH: pluginDir('opencode'), CODA_PLUGIN_SETTINGS: '{}' },
    onMessage: message => {
      updates.push(message);
      if (message.method === 'session/request_permission') agent.respond(message.id, { outcome: { outcome: 'selected', optionId: 'once' } });
    } });
  const request = (method, params) => agent.request(method, params, { timeout: 45_000 });
  assert.equal((await request('initialize', { protocolVersion: 1, clientCapabilities: {} })).error, undefined);
  const { sessionId } = (await request('session/new', { cwd: root, mcpServers: [] })).result;
  const prompt = async text => {
    const started = Date.now(), reply = await request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
    return { ...reply, took: Date.now() - started, stderr: agent.stderr };
  };
  return { prompt, turns, updates, request, sessionId, agent };
}
const STOPPED = '用量窗口已满，明天 17:42 重置\n\nOpenCode 要等约 15 分钟才会重试，这一轮先结束。';

test('real OpenCode: a model service\'s wait past a minute ends the turn with its reason; a shorter one OpenCode sits out',
  { skip: !binary, timeout: 120_000 }, async t => {
  const { prompt, turns } = await retrying(t, { Window: () => 3600, Moment: asked => asked ? null : 1 });
  const long = await prompt('Window, please.');
  assert.ok(long.took < 30_000, `${long.took} ms`);
  assert.equal(long.result, undefined, JSON.stringify(long.result) + long.stderr);
  assert.equal(long.error.message, STOPPED);
  const short = await prompt('Moment, please.');
  assert.equal(short.result?.stopReason, 'end_turn', JSON.stringify(short));
  // Stopped, the long wait is not sat out after all: the service is asked once for it.
  assert.deepEqual(turns, ['Window', 'Moment', 'Moment']);
});

// A subagent's wait is the turn's that waits on it: it ends too, and the subagent with it.
test('real OpenCode: a subagent\'s wait past a minute ends the turn that runs its task',
  { skip: !binary, timeout: 120_000 }, async t => {
  const { prompt, turns } = await retrying(t, { Delegate: asked => asked ? null : 'subagent', Child: () => 3600, Moment: () => null });
  const long = await prompt('Delegate, please.');
  assert.ok(long.took < 30_000, `${long.took} ms`);
  assert.equal(long.result, undefined, JSON.stringify(long.result) + long.stderr);
  assert.equal(long.error.message, STOPPED);
  const next = await prompt('Moment, please.');
  assert.equal(next.result?.stopReason, 'end_turn', JSON.stringify(next));
  assert.deepEqual(turns, ['Delegate', 'Child', 'Moment']);
});

const delegate = (prompt, background = false) => ({ tool: 'subagent', input: { agent: 'general', description: 'Probe task', prompt, background } });
async function until(predicate, client) {
  for (let i = 0; i < 1000; i++) { if (predicate()) return; await delay(10); }
  assert.fail(`Expected native event did not arrive: ${JSON.stringify(client.updates)}\n${client.agent.stderr}`);
}

test('real OpenCode: native child output, tool and permission belong to its registered session',
  { skip: !binary, timeout: 120_000 }, async t => {
  const client = await retrying(t, { Delegate: n => n ? null : 'subagent',
    Child: n => n ? null : { tool: 'shell', input: { command: 'printf native-child-tool' } } }, { permission: { shell: 'ask' } });
  const result = await client.prompt('Delegate, please.');
  assert.equal(result.result?.stopReason, 'end_turn', JSON.stringify(result));
  const start = client.updates.findIndex(m => m.method === '_coda/wait' && m.params.state === 'waiting');
  assert.ok(start >= 0, JSON.stringify(client.updates));
  const child = client.updates[start].params.childSessionId;
  const own = client.updates.filter(m => m.params?.sessionId === child);
  assert.ok(own.some(m => m.params.update?.sessionUpdate === 'agent_message_chunk'));
  assert.ok(own.some(m => m.params.update?.sessionUpdate === 'tool_call' && m.params.update.name === 'shell'));
  const permission = own.find(m => m.method === 'session/request_permission');
  assert.ok(permission, JSON.stringify(client.updates));
  assert.ok(own.some(m => m.params.update?.toolCallId === permission.params.toolCall.toolCallId && m.params.update.status === 'completed'));
  assert.ok(client.updates.findIndex(m => m.params?.sessionId === child) > start);
  const finished = client.updates.findIndex(m => m.method === '_coda/wait' && m.params.state === 'done');
  assert.ok(finished > client.updates.findIndex(m => m.params?.sessionId === child && m.params.update?.sessionUpdate === 'agent_message_chunk'));
  assert.ok(!client.updates.some(m => m.params?.sessionId === client.sessionId && m.params.update?._meta?.['opencode/child-session']));
});

for (const stop of [false, true]) test(`real OpenCode: background child remains registered after the parent replies and ${stop ? 'can be stopped individually' : 'finishes with its output'}`,
  { skip: !binary, timeout: 120_000 }, async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  t.after(() => release(null));
  const client = await retrying(t, { Delegate: n => n ? null : delegate('Child, please.', true), Child: () => held, Moment: () => null });
  assert.equal((await client.prompt('Delegate, please.')).result?.stopReason, 'end_turn');
  await until(() => client.turns.includes('Child'), client);
  const waiting = client.updates.find(m => m.method === '_coda/wait' && m.params.state === 'waiting')?.params;
  assert.ok(waiting, JSON.stringify(client.updates));
  assert.ok(!client.updates.some(m => m.method === '_coda/wait' && ['done', 'failed', 'cancelled'].includes(m.params.state)));
  if (stop) {
    assert.equal(waiting.stoppable, true);
    const reply = await client.request('_coda/wait/stop', { sessionId: client.sessionId, waitId: waiting.waitId });
    assert.equal(reply.error, undefined, JSON.stringify(reply));
  } else release(null);
  await until(() => client.updates.some(m => m.method === '_coda/wait' && m.params.state === (stop ? 'cancelled' : 'done')), client);
  if (!stop) assert.ok(client.updates.some(m => m.params?.sessionId === waiting.childSessionId && m.params.update?.content?.text === 'Fixture answer'));
  if (stop) assert.equal((await client.prompt('Moment, please.')).result?.stopReason, 'end_turn', 'stopping the child leaves the root usable');
});

for (const nextTurn of [false, true]) test(`real OpenCode: a background child's long retry cannot cancel the ${nextTurn ? 'next' : 'launching'} root prompt`,
  { skip: !binary, timeout: 120_000 }, async t => {
  let releaseChild, releaseRoot;
  const childResponse = new Promise(resolve => { releaseChild = resolve; });
  const rootResponse = new Promise(resolve => { releaseRoot = resolve; });
  t.after(() => { releaseChild(null); releaseRoot(null); });
  const client = await retrying(t, {
    Delegate: n => n ? (nextTurn ? null : rootResponse) : delegate('Child, please.', true),
    Child: () => childResponse, Moment: () => rootResponse,
  });
  let pending = client.prompt('Delegate, please.');
  if (nextTurn) {
    assert.equal((await pending).result?.stopReason, 'end_turn');
    pending = client.prompt('Moment, please.');
  }
  await until(() => client.turns.includes('Child') && (nextTurn ? client.turns.includes('Moment')
    : client.turns.filter(turn => turn === 'Delegate').length === 2), client);
  releaseChild(900);
  await until(() => client.updates.some(m => m.params?.update?._meta?.['opencode/retry']?.nextRetryAt), client);
  releaseRoot(null);
  const result = await pending;
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.equal(result.result?.stopReason, 'end_turn');
  const waiting = client.updates.find(m => m.method === '_coda/wait' && m.params.state === 'waiting').params;
  assert.ok(!client.updates.some(m => m.method === '_coda/wait' && m.params.waitId === waiting.waitId && m.params.state !== 'waiting'));
});

test('real OpenCode: a failed child reports the service error on its card',
  { skip: !binary, timeout: 120_000 }, async t => {
  const client = await retrying(t, { Delegate: n => n ? null : 'subagent', Child: () => ({ error: 'Fixture child rejected' }) });
  await client.prompt('Delegate, please.');
  const failed = client.updates.find(m => m.method === '_coda/wait' && m.params.state === 'failed');
  assert.ok(failed, JSON.stringify(client.updates));
  assert.match(failed.params.detail, /Fixture child rejected/);
});

test('real OpenCode: a background grandchild retry cannot cancel the root waiting for its foreground parent',
  { skip: !binary, timeout: 120_000 }, async t => {
  let releaseChild, releaseGrandchild;
  const childResponse = new Promise(resolve => { releaseChild = resolve; });
  const grandchildResponse = new Promise(resolve => { releaseGrandchild = resolve; });
  t.after(() => { releaseChild(null); releaseGrandchild(null); });
  const client = await retrying(t, { Delegate: n => n ? null : 'subagent',
    Child: n => n ? childResponse : delegate('Grand, please.', true), Grand: () => grandchildResponse },
    { experimental: { subagent_depth: 2 }, agent: { general: { permission: { subagent: 'allow' } } } });
  const pending = client.prompt('Delegate, please.');
  await until(() => client.turns.includes('Grand') && client.turns.filter(turn => turn === 'Child').length === 2, client);
  releaseGrandchild(900);
  await until(() => client.updates.some(m => m.params?.update?._meta?.['opencode/retry']?.nextRetryAt), client);
  releaseChild(null);
  const result = await pending;
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.equal(result.result?.stopReason, 'end_turn');
});

test('real OpenCode: nested native child is registered under the child that launched it',
  { skip: !binary, timeout: 120_000 }, async t => {
  const client = await retrying(t, { Delegate: n => n ? null : 'subagent', Child: n => n ? null : delegate('Grand, please.'), Grand: () => null },
    { experimental: { subagent_depth: 2 }, agent: { general: { permission: { subagent: 'allow' } } } });
  assert.equal((await client.prompt('Delegate, please.')).result?.stopReason, 'end_turn');
  const waiting = client.updates.filter(m => m.method === '_coda/wait' && m.params.state === 'waiting').map(m => m.params);
  assert.equal(waiting.length, 2, JSON.stringify(client.updates));
  assert.equal(waiting[0].sessionId, client.sessionId);
  assert.equal(waiting[1].sessionId, waiting[0].childSessionId);
  assert.equal(client.updates.filter(m => m.method === '_coda/wait' && m.params.state === 'done').length, 2);
});
