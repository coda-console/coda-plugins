import { kimiDisplayNames } from './display.mjs';
// Between Coda and `kimi acp`, a message at a time: everything passes as said, in order, and what Kimi keeps going beside a
// turn, read from its files (observe.mjs), is told to Coda as waits (waits.mjs). Its files are read once the session is
// known, again whenever they change, at most once every `every`, and before Kimi's answer to a prompt is passed on, so
// that what that turn took up is not left as if Kimi still had it to handle. A message Kimi sends outside a prompt while
// nothing is handled may begin a turn of its own: it waits for a look too, so that what Kimi handles there is told first.
// The turns Kimi's ACP does not tell, its goal's and those of prompts it queued behind them, are told from its files too
// (turns.mjs): an answer Kimi gave at once to a prompt in which it said nothing waits for that look, and is held if Kimi
// has not run the prompt yet.
// Nothing waits on a look longer than `hold`. CODA_DISABLE_RUNTIME_PATCHES=kimi leaves a plain relay. A known quota error in
// a prompt's answer is classified at this boundary (errors.mjs), without retrying or changing other errors; an `end_turn`
// Kimi gave to a prompt whose turn its files say failed is passed on as that failure. A Kimi whose files are not as understood
// (another version, another layout) is relayed as it would be anyway, but said so once a session and way, to a Coda that takes
// it (`_coda/unrecognized`, docs/agent-protocol.md「没适配的东西」): the user is told what goes unseen.
import { classifyKimiError, failedAnswer } from './errors.mjs';
import { SUPPORTED, kimiSession } from './observe.mjs';
import { KimiWaits } from './waits.mjs';
import { KimiTurns } from './turns.mjs';

const record = value => value && typeof value === 'object' && !Array.isArray(value);
// What Kimi says in a turn, as opposed to what it says of the session.
const SAID = new Set(['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update', 'plan']);
// Each way Kimi's files are not as understood (observe.mjs), by the name it is told by.
const UNREAD = { 'files:version': '这个版本的 Kimi 没有核对过', 'files:state.version': '会话的 state.json 版本对不上',
  'files:wire.protocol_version': '主 Agent 的 wire 协议版本对不上', 'files:layout': '会话文件的布局对不上' };

