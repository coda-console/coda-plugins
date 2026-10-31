import { kimiDisplayNames } from './display.mjs';
// Between Coda and `kimi acp`, a message at a time: everything passes as said, in order, and what Kimi keeps going beside a
// turn, read from its files (observe.mjs), is told to Coda as waits (waits.mjs). Its files are read once the session is
// known, again whenever they change, at most once every `every`, and before Kimi's answer to a prompt is passed on, so
// that what that turn took up is not left as if Kimi still had it to handle. A message Kimi sends outside a prompt while
// nothing is handled may begin a turn of its own: it waits for a look too, so that what Kimi handles there is told first.
// Nothing waits on a look longer than `hold`. CODA_DISABLE_RUNTIME_PATCHES=kimi leaves a plain relay, but for Coda's session
// instructions, which go in front of a new session's first prompt either way (instructions.mjs). A known quota error in
// a prompt's answer is classified at this boundary (errors.mjs), without retrying or changing other errors.
import { SessionInstructions } from './instructions.mjs';
import { classifyKimiError } from './errors.mjs';
import { SUPPORTED, kimiSession } from './observe.mjs';
import { KimiWaits } from './waits.mjs';

const record = value => value && typeof value === 'object' && !Array.isArray(value);

export class KimiRelay {
  // `say`: a message to Coda; `tell`: one to Kimi.
  constructor({ say, tell, env = process.env, startedAt = Date.now(), every = 2_000, hold = 500, session = kimiSession }) {
    this.say = say; this.tell = tell; this.env = env; this.startedAt = startedAt; this.every = every; this.hold = hold; this.makeSession = session;
    this.plain = (env.CODA_DISABLE_RUNTIME_PATCHES ?? '').split(',').map(s => s.trim()).includes('kimi');
    // Coda's requests whose answers are read here, by id; the prompts going.
    this.asked = new Map(); this.prompts = new Set();
    this.version = null; this.session = null; this.waits = null; this.content = []; this.instructions = new SessionInstructions();
    // What Kimi said, passed on in order behind any message that waits for a look.
    this.queue = Promise.resolve();
    this.looking = null; this.again = false; this.lookedAt = -Infinity; this.timer = null; this.watching = null; this.closed = false;
  }
  fromCoda(message) {
    const { agent, coda } = this.instructions.fromCoda(message);
    if (coda) { this.queue = this.queue.then(() => this.say(coda)); return; }
    message = agent;
    if (!this.plain && 'id' in message && typeof message.method === 'string') {
      if (message.method === 'initialize') this.asked.set(message.id, { initialize: true });
      else if (['session/new', 'session/load'].includes(message.method)) this.asked.set(message.id, { cwd: message.params?.cwd, sessionId: message.params?.sessionId });
      else if (message.method === 'session/prompt') { this.asked.set(message.id, { prompt: true }); this.prompts.add(message.id); }
    }
    this.tell(message);
  }
  fromAgent(message) {
    if (!record(message)) return;
    message = kimiDisplayNames(this.instructions.fromAgent(message));
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
    if (asked?.prompt) { this.prompts.delete(message.id); message = classifyKimiError(message); }
    const waiting = asked?.prompt || (!answer && !this.prompts.size && this.waits && !this.waits.handling && Date.now() >= this.lookedAt + this.every);
    this.queue = this.queue.then(async () => {
      if (waiting) await this.look({ fresh: !!asked?.prompt });
      this.say(message);
      const sessionId = asked && !('error' in message) ? message.result?.sessionId ?? asked.sessionId : undefined;
      if (typeof sessionId === 'string') this.begin(sessionId, asked.cwd);
    }).catch(() => {});
  }
  begin(sessionId, cwd) {
    this.unfollow();
    this.session = this.makeSession({ sessionId, cwd, env: this.env, version: this.version, startedAt: this.startedAt });
    this.waits = new KimiWaits({ sessionId, startedAt: this.startedAt });
    this.observe();
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
    const session = this.session, waits = this.waits, promptActive = this.prompts.size > 0;
    this.lookedAt = Date.now();
    this.looking = session.observe({ signal: new AbortController().signal, emit: (update, sessionId, taskId) => this.content.push({ update, sessionId, taskId }) })
      .then(facts => {
        if (this.closed || session !== this.session) return;
        for (const message of facts ? waits.read(facts, this.content.splice(0), { promptActive }) : waits.lost()) this.say(message);
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
