import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
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
    this.records = new Map(); this.bots = new Map(); this.runs = new Map(); this.waiting = new Map(); this.watches = new Map(); this.mirrors = new Map(); this.changes = new EventEmitter();
    this.controller = new AbortController(); this.queue = Promise.resolve(); this.jobs = new Set();
    this.indexFile = join(coda.plugin.state, 'transcript-index.json');
    try { this.index = JSON.parse(readFileSync(this.indexFile, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; this.index = {}; }
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
    this.coda.views.register('bind', {
      open: async view => {
        try {
          await this.schedule(() => this.bind(view.context.args?.record));
          view.postMessage({ type: 'result', text: '已发给 Bot' });
        } catch (error) {
          view.postMessage({ type: 'result', text: error.message });
        }
      },
    });
    this.polling = this.poll();
  }
  async bind(id) {
    if (!await this.sync()) throw new Error('无法刷新 Bot，请确认登录和网络后重试');
    const target = this.bots.get(id);
    if (!target || !this.records.has(id)) throw new Error('Bot 已不存在，请刷新资源页');
    const { code, addresses } = await this.coda.protocols.remoteCode(id);
    if (!addresses.length) throw new Error('Coda 尚未连接 tailnet，无法提供远端入口');
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
    const text = '请运行下面的命令绑定 Coda：\nnode coda-bot.mjs bind ' + quote(addresses[0]) + ' ' + quote(code);
    const answer = await this.auth.client.request('SendGrokBotUserMessage', {
      agentId: target.bot, sessionId: '', messageId: randomUUID(), text,
      sentAtMs: String(Date.now()), source: 1, initiator: 1, sendSource: 1,
    });
    if (!answer.dispatched) throw new Error('Grok 未确认发送绑定指令');
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
          await this.write(id, { ...status, ...this.activityStatus(id), ...(held.status.head ? { head: held.status.head } : {}) });
        }
        if (!this.watches.has(id)) {
          const controller = new AbortController();
          const running = this.watch(id, controller.signal);
          this.watches.set(id, { controller, running });
        }
      }
      for (const id of this.records.keys()) if (!listed.has(id)) {
        this.watches.get(id)?.controller.abort(); this.watches.delete(id); this.bots.delete(id); this.clearMirror(id);
        await this.coda.protocols.delete(SESSION, id); this.records.delete(id);
      }
      return true;
    } catch (e) {
      for (const id of this.records.keys()) await this.write(id, { ...this.records.get(id).status, state: 'unreachable', reason: e.status === 401 ? '请在资源页重新登录' : e.message });
    }
  }
  async write(id, status) {
    const held = this.records.get(id);
    if (!held || JSON.stringify(held.status) === JSON.stringify(status)) return;
    this.records.set(id, await this.coda.protocols.setStatus(SESSION, id, status, held.revision));
  }
  activityStatus(id) {
    const activity = this.mirrors.get(id)?.activity;
    return activity ? { activity } : {};
  }
  async updateLive(id, live) {
    const mirror = this.mirrors.get(id);
    mirror.live = live;
    // As in 0.4.0, a remembered settlement must not close active main-agent work.
    const busy = !!(live.isRunning || live.isComposingMessage || live.isRetrying || live.activity || live.awaiting);
    if (!busy && live.lastTurnSettlement) delete mirror.activity;
    else if (live.activity) {
      const a = live.activity;
      const text = a.kind === 'tool' ? a.detail || a.tool || 'Grok 活动'
        : a.kind === 'thinking' ? a.detail || 'Grok 正在思考' : undefined;
      if (text) {
        const line = text.trim().split(/[\r\n\u2028\u2029]/u)[0].trim();
        if (line) mirror.activity = { participant: this.bots.get(id).bot, text: [...line].slice(0, 200).join('') };
      }
    }
    const { activity, ...status } = this.records.get(id).status;
    await this.write(id, { ...status, ...this.activityStatus(id) });
  }
  clearMirror(id) {
    const mirror = this.mirrors.get(id);
    for (const pending of mirror?.pending.values() ?? []) this.clock.clearTimeout(pending.timer);
    this.mirrors.delete(id);
  }
  updateRows(id, entries) {
    const mirror = this.mirrors.get(id);
    for (const row of entries) {
      const old = mirror.entries.get(row.entryId);
      if (old && BigInt(old.updatedSeq ?? old.seq) >= BigInt(row.updatedSeq ?? row.seq)) continue;
      mirror.entries.set(row.entryId, row);
      if (!conversation(row)) continue;
      const pending = mirror.pending.get(row.entryId);
      if (old?.body === row.body) continue;
      if (pending) this.clock.clearTimeout(pending.timer);
      const next = { row, ready: false };
      mirror.pending.set(row.entryId, next);
      next.timer = this.clock.setTimeout(() => {
        next.ready = true;
        void this.schedule(() => this.flush(id)).catch(() => {});
      }, this.stableMs);
    }
  }
  async flush(id) {
    const mirror = this.mirrors.get(id);
    if (!mirror) return;
    const target = this.bots.get(id);
    // Do not advance past an earlier entry that is still changing.
    const pending = [...mirror.pending.values()].sort((a, b) => BigInt(a.row.updatedSeq ?? a.row.seq) < BigInt(b.row.updatedSeq ?? b.row.seq) ? -1 : 1);
    for (const item of pending) {
      if (!item.ready) break;
      const row = item.row, key = `${id}:${mirror.generation}:${row.entryId}`, hash = signature(row.body);
      const previous = this.index[key];
      const seq = previous?.hash === hash ? previous.seq : String(row.updatedSeq ?? row.seq);
      const exposed = previous?.hash === hash ? previous : {
        hash, seq, baseSeq: previous?.baseSeq ?? seq, edited: !!previous,
      };
      this.index[key] = exposed;
      const rendered = messages({ generation: mirror.generation, entries: [{ ...row, exposed }] }, target.self, target.bot);
      for (const message of rendered) mirror.messages.set(message.id, message);
      mirror.pending.delete(row.entryId);
    }
    writePrivate(this.coda.plugin.state, this.indexFile, this.index);
    const head = this.visible(id).at(-1)?.cursor;
    await this.write(id, { participants: this.records.get(id).status.participants, state: 'active', ...this.activityStatus(id), ...(head ? { head } : {}) });
    this.changes.emit(id);
  }
  visible(id) {
    const rows = [...this.mirrors.get(id).messages.values()];
    const senders = new Map(rows.map(m => [m.id, m.sender]));
    return rows.map(m => m.replyTo && senders.has(m.replyTo) ? { ...m, mentions: [senders.get(m.replyTo)] } : m)
      .sort((a, b) => position(a.cursor) < position(b.cursor) ? -1 : 1);
  }
  async watch(id, signal) {
    while (!signal.aborted) {
      try {
        const bot = this.bots.get(id).bot;
        const baseline = await history(this.auth.client, bot);
        if (signal.aborted) break;
        const previous = this.mirrors.get(id);
        this.clearMirror(id);
        this.mirrors.set(id, { generation: baseline.generation, entries: new Map(), pending: new Map(),
          messages: previous?.generation === baseline.generation ? previous.messages : new Map() });
        await this.schedule(async () => {
          const { activity, ...status } = this.records.get(id).status;
          await this.write(id, status);
        });
        this.updateRows(id, baseline.entries);
        if (!this.mirrors.get(id).pending.size) await this.schedule(() => this.flush(id));
        const seq = baseline.entries.reduce((n, r) => BigInt(r.updatedSeq ?? r.seq) > BigInt(n) ? String(r.updatedSeq ?? r.seq) : n, '0');
        const stream = await this.auth.client.request('WatchGrokBotTranscripts', { cursors: [{ agentId: bot, sessionId: '', generation: baseline.generation, afterUpdatedSeq: seq }], includeUnlistedAgents: true, inlineBodyMaxBytes: 262144 }, { stream: true, signal });
        for await (const event of stream) {
          if (event.rows?.agentId === bot && !(event.rows.sessionId ?? '')) this.updateRows(id, event.rows.entries ?? []);
          if (event.agentState) for (const live of event.agentState.live ?? [])
            if (live.agentId === bot && !(live.sessionId ?? ''))
              await this.schedule(() => this.updateLive(id, live));
          const reset = event.cleared ?? event.cursorTooOld;
          if (reset && (!reset.agentId || reset.agentId === bot) && !(reset.sessionId ?? '')) break;
        }
      } catch (e) {
        if (signal.aborted) break;
        await this.schedule(() => this.write(id, { ...this.records.get(id)?.status, state: 'unreachable', reason: e.message }));
      }
      // A disconnected stream cannot establish stability. Rebuild before exposing pending rows.
      const mirror = this.mirrors.get(id);
      for (const p of mirror?.pending.values() ?? []) this.clock.clearTimeout(p.timer);
      mirror?.pending.clear();
      try { await pause(this.clock, 2000, signal); } catch { break; }
    }
  }
  async read(id, { after, before, limit = 50 } = {}) {
    if (after && before) throw new Error('after 与 before 不能同时使用');
    const mirror = this.mirrors.get(id);
    if (!mirror) throw new Error('会话不可用，请在资源页登录');
    const head = this.records.get(id).status.head;
    for (const c of [after, before]) if (c && !c.startsWith(`${mirror.generation}:`)) throw new Error('Grok 历史已重置，请重新读取');
    const rows = this.visible(id).filter(m => head?.startsWith(`${mirror.generation}:`) && position(m.cursor) <= position(head)
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
    let attempted = false, status;
    try {
      const target = this.bots.get(record.id);
      if (!target) throw new Error('会话不可用');
      if (input.parts?.length) throw Object.assign(new Error('只支持文字'), { code: 'unsupported' });
      const h = this.mirrors.get(record.id);
      if (!h) throw new Error('会话正在连接');
      const all = this.visible(record.id);
      const reply = input.replyTo && all.find(m => m.id === input.replyTo);
      if (input.replyTo && !reply) throw new Error('回复的消息不存在');
      const entry = reply && [...h.entries.values()].find(r => `${h.generation}:${r.entryId}` === (reply.about?.message ?? reply.id));
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
      const found = await this.echo(record.id, current => {
        const row = [...current.entries.values()].find(r => {
          if (!conversation(r)) return false;
          const b = decode(r);
          return widget ? r.entryId === entry.entryId && b.respondedValue === option.value : b.clientNonce === key;
        });
        if (!row || current.pending.has(row.entryId)) return;
        const base = `${current.generation}:${row.entryId}`;
        return this.visible(record.id).find(m => widget ? m.replyTo === base && m.sender === target.self : m.id === base);
      });
      status = { state: 'completed', result: { message: { id: found.id, cursor: found.cursor } } };
    } catch (e) { status = { state: 'failed', result: { code: attempted ? 'unknown' : e.code ?? 'invalid', message: e.message } }; }
    await this.setRun(run.id, status);
  }
  echo(id, find) {
    return new Promise((resolve, reject) => {
      const signal = this.controller.signal;
      const finish = (error, message) => {
        this.clock.clearTimeout(timer); this.changes.off(id, check); signal.removeEventListener('abort', abort);
        error ? reject(error) : resolve(message);
      };
      const check = () => {
        const mirror = this.mirrors.get(id);
        const message = mirror && find(mirror);
        if (message) finish(null, message);
      };
      const abort = () => finish(new Error('发送确认已停止'));
      const timer = this.clock.setTimeout(() => finish(new Error('尚未在 transcript 确认发送结果')), 5000);
      this.changes.on(id, check); signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort(); else check();
    });
  }
  async stop() {
    this.controller.abort(); this.auth.close();
    for (const [id, w] of this.watches) { w.controller.abort(); this.clearMirror(id); }
    for (const h of this.handlers ?? []) h.dispose();
    await Promise.allSettled([this.polling, ...[...this.watches.values()].map(w => w.running), ...this.jobs]);
    await this.queue;
    for (const o of this.observers ?? []) await o.dispose();
  }
}
