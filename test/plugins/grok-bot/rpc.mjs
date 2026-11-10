import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

// Newline JSON-RPC, shared by ACP and the local MCP client. Requests are concurrent:
// a prompt must not block remote replies or cancellation on the same connection.
export class Rpc {
  constructor(input, output, handle = async () => { throw Object.assign(new Error('Method not found'), { code: -32601 }); }) {
    this.output = output;
    this.pending = new Map();
    this.lines = createInterface({ input });
    this.lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (!message || typeof message !== 'object') return;
      if (!message.method) {
        const pending = this.pending.get(message.id);
        if (pending) message.error ? pending.reject(Object.assign(new Error(message.error.message), { code: message.error.code })) : pending.resolve(message.result);
      } else {
        Promise.resolve().then(() => handle(message.method, message.params ?? {})).then(
          result => { if (message.id !== undefined) this.send({ id: message.id, result }); },
          error => { if (message.id !== undefined) this.send({ id: message.id, error: { code: error.code ?? -32603, message: error.message } }); },
        );
      }
    });
    this.lines.on('close', () => this.close());
    output.on('error', () => this.close());
  }
  send(message) { if (!this.closed) this.output.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`); }
  notify(method, params) { this.send({ method, params }); }
  request(method, params, { signal } = {}) {
    if (this.closed) return Promise.reject(new Error('RPC connection closed'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const finish = fn => value => { this.pending.delete(id); signal?.removeEventListener('abort', abort); fn(value); };
      const abort = () => {
        this.notify(method === 'session/request_permission' ? '$/cancel_request' : 'notifications/cancelled',
          method === 'session/request_permission' ? { requestId: id } : { requestId: id, reason: 'Turn ended' });
        this.pending.get(id)?.reject(new Error('Turn ended'));
      };
      this.pending.set(id, { resolve: finish(resolve), reject: finish(reject) });
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener('abort', abort, { once: true });
      this.send({ id, method, params });
    });
  }
  close() {
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(new Error('RPC connection closed'));
  }
}
