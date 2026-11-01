import { isAbsolute, sep } from 'node:path';

// ACP is the trusted host boundary: Coda reserves the server name `coda` and supplies this stdio shim itself
// (backend/src/components/session-config/service.mjs). Do not infer trust from a Codex config entry of the same name.
// The shape check limits the exception to the current Coda transport, not arbitrary HTTP or plugin MCP servers.
export function codaMcpPolicy(server, config) {
  const args = config.args;
  if (server.name !== 'coda' || 'type' in server || config.command !== process.execPath ||
      !Array.isArray(args) || args.length !== 5 || typeof args[0] !== 'string' || !isAbsolute(args[0]) ||
      !args[0].endsWith(`${sep}src${sep}adapters${sep}mcp-shim.mjs`) ||
      args[1] !== '--thread' || typeof args[2] !== 'string' || !args[2] ||
      args[3] !== '--socket' || typeof args[4] !== 'string' || !isAbsolute(args[4])) return config;
  // All tools of Coda's own server, including workflow_run/approve-command, must reach Coda's permission boundary.
  // This approves the MCP request, not the command or human decision it asks Coda to handle.
  return { ...config, default_tools_approval_mode: 'approve' };
}

const before = '      "mcp_servers": Object.fromEntries(serversToConfigure.map((mcp) => [mcp.name, this.createMcpSeverConfig(mcp.server)]))';
export function trustedCodaMcpRequests(source) {
  if (source.split(before).length !== 2) throw new Error('codex-acp MCP approval patch no longer matches the locked adapter');
  // Apply after codex-acp's name deduplication: a native configured server it selected keeps its own policy.
  return `import { codaMcpPolicy } from ${JSON.stringify(import.meta.url)};\n${source.replace(/^#![^\n]*\n/, '').replace(before,
    '      "mcp_servers": Object.fromEntries(serversToConfigure.map((mcp) => [mcp.name, codaMcpPolicy(mcp.server, this.createMcpSeverConfig(mcp.server))]))')}`;
}
