// The Antigravity entry on a fake `agy acp`, as Coda starts it: Coda is given no additional directories to pass.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AgentProcess } from '../../../check/process.mjs';
import { manifest } from '../command.mjs';
import { pluginDir } from '../plugin.mjs';

const quote = s => `'${s.replaceAll("'", "'\\''")}'`;

function start(t) {
  const home = mkdtempSync(join(tmpdir(), 'antigravity-entry-'));
  mkdirSync(join(home, '.local/bin'), { recursive: true });
  writeFileSync(join(home, '.local/bin/agy'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fileURLToPath(new URL('./fixture.mjs', import.meta.url)))}\n`, { mode: 0o755 });
  const p = new AgentProcess({ command: manifest('antigravity').contributes.agents[0].command, cwd: home,
    env: { ...process.env, HOME: home, CODA_NODE: process.execPath, CODA_PLUGIN_PATH: pluginDir('antigravity') } });
  t.after(async () => { await p.terminate(1500); p.kill(); rmSync(home, { recursive: true, force: true }); });
  return { p, request: async (method, params) => (await p.request(method, params, { timeout: 5000 })).result };
}

test('the entry takes additionalDirectories out of the capabilities agy declares and out of session requests', async t => {
  const { request } = start(t);
  const { agentCapabilities } = await request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  assert.deepEqual(agentCapabilities, { loadSession: true, sessionCapabilities: { list: {} }, session_capabilities: { list: {} } });
  const params = { cwd: '/work', mcpServers: [], additionalDirectories: ['/b-extra', '/c-extra'] };
  const { additionalDirectories, ...rest } = params;
  assert.deepEqual((await request('session/new', params)).received, rest);
  assert.deepEqual((await request('session/load', { ...params, sessionId: 's' })).received, { ...rest, sessionId: 's' });
  assert.deepEqual((await request('session/resume', { ...params, sessionId: 's' })).received, { ...rest, sessionId: 's' });
  assert.deepEqual((await request('session/prompt', { sessionId: 's', additionalDirectories })).received, { sessionId: 's', additionalDirectories }, 'other requests are not touched');
});

test('the entry ends on SIGTERM', async t => {
  const { p, request } = start(t);
  await request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  const started = Date.now();
  process.kill(p.pid, 'SIGTERM');
  assert.equal((await p.exited).code, 0);
  assert.ok(Date.now() - started < 2000);
});
