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
import { COMMAND, acp, canceled, finished, running, SUMMARY } from './background-fixture.mjs';

const quote = s => `'${s.replaceAll("'", "'\\''")}'`;

// A session `s1` of the fake agy, whose transcript is in the home; `waits` is whether Coda declares the capability.
async function session(t, waits) {
  const messages = [];
  const home = mkdtempSync(join(tmpdir(), 'antigravity-background-entry-'));
  mkdirSync(join(home, '.local/bin'), { recursive: true });
  writeFileSync(join(home, '.local/bin/agy'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fileURLToPath(new URL('./fixture.mjs', import.meta.url)))}\n`, { mode: 0o755 });
  const dir = join(home, '.gemini/antigravity-cli/brain/s1/.system_generated');
  mkdirSync(join(dir, 'logs'), { recursive: true });
  const transcript = join(dir, 'logs/transcript.jsonl');
  writeFileSync(transcript, '');
  const p = new AgentProcess({ onMessage: m => messages.push(m), command: manifest('antigravity').contributes.agents[0].command, cwd: home,
    env: { ...process.env, HOME: home, CODA_NODE: process.execPath, CODA_PLUGIN_PATH: pluginDir('antigravity') } });
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
  const updates = list => request('fake/updates', { sessionId, updates: list });
  return { p, messages, request, transcript, waited, updates, append: step => appendFileSync(transcript, `${JSON.stringify(step)}\n`) };
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
