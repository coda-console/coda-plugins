// The entry on a fake `agy acp`, with a transcript of the session in its home: a command agy moves into the background reaches
// Coda as a `_coda/wait` task, for a Coda that declares `_meta.coda.waits`, and the ACP around it is relayed as it was.
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AgentProcess } from '../../helpers/agent.mjs';
import { manifest } from '../command.mjs';
import { pluginDir } from '../plugin.mjs';
import { agentValueProblem } from '@coda-console/protocol/agent';
import { CHILD, COMMAND, ROLE, TIMEOUT, UNAVAILABLE, acp, answer, apiError, canceled, finished, idle, input, record, running, SUMMARY } from './background-fixture.mjs';

const quote = s => `'${s.replaceAll("'", "'\\''")}'`;

// A session `s1` of the fake agy, whose transcript is in the home; `waits` is whether Coda declares the capability. `turn(dir)` is what
// the fake agy writes when it is prompted: `{steps, files, updates}`, the files by their path from the session's `.system_generated`.
async function session(t, waits, turn) {
  const messages = [];
  const home = mkdtempSync(join(tmpdir(), 'antigravity-background-entry-'));
  mkdirSync(join(home, '.local/bin'), { recursive: true });
  writeFileSync(join(home, '.local/bin/agy'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fileURLToPath(new URL('./fixture.mjs', import.meta.url)))}\n`, { mode: 0o755 });
  const dir = join(home, '.gemini/antigravity-cli/brain/s1/.system_generated');
  mkdirSync(join(dir, 'logs'), { recursive: true });
  const transcript = join(dir, 'logs/transcript.jsonl');
  writeFileSync(transcript, '');
  const written = turn?.(dir);
  const p = new AgentProcess({ onMessage: m => messages.push(m), command: manifest('antigravity').contributes.agents[0].command, cwd: home,
    env: { ...process.env, HOME: home, ...(written && { FAKE_AGY_TURN: JSON.stringify({ file: transcript, steps: written.steps, updates: written.updates, files: Object.fromEntries(Object.entries(written.files ?? {}).map(([path, value]) => [join(dir, path), value])) }) }), CODA_NODE: process.execPath, CODA_PLUGIN_PATH: pluginDir('antigravity') } });
  t.after(async () => { await p.terminate(1500); p.kill(); rmSync(home, { recursive: true, force: true }); });
  const request = async (method, params) => (await p.request(method, params, { timeout: 5000 })).result;
  await request('initialize', { protocolVersion: 1, clientCapabilities: waits ? { _meta: { coda: { waits: {} } } } : {} });
  const { sessionId } = await request('session/new', { cwd: '/work', mcpServers: [] });
  assert.equal(sessionId, 's1');
  const waited = async (count, within = 4000) => {
    for (const end = Date.now() + within; Date.now() < end; await new Promise(resolve => setTimeout(resolve, 20))) {
      const found = messages.filter(m => m.method === '_coda/wait');
      if (found.length >= count) return found.map(m => m.params);
    }
    throw new Error(`fewer than ${count} _coda/wait: ${JSON.stringify(messages.filter(m => m.method === '_coda/wait'))}`);
  };
  const prompt = (params = {}) => p.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'go' }], ...params }, { timeout: 5000 });
  const updates = list => request('fake/updates', { sessionId, updates: list });
  return { p, messages, request, transcript, dir, waited, updates, prompt, append: step => appendFileSync(transcript, `${JSON.stringify(step)}\n`) };
}

test('a command moved into the background is told to Coda with its call, and ended when the transcript says it finished', async t => {
  const { messages, updates, append, waited } = await session(t, true);
  const call = acp('tool_call', 'in_progress');
  await updates([call, acp('tool_call_update', 'pending'), acp('tool_call_update', 'in_progress')]);
  append(running(342, COMMAND));
  const [wait] = await waited(1);
  assert.deepEqual(wait, { sessionId: 's1', waitId: 'c94a5096-f799-4d8a-be8d-e5623b27ce0c/task-342', kind: 'task', state: 'waiting', toolCallId: call.toolCallId, title: SUMMARY, detail: COMMAND });
  append(finished(342));
  assert.deepEqual((await waited(2))[1], { sessionId: 's1', waitId: wait.waitId, state: 'done' });
  assert.deepEqual(messages.filter(m => m.method === 'session/update').map(m => [m.params.update.sessionUpdate, m.params.update.status]).filter(([name]) => name !== 'current_mode_update'),
    [['tool_call', 'in_progress'], ['tool_call_update', 'pending'], ['tool_call_update', 'in_progress']], 'the ACP is relayed as it came');
});

test('a Coda that does not declare _meta.coda.waits is told nothing, and the ACP is relayed all the same', async t => {
  const { messages, updates, append, waited } = await session(t, false);
  await updates([acp('tool_call', 'in_progress')]);
  append(running(342, COMMAND));
  await assert.rejects(waited(1, 1700), /fewer than 1/);
  assert.equal(messages.filter(m => m.method === 'session/update').length, 1);
});

test('the session closing, or agy ending, ends the task as cancelled', async t => {
  const closed = await session(t, true);
  await closed.updates([acp('tool_call', 'in_progress')]);
  closed.append(running(1, COMMAND));
  await closed.waited(1);
  await closed.request('session/close', { sessionId: 's1' });
  assert.deepEqual((await closed.waited(2))[1], { sessionId: 's1', waitId: 'c94a5096-f799-4d8a-be8d-e5623b27ce0c/task-1', state: 'cancelled' });

  const ended = await session(t, true);
  await ended.updates([acp('tool_call', 'in_progress')]);
  ended.append(running(2, COMMAND));
  await ended.waited(1);
  ended.p.write({ id: 'x', method: 'fake/exit', params: { code: 0 } });
  assert.deepEqual((await ended.waited(2))[1], { sessionId: 's1', waitId: 'c94a5096-f799-4d8a-be8d-e5623b27ce0c/task-2', state: 'cancelled' });
  assert.equal((await ended.p.exited).code, 0);
});

test('the user stopping the turn: the stopped card and the cancelled transcript step end the task once', async t => {
  const { updates, append, waited, messages } = await session(t, true);
  await updates([acp('tool_call', 'in_progress')]);
  append(running(342, COMMAND));
  await waited(1);
  append(canceled(342));
  assert.equal((await waited(2))[1].state, 'cancelled');
  await updates([{ ...acp('tool_call_update', 'failed'), rawOutput: { exit_code: -1 } }]);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(messages.filter(m => m.method === '_coda/wait').length, 2);
});

test('a daemon is told as a task that is not awaited, tied to its card, and the entry makes up no update for the card', async t => {
  const { updates, append, waited, messages } = await session(t, true);
  await updates([acp('tool_call', 'in_progress', { command: 'npm run dev', input: { IsDaemon: true } })]);
  append(running(9, 'npm run dev'));
  const [wait] = await waited(1);
  assert.deepEqual([wait.awaited, wait.toolCallId, wait.state], [false, 'call_1946860740160464019', 'waiting']);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(messages.filter(m => m.method === 'session/update').map(m => m.params.update.status), ['in_progress'], 'the card is as agy said it');
});

// A prompt agy answers end_turn, with the steps of the turn in its transcript.
const failing = (t, waits, ...steps) => session(t, waits, () => ({ steps }));

test('end_turn with an upstream error as the last step of the turn is answered with that error, whether or not Coda declares waits', async t => {
  for (const waits of [true, false]) {
    const { prompt, p } = await failing(t, waits, input(1), answer(2), apiError(3, TIMEOUT));
    const { result, error } = await prompt();
    assert.equal(result, undefined);
    assert.deepEqual([error.code, error.message, error.data], [-32603, TIMEOUT, undefined]);
    assert.match(p.stderr, /上游错误/);
  }
});

test('a server error is a service failure whose input was accepted, as Coda reads it; the entry says so on its stderr', async t => {
  const { prompt, p } = await failing(t, true, input(1), apiError(2, UNAVAILABLE));
  const { error } = await prompt();
  const failure = error.data?._meta?.coda?.failure;
  assert.equal(agentValueProblem('failure.json', failure, 'failure'), null);
  assert.deepEqual([error.code, error.message, failure], [-32603, UNAVAILABLE, { kind: 'service_unavailable', input: 'accepted' }]);
  assert.match(p.stderr, /503/);
});

test('a turn that ends well, or is stopped, is answered as agy answered it', async t => {
  const well = await failing(t, true, input(1), apiError(2), answer(3));
  assert.deepEqual((await well.prompt()).result.stopReason, 'end_turn');
  const stopped = await failing(t, true, input(1), apiError(2));
  assert.equal((await stopped.prompt({ stopReason: 'cancelled' })).result.stopReason, 'cancelled');
  const none = await session(t, true);
  assert.equal((await none.prompt()).result.stopReason, 'end_turn', 'no step in the transcript');
});

test('a turn that already said something on ACP is not turned into a failure: a reply text, a tool that succeeded; a tool that failed is not that', async t => {
  const chunk = { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'The checks pass.' } };
  const call = status => ({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status });
  for (const [updates, kept] of [[[chunk], true], [[call('completed')], true], [[call('failed')], false], [[{ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hm' } }], false]]) {
    const { prompt } = await session(t, true, () => ({ steps: [input(1), apiError(2)], updates }));
    const reply = await prompt();
    assert.equal(reply.result?.stopReason === 'end_turn', kept, JSON.stringify(updates));
    assert.equal(reply.error === undefined, kept);
  }
});

test('a sub-agent started in the turn is told when the turn is answered, and ended when the system says it is idle', async t => {
  const { prompt, waited, dir } = await session(t, true, () => ({ files: { [`subagents/${CHILD}.json`]: record() } }));
  assert.equal((await prompt()).result.stopReason, 'end_turn');
  assert.deepEqual((await waited(1))[0], { sessionId: 's1', waitId: CHILD, kind: 'subagent', state: 'waiting', awaited: false, title: ROLE, childSessionId: CHILD });
  mkdirSync(join(dir, 'messages'));
  writeFileSync(join(dir, 'messages/1.json'), JSON.stringify(idle()));
  assert.deepEqual((await waited(2))[1], { sessionId: 's1', waitId: CHILD, state: 'done' });
});
