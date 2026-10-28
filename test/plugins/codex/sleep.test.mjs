import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentProcess } from '../../../check/process.mjs';
import { clientCapabilities } from '../../../check/coda/domain/agent-protocol.mjs';
import { CodexWaits } from '../../../plugins/codex/agent/waits.mjs';
import { codexSleepUpdate, reportedCodexSleeps } from '../../../plugins/codex/agent/sleep.mjs';
import { pluginEnv } from '../command.mjs';
import { pluginDir, resolveFrom } from '../plugin.mjs';

const sleep = (id = 'nap', durationMs = 7200000) => ({ type: 'sleep', id, durationMs });
const update = (sessionId, item, state) => ({ method: 'session/update', params: { sessionId, update: codexSleepUpdate(item, state) } });
const facts = messages => messages.filter(m => m.method === '_coda/wait').map(m => m.params);

test('native sleeps are background waits, with readable durations and no pretend per-task stop', () => {
  const waits = new CodexWaits();
  for (const [duration, title] of [[7200000, '等待 2 小时'], [90000, '等待 90 秒'], [60000, '等待 1 分钟'], [1500, '等待 1.5 秒']]) {
    const item = sleep(`nap-${duration}`, duration);
    const [start] = facts(waits.fromAgent(update('root', item, 'waiting')));
    assert.deepEqual(start, { sessionId: 'root', waitId: `sleep:${item.id}`, kind: 'task', state: 'waiting', title,
      detail: '等待结束后继续；发送消息并选择「立即插话」可提前继续。', stoppable: false });
    const stop = waits.fromCoda({ id: 'stop', method: '_coda/wait/stop', params: { sessionId: 'root', waitId: start.waitId } });
    assert.equal(stop.coda[0].error.code, -32602);
    assert.deepEqual(facts(waits.fromAgent(update('root', item, 'done'))), [{ sessionId: 'root', waitId: start.waitId, state: 'done' }]);
  }
  assert.equal(waits.sleeps.size, 0);
});

test('a prompt ending without the sleep completion clears only its own waits before the reply', () => {
  for (const [reply, state] of [[{ result: { stopReason: 'cancelled' } }, 'cancelled'], [{ error: { code: -32603, message: 'failed' } }, 'failed'], [{ result: { stopReason: 'end_turn' } }, 'done']]) {
    const waits = new CodexWaits();
    waits.fromCoda({ id: 'prompt', method: 'session/prompt', params: { sessionId: 'root' } });
    waits.fromAgent(update('root', sleep(), 'waiting'));
    waits.fromAgent(update('child:generation:2', sleep(), 'waiting'));
    const ended = waits.fromAgent({ id: 'prompt', ...reply });
    assert.deepEqual(facts(ended), [{ sessionId: 'root', waitId: 'sleep:nap', state }]);
    assert.equal(ended.at(-1).id, 'prompt');
    assert.deepEqual(facts(waits.fromAgent(update('child:generation:2', sleep(), 'done'))), [{ sessionId: 'child', waitId: 'sleep:nap', state: 'done' }]);
    assert.equal(waits.sleeps.size, 0);
  }
});

test('a continued child ending closes its sleep before its delegation, without closing the parent sleep', () => {
  const waits = new CodexWaits();
  waits.fromAgent(update('root', sleep(), 'waiting'));
  waits.fromAgent(update('child:generation:2', sleep(), 'waiting'));
  assert.deepEqual(facts(waits.fromAgent({ method: 'session/update', params: { sessionId: 'root', update: {
    sessionUpdate: 'subagent_state_update', subagentSessionId: 'child:generation:2', state: 'cancelled',
  } } })), [
    { sessionId: 'child', waitId: 'sleep:nap', state: 'cancelled' },
    { sessionId: 'root', waitId: 'child:generation:2', state: 'cancelled' },
  ]);
  assert.equal(waits.sleeps.has('root'), true);
});

test('the sleep patch fails loudly when either locked adapter branch changes', () => {
  const bundle = readFileSync(resolveFrom('codex', '@agentclientprotocol/codex-acp'), 'utf8');
  for (const activity of ['Started', 'Completed']) {
    assert.throws(() => reportedCodexSleeps(bundle.replace(`legacyActivity${activity}(event.item)`, 'changed(event.item)')), /no longer matches/);
  }
});

for (const ending of ['complete', 'steer', 'cancel']) test(`through the real adapter: sleep is visible until ${ending}`, { timeout: 15000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'coda-codex-sleep-'));
  let proc;
  t.after(async () => { if (proc) { await proc.terminate(1000); proc.kill(); } rmSync(root, { recursive: true, force: true }); });
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const program = join(root, 'codex');
  writeFileSync(program, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fileURLToPath(new URL('./app-server-fixture.mjs', import.meta.url)))}\n`);
  chmodSync(program, 0o700); writeFileSync(join(root, 'died'), '');
  const messages = [];
  let started;
  const waiting = new Promise(resolve => { started = resolve; });
  proc = new AgentProcess({ command: `exec ${quote(process.execPath)} ${quote(join(pluginDir('codex'), 'agent/entry.mjs'))}`, cwd: root,
    env: pluginEnv('codex', { CODEX_PATH: program, FAKE_CODEX_STATE: root, CODEX_HOME: join(root, 'home') }),
    onMessage(message) { messages.push(message); if (message.method === '_coda/wait' && message.params.state === 'waiting') started(message.params); } });
  const request = async (method, params) => {
    const reply = await proc.request(method, params, { timeout: 10000 });
    assert.equal(reply.error, undefined, JSON.stringify(reply.error));
    return reply.result;
  };
  await request('initialize', { protocolVersion: 1, clientCapabilities: clientCapabilities() });
  const { sessionId } = await request('session/new', { cwd: root, mcpServers: [] });
  let finished = false;
  const prompt = request('session/prompt', { sessionId, prompt: [{ type: 'text', text: `clock.sleep ${ending === 'complete' ? '' : 'hold'}` }] }).then(result => { finished = true; return result; });
  const active = await waiting;
  assert.equal(active.title, '等待 2 小时');
  assert.equal(active.kind, 'task');
  if (ending !== 'complete') {
    assert.equal(finished, false, 'the original prompt remains pending while the wait is visible');
    if (ending === 'steer') await request('_session/steering', { sessionId, prompt: [{ type: 'text', text: '继续' }] });
    else proc.notify('session/cancel', { sessionId });
  }
  const result = await prompt;
  assert.equal(result.stopReason, ending === 'cancel' ? 'cancelled' : 'end_turn');
  assert.deepEqual(facts(messages).map(m => [m.sessionId, m.waitId, m.state]), [
    [sessionId, active.waitId, 'waiting'], [sessionId, active.waitId, ending === 'cancel' ? 'cancelled' : 'done'],
  ]);
});
