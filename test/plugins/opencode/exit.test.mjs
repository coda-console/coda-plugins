// When `opencode acp` dies on its own, the prompt it leaves waiting fails with how it ended (exit code or signal, and the end of
// its stderr), and the entry's own stderr, the plugin's log, says the same.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AgentProcess } from '../../../check/process.mjs';
import { pluginDir } from '../plugin.mjs';

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
// An `opencode acp` that answers the handshake, then dies when it is prompted: `OPENCODE_EXIT` is an exit code or a signal.
const fake = `
process.stdin.on('data', chunk => {
  for (const line of String(chunk).split('\\n').filter(Boolean)) {
    const m = JSON.parse(line);
    if (m.method === 'session/prompt') {
      console.error('fake opencode: git: Operation not permitted');
      const exit = process.env.OPENCODE_EXIT;
      if (/^\\d+$/.test(exit)) process.exit(Number(exit)); else process.kill(process.pid, exit);
    } else if ('id' in m) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: m.method === 'initialize' ? { protocolVersion: 1, agentCapabilities: {} } : { sessionId: 'native' } }) + '\\n');
  }
});`;

for (const [name, exit, how] of [['a non-zero exit code', '3', /退出码 3[\s\S]*git: Operation not permitted/], ['a signal', 'SIGKILL', /被信号 SIGKILL 终止/]])
  test(`the prompt error and the plugin's stderr say how OpenCode ended: ${name}`, async t => {
    const home = await mkdtemp(join(tmpdir(), 'opencode-exit-')), cli = join(home, '.opencode/bin/opencode'), script = join(home, 'fake.mjs');
    await mkdir(dirname(cli), { recursive: true });
    await writeFile(script, fake);
    await writeFile(cli, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`); await chmod(cli, 0o755);
    const peer = new AgentProcess({ command: `exec ${quote(process.execPath)} ${quote(join(pluginDir('opencode'), 'agent/entry.mjs'))}`, cwd: home,
      env: { ...process.env, HOME: home, OPENCODE_EXIT: exit, CODA_NODE: process.execPath, CODA_PLUGIN_PATH: pluginDir('opencode') } });
    t.after(async () => { await peer.terminate(2000); peer.kill(); await rm(home, { recursive: true, force: true }); });
    const request = (method, params) => peer.request(method, params, { timeout: 10_000 });
    await request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    const session = await request('session/new', { cwd: home, mcpServers: [] });
    const reply = await request('session/prompt', { sessionId: session.result.sessionId, prompt: [{ type: 'text', text: 'task' }] });
    assert.equal(reply.error?.code, -32603, JSON.stringify(reply));
    assert.match(reply.error.message, how);
    assert.equal(reply.error.data, undefined);
    await peer.exited;
    assert.match(peer.stderr, how);
  });
