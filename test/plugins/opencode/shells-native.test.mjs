// Real OpenCode, deterministic local model, no external model or credentials.
// OPENCODE_TEST_BINARY=/absolute/path/to/opencode node --test test/plugins/opencode/shells-native.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentProcess } from '../../../check/process.mjs';
import { pluginDir } from '../plugin.mjs';

const binary = process.env.OPENCODE_TEST_BINARY;
const quote = s => `'${s.replaceAll("'", "'\\''")}'`;
for (const scenario of ['success', 'nonzero', 'timeout', 'fast', 'cancel-handling', 'plugins-file'])
test(`real OpenCode: background shell ${scenario}, including native notification handling`,
  { skip: !binary, timeout: 30_000 }, async t => {
    const root = mkdtempSync(join(tmpdir(), 'coda-oc-shell-test-')), release = join(root, 'release');
    const messages = [], watchers = new Set();
    let turns = 0, requests = [];
    const server = createServer(async (req, res) => {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : {};
      if (req.method === 'GET') { res.setHeader('content-type', 'application/json'); res.end('{"data":[]}'); return; }
      requests.push(body);
      if (!body.stream) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ id: 'chat_test', object: 'chat.completion', created: 1, model: 'native',
          choices: [{ index: 0, message: { role: 'assistant', content: 'Shell fixture' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })); return;
      }
      const primary = body.tools?.some(t => t.function?.name === 'shell');
      if (primary) turns++;
      for (const w of watchers) w();
      if (primary && turns === 3 && scenario === 'cancel-handling') return; // Coda must be able to stop this autonomous execution.
      const tool = primary && turns === 1;
      res.setHeader('content-type', 'text/event-stream');
      const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call_bg', type: 'function',
        function: { name: 'shell', arguments: JSON.stringify({ background: true,
          ...(scenario === 'timeout' ? { timeout: 1000 } : {}),
          command: scenario === 'fast' ? 'echo fast-shell-done'
            : `while ! test -f ${quote(release)}; do sleep 0.05; done; echo shell-fixture-done; exit ${scenario === 'nonzero' ? 7 : 0}` }) } }] }
        : { role: 'assistant', content: turns === 2 ? 'The command is running.' : 'The command finished.' };
      for (const choice of [{ index: 0, delta, finish_reason: null }, { index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }])
        res.write(`data: ${JSON.stringify({ id: `chat_${turns}`, object: 'chat.completion.chunk', created: 1, model: body.model, choices: [choice] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/v1`;
    mkdirSync(join(root, '.opencode/bin'), { recursive: true }); symlinkSync(binary, join(root, '.opencode/bin/opencode'));
    const pluginsFile = join(root, 'plugins.json');
    if (scenario === 'plugins-file') writeFileSync(pluginsFile, '[]\n');
    writeFileSync(join(root, 'opencode.json'), JSON.stringify({ model: 'fixture/native', small_model: 'fixture/native',
      autoupdate: false, permission: { '*': 'allow' }, provider: { fixture: { npm: '@ai-sdk/openai-compatible',
        options: { baseURL: url, apiKey: 'none' }, models: { native: { name: 'Fixture', limit: { context: 32768, output: 4096 } } } } } }));
    const manifest = JSON.parse(readFileSync(join(pluginDir('opencode'), 'package.json'), 'utf8'));
    const agent = new AgentProcess({ command: manifest.contributes.agents[0].command, cwd: root,
      env: { PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'),
        XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'), OPENCODE_DISABLE_MODELS_FETCH: 'true',
        ...(scenario === 'plugins-file' ? { OPENCODE_CONFIG_CONTENT: `{"plugins":{file:${pluginsFile}}}` } : {}),
        CODA_NODE: process.execPath, CODA_PLUGIN_PATH: pluginDir('opencode'), OPENCODE_PRINT_LOGS: '1' },
      onMessage(m) {
        messages.push(m);
        if (m.method === 'session/request_permission') agent.respond(m.id, { outcome: { outcome: 'selected', optionId: 'once' } });
        for (const w of watchers) w();
      } });
    const nativeLogs = []; agent.child.stderr.on('data', chunk => nativeLogs.push(String(chunk)));
    t.after(() => { if (process.env.OPENCODE_TEST_DEBUG) console.error(nativeLogs.join('').split('\n').filter(l => /plugin|error|coda/i.test(l)).join('\n')); });
    t.after(async () => { await agent.terminate(1000); agent.kill(); server.closeAllConnections();
      await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }); });
    const request = async (method, params) => {
      const r = await agent.request(method, params, { timeout: 10_000 }); assert.equal(r.error, undefined, JSON.stringify(r) + agent.stderr); return r.result;
    };
    const until = predicate => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { watchers.delete(check); reject(new Error(JSON.stringify({ messages, turns,
        requests: requests.map(r => ({ messages: r.messages, tools: r.tools?.map(t => t.function?.name) })), stderr: agent.stderr }))); }, 10_000);
      const check = () => { if (!predicate()) return; clearTimeout(timer); watchers.delete(check); resolve(); };
      watchers.add(check); check();
    });
    await request('initialize', { protocolVersion: 1, clientCapabilities: { _meta: { coda: { waits: {} } } } });
    const session = await request('session/new', { cwd: root, mcpServers: [] });
    await request('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'Run the shell fixture in the background.' }] });
    const waits = () => messages.filter(m => m.method === '_coda/wait' && m.params.kind !== 'subagent');
    assert.equal(waits()[0]?.params.state, 'waiting', JSON.stringify({ messages, stderr: agent.stderr }));
    assert.equal(waits()[0].params.toolCallId, 'call_bg');
    assert.equal(waits()[0].params.stoppable, false);
    if (scenario !== 'fast') assert.equal(waits().length, 1);
    if (scenario !== 'timeout') writeFileSync(release, '');
    if (scenario === 'cancel-handling') {
      await until(() => turns >= 3 && waits().some(m => m.params.state === 'handling'));
      agent.notify('session/cancel', { sessionId: session.sessionId });
    }
    const terminal = ['nonzero', 'timeout'].includes(scenario) ? 'failed' : 'done';
    await until(() => waits().some(m => m.params.state === terminal));
    assert.equal(waits().at(-1).params.state, terminal);
    if (scenario === 'cancel-handling') {
      assert.match(waits().at(-1).params.detail, /停止处理/);
      await request('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'Continue after stopping.' }] });
    }
    if (scenario !== 'fast') assert.deepEqual(waits().map(m => m.params.state), ['waiting', 'handling', terminal]);
    assert.ok(turns >= (scenario === 'fast' ? 2 : 3), 'native OpenCode handled the shell completion');
    assert.ok(waits().every(m => m.params.sessionId === session.sessionId));
  });
