import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AgentProcess } from '../../../check/process.mjs';
import { pluginDir } from '../plugin.mjs';
import { MINIMUM, needed, older } from '../../../plugins/grok/scripts/setup.mjs';
import { OTHER } from '../../../plugins/grok/agent/questions.mjs';
import { relaysInstructions } from '../relay.mjs';

const manifest = JSON.parse(readFileSync(join(pluginDir('grok'), 'package.json')));
const quote = s => `'${s.replaceAll("'", "'\\''")}'`;

// The entry on the fixture Grok, as Coda starts it.
function start(t) {
  const dir = mkdtempSync(join(tmpdir(), 'grok-entry-')), messages = [], waiting = [];
  mkdirSync(join(dir, '.grok/bin'), { recursive: true });
  writeFileSync(join(dir, '.grok/bin/grok'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fileURLToPath(new URL('./fixture.mjs', import.meta.url)))}\n`, { mode: 0o755 });
  const p = new AgentProcess({ command: manifest.contributes.agents[0].command, cwd: dir, env: { ...process.env, HOME: dir,
    CODA_NODE: process.execPath, CODA_PLUGIN_PATH: pluginDir('grok') }, onMessage: m => {
    messages.push(m);
    const i = waiting.findIndex(w => w.method === m.method); if (i >= 0) waiting.splice(i, 1)[0].resolve(m);
  } });
  t.after(async () => { await p.terminate(1500); p.kill(); rmSync(dir, { recursive: true, force: true }); });
  const request = async (method, params) => {
    const r = await p.request(method, params, { timeout: 5000 }); assert.equal(r.error, undefined, JSON.stringify(r.error)); return r.result;
  };
  const prompt = text => request('session/prompt', { sessionId: 'native', prompt: [{ type: 'text', text }] });
  const said = () => messages.filter(m => m.params?.update?.content).at(-1).params.update.content.text;
  // The next message of `method` the entry sends: asked for before what brings it about.
  const next = method => new Promise(resolve => waiting.push({ method, resolve }));
  return { dir, p, messages, request, prompt, said, next };
}

test('Grok mode selection takes effect in the same process, preserving options; active turns cannot change mode', async t => {
  const { dir, p, messages, request, prompt, said } = start(t);
  const report = async () => { await prompt('report'); return JSON.parse(said()); };
  await request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  for (const method of ['session/new', 'session/load']) {
    const r = await request(method, { cwd: dir, mcpServers: [], ...(method === 'session/load' ? { sessionId: 'native' } : {}) });
    assert.deepEqual(r.modes.availableModes.map(m => m.id), ['auto', 'always-approve']);
    assert.equal(r.modes.currentModeId, '', 'no explicit mode overrides the machine configuration');
  }
  const before = await report(); assert.equal(before.mode, 'machine');
  await request('session/set_config_option', { sessionId: 'native', configId: 'reasoning_effort', value: 'high' });
  for (const modeId of ['auto', 'always-approve', 'auto']) {
    await request('session/set_mode', { sessionId: 'native', modeId });
    assert.equal(messages.at(-1).params.update.currentModeId, modeId);
    assert.deepEqual(await report(), { mode: modeId, effort: 'high', pid: before.pid });
  }
  const held = prompt('hold');
  for (let i = 0; i < 100 && messages.at(-1)?.params?.update?.content?.text !== 'holding'; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(messages.at(-1).params.update.content.text, 'holding');
  const refused = await p.request('session/set_mode', { sessionId: 'native', modeId: 'always-approve' }, { timeout: 5000 });
  assert.match(refused.error.message, /当前轮次/);
  p.notify('session/cancel', { sessionId: 'native' }); assert.equal((await held).stopReason, 'cancelled');
  assert.equal((await report()).mode, 'auto');
  for (const params of [{ sessionId: 'native', modeId: 'missing' }, { sessionId: 'missing', modeId: 'auto' }]) {
    assert.equal((await p.request('session/set_mode', params, { timeout: 5000 })).error.code, -32602);
  }
});

test('Grok\'s questions are a plain form, answered as Grok takes them, and withdrawn once Grok gives up on them', async t => {
  const { dir, p, request, prompt, said, next } = start(t);
  await request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  await request('session/new', { cwd: dir, mcpServers: [] });
  const form = next('elicitation/create'), answered = prompt('ask'), { id, params: { toolCallId, ...params } } = await form;
  assert.match(toolCallId, /^ask-/);
  assert.deepEqual(params, { sessionId: 'native', mode: 'form', message: 'Grok 需要你的回答', requestedSchema: { type: 'object', properties: {
    q0: { title: '选一个', type: 'string', oneOf: [{ const: 'A', title: 'A — 第一种' }, { const: 'B', title: 'B' }, { const: OTHER, title: '其他（写在下面）' }] },
    q0_other: { type: 'string', title: '其他' },
    q1: { title: '选多个', type: 'array', items: { anyOf: [{ const: 'X', title: 'X' }, { const: 'Y', title: 'Y' }, { const: OTHER, title: '其他（写在下面）' }] }, minItems: 1 },
    q1_other: { type: 'string', title: '其他' } }, required: ['q0', 'q1'] } });
  p.respond(id, { action: 'accept', content: { q0: OTHER, q0_other: 'C', q1: ['X', OTHER], q1_other: 'Z' } });
  await answered;
  assert.deepEqual(JSON.parse(said()), { outcome: 'accepted', answers: { 选一个: 'C', 选多个: ['X', 'Z'] } });
  // Declined, or not asked at all (Coda answers an error), the questions are cancelled.
  for (const reply of [r => p.respond(r, { action: 'decline' }), r => p.respondError(r, -32603, '请求已失效')]) {
    const asked = next('elicitation/create'), done = prompt('ask');
    reply((await asked).id); await done;
    assert.deepEqual(JSON.parse(said()), { outcome: 'cancelled' });
  }
  // Grok stops waiting (its timeout, a cancelled turn) and only ends the tool call: Coda is told to stop asking.
  const asked = next('elicitation/create'), withdrawn = next('$/cancel_request');
  await prompt('give up');
  assert.deepEqual((await withdrawn).params, { requestId: (await asked).id });
});

test('the entry forwards Coda instructions to Grok unchanged', t =>
  relaysInstructions(t, 'grok', '.grok/bin/grok', ['agent', '--no-leader', 'stdio']));

test('setup installs a missing or broken Grok CLI, upgrades one older than the entry was checked against, and keeps a newer one', () => {
  const run = (status, stdout = '') => () => ({ status, stdout, stderr: '' });
  assert.equal(MINIMUM, '1.0.52');
  assert.equal(needed(null).action, 'install');
  assert.equal(needed('/bin/grok', run(1)).action, 'install');
  assert.deepEqual(needed('/bin/grok', run(0, 'grok 1.0.51\n')), { action: 'upgrade', reason: 'Grok CLI 1.0.51 低于所需的 1.0.52' });
  assert.deepEqual(needed('/bin/grok', run(0, 'grok 1.0.52\n')), { action: 'none', version: '1.0.52' });
  assert.deepEqual(needed('/bin/grok', run(0, 'grok 1.1.0 (abc)\n')), { action: 'none', version: '1.1.0' });
  assert.ok(older('1.0.9', '1.0.52') && !older('1.0.52', '1.0.52') && !older('2.0.0', '1.9.99'));
});
