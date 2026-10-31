// A fake agent that gets Coda's protocol wrong on purpose, one way per run: `node liar.mjs <mode>`. Without a mode it
// speaks it right, so each test shows one rule failing and nothing else.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const mode = process.argv[2] ?? 'honest';
// Wire extensions supplied by a test, without duplicating the honest ACP conversation.
const extension = process.argv[3] ? JSON.parse(readFileSync(process.argv[3], 'utf8')) : {};
const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const notify = (method, params) => send({ method, params });
const say = (sessionId, text) => notify('session/update', { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } });
const wait = params => notify('_coda/wait', params);
const MODEL = { id: 'model', name: '模型', category: 'model', type: 'select', currentValue: 'liar', options: [{ value: 'liar', name: '说错话' }] };
const asked = new Map();
let next = 0, turn = null, running = null, turns = 0, afterCancel = null, afterSteer = null, context = '';
const textOf = blocks => (blocks ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
// What it was told: the session instructions, from its system prompt or in front of its first input (as a relay without a
// system prompt of its own puts them, Kimi's); the checker's first turn asks for the word in them, and it is said.
const instructed = ({ systemPrompt }) => { if (systemPrompt) context += `${textOf(systemPrompt.content)}\n`; };
const STEERS = ['steer', 'steer-own-turn', 'steer-started'];
// What the checker answered a request of ours.
function ask(method, params) {
  const id = `liar-${next++}`;
  send({ id, method, params });
  return new Promise(resolve => asked.set(id, resolve));
}

// The sessions this process opened itself.
const opened = new Set();
const methods = {
  initialize: () => ({ protocolVersion: mode === 'protocol-version' ? 2 : 1,
    agentCapabilities: { loadSession: mode === 'load-fails' || mode === 'load-forgets', ...(mode === 'no-system-prompt' ? {} : { sessionCapabilities: { systemPrompt: {} } }), _meta: { coda: { waits: {}, ...(mode.startsWith('remote-code') ? { remote: {} } : {}) } } },
    authMethods: [], ...(STEERS.includes(mode) ? { _meta: { steering: { supported: true } } } : {}), ...extension.initialize }),
  'session/new': params => {
    if (mode === 'signed-out') throw Object.assign(new Error('Authentication required'), { code: -32000 });
    instructed(params);
    const sessionId = randomUUID();
    opened.add(sessionId);
    if (mode === 'wait-while-loading') wait({ sessionId, waitId: 'early', kind: 'task', state: 'waiting' });
    if (extension.newError) throw Object.assign(new Error('Cannot open'), extension.newError);
    return mode === 'no-model' ? { sessionId } : { sessionId, configOptions: [MODEL], ...extension.newResult };
  },
  // Says whether the instructions came with it; or answers the load and keeps no session for it (OpenCode before 1.0.151).
  'session/load': ({ systemPrompt }) => {
    if (extension.loadResult) return extension.loadResult;
    if (extension.loadError) throw Object.assign(new Error('Cannot load'), extension.loadError);
    if (mode === 'load-forgets') return { configOptions: [MODEL] };
    const word = /reply with exactly (\S+) and nothing else/.exec(textOf(systemPrompt?.content))?.[1];
    throw Object.assign(new Error(`会话不见了${word ? `（收到了检查词 ${word} 的会话指令）` : ''}`), { code: -32002 });
  },
  'session/prompt': async ({ sessionId, prompt }) => {
    if (mode === 'load-forgets' && !opened.has(sessionId)) throw Object.assign(new Error(`Session not found: ${sessionId}`), { code: -32602 });
    const text = textOf(prompt);
    context += `${text}\n`;
    // The checker's first turn, apart from those the modes count.
    if (text.includes('What is the Coda check word?')) {
      say(sessionId, mode === 'ignore-system-prompt' ? 'ok' : /reply with exactly (\S+) and nothing else/.exec(context)?.[1] ?? '不知道');
      return { stopReason: 'end_turn' };
    }
    const me = turn = running = { cancelled: false }, first = ++turns === 1;
    try { return await act(sessionId, me, first); } finally { if (running === me) running = null; }
  },
  // Not taken once its turn has ended; or taken, as a turn of its own; or a turn of its own after saying it was not.
  '_session/steering': ({ sessionId }) => {
    afterSteer?.(); afterSteer = null;
    if (Object.hasOwn(extension, 'steeringResult')) return extension.steeringResult;
    if (running && mode === 'steer') return { outcome: 'injected' };
    if (mode === 'steer-started') { setImmediate(() => say(sessionId, '我自己开了一轮')); return { outcome: 'startedNewTurn' }; }
    if (mode === 'steer-own-turn') setImmediate(() => say(sessionId, '还是说一句'));
    return { outcome: 'promptRequired', reason: 'noRunningTurn' };
  },
};
// A turn, as each mode gets it wrong.
async function act(sessionId, me, first) {
  if (first) {
    for (const update of extension.updates ?? []) notify('session/update', { sessionId, update });
    for (const params of extension.waits ?? []) wait({ sessionId, ...params });
    for (const request of extension.requests ?? []) await ask(request.method, request.params);
    if (extension.promptError) throw Object.assign(new Error('Request failed'), extension.promptError);
  }
  if (mode === 'quota-exhausted')
    throw Object.assign(new Error('Provider usage allowance exhausted'), { code: -32603,
      data: { _meta: { coda: { failure: { kind: 'quota_exhausted', input: 'accepted' } } } } });
  if (mode === 'service-failure-always' || (mode === 'service-failure-once' && first))
    throw Object.assign(new Error('Service unavailable'), { code: -32603,
      data: { _meta: { coda: { failure: { kind: 'service_unavailable', input: 'accepted' } } } } });
  // Once, saying how long upstream asks to wait: within Coda's one-minute budget, or past it.
  if (first && (mode === 'service-wait-short' || mode === 'service-wait-long'))
    throw Object.assign(new Error('Service unavailable'), { code: -32603, data: { _meta: { coda: { failure: { kind: 'service_unavailable',
      input: 'accepted', retryAfterMs: mode === 'service-wait-short' ? 300 : 60_001 } } } } });
  if (mode === 'stdout-noise') process.stdout.write('starting turn...\n');
  if (mode === 'bad-update') notify('session/update', { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: 'hi' } });
  if (mode === 'foreign-session') say('someone-else', 'hi');
  if (mode === 'bad-wait') wait({ sessionId, waitId: 'w', state: 'running' });
  if (mode === 'wait-no-params') send({ method: '_coda/wait' });
  if (mode === 'after-terminal') { wait({ sessionId, waitId: 'w', kind: 'task', state: 'waiting' }); wait({ sessionId, waitId: 'w', state: 'done' }); wait({ sessionId, waitId: 'w', state: 'handling' }); }
  if (mode === 'subagent-no-child') { wait({ sessionId, waitId: `w${turns}`, kind: 'subagent', state: 'waiting' }); wait({ sessionId, waitId: `w${turns}`, state: 'done' }); }
  if (mode === 'timer-no-at') { wait({ sessionId, waitId: `t${turns}`, kind: 'timer', state: 'waiting' }); wait({ sessionId, waitId: `t${turns}`, state: 'done' }); }
  // A remote agent not yet bound asks Coda for a binding code (docs/agent-protocol.md「远端入口」), for its own session or not.
  if (mode === 'remote-code' || mode === 'remote-code-foreign') {
    const answer = await ask('_coda/remote/code', { sessionId: mode === 'remote-code' ? sessionId : 'someone-else' });
    say(sessionId, answer.error ? `绑定码被拒：${answer.error.message}` : `绑定码字段 ${Object.keys(answer.result).sort().join(',')}`);
  }
  if (mode === 'permission') {
    const answer = await ask('session/request_permission', { sessionId, toolCall: { toolCallId: 'c1', title: 'rm -rf build' },
      options: [{ optionId: 'yes', name: '允许', kind: 'allow_once' }, { optionId: 'no', name: '拒绝', kind: 'reject_once' }] });
    say(sessionId, `审批答复 ${JSON.stringify(answer.result)}`);
  }
  // The second turn, the one the checker stops, never ends.
  if (mode === 'ignore-cancel' && !first) await new Promise(() => {});
  say(sessionId, 'ok');
  // Keep the honest second turn alive until it reads the cancel and the checker's barrier. A fast echo can otherwise
  // finish before the checker sends the cancel, which is valid but does not exercise cancellation.
  if (mode === 'honest' && !first) await new Promise(resolve => { afterCancel = resolve; });
  // The steering turn has finished its work, but its reply is still pending when the steering message arrives. Hold that
  // reply until the message is read so this ordering does not depend on how stdout chunks are delivered.
  if (mode === 'steer' && turns === 2) {
    running = null;
    await new Promise(resolve => { afterSteer = resolve; });
  }
  // It reads the cancel, and what comes after it: it goes on and says it ended; it waits, and says it ended; or it had done
  // all it had to and says so at once (as Codex does, its reply held back by a title).
  if (['keep-going', 'slow-end-turn', 'late-end-turn'].includes(mode) && !first) {
    await new Promise(resolve => { afterCancel = resolve; });
    if (mode === 'keep-going') say(sessionId, '还在说');
    if (mode === 'slow-end-turn') await new Promise(resolve => setTimeout(resolve, 1500));
    return { stopReason: 'end_turn' };
  }
  // Its answer is written before it reads the cancel the checker sends as it hears the `ok`: it is busy until then.
  if (mode === 'reply-in-flight' && !first) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300); return { stopReason: 'end_turn' }; }
  return { stopReason: me.cancelled ? 'cancelled' : 'end_turn' };
}

