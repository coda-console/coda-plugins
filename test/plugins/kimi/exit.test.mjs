// When `kimi acp` ends on its own (a non-zero exit code or a signal, or any end with a prompt unanswered), the prompt it leaves
// waiting fails with how it ended (exit code or signal, and the end of its stderr), and the entry's own stderr, the plugin's log, says
// the same. When Coda's input closes or a signal stops the entry, nothing is said.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AgentProcess } from '../../../check/process.mjs';
import { agentValueProblem } from '@coda-console/protocol/agent';
import { pluginDir } from '../plugin.mjs';

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
// A `kimi acp` that answers the handshake, then ends when it is prompted: `KIMI_EXIT` is an exit code or a signal, or `hold`
// to go on without answering; with `KIMI_SAY` it says something of the session first (a title update).
const fake = `
process.stdin.on('data', chunk => {
  for (const line of String(chunk).split('\\n').filter(Boolean)) {
    const m = JSON.parse(line);
    if (m.method === 'session/prompt') {
      console.error('fake kimi: git: Operation not permitted');
      if (process.env.KIMI_SAY) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'native', update: { sessionUpdate: 'session_info_update', title: 'renamed' } } }) + '\\n');
      const exit = process.env.KIMI_EXIT;
      if (exit === 'hold') continue;
      if (/^\\d+$/.test(exit)) process.exit(Number(exit)); else process.kill(process.pid, exit);
    } else if ('id' in m) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: m.method === 'initialize' ? { protocolVersion: 1, agentCapabilities: {} } : { sessionId: 'native' } }) + '\\n');
  }
});`;

// Starts the entry on that CLI and prompts it: the entry's process, and the prompt's reply to come.
async function prompted(t, exit, say = false) {
  const home = await mkdtemp(join(tmpdir(), 'kimi-exit-')), cli = join(home, '.kimi-code/bin/kimi'), script = join(home, 'fake.mjs');
  await mkdir(dirname(cli), { recursive: true });
  await writeFile(script, fake);
  await writeFile(cli, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`); await chmod(cli, 0o755);
  const peer = new AgentProcess({ command: `exec ${quote(process.execPath)} ${quote(join(pluginDir('kimi'), 'agent/entry.mjs'))}`, cwd: home,
    env: { ...process.env, HOME: home, KIMI_EXIT: exit, ...(say ? { KIMI_SAY: '1' } : {}), CODA_NODE: process.execPath, CODA_PLUGIN_PATH: pluginDir('kimi') } });
  t.after(async () => { await peer.terminate(2000); peer.kill(); await rm(home, { recursive: true, force: true }); });
  const request = (method, params) => peer.request(method, params, { timeout: 10_000 });
  await request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  const session = await request('session/new', { cwd: home, mcpServers: [] });
  const reply = request('session/prompt', { sessionId: session.result.sessionId, prompt: [{ type: 'text', text: 'task' }] });
  return { peer, reply };
}

for (const [name, exit, how, say] of [['a non-zero exit code', '3', /退出码 3[\s\S]*git: Operation not permitted/], ['a signal', 'SIGKILL', /被信号 SIGKILL 终止/],
  ['exit code 0 with the prompt unanswered', '0', /退出码 0/], ['a signal after the session said something else', 'SIGKILL', /被信号 SIGKILL 终止/, true]])
  test(`the prompt error and the plugin's stderr say how Kimi ended: ${name}`, async t => {
    const { peer, reply } = await prompted(t, exit, say);
    const { error } = await reply;
    assert.equal(error?.code, -32603);
    assert.match(error.message, how);
    const failure = error.data?._meta?.coda?.failure;
    assert.equal(agentValueProblem('failure.json', failure, 'failure'), null);
    assert.deepEqual(failure, { kind: 'session_ended' });
    await peer.exited;
    assert.match(peer.stderr, how);
  });

// Coda closing its side, or a signal to the entry, stops Kimi on purpose: no error for the prompt, nothing in the log.
for (const [name, stop] of [['its input closing', peer => peer.child.stdin.end()], ['SIGTERM to the entry\'s process group, as Coda\'s session host stops it', peer => { void peer.terminate(2000); }]])
  test(`stopping Kimi on purpose is not an unexpected end: ${name}`, async t => {
    const { peer, reply } = await prompted(t, 'hold');
    const settled = reply.then(() => 'answered', () => 'unanswered');
    stop(peer);
    await peer.exited;
    assert.equal(await settled, 'unanswered', peer.stderr);
    assert.doesNotMatch(peer.stderr, /意外退出/);
  });
