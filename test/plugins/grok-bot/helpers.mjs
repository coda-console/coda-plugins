import { PassThrough } from 'node:stream';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { Rpc } from '../../../plugins/grok-bot/agent/rpc.mjs';
import { serve } from '../../../plugins/grok-bot/agent/entry.mjs';

export function mailbox() {
  const values = [], readers = [];
  return { push: value => readers.length ? readers.shift()(value) : values.push(value), next: () => values.length ? Promise.resolve(values.shift()) : new Promise(resolve => readers.push(resolve)) };
}
export async function http(t, handler) {
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const text = Buffer.concat(chunks).toString();
      await handler(request, response, text ? JSON.parse(text) : undefined);
    } catch (error) { response.writeHead(500); response.end(JSON.stringify({ error: { message: error.message } })); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}
export function temporary(t) {
  const root = mkdtempSync(join(tmpdir(), 'grok-bot-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
export function fakeClock() {
  const timers = new Map();
  return { setTimeout(fn) { const id = Symbol(); timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); },
    expire() { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } }, get size() { return timers.size; } };
}
export async function harness(t, { settings = {}, root = temporary(t), space = true, capabilities = { waits: {}, remote: {} }, ...options } = {}) {
  const events = [], logs = [], messages = mailbox();
  const toAgent = new PassThrough(), fromAgent = new PassThrough();
  const keyPath = join(root, 'webhook-key');
  writeFileSync(keyPath, 'secret-for-fixture');
  const env = { CODA_PLUGIN_STATE: root, CODA_PLUGIN_SETTINGS: JSON.stringify(settings),
    CODA_PLUGIN_SECRETS: JSON.stringify({ 'grok-bot.bots': { inspector: { key: keyPath } } }) };
  const client = new Rpc(fromAgent, toAgent, async (method, params) => {
    events.push({ method, params });
    messages.push({ method, params });
    if (method === '_coda/remote/code') return { code: 'single-use-code', expiresAt: '2030-01-01T00:00:00.000Z', addresses: ['http://100.88.214.15:8080'] };
    if (method === 'session/request_permission') throw new Error('Adapter must delegate authorization to Coda MCP');
    return {};
  });
  const running = serve(toAgent, fromAgent, { env, clock: fakeClock(), log: text => logs.push(text), ...options });
  t.after(() => { running.adapter.close(); client.close(); toAgent.end(); fromAgent.end(); });
  const initialized = await client.request('initialize', { clientCapabilities: { _meta: { coda: capabilities } } });
  const callsFile = join(root, 'calls.jsonl');
  const discoveryFile = join(root, 'discovery.txt');
  const open = { cwd: root, mcpServers: ['coda', ...(space ? ['space'] : [])].map(name => ({ name, command: process.execPath, args: [fileURLToPath(new URL('./fixture-mcp.mjs', import.meta.url))],
    env: [{ name: 'CODA_TEST_CALLS', value: callsFile }, { name: 'CODA_TEST_SERVER', value: name }, { name: 'CODA_TEST_DISCOVERY', value: discoveryFile }] })),
    systemPrompt: { mode: 'append', content: [{ type: 'text', text: 'session instructions marker' }] } };
  const created = await client.request('session/new', open);
  const sessionId = created.sessionId;
  const remote = (method, params = {}) => client.request('_coda/remote', { sessionId, method, params });
  return { ...running, client, sessionId, remote, initialized, created, events, logs, messages, open, env, root,
    text: () => events.filter(e => e.params.update?.sessionUpdate === 'agent_message_chunk').map(e => e.params.update.content.text).join('\n'),
    calls: () => { try { return readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } },
    discovered: () => readFileSync(discoveryFile, 'utf8').trim().split('\n'),
    prompt: text => client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }),
    select: () => client.request('session/set_config_option', { sessionId, configId: 'bot', value: 'inspector' }) };
}
