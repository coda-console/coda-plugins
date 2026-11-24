// The locked adapter's own sandbox code, patched as the entry patches it: which roots a turn and a session config get.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { withSessionTmp, writableCodexSessionTmp } from '../../../plugins/codex/agent/session-tmp.mjs';
import { resolveFrom } from '../plugin.mjs';

const bundle = await readFile(resolveFrom('codex', '@agentclientprotocol/codex-acp'), 'utf8');
const patched = writableCodexSessionTmp(bundle);
const own = '/coda/state/session-tmp/this-session';
const plain = value => JSON.parse(JSON.stringify(value));

function adapter(source, env) {
  const slice = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
  return vm.runInNewContext(`${slice('// src/AgentMode.ts', '// src/CodexAcpClient.ts')}
${slice('function mergeSandboxWorkspaceWriteRoots(', 'function arraysEqual(')}
({ modes: AgentMode,
${slice('  async sendPrompt(request, agentMode,', '  async setCollaborationMode(')},
${slice('  async createSessionConfig(projectPath, additionalDirectories, mcpServers) {', '  async getConfigMcpServerNames(')} })`, {
    withSessionTmp: directories => withSessionTmp(directories, env), buildPromptItems: prompt => prompt, process: { env: {} },
    isJsonObject: value => typeof value === 'object' && value !== null && !Array.isArray(value), logger: { log() {} },
    mergeGatewayConfig: config => config
  });
}
async function turn(source, env, mode, additional = []) {
  const a = adapter(source, env), sent = [];
  await a.sendPrompt.call({ refreshSkills: async () => {}, codexClient: { runTurn: async params => { sent.push(params); } } },
    { sessionId: 'thread', prompt: [] }, typeof mode === 'string' ? a.modes[mode] : mode, { model: 'fixture' }, undefined, false, '/checkout', additional);
  return plain(sent[0].sandboxPolicy);
}
async function config(source, env, additional = []) {
  const a = adapter(source, env);
  return plain(await a.createSessionConfig.call({ config: { sandbox_mode: 'workspace-write' }, gatewayConfig: null,
    getNativeProviderConfig: () => ({}), getModelProvider: () => 'fixture' }, '/checkout', additional, []));
}

test('workspace-write turns and the session config gain exactly the session\'s own directory', async () => {
  const env = { CODA_SESSION_TMP: own };
  for (const mode of ['Agent', 'ReadOnly']) {
    assert.deepEqual((await turn(patched, env, mode)).writableRoots, [own]);
    assert.deepEqual((await turn(patched, env, mode, ['/uploads', own])).writableRoots, ['/uploads', own]);
  }
  assert.deepEqual((await config(patched, env, ['/uploads'])).sandbox_workspace_write, { writable_roots: ['/uploads', own] });
  // The session's directory is not trusted as a project: it widens the sandbox, nothing else.
  assert.deepEqual(Object.keys((await config(patched, env, ['/uploads'])).projects), ['/checkout', '/uploads']);
  const a = adapter(patched, env);
  assert.equal(a.modes.Agent.sandboxPolicy.writableRoots.length, 0, 'the mode default is not widened');
});

test('full access, a read-only policy, and no or a relative CODA_SESSION_TMP leave the adapter as it is', async () => {
  assert.deepEqual(await turn(patched, { CODA_SESSION_TMP: own }, 'AgentFullAccess'), { type: 'dangerFullAccess' });
  // codex-acp has no read-only sandbox mode of its own ("read-only" is workspace-write with the user approving); one with a
  // read-only policy is not widened.
  const readOnly = { approvalPolicy: 'on-request', approvalsReviewer: 'user', sandboxPolicy: { type: 'readOnly', networkAccess: false } };
  assert.deepEqual(await turn(patched, { CODA_SESSION_TMP: own }, readOnly, ['/uploads']), { type: 'readOnly', networkAccess: false });
  for (const env of [{}, { CODA_SESSION_TMP: '' }, { CODA_SESSION_TMP: 'session-tmp/this-session' }]) {
    for (const mode of ['Agent', 'ReadOnly', 'AgentFullAccess']) assert.deepEqual(await turn(patched, env, mode, ['/uploads']), await turn(bundle, env, mode, ['/uploads']));
    assert.deepEqual(await config(patched, env), await config(bundle, env));
    assert.deepEqual(await config(patched, env, ['/uploads']), await config(bundle, env, ['/uploads']));
  }
});

test('withSessionTmp adds one absolute directory once', () => {
  assert.deepEqual(withSessionTmp([], { CODA_SESSION_TMP: own }), [own]);
  assert.deepEqual(withSessionTmp([own], { CODA_SESSION_TMP: own }), [own]);
  const given = ['/uploads'];
  assert.equal(withSessionTmp(given, {}), given);
});

test('the session temporary directory patch is valid ESM and rejects drift or double application', () => {
  const checked = spawnSync(process.execPath, ['--check', '--input-type=module'], { input: patched, encoding: 'utf8' });
  assert.equal(checked.status, 0, checked.stderr);
  assert.throws(() => writableCodexSessionTmp(bundle.replace('addAdditionalDirectoriesToSandboxPolicy(agentMode.sandboxPolicy, additionalDirectories)', 'changed()')), /no longer matches/);
  assert.throws(() => writableCodexSessionTmp(bundle.replace('mergeSandboxWorkspaceWriteRoots(mergedConfig, additionalDirectories)', 'changed()')), /no longer matches/);
  assert.throws(() => writableCodexSessionTmp(patched), /no longer matches/);
});