export class KimiRelay {
  // `say`: a message to Coda; `tell`: one to Kimi.
  constructor({ say, tell, env = process.env, startedAt = Date.now(), every = 2_000, hold = 500, session = kimiSession }) {
    this.say = say; this.tell = tell; this.env = env; this.startedAt = startedAt; this.every = every; this.hold = hold; this.makeSession = session;
    this.plain = (env.CODA_DISABLE_RUNTIME_PATCHES ?? '').split(',').map(s => s.trim()).includes('kimi');
    // Coda's requests whose answers are read here, by id; the prompts going, each with when it was sent and whether Kimi
    // said nothing in it yet.
    this.asked = new Map(); this.prompts = new Set(); this.sent = new Map();
    // Whether Coda takes what is not understood, and what it was told, by session and name.
    this.taken = false; this.told = new Set();
    this.version = null; this.session = null; this.waits = null; this.turns = null; this.content = [];
    // What Kimi said, passed on in order behind any message that waits for a look.
    this.queue = Promise.resolve();
    this.looking = null; this.again = false; this.lookedAt = -Infinity; this.timer = null; this.watching = null; this.closed = false;
  }
  fromCoda(message) {
    if (!this.plain && 'id' in message && typeof message.method === 'string') {
      if (message.method === 'initialize') {
        this.asked.set(message.id, { initialize: true });
        this.taken = record(message.params?.clientCapabilities?._meta?.coda?.unrecognized);
      } else if (['session/new', 'session/load'].includes(message.method)) this.asked.set(message.id, { cwd: message.params?.cwd, sessionId: message.params?.sessionId });
      else if (message.method === 'session/prompt') {
        this.asked.set(message.id, { prompt: true }); this.prompts.add(message.id); this.sent.set(message.id, { at: Date.now(), quiet: true });
      }
    }
    this.tell(message);
    if (message.method === 'session/cancel' && this.turns) for (const answer of this.turns.cancel()) {
      this.prompts.delete(answer.id);
      this.queue = this.queue.then(() => this.say(answer));
    }
  }
  fromAgent(message) {
    if (!record(message)) return;
    message = kimiDisplayNames(message);
    const answer = 'id' in message && !('method' in message), asked = answer ? this.asked.get(message.id) : undefined;
    if (asked) this.asked.delete(message.id);
    if (asked?.initialize && record(message.result)) {
      this.version = message.result.agentInfo?.version ?? null;
      // It reports its waits, for the version whose files are understood.
      if (this.version === SUPPORTED) {
        const capabilities = record(message.result.agentCapabilities) ? message.result.agentCapabilities : {};
        const meta = record(capabilities._meta) ? capabilities._meta : {};
        message = { ...message, result: { ...message.result, agentCapabilities: { ...capabilities, _meta: { ...meta, coda: { waits: {} } } } } };
      }
    }
    const sent = asked?.prompt ? this.sent.get(message.id) : undefined;
    if (asked?.prompt) { this.prompts.delete(message.id); this.sent.delete(message.id); message = classifyKimiError(message); }
    else if (message.method === 'session/update' && SAID.has(message.params?.update?.sessionUpdate)) for (const going of this.sent.values()) going.quiet = false;
    const waiting = asked?.prompt || (!answer && !this.prompts.size && this.waits && !this.waits.handling && Date.now() >= this.lookedAt + this.every);
    this.queue = this.queue.then(async () => {
      if (waiting) await this.look({ fresh: !!asked?.prompt });
      if (sent?.quiet && message.result?.stopReason === 'end_turn' && this.turns?.hold(sent.at, message)) { this.prompts.add(message.id); return; }
      const failure = sent && message.result?.stopReason === 'end_turn' ? this.turns?.failure(sent.at) : null;
      if (failure) message = failedAnswer(message, failure);
      this.say(message);
      const sessionId = asked && !('error' in message) ? message.result?.sessionId ?? asked.sessionId : undefined;
      if (typeof sessionId === 'string') this.begin(sessionId, asked.cwd);
    }).catch(() => {});
  }
  begin(sessionId, cwd) {
    this.unfollow();
    this.session = this.makeSession({ sessionId, cwd, env: this.env, version: this.version, startedAt: this.startedAt,
      unread: reason => this.unread(sessionId, reason) });
    this.waits = new KimiWaits({ sessionId, startedAt: this.startedAt });
    this.turns = new KimiTurns({ sessionId, startedAt: this.startedAt });
    this.observe();
  }
  // A look at the session's files that found them not as understood (`name`, observe.mjs), told once.
  unread(sessionId, name) {
    const key = `${sessionId}\n${name}`;
    if (!Object.hasOwn(UNREAD, name) || !this.taken || this.told.has(key)) return;
    this.told.add(key);
    this.say({ jsonrpc: '2.0', method: '_coda/unrecognized', params: { sessionId, kind: 'output', name, lost: true,
      detail: `Kimi ${this.version ?? '（版本未知）'}：${UNREAD[name]}（核对过的是 ${SUPPORTED}），后台任务、子 Agent、定时看不见，失败的一轮可能显示成成功` } });
  }
  // Waits, at most `hold`, for a look at the files: one begun after this, when `fresh`.
  look({ fresh = false } = {}) {
    if (!this.session) return;
    const looked = fresh && this.looking ? this.looking.then(() => this.observe()) : this.observe();
    let timer;
    return Promise.race([looked, new Promise(resolve => { timer = setTimeout(resolve, this.hold); })]).finally(() => clearTimeout(timer));
  }
  // The look going, or a new one. What it finds is told as soon as it is found.
  observe() {
    if (this.looking || this.closed || !this.session) return this.looking;
    const session = this.session, waits = this.waits, turns = this.turns, promptActive = this.prompts.size > 0;
    this.lookedAt = Date.now();
    this.looking = session.observe({ signal: new AbortController().signal, emit: (update, sessionId, taskId) => this.content.push({ update, sessionId, taskId }) })
      .then(facts => {
        if (this.closed || session !== this.session) return;
        const told = facts ? [...waits.read(facts, this.content.splice(0), { promptActive }), ...turns.read(facts.main)] : [...waits.lost(), ...turns.lost()];
        for (const message of told) {
          // A held prompt's answer, now due.
          if ('id' in message) this.prompts.delete(message.id);
          this.say(message);
        }
        if (facts) this.follow();
      }, () => {})
      .finally(() => {
        this.looking = null;
        if (this.again) { this.again = false; this.noticed(); }
      });
    return this.looking;
  }
  // Once a look found its files, their changes have them looked at again.
  follow() {
    if (this.watching || this.closed) return;
    this.watching = this.session.watch?.(() => this.noticed(), () => { this.watching = null; this.noticed(); }) ?? null;
  }
  unfollow() { this.watching?.close(); this.watching = null; }
  noticed() {
    if (this.closed || this.timer) return;
    if (this.looking) { this.again = true; return; }
    this.timer = setTimeout(() => { this.timer = null; this.observe(); }, Math.max(0, this.lookedAt + this.every - Date.now()));
  }
  // Everything Kimi said has been passed on.
  drained() { return this.queue; }
  close() { this.closed = true; this.unfollow(); clearTimeout(this.timer); this.timer = null; }
}
