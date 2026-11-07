// This plugin owns its accounts. Each has a Codex home below CODA_PLUGIN_STATE; Codex performs OAuth and renews its
// auth.json there. Only access tokens cross the account-source pipe. No external account manager or Python is needed.
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import { withAccountHome } from './codex.mjs';

const ID = /^[a-f0-9]{64}$/;
export const identity = account => createHash('sha256').update(account).digest('hex');
export const paths = (env = process.env) => {
  if (!env.CODA_PLUGIN_STATE) throw new Error('Coda 没有提供插件状态目录');
  return { state: env.CODA_PLUGIN_STATE, native: env.CODEX_HOME || join(homedir(), '.codex'), env };
};
const unavailable = '账号登录已失效，请在「Codex 多账号」重新登录该账号';
const missing = '此账号尚未在插件中登录，请在「Codex 多账号」重新登录';
function privateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) throw new Error('账号目录不可用');
  chmodSync(dir, 0o700);
}
export function prepare(at = paths()) {
  privateDir(at.state); privateDir(join(at.state, 'accounts')); privateDir(join(at.state, 'locks'));
}
function readJSON(file) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error('账号文件不可用');
  return JSON.parse(readFileSync(file, 'utf8'));
}
function writeJSON(file, value) {
  const temp = `${file}.${randomUUID()}`;
  try { writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx', flush: true }); renameSync(temp, file); }
  finally { rmSync(temp, { force: true }); }
}
// All credential writers take the same per-account lock, including quota reads (Codex may refresh during them).
// Index changes take the store lock first. Locks have a heartbeat and recover after an abruptly ended process.
async function locked(key, at, work) {
  prepare(at);
  let release;
  try { release = await lockfile.lock(join(at.state, 'locks', key), { realpath: false, stale: 10_000,
    retries: { retries: 20, minTimeout: 100, maxTimeout: 150, factor: 1 } }); }
  catch { throw new Error('账号正在更新，请稍后重试'); }
  try { return await work(); } finally { await release(); }
}
function stored(at) {
  try {
    const value = readJSON(join(at.state, 'accounts.json'));
    if (value.version !== 1 || !Array.isArray(value.accounts) || value.accounts.some(a => !ID.test(a?.identity) || typeof a.alias !== 'string')) throw Error();
    return value.accounts;
  } catch (error) { if (error.code === 'ENOENT') return null; throw new Error('读不了插件保存的账号列表'); }
}
// Import the existing Codex login once, as an ordinary managed account. A store, even an empty one, records that this
// has happened: removing the imported account must not make it reappear on the next reading.
export async function list(at = paths(), { recoverImport = false } = {}) {
  const known = stored(at);
  if (known !== null) return known;
  return locked('store', at, async () => {
    const existing = stored(at);
    if (existing !== null) return existing;
    const accounts = [];
    let login;
    try {
      const auth = readJSON(join(at.native, 'auth.json'));
      if (auth?.tokens?.access_token && auth.tokens.refresh_token) login = readAuth(at.native);
    } catch (error) {
      if (error.code !== 'ENOENT' && !recoverImport) throw new Error('无法导入已有 Codex 登录，请从「添加资源」登录 Codex 多账号');
    }
    if (login) {
      const id = identity(login.tokens.chatgptAccountId);
      let email;
      try { email = JSON.parse(Buffer.from(login.auth.tokens.id_token.split('.')[1], 'base64url').toString('utf8')).email; } catch {}
      const home = join(at.state, 'accounts', id);
      privateDir(home); writeJSON(join(home, 'auth.json'), login.auth);
      accounts.push({ identity: id, alias: typeof email === 'string' && email ? email : `账号 ${id.slice(0, 8)}`, plan: login.tokens.chatgptPlanType ?? null });
    }
    const chosen = selection(at);
    // The old plugin's "native" choice becomes the imported identity, not a second kind of account.
    if (chosen === null || chosen === 'native') writeJSON(join(at.state, 'selection.json'), { account: accounts[0]?.identity ?? null });
    writeJSON(join(at.state, 'accounts.json'), { version: 1, accounts });
    return accounts;
  });
}
export function selection(at = paths()) {
  try {
    const selected = readJSON(join(at.state, 'selection.json')).account ?? null;
    if (selected !== null && selected !== 'native' && !ID.test(selected)) throw Error();
    return selected;
  } catch (error) { if (error.code === 'ENOENT') return null; throw new Error('读不了所选的账号'); }
}
export async function choose(account, at = paths()) {
  await list(at);
  return locked('store', at, async () => {
    if (!(await list(at)).some(a => a.identity === account)) throw new Error(missing);
    writeJSON(join(at.state, 'selection.json'), { account });
  });
}
function homeFor(account, at) {
  if (!ID.test(account)) throw new Error(missing);
  const home = join(at.state, 'accounts', account);
  try { if (!lstatSync(home).isDirectory() || lstatSync(home).isSymbolicLink()) throw Error(); }
  catch { throw new Error(missing); }
  return home;
}
export function readAuth(home, expected) {
  try {
    const auth = readJSON(join(home, 'auth.json')), accessToken = auth.tokens.access_token;
    const claims = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString('utf8'));
    const info = claims['https://api.openai.com/auth'], chatgptAccountId = info.chatgpt_account_id;
    if (typeof chatgptAccountId !== 'string' || !chatgptAccountId || !Number.isFinite(claims.exp)
      || (expected && identity(chatgptAccountId) !== expected)
      || (auth.tokens.account_id && auth.tokens.account_id !== chatgptAccountId)) throw Error();
    return { auth, expires: claims.exp * 1000, tokens: { accessToken, chatgptAccountId,
      ...(typeof info.chatgpt_plan_type === 'string' ? { chatgptPlanType: info.chatgpt_plan_type } : {}) } };
  } catch { throw new Error(unavailable); }
}
async function checked(server, expected, refreshToken = false) {
  const result = await server.request('account/read', { refreshToken });
  if (result.account?.type !== 'chatgpt' || identity(result.workspaceRouting?.chatgptAccountId ?? '') !== expected) throw new Error('Codex 登录后的账号与所选的不符');
  return result.account;
}
// Quota/reset requests use this account's managed login, so Codex itself handles a 401 and persists renewed tokens.
export async function withManagedAccount(account, work, at = paths(), options) {
  if (!(await list(at)).some(a => a.identity === account)) throw new Error(missing);
  return locked(account, at, async () => {
    const home = homeFor(account, at);
    readAuth(home, account);
    return withAccountHome(home, async server => { await checked(server, account); return work(server); }, { env: at.env, ...options });
  });
}
// Refresh only when needed or explicitly requested after a rejected access token. Recheck under the lock so concurrent
// sessions do not refresh the same rotating refresh token at once. The full auth document never leaves this module.
export async function tokens(account, at = paths(), { refresh = false, ...options } = {}) {
  if (!(await list(at)).some(a => a.identity === account)) throw new Error(missing);
  return locked(account, at, async () => {
    const home = homeFor(account, at), expected = account;
    let current = readAuth(home, expected);
    if (refresh || current.expires <= Date.now() + 60_000) {
      try {
        await withAccountHome(home, server => checked(server, identity(current.tokens.chatgptAccountId), true), { env: at.env, ...options });
        current = readAuth(home, expected);
      } catch { throw new Error(unavailable); }
    }
    if (current.expires <= Date.now() + 30_000) throw new Error(unavailable);
    return current.tokens;
  });
}
// Commit a completed device login. Logging in to an existing identity replaces its credentials; other accounts and
// their selection stay intact. Only the first account is selected automatically, unless a choice was already saved.
export async function saveLogin(home, at = paths(), { isCancelled = () => false, ...options } = {}) {
  await list(at);
  const initial = readAuth(home), id = identity(initial.tokens.chatgptAccountId);
  if (initial.expires <= Date.now() + 30_000 || !initial.auth.tokens.refresh_token) throw new Error(unavailable);
  const account = await withAccountHome(home, server => checked(server, id), { env: at.env, ...options });
  return locked('store', at, () => locked(id, at, async () => {
    const accounts = await list(at), previous = accounts.find(a => a.identity === id);
    if (isCancelled()) throw new Error('登录已取消');
    const record = { identity: id, alias: account.email || previous?.alias || `账号 ${id.slice(0, 8)}`, plan: account.planType ?? null };
    const target = join(at.state, 'accounts', id);
    privateDir(target);
    writeJSON(join(target, 'auth.json'), readAuth(home, id).auth);
    writeJSON(join(at.state, 'accounts.json'), { version: 1, accounts: previous ? accounts.map(a => a.identity === id ? record : a) : [...accounts, record] });
    if (!accounts.length && selection(at) === null) writeJSON(join(at.state, 'selection.json'), { account: id });
    return record;
  }));
}
export async function remove(account, at = paths()) {
  if (!ID.test(account)) throw new Error('没有指明要移除的账号');
  await list(at);
  return locked('store', at, () => locked(account, at, async () => {
    const accounts = await list(at);
    if (!accounts.some(a => a.identity === account)) throw new Error(missing);
    const home = join(at.state, 'accounts', account);
    // Remove secrets before the index: a failed removal remains visible and can be retried.
    rmSync(home, { recursive: true, force: true });
    if (selection(at) === account) writeJSON(join(at.state, 'selection.json'), { account: null });
    writeJSON(join(at.state, 'accounts.json'), { version: 1, accounts: accounts.filter(a => a.identity !== account) });
  }));
}
