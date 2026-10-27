// Compacting a session before the prompt cache of its main thread expires, when Coda asks (`_coda/session/compact`): the
// plugin's lifecycle process (.coda/workflows/claude-compaction.bpmn, setting `claude.idleCompaction`) asks once the session
// has been still for most of an hour and is to go on later. Whether it is worth it is told here, where the cache is known:
// the summary is made from the cache still warm, and the turn that takes the session up again writes that summary to the
// cache rather than the whole conversation.
// As Claude Code's own idle compaction (2.1.296, behind a flag of Anthropic's): only a cache of an hour, from nine tenths of
// it on and not when it is about to go (the machine slept, the lifecycle came late), not for a context too small to be worth
// a summary, and not while the plan's limits are near. A turn is compacted once at most.
const TTL = 3_600_000, FROM = TTL * 0.9, UNTIL = TTL - 120_000;
export const MIN_CONTEXT = 150_000;
const mark = time => `<t:${new Date(time).toISOString()}>`;

export class IdleCompaction {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    // The last request of the main thread, that of the last turn's, and the turn compacted.
    this.cache = null; this.context = 0; this.lastRequest = null; this.turn = null; this.compactedTurn = null;
  }
  // A main-thread request: its cache is kept from now.
  requested() { this.lastRequest = this.now(); }
  // A main-thread response's usage: the context it carried, and how long what it wrote to the cache lasts. One that wrote
  // nothing says nothing of that; one that wrote any for five minutes has that much gone long before this would compact.
  used(usage) {
    if (!usage) return;
    const context = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
    if (context) this.context = context;
    const written = usage.cache_creation ?? {};
    if (written.ephemeral_5m_input_tokens) this.cache = '5m';
    else if (written.ephemeral_1h_input_tokens) this.cache = '1h';
  }
  // Another query of the session (another model, another service): what its cache is is not known until it answers.
  restarted() { this.cache = null; }
  // The session compacted, by Claude Code or here: its context is what the summary left.
  compacted(tokens) { this.context = Number.isFinite(tokens) ? tokens : 0; }
  // A turn of the session ended (not one of the compaction's): its cache runs from its last request.
  ended() { this.turn = this.lastRequest; }
  // Why the session is not to be compacted now, as Coda's answer says it ({ reason, dueAt? }); null when it is.
  // `busy`: a turn goes or is about to; `wakes(until)`: something of its own wakes Claude by then, whose turn uses the cache;
  // `limited`: the plan's limits are near.
  refusal({ busy, wakes, limited }) {
    const turn = this.turn;
    if (turn === null) return { reason: '会话还没有结束过一轮' };
    if (turn === this.compactedTurn) return { reason: '这一轮之后已经压缩过' };
    if (this.cache !== '1h') return { reason: this.cache === '5m' ? '缓存是 5 分钟的，早已过期' : '还不知道缓存能留多久' };
    if (this.context < MIN_CONTEXT) return { reason: `上下文 ${this.context} token，不到 ${MIN_CONTEXT}，不值得压缩` };
    if (limited) return { reason: '额度接近上限' };
    const since = this.now() - turn;
    if (since < FROM) return { reason: `缓存最后一次用在 ${mark(turn)}，${mark(turn + FROM)} 才快过期`, dueAt: new Date(turn + FROM).toISOString() };
    if (since >= UNTIL) return { reason: `缓存最后一次用在 ${mark(turn)}，到 ${mark(turn + TTL)} 就过期，来不及压缩` };
    if (busy) return { reason: '会话正在进行一轮' };
    if (wakes(turn + TTL)) return { reason: '缓存过期前 Claude 会被唤醒，那一轮会用上缓存' };
    return null;
  }
}
