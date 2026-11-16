// OpenCode 2 tells ACP when it compacts a session's context (manual `/compact`, or on its own near the limit) as a
// `session_info_update` carrying `_meta['opencode/compaction']`: `{ status: started | completed | failed, messageId, reason }`.
// Coda learns of it as `compaction_update` (docs/agent-protocol.md), one id per compaction, completed once. Only a root session's:
// a native child's updates arrive here under the child's own id.
const META = 'opencode/compaction';
const STATUS = { started: 'in_progress', completed: 'completed', failed: 'failed' };

export class OpenCodeCompactions {
  constructor({ owns }) { this.owns = owns; this.ended = new Map(); }
  // The `compaction_update` that `message` makes known, or null.
  fromAgent(message) {
    const update = message.method === 'session/update' ? message.params?.update : null;
    const meta = update?.sessionUpdate === 'session_info_update' ? update._meta?.[META] : null;
    const sessionId = message.params?.sessionId, status = STATUS[meta?.status];
    if (!status || typeof meta.messageId !== 'string' || !meta.messageId || !this.owns(sessionId)) return null;
    if (status !== 'in_progress') {
      if (this.ended.get(sessionId) === meta.messageId) return null;
      this.ended.set(sessionId, meta.messageId);
    }
    return { jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'compaction_update',
      compactionId: meta.messageId, status, error: status === 'failed' ? meta.error?.message ?? null : null } } };
  }
}
