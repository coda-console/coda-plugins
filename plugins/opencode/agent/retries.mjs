// A model service's wait OpenCode would sit out for longer than Coda waits. OpenCode waits as long as a provider's
// Retry-After says, up to 15 minutes a time and ten times (its model-retry.ts), and tells an ACP client: a
// `session_info_update` whose `_meta["opencode/retry"]` says when it tries again (`nextRetryAt`) and the service's error,
// a subagent's said on its child-update extension (or projected into the root without that capability). Coda ends a turn
// on an agent's failure and keeps why, and retries a service's failures itself over at most a minute (docs/agent-protocol.md「服务暂不可用」);
// so a wait longer than LONG_WAIT ends the turn here: the entry stops OpenCode's (`session/cancel`, which stops its
// foreground subagents too) and answers Coda's prompt with the service's reason, whatever OpenCode answers it with once
// stopped. A shorter wait is OpenCode's to sit out.
import { CHILD_UPDATE } from './children.mjs';
export const LONG_WAIT = 60_000;
const RETRY = 'opencode/retry';

const record = value => value && typeof value === 'object' && !Array.isArray(value);
const span = ms => Math.ceil(ms / 60_000) >= 60 ? `约 ${Math.round(ms / 3_600_000)} 小时` : `约 ${Math.ceil(ms / 60_000)} 分钟`;

export class LongRetries {
  // `cancel(sessionId)`: stops OpenCode's turn in an ACP session.
  constructor(cancel, now = Date.now) {
    this.cancel = cancel; this.now = now;
    // Coda's prompt under way in each session, by its id; the reason each prompt being stopped here ends with.
    this.prompts = new Map(); this.ending = new Map();
  }
  // What the entry tells OpenCode.
  toAgent(message) {
    if (message?.method === 'session/prompt' && 'id' in message && typeof message.params?.sessionId === 'string') this.prompts.set(message.params.sessionId, message.id);
  }
  // What OpenCode says, as said to Coda: its answer to a prompt stopped here is the reason it was.
  fromAgent(message) {
    if (!record(message)) return message;
    if (message.method === 'session/update') { this.updated(message.params); return message; }
    if (message.method === CHILD_UPDATE && message.params?.type === 'update') {
      this.updated({ sessionId: message.params.rootSessionId, update: message.params.update }); return message;
    }
    if (!('id' in message) || 'method' in message) return message;
    for (const [session, id] of this.prompts) if (id === message.id) this.prompts.delete(session);
    if (!this.ending.has(message.id)) return message;
    const reason = this.ending.get(message.id);
    this.ending.delete(message.id);
    return { jsonrpc: '2.0', id: message.id, error: { code: -32603, message: reason } };
  }
  updated(params) {
    const update = record(params?.update) && params.update.sessionUpdate === 'session_info_update' ? params.update : null;
    const retry = record(update?._meta) ? update._meta[RETRY] : null;
    if (!record(retry) || typeof retry.nextRetryAt !== 'string' || !this.prompts.has(params.sessionId)) return;
    const wait = Date.parse(retry.nextRetryAt) - this.now(), id = this.prompts.get(params.sessionId);
    if (!(wait > LONG_WAIT) || this.ending.has(id)) return;
    const said = typeof retry.error?.message === 'string' ? retry.error.message.trim() : '';
    this.ending.set(id, `${said || '模型服务要求稍后再试'}\n\nOpenCode 要等${span(wait)}才会重试，这一轮先结束。`);
    this.cancel(params.sessionId);
  }
}