createInterface({ input: process.stdin }).on('line', async line => {
  const message = JSON.parse(line);
  // Something read after the cancel (the checker's barrier): handled before the stopped turn answers.
  if (turn?.cancelled && message.method !== 'session/cancel') setImmediate(() => afterCancel?.());
  if (!('method' in message)) { asked.get(message.id)?.(message); return; }
  if (!('id' in message)) { if (message.method === 'session/cancel' && turn && mode !== 'ignore-cancel') turn.cancelled = true; return; }
  const method = methods[message.method];
  if (!method) { send({ id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } }); return; }
  try { send({ id: message.id, result: await method(message.params ?? {}) }); }
  catch (error) { send({ id: message.id, error: { code: error.code ?? -32603, message: error.message, data: error.data } }); }
  // Right after the first turn ended, with nothing being handled: out of any turn.
  if (message.method === 'session/prompt' && mode === 'permission-outside' && turns === 1) void ask('session/request_permission', { sessionId: message.params.sessionId,
    toolCall: { toolCallId: 'c2', title: '之后再问' }, options: [{ optionId: 'no', name: '拒绝', kind: 'reject_once' }] });
}).on('close', () => { if (mode !== 'linger') process.exit(0); });
// Stays after its input ends (until SIGTERM); stays after SIGTERM; goes a while after SIGTERM.
if (mode === 'linger') setInterval(() => {}, 1000);
if (mode === 'ignore-sigterm') process.on('SIGTERM', () => {});
if (mode === 'slow-sigterm') process.on('SIGTERM', () => setTimeout(() => process.exit(0), 1200));
