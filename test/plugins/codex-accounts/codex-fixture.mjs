// A Codex CLI for lifecycle tests. Credentials stay in fixture auth.json files; its event log contains no tokens.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createInterface } from 'node:readline';

const home = process.env.CODEX_HOME, authFile = join(home, 'auth.json');
const log = value => appendFileSync(process.env.FAKE_LOG, JSON.stringify({ ...value, home, cwd: process.cwd() }) + '\n');
const jwt = data => `x.${Buffer.from(JSON.stringify(data)).toString('base64url')}.x`;
const auth = (account, version = '1') => ({ auth_mode: 'chatgpt', last_refresh: new Date().toISOString(), tokens: {
  id_token: jwt({ email: `${account}@example.com` }),
  access_token: jwt({ exp: Date.now() / 1000 + 3600, version, 'https://api.openai.com/auth': { chatgpt_account_id: account, chatgpt_plan_type: 'pro' } }),
  refresh_token: `PRIVATE-REFRESH-${account}-${version}`, account_id: account,
} });
const read = () => { try { return JSON.parse(readFileSync(authFile, 'utf8')); } catch { return null; } };
const fromToken = value => { try { return JSON.parse(Buffer.from(value.split('.')[1], 'base64url').toString())['https://api.openai.com/auth']; } catch { return null; } };
log({ mode: process.argv[2], args: process.argv.slice(2), inheritedCredentials: !!(process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY || process.env.CODEX_ACCESS_TOKEN) });
if (process.argv[2] === 'login') {
  // Saying nothing of a link, as a login stuck on the network does, until it is ended.
  if (process.env.FAKE_SILENT) { console.log('Contacting OpenAI...'); await delay(60_000); }
  process.stdout.write('Open https://auth.openai.com/codex/device\n\nABCD-12345\n');
  if (process.env.FAKE_CONFIRM) while (!existsSync(process.env.FAKE_CONFIRM)) await delay(10);
  if (process.env.FAKE_LOGIN_FAIL) process.exit(1);
  writeFileSync(authFile, JSON.stringify(auth(process.env.FAKE_ACCOUNT ?? 'first', process.env.FAKE_TOKEN_VERSION)), { mode: 0o600 });
  process.exit(0);
}
let external = null;
for await (const line of createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  log({ method: m.method, refresh: m.params?.refreshToken, account: m.params?.chatgptAccountId, credit: m.params?.creditId });
  if (m.id === undefined || !m.method) continue;
  if (m.method === 'account/login/start') external = fromToken(m.params.accessToken);
  if (m.method === 'account/read' && m.params?.refreshToken && !external) {
    if (process.env.FAKE_REFRESH_DELAY) await delay(Number(process.env.FAKE_REFRESH_DELAY));
    if (process.env.FAKE_REFRESH_FAIL) { process.stdout.write(JSON.stringify({ id: m.id, error: { message: 'PRIVATE-REFRESH-ERROR' } }) + '\n'); continue; }
    const current = read(), account = current?.tokens.account_id;
    if (account) writeFileSync(authFile, JSON.stringify(auth(process.env.FAKE_REFRESH_ACCOUNT ?? account, 'renewed')), { mode: 0o600 });
  }
  const current = external ?? fromToken(read()?.tokens.access_token), accountId = current?.chatgpt_account_id;
  const result = m.method === 'account/read' ? { account: accountId ? { type: 'chatgpt', email: `${accountId}@example.com`, planType: 'pro' } : null,
    workspaceRouting: { chatgptAccountId: process.env.FAKE_REFUSE ? 'someone-else' : accountId } }
    : m.method === 'account/rateLimits/read' ? { rateLimits: { primary: { usedPercent: 50, windowDurationMins: 300 } } }
    : m.method === 'account/rateLimitResetCredit/consume' ? { outcome: 'reset' }
    : m.method === 'turn/start' ? { turn: { id: 't1' } } : {};
  process.stdout.write(JSON.stringify({ id: m.id, result }) + '\n');
}
