// OpenCode 2.1.4 does not put shell lifecycle events on ACP. Its native plugin API does expose them; runtime/server.mjs
// forwards just those facts over a private local socket. A completed shell *tool call* only started the job. Keep the
// wait until its native completion notification has been handled, so Coda does not retire the process between turns.
// The native events are not documented and were checked with CHECKED alone, as OpenCode's handshake names it: under another
// version they may go by other names and its background commands untold. That is said once a session, to a Coda that takes
// it (`_coda/unrecognized`, docs/agent-protocol.md「没适配的东西」); nothing else changes. Setup keeps none older (scripts/setup.mjs).
export const CHECKED = '2.1.4';
const record = x => x && typeof x === 'object' && !Array.isArray(x);
const id = x => typeof x === 'string' && x.length > 0 && x.length <= 180;
const shellId = x => id(x) && /^sh_[A-Za-z0-9]+$/.test(x);
const cut = (x, n) => typeof x === 'string' ? x.slice(0, n) : undefined;

export class OpenCodeShells {
  constructor({ owns, say, interrupt }) {
    this.owns = owns; this.say = say; this.interrupt = interrupt;
    this.shells = new Map(); this.inbox = new Map(); this.prompts = new Map(); this.calls = new Set();
    // Coda's handshake and sessions whose answers are read here, by id; OpenCode's version; whether Coda takes what is not
    // adapted, and the sessions told it.
    this.asked = new Map(); this.version = null; this.taken = false; this.told = new Set();
  }
  fromCoda(message) {
    if (['initialize', 'session/new', 'session/load', 'session/resume'].includes(message.method) && 'id' in message)
      this.asked.set(message.id, { method: message.method, sessionId: message.params?.sessionId });
    if (message.method === 'initialize') this.taken = record(message.params?.clientCapabilities?._meta?.coda?.unrecognized);
    if (message.method === 'session/prompt' && 'id' in message)
      this.prompts.set(message.id, message.params?.sessionId);
    if (message.method === 'session/cancel' && ![...this.prompts.values()].includes(message.params?.sessionId)
      && [...this.shells.values()].some(s => s.session === message.params?.sessionId && s.delivered && !s.handled && !s.ended)) {
      // ACP cancel only interrupts an ACP prompt. Use the native plugin API for this autonomous execution;
      // ACP session/close would also detach the root and make the next user prompt fail.
      const shell = [...this.shells.values()].find(s => s.session === message.params.sessionId && s.delivered && !s.handled && !s.ended);
      this.interrupt(shell.source, shell.session);
      return true;
    }
    return false;
  }
  fromAgent(message) {
    if ('id' in message && !message.method) {
      const asked = this.asked.get(message.id);
      this.asked.delete(message.id);
      if (asked && record(message.result)) this.checked(asked, message.result);
      const session = this.prompts.get(message.id);
      this.prompts.delete(message.id);
      for (const shell of this.shells.values()) if (shell.session === session) this.handling(shell);
    }
    const u = message.method === 'session/update' ? message.params?.update : null;
    const call = JSON.stringify([message.params?.sessionId, u?.toolCallId]);
    if (u?.sessionUpdate === 'tool_call' && ['shell', 'bash'].includes(u.name)) this.calls.add(call);
    const meta = u?.rawOutput?.metadata;
    const isShell = this.calls.has(call);
    if (['completed', 'failed'].includes(u?.status)) this.calls.delete(call);
    if (u?.sessionUpdate !== 'tool_call_update' || meta?.status !== 'running' || !shellId(meta.shellID)
      || !isShell || !this.owns(message.params.sessionId)) return;
    const shell = this.shells.get(meta.shellID);
    if (shell?.registered) return;
    // Native plugin activation may be refused by the machine's OpenCode policy. The ACP result still proves that a
    // background shell was launched; show the missing observation instead of silently declaring it completed.
    const failed = { id: meta.shellID, session: message.params.sessionId, registered: true, ended: true };
    this.shells.set(failed.id, failed);
    this.report(failed, { kind: 'task', state: 'waiting', title: '后台命令', toolCallId: u.toolCallId, stoppable: false });
    this.report(failed, { state: 'failed', detail: 'OpenCode 未建立后台命令事件连接，命令结果未确认' });
  }
  checked(asked, result) {
    if (asked.method === 'initialize') { this.version = result.agentInfo?.version ?? null; return; }
    const sessionId = result.sessionId ?? asked.sessionId;
    if (!this.taken || this.version === CHECKED || !id(sessionId) || this.told.has(sessionId)) return;
    this.told.add(sessionId);
    this.say({ jsonrpc: '2.0', method: '_coda/unrecognized', params: { sessionId, kind: 'output', name: 'plugin:version', lost: true,
      detail: `这个版本的 OpenCode（${this.version ?? '版本未知'}）没有核对过（核对过的是 ${CHECKED}），后台命令在底部可能看不见` } });
  }
  report(shell, fields) {
    this.say({ jsonrpc: '2.0', method: '_coda/wait', params: {
      sessionId: shell.session, waitId: `shell:${shell.id}`, ...fields,
    } });
  }
  handling(shell) {
    if (!shell.registered || !shell.delivered || shell.handled || shell.ended || shell.handling
      || [...this.prompts.values()].includes(shell.session)) return;
    shell.handling = true;
    this.report(shell, { state: 'handling' });
  }
  event(event, source) {
    if (!record(event) || !record(event.data)) return;
    const d = event.data;
    if (event.type === 'shell.created') {
      const info = d.info;
      if (!record(info) || !shellId(info.id) || !this.owns(info.metadata?.sessionID) || this.shells.has(info.id)) return;
      this.shells.set(info.id, { id: info.id, session: info.metadata.sessionID, source,
        command: cut(info.command, 4000), outputFile: cut(info.file, 4000), status: 'running' });
      return;
    }
    if (event.type === 'shell.exited') {
      const shell = this.shells.get(d.id);
      if (!shell || shell.source !== source || shell.ended || !['exited', 'timeout', 'killed'].includes(d.status)) return;
      shell.status = d.status; shell.exit = d.exit;
      // The notifier also records the exit/signal; an exited shell is not necessarily a successful command.
      shell.result = d.status === 'killed' ? 'cancelled' : d.status === 'exited' && d.exit === 0 ? 'done' : 'failed';
      shell.detail = d.status === 'timeout' ? '命令超时' : d.status === 'killed' ? '命令已被停止'
        : Number.isFinite(d.exit) ? `退出码 ${d.exit}` : '命令退出，未报告退出码';
      this.settle(shell);
      return;
    }
    if (!this.owns(d.sessionID)) return;
    if (event.type === 'session.inbox.enqueued') {
      const meta = d.item?.type === 'synthetic' ? d.item.payload?.metadata : null;
      const shell = meta?.source === 'shell' ? this.shells.get(meta.shellID) : null;
      if (shell && shell.source === source && shell.session === d.sessionID && id(d.inboxID) && !shell.ended) {
        this.inbox.set(d.inboxID, shell);
        shell.notification = d.inboxID;
      }
    } else if (event.type === 'session.inbox.delivered' || event.type === 'session.inbox.cancelled') {
      const shell = this.inbox.get(d.inboxID);
      if (!shell || shell.source !== source || shell.session !== d.sessionID || shell.ended) return;
      shell.delivered = event.type === 'session.inbox.delivered';
      shell.handled = !shell.delivered;
      this.handling(shell);
      this.settle(shell);
    } else if (['session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted'].includes(event.type)) {
      for (const shell of this.shells.values()) if (shell.session === d.sessionID && shell.source === source && shell.delivered) {
        shell.handled = true;
        if (event.type === 'session.execution.failed') {
          shell.handlingError = `OpenCode 处理命令结果失败：${cut(d.error?.message, 3000) || '未知错误'}`;
        }
        if (event.type === 'session.execution.interrupted') shell.handlingNote = 'OpenCode 已停止处理命令结果';
        this.settle(shell);
      }
    }
    this.prune();
  }
  register(message, source) {
    const shell = this.shells.get(message.shellId);
    if (!shell || shell.source !== source || shell.session !== message.sessionId || !this.owns(shell.session)
      || !id(message.toolCallId)) return false;
    if (shell.registered) return true;
    shell.registered = true;
    this.report(shell, { kind: 'task', state: 'waiting', title: cut(shell.command, 500) || '后台命令',
      detail: shell.command, outputFile: shell.outputFile, toolCallId: message.toolCallId, stoppable: false });
    this.handling(shell);
    this.settle(shell);
    return true;
  }
  settle(shell) {
    if (!shell.registered || shell.ended || !shell.result || !shell.handled) return;
    shell.ended = true;
    this.report(shell, { state: shell.handlingError ? 'failed' : shell.result,
      detail: [shell.detail, shell.handlingError, shell.handlingNote].filter(Boolean).join('；') });
    if (shell.notification) this.inbox.delete(shell.notification);
  }
  disconnected(source) {
    for (const [key, shell] of this.shells) if (shell.source === source) {
      if (shell.registered && !shell.ended)
        this.report(shell, { state: 'failed', detail: 'OpenCode 后台命令事件连接已断开，结果未确认' });
      if (shell.notification) this.inbox.delete(shell.notification);
      this.shells.delete(key);
    }
  }
  prune() {
    // Foreground shells have no waits. Retain a bounded tail for an extremely fast background command whose native
    // exit/notification precedes the tool's after hook; active or registered unfinished work is never evicted.
    const old = [...this.shells.values()].filter(s => s.ended || (!s.registered && s.status !== 'running'));
    for (const s of old.slice(0, -256)) {
      this.shells.delete(s.id);
      if (s.notification) this.inbox.delete(s.notification);
    }
  }
}
