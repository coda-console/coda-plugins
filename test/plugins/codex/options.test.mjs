// Drive the real patched adapter through ACP, and inspect what its app-server actually receives. No model calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentProcess } from '../../../check/process.mjs';
import { cleared } from '../../../check/coda/components/plugins/plugin-rules.mjs';
import { clientCapabilities } from '../../../check/coda/domain/agent-protocol.mjs';
import { schemas } from '../../../check/schema.mjs';
import { codexOptionsAsShown } from '../../../plugins/codex/agent/options.mjs';
import { pluginDir, resolveFrom } from '../plugin.mjs';

const fast = { id: 'priority', name: 'Fast', description: '2x speed, increased usage' };
const ultra = { id: 'ultrafast', name: 'Ultrafast', description: 'Higher speed and usage' };
const future = { id: 'future', name: 'A future tier', description: 'From the native catalog' };
const model = (id, tiers, defaultServiceTier = null) => ({ id, model: id, displayName: id, description: '', hidden: false,
  isDefault: id === 'full', defaultReasoningEffort: 'medium', inputModalities: ['text'],
  supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: '' }, { reasoningEffort: 'high', description: '' }],
  serviceTiers: tiers, defaultServiceTier, additionalSpeedTiers: ['fast'] });
const models = [model('full', [fast, ultra, future], 'priority'), model('fast-only', [fast]), model('standard-only', [])];
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const speed = result => result.configOptions.find(option => option.id === 'service-tier');

async function session(t, { tier, load = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'coda-codex-options-'));
  let proc;
  t.after(async () => { if (proc) { await proc.terminate(1000); proc.kill(); } rmSync(root, { recursive: true, force: true }); });
  const program = join(root, 'codex');
  writeFileSync(program, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fileURLToPath(new URL('./app-server-fixture.mjs', import.meta.url)))}\n`);
  chmodSync(program, 0o700);
  writeFileSync(join(root, 'died'), '');
  proc = new AgentProcess({ command: `exec ${quote(process.execPath)} ${quote(join(pluginDir('codex'), 'agent/entry.mjs'))}`, cwd: root,
    env: { ...cleared(process.env), CODEX_PATH: program, CODEX_HOME: join(root, 'home'), FAKE_CODEX_STATE: root,
      FAKE_CODEX_MODELS: JSON.stringify(models), ...(tier ? { FAKE_CODEX_SERVICE_TIER: tier } : {}) } });
  const request = async (method, params) => {
    const reply = await proc.request(method, params, { timeout: 10000 });
    assert.equal(reply.error, undefined, JSON.stringify(reply.error));
    return reply.result;
  };
  await request('initialize', { protocolVersion: 1, clientCapabilities: clientCapabilities() });
  const result = await request(load ? 'session/load' : 'session/new', { cwd: root, mcpServers: [], ...(load ? { sessionId: 'fake-thread' } : {}) });
  assert.equal((load ? schemas.zLoadSessionResponse : schemas.zNewSessionResponse).safeParse(result).success, true);
  const sessionId = result.sessionId ?? 'fake-thread';
  return { result, proc, sessionId,
    set: (configId, value) => request('session/set_config_option', { sessionId, configId, value }),
    prompt: async () => {
      await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hello' }] });
      return readFileSync(join(root, 'prompts.ndjson'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
        .filter(p => p.input.some(item => item.text === 'hello')).at(-1);
    } };
}

test('speed is an ACP select and every advertised tier reaches the next native turn, including clearing paid speed', async t => {
  const s = await session(t);
  const option = speed(s.result);
  assert.equal(option.type, 'select');
  assert.equal(option.name, '速度');
  assert.equal(option.currentValue, 'default', 'the native thread value wins over the catalog default');
  assert.deepEqual(option.options.map(o => [o.value, o.name]),
    [['default', '标准'], ['priority', '加速'], ['ultrafast', '超高速'], ['future', 'A future tier']]);
  assert.equal(option.options[1].description, fast.description);
  assert.equal(s.result.configOptions.some(o => ['fast-mode', 'collaboration_mode'].includes(o.id)), false);
  for (const tier of ['ultrafast', 'priority', 'future', 'default']) {
    assert.equal(speed(await s.set('service-tier', tier)).currentValue, tier);
    assert.equal((await s.prompt()).serviceTier, tier === 'default' ? null : tier);
  }
  await s.set('service-tier', 'ultrafast');
  assert.equal(speed(await s.set('reasoning_effort', 'high')).currentValue, 'ultrafast', 'effort changes do not reset speed');
  assert.equal((await s.prompt()).serviceTier, 'ultrafast');
});

test('changing models uses their own tiers and defaults, and unavailable values are rejected', async t => {
  const s = await session(t, { tier: 'ultrafast' });
  const limited = speed(await s.set('model', 'fast-only'));
  assert.deepEqual(limited.options.map(o => o.value), ['default', 'priority']);
  assert.equal(limited.currentValue, 'default');
  for (const value of ['ultrafast', 'unavailable', true]) {
    const reply = await s.proc.request('session/set_config_option', { sessionId: s.sessionId, configId: 'service-tier', value });
    assert.equal(reply.error?.code, -32602);
  }
  assert.equal((await s.prompt()).serviceTier, null);
  await s.set('service-tier', 'priority');
  assert.equal(speed(await s.set('model', 'standard-only')), undefined, 'no accelerated tier means no speed control');
  assert.equal((await s.prompt()).serviceTier, null);
  assert.equal(speed(await s.set('model', 'full')).currentValue, 'priority', 'another model starts at its catalog default');
  assert.equal((await s.prompt()).serviceTier, 'priority');
});

for (const tier of ['ultrafast', 'fast']) test(`loading a native ${tier} session preserves its speed`, async t => {
  const s = await session(t, { tier, load: true });
  const expected = tier === 'fast' ? 'priority' : tier;
  assert.equal(speed(s.result).currentValue, expected);
  assert.equal((await s.prompt()).serviceTier, expected);
});

test('the config patch refuses a changed or already patched adapter', () => {
  const source = readFileSync(resolveFrom('codex', '@agentclientprotocol/codex-acp'), 'utf8');
  assert.throws(() => codexOptionsAsShown(source.replace('const serviceTier = resolveFastServiceTier(', 'const serviceTier = anotherTier(')), /no longer matches/);
  assert.throws(() => codexOptionsAsShown(codexOptionsAsShown(source)), /no longer matches/);
});
