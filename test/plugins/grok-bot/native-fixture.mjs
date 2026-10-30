import { envelope } from '../../../plugins/grok-bot/agent/native.mjs';
import { mailbox } from './helpers.mjs';
export class FakeNative {
  constructor() { this.requests = []; this.calls = mailbox(); this.connections = []; this.entries = []; this.polls = 0; this.pollAnswers = [404, { accessToken: 'fixture-access' }]; }
  fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (path === '/auth/poll') {
      this.polls++;
      const answer = this.pollAnswers.shift() ?? 404;
      this.calls.push({ method: 'poll' });
      return typeof answer === 'number' ? new Response('{}', { status: answer }) : Response.json(answer);
    }
    const method = path.split('/').at(-1);
    const stream = options.headers?.['content-type'] === 'application/connect+json';
    const params = JSON.parse(stream ? options.body.subarray(5) : options.body);
    const request = { method, params, headers: options.headers }; this.requests.push(request); this.calls.push(request);
    if (this.handler) { const result = await this.handler(method, params); if (result) return result; }
    if (method === 'ListGrokBotSubagents') return Response.json({ subagents: this.subagents ?? [] });
    if (method === 'ListGrokBotAgentAutomations') return Response.json({ automations: this.automations ?? [] });
    if (method === 'ListGrokBotAgents') return Response.json({ agents: [{ agentId: 'inspector', name: '巡检' }] });
    if (method === 'ListGrokBotTranscriptEntries') return Response.json({ generation: this.generation ?? 0, entries: [...this.entries].filter(e => !params.beforeSeq || BigInt(e.seq) < BigInt(params.beforeSeq)).reverse().slice(0, params.limit) });
    if (method === 'WatchGrokBotTranscripts') {
      let controller;
      const body = new ReadableStream({ start(c) { controller = c; } });
      const connection = { controller, closed: false };
      this.connections.push(connection);
      options.signal.addEventListener('abort', () => { if (!connection.closed) { connection.closed = true; controller.error(new Error('Stopped')); } }, { once: true });
      controller.enqueue(envelope({ connected: {} }));
      return new Response(body);
    }
    if (method === 'SendGrokBotUserMessage') return Response.json({ dispatched: true });
    if (method === 'InterruptGrokBotAgentRun') return Response.json({ hadActiveRun: true });
    if (method === 'RespondGrokBotWidget') return Response.json({ accepted: true });
    throw new Error(`Unexpected fake request: ${method}`);
  };
  emit(event) { this.connections.at(-1).controller.enqueue(envelope(event)); }
  end() { const connection = this.connections.at(-1); connection.closed = true; const frame = envelope({}); frame[0] = 2; connection.controller.enqueue(frame); connection.controller.close(); }
  drop() { const connection = this.connections.at(-1); connection.closed = true; connection.controller.error(new Error('connection dropped')); }
  row(id, body, seq = this.entries.length + 1) {
    const row = { entryId: id, entryKind: body.kind, seq: String(seq), updatedSeq: String(seq), body: Buffer.from(JSON.stringify({ timestampMs: Date.now() + 10000, ...body })).toString('base64') };
    this.entries = [...this.entries.filter(e => e.entryId !== id), row];
    return { rows: { agentId: 'inspector', sessionId: '', entries: [row] } };
  }
  async next(method) { for (;;) { const r = await this.calls.next(); if (r.method === method) return r; } }
}
