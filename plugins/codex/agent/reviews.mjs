// Codex's own check of a call before running it (its automatic approval review), said to Coda as part of that call
// (docs/agent-protocol.md「工具调用的审核」). codex-acp makes each check a call of its own, `Guardian Review`
// (`guardian_assessment:<id>`), which names the call it checks (`targetItemId`); here it becomes `_meta.coda.review` of that
// call. A check can begin before codex-acp tells of the call: the call is told then, pending, and codex-acp's own telling of
// it later is an update of it.
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const CHECK = 'guardian_assessment:';
const STATE = { inProgress: 'reviewing', approved: 'approved', denied: 'denied', aborted: 'denied', timedOut: 'denied' };
const RISKS = new Set(['low', 'medium', 'high', 'critical']);
// What the call is, as far as the check says, until codex-acp tells it.
const placeholder = action => action?.type === 'command' && typeof action.command === 'string' ? { title: action.command, kind: 'execute' }
  : action?.type === 'execve' && Array.isArray(action.argv) ? { title: action.argv.join(' ') || action.program, kind: 'execute' } : {};

export class CodexReviews {
  constructor() {
    // The calls told of, and those told here before codex-acp did, by session.
    this.told = new Set(); this.early = new Set();
  }
  // What codex-acp says, as said to Coda: the same, but a check is said of the call it checks.
  fromAgent(message) {
    const u = message?.params?.update;
    if (message?.method !== 'session/update' || !record(u) || !['tool_call', 'tool_call_update'].includes(u.sessionUpdate)
      || typeof u.toolCallId !== 'string') return [message];
    const { sessionId } = message.params, key = id => `${sessionId}\n${id}`;
    const said = update => ({ ...message, params: { ...message.params, update } });
    if (!u.toolCallId.startsWith(CHECK)) {
      if (u.sessionUpdate !== 'tool_call') return [message];
      if (this.early.delete(key(u.toolCallId))) return [said({ ...u, sessionUpdate: 'tool_call_update' })];
      this.told.add(key(u.toolCallId));
      return [message];
    }
    // The started event, then the completed one: the later is the last word.
    const check = record(u.rawOutput) ? u.rawOutput : u.rawInput, target = check?.targetItemId, state = STATE[check?.review?.status];
    if (typeof target !== 'string' || !target || !state) return [message];
    const { rationale, riskLevel } = check.review;
    const review = { state, ...(typeof rationale === 'string' && rationale.trim() ? { reason: rationale.slice(0, 4000) } : {}),
      ...(RISKS.has(riskLevel) ? { risk: riskLevel } : {}) };
    const meta = { toolCallId: target, _meta: { coda: { review } } };
    if (this.told.has(key(target)) || this.early.has(key(target))) return [said({ sessionUpdate: 'tool_call_update', ...meta })];
    this.early.add(key(target)); this.told.add(key(target));
    return [said({ sessionUpdate: 'tool_call', ...meta, ...placeholder(check.action), status: 'pending' })];
  }
}
