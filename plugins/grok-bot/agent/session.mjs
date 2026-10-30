import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CodaMcp } from './mcp.mjs';
import { bindingGuide } from './setup.mjs';

const MODEL = { id: 'model', name: '模型', category: 'model', type: 'select', currentValue: 'grok-bot', options: [{ value: 'grok-bot', name: 'Grok Bot' }] };
const READ = new Set(['read_thread', 'read_tool_call', 'agents', 'status', 'workflow_status', 'workflow_list', 'machines', 'machine_diagnostics']);
const WRITE = new Set(['spawn', 'send', 'cancel']);
const DIAGNOSTICS = new Set(['machines', 'machine_diagnostics']);
const fail = message => { throw Object.assign(new Error(message), { code: -32602 }); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
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
  constructor({ rpc, env = process.env, fetcher = fetch, clock = { setTimeout, clearTimeout }, submissionWaitMs = SUBMISSION_WAIT_MS, log = text => console.error(text), mcpFactory = (server, cwd) => new CodaMcp(server, cwd) }) {
    Object.assign(this, { rpc, env, fetcher, clock, submissionWaitMs, log, mcpFactory });
    this.settings = JSON.parse(env.CODA_PLUGIN_SETTINGS || '{}');
    this.secrets = JSON.parse(env.CODA_PLUGIN_SECRETS || '{}');
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
    const bots = Object.keys(this.settings['grok-bot.bots'] ?? {});
    return [MODEL, { id: 'bot', name: '这是哪个 Bot', type: 'select', currentValue: s.saved.bot,
      options: [{ value: '', name: '请选择 Bot' }, ...[...new Set([...bots, s.saved.bot].filter(Boolean))].map(value => ({ value, name: value }))] }];
  }
  wait(s, state) { if (this.waits) this.rpc.notify('_coda/wait', { sessionId: s.id, waitId: 'grok-bot-routines', kind: 'timer', recurring: true, title: 'Grok Bot 的定时任务', state }); }
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
      this.say(s, `等待 Grok Bot 超过 ${this.settings['grok-bot.turnTimeout'] ?? 'PT30M'}，本轮已结束；云端任务未必停止。迟到的本轮消息会被拒绝。`);
      this.finish(s, 'end_turn');
    }, this.timeout);
    return turn;
  }
  finish(s, stopReason) {
    const turn = s.turn;
    if (!turn) return;
    for (const [toolCallId] of turn.tools) this.update(s, { sessionUpdate: 'tool_call_update', toolCallId, status: 'failed', rawOutput: '本轮已结束，远端操作结果未确认' });
    this.clock.clearTimeout(turn.timer);
    s.turn = null;
    turn.controller.abort();
    if (turn.autonomous) this.wait(s, 'waiting');
    turn.resolve({ stopReason });
  }
  active(s, turn, create = false) {
    if (turn !== undefined && (typeof turn !== 'string' || s.turn?.id !== turn)) fail('轮次已结束或不匹配；迟到的消息不再接收');
    // Webhook runs must carry their ID, including after a cancellation and a new prompt.
    if (turn === undefined && s.turn && !s.turn.autonomous) fail('处理 Coda 消息必须带 Webhook 中的 turn');
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
        const { bot, bound } = JSON.parse(readFileSync(this.file(id), 'utf8'));
        saved = { bot, bound };
      }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const instructions = systemPrompt?.content.map(b => b.text).join('\n') ?? '';
    const s = { id, saved, instructions, diagnosticsEnabled: mcpServers.some(server => server.name === 'diagnostics'), clients: [], routes: new Map(), unavailable: new Map(), turn: null };
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
    this.wait(s, 'waiting');
    return { ...(load ? {} : { sessionId: id }), configOptions: this.configs(s) };
  }
  async prompt(s, prompt) {
    if (!Array.isArray(prompt) || prompt.some(block => block.type !== 'text' || typeof block.text !== 'string')) fail('Grok Bot 目前只接受文本；请在文本里提供可读取的附件路径');
    const turn = this.start(s, false);
    // Return the turn promise immediately; cancellation also finishes while code/webhook is in flight.
    void (async () => {
      if (!s.saved.bound || prompt.map(b => b.text).join('\n').trim() === '/bind') {
        if (!this.remote) throw new Error('请先升级到支持远端 Agent 入口的 Coda，再绑定 Grok Bot。');
        const code = await this.rpc.request('_coda/remote/code', { sessionId: s.id }, { signal: turn.controller.signal });
        if (s.turn !== turn) return;
        this.say(s, bindingGuide(s.id, code));
        this.finish(s, 'end_turn');
        return;
      }
      const bot = this.settings['grok-bot.bots']?.[s.saved.bot];
      const keyPath = this.secrets['grok-bot.bots']?.[s.saved.bot]?.key;
      if (!bot?.webhook || !keyPath) throw new Error('请在插件设置的 bots 表填写这个 Bot 的 Webhook 与密文 key，并在会话里选择它。');
      const key = readFileSync(keyPath, 'utf8').trim();
      if (!key) throw new Error('这个 Bot 的 Webhook key 为空');
      const text = prompt.map(b => b.text).join('\n');
      const instructions = s.instructions;
      const response = await this.fetcher(url(bot.webhook), { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ source: 'coda', sessionId: s.id, turn: turn.id,
          text: instructions ? `<coda-session-instructions>\n${instructions}\n</coda-session-instructions>\n\n${text}` : text }), signal: turn.controller.signal });
      if (!response.ok) throw new Error(`Grok Webhook 返回 HTTP ${response.status}；未确认云端是否开始处理，不自动重发。`);
      await response.body?.cancel();
    })().catch(error => {
      if (s.turn !== turn) return;
      this.say(s, `消息未能完成：${error.message}`);
      this.finish(s, 'end_turn');
    });
    return turn.result;
  }
  async trace(s, name, args, operation, replyAfter) {
    const turn = s.turn, toolCallId = randomUUID();
    const toolCall = { toolCallId, title: `Coda · ${name}`, kind: 'other', status: 'pending', rawInput: args };
    if (turn) { turn.tools.set(toolCallId, true); this.update(s, { sessionUpdate: 'tool_call', ...toolCall }); }
    else this.log(JSON.stringify({ sessionId: s.id, toolCallId, name, arguments: args, state: 'started' }));
    const completed = (async () => {
      try {
        const result = await operation(toolCall, turn);
        if (turn && s.turn === turn) this.update(s, { sessionUpdate: 'tool_call_update', toolCallId, status: result?.isError ? 'failed' : 'completed', rawOutput: result });
        else this.log(JSON.stringify({ sessionId: s.id, toolCallId, state: result?.isError ? 'failed' : 'completed', result }));
        return result;
      } catch (error) {
        if (turn && s.turn === turn) this.update(s, { sessionUpdate: 'tool_call_update', toolCallId, status: 'failed', rawOutput: error.message });
        else this.log(JSON.stringify({ sessionId: s.id, toolCallId, state: 'failed', error: error.message }));
        throw error;
      } finally { turn?.tools.delete(toolCallId); }
    })();
    if (replyAfter === undefined) return completed;
    let timer;
    const submitted = new Promise(resolve => {
      timer = this.clock.setTimeout(() => {
        // done may now end the turn; the actual Coda request and its trace keep
        // running, and late completion is logged rather than added to a new turn.
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
    if (name === 'spawn' && (typeof args.project !== 'string' || !args.project.trim()))
      fail('spawn 必须指定目标 project；Bot 所在的空目录没有代码，请选择要修复的项目');
    this.provider(s, name);
    const turn = this.active(s, id, WRITE.has(name));
    const signal = turn?.controller.signal;
    let forwarded = args;
    if (WRITE.has(name)) {
      // Coda owns authorization: cross-project spawn and messages to other
      // sessions use its cards; follow-ups/cancel of our children use its ownership checks.
      const status = await this.trace(s, 'status', {}, () => this.provider(s, 'status').call('status', {}, signal));
      if (status.isError) throw new Error('无法取得 Coda turn 票据');
      const ticket = (status.structuredContent ?? JSON.parse(status.content.find(b => b.type === 'text').text)).turn;
      if (typeof ticket !== 'string' || !ticket || s.turn !== turn) fail('没有有效的 Coda turn 票据');
      forwarded = { ...args, turn: ticket, requestId: requestId(turn, name, args) };
    }
    const mayWaitForApproval = name === 'spawn' || name === 'send';
    // Approval calls outlive a Coda turn and must not inherit its abort signal
    // or the MCP client's default 60-second timeout (null disables both).
    return this.trace(s, name, args, () => this.provider(s, name).call(name, forwarded, mayWaitForApproval ? null : signal),
      mayWaitForApproval ? this.submissionWaitMs : undefined);
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
      if (p.configId !== 'bot' || typeof p.value !== 'string' || (p.value !== '' && !Object.hasOwn(this.settings['grok-bot.bots'] ?? {}, p.value))) fail('未知的 Bot 配置');
      if (p.value !== s.saved.bot) {
        if (s.turn) fail('请先结束本轮再切换 Bot');
        if (s.saved.bot) s.saved.bound = false;
        s.saved.bot = p.value;
        this.save(s);
      }
      return { configOptions: this.configs(s) };
    }
    if (method === 'session/prompt') return this.prompt(s, p.prompt);
    if (method === 'session/cancel') {
      if (s.turn) { this.say(s, '本轮已取消；Grok 云端任务未必停止，迟到的本轮消息不会加入后续轮次。'); this.finish(s, 'cancelled'); }
      return {};
    }
    const args = p.params ?? {};
    if (!object(args)) fail('远端 params 必须是对象');
    if (p.method === 'hello') {
      s.saved.bound = true;
      this.save(s);
      // The HTTP response can be lost after this request succeeds. Keep the
      // instructions available to every bind (including a different Bot).
      return { sessionId: s.id, bot: s.saved.bot, instructions: s.instructions };
    }
    if (!s.saved.bound) fail('Bot 尚未完成绑定，请先运行 bind');
    if (p.method === 'say') {
      if (typeof args.text !== 'string' || !args.text.trim()) fail('say 需要非空 text');
      const turn = this.active(s, args.turn, true);
      this.say(s, args.text);
      return { turn: turn.id };
    }
    if (p.method === 'done') {
      const turn = this.active(s, args.turn);
      if (!turn) fail('没有正在进行的轮次');
      if (turn.tools.size) fail('仍有工具调用或审批在进行，请等待结果再 done');
      this.finish(s, 'end_turn');
      return {};
    }
    if (p.method === 'tool') return this.tool(s, args);
    if (p.method === 'telemetry') return this.telemetry(s, args);
    fail(`未知的远端方法：${p.method}`);
  }
  close() { for (const s of this.sessions.values()) { this.finish(s, 'cancelled'); for (const client of s.clients) client.close(); } }
}
