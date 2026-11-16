// Grok 1.0.52 reports no ACP modes. Translate set_mode to the notification its own UI sends; everything else passes
// through. No selected mode (the empty currentModeId) leaves the machine's configuration in charge, as before.
// Grok's questions are asked of Coda as ACP forms (questions.mjs). Grok gives one up (its timeout, a cancelled turn)
// by ending the tool call alone, so that end withdraws the form.
// Grok's ACP has no session/delete, but `grok sessions delete <id>` removes a session from its history: the entry declares
// the capability and answers it with that command, so Coda's probes (session/new, then gone) leave no empty sessions behind.
// Checked on 1.0.77 with a session that was never resident (new failed unauthenticated): the command deletes it with the
// agent still running, and a session/close before it changes nothing (`notResident`). Deleting a resident session is not checked.
import { spawn } from 'node:child_process';
import { grokBinary } from '../scripts/ask.mjs';
import { ASK, questionForm } from './questions.mjs';

const DELETE_TIMEOUT_MS = Number(process.env.CODA_GROK_DELETE_TIMEOUT_MS) || 15000;
const modes = [{ id: 'auto', name: '自动审批', _meta: { coda: { shortName: '自动审批' } } },
  { id: 'always-approve', name: '全部放行', _meta: { coda: { shortName: '全部放行' } } }];
const binary = grokBinary() ?? 'grok';
const grok = spawn(binary, ['agent', '--no-leader', 'stdio'], { stdio: ['pipe', 'pipe', 'inherit'] });
const send = (stream, message) => stream.write(`${JSON.stringify(message)}\n`);
const say = message => send(process.stdout, { jsonrpc: '2.0', ...message });
const pending = new Map();
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
// `grok sessions delete <id>`: the error message says why it did not, or null once the session is gone.
function deleteSession(id) {
  return new Promise(resolve => {
    const child = spawn(binary, ['sessions', 'delete', '--', id], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '', done = false;
    const finish = error => { if (done) return; done = true; clearTimeout(timer); resolve(error); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish('删除 Grok 会话超时'); }, DELETE_TIMEOUT_MS);
    child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
    child.on('error', error => finish(`无法运行 Grok CLI：${error.message}`));
    child.on('close', code => finish(code === 0 ? null
      : stderr.split('\n').find(line => line.trim()) ?? `grok sessions delete 退出码 ${code}`));
  });
}
read(process.stdin, message => {
  if (message.method === 'session/delete' && 'id' in message) {
    const id = message.params?.sessionId;
    if (typeof id !== 'string' || !id) { say({ id: message.id, error: { code: -32602, message: '缺少 sessionId' } }); return; }
    deleteSession(id).then(error => say(error ? { id: message.id, error: { code: -32603, message: error } } : { id: message.id, result: {} }));
    return;
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
    } else if (message.result && request.method !== 'session/prompt') {
      sessionId = message.result.sessionId ?? request.params.sessionId;
      mode = request.params?._meta?.yoloMode ? 'always-approve' : request.params?._meta?.autoMode ? 'auto' : '';
      message.result.modes = { currentModeId: mode, availableModes: modes };
    }
  }
  say(message);
});
const stop = () => {
  if (stopping) return;
  stopping = true; grok.stdin.end(); grok.kill();
  setTimeout(() => grok.kill('SIGKILL'), 800).unref();
};
grok.stdin.on('error', () => {});
grok.on('error', () => process.exit(1));
grok.on('close', code => process.exit(stopping ? 0 : code ?? 1));
process.stdin.on('end', stop);
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(signal, stop);
