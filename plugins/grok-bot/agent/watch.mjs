import { createHash } from 'node:crypto';
import { pause } from './auth.mjs';
import { ConnectionHealth, authenticationError } from './health.mjs';

export const TRANSCRIPT_CACHE_LIMIT = 2000;

export function decode(entry) {
  if (entry.bodyOmitted) throw new Error('原生 transcript 正文被省略，无法交付；请在 Grok 客户端查看');
  try { return JSON.parse(Buffer.from(entry.body, 'base64').toString('utf8')); }
  catch { throw new Error('无法解析 Grok transcript 正文'); }
}
export const sequence = entries => entries.reduce((n, e) => BigInt(e.updatedSeq ?? 0) > BigInt(n) ? String(e.updatedSeq) : n, '0');
// A single connection owns a Bot's main transcript. The adapter serializes
// events; reconnects use the committed cursor, never resend user messages.
export class NativeWatch {
  constructor({ client, bot, saved, clock, commit, event, error, recovered, log }) {
    Object.assign(this, { client, bot, saved, clock, commit, event, error, recovered, log });
    this.health = new ConnectionHealth({ error, recovered, log });
    this.controller = new AbortController();
  }
  async history({ all = false } = {}) {
    const entries = [];
    let beforeSeq, generation;
    for (;;) {
      const page = await this.client.request('ListGrokBotTranscriptEntries', { agentId: this.bot, sessionId: '', limit: 1000,
        ...(beforeSeq ? { beforeSeq, generation } : {}) }, { signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(30_000)]) });
      if (generation !== undefined && generation !== (page.generation ?? 0)) throw new Error('Grok 历史在分页时已重置，重新连接后核对');
      generation = page.generation ?? 0;
      const rows = page.entries ?? [];
      entries.push(...rows);
      if (!all || rows.length < 1000) break;
      const next = rows.reduce((n, r) => BigInt(r.seq) < BigInt(n) ? r.seq : n, rows[0].seq);
      if (beforeSeq && BigInt(next) >= BigInt(beforeSeq)) throw new Error('Grok 历史分页游标没有前进');
      beforeSeq = next;
    }
    return { entries, generation };
  }
  async start() {
    if (!this.saved.stream) {
      const h = await this.history();
      // Existing Grok history is a baseline, not a new autonomous run.
      this.saved.stream = { generation: h.generation ?? 0, afterUpdatedSeq: sequence(h.entries ?? []), seen: {}, hashes: {}, baselineAt: Date.now() };
      for (const row of h.entries ?? []) {
        this.saved.stream.seen[row.entryId] = String(row.updatedSeq ?? row.seq);
        this.saved.stream.hashes[row.entryId] = createHash('sha256').update(row.body ?? '').digest('hex');
      }
      this.commit();
    }
    if (this.trim()) this.commit();
    this.running = this.loop();
  }
  trim() {
    const state = this.saved.stream;
    const oldSize = Object.keys(state.seen).length;
    const oldHashSize = Object.keys(state.hashes ?? {}).length;
    const ids = Object.keys(state.seen).sort((a, b) => BigInt(state.seen[a]) > BigInt(state.seen[b]) ? -1 : 1).slice(0, TRANSCRIPT_CACHE_LIMIT);
    state.seen = Object.fromEntries(ids.map(id => [id, state.seen[id]]));
    state.hashes = Object.fromEntries(ids.map(id => [id, state.hashes?.[id]]));
    return oldSize !== ids.length || oldHashSize !== ids.length;
  }
  async rows(rows) {
    if (rows.agentId !== this.bot || (rows.sessionId ?? '') !== '') return;
    const state = this.saved.stream;
    const through = BigInt(rows.replayThrough ?? state.afterUpdatedSeq);
    let changed = false;
    try {
      for (const row of [...(rows.entries ?? [])].sort((a, b) => BigInt(a.updatedSeq) < BigInt(b.updatedSeq) ? -1 : 1)) {
        const seq = String(row.updatedSeq ?? row.seq);
        // Eviction must not turn normal history reconciliation into replay.
        if (state.seen[row.entryId] === undefined && !rows.newGeneration && BigInt(seq) <= through) continue;
        if (state.seen[row.entryId] !== undefined && BigInt(state.seen[row.entryId]) >= BigInt(seq)) continue;
        const body = decode(row);
        const hash = createHash('sha256').update(row.body).digest('hex');
        if (state.hashes[row.entryId] !== hash && !(rows.replay && body.timestampMs < state.baselineAt && !state.seen[row.entryId]))
          await this.event({ entry: { row, body } });
        state.hashes[row.entryId] = hash;
        state.seen[row.entryId] = seq;
        if (BigInt(seq) > BigInt(state.afterUpdatedSeq)) state.afterUpdatedSeq = seq;
        changed = true;
      }
    } finally {
      // Commit delivered rows once per batch, including a partial batch whose
      // later entry failed. Keep only the newest updatedSeq IDs and hashes.
      if (changed) { this.trim(); this.commit(); }
    }
    await this.event({ checkpoint: true });
  }
  async reconcile() {
    const history = await this.history();
    await this.rows({ agentId: this.bot, entries: history.entries });
  }
  async loop() {
    const signal = this.controller.signal;
    while (!signal.aborted) {
      try {
        const stream = await this.client.request('WatchGrokBotTranscripts', {
          cursors: [{ agentId: this.bot, sessionId: '', generation: this.saved.stream.generation, afterUpdatedSeq: this.saved.stream.afterUpdatedSeq }],
          includeUnlistedAgents: true, inlineBodyMaxBytes: 262144,
        }, { stream: true, signal });
        for await (const value of stream) {
          if (signal.aborted) break;
          if (value.connected) await this.event({ connected: true });
          const reset = value.cleared ?? value.cursorTooOld;
          if (reset && (!reset.agentId || reset.agentId === this.bot) && (reset.sessionId ?? '') === '') {
            const history = await this.history({ all: true });
            const previous = this.saved.stream;
            const newGeneration = previous.generation !== (history.generation ?? 0);
            const replayThrough = previous.afterUpdatedSeq;
            this.saved.stream.generation = history.generation ?? 0;
            if (newGeneration) this.saved.stream.seen = {};
            this.saved.stream.afterUpdatedSeq = '0';
            // Keep IDs across cursor resets; the new stream replays history.
            await this.rows({ agentId: this.bot, entries: history.entries, replay: true, replayThrough, newGeneration });
            this.saved.stream.afterUpdatedSeq = sequence(history.entries);
            this.trim(); this.commit();
            this.log('原生游标已重置，静默重连');
            break;
          }
          if (value.rows) await this.rows(value.rows);
          if (value.agentState) for (const live of value.agentState.live ?? [])
            if (live.agentId === this.bot && (live.sessionId ?? '') === '')
              await this.event({ live, snapshot: !!value.agentState.snapshot });
          if (value.agentStateChanged?.agentId === this.bot && value.agentStateChanged.families?.some(f => ['subagents', 'automations'].includes(f)))
            await this.event({ routinesChanged: true });
          if (value.turnFailed?.agentId === this.bot && (value.turnFailed.sessionId ?? '') === '') await this.event({ failed: value.turnFailed });
          if (value.heartbeat) await this.event({ heartbeat: value.heartbeat });
          if (value.heartbeat || value.rows || value.agentState) this.health.success();
        }
        if (signal.aborted) break;
        this.log('原生订阅正常结束，静默重连');
        this.health.success();
      } catch (error) {
        if (signal.aborted) break;
        this.health.failure(error);
        // Authentication errors need a new official login, not a retry loop.
        if (authenticationError(error)) break;
      }
      try { await pause(this.clock, this.health.delay, signal); }
      catch { break; }
    }
  }
  close() { this.controller.abort(); }
}
