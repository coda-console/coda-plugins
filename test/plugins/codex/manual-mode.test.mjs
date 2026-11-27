import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { contributionProblem, manifestProblem, SCHEMAS } from '@coda-console/protocol/validate';
import vm from 'node:vm';
import { manualCodexApproval } from '../../../plugins/codex/agent/manual-mode.mjs';
import { networkedCodexDevelopment } from '../../../plugins/codex/agent/network.mjs';
import { pluginDir, resolveFrom } from '../plugin.mjs';

const bundle = await readFile(resolveFrom('codex', '@agentclientprotocol/codex-acp'), 'utf8');

test('the patch adds `manual` to the adapter\'s one mode table, beside the modes it had, and the network patch leaves it closed', () => {
  const source = networkedCodexDevelopment(manualCodexApproval(bundle));
  const start = source.indexOf('// src/AgentMode.ts'), end = source.indexOf('// src/CodexAcpClient.ts', start);
  const { AgentMode } = vm.runInNewContext(`${source.slice(start, end)}\n({ AgentMode })`, { process: { env: {} } });
  const modes = JSON.parse(JSON.stringify(AgentMode.all()));
  assert.deepEqual(modes.map(mode => mode.id), ['manual', 'read-only', 'agent', 'agent-full-access']);
  const [manual] = modes;
  assert.deepEqual([manual.approvalPolicy, manual.approvalsReviewer, manual.sandboxMode], ['untrusted', 'user', 'workspace-write']);
  assert.deepEqual(manual.sandboxPolicy, { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false });
  assert.equal(AgentMode.find('manual').id, 'manual');
  assert.equal(modes.filter(mode => mode.sandboxPolicy.networkAccess).map(mode => mode.id).join(), 'agent');
});

test('the manual mode patch rejects an incompatible or already patched adapter', () => {
  assert.throws(() => manualCodexApproval(bundle.replace('static DEFAULT_AGENT_MODE = _AgentMode.Agent;', 'static DEFAULT_AGENT_MODE = null;')), /no longer matches/);
  assert.throws(() => manualCodexApproval(bundle.replace('_AgentMode.ReadOnly, _AgentMode.Agent,', '_AgentMode.Agent,')), /no longer matches/);
  assert.throws(() => manualCodexApproval(manualCodexApproval(bundle)), /no longer matches/);
});

test('the manifest declares the four approval tiers the adapter has, as the protocol checks them', async () => {
  const dir = pluginDir('codex'), manifest = JSON.parse(await readFile(`${dir}/package.json`, 'utf8'));
  assert.equal(manifestProblem(manifest, dir), null);
  assert.equal(contributionProblem(SCHEMAS['agents.json'], manifest, 'agents', dir), null);
  const { modes } = manifest.contributes.agents[0];
  assert.deepEqual([modes.manual, modes.auto, modes.full, modes.safe, modes.default], ['manual', 'agent', 'agent-full-access', [], 'full']);
});
