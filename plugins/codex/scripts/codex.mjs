// Managed Codex homes and isolated checks that external tokens select the same identity as a session would use.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppServer } from './app-server.mjs';

// Account operations never inherit a different account from API-key/token environment variables.
export function accountEnv(home, env = process.env) {
  const result = { ...env, CODEX_HOME: home, NO_COLOR: '1' };
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN']) delete result[key];
  return result;
}
export const fileCredentials = ['-c', 'cli_auth_credentials_store="file"'];
export async function withAccountHome(home, work, { env = process.env, makeServer = options => new AppServer(options) } = {}) {
  const server = makeServer({ env: accountEnv(home, env), cwd: home, args: fileCredentials, timeoutMs: 6000 });
  try { await server.initialize(); return await work(server); }
  finally { await server.close(); }
}

export async function withAccount(tokens, work, { makeServer = options => new AppServer(options) } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'coda-codex-account-'));
  const server = makeServer({ env: accountEnv(home), cwd: home, args: fileCredentials });
  try {
    await server.initialize();
    await server.request('account/login/start', { type: 'chatgptAuthTokens', ...tokens });
    const { account, workspaceRouting } = await server.request('account/read', { refreshToken: false });
    if (account?.type !== 'chatgpt' || workspaceRouting?.chatgptAccountId !== tokens.chatgptAccountId) throw new Error('Codex 登录后的账号与所选的不符');
    return await work(server);
  } finally { await server.close(); await rm(home, { recursive: true, force: true }); }
}
