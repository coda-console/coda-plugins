// What a session on a model service sends the service, by the real Claude Code (the plugin's locked SDK) against a local
// server: the service's token alone, none of the machine's credentials, wherever the machine keeps them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ClaudeSession } from '../../../plugins/claude/agent/session.mjs';
import { resolveFrom } from '../plugin.mjs';

const sdk = await import(pathToFileURL(resolveFrom('claude', '@anthropic-ai/claude-agent-sdk')).href);

// An Anthropic API under `/service` (the model service) and `/native` (where the machine's own Claude goes): it lists one model
// and answers every message with a word, noting what each request carried.
async function anthropic(t) {
  const asked = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const payload = body ? JSON.parse(body) : null;
    asked.push({ path: request.url, authorization: request.headers.authorization, apiKey: request.headers['x-api-key'], secret: request.headers['x-secret'],
      billing: payload?.system?.find(block => block.text?.startsWith('x-anthropic-billing-header:'))?.text });
    if (request.url.startsWith('/service/models')) return response.end(JSON.stringify({ data: [{ id: 'fake/alpha' }] }));
    if (!/^\/\w+\/v1\/messages/.test(request.url) || request.url.includes('count_tokens')) return response.end('{}');
    const { model } = JSON.parse(body);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const event = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    event('message_start', { message: { id: 'msg', type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } });
    event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'pong' } });
    event('content_block_stop', { index: 0 });
    event('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } });
    event('message_stop', {});
    response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { asked, at: `http://127.0.0.1:${server.address().port}` };
}

test('the real Claude Code identifies as Coda and sends the service only its own credentials', { timeout: 120_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'coda-claude-service-auth-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, 'config'), cwd = join(root, 'cwd');
  await mkdir(config); await mkdir(cwd);
  // The machine's settings: a key of its own, and a helper that gives another.
  await writeFile(join(config, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_API_KEY: 'sk-ant-api03-settings' }, apiKeyHelper: 'echo sk-ant-api03-helper' }));
  const { asked, at } = await anthropic(t);
  const session = new ClaudeSession({ sdk, env: { ...process.env, HOME: root, CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
    // The machine's environment: its own way to the API, with a key, an OAuth token and a header of its own.
    ANTHROPIC_BASE_URL: `${at}/native`, ANTHROPIC_API_KEY: 'sk-ant-api03-process', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-process', ANTHROPIC_CUSTOM_HEADERS: 'X-Secret: process',
    CODA_PLUGIN_SETTINGS: JSON.stringify({ 'claude.modelProviders': ['magpie/anthropic'] }),
    CODA_MODEL_PROVIDERS: JSON.stringify({ 'magpie/anthropic': { plugin: 'magpie', title: 'Magpie · Anthropic', api: 'anthropic-messages', url: `${at}/service` } }) } });
  t.after(() => session.close());
  await session.open({ cwd, mcpServers: [] });
  await session.configure('model', 'magpie/anthropic/fake/alpha');
  assert.deepEqual(await session.prompt({ prompt: [{ type: 'text', text: 'hi' }] }), { stopReason: 'end_turn' });
  const sent = asked.filter(request => request.path.startsWith('/service/v1/messages'));
  assert.ok(sent.length, JSON.stringify(asked));
  for (const request of sent) {
    assert.deepEqual([request.authorization, request.apiKey, request.secret], ['Bearer none', undefined, undefined], request.path);
    assert.match(request.billing ?? '', /\bcc_entrypoint=coda(?:;|\s|$)/);
  }
});
