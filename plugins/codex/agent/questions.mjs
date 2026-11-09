// Codex's messages to the user beside a turn (`send_user_message_async`, `request_user_input_async`, which OpenAI's model
// catalogue gives the model whatever Codex runs): each is a completed agentMessage with `delivery: "async"`, and `questions`
// when it asks, said without deltas. codex-acp 1.12.0 shows an agent message only from its deltas; the patch here says the
// text of one it streamed nothing of, with its questions under `_meta.coda.asyncQuestions` (through unrecognized.mjs, which
// says the text of any other such message too). Codex's turn goes on without
// the answer, which reaches it as a later user message. CodexQuestions asks Coda one form per call, the way Claude's
// AskUserQuestion is asked (docs/agent-protocol.md「Claude 的提问」), and keeps Coda's turn going until every card of it has
// its answer: given to Codex by steering while codex-acp's prompt runs, else as a prompt of the entry's own, whose output
// and end are the same Coda turn's. Fails loudly once the adapter changes.
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const none = { agent: [], coda: [] };
export const OTHER = 'coda:other';
// The ids of what the entry asks itself, of Coda (the cards) and of codex-acp (steering, prompts).
const OWN = 'coda-codex-question:';
const own = message => !('method' in message) && typeof message.id === 'string' && message.id.startsWith(OWN);

// The update said of a completed agent message: none unless it is async; its text unless that was streamed.
export function codexAsyncMessage(item, streamed) {
  const questions = item.questions?.length ? item.questions : null;
  if (item.delivery !== 'async' || (streamed && !questions)) return null;
  return { sessionUpdate: 'agent_message_chunk', messageId: item.id, content: { type: 'text', text: streamed ? '' : item.text },
    ...(questions ? { _meta: { coda: { asyncQuestions: questions } } } : {}) };
}

const patches = [
  ['  agentMessagePhases = /* @__PURE__ */ new Map();\n', before => `${before}  codaStreamedMessages = /* @__PURE__ */ new Set();\n`],
  ['  async createTextEvent(event) {\n', before => `${before}    this.codaStreamedMessages.add(event.itemId);\n`],
  [`        return this.subagents.legacyCollaborationCompleted(event.item);
      case "agentMessage":
        this.rememberAgentMessagePhase(event.item);
        return null;`, before => before.replace('return null;', 'return codexAgentMessage(event.item, this.codaStreamedMessages.delete(event.item.id));')],
];
export function shownCodexAsyncMessages(source) {
  for (const [before, after] of patches) {
    if (source.split(before).length !== 2) throw new Error('codex-acp async message patch no longer matches the locked adapter');
    source = source.replace(before, after(before));
  }
  return `import { codexAgentMessage } from ${JSON.stringify(new URL('./unrecognized.mjs', import.meta.url).href)};\n${source.replace(/^#![^\n]*\n/, '')}`;
}

// One call's questions as a form: question i is the required field `q{i}`, its options a choice with one more for an answer
// written in `q{i}_other`; without options it is text.
export function questionForm(sessionId, questions) {
  const properties = {};
  questions.forEach((q, i) => {
    if (!q.options?.length) { properties[`q${i}`] = { type: 'string', title: q.title }; return; }
    properties[`q${i}`] = { type: 'string', title: q.title,
      oneOf: [...q.options.map(option => ({ const: option, title: option })), { const: OTHER, title: '其他（写在下面）' }] };
    properties[`q${i}_other`] = { type: 'string', title: '其他' };
  });
  return { sessionId, mode: 'form', message: 'Codex 需要你的回答', requestedSchema: { type: 'object', properties, required: questions.map((_, i) => `q${i}`) } };
}

// What the user said to a card, as the message Codex is told, a line a question.
export function answerText(questions, response) {
  const content = response?.action === 'accept' && record(response.content) ? response.content : null;
  return questions.map((q, i) => {
    if (!content) return `用户没有回答「${q.title}」`;
    const value = content[`q${i}`], other = String(content[`q${i}_other`] ?? '').trim();
    return `回答你的提问「${q.title}」：${value === OTHER ? other || '其他' : value}`;
  }).join('\n');
}

