// The account source another plugin plugs into Codex (the `account-source` extension point, docs/plugins.md「内置插件：Codex」):
// its command, started once and asked over its standard input and output, one JSON object a line.
//   → { "id": 1, "method": "selected" }                       ← { "id": 1, "result": { "account": { "id", "name" } | null } }
//   → { "id": 2, "method": "tokens", "params": { "account", "refresh"? } } ← { "id": 2, "result": { "accessToken", "chatgptAccountId", "chatgptPlanType" } }
// `refresh: true` asks the owner to renew a rejected access token, even before its expiry.
// Either may answer `{ "id", "error": { "message" } }`. A source taking full ownership reports an error until an account
// is chosen; a legacy source's `null` leaves the underlying login as it is. A source that ends is started again when asked.
// An installed source owns the account's resources and handles `--login` for Codex's existing login entry.
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { readLines } from './lines.mjs';

// What Coda hands this plugin's processes of the plugins plugged into its points (CODA_PLUGIN_EXTENSIONS): the first source.
export function accountSource(env = process.env) {
  let points; try { points = JSON.parse(env.CODA_PLUGIN_EXTENSIONS || '{}'); } catch { return null; }
  return points?.['account-source']?.[0] ?? null;
}

export function sourceEnv(source, env = process.env) {
  return { ...env, CODA_PLUGIN_PATH: source.path, ...(source.state ? { CODA_PLUGIN_STATE: source.state } : {}),
    CODA_PLUGIN_DEPENDENCIES: JSON.stringify({ codex: env.CODA_PLUGIN_PATH }),
    PATH: [dirname(process.execPath), env.PATH].filter(Boolean).join(':') };
}

export class AccountSource {
  constructor(source, { env = process.env, timeoutMs = 10_000 } = {}) {
    this.source = source; this.env = env; this.timeoutMs = timeoutMs; this.next = 0; this.pending = new Map(); this.child = null; this.closed = false;
  }
  start() {
    const { command } = this.source;
    // As a resource type's command is run (docs/plugins.md「资源」): its plugin's directory and state, and this Node first on the PATH.
    const child = spawn('/bin/sh', ['-c', command], { env: sourceEnv(this.source, this.env),
      stdio: ['pipe', 'pipe', 'ignore'] });
    child.stdin.on('error', () => {});
    readLines(child.stdout).on('line', line => {
      let message; try { message = JSON.parse(line); } catch { return; }
      const waiter = this.pending.get(message?.id);
      if (!waiter) return;
      this.pending.delete(message.id); clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(typeof message.error.message === 'string' && message.error.message.trim() ? message.error.message.trim().slice(0, 200) : '账号来源拒绝了请求'));
      else waiter.resolve(message.result ?? {});
    });
    const ended = () => {
      if (this.child === child) this.child = null;
      for (const [id, waiter] of this.pending) if (waiter.child === child) { clearTimeout(waiter.timer); this.pending.delete(id); waiter.reject(new Error('账号来源提前退出了')); }
    };
    child.once('error', ended); child.once('exit', ended);
    return child;
  }
  request(method, params) {
    if (this.closed) return Promise.reject(new Error('账号来源已关闭'));
    const child = this.child ??= this.start(), id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('账号来源没有答复')); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, child });
      child.stdin.write(`${JSON.stringify({ id, method, ...(params ? { params } : {}) })}\n`);
    });
  }
  async selected() {
    const { account } = await this.request('selected');
    if (account == null) return null;
    if (typeof account?.id !== 'string' || !account.id) throw new Error('账号来源给的账号无效');
    return { id: account.id, name: typeof account.name === 'string' && account.name ? account.name.slice(0, 80) : account.id };
  }
  async tokens(account, { refresh = false } = {}) {
    const tokens = await this.request('tokens', { account, ...(refresh ? { refresh: true } : {}) });
    if (typeof tokens.accessToken !== 'string' || typeof tokens.chatgptAccountId !== 'string') throw new Error('账号来源给的凭据不完整');
    return { accessToken: tokens.accessToken, chatgptAccountId: tokens.chatgptAccountId, ...(typeof tokens.chatgptPlanType === 'string' ? { chatgptPlanType: tokens.chatgptPlanType } : {}) };
  }
  close() { this.closed = true; this.child?.kill(); }
}
