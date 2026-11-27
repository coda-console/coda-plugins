// Actual ACP entry -> locked codex-acp -> fixture app-server: assert the policies sent on the wire, not source strings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentProcess, cleared, clientCapabilities } from '../../helpers/agent.mjs';
import { pluginDir } from '../plugin.mjs';

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const expected = {
  manual: ['untrusted', 'user', 'workspaceWrite'],
  'agent-full-access': ['never', 'user', 'dangerFullAccess'],
  agent: ['on-request', 'auto_review', 'workspaceWrite'],
  'read-only': ['on-request', 'user', 'workspaceWrite'],
};
async function session(t, { load, initial, mcpServers = [], sessionTmp, additionalDirectories } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'coda-codex-permissions-'));
  let proc;
  const asked = [];
  t.after(async () => { if (proc) { await proc.terminate(1000); proc.kill(); } rmSync(root, { recursive: true, force: true }); });
  const program = join(root, 'codex');
  writeFileSync(program, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fileURLToPath(new URL('./app-server-fixture.mjs', import.meta.url)))}\n`);
  chmodSync(program, 0o700); writeFileSync(join(root, 'died'), '');
  const env = { ...cleared(process.env), CODEX_PATH: program, CODEX_HOME: join(root, 'home'), FAKE_CODEX_STATE: root };
  delete env.INITIAL_AGENT_MODE; delete env.CODEX_CONFIG;
  if (initial) env.INITIAL_AGENT_MODE = initial;
  delete env.CODA_SESSION_TMP;
  if (sessionTmp) env.CODA_SESSION_TMP = sessionTmp(root);
  proc = new AgentProcess({ command: `exec ${quote(process.execPath)} ${quote(join(pluginDir('codex'), 'agent/entry.mjs'))}`, cwd: root, env,
    // The user (here: this test) allows what Codex asks to run; what was asked stays in `asked`.
    onMessage: message => {
      if (message.method !== 'session/request_permission') return;
      asked.push(message);
      proc.respond(message.id, { outcome: { outcome: 'selected', optionId: message.params.options.find(option => option.kind === 'allow_once').optionId } });
    } });
  const request = async (method, params) => {
    const reply = await proc.request(method, params, { timeout: 10000 });
    assert.equal(reply.error, undefined, JSON.stringify(reply.error)); return reply.result;
  };
  await request('initialize', { protocolVersion: 1, clientCapabilities: clientCapabilities() });
  const result = await request(load ? 'session/load' : 'session/new', { cwd: root, mcpServers, ...(additionalDirectories ? { additionalDirectories } : {}),
    ...(load ? { sessionId: 'fake-thread' } : {}) });
  const sessionId = result.sessionId ?? 'fake-thread';
  const nativeConfig = readFileSync(join(root, 'threads.ndjson'), 'utf8').trim().split('\n').map(JSON.parse)
    .find(call => ['thread/start', 'thread/resume'].includes(call.method) && !call.params.ephemeral).params.config;
  return { root, result, nativeConfig, asked, set: modeId => request('session/set_mode', { sessionId, modeId }),
    setOption: value => request('session/set_config_option', { sessionId, configId: 'mode', value }),
    async turn(text = 'permission check') {
      await request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
      return readFileSync(join(root, 'prompts.ndjson'), 'utf8').trim().split('\n').map(JSON.parse)
        .filter(p => p.input.some(item => item.text === text)).at(-1);
    } };
}
function policy(turn, mode) {
  assert.deepEqual([turn.approvalPolicy, turn.approvalsReviewer, turn.sandboxPolicy.type], expected[mode]);
  if (mode === 'agent-full-access') assert.deepEqual(turn.sandboxPolicy, { type: 'dangerFullAccess' });
  // The existing automatic mode allows networking; the approval modes keep their network boundary.
  else assert.equal(turn.sandboxPolicy.networkAccess, mode === 'agent');
}

test('new and restored sessions default to full access; explicit saved/user ACP selections still take effect', async t => {
  for (const load of [false, true]) await t.test(load ? 'load' : 'new', async t => {
    const s = await session(t, { load });
    assert.equal(s.result.configOptions.find(option => option.category === 'mode').currentValue, 'agent-full-access');
    policy(await s.turn(), 'agent-full-access');
    for (const mode of ['manual', 'read-only', 'agent', 'agent-full-access']) { await s.set(mode); policy(await s.turn(), mode); }
  });
});

test('manual approval is one more ACP mode, in the mode list and the config option, and set_mode and set_config_option both reach it', async t => {
  const s = await session(t);
  const option = s.result.configOptions.find(each => each.category === 'mode');
  assert.deepEqual(option.options.map(each => [each.value, each._meta.coda?.shortName]),
    [['manual', '人工审批'], ['read-only', '按需审批'], ['agent', '自动审批'], ['agent-full-access', '完全访问']]);
  assert.deepEqual(s.result.modes.availableModes.map(each => each.id), ['manual', 'read-only', 'agent', 'agent-full-access']);
  assert.equal(option.currentValue, 'agent-full-access');
  await s.setOption('manual');
  policy(await s.turn(), 'manual');
  await s.setOption('agent');
  policy(await s.turn(), 'agent');
});

test('in manual approval Codex\'s request to approve a command reaches Coda as session/request_permission, and the answer goes back', async t => {
  const s = await session(t, { initial: 'manual' });
  policy(await s.turn('command-approval'), 'manual');
  assert.equal(s.asked.length, 1);
  assert.equal(s.asked[0].params.toolCall.rawInput.command, 'npm test');
  assert.deepEqual(s.asked[0].params.options.map(option => option.kind), ['allow_once', 'reject_once']);
  const answers = readFileSync(join(s.root, 'answers.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(answers.find(answer => answer.id === 'approval-1').result, { decision: 'accept' });
});

test('an explicit launch mode is not replaced by the default', async t => {
  for (const initial of ['manual', 'read-only', 'agent']) await t.test(initial, async t => {
    const s = await session(t, { initial });
    assert.equal(s.result.configOptions.find(option => option.category === 'mode').currentValue, initial);
    policy(await s.turn(), initial);
  });
});


test('the entry applies Coda MCP approval policy while an explicitly automatic session stays automatic', async t => {
  const mcpServers = [{ name: 'coda', command: process.execPath, env: [], args: [
    join(tmpdir(), 'coda-runtime', 'src/adapters/mcp-shim.mjs'), '--thread', 'coda-thread', '--socket', join(tmpdir(), 'coda.sock')
  ] }];
  const s = await session(t, { initial: 'agent', mcpServers });
  assert.equal(s.nativeConfig.mcp_servers.coda.default_tools_approval_mode, 'approve');
  policy(await s.turn(), 'agent');
});

test('the session\'s own temporary directory joins the workspace-write roots of every mode that has them, and only it', async t => {
  for (const load of [false, true]) await t.test(load ? 'load' : 'new', async t => {
    const s = await session(t, { load, initial: 'agent', additionalDirectories: ['/coda/uploads'],
      sessionTmp: root => join(root, 'state', 'session-tmp', 'this-session') });
    const own = join(s.root, 'state', 'session-tmp', 'this-session');
    assert.deepEqual(s.nativeConfig.sandbox_workspace_write.writable_roots, ['/coda/uploads', own]);
    for (const mode of ['agent', 'manual', 'read-only']) {
      await s.set(mode);
      const turn = await s.turn();
      policy(turn, mode);
      // Exactly the session's directory beside the ACP ones: not session-tmp/ (other sessions' directories are under it).
      assert.deepEqual(turn.sandboxPolicy.writableRoots, ['/coda/uploads', own]);
    }
    await s.set('agent-full-access');
    policy(await s.turn(), 'agent-full-access');
  });
});

test('without an absolute CODA_SESSION_TMP the sandbox roots stay as codex-acp makes them', async t => {
  for (const sessionTmp of [undefined, () => 'relative/session-tmp/this-session']) await t.test(sessionTmp ? 'relative' : 'unset', async t => {
    const s = await session(t, { initial: 'agent', sessionTmp });
    assert.equal(s.nativeConfig.sandbox_workspace_write, undefined);
    assert.deepEqual((await s.turn()).sandboxPolicy.writableRoots, []);
  });
});
