// The locked SDK/CLI against a local model: native permission and question control requests must still reach Coda.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ClaudeSession } from '../../../plugins/claude/agent/session.mjs';
import { resolveFrom } from '../plugin.mjs';

const sdk = await import(pathToFileURL(resolveFrom('claude', '@anthropic-ai/claude-agent-sdk')).href);

test('native questions accept or cancel through Coda, and a denied command stays denied', { timeout: 120_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'coda-claude-native-permissions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, 'config'), cwd = join(root, 'work');
  await mkdir(config); await mkdir(cwd);
  const results = [], cards = [];
  let scenario;
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    if (request.url.startsWith('/models')) return response.end(JSON.stringify({ data: [{ id: 'fake/permissions' }] }));
    if (!request.url.startsWith('/v1/messages') || request.url.includes('count_tokens')) return response.end('{}');
    const payload = JSON.parse(raw), last = payload.messages.findLast(message => message.role === 'user');
    const result = Array.isArray(last?.content) && last.content.find(block => block.type === 'tool_result');
    if (result) results.push({ scenario, ...result });
    const command = scenario === 'command';
    const tool = { type: 'tool_use', id: `tool-${scenario}`, name: command ? 'Bash' : 'AskUserQuestion', input: command
      ? { command: 'printf coda-native-permissions', description: 'Print a test marker' }
      : { questions: [{ question: 'Continue?', header: 'Choice', multiSelect: false,
        options: [{ label: 'Yes', description: 'Continue' }, { label: 'No', description: 'Stop' }] }] } };
    const requested = JSON.stringify(last?.content).includes(`Run ${scenario}`);
    const content = result || !requested ? { type: 'text', text: 'done' } : tool;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const event = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    event('message_start', { message: { id: `msg-${Date.now()}`, type: 'message', role: 'assistant', model: payload.model,
      content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } });
    event('content_block_start', { index: 0, content_block: content.type === 'tool_use' ? { ...content, input: {} } : { type: 'text', text: '' } });
    event('content_block_delta', { index: 0, delta: content.type === 'tool_use'
      ? { type: 'input_json_delta', partial_json: JSON.stringify(content.input) } : { type: 'text_delta', text: content.text } });
    event('content_block_stop', { index: 0 });
    event('message_delta', { delta: { stop_reason: content.type === 'tool_use' ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 1 } });
    event('message_stop', {}); response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const session = new ClaudeSession({ sdk, env: { ...process.env, CLAUDE_CONFIG_DIR: config,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
    CODA_PLUGIN_SETTINGS: JSON.stringify({ 'claude.modelProviders': ['fixture/anthropic'] }),
    CODA_MODEL_PROVIDERS: JSON.stringify({ 'fixture/anthropic': { plugin: 'fixture', title: 'Fixture', api: 'anthropic-messages',
      url: `http://127.0.0.1:${server.address().port}` } }) } });
  t.after(() => session.close());
  session.client = { notify: async () => {}, request: async (method, params) => {
    cards.push({ scenario, method, params });
    return method === 'elicitation/create' ? scenario === 'accept'
      ? { action: 'accept', content: { q0: 'Yes' } } : { action: 'cancel' }
      : { outcome: { outcome: 'selected', optionId: 'deny' } };
  } };
  await session.open({ cwd, mcpServers: [] });
  session.launch.settings.permissions = { ask: ['Bash'] };
  await session.configure('model', 'fixture/anthropic/fake/permissions');
  assert.equal(session.current.mode, 'default');
  for (scenario of ['accept', 'cancel', 'command']) {
    assert.deepEqual(await session.prompt({ prompt: [{ type: 'text', text: `Run ${scenario}` }] }), { stopReason: 'end_turn' });
    const card = cards.find(card => card.scenario === scenario);
    assert.equal(card?.method, scenario === 'command' ? 'session/request_permission' : 'elicitation/create', JSON.stringify(results));
    const result = results.find(result => result.scenario === scenario);
    assert.ok(result, `${scenario}: the native CLI must return the tool outcome to the model`);
    if (scenario === 'accept') assert.match(JSON.stringify(result.content), /Yes/);
    else assert.equal(result.is_error, true, JSON.stringify(result));
  }
});
