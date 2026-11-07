// A private connection to the Codex CLI's app-server (a copy of the codex plugin's scripts/app-server.mjs: a plugin uses
// nothing of another's but what it plugs into). Used for a managed account's home and isolated token checks.
// The CLI is the codex plugin's (its `@openai/codex` dependency, found from its directory in `CODA_PLUGIN_DEPENDENCIES`), so
// the resources ask the same Codex the sessions run.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { readLines } from './lines.mjs';

export const codexCli = (env = process.env) =>
  createRequire(join(JSON.parse(env.CODA_PLUGIN_DEPENDENCIES || '{}').codex ?? '', 'package.json')).resolve('@openai/codex/bin/codex.js');

export class AppServer {
  constructor({ env = process.env, cwd, args = [], command = [process.execPath, codexCli(env), 'app-server', ...args],
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
    this.exited = new Promise(resolve => {
      const done = () => {
        for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('Codex 提前退出了')); }
        this.pending.clear(); resolve();
      };
      this.child.once('error', done); this.child.once('exit', done);
    });
  }
  send(message) { this.child.stdin.write(`${JSON.stringify(message)}\n`); }
  request(method, params = {}) {
    const id = `coda-accounts-${process.pid}-${++this.next}`;
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
