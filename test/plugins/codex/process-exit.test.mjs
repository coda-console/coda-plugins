// From Coda's backend/test/codex-process-exit.test.mjs at ef1d2311, as plain node:test. Its case of an app-server dying
// mid-turn, through Coda's backend, stays in Coda.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentProcess } from '../../../check/process.mjs';
import { followCodexProcessExit } from '../../../plugins/codex/agent/process-exit.mjs';
import { CodexWaits } from '../../../plugins/codex/agent/waits.mjs';
import { agentValueProblem } from '@coda-console/protocol/agent';
import { pluginDir, resolveFrom } from '../plugin.mjs';

const fixture = fileURLToPath(new URL('./app-server-fixture.mjs', import.meta.url));
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

// The category of the error as the protocol checks it, and the `input` it says.
const ended = (error, input) => {
  const failure = error.data?._meta?.coda?.failure;
  assert.equal(agentValueProblem('failure.json', failure, 'failure'), null);
  assert.deepEqual(failure, input ? { kind: 'session_ended', input } : { kind: 'session_ended' });
};
// Through the real codex-acp, whether it has said anything of the turn before the process ends is up to its timing: without the
// fixture saying something, the input is `accepted` or not written.
const endedMaybeAccepted = error => {
  assert.equal(agentValueProblem('failure.json', error.data?._meta?.coda?.failure, 'failure'), null);
  assert.equal(error.data._meta.coda.failure.kind, 'session_ended');
  assert.ok([undefined, 'accepted'].includes(error.data._meta.coda.failure.input));
};

const bundle = await readFile(resolveFrom('codex', '@agentclientprotocol/codex-acp'), 'utf8');

test('what the session said since the prompt was asked makes its input accepted', () => {
  const waits = new CodexWaits();
  waits.fromCoda({ jsonrpc: '2.0', id: 1, method: 'session/prompt', params: { sessionId: 'root', prompt: [] } });
  waits.fromCoda({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: 'other', prompt: [] } });
  waits.fromAgent({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'root:generation:2', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } } } });
  const [first, second] = waits.fail('gone');
  ended(first.error, 'accepted');
  ended(second.error);
});

test('the patch fails loudly once the locked adapter changes', () => {
  assert.match(followCodexProcessExit(bundle), /ending the adapter with it/);
  assert.throws(() => followCodexProcessExit(bundle.replace('void this.finishAllAsyncTasks("failed", "after the Codex process exited");', 'changed();')), /no longer matches/);
});

test('turns waiting on the Codex process are answered with how it ended, and its own late answers are dropped', () => {
  const waits = new CodexWaits();
  waits.fromCoda({ jsonrpc: '2.0', id: 1, method: 'session/prompt', params: { sessionId: 'root', prompt: [] } });
  waits.fromCoda({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '/', mcpServers: [] } });
  const [answer] = waits.fail('gone');
  assert.deepEqual([answer.id, answer.error.code, answer.error.message], [1, -32603, 'gone']);
  ended(answer.error);
  assert.deepEqual(waits.fail('gone'), []);
  assert.deepEqual(waits.fromAgent({ jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'Connection is disposed' } }), []);
  assert.deepEqual(waits.fromAgent({ jsonrpc: '2.0', id: 1, result: {} }).length, 1);
});

for (const [name, exit, how, say, input] of [['a non-zero exit code', '7', /退出码 7[\s\S]*fake codex: boom/], ['a signal', 'SIGKILL', /被信号 SIGKILL 终止/], ['exit code 0', '0', /退出码 0/],
  ['a signal after the turn said something', 'SIGKILL', /被信号 SIGKILL 终止/, '1', 'accepted']])
  test(`the turn error and the plugin's stderr say how the Codex process ended: ${name}`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'codex-exit-')), codex = join(root, 'codex');
    await writeFile(codex, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} "$@"\n`); await chmod(codex, 0o700);
    const peer = new AgentProcess({ command: `exec ${quote(process.execPath)} ${quote(join(pluginDir('codex'), 'agent/entry.mjs'))}`, cwd: root,
      env: { ...process.env, FAKE_CODEX_EXIT: exit, ...(say ? { FAKE_CODEX_SAY: say } : {}), FAKE_CODEX_STATE: root, CODEX_PATH: codex, CODEX_HOME: join(root, 'home') } });
    t.after(async () => { await peer.terminate(2000); peer.kill(); await rm(root, { recursive: true, force: true }); });
    const request = (method, params) => peer.request(method, params, { timeout: 10_000 });
    await request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    const session = await request('session/new', { cwd: root, mcpServers: [] });
    const reply = await request('session/prompt', { sessionId: session.result.sessionId, prompt: [{ type: 'text', text: 'original task' }] });
    assert.equal(reply.error?.code, -32603, JSON.stringify(reply));
    assert.match(reply.error.message, how);
    if (say) ended(reply.error, input); else endedMaybeAccepted(reply.error);
    await peer.exited;
    assert.match(peer.stderr, how);
  });

test('the Codex process ending as Coda\'s input closes is not an unexpected end', async t => {
  const root = await mkdtemp(join(tmpdir(), 'codex-exit-')), codex = join(root, 'codex');
  await writeFile(codex, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} "$@"\n`); await chmod(codex, 0o700);
  const peer = new AgentProcess({ command: `exec ${quote(process.execPath)} ${quote(join(pluginDir('codex'), 'agent/entry.mjs'))}`, cwd: root,
    env: { ...process.env, FAKE_CODEX_STATE: root, CODEX_PATH: codex, CODEX_HOME: join(root, 'home') } });
  t.after(async () => { await peer.terminate(2000); peer.kill(); await rm(root, { recursive: true, force: true }); });
  await peer.request('initialize', { protocolVersion: 1, clientCapabilities: {} }, { timeout: 10_000 });
  await peer.request('session/new', { cwd: root, mcpServers: [] }, { timeout: 10_000 });
  peer.child.stdin.end();
  await peer.exited;
  assert.doesNotMatch(peer.stderr, /意外退出/);
});
