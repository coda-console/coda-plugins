// An agent entry that relays a CLI's ACP (grok, opencode, cursor), run as Coda runs it from its manifest, with the CLI stood in
// for by relay-fixture.mjs at the path the entry looks first (`binary`, under a temporary HOME). What Coda's session
// instructions become on the way (docs/agent-protocol.md「会话指令」) is checked by `relaysInstructions`.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentProcess } from '../../check/process.mjs';
import { pluginDir } from './plugin.mjs';
import { instructionsBlock } from '../../check/coda/domain/agent-protocol.mjs';

const quote = s => `'${s.replaceAll("'", "'\\''")}'`;

export async function relaysInstructions(t, id, binary, argv) {
  const manifest = JSON.parse(readFileSync(join(pluginDir(id), 'package.json'), 'utf8'));
  const home = mkdtempSync(join(tmpdir(), `coda-${id}-relay-`)), cli = join(home, binary);
  mkdirSync(dirname(cli), { recursive: true });
  writeFileSync(cli, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fileURLToPath(new URL('./relay-fixture.mjs', import.meta.url)))} "$@"\n`, { mode: 0o755 });
  const messages = [];
  const start = () => new AgentProcess({ command: manifest.contributes.agents[0].command, cwd: home,
    env: { ...process.env, HOME: home, CODA_NODE: process.execPath, CODA_PLUGIN_PATH: pluginDir(id) }, onMessage: m => messages.push(m) });
  const agents = [];
  t.after(async () => { for (const p of agents) { await p.terminate(1500); p.kill(); } rmSync(home, { recursive: true, force: true }); });
  const open = async () => { const p = start(); agents.push(p); return p; };
  const request = async (p, method, params) => (await p.request(method, params, { timeout: 5000 }));
  const prompt = async (p, text) => {
    assert.equal((await request(p, 'session/prompt', { sessionId: 'native', prompt: Array.isArray(text) ? text : [{ type: 'text', text }] })).result.stopReason, 'end_turn');
    return JSON.parse(messages.filter(m => m.params?.update?.content).at(-1).params.update.content.text);
  };

  const p = await open();
  const init = (await request(p, 'initialize', { protocolVersion: 1, clientCapabilities: {} })).result;
  assert.deepEqual(init.agentCapabilities.sessionCapabilities, { list: {} });
  assert.equal((await request(p, 'session/new', { cwd: home, mcpServers: [] })).result.sessionId, 'native');
  assert.deepEqual((await prompt(p, '/compact')).prompt, [{ type: 'text', text: '/compact' }]);
  const input = [instructionsBlock('# Coda client'), { type: 'text', text: '你好' }];
  const first = await prompt(p, input);
  assert.deepEqual(first.prompt, input, 'Coda supplies the instruction block; the entry forwards both blocks unchanged');
  assert.deepEqual(first.argv, argv);
  assert.equal(first.leaked, false, 'the agent is not given systemPrompt');
  assert.equal(first.prompt.length, 2);
  assert.match(first.prompt[0].text, /^<coda-session-instructions>\n[^]*\n\n# Coda client\n<\/coda-session-instructions>\n$/);
  assert.deepEqual(first.prompt[1], { type: 'text', text: '你好' });
  assert.deepEqual((await prompt(p, '再来')).prompt, [{ type: 'text', text: '再来' }], 'only the first prompt');
  // A loaded session has had them.
  const q = await open();
  await request(q, 'initialize', { protocolVersion: 1, clientCapabilities: {} });
  assert.ok((await request(q, 'session/load', { sessionId: 'native', cwd: home, mcpServers: [] })).result);
  const loaded = await prompt(q, '继续');
  assert.deepEqual([loaded.leaked, loaded.prompt], [false, [{ type: 'text', text: '继续' }]]);
  // It ends as the CLI ends, once Coda's side closes.
  q.child.stdin.end();
  assert.equal((await q.exited).code, 0);
}
