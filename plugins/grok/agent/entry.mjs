// Grok (checked on 1.0.52) reports no ACP modes. Translate set_mode to the notification its own UI sends; everything else passes
// through. No selected mode (the empty currentModeId) leaves the machine's configuration in charge, as before.
// Grok's questions are asked of Coda as ACP forms (questions.mjs). Grok gives one up (its timeout, a cancelled turn)
// by ending the tool call alone, so that end withdraws the form. Its context compactions, auto or a /compact of the user's, are
// told as `_x.ai/session_notification` updates, which are also told to Coda as `compaction_update` (docs/agent-protocol.md).
// The prompt's usage Grok tells in `_meta.usage` is also told as the response's `usage` (usage.mjs).
// Grok's ACP has no session/delete, so the entry declares it and answers it with `grok sessions delete`
// (delete.mjs; checked on 1.0.77): Coda's probes (session/new, then gone) leave no empty sessions in Grok's history.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { grokBinary } from '../scripts/ask.mjs';
import { deleteSession } from './delete.mjs';
import { describeExit, endedError } from './exit.mjs';
import { ASK, questionForm } from './questions.mjs';
import { promptUsage } from './usage.mjs';

const modes = [{ id: 'auto', name: '自动审批', _meta: { coda: { shortName: '自动审批' } } },
  { id: 'always-approve', name: '全部放行', _meta: { coda: { shortName: '全部放行' } } }];
const binary = grokBinary() ?? 'grok';
const grok = spawn(binary, ['agent', '--no-leader', 'stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
let stderr = '';
grok.stderr.on('data', chunk => { process.stderr.write(chunk); stderr = (stderr + chunk).slice(-2048); });
const send = (stream, message) => stream.write(`${JSON.stringify(message)}\n`);
const say = message => send(process.stdout, { jsonrpc: '2.0', ...message });
const pending = new Map();
// What Grok says of a compaction of the main session, as Coda takes it. A /compact says its end only.
const COMPACTION = { auto_compact_started: 'in_progress', auto_compact_completed: 'completed', auto_compact_failed: 'failed', auto_compact_cancelled: 'failed' };
let compaction = null;
// The deletes under way, by session: Coda closes a probe's session once its delete has had its few seconds, and a close
// reaching Grok while `sessions delete` still runs could write the session back.
const deleting = new Map();
// The forms asked of Coda, by their id: Grok's request they answer, its tool call, and how the answer is given back.
const questions = new Map();
let sessionId, mode = '', stopping = false, asked = 0;

// Only LF separates JSON messages; readline would also split literal Unicode line separators inside JSON strings.
function read(stream, receive) {
  let rest = '';
  const take = text => {
    const lines = (rest + text).split('\n'); rest = lines.pop();
    for (const line of lines) {
      let message; try { message = JSON.parse(line); } catch { continue; }
      if (message && typeof message === 'object' && !Array.isArray(message)) receive(message);
    }
  };
  stream.setEncoding('utf8').on('data', take).on('end', () => take('\n'));
}
read(process.stdin, message => {
  if (message.method === 'session/delete' && 'id' in message) {
    const id = message.params?.sessionId;
    if (typeof id !== 'string' || !id) { say({ id: message.id, error: { code: -32602, message: '缺少 sessionId' } }); return; }
    deleting.set(id, deleteSession(binary, id).then(error => {
      deleting.delete(id); say(error ? { id: message.id, error } : { id: message.id, result: {} });
    }));
    return;
  }
  if (message.method === 'session/close' && deleting.has(message.params?.sessionId)) {
    deleting.get(message.params.sessionId).then(() => send(grok.stdin, message)); return;
  }
  const question = !message.method && questions.get(message.id);
  if (question) {
    questions.delete(message.id);
    send(grok.stdin, { jsonrpc: '2.0', id: question.id, result: question.answer(message.result) }); return;
  }
  if (message.method === 'session/set_mode' && 'id' in message) {
    const chosen = message.params?.modeId;
    const error = !sessionId || message.params?.sessionId !== sessionId ? 'Grok 会话不存在'
      : !modes.some(m => m.id === chosen) ? '审批模式不可用'
      : [...pending.values()].some(m => m.method === 'session/prompt') ? '请在当前轮次结束后切换审批模式' : null;
    if (error) { say({ id: message.id, error: { code: -32602, message: error } }); return; }
    send(grok.stdin, { jsonrpc: '2.0', method: '_x.ai/yolo_mode_changed', params: {
      sessionId, yolo_mode: chosen === 'always-approve', auto_mode: chosen === 'auto', permission_mode: chosen,
    } });
    mode = chosen;
    say({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'current_mode_update', currentModeId: mode } } });
    say({ id: message.id, result: {} }); return;
  }
  if ('id' in message && ['initialize', 'session/new', 'session/load', 'session/prompt'].includes(message.method)) pending.set(message.id, message);
  send(grok.stdin, message);
});
read(grok.stdout, message => {
  if (message.method === ASK && 'id' in message) {
    const id = `grok-ask-${++asked}`, { params, answer } = questionForm(message.params ?? {});
    questions.set(id, { id: message.id, toolCallId: params.toolCallId, answer });
    say({ id, method: 'elicitation/create', params }); return;
  }
  const update = message.method === 'session/update' ? message.params?.update : null;
  if (update?.sessionUpdate === 'tool_call_update' && ['completed', 'failed'].includes(update.status)) {
    for (const [id, question] of questions) if (question.toolCallId === update.toolCallId) {
      questions.delete(id); say({ method: '$/cancel_request', params: { requestId: id } });
    }
  }
  const request = !message.method && pending.get(message.id);
  if (request) {
    pending.delete(message.id);
    if (message.result && request.method === 'initialize') {
      const capabilities = message.result.agentCapabilities ??= {};
      capabilities.sessionCapabilities = { ...capabilities.sessionCapabilities, delete: {} };
    } else if (message.result && request.method === 'session/prompt') {
      const usage = promptUsage(message.result);
      if (usage) message.result.usage = usage;
    } else if (message.result && request.method !== 'session/prompt') {
      sessionId = message.result.sessionId ?? request.params.sessionId;
      mode = request.params?._meta?.yoloMode ? 'always-approve' : request.params?._meta?.autoMode ? 'auto' : '';
      message.result.modes = { currentModeId: mode, availableModes: modes };
    }
  }
  say(message);
  const status = message.method === '_x.ai/session_notification' && message.params?.sessionId === sessionId ? COMPACTION[message.params.update?.sessionUpdate] : null;
  if (status) {
    compaction ??= randomUUID();
    say({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'compaction_update', compactionId: compaction, status, error: null } } });
    if (status !== 'in_progress') compaction = null;
  }
});
const stop = () => {
  if (stopping) return;
  stopping = true; grok.stdin.end(); grok.kill();
  setTimeout(() => grok.kill('SIGKILL'), 800).unref();
};
grok.stdin.on('error', () => {});
grok.on('error', () => process.exit(1));
// Grok dying on its own: the log and the prompts still waiting say how (exit.mjs).
grok.on('close', (code, signal) => {
  const waiting = [...pending].filter(([, request]) => request.method === 'session/prompt');
  if (!stopping && (code !== 0 || waiting.length)) {
    const message = describeExit({ code, signal, stderr });
    process.stderr.write(`${message}\n`);
    for (const [id] of waiting) say({ id, error: endedError(message) });
  }
  // What was said reaches Coda before this process ends.
  process.stdout.write('', () => process.exit(stopping ? 0 : code ?? 1));
});
process.stdin.on('end', stop);
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(signal, stop);
