import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CodaMcp } from './mcp.mjs';
import { bindingGuide } from './setup.mjs';
import { NativeAuth } from './auth.mjs';
import { NativeWatch } from './watch.mjs';
import { RoutineWatch } from './routines.mjs';

const MODEL = { id: 'model', name: '模型', category: 'model', type: 'select', currentValue: 'grok-bot', options: [{ value: 'grok-bot', name: 'Grok Bot' }] };
const READ = new Set(['read_thread', 'read_tool_call', 'agents', 'status', 'workflow_status', 'workflow_list', 'machines', 'machine_diagnostics']);
const WRITE = new Set(['new_session', 'send']);
const DIAGNOSTICS = new Set(['machines', 'machine_diagnostics']);
const fail = message => { throw Object.assign(new Error(message), { code: -32602 }); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
export const SETTLEMENT_GRACE_MS = 5000;
export const SUBMISSION_WAIT_MS = 20_000;
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function requestId(turn, name, args) {
  const { turn: _ticket, requestId: _request, ...input } = args;
  const bytes = createHash('sha256').update(canonical([turn.id, name, input])).digest().subarray(0, 16);
  // UUIDv8: a custom SHA-256-derived identifier, with UUID version/variant bits.
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function duration(value = 'PT30M') {
  const m = /^P(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value);
  const ms = m && m.slice(1).reduce((sum, n, i) => sum + Number(n ?? 0) * [604800000, 86400000, 3600000, 60000, 1000][i], 0);
  if (!(ms > 0 && ms <= 2147483647)) fail('turnTimeout 须为正的周、日、时、分、秒时长，且不超过 24 天');
  return ms;
}
function url(value) {
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) fail('地址必须是无用户名和密码的 HTTP(S) URL');
  return parsed;
}

export class Adapter {
  constructor({ rpc, env = process.env, fetcher = fetch, clock = { setTimeout, clearTimeout, now: Date.now }, submissionWaitMs = SUBMISSION_WAIT_MS, log = text => console.error(text), mcpFactory = (server, cwd) => new CodaMcp(server, cwd) }) {
    Object.assign(this, { rpc, env, fetcher, clock, submissionWaitMs, log, mcpFactory });
    this.settings = JSON.parse(env.CODA_PLUGIN_SETTINGS || '{}');
    this.now = () => this.clock.now ? this.clock.now() : Date.now();
    this.auth = new NativeAuth({ root: env.CODA_PLUGIN_STATE, fetcher, clock });
    this.bots = [];
    this.sessions = new Map();
    this.timeout = duration(this.settings['grok-bot.turnTimeout']);
  }
  file(id) {
    if (!this.env.CODA_PLUGIN_STATE) throw new Error('缺少 CODA_PLUGIN_STATE，无法保存 Bot 绑定');
    return join(this.env.CODA_PLUGIN_STATE, `${createHash('sha256').update(id).digest('hex')}.json`);
  }
  save(s) {
    const file = this.file(s.id), temp = `${file}.${randomUUID()}.tmp`;
    mkdirSync(this.env.CODA_PLUGIN_STATE, { recursive: true, mode: 0o700 });
    writeFileSync(temp, JSON.stringify(s.saved), { mode: 0o600 });
    renameSync(temp, file);
  }
  session(id) { return this.sessions.get(id) ?? fail('会话尚未加载'); }
  configs(s) {
    return [MODEL, { id: 'bot', name: '这是哪个 Bot', type: 'select', currentValue: s.saved.bot,
      options: [{ value: '', name: '请选择 Bot（先发送 /login 登录）' }, ...this.bots.map(bot => ({ value: bot.agentId, name: `${bot.name || bot.agentId} (${bot.agentId})` })),
        ...(!this.bots.some(b => b.agentId === s.saved.bot) && s.saved.bot ? [{ value: s.saved.bot, name: s.saved.bot }] : [])] }];
  }
  wait(s, state) { if (this.waits) this.rpc.notify('_coda/wait', { sessionId: s.id, waitId: s.subscriptionId ?? 'grok-native', kind: 'task', title: 'Grok 主会话订阅', state }); }
  async refreshBots() {
    if (!this.auth.client) return;
    const result = await this.auth.client.request('ListGrokBotAgents', {});
    this.bots = result.agents ?? [];
  }
  update(s, update) { this.rpc.notify('session/update', { sessionId: s.id, update }); }
  say(s, text) { this.update(s, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }); }
  start(s, autonomous) {
    if (s.turn) fail('这个会话已有轮次在进行');
    if (autonomous && !this.waits) fail('Coda 未声明 waits，不能开启自主轮次');
    const turn = { id: randomUUID(), autonomous, controller: new AbortController(), tools: new Map() };
    turn.result = new Promise(resolve => { turn.resolve = resolve; });

    s.turn = turn;
    if (autonomous) this.wait(s, 'handling');
    turn.timer = this.clock.setTimeout(() => {
      if (s.turn !== turn) return;
      turn.failed = true;
      this.say(s, `等待 Grok Bot 超过 ${this.settings['grok-bot.turnTimeout'] ?? 'PT30M'}，本轮已结束；云端任务未必停止。之后收到的原生消息将标为补充消息。`);
      this.finish(s, 'end_turn');
    }, this.timeout);
    return turn;
  }
  finish(s, stopReason) {
    const turn = s.turn;
    if (!turn) return;
    for (const [toolCallId, call] of turn.tools) if (!call.background)
      this.update(s, { sessionUpdate: 'tool_call_update', toolCallId, status: 'failed', rawOutput: '本轮已结束，远端操作结果未确认' });
    this.clock.clearTimeout(turn.timer);
    this.clock.clearTimeout(turn.settlementTimer);
    if (turn.activityId) this.update(s, { sessionUpdate: 'tool_call_update', toolCallId: turn.activityId, status: stopReason === 'cancelled' || turn.failed ? 'failed' : 'completed' });
    if (turn.nativeId) s.closedRuns.add(turn.nativeId);
    s.turn = null;
    turn.controller.abort();
    if (turn.autonomous) this.wait(s, s.watch ? 'waiting' : 'done');
    turn.resolve({ stopReason });
  }
  active(s, id, create = false) {
    if (id !== undefined && id !== s.turn?.id) fail('轮次已结束或不匹配');
    if (!s.turn && create) return this.start(s, true);
    return s.turn;
  }
  async open(params, load) {
    const { systemPrompt, mcpServers = [], cwd } = params;
    if (systemPrompt && (systemPrompt.mode !== 'append' || !Array.isArray(systemPrompt.content) || systemPrompt.content.some(b => b.type !== 'text' || typeof b.text !== 'string')))
      fail('只支持 append 模式的文本会话指令');
    const id = load ? params.sessionId : randomUUID();
    if (typeof id !== 'string' || !id) fail('缺少 sessionId');
    if (this.sessions.has(id)) fail('会话已经加载');
    let saved = { bot: '', bound: false };
    if (load) {
      try {
        saved = JSON.parse(readFileSync(this.file(id), 'utf8'));
        if (typeof saved.bot !== 'string' || typeof saved.bound !== 'boolean') fail('无效的 Bot 会话状态');
        delete saved.instructions;
      }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const s = { id, saved, sent: new Map(), closedRuns: new Set(), texts: new Map(), widgets: new Set(), diagnosticsEnabled: mcpServers.some(server => server.name === 'diagnostics'), clients: [], routes: new Map(), unavailable: new Map(), turn: null };
    // Coda and the optional built-in diagnostics plugin are separate stdio MCP servers. Discover
    // both at load time; never treat a tool name returned by a server as authority
    // to expand the whitelist, or fall back to coda for absent diagnostics tools.
    const catalogs = await Promise.all(['coda', 'diagnostics'].map(async name => {
      const server = mcpServers.find(server => server.name === name);
      if (!server) return { name, tools: [] };
      const client = this.mcpFactory(server, cwd);
      s.clients.push(client);
      try {
        const { tools } = await client.list();
        if (!Array.isArray(tools)) throw new Error('tools/list 未返回工具列表');
        return { name, client, tools };
      } catch (error) {
        client.close();
        s.unavailable.set(name, error.message);
        this.log(JSON.stringify({ sessionId: id, server: name, error: error.message }));
        return { name, tools: [] };
      }
    }));
    for (const catalog of catalogs) for (const tool of catalog.tools) {
      if (!READ.has(tool.name) && !WRITE.has(tool.name)) continue;
      if (DIAGNOSTICS.has(tool.name) && catalog.name !== 'diagnostics') continue;
      if (s.routes.has(tool.name)) { s.routes.set(tool.name, null); continue; }
      s.routes.set(tool.name, catalog.client);
    }
    this.sessions.set(id, s);
    if (this.auth.client) {
      try { await this.refreshBots(); if (saved.bot) await this.attach(s); }
      catch (error) { s.setupError = error.message; this.log(error.message); }
    }
    return { ...(load ? {} : { sessionId: id }), configOptions: this.configs(s) };
  }
  async prompt(s, prompt) {
    if (!Array.isArray(prompt) || prompt.some(b => b.type !== 'text' || typeof b.text !== 'string')) fail('Grok Bot 目前只接受文本');
    const text = prompt.map(b => b.text).join('\n');
    if (!text.trim()) fail('消息不能为空');
    const turn = this.start(s, false);
    void (async () => {
      if (!this.auth.client || text.trim() === '/login') {
        this.beginLogin(s); this.finish(s, 'end_turn'); return;
      }
      if (text.trim() === '/bind') {
        if (!this.remote) throw new Error('请升级到支持远端 Agent 入口的 Coda');
        const code = await this.rpc.request('_coda/remote/code', { sessionId: s.id }, { signal: turn.controller.signal });
        if (s.turn === turn) { this.say(s, bindingGuide(s.id, code)); this.finish(s, 'end_turn'); }
        return;
      }
      if (!s.saved.bot) { this.say(s, '请在「这是哪个 Bot」中按名字或 ID 选择 Bot，再发送消息。'); this.finish(s, 'end_turn'); return; }
      if (!s.watch) await this.attach(s);
      if (s.turn === turn) await this.sendNative(s, turn, text);
    })().catch(error => { if (s.turn === turn) { this.say(s, `消息未能完成：${error.message}；未自动重发。认证失效请发送 /login。`); this.finish(s, 'end_turn'); } });
    return turn.result;
  }
  beginLogin(s) {
    const login = this.auth.login();
    this.say(s, `请打开官方登录链接：${login.url}\n手机可能停在「Completing sign-in」，请再点一次 Continue。登录完成后会自动显示 Bot 列表。`);
    if (this.loginTask) return;
    const waitId = `grok-login-${randomUUID()}`;
    this.rpc.notify('_coda/wait', { sessionId: s.id, waitId, kind: 'task', state: 'waiting', title: '等待 Grok 官方登录' });
    this.loginTask = login.promise.then(async () => {
      await this.refreshBots();
      for (const session of this.sessions.values()) {
        this.update(session, { sessionUpdate: 'config_option_update', configOptions: this.configs(session) });
        if (session.saved.bot) { session.routines?.close(); session.watch?.close(); this.wait(session, 'done'); session.watch = null; await this.attach(session); }
      }
      this.rpc.notify('_coda/wait', { sessionId: s.id, waitId, state: 'handling' });
      this.say(s, 'Grok 登录成功，请在「这是哪个 Bot」选择 Bot。');
      this.rpc.notify('_coda/wait', { sessionId: s.id, waitId, state: 'done' });
    }).catch(error => {
      if (this.closed) return;
      this.rpc.notify('_coda/wait', { sessionId: s.id, waitId, state: 'handling' });
      this.say(s, `登录未完成：${error.message}；请发送 /login 重试。`);
      this.rpc.notify('_coda/wait', { sessionId: s.id, waitId, state: 'failed' });
    }).finally(() => { this.loginTask = null; });
  }
  nativeNotice(s, text) {
    const own = !s.turn; if (own) this.start(s, true);
    this.say(s, text);
    if (own) this.finish(s, 'end_turn');
  }
  healthCallbacks(s, source) {
    return {
      log: message => this.log(JSON.stringify({ sessionId: s.id, source, message })),
      error: error => this.nativeNotice(s, `Grok ${source}持续失败：${error.message}。认证失效请发送 /login；其他断线按游标重连，不重发消息。`),
      recovered: () => this.nativeNotice(s, `Grok ${source}已恢复。`),
    };
  }
  async attach(s) {
    if (!this.waits) throw new Error('当前 Coda 不支持 waits，无法保持原生订阅与自主轮次');
    s.subscriptionId = `grok-native-${randomUUID()}`;
    this.wait(s, 'waiting');
    const watch = new NativeWatch({ client: this.auth.client, bot: s.saved.bot, saved: s.saved, clock: this.clock,
      commit: () => { if (s.watch === watch) this.save(s); }, event: event => { if (s.watch === watch) return this.nativeEvent(s, event); },
      ...this.healthCallbacks(s, '主会话订阅') });
    s.watch = watch;
    s.routines?.close();
    s.routines = new RoutineWatch({ client: this.auth.client, bot: s.saved.bot, saved: s.saved, clock: this.clock,
      commit: () => this.save(s), notify: event => this.rpc.notify('_coda/wait', { sessionId: s.id, ...event }),
      ...this.healthCallbacks(s, 'Routine 记录') });
    try { await watch.start(); void s.routines.hint(); }
    catch (error) { watch.close(); s.watch = null; this.wait(s, 'failed'); throw error; }
  }
  async sendNative(s, turn, text) {
    turn.messageId = randomUUID();
    s.sent.set(turn.messageId, turn.id);
    const result = await this.auth.client.request('SendGrokBotUserMessage', { agentId: s.saved.bot, sessionId: '', messageId: turn.messageId, text,
      sentAtMs: String(this.now()), source: 1, initiator: 1, sendSource: 1 }, { signal: turn.controller.signal });
    if (!result.dispatched) throw new Error('Grok 未确认主会话开始执行');
  }
  async nativeEvent(s, event) {
    if (this.closed) return;
    if (event.connected) { if (s.connected) void s.routines.hint(); s.connected = true; return; }
    if (event.routinesChanged) { void s.routines.hint(); return; }
    if (event.entry) {
      const { row, body } = event.entry;
      if (body.kind === 'message' && body.role === 'user') {
        if (s.sent.has(body.clientNonce)) {
          if (s.sent.get(body.clientNonce) === s.turn?.id) s.turn.nativeId = body.requestId;
          else s.closedRuns.add(body.requestId);
        }
        else {
          if (s.turn?.settlement && s.turn.nativeId !== body.requestId) this.finish(s, 'end_turn');
          if (!s.turn) this.start(s, true);
          if (!s.turn.nativeId) s.turn.nativeId = body.requestId;
          this.update(s, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: body.content ?? '' } });
        }
        return;
      }
      if (body.kind !== 'send-message') return;
      if (body.message?.type === 'widget' && (body.respondedValue !== undefined || body.widgetSkipped)) return;
      const late = s.closedRuns.has(body.requestId);
      if (!late && s.turn?.autonomous && s.turn.hasReply && s.turn.nativeId && s.turn.nativeId !== body.requestId) this.finish(s, 'end_turn');
      if (!s.turn) {
        this.start(s, true);
        if (late) { this.say(s, 'Grok 上一轮补充消息：'); s.turn.settlement = { turnId: body.requestId, outcome: 'success', settledAtMs: String(this.now()) }; }
      }
      const turn = s.turn;
      if (!turn.nativeId && !(late && turn.messageId)) turn.nativeId = body.requestId;
      // Preserve late native output as an explicit supplement, never silently drop it.
      if (body.requestId && turn.nativeId !== body.requestId) this.say(s, 'Grok 上一轮补充消息：');
      if (turn.nativeId === body.requestId) {
        turn.hasReply = true;
        if (s.lastSettlement?.turnId === body.requestId) turn.settlement = s.lastSettlement;
      }
      if (body.message?.type === 'text') {
        const text = body.message.content ?? '', previous = s.texts.get(row.entryId) ?? '';
        if (text !== previous) this.say(s, text.startsWith(previous) ? text.slice(previous.length) : `\nGrok 修订消息：${text}`);
        s.texts.set(row.entryId, text);
      } else if (body.message?.type === 'widget') {
        if (!s.widgets.has(row.entryId)) { s.widgets.add(row.entryId); void this.widget(s, turn, row.entryId, body.message.widget); }
      } else this.say(s, `Grok 返回未支持的消息类型 ${body.message?.type ?? 'unknown'}，请在 Grok 客户端查看。`);
      return;
    }
    if (event.live) {
      const live = event.live;
      if (live.hasRunningSubagents || s.hadSubagents) void s.routines.hint(!!live.hasRunningSubagents);
      s.hadSubagents = !!live.hasRunningSubagents;
      if (live.isRunning && !s.turn) this.start(s, true);
      if (live.isRunning && s.turn) {
        s.turn.nativeRunning = true;
        if (live.activity?.kind === 'thinking' && !s.turn.thinking) {
          s.turn.thinking = true;
          this.update(s, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Grok 正在思考（原生状态，未提供思考正文）' } });
        }
        if (live.activity?.kind === 'tool') {
          const title = live.activity.detail || live.activity.tool || 'Grok 活动';
          if (title !== s.turn.activityTitle) {
            if (s.turn.activityId) this.update(s, { sessionUpdate: 'tool_call_update', toolCallId: s.turn.activityId, status: 'completed' });
            s.turn.activityTitle = title; s.turn.activityId = randomUUID();
            this.update(s, { sessionUpdate: 'tool_call', toolCallId: s.turn.activityId, title, kind: 'other', status: 'in_progress' });
          }
        }
      }
      if (live.awaiting) {
        this.log(JSON.stringify({ sessionId: s.id, nativeAwaiting: live.awaiting }));
        if (!s.awaiting) { if (!s.turn) this.start(s, true); this.say(s, 'Grok 正在等待原生审批，请到 Grok 客户端处理。'); }
      }
      s.awaiting = !!live.awaiting;
      const settlement = live.lastTurnSettlement;
      if (settlement && !live.isRunning) s.lastSettlement = settlement;
      if (!live.isRunning && settlement && !s.closedRuns.has(settlement.turnId) && !(event.snapshot && !s.turn)) {
        if (!s.turn) this.start(s, true);
        if (!s.turn.nativeId) s.turn.nativeId = settlement.turnId;
        if (s.turn.nativeId === settlement.turnId) {
          s.turn.settlement = settlement; s.turn.nativeRunning = false;
          if (settlement.outcome === 'cancelled') this.finish(s, 'cancelled');
          else if (settlement.outcome !== 'success') { s.turn.failed = true; this.say(s, `Grok 运行结束：${settlement.outcome}`); this.finish(s, 'end_turn'); }
        }
      }
    }
    if (event.failed) {
      const id = event.failed.turnId;
      if (id && s.closedRuns.has(id)) {
        this.log(JSON.stringify({ sessionId: s.id, closedRunFailure: event.failed }));
        return;
      }
      if (s.turn && (!id || s.turn.nativeId !== id)) {
        if (id && !s.turn.nativeId) {
          // A Coda prompt is not associated with a native turn until its echo
          // (or reply) arrives. Retain failures until that association is known.
          (s.turn.pendingFailures ??= new Map()).set(id, event.failed);
          this.log(JSON.stringify({ sessionId: s.id, unassociatedFailure: event.failed }));
        } else this.say(s, `Grok 其他轮次 ${id ?? '（未提供 ID）'} 失败（${event.failed.code ?? 'unknown'}）`);
      } else {
        if (!s.turn) { this.start(s, true); s.turn.nativeId = id; }
        s.turn.failed = true;
        this.say(s, `Grok 运行失败（${event.failed.code ?? 'unknown'}）`);
        this.finish(s, 'end_turn');
      }
    }
    if (s.turn?.nativeId && s.turn.pendingFailures) {
      const failed = s.turn.pendingFailures.get(s.turn.nativeId);
      delete s.turn.pendingFailures;
      if (failed) return this.nativeEvent(s, { failed });
    }
    const turn = s.turn;
    if (turn?.settlement?.outcome === 'success') {
      const afterSettlement = event.heartbeat && BigInt(event.heartbeat.serverTimeMs ?? 0) > BigInt(turn.settlement.settledAtMs ?? 0);
      if (turn.hasReply || afterSettlement) await this.completeSettled(s, turn, !!afterSettlement);
      else this.settlementGrace(s, turn);
    }
  }
  settlementGrace(s, turn) {
    if (turn.settlementTimer || s.turn !== turn) return;
    turn.settlementTimer = this.clock.setTimeout(() => {
      turn.settlementTimer = null;
      void this.completeSettled(s, turn, true).catch(error => {
        if (s.turn !== turn) return;
        s.watch.health.failure(error);
        this.settlementGrace(s, turn);
      });
    }, SETTLEMENT_GRACE_MS);
  }
  async completeSettled(s, turn, allowEmpty) {
    if (s.turn !== turn || turn.reconciling || turn.widgetPending || (!turn.hasReply && !allowEmpty)) return;
    turn.reconciling = true;
    try {
      await s.watch.reconcile();
      if (s.turn === turn && !turn.widgetPending) this.finish(s, 'end_turn');
    } finally { turn.reconciling = false; }
  }
  async widget(s, turn, entryId, widget) {
    turn.widgetPending = (turn.widgetPending ?? 0) + 1;
    try {
      if (!Array.isArray(widget?.options) || !widget.options.length) throw new Error('widget 没有可选项，请到 Grok 客户端处理');
      const options = widget.options.map((option, index) => ({ optionId: String(index), name: option.label ?? String(option.value), kind: 'allow_once' }));
      const answer = await this.rpc.request('session/request_permission', { sessionId: s.id,
        toolCall: { toolCallId: `widget:${entryId}`, title: widget.prompt || 'Grok 提问', status: 'pending', kind: 'other' }, options }, { signal: turn.controller.signal });
      if (answer.outcome?.outcome !== 'selected') return;
      const choice = options.findIndex(o => o.optionId === answer.outcome.optionId);
      if (choice < 0) throw new Error('未知 widget 选项');
      const result = await this.auth.client.request('RespondGrokBotWidget', { agentId: s.saved.bot, sessionId: '', entryId, value: widget.options[choice].value });
      if (!result.accepted) throw new Error('Grok 未接受 widget 回答');
    } catch (error) { if (s.turn === turn) this.say(s, `Grok 卡片未完成：${error.message}`); }
    finally {
      turn.widgetPending--;
      if (turn.settlement?.outcome === 'success') this.settlementGrace(s, turn);
    }
  }
  async trace(s, name, args, operation, replyAfter) {
    const turn = s.turn, toolCallId = randomUUID();
    const background = replyAfter !== undefined && !!this.waits;
    const toolCall = { toolCallId, title: `Coda · ${name}`, kind: 'other', status: 'pending', rawInput: args };
    if (turn) { turn.tools.set(toolCallId, { background }); this.update(s, { sessionUpdate: 'tool_call', ...toolCall }); }
    else this.log(JSON.stringify({ sessionId: s.id, toolCallId, name, arguments: args, state: 'started' }));
    // Register while the initiating turn is still active, before dispatch. The
    // request survives cancellation even before its early acknowledgement.
    if (background) this.rpc.notify('_coda/wait', { sessionId: s.id, waitId: toolCallId, kind: 'task', state: 'waiting',
      title: `Coda · ${name} 等待结果`, toolCallId });
    const activity = state => this.rpc.notify('_coda/wait', { sessionId: s.id, waitId: toolCallId, state });
    const report = (status, rawOutput) => {
      if (background) {
        // handling opens a Coda autonomous turn when idle and preserves the
        // activity's original cause. Do not reopen the Bot's expired turn.
        activity('handling');
        this.update(s, { sessionUpdate: 'tool_call_update', toolCallId, status, rawOutput });
        if (s.turn !== turn || !turn.tools.has(toolCallId)) this.say(s, status === 'failed'
          ? `Coda · ${name} 后台调用失败：${typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput)}。请核实执行结果，不要自动重发。`
          : `Coda · ${name} 后台调用已返回，结果见该工具记录。`);
        activity(status === 'failed' ? 'failed' : 'done');
      } else if (turn && s.turn === turn) this.update(s, { sessionUpdate: 'tool_call_update', toolCallId, status, rawOutput });
      else this.log(JSON.stringify({ sessionId: s.id, toolCallId, state: status, result: rawOutput }));
    };
    const completed = (async () => {
      try {
        const result = await operation(toolCall, turn);
        report(result?.isError ? 'failed' : 'completed', result);
        return result;
      } catch (error) {
        report('failed', error.message);
        throw error;
      } finally { turn?.tools.delete(toolCallId); }
    })();
    // Without activity support we cannot safely hand off a pending call.
    if (!background) return completed;
    let timer;
    const submitted = new Promise(resolve => {
      timer = this.clock.setTimeout(() => {
        turn.tools.delete(toolCallId);
        resolve({ content: [{ type: 'text', text: '已提交，正在等用户在 Coda 卡片上批准；结果会作为新消息送来；不要重试或轮询。没有其他工作就结束本轮。' }] });
      }, replyAfter);
    });
    try { return await Promise.race([completed, submitted]); }
    finally { this.clock.clearTimeout(timer); }
  }
  async tool(s, { name, arguments: args = {}, turn: id }) {
    if (!READ.has(name) && !WRITE.has(name)) fail(`不允许代理工具：${name}`);
    if (!object(args)) fail('arguments 必须是对象');
    if (name === 'new_session' && (typeof args.project !== 'string' || !args.project.trim()))
      fail('new_session 必须指定目标 project；Bot 所在的空目录没有代码，请选择要修复的项目');
    this.provider(s, name);
    const local = !s.turn;
    const turn = this.active(s, id, WRITE.has(name));
    const signal = turn?.controller.signal;
    let forwarded = args;
    if (WRITE.has(name)) {
      // Coda owns authorization for new independent sessions and messages.
      // new_session returns immediately after requesting approval.
      const status = await this.trace(s, 'status', {}, () => this.provider(s, 'status').call('status', {}, signal));
      if (status.isError) throw new Error('无法取得 Coda turn 票据');
      const ticket = (status.structuredContent ?? JSON.parse(status.content.find(b => b.type === 'text').text)).turn;
      if (typeof ticket !== 'string' || !ticket || s.turn !== turn) fail('没有有效的 Coda turn 票据');
      forwarded = { ...args, turn: ticket, requestId: requestId(turn, name, args) };
    }
    const mayWaitForApproval = name === 'send';
    // Approval calls outlive a Coda turn and must not inherit its abort signal
    // or the MCP client's default 60-second timeout (null disables both).
    return this.trace(s, name, args, () => this.provider(s, name).call(name, forwarded, mayWaitForApproval ? null : signal),
      mayWaitForApproval ? this.submissionWaitMs : undefined).finally(() => {
        if (local && turn && s.turn === turn && !turn.nativeRunning && !turn.nativeId) this.finish(s, 'end_turn');
      });
  }
  provider(s, name) {
    const client = s.routes.get(name);
    if (!client && DIAGNOSTICS.has(name) && !s.diagnosticsEnabled)
      fail('这两个工具需要在 Coda 里安装并为这个目录启用『机器诊断』插件');
    if (!client) fail(`${name} 不可用：${DIAGNOSTICS.has(name) ? 'diagnostics' : 'coda/diagnostics'} MCP 未提供此工具或工具名冲突${s.unavailable.size ? `（${[...s.unavailable].map(([server, error]) => `${server}: ${error}`).join('；')}）` : ''}`);
    return client;
  }
  async telemetry(s, { path, query = {}, turn }) {
    if (typeof path !== 'string' || !path.startsWith('/api/') || /[\x00-\x20\x7f\\?#%]/.test(path) || path.split('/').some(p => p === '..' || p === '.')) fail('telemetry 只允许 /api/ 下不含控制字符、编码或路径跳转的只读路径');
    if (!object(query) || Object.values(query).some(v => !['string', 'number', 'boolean'].includes(typeof v))) fail('query 必须是标量键值对象');
    if (!this.settings['grok-bot.telemetry']) fail('尚未设置 grok-bot.telemetry');
    this.active(s, turn);
    const target = url(this.settings['grok-bot.telemetry']);
    const basePath = target.pathname.replace(/\/$/, '');
    target.pathname = `${basePath}${path}`;
    if (!target.pathname.startsWith(`${basePath}/api/`)) fail('telemetry 只允许配置基地址的 /api/ 下的只读路径');
    target.search = new URLSearchParams(query).toString();
    target.hash = '';
    return this.trace(s, 'telemetry', { path, query }, async () => {
      const response = await this.fetcher(target, { redirect: 'error', signal: AbortSignal.timeout(60_000) });
      if (!response.ok) throw new Error(`遥测返回 HTTP ${response.status}`);
      return response.json();
    });
  }
  async handle(method, p) {
    if (method === 'initialize') {
      this.waits = !!p.clientCapabilities?._meta?.coda?.waits;
      this.remote = !!p.clientCapabilities?._meta?.coda?.remote;
      return { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { systemPrompt: {} }, _meta: { coda: { waits: {}, remote: {} } } }, authMethods: [] };
    }
    if (method === 'session/new' || method === 'session/load') return this.open(p, method === 'session/load');
    if (!['session/set_config_option', 'session/prompt', 'session/cancel', '_coda/remote'].includes(method)) throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
    const s = this.session(p.sessionId);
    if (method === 'session/set_config_option') {
      if (p.configId === 'model' && p.value === 'grok-bot') return { configOptions: this.configs(s) };
      if (p.configId !== 'bot' || typeof p.value !== 'string') fail('未知的 Bot 配置');
      await this.refreshBots();
      const bot = this.bots.find(b => b.agentId === p.value || b.name === p.value);
      if (p.value && !bot) fail('未找到 Bot，请先 /login 并刷新列表');
      if (s.turn) fail('请先结束本轮再切换 Bot');
      if ((bot?.agentId ?? '') === s.saved.bot) return { configOptions: this.configs(s) };
      if (s.watch) { s.watch.close(); this.wait(s, 'done'); s.watch = null; }
      s.routines?.close();
      s.saved = { bot: bot?.agentId ?? '', bound: false };
      s.closedRuns.clear(); s.texts.clear(); s.widgets.clear(); s.sent.clear();
      s.connected = false; s.hadSubagents = false; s.lastSettlement = null; s.awaiting = false;
      this.save(s);
      if (bot) await this.attach(s);
      return { configOptions: this.configs(s) };
    }
    if (method === 'session/prompt') return this.prompt(s, p.prompt);
    if (method === 'session/cancel') {
      const turn = s.turn;
      if (turn && s.saved.bot && this.auth.client) {
        await this.auth.client.request('InterruptGrokBotAgentRun', { agentId: s.saved.bot, sessionId: '' });
      }
      if (turn && s.turn === turn) this.finish(s, 'cancelled');
      return {};
    }
    const args = p.params ?? {};
    if (!object(args)) fail('远端 params 必须是对象');
    if (p.method === 'hello') {
      s.saved.bound = true;
      this.save(s);
      // Idempotent confirmation of the authenticated Coda tool binding.
      return { sessionId: s.id, bot: s.saved.bot };
    }
    if (!s.saved.bound) fail('Bot 尚未完成绑定，请先运行 bind');
    if (p.method === 'tool') return this.tool(s, args);
    if (p.method === 'telemetry') return this.telemetry(s, args);
    fail(`未知的远端方法：${p.method}`);
  }
  close() { this.closed = true; this.auth.close(); for (const s of this.sessions.values()) { s.routines?.close(); s.watch?.close(); this.finish(s, 'cancelled'); for (const client of s.clients) client.close(); } }
}
