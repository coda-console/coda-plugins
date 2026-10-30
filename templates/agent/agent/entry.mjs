// 回声 Agent：Coda Agent 插件的最小模板。
//
// Coda 用 `sh -c` 运行清单里的 command，经标准输入输出讲 ACP（一行一个 JSON-RPC 消息），外加 Coda 的等待项登记
// `_coda/wait`（见协议仓库 coda-console/coda-protocol 的 docs/agent-protocol.md）。这里全部手写，只用 Node 自带的模块：从仓库安装的插件没有 npm 依赖。
//
// - 每轮把提示词原样回显，几个字一段地流式发出，所以「停止」能落在一轮中间。
// - 会话指令（systemPrompt）：Coda 要求声明。回声 Agent 没有原生的系统提示词，就照协议在这个会话第一次 session/prompt 时
//   把指令作为单独分隔的一段放在用户输入前面；它没有模型，「送入」就是把这一段也回显出来。
// - 插话（_session/steering）：一轮进行中收到的加进这一轮，说完提示词接着说；一轮已经结束就回 promptRequired，不自己另开一轮。
// - 提示词以 wait 开头时登记一个后台任务（kind: task），两秒后在一轮之外报 handling：Coda 为它开一轮自主轮次，
//   这时说的话归这一项；说完报 done，自主轮次结束。
// - session/cancel：停止本轮；没有轮次在进行时，停止正在处理（handling）的等待项。
// - 日志只能写标准错误：标准输出里每一行都必须是 JSON-RPC 消息。
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const reply = (id, result) => send({ id, result });
const refuse = (id, code, message) => send({ id, error: { code, message } });
const notify = (method, params) => send({ method, params });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// 把一段话作为回复发出，四个字一段；`stopped()` 为真时不再往下说。返回是否说完了。
async function speak(sessionId, text, stopped) {
  for (const piece of text.match(/.{1,4}/gsu) ?? []) {
    if (stopped()) return false;
    notify('session/update', { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: piece } } });
    await sleep(20);
  }
  return !stopped();
}

// Coda 每轮开始前要知道会话用的是哪个模型：没有模型的 Agent 也报一个。
const MODEL = { id: 'model', name: '模型', category: 'model', type: 'select', currentValue: 'echo', options: [{ value: 'echo', name: '回声' }] };
// sessionId → { turn：进行中的一轮或 null，waits：waitId → { state, timer }，count：取 waitId 用，
//   instructions：会话指令还没送入时是它的正文，送入后为 null }
const sessions = new Map();
const session = sessionId => {
  const found = sessions.get(sessionId);
  if (!found) throw Object.assign(new Error(`没有会话 ${sessionId}`), { code: -32002 });
  return found;
};

// ---- 等待项 ----
// 报告一项的新状态；结束（done、failed、cancelled）后这个 waitId 不再说话。
function report(sessionId, waitId, state, fields = {}) {
  const s = sessions.get(sessionId), wait = s?.waits.get(waitId);
  if (!wait) return;
  wait.state = state;
  if (['done', 'failed', 'cancelled'].includes(state)) { clearTimeout(wait.timer); s.waits.delete(waitId); }
  notify('_coda/wait', { sessionId, waitId, state, ...fields });
}
function startWait(sessionId, text) {
  const s = session(sessionId), waitId = `wait-${++s.count}`;
  s.waits.set(waitId, { state: 'waiting', timer: setTimeout(() => handle(sessionId, waitId, text), 2000) });
  report(sessionId, waitId, 'waiting', { kind: 'task', title: '两秒后回来', detail: text.slice(0, 4000), stoppable: true });
}
// 到点了：报 handling（一轮之外时 Coda 开一轮自主轮次），说完报 done。被停下就不再说。
async function handle(sessionId, waitId, text) {
  report(sessionId, waitId, 'handling');
  const wait = sessions.get(sessionId)?.waits.get(waitId);
  if (await speak(sessionId, `两秒到了，接着说：${text}`, () => wait.state !== 'handling')) report(sessionId, waitId, 'done');
}

