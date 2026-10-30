import { spawn } from 'node:child_process';
import { Rpc } from './rpc.mjs';

export class CodaMcp {
  constructor(server, cwd) { this.server = server; this.cwd = cwd; }
  async connect() {
    if (this.ready) return this.ready;
    if (!this.server || this.server.type && this.server.type !== 'stdio') throw new Error('会话没有 coda stdio MCP 服务');
    const { command, args = [], env = [] } = this.server;
    this.child = spawn(command, args, { cwd: this.cwd, env: { ...process.env, ...Object.fromEntries(env.map(({ name, value }) => [name, value])) }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.pipe(process.stderr);
    const rpc = this.rpc = new Rpc(this.child.stdout, this.child.stdin);
    const closed = () => { rpc.close(); if (this.rpc === rpc) this.ready = null; };
    this.child.on('error', closed);
    this.child.on('exit', closed);
    this.ready = rpc.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'grok-bot', version: '0.1.0' } },
      { signal: AbortSignal.timeout(30_000) }).then(() => rpc.notify('notifications/initialized', {}));
    return this.ready;
  }
  async call(name, args, signal = AbortSignal.timeout(60_000)) {
    await this.connect();
    return this.rpc.request('tools/call', { name, arguments: args }, { signal });
  }
  close() { this.rpc?.close(); this.child?.kill(); }
}
