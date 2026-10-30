// The checker against this repository's own agent entries, each with what it drives stood in for, so that no login is
// needed and nothing of this machine's is touched: Claude with the fixture SDK, Codex with a fixture app-server, Kimi with
// the checker's honest fake agent as `kimi acp`, `opencode acp` and `cursor-agent acp`, Grok with a fixture CLI. They pass
// every level, as Coda holds them.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkPlugin } from '../../check/index.mjs';
import { pluginDir } from './plugin.mjs';
import { substituted } from './substitute.mjs';

const at = path => fileURLToPath(new URL(path, import.meta.url));
const limits = { settle: 10_000 };
const root = mkdtempSync(join(tmpdir(), 'coda-plugins-contract-'));
after(() => rmSync(root, { recursive: true, force: true }));
// A program at `path` that runs a Node script.
function program(path, script) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)}\n`);
  chmodSync(path, 0o755);
  return path;
}
// The agent's environment is the checker's (check/agent.mjs): these, for one check.
async function check(id, agent, env) {
  const before = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  try { return (await checkPlugin(pluginDir(id), { agent, live: true, limits })).report; }
  finally { for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value; }
}
// The fakes answer at once: whether the second turn is still going when the checker stops it is theirs to say, and either
// way it is judged (live.cancel).
function assertPasses(report, expected) {
  assert.deepEqual(report.failures, []);
  const passed = report.items.filter(item => item.status === 'pass').map(item => item.rule);
  for (const rule of expected) assert.ok(passed.includes(rule), `${rule} passed: ${passed.join(', ')}`);
  assert.ok(report.items.some(item => item.rule === 'live.cancel'));
}
const EVERY = ['handshake.initialize', 'handshake.new', 'handshake.sigterm', 'handshake.exit-input', 'live.turn', 'live.updates'];

test('claude, with the fixture SDK', async () => {
  const report = await check('claude', 'claude-sdk', substituted({ '@anthropic-ai/claude-agent-sdk': at('./claude/fixture-sdk.mjs') }));
  assertPasses(report, [...EVERY, 'live.load']);
});

test('codex, its codex-acp with a fixture app-server', async () => {
  // The fixture's first turn in a state directory dies, as an app-server can; here it has died already.
  const state = join(root, 'codex');
  mkdirSync(state);
  writeFileSync(join(state, 'died'), '');
  const report = await check('codex', 'codex', { CODEX_PATH: program(join(root, 'bin/codex'), at('./codex/app-server-fixture.mjs')),
    FAKE_CODEX_STATE: state, CODEX_HOME: join(root, 'codex-home') });
  assertPasses(report, [...EVERY, 'live.load']);
});

test('kimi, its relay with a fake kimi acp', async () => {
  // Kimi is looked for in ~/.kimi-code/bin, then on the PATH: here only the fake is found.
  const home = join(root, 'home');
  mkdirSync(home);
  program(join(root, 'kimi-bin/kimi'), at('../fixtures/liar.mjs'));
  const report = await check('kimi', 'kimi', { HOME: home, KIMI_CODE_HOME: join(home, '.kimi-code'), PATH: `${join(root, 'kimi-bin')}:${process.env.PATH}` });
  assertPasses(report, EVERY);
});

test('grok, its approval-mode entry with a fake Grok CLI', async () => {
  const home = join(root, 'grok-home');
  program(join(home, '.grok/bin/grok'), at('./grok/fixture.mjs'));
  const report = await check('grok', 'grok', { HOME: home, GROK_HOME: join(home, '.grok') });
  assertPasses(report, [...EVERY, 'live.load']);
});

test('grok-bot, handshake without a cloud account or the pending remote extension', async () => {
  const { report } = await checkPlugin(pluginDir('grok-bot'), { agent: 'grok-bot', limits });
  assert.deepEqual(report.failures, []);
  for (const rule of ['handshake.initialize', 'handshake.new', 'handshake.sigterm', 'handshake.exit-input'])
    assert.ok(report.items.some(item => item.rule === rule && item.status === 'pass'), rule);
});

test('opencode and cursor, their relays with a fake CLI', async () => {
  for (const [id, binary] of [['opencode', '.opencode/bin/opencode'], ['cursor', '.local/bin/cursor-agent']]) {
    const home = join(root, `${id}-home`);
    program(join(home, binary), at('../fixtures/liar.mjs'));
    assertPasses(await check(id, id, { HOME: home }), EVERY);
  }
});
