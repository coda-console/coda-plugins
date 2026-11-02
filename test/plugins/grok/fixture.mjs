// Grok's modes are changed by a notification, not by ACP set_mode. Report what subsequent prompts actually use. Its questions are
// a request of its own (`_x.ai/ask_user_question`): `ask` reports the answer it is given, `give up` ends the tool call unanswered.
import { createInterface } from 'node:readline';
const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const say = text => send({ method: 'session/update', params: { sessionId: 'native', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
let mode = 'machine', effort = 'low', held, asking;
const options = () => [{ id: 'model', category: 'model', name: 'Model', type: 'select', currentValue: 'grok', options: [{ value: 'grok', name: 'Grok' }] }];
createInterface({ input: process.stdin }).on('line', m => {
  m = JSON.parse(m);
  if (!m.method) {
    if (asking && m.id === 0) { say(JSON.stringify(m.result)); send({ id: asking, result: { stopReason: 'end_turn' } }); asking = null; }
    return;
  }
  if (m.method === '_x.ai/yolo_mode_changed') { mode = m.params.yolo_mode ? 'always-approve' : m.params.auto_mode ? 'auto' : 'machine'; return; }
  if (m.method === 'session/cancel') { if (held) send({ id: held, result: { stopReason: 'cancelled' } }); held = null; return; }
  if (!('id' in m)) return;
  const result = m.method === 'initialize' ? { protocolVersion: 1, agentCapabilities: { loadSession: true } }
    : m.method === 'session/new' ? { sessionId: 'native', configOptions: options() }
    : m.method === 'session/load' ? { configOptions: options() }
    : m.method === 'session/set_config_option' ? (effort = m.params.value, { configOptions: options() }) : null;
  if (result) { send({ id: m.id, result }); return; }
  if (m.method === 'session/prompt') {
    if (m.params.prompt[0].text === 'hold') { held = m.id; say('holding'); return; }
    if (['ask', 'give up'].includes(m.params.prompt[0].text)) {
      const toolCallId = `ask-${m.id}`;
      send({ id: 0, method: '_x.ai/ask_user_question', params: { sessionId: 'native', toolCallId, mode: 'default', questions: [
        { question: '选一个', options: [{ label: 'A', description: '第一种' }, { label: 'B', description: '' }], multiSelect: false },
        { question: '选多个', options: [{ label: 'X', description: '' }, { label: 'Y', description: '' }], multiSelect: true }] } });
      if (m.params.prompt[0].text === 'ask') { asking = m.id; return; }
      send({ method: 'session/update', params: { sessionId: 'native', update: { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed' } } });
      send({ id: m.id, result: { stopReason: 'end_turn' } }); return;
    }
    // The checker's question about the session instructions, answered from what came in front of it as a model would.
    const given = m.params.prompt.map(block => block.text ?? '').join('\n');
    if (given.includes('What is the Coda check word?')) {
      say(/reply with exactly (\S+) and nothing else/.exec(given)?.[1] ?? '不知道'); send({ id: m.id, result: { stopReason: 'end_turn' } }); return;
    }
    say(JSON.stringify({ mode, effort, pid: process.pid })); send({ id: m.id, result: { stopReason: 'end_turn' } }); return;
  }
  send({ id: m.id, error: { code: -32601, message: 'Method not found' } });
}).on('close', () => process.exit(0));
