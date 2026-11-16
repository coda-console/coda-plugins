import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentProcess } from '../../../check/process.mjs';
import { clientCapabilities } from '../../../check/coda/domain/agent-protocol.mjs';
import { codexCompactionUpdate, reportedCodexCompactions } from '../../../plugins/codex/agent/compaction.mjs';
import { pluginEnv } from '../command.mjs';
import { pluginDir, resolveFrom } from '../plugin.mjs';

const item = { type: 'contextCompaction', id: 'c1' };

test('an item compaction goes from in_progress to completed under the item id', () => {
  const handler = {};
  assert.deepEqual(codexCompactionUpdate(handler, { turnId: 't1', item }, 'in_progress'), { sessionUpdate: 'compaction_update', compactionId: 'c1', status: 'in_progress' });
  assert.deepEqual(codexCompactionUpdate(handler, { turnId: 't1', item }, 'completed'), { sessionUpdate: 'compaction_update', compactionId: 'c1', status: 'completed' });
});

test('the deprecated notification alone completes one compaction of its turn', () => {
  assert.deepEqual(codexCompactionUpdate({}, { turnId: 't1' }), { sessionUpdate: 'compaction_update', compactionId: 't1:compacted', status: 'completed' });
});

test('whichever of the item and the deprecated notification comes first is the one told in its turn, the other is not', () => {
  for (const [first, second] of [[{ turnId: 't1', item }, { turnId: 't1' }], [{ turnId: 't1' }, { turnId: 't1', item }]]) {
    const handler = {};
    assert.ok(codexCompactionUpdate(handler, first, 'completed'));
    assert.equal(codexCompactionUpdate(handler, second, 'completed'), null);
  }
  const handler = {};
  codexCompactionUpdate(handler, { turnId: 't1', item }, 'completed');
  assert.ok(codexCompactionUpdate(handler, { turnId: 't2' }), 'a later turn is told again');
});

test('the compaction patch fails loudly when any locked adapter branch changes', () => {
  const bundle = readFileSync(resolveFrom('codex', '@agentclientprotocol/codex-acp'), 'utf8');
  for (const name of ['createContextCompactionStartUpdate(event.item)', 'createContextCompactionCompleteUpdate(event.item)', 'this.createContextCompactedEvent()']) {
    assert.throws(() => reportedCodexCompactions(bundle.replace(name, 'changed()')), /no longer matches/);
  }
});

// What each way Codex can say it comes to: the item's start and completion, or the one completion of the notification first.
const modes = {
  'the item alone': ['compaction', ['in_progress', 'completed']],
  'the item with the deprecated notification after it': ['compaction legacy-last', ['in_progress', 'completed']],
  'the deprecated notification before the item': ['compaction legacy-first', ['completed']],
  'the deprecated notification alone': ['compaction legacy-only', ['completed']],
};
for (const [name, [text, expected]] of Object.entries(modes)) test(`through the real adapter: ${name} is one compaction_update, no tool card`, { timeout: 15000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'coda-codex-compaction-'));
  let proc;
  t.after(async () => { if (proc) { await proc.terminate(1000); proc.kill(); } rmSync(root, { recursive: true, force: true }); });
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const program = join(root, 'codex');
  writeFileSync(program, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fileURLToPath(new URL('./app-server-fixture.mjs', import.meta.url)))}\n`);
  chmodSync(program, 0o700); writeFileSync(join(root, 'died'), '');
  const updates = [];
  proc = new AgentProcess({ command: `exec ${quote(process.execPath)} ${quote(join(pluginDir('codex'), 'agent/entry.mjs'))}`, cwd: root,
    env: pluginEnv('codex', { CODEX_PATH: program, FAKE_CODEX_STATE: root, CODEX_HOME: join(root, 'home') }),
    onMessage(message) { if (message.method === 'session/update') updates.push(message.params.update); } });
  const request = async (method, params) => {
    const reply = await proc.request(method, params, { timeout: 10000 });
    assert.equal(reply.error, undefined, JSON.stringify(reply.error));
    return reply.result;
  };
  await request('initialize', { protocolVersion: 1, clientCapabilities: clientCapabilities() });
  const { sessionId } = await request('session/new', { cwd: root, mcpServers: [] });
  await request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
  const compactions = updates.filter(u => u.sessionUpdate === 'compaction_update');
  assert.deepEqual(compactions.map(u => u.status), expected);
  assert.equal(new Set(compactions.map(u => u.compactionId)).size, 1);
  assert.deepEqual(updates.filter(u => /^tool_call/.test(u.sessionUpdate) || /compact/i.test(JSON.stringify(u.content ?? ''))), []);
});