export class CodexQuestions {
  constructor() {
    // Coda's turn: its prompt, the codex-acp prompt running in it, its cards and steering in flight by id, the answers
    // waiting for codex-acp's prompt to end, codex-acp's last reply, and whether a cancel withdrew what it waited for.
    this.turn = null; this.next = 0;
  }
  // What Coda says: `agent`, what codex-acp is told; `coda`, what Coda is told here.
  fromCoda(message) {
    const turn = this.turn;
    if (message.method === 'session/prompt') {
      this.turn = { id: message.id, sessionId: message.params?.sessionId, running: message.id, cards: new Map(), steers: new Map(), queued: [], reply: null, cancelled: false };
      return { agent: [message], coda: [] };
    }
    if (own(message)) {
      const questions = turn?.cards.get(message.id);
      if (!questions) return none;
      turn.cards.delete(message.id);
      return this.deliver(answerText(questions, message.result));
    }
    if (!turn) return { agent: [message], coda: [] };
    // Unanswered cards are withdrawn; the turn ends once codex-acp's prompt does, or now when none runs, as cancelled when
    // it waited for any.
    if (message.method === 'session/cancel') {
      const withdrawn = [...turn.cards.keys()].map(id => ({ jsonrpc: '2.0', method: '$/cancel_request', params: { id } }));
      turn.cancelled ||= turn.cards.size + turn.steers.size + turn.queued.length > 0;
      turn.cards.clear(); turn.steers.clear(); turn.queued = [];
      if (turn.running) return { agent: [message], coda: withdrawn };
      this.turn = null;
      return { agent: [message], coda: [...withdrawn, { jsonrpc: '2.0', id: turn.id, result: { stopReason: 'cancelled' } }] };
    }
    // Codex has stopped while its cards wait: the message runs as the turn's next prompt.
    if (message.method === '_session/steering' && !turn.running) {
      return { agent: [this.prompt(message.params.prompt)], coda: [{ jsonrpc: '2.0', id: message.id, result: { outcome: 'injected' } }] };
    }
    return { agent: [message], coda: [] };
  }
  // What codex-acp says, as said to Coda.
  fromAgent(message) {
    const turn = this.turn;
    if ('id' in message && !('method' in message)) {
      if (turn && message.id === turn.running) { turn.running = null; turn.reply = message; return this.settle(); }
      if (turn?.steers.has(message.id)) {
        const text = turn.steers.get(message.id);
        turn.steers.delete(message.id);
        if (message.result?.outcome !== 'injected') turn.queued.push(text);
        return this.settle();
      }
      return own(message) ? none : { agent: [], coda: [message] };
    }
    const u = message.params?.update, questions = u?._meta?.coda?.asyncQuestions;
    if (message.method !== 'session/update' || !questions) return { agent: [], coda: [message] };
    const { _meta, ...update } = u;
    const said = update.content.text ? [{ ...message, params: { ...message.params, update } }] : [];
    if (!turn) return { agent: [], coda: said };
    const id = `${OWN}${this.next++}`;
    turn.cards.set(id, questions);
    return { agent: [], coda: [...said, { jsonrpc: '2.0', id, method: 'elicitation/create', params: questionForm(turn.sessionId, questions) }] };
  }
  // An answer goes into the running prompt's turn, else runs as the next prompt.
  deliver(text) {
    const turn = this.turn;
    if (!turn.running) { turn.queued.push(text); return this.settle(); }
    const id = `${OWN}${this.next++}`;
    turn.steers.set(id, text);
    return { agent: [{ jsonrpc: '2.0', id, method: '_session/steering',
      params: { sessionId: turn.sessionId, prompt: [{ type: 'text', text }], _meta: { steering: { idleBehavior: 'promptRequired' } } } }], coda: [] };
  }
  // With no prompt running: the answers waiting run as one; else Coda's turn ends with the last reply once nothing waits.
  settle() {
    const turn = this.turn;
    if (turn.running) return none;
    if (turn.queued.length) {
      const text = turn.queued.join('\n');
      turn.queued = [];
      return { agent: [this.prompt([{ type: 'text', text }])], coda: [] };
    }
    if (turn.cards.size || turn.steers.size) return none;
    this.turn = null;
    return { agent: [], coda: [turn.cancelled ? { jsonrpc: '2.0', id: turn.id, result: { stopReason: 'cancelled' } } : { ...turn.reply, id: turn.id }] };
  }
  prompt(prompt) {
    const id = `${OWN}${this.next++}`;
    this.turn.running = id;
    return { jsonrpc: '2.0', id, method: 'session/prompt', params: { sessionId: this.turn.sessionId, prompt } };
  }
}
