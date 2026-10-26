// OpenCode 2's ACP child-session extension (checked against 2.1.4, packages/cli/src/acp/{child,turn}.ts).
// Opt in so child output is no longer projected into the parent's transcript. Register each run before its output,
// including nested children and children that outlive session/prompt. Only native lifecycle events end a wait.
export const CHILD_CAPABILITY = 'opencode/child-session-updates';
export const CHILD_UPDATE = 'opencode/session/child_update';
const CHILD_META = 'opencode/child-session';
const terminal = { completed: 'done', failed: 'failed', interrupted: 'cancelled' };
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 180;
const cut = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : undefined;

export class OpenCodeChildren {
  constructor() {
    this.asked = new Map(); this.roots = new Set(); this.children = new Map(); this.waits = new Map();
    this.enabled = false; this.canClose = false;
  }
  fromCoda(message) {
    if (message.method === '_coda/wait/stop' && 'id' in message) {
      const child = this.waits.get(message.params?.waitId);
      if (!child || child.ended || !this.canClose || child.parent !== message.params?.sessionId)
        return { coda: { jsonrpc: '2.0', id: message.id, error: { code: -32602, message: '没有可以停止的子会话' } } };
      // session/cancel only cancels an ACP prompt. Native children have no ACP prompt; session/close interrupts the
      // native session even when it is not attached to ACP. It does not delete its history (service.ts, turn.ts).
      this.asked.set(message.id, { method: 'stop' });
      return { agent: { ...message, method: 'session/close', params: { sessionId: child.id } } };
    }
    if (['initialize', 'session/new', 'session/load', 'session/resume'].includes(message.method) && 'id' in message)
      this.asked.set(message.id, { method: message.method, sessionId: message.params?.sessionId });
    if (message.method === 'initialize') {
      const capabilities = message.params?.clientCapabilities ?? {};
      message = { ...message, params: { ...message.params, clientCapabilities: { ...capabilities,
        _meta: { ...capabilities._meta, [CHILD_CAPABILITY]: true } } } };
    }
    return { agent: message };
  }
  fromAgent(message) {
    if ('id' in message && !('method' in message)) return [this.answer(message)];
    if (message.method === CHILD_UPDATE) return this.updated(message.params);
    // OpenCode sends permission requests under the root, even with child updates enabled. Its tool metadata names
    // the actual child. Keep the request ID and the namespaced tool ID: the response still belongs to OpenCode.
    if (message.method === 'session/request_permission' && this.enabled) {
      const meta = message.params?.toolCall?._meta?.[CHILD_META];
      if (record(meta)) {
        const reports = [], child = this.child({ rootSessionId: message.params.sessionId, childSessionId: meta.id,
          parentSessionId: meta.parentID, title: meta.title }, reports);
        if (child) return [...reports, { ...message, params: { ...message.params, sessionId: child.id } }];
      }
    }
    return [message];
  }
  answer(message) {
    const asked = this.asked.get(message.id);
    if (!asked) return message;
    this.asked.delete(message.id);
    if (!record(message.result)) return message;
    if (asked.method === 'stop') return { ...message, result: {} };
    if (asked.method !== 'initialize') {
      const id = message.result.sessionId ?? asked.sessionId;
      if (identity(id)) this.roots.add(id);
      return message;
    }
    const capabilities = message.result.agentCapabilities ?? {}, meta = capabilities._meta ?? {};
    this.enabled = meta[CHILD_CAPABILITY] === true;
    this.canClose = record(capabilities.sessionCapabilities?.close);
    if (!this.enabled) return message;
    return { ...message, result: { ...message.result, agentCapabilities: { ...capabilities,
      _meta: { ...meta, coda: { ...meta.coda, waits: {} } } } } };
  }
  child(p, reports) {
    if (!this.enabled || !record(p) || !this.roots.has(p.rootSessionId) || !identity(p.childSessionId)
      || p.childSessionId === p.rootSessionId || this.roots.has(p.childSessionId)) return null;
    const parent = this.children.get(p.parentSessionId);
    if (p.parentSessionId !== p.rootSessionId && (!parent || parent.root !== p.rootSessionId)) return null;
    let child = this.children.get(p.childSessionId);
    if (child && (child.root !== p.rootSessionId || child.parent !== p.parentSessionId)) return null;
    if (!child) {
      child = { id: p.childSessionId, root: p.rootSessionId, parent: p.parentSessionId, title: cut(p.title, 500), run: 0 };
      this.children.set(child.id, child);
      this.start(child, reports);
    }
    return child;
  }
  start(child, reports) {
    if (child.waitId) this.waits.delete(child.waitId);
    child.run++; child.ended = false;
    child.waitId = child.run === 1 ? child.id : `${child.id}#${child.run}`;
    this.waits.set(child.waitId, child);
    reports.push(this.report(child, { kind: 'subagent', state: 'waiting', title: child.title ?? '子 Agent',
      childSessionId: child.id, stoppable: this.canClose }));
  }
  updated(p) {
    if (!record(p) || (p.type !== 'update' && p.type !== 'status')) return [];
    if (p.type === 'update' && !record(p.update)) return [];
    if (p.type === 'status' && !['created', 'running', ...Object.keys(terminal)].includes(p.status)) return [];
    const reports = [];
    // An end without a preceding start does not create a completed historical task on reconnect.
    if (p.type === 'status' && terminal[p.status] && !this.children.has(p.childSessionId)) return [];
    const child = this.child(p, reports);
    if (!child) return [];
    if (p.type === 'update') {
      reports.push({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: child.id, update: p.update } });
    } else if (p.status === 'running' && child.ended) {
      // A fresh native execution is another run of the same card; duplicate created/end events do not reopen it.
      this.start(child, reports);
    } else if (terminal[p.status] && !child.ended) {
      child.ended = true;
      reports.push(this.report(child, { state: terminal[p.status], ...(p.error?.message ? { detail: cut(p.error.message, 4000) } : {}) }));
    }
    return reports;
  }
  report(child, fields) {
    return { jsonrpc: '2.0', method: '_coda/wait', params: { sessionId: child.parent, waitId: child.waitId, ...fields } };
  }
}
