// What the plugin's lifecycle process (.coda/workflows/claude-compaction.bpmn, setting `claude.idleCompaction`) decides by
// whether to compact a session before the prompt cache of its main thread expires, told to Coda with each turn's usage
// (`usage_update` `_meta.coda`, which Coda passes on as the session's fact `usage`): when that cache was last used (the turn's
// last request), how large the context it carries is, how long it lasts, and when the session was last compacted — by Claude
// Code, by /compact or as asked —, which none is to follow. The process decides; the session only compacts when asked
// (`_coda/session/compact`).
export class CacheUse {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    // The last request of the main thread, that of the last turn's, and the last compaction.
    this.cache = null; this.context = null; this.lastRequest = null; this.turn = null; this.compactedAt = null;
  }
  // A main-thread request: its cache is kept from now.
  requested() { this.lastRequest = this.now(); }
  // A main-thread response's usage: the context it carried, and how long what it wrote to the cache lasts. One that wrote
  // nothing says nothing of that; one that wrote any for five minutes has that much gone in five.
  used(usage) {
    if (!usage) return;
    const context = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
    if (context) this.context = context;
    const written = usage.cache_creation ?? {};
    if (written.ephemeral_5m_input_tokens) this.cache = 'PT5M';
    else if (written.ephemeral_1h_input_tokens) this.cache = 'PT1H';
  }
  // Another query of the session (another model, another service): what its cache is is not known until it answers.
  restarted() { this.cache = null; }
  // The session compacted, by Claude Code, by /compact or as asked: its context is what the summary left.
  compacted(tokens) { this.context = Number.isFinite(tokens) ? tokens : null; this.compactedAt = this.now(); }
  // A turn of the session ended (not a compaction's): its cache runs from its last request.
  ended() { this.turn = this.lastRequest; }
  // What Coda is told, what is known of it.
  told() {
    return { ...(this.turn !== null ? { lastRequestAt: new Date(this.turn).toISOString() } : {}),
      ...(this.context !== null ? { contextTokens: this.context } : {}), ...(this.cache ? { cacheTtl: this.cache } : {}),
      ...(this.compactedAt !== null ? { compactedAt: new Date(this.compactedAt).toISOString() } : {}) };
  }
}
