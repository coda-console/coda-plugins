import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NativeAuth, pause, writePrivate } from './auth.mjs';
import { account } from './account.mjs';
import { history, messages, decode, signature, position, conversation } from './transcript.mjs';
export const SESSION = 'coda/session@1', RUN = 'coda/run@1';
export const recordId = (account, bot) => `grok-bot:${account}:${encodeURIComponent(bot)}`;
export function messageId(requestId, record, parent) {
  const b = createHash('sha256').update(JSON.stringify([parent?.kind, parent?.id, record, requestId])).digest().subarray(0, 16);
  b[6] = (b[6] & 15) | 128; b[8] = (b[8] & 63) | 128;
  const h = b.toString('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
const terminal = run => ['completed', 'failed', 'canceled'].includes(run.status.state);
export class Provider {
  constructor(coda, { auth, clock = { setTimeout, clearTimeout }, stableMs = 1000 } = {}) {
    Object.assign(this, { coda, clock, stableMs });
    this.auth = auth ?? new NativeAuth({ root: coda.plugin.state });
    this.records = new Map(); this.bots = new Map(); this.runs = new Map(); this.waiting = new Map(); this.watches = new Map();
    this.controller = new AbortController(); this.queue = Promise.resolve(); this.jobs = new Set();
    this.indexFile = join(coda.plugin.state, 'transcript-index.json');
    try { this.index = JSON.parse(readFileSync(this.indexFile, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; this.index = {}; }
    this.file = join(coda.plugin.state, 'posts.json');
    try { this.posts = JSON.parse(readFileSync(this.file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; this.posts = {}; }
  }
  schedule(fn) {
    const next = this.queue.then(fn);
    this.queue = next.catch(e => console.error('[grok-bot]', e.message));
    return next;
  }
  async start() {
    this.observers = [];
    for (const [kind, map] of [[SESSION, this.records], [RUN, this.runs]]) this.observers.push(await this.coda.protocols.observe(kind, ({ type, id, object }) => {
      if (object.provider !== this.coda.plugin.id) return;
      if (type === 'DELETED') map.delete(id);
      else if (kind === SESSION || !map.has(id)) map.set(id, object);
      this.waiting.get(id)?.(); this.waiting.delete(id);
    }, 'local'));
    for (const [id, run] of this.runs) if (!terminal(run)) await this.setRun(id, { state: 'failed', result: { code: 'unknown', message: '插件重启，发送结果未知；不会重发' } });
    this.handlers = [
      this.coda.protocols.handle(SESSION, 'read', (input, { record }) => this.read(record.id, input)),
      this.coda.protocols.handle(SESSION, 'draft', () => ({})),
      this.coda.protocols.handle(SESSION, 'post', (input, context) => {
        const job = this.post(input, context).catch(e => console.error('[grok-bot]', e.message));
        this.jobs.add(job); job.finally(() => this.jobs.delete(job));
      }),
    ];
    await this.schedule(() => this.sync());
    this.polling = this.poll();
  }
  async poll() {
    while (!this.controller.signal.aborted) {
      try { await pause(this.clock, 30_000, this.controller.signal); await this.schedule(() => this.sync()); }
      catch (e) { if (!this.controller.signal.aborted) console.error('[grok-bot]', e.message); }
    }
  }
  async sync() {
    // Login is a separate resource command; reload its file without restarting the provider.
    if (this.auth.file) {
      try { this.auth.use(JSON.parse(readFileSync(this.auth.file, 'utf8'))); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    if (!this.auth.client) return;
    try {
      const who = await account(this.auth);
      const { agents = [] } = await this.auth.client.request('ListGrokBotAgents', {});
      const listed = new Set();
      for (const bot of agents) {
        const id = recordId(who.id, bot.agentId); listed.add(id);
        this.bots.set(id, { bot: bot.agentId, self: who.id });
        const spec = { title: bot.name || bot.agentId, container: who };
        const status = { participants: [{ id: who.id, name: who.title, self: true, kind: 'person' }, { id: bot.agentId, name: spec.title, kind: 'agent' }], state: 'active' };
        const held = this.records.get(id);
        if (!held) { this.records.set(id, await this.coda.protocols.put({ kind: SESSION, id, spec, status })); await this.coda.protocols.publish(SESSION, id); }
        else {
          if (JSON.stringify(held.spec) !== JSON.stringify(spec)) this.records.set(id, await this.coda.protocols.update(SESSION, id, spec, held.revision));
          await this.write(id, { ...status, ...(held.status.head ? { head: held.status.head } : {}) });
        }
        if (!this.watches.has(id)) {
          const controller = new AbortController();
          const running = this.watch(id, controller.signal);
          this.watches.set(id, { controller, running });
        }
      }
      for (const id of this.records.keys()) if (!listed.has(id)) {
        this.watches.get(id)?.controller.abort(); this.watches.delete(id); this.bots.delete(id);
        await this.coda.protocols.delete(SESSION, id); this.records.delete(id);
      }
    } catch (e) {
      for (const id of this.records.keys()) await this.write(id, { ...this.records.get(id).status, state: 'unreachable', reason: e.status === 401 ? '请在资源页重新登录' : e.message });
    }
  }
  async write(id, status) {
    const held = this.records.get(id);
    if (!held || JSON.stringify(held.status) === JSON.stringify(status)) return;
    this.records.set(id, await this.coda.protocols.setStatus(SESSION, id, status, held.revision));
  }
  async stable(id, signal) {
    const target = this.bots.get(id);
    let previous = await history(this.auth.client, target.bot);
    for (;;) {
      await pause(this.clock, this.stableMs, signal);
      const next = await history(this.auth.client, target.bot);
      if (signature(messages(previous, target.self, target.bot)) === signature(messages(next, target.self, target.bot))) {
        const entries = next.entries.filter(conversation).map(row => {
          const key = `${id}:${next.generation}:${row.entryId}`, hash = signature(row.body);
          const previous = this.index[key];
          const seq = previous?.hash === hash ? previous.seq : String(row.updatedSeq ?? row.seq);
          this.index[key] = { hash, seq };
          return { ...row, updatedSeq: seq };
        });
        writePrivate(this.coda.plugin.state, this.indexFile, this.index);
        const rows = messages({ ...next, entries }, target.self, target.bot), head = rows.at(-1)?.cursor;
        await this.schedule(() => this.write(id, { participants: this.records.get(id).status.participants, state: 'active', ...(head ? { head } : {}) }));
        return next;
      }
      previous = next;
    }
  }
  async watch(id, signal) {
    while (!signal.aborted) {
      try {
        const baseline = await this.stable(id, signal), bot = this.bots.get(id).bot;
        const seq = baseline.entries.reduce((n, r) => BigInt(r.updatedSeq ?? r.seq) > BigInt(n) ? String(r.updatedSeq ?? r.seq) : n, '0');
        const stream = await this.auth.client.request('WatchGrokBotTranscripts', { cursors: [{ agentId: bot, sessionId: '', generation: baseline.generation, afterUpdatedSeq: seq }], includeUnlistedAgents: true, inlineBodyMaxBytes: 262144 }, { stream: true, signal });
        for await (const event of stream) {
          if (event.rows?.agentId === bot && !(event.rows.sessionId ?? '')) await this.stable(id, signal);
          if (event.cleared || event.cursorTooOld) break;
        }
      } catch (e) {
        if (signal.aborted) break;
        await this.schedule(() => this.write(id, { ...this.records.get(id)?.status, state: 'unreachable', reason: e.message }));
      }
      try { await pause(this.clock, 2000, signal); } catch { break; }
    }
  }
  async read(id, { after, before, limit = 50 } = {}) {
    if (after && before) throw new Error('after 与 before 不能同时使用');
    const target = this.bots.get(id);
    if (!target) throw new Error('会话不可用，请在资源页登录');
    const h = await history(this.auth.client, target.bot), head = this.records.get(id).status.head;
    for (const c of [after, before]) if (c && !c.startsWith(`${h.generation}:`)) throw new Error('Grok 历史已重置，请重新读取');
    h.entries = h.entries.map(row => {
      const saved = this.index[`${id}:${h.generation}:${row.entryId}`];
      return saved?.hash === signature(row.body) ? { ...row, updatedSeq: saved.seq } : row;
    });
    const rows = messages(h, target.self, target.bot).filter(m => head?.startsWith(`${h.generation}:`) && position(m.cursor) <= position(head)
      && (!after || position(m.cursor) > position(after)) && (!before || position(m.cursor) < position(before)));
    const page = after ? rows.slice(0, limit) : rows.slice(-limit);
    return { messages: page, cursor: page.at(-1)?.cursor ?? null, more: rows.length > page.length };
  }
  async setRun(id, status) {
    if (!this.runs.has(id)) await new Promise(resolve => this.waiting.set(id, resolve));
    if (terminal(this.runs.get(id))) return;
    this.runs.set(id, await this.coda.protocols.setStatus(RUN, id, status, this.runs.get(id).revision));
  }
  async post(input, { record, requestId, parent, run }) {
    const key = messageId(requestId, record.id, parent);
    if (this.posts[key]) {
      if (!this.posts[key].status && this.posts[key].run === run.id) return;
      await this.setRun(run.id, this.posts[key].status ?? { state: 'failed', result: { code: 'unknown', message: '此请求已尝试发送，不会重发' } }); return;
    }
    this.posts[key] = { run: run.id }; writePrivate(this.coda.plugin.state, this.file, this.posts);
    let attempted = false, status;
    try {
      const target = this.bots.get(record.id);
      if (!target) throw new Error('会话不可用');
      if (input.parts?.length) throw Object.assign(new Error('只支持文字'), { code: 'unsupported' });
      const h = await history(this.auth.client, target.bot);
      const all = messages(h, target.self, target.bot);
      const reply = input.replyTo && all.find(m => m.id === input.replyTo);
      if (input.replyTo && !reply) throw new Error('回复的消息不存在');
      const entry = reply && h.entries.find(r => `${h.generation}:${r.entryId}` === (reply.about?.message ?? reply.id));
      const body = entry && decode(entry), widget = body?.message?.type === 'widget' && body.message.widget;
      const option = widget && widget.options.find(o => String(o.label ?? o.value) === input.text || String(o.value) === input.text);
      if (widget && (!option || body.respondedValue !== undefined || body.widgetSkipped)) throw new Error('选项无效或此问题已回答');
      attempted = true;
      if (widget) {
        const answer = await this.auth.client.request('RespondGrokBotWidget', { agentId: target.bot, sessionId: '', entryId: entry.entryId, value: option.value });
        if (!answer.accepted) throw new Error('Grok 未确认接受选项');
      } else {
        const answer = await this.auth.client.request('SendGrokBotUserMessage', { agentId: target.bot, sessionId: '', messageId: key, text: input.text,
          ...(entry ? { replyToId: entry.entryId } : {}), sentAtMs: String(Date.now()), source: 1, initiator: 1, sendSource: 1 });
        if (!answer.dispatched) throw new Error('Grok 未确认发送');
      }
      // Confirm in the native transcript, never invent a successful message cursor.
      let found;
      for (let i = 0; i < 20 && !found; i++) {
        const current = await history(this.auth.client, target.bot);
        const row = current.entries.find(r => {
          if (!conversation(r)) return false;
          const b = decode(r);
          return widget ? r.entryId === entry.entryId && b.respondedValue === option.value : b.clientNonce === key;
        });
        if (row) found = messages({ ...current, entries: [row] }, target.self, target.bot).at(-1);
        if (!found) await pause(this.clock, 250, this.controller.signal);
      }
      if (!found) throw new Error('尚未在 transcript 确认发送结果');
      status = { state: 'completed', result: { message: { id: found.id, cursor: found.cursor } } };
    } catch (e) { status = { state: 'failed', result: { code: attempted ? 'unknown' : e.code ?? 'invalid', message: e.message } }; }
    this.posts[key] = { run: run.id, status }; writePrivate(this.coda.plugin.state, this.file, this.posts);
    await this.setRun(run.id, status);
  }
  async stop() {
    this.controller.abort(); this.auth.close();
    for (const w of this.watches.values()) w.controller.abort();
    for (const h of this.handlers ?? []) h.dispose();
    await Promise.allSettled([this.polling, ...[...this.watches.values()].map(w => w.running), ...this.jobs]);
    await this.queue;
    for (const o of this.observers ?? []) await o.dispose();
  }
}
