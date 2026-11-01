// Exercise the locked adapter's actual config builder and the locked CLI's parser, below the Coda backend.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { codaMcpPolicy, trustedCodaMcpRequests } from '../../../plugins/codex/agent/mcp-policy.mjs';
import { pluginDir, resolveFrom } from '../plugin.mjs';

const bundle = readFileSync(resolveFrom('codex', '@agentclientprotocol/codex-acp'), 'utf8');
const patched = trustedCodaMcpRequests(bundle);
const coda = () => ({ name: 'coda', command: process.execPath, env: [], args: [
  join(tmpdir(), 'coda-runtime', 'src/adapters/mcp-shim.mjs'), '--thread', 'fixture-thread', '--socket', join(tmpdir(), 'coda.sock')
] });
const plain = value => JSON.parse(JSON.stringify(value));
function owner(source, configuredNames = []) {
  const method = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
  const methods = method('  async createSessionConfig(projectPath, additionalDirectories, mcpServers) {', '  async getConfigMcpServerNames(') + ',\n' +
    method('  createMcpSeverConfig(mcpServer) {', '  /**\n   * Resolves a ModelId');
  return Object.assign(vm.runInNewContext(`({ ${methods} })`, {
    codaMcpPolicy, logger: { log() {} }, forceGitRootTurnDiffPaths: config => config, mergeGatewayConfig: config => config,
    mergeSandboxWorkspaceWriteRoots: config => config, sanitizeMcpServerName: name => name.replace(/\s/g, '_'),
    shouldDeduplicateMcpConflicts: () => true, RequestError: { invalidRequest: message => new Error(message) }
  }), { config: { approval_policy: 'on-request', approvals_reviewer: 'auto_review', sandbox_mode: 'workspace-write' }, gatewayConfig: null,
    getNativeProviderConfig: () => ({}), getModelProvider: () => 'fixture', getConfigMcpServerNames: async () => new Set(configuredNames) });
}

test('Coda MCP tools reach Coda in auto-review mode without changing the session or other servers', async () => {
  const peers = [coda(), { name: 'docs', type: 'http', url: 'https://example.test/mcp', headers: [{ name: 'X-Fixture', value: 'value' }] }];
  const original = plain(await owner(bundle).createSessionConfig('/tmp/project', [], peers));
  const actual = plain(await owner(patched).createSessionConfig('/tmp/project', [], peers));
  assert.equal(actual.mcp_servers.coda.default_tools_approval_mode, 'approve');
  delete actual.mcp_servers.coda.default_tools_approval_mode;
  assert.deepEqual(actual, original);
});

test('a name alone, a different transport, command or shim, and malformed arguments grant no exception', async () => {
  const real = coda();
  const fixtures = [
    { ...real, name: 'other' }, { ...real, name: ' coda' },
    { name: 'coda', type: 'http', url: 'https://example.test/mcp', headers: [] },
    { ...real, command: '/tmp/other-node' }, { ...real, args: ['/tmp/mcp-shim.mjs', ...real.args.slice(1)] },
    { ...real, args: ['src/adapters/mcp-shim.mjs', ...real.args.slice(1)] },
    { ...real, args: [...real.args, '--extra'] }, { ...real, args: real.args.slice(0, 4) },
    { ...real, args: [real.args[0], '--thread', '', '--socket', real.args[4]] },
    { ...real, args: [real.args[0], '--thread', 'thread', '--socket', 'relative.sock'] }
  ];
  for (const server of fixtures) assert.deepEqual(plain(await owner(patched).createSessionConfig('/tmp/project', [], [server])),
    plain(await owner(bundle).createSessionConfig('/tmp/project', [], [server])));
});

test('native configured coda selected by deduplication retains its own approval policy', async () => {
  const configured = { coda: { command: 'other-server', default_tools_approval_mode: 'auto', tools: { workflow_run: { approval_mode: 'prompt' } } } };
  for (const peers of [[], [coda()], [coda(), { name: 'docs', command: 'docs', args: [], env: [] }]]) {
    const get = source => { const value = owner(source, ['coda']); value.config.mcp_servers = configured; return value; };
    assert.deepEqual(plain(await get(patched).createSessionConfig('/tmp/project', [], peers)),
      plain(await get(bundle).createSessionConfig('/tmp/project', [], peers)));
  }
});

test('the pinned CLI parses the server approval mode and rejects an invalid value', t => {
  const root = mkdtempSync(join(tmpdir(), 'coda-codex-mcp-policy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cli = join(pluginDir('codex'), 'node_modules/.bin/codex');
  const inspect = mode => spawnSync(cli, ['mcp', 'get', 'coda', '--json', '-c', 'mcp_servers.coda.command="node"',
    '-c', `mcp_servers.coda.default_tools_approval_mode="${mode}"`], { encoding: 'utf8', env: { ...process.env, CODEX_HOME: root }, timeout: 10000 });
  const approved = inspect('approve');
  assert.equal(approved.status, 0, approved.stderr);
  assert.equal(JSON.parse(approved.stdout).name, 'coda');
  const invalid = inspect('unknown-mode');
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /unknown variant `unknown-mode`/);
  assert.match(invalid.stderr, /default_tools_approval_mode/);
});

test('the policy patch is valid ESM and rejects drift or double application', () => {
  const checked = spawnSync(process.execPath, ['--check', '--input-type=module'], { input: patched, encoding: 'utf8' });
  assert.equal(checked.status, 0, checked.stderr);
  assert.throws(() => trustedCodaMcpRequests(bundle.replace('this.createMcpSeverConfig(mcp.server)', 'changed()')), /no longer matches/);
  assert.throws(() => trustedCodaMcpRequests(patched), /no longer matches/);
});
