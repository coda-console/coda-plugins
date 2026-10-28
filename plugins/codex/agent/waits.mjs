// What codex-acp says of the work it has going beside a turn, in JetBrains AIR (its subagents and the commands it moved to
// the background), said to Coda as waits of its own (docs/agent-protocol.md「_coda/wait」); and a stop Coda asks of one, asked
// of codex-acp the AIR way. A continued subagent is another session to codex-acp (`X:generation:N`) and the same one to
// Coda: every session it names to Coda is `X`, and each run of it a wait of its own. Coda's session instructions are checked
// here and handed to the patched codex-acp in the request's `_meta` (instructions.mjs).
import { INSTRUCTIONS, sessionInstructions } from './instructions.mjs';
import { sleepTitle } from './sleep.mjs';

const record = value => value && typeof value === 'object' && !Array.isArray(value);
const string = value => typeof value === 'string' && value.length > 0;
const base = id => id.replace(/:generation:\d+$/, '');
const SUBAGENT_END = { completed: 'done', failed: 'failed', cancelled: 'cancelled', disconnected: 'failed' };
const TASK_END = { completed: 'done', failed: 'failed', stopped: 'cancelled' };
const AIR = { version: 1, capabilities: ['nativeSubagentSessions', 'asyncTasks'] };

export class CodexWaits {
  // `agentInfo`: the Codex it runs, said in place of codex-acp's own name and version.
  constructor({ agentInfo = null } = {}) {
    // The root session; Coda's requests whose answers are read here, by id; the waits said, by id.
    this.root = null; this.asked = new Map(); this.waits = new Map(); this.sleeps = new Map(); this.agentInfo = agentInfo;
  }
  // What Coda says: `agent`, what codex-acp is told; `coda`, what Coda is answered here.
  fromCoda(message) {
    if (message.method === 'initialize' && record(message.params)) {
      this.asked.set(message.id, 'initialize');
      // Without native subagent sessions codex-acp drops a delegated thread's own events and only reports start and end;
      // without async tasks it does not say which commands it moved to the background.
      const capabilities = record(message.params.clientCapabilities) ? message.params.clientCapabilities : {};
      const meta = record(capabilities._meta) ? capabilities._meta : {};
      message = { ...message, params: { ...message.params, clientCapabilities: { ...capabilities, _meta: { ...meta, jetbrains: { air: AIR } } } } };
    } else if (message.method === '_coda/wait/stop' && 'id' in message) return this.stop(message);
    if (['session/new', 'session/load'].includes(message.method) && record(message.params)) {
      let instructions;
      try { instructions = sessionInstructions(message.params.systemPrompt); }
      catch (error) { return { agent: [], coda: [{ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: error.message } }] }; }
      const { systemPrompt, ...params } = message.params, meta = record(params._meta) ? params._meta : {};
      message = { ...message, params: instructions ? { ...params, _meta: { ...meta, [INSTRUCTIONS]: instructions } } : params };
    }
    if (message.method === 'session/new') this.asked.set(message.id, 'session');
    else if (message.method === 'session/load' && string(message.params?.sessionId)) this.root = message.params.sessionId;
    else if (message.method === 'session/prompt') this.asked.set(message.id, { prompt: message.params.sessionId });
    return { agent: [message], coda: [] };
  }
  // A command is stopped through the session that keeps it, the root; a subagent by cancelling its session.
  stop({ id, params }) {
    const wait = this.waits.get(params?.waitId);
    if (wait?.stoppable && wait.asyncTaskId) {
      this.asked.set(id, 'stop');
      return { agent: [{ jsonrpc: '2.0', id, method: '_session/async_task/stop', params: { sessionId: this.root, asyncTaskId: wait.asyncTaskId } }], coda: [] };
    }
    if (wait?.stoppable) return { agent: [{ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: wait.subagentSessionId } }], coda: [{ jsonrpc: '2.0', id, result: {} }] };
    return { agent: [], coda: [{ jsonrpc: '2.0', id, error: { code: -32602, message: '没有可以停止的等待项' } }] };
  }
  // What codex-acp says, as said to Coda.
  fromAgent(message) {
    if (!record(message)) return [];
    if ('id' in message && !('method' in message)) {
      const sessionId = this.asked.get(message.id)?.prompt;
      // Cancelling or failing a turn can skip the sleep's completed item. End its waits before ending the prompt.
      const finished = sessionId ? this.finishSleeps(base(sessionId), message.error ? 'failed' : message.result?.stopReason === 'cancelled' ? 'cancelled' : 'done') : [];
      return [...finished, this.answer(message)];
    }
    if (record(message.params) && string(message.params.sessionId)) message = { ...message, params: { ...message.params, sessionId: base(message.params.sessionId) } };
    if (message.method !== 'session/update' || !record(message.params?.update)) return [message];
    const { sessionId, update: u } = message.params;
    const said = params => [{ jsonrpc: '2.0', method: '_coda/wait', params: { sessionId, ...params } }];
    switch (u.sessionUpdate) {
      case 'session_info_update': {
        const sleep = u._meta?.coda?.sleep;
        if (!sleep) return [message];
        const waitId = `sleep:${sleep.id}`;
        if (sleep.state === 'waiting') {
          if (!this.sleeps.has(sessionId)) this.sleeps.set(sessionId, new Set());
          this.sleeps.get(sessionId).add(waitId);
          return said({ waitId, kind: 'task', state: 'waiting', title: sleepTitle(sleep.durationMs),
            detail: '等待结束后继续；发送消息并选择「立即插话」可提前继续。', stoppable: false });
        }
        if (!this.sleeps.get(sessionId)?.delete(waitId)) return [];
        if (!this.sleeps.get(sessionId).size) this.sleeps.delete(sessionId);
        return said({ waitId, state: 'done' });
      }
      case 'subagent_spawned': {
        if (!string(u.subagentSessionId)) return [];
        const stoppable = u.capabilities?.cancel === true;
        this.waits.set(u.subagentSessionId, { subagentSessionId: u.subagentSessionId, stoppable });
        return said({ waitId: u.subagentSessionId, kind: 'subagent', state: 'waiting', title: cut(u.name, 500), detail: cut(u.task, 4000),
          childSessionId: base(u.subagentSessionId), stoppable });
      }
      case 'subagent_state_update':
        return string(u.subagentSessionId) && SUBAGENT_END[u.state] ? [
          ...this.finishSleeps(base(u.subagentSessionId), SUBAGENT_END[u.state]),
          ...said({ waitId: u.subagentSessionId, state: SUBAGENT_END[u.state] }),
        ] : [];
      case 'async_task_spawned': {
        if (!string(u.asyncTaskId)) return [];
        const stoppable = u.canStop === true;
        this.waits.set(u.asyncTaskId, { asyncTaskId: u.asyncTaskId, stoppable });
        return said({ waitId: u.asyncTaskId, kind: 'task', state: 'waiting', title: cut(u.name, 500), stoppable,
          ...(string(u.toolCallId) ? { toolCallId: u.toolCallId } : {}) });
      }
      case 'async_task_state_update':
        return string(u.asyncTaskId) && TASK_END[u.state] ? said({ waitId: u.asyncTaskId, state: TASK_END[u.state] }) : [];
      case 'async_task_progress': return [];
      case 'tool_call_update': {
        // That a call's command went to the background is told by its wait.
        if (!record(u._meta?.jetbrains?.air?.asyncTasks)) return [message];
        const { asyncTasks, ...air } = u._meta.jetbrains.air;
        return [{ ...message, params: { ...message.params, update: { ...u, _meta: { ...u._meta, jetbrains: { ...u._meta.jetbrains, air } } } } }];
      }
    }
    return [message];
  }
  finishSleeps(sessionId, state) {
    const pending = this.sleeps.get(sessionId) ?? [];
    this.sleeps.delete(sessionId);
    return [...pending].map(waitId => ({ jsonrpc: '2.0', method: '_coda/wait', params: { sessionId, waitId, state } }));
  }
  answer(message) {
    const asked = this.asked.get(message.id);
    if (!asked) return message;
    this.asked.delete(message.id);
    if (asked === 'stop') return { jsonrpc: '2.0', id: message.id, ...('error' in message ? { error: message.error } : { result: {} }) };
    if (!record(message.result)) return message;
    if (asked === 'session' && string(message.result.sessionId)) this.root = message.result.sessionId;
    if (asked !== 'initialize') return message;
    // It reports its waits and takes Coda's session instructions; codex-acp itself declares steering (`_meta.steering`).
    const capabilities = record(message.result.agentCapabilities) ? message.result.agentCapabilities : {};
    const meta = record(capabilities._meta) ? capabilities._meta : {};
    const sessions = record(capabilities.sessionCapabilities) ? capabilities.sessionCapabilities : {};
    return { ...message, result: { ...message.result, ...(this.agentInfo ? { agentInfo: this.agentInfo } : {}),
      agentCapabilities: { ...capabilities, sessionCapabilities: { ...sessions, systemPrompt: {} }, _meta: { ...meta, coda: { waits: {} } } } } };
  }
}
const cut = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : undefined;