// ---- 请求 ----
const methods = {
  // 声明会话指令（sessionCapabilities.systemPrompt）、会登记等待项（_meta.coda.waits）与插话（顶层 _meta.steering）；
  // 不支持恢复会话，Coda 就不会发 session/load（支持的，恢复的会话已经送过指令，不再送）。
  initialize: () => ({ protocolVersion: 1, agentCapabilities: { loadSession: false, sessionCapabilities: { systemPrompt: {} }, _meta: { coda: { waits: {} } } },
    authMethods: [], _meta: { steering: { supported: true } } }),
  'session/new': ({ systemPrompt }) => {
    // Coda 只用 append 模式、一个文本块；应用不了的指令回错误，不建立会话。
    if (systemPrompt && systemPrompt.mode !== 'append') throw Object.assign(new Error(`不支持 systemPrompt 模式 ${systemPrompt.mode}`), { code: -32602 });
    const instructions = (systemPrompt?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n').trim() || null;
    const sessionId = randomUUID();
    sessions.set(sessionId, { turn: null, waits: new Map(), count: 0, instructions });
    return { sessionId, configOptions: [MODEL] };
  },
  'session/set_config_option': ({ sessionId, configId, value }) => {
    session(sessionId);
    if (configId !== 'model' || value !== 'echo') throw Object.assign(new Error(`不支持 ${configId}=${value}`), { code: -32602 });
    return { configOptions: [MODEL] };
  },
  'session/prompt': async ({ sessionId, prompt }) => {
    const s = session(sessionId), turn = s.turn = { cancelled: false, steers: [] };
    const text = (prompt ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n').trim();
    try {
      if (/^wait\b/i.test(text)) startWait(sessionId, text);
      // 第一轮：指令作为单独分隔的一段在用户输入前面，整段一次说出。
      if (s.instructions) {
        notify('session/update', { sessionId, update: { sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `<coda-instructions>\n${s.instructions}\n</coda-instructions>\n\n` } } });
        s.instructions = null;
      }
      let said = await speak(sessionId, `回声：${text}`, () => turn.cancelled);
      while (said && turn.steers.length) said = await speak(sessionId, `\n插话：${turn.steers.shift()}`, () => turn.cancelled);
      return { stopReason: turn.cancelled ? 'cancelled' : 'end_turn' };
    } finally { if (s.turn === turn) s.turn = null; }
  },
  // 插话：一轮进行中就加进这一轮，之后的回复与结束都属于原来那次 session/prompt；没有轮次在进行时不收，等 Coda 作为下一轮发来。
  '_session/steering': ({ sessionId, prompt }) => {
    const s = session(sessionId);
    if (!s.turn || s.turn.cancelled) return { outcome: 'promptRequired', reason: 'noRunningTurn' };
    s.turn.steers.push((prompt ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n').trim());
    return { outcome: 'injected' };
  },
  // Coda 停一个声明了 stoppable 的等待项：回 {} 只表示收到，随后用 _coda/wait 报它结束。
  '_coda/wait/stop': ({ sessionId, waitId }) => {
    setImmediate(() => report(sessionId, waitId, 'cancelled'));
    return {};
  },
};
function cancel({ sessionId }) {
  const s = sessions.get(sessionId);
  if (!s) return;
  if (s.turn) s.turn.cancelled = true;
  for (const [waitId, wait] of s.waits) if (wait.state === 'handling') report(sessionId, waitId, 'cancelled');
}

createInterface({ input: process.stdin }).on('line', async line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (typeof message?.method !== 'string') return;
  if (!('id' in message)) { if (message.method === 'session/cancel') cancel(message.params ?? {}); return; }
  const method = methods[message.method];
  if (!method) { refuse(message.id, -32601, `Method not found: ${message.method}`); return; }
  try { reply(message.id, await method(message.params ?? {})); }
  catch (error) { refuse(message.id, error.code ?? -32603, error.message); }
}).on('close', () => process.exit(0));
