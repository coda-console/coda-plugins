// A private connection to the Codex CLI's app-server, as this machine's Codex sessions are signed in: the plugin's own CLI
// (its `@openai/codex` dependency, the one codex-acp runs) in its own home (`CODEX_HOME`, or ~/.codex).
// Codex reads and renews that login itself; nothing of it passes through here, unless a login is handed to it (the account
// bridge, agent/accounts.mjs, which also takes what Codex says and asks of its client: `onMessage`). With「多账号」on, a managed
// account's own home is given as `env` and `cwd`, and `args` add to `app-server` (scripts/codex.mjs).
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readLines } from '../agent/lines.mjs';

// The plugin's own Codex CLI.
export const codexCli = () => fileURLToPath(import.meta.resolve('@openai/codex/bin/codex.js'));

export class AppServer {
  constructor({ env = process.env, cwd, args = [], command = [process.execPath, codexCli(), 'app-server', ...args],
    timeoutMs = 15_000, onMessage = null } = {}) {
    this.pending = new Map(); this.next = 0; this.timeoutMs = timeoutMs; this.onMessage = onMessage;
    this.child = spawn(command[0], command.slice(1), { env, cwd, stdio: ['pipe', 'pipe', 'ignore'] });
    this.child.stdin.on('error', () => {});
    readLines(this.child.stdout).on('line', line => {
      let message; try { message = JSON.parse(line); } catch { return; }
      const waiter = message.method ? null : this.pending.get(message.id);
      if (!waiter) {
        if (this.onMessage) return this.onMessage(message);
        // Codex asking for something of its client (new tokens for a login it was handed): this one has none to give.
        if (message.id !== undefined && message.method) this.send({ id: message.id, error: { code: -32601, message: 'not supported' } });
        return;
      }
      this.pending.delete(message.id); clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(oneLine(message.error.message) || 'Codex 拒绝了请求'));
      else waiter.resolve(message.result);
    });
    // Resolves how it ended: `{ code, signal }` as the process exited, or, if it could not be started at all (no such
    // command), `{ code: 1, signal: null, error }`.
    this.exited = new Promise(resolve => {
      const done = result => {
        for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('Codex 提前退出了')); }
        this.pending.clear(); resolve(result);
      };
      this.child.once('error', error => done({ code: 1, signal: null, error }));
      this.child.once('exit', (code, signal) => done({ code, signal }));
    });
  }
  send(message) { this.child.stdin.write(`${JSON.stringify(message)}\n`); }
  request(method, params = {}) {
    const id = `coda-${process.pid}-${++this.next}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Codex 没有答复')); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }
  async initialize() {
    await this.request('initialize', { clientInfo: { name: 'coda_panel', version: '1' }, capabilities: { experimentalApi: true } });
    this.send({ method: 'initialized' });
  }
  async close() {
    this.child.kill('SIGTERM');
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 2000);
    await this.exited; clearTimeout(timer);
  }
}
const oneLine = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 200) : '';

// Runs `work` against a started app-server, which is always ended after.
export async function withAppServer(work, options) {
  const server = new AppServer(options);
  try { await server.initialize(); return await work(server); }
  finally { await server.close(); }
}
