// A model service's wait OpenCode would sit out for longer than Coda waits. OpenCode waits as long as a provider's
// Retry-After says, up to 15 minutes a time and ten times (its model-retry.ts), and tells an ACP client: a
// `session_info_update` whose `_meta["opencode/retry"]` says when it tries again (`nextRetryAt`) and the service's error,
// a subagent's said on its child-update extension (or projected into the root without that capability). Coda ends a turn
// on an agent's failure and keeps why, and retries a service's failures itself over at most a minute (docs/agent-protocol.md「服务暂不可用」);
// so a wait longer than LONG_WAIT ends the turn here only for that prompt or a foreground child it still waits on:
// the entry stops OpenCode's (`session/cancel`, which stops its
// foreground subagents too) and answers Coda's prompt with the service's reason, whatever OpenCode answers it with once
// stopped. A shorter wait is OpenCode's to sit out.
import { CHILD_UPDATE } from './children.mjs';
export const LONG_WAIT = 60_000;
const RETRY = 'opencode/retry';
const CHILD_META = 'opencode/child-session';

const record = value => value && typeof value === 'object' && !Array.isArray(value);
const span = ms => Math.ceil(ms / 60_000) >= 60 ? `约 ${Math.round(ms / 3_600_000)} 小时` : `约 ${Math.ceil(ms / 60_000)} 分钟`;

export class LongRetries {
  // `cancel(sessionId)`: stops OpenCode's turn in an ACP session.
  constructor(cancel, now = Date.now) {
    this.cancel = cancel; this.now = now;
    // Every prompt owns its own call/child records. A background child outliving it cannot be adopted by a later prompt.
    // `ending` keeps the reason each prompt being stopped here ends with.
    this.prompts = new Map(); this.ending = new Map();
  }
  // What the entry tells OpenCode.
  toAgent(message) {
    if (message?.method === 'session/prompt' && 'id' in message && typeof message.params?.sessionId === 'string')
      this.prompts.set(message.params.sessionId, { id: message.id, calls: new Map(), children: new Map() });
  }
  // What OpenCode says, as said to Coda: its answer to a prompt stopped here is the reason it was.
  fromAgent(message) {
    if (!record(message)) return message;
    if (message.method === 'session/update') {
      const { sessionId, update } = message.params ?? {}, child = update?._meta?.[CHILD_META];
      if (child !== undefined && (!record(child) || typeof child.id !== 'string' || typeof child.parentID !== 'string')) return message;
      this.updated(sessionId, update, child?.id, child?.parentID); return message;
    }
    if (message.method === CHILD_UPDATE) {
      const p = message.params, turn = this.prompts.get(p?.rootSessionId);
      if (turn && p.type === 'status') this.childStatus(turn, p);
      if (p?.type === 'update' && typeof p.childSessionId === 'string' && typeof p.parentSessionId === 'string')
        this.updated(p.rootSessionId, p.update, p.childSessionId, p.parentSessionId);
      return message;
    }
    if (!('id' in message) || 'method' in message) return message;
    for (const [session, turn] of this.prompts) if (turn.id === message.id) this.prompts.delete(session);
    if (!this.ending.has(message.id)) return message;
    const reason = this.ending.get(message.id);
    this.ending.delete(message.id);
    return { jsonrpc: '2.0', id: message.id, error: { code: -32603, message: reason } };
  }
  childStatus(turn, p) {
    if (typeof p.childSessionId !== 'string' || p.childSessionId === p.rootSessionId) return;
    if (p.parentSessionId !== p.rootSessionId && !turn.children.has(p.parentSessionId)) return;
    const child = turn.children.get(p.childSessionId);
    if (child && child.parent !== p.parentSessionId) return;
    if ((p.status === 'created' && !child) || (p.status === 'running' && child?.ended)) {
      // ACP supplies no launching tool ID on child creation. Retain every possible call, including background and
      // pending calls: cancelling is safe only while ALL candidates are foreground and still being waited on.
      // A continued execution must name this child explicitly; a late `running` cannot acquire another call's owner.
      const calls = [...(turn.calls.get(p.parentSessionId)?.values() ?? [])].filter(call =>
        p.status === 'running' ? call.input?.sessionID === p.childSessionId
          : call.input?.sessionID === undefined || call.input.sessionID === p.childSessionId);
      turn.children.set(p.childSessionId, { parent: p.parentSessionId, calls, ended: false });
    } else if (child && ['completed', 'failed', 'interrupted'].includes(p.status)) {
      child.ended = true;
      for (const call of turn.calls.get(p.childSessionId)?.values() ?? []) call.ended = true;
      turn.calls.delete(p.childSessionId);
    }
  }
  toolUpdate(turn, sessionId, update) {
    if (!['tool_call', 'tool_call_update'].includes(update.sessionUpdate) || typeof update.toolCallId !== 'string') return;
    let calls = turn.calls.get(sessionId);
    if (!calls) { calls = new Map(); turn.calls.set(sessionId, calls); }
    if (update.sessionUpdate === 'tool_call' && ['subagent', 'task'].includes(update.name) && !calls.has(update.toolCallId))
      calls.set(update.toolCallId, { ended: false });
    const call = calls.get(update.toolCallId);
    if (!call) return;
    if (record(update.rawInput)) call.input = update.rawInput;
    if (update.status) call.status = update.status;
    if (['completed', 'failed'].includes(update.status)) { call.ended = true; calls.delete(update.toolCallId); }
  }
  foreground(turn, root, sessionId) {
    const seen = new Set();
    while (sessionId !== root) {
      const child = turn.children.get(sessionId);
      if (seen.has(sessionId) || !child || child.ended || !child.calls.length) return false;
      seen.add(sessionId);
      if (!child.calls.every(call => !call.ended && call.status === 'in_progress' && typeof call.input?.prompt === 'string'
        && typeof call.input?.agent === 'string' && call.input.background !== true)) return false;
      sessionId = child.parent;
    }
    return true;
  }
  updated(sessionId, update, childId, parentId) {
    const turn = this.prompts.get(sessionId);
    if (!turn || !record(update)) return;
    // A projected child without a tracked origin is not evidence that the current root prompt is waiting for it.
    if (childId !== undefined && (!turn.children.has(childId) || turn.children.get(childId).parent !== parentId)) return;
    this.toolUpdate(turn, childId ?? sessionId, update);
    if (childId !== undefined && !this.foreground(turn, sessionId, childId)) return;
    if (update.sessionUpdate !== 'session_info_update') return;
    const retry = record(update?._meta) ? update._meta[RETRY] : null;
    if (!record(retry) || typeof retry.nextRetryAt !== 'string') return;
    const wait = Date.parse(retry.nextRetryAt) - this.now(), id = turn.id;
    if (!(wait > LONG_WAIT) || this.ending.has(id)) return;
    const said = typeof retry.error?.message === 'string' ? retry.error.message.trim() : '';
    this.ending.set(id, `${said || '模型服务要求稍后再试'}\n\nOpenCode 要等${span(wait)}才会重试，这一轮先结束。`);
    this.cancel(sessionId);
  }
}
