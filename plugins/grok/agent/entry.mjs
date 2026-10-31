// Grok 1.0.52 reports no ACP modes. Translate set_mode to the notification its own UI sends; everything else passes
// through. No selected mode (the empty currentModeId) leaves the machine's configuration in charge, as before. Coda's session
// instructions go in front of a new session's first prompt (instructions.mjs).
import { spawn } from 'node:child_process';
import { grokBinary } from '../scripts/ask.mjs';
import { SessionInstructions } from './instructions.mjs';

const modes = [{ id: 'auto', name: '自动审批', _meta: { coda: { shortName: '自动审批' } } },
  { id: 'always-approve', name: '全部放行', _meta: { coda: { shortName: '全部放行' } } }];
const grok = spawn(grokBinary() ?? 'grok', ['agent', '--no-leader', 'stdio'], { stdio: ['pipe', 'pipe', 'inherit'] });
const send = (stream, message) => stream.write(`${JSON.stringify(message)}\n`);
const say = message => send(process.stdout, { jsonrpc: '2.0', ...message });
const pending = new Map();
const instructions = new SessionInstructions();
let sessionId, mode = '', stopping = false;

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
read(process.stdin, said => {
  const { agent: message, coda } = instructions.fromCoda(said);
  if (coda) { say(coda); return; }
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
  if ('id' in message && ['session/new', 'session/load', 'session/prompt'].includes(message.method)) pending.set(message.id, message);
  send(grok.stdin, message);
});
read(grok.stdout, said => {
  const message = instructions.fromAgent(said), request = !message.method && pending.get(message.id);
  if (request) {
    pending.delete(message.id);
    if (message.result && request.method !== 'session/prompt') {
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
