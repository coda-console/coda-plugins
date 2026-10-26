// One Claude Code session through its SDK (one `query` per process), as an ACP agent with Coda's waits
// (docs/agent-protocol.md). Coda's prompts go into the query's input; a prompt is answered by the native result that names
// its input. What Claude says, its tools and their results, its settings, its title and its usage become session updates;
// what it keeps going beside a turn, waits (waits.mjs); what it asks, permission requests and forms, withdrawn as the SDK
// withdraws them. A turn Claude begins on its own is told by what it handles. The plan windows it reports go to the file
// the plugin's「Claude」panel reads (limits.json in CODA_PLUGIN_STATE, limits.mjs), not to Coda's session.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { agent, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk';
import { ClaudeSessionLimits, accountHash } from './limits.mjs';
import { sdkEnvironment } from './auth.mjs';
import { chosenServices, listedModels, serviceSettings } from './providers.mjs';
import { SessionTitle } from './titles.mjs';
import { MODEL_EFFORT, MODES, claudeModels, configOptions, reportedModel } from './models.mjs';
import { permissionRequest } from './permissions.mjs';
import { elicitationForm, questionForm } from './questions.mjs';
import { ClaudeWaits } from './waits.mjs';

// The Claude Agent SDK this entry runs, as the handshake's `agentInfo` names it (Coda's protocol「Agent 版本」).
const SDK = (() => {
  try { return JSON.parse(readFileSync(new URL('./package.json', import.meta.resolve('@anthropic-ai/claude-agent-sdk')), 'utf8')).version; }
  catch { return null; }
})();

// Coda's session instructions (docs/agent-protocol.md「会话指令」), ACP's `systemPrompt`: its text, '' when there is none. Only
// text appended to the agent's own is understood; anything else is refused before a session opens.
export function sessionInstructions(systemPrompt) {
  if (systemPrompt === undefined || systemPrompt === null) return '';
  if (systemPrompt.mode !== 'append') throw new RequestError(-32602, '会话指令只支持 append 模式');
  const { content } = systemPrompt;
  if (!Array.isArray(content) || content.some(block => block?.type !== 'text' || typeof block.text !== 'string')) throw new RequestError(-32602, '会话指令只接受文本块');
  return content.map(block => block.text).join('\n\n');
}
const text = content => typeof content === 'string' ? content : Array.isArray(content) ? content.filter(b => b.type === 'text').map(b => b.text).join('\n') : '';
const interrupted = m => ['interrupt', 'cancelled'].includes(m.stop_reason) || ['aborted_streaming', 'aborted_tools'].includes(m.terminal_reason);
const errorText = m => (m.errors?.length ? m.errors : [m.result || m.subtype]).join('\n');
const failure = (message, code = -32603) => new RequestError(code, message);
const denied = { behavior: 'deny', message: 'Coda 没有在请求结束前给出审批' };
// A child session's output that comes before its task, kept until the task names that session: all of it, since what streamed
// counts as said, a message's streamed pieces as one.
const CHUNKS = new Set(['agent_message_chunk', 'agent_thought_chunk']);
// How many messages sent into a prompt (steer) may be waiting to be taken at once.
const STEERING_LIMIT = 32;

class InputStream {
  queue = []; wake = null; ended = false;
  push(message) { this.queue.push(message); this.wake?.(); }
  close() { this.ended = true; this.wake?.(); }
  async *[Symbol.asyncIterator]() {
    while (!this.ended) {
      if (this.queue.length) yield this.queue.shift();
      else await new Promise(resolve => { this.wake = resolve; });
    }
  }
}

export class ClaudeSession {
  // `env`: what the SDK's process is started with; `onEnded`: the query ended without being closed.
  constructor({ sdk, env = process.env, environment = sdkEnvironment, initializationTimeoutMs = 60_000, onEnded = () => {} }) {
    Object.assign(this, { sdk, env, environment, initializationTimeoutMs, onEnded });
    this.phase = 'new'; this.input = new InputStream(); this.prompts = new Map(); this.withdrawals = new Set();
    // The messages sent into the prompt's turn not yet taken (steer), the prompt whose own turn ended before they were, how
    // the prompt ends once it is ending before they are taken (dropRest), and whether a native turn is going.
    this.steering = new Set(); this.held = null; this.ending = null; this.turning = false;
    // The model services chosen in Coda (providers.mjs), and the service's model the query runs on: null on Claude's own.
    this.services = chosenServices(env); this.serviceModel = null;
    this.models = []; this.commands = []; this.terminal = null; this.current = { mode: 'default', model: undefined, effort: null };
    // Streamed text by API message, so that the complete message adds only what was not streamed; tool calls said.
    this.streams = new Map(); this.streamed = new Map(); this.tools = new Set(); this.children = new Set(); this.early = new Map(); this.compaction = null;
    this.waits = new ClaudeWaits({ say: (params, sessionId = this.sessionId) => this.notify('_coda/wait', { sessionId, ...params }),
      going: () => this.prompts.size > 0 || this.waits.handling, registered: sessionId => this.registered(sessionId) });
  }
  connect(stream) {
    this.connection = agent({ name: 'coda-claude' })
      .onRequest('initialize', () => ({ protocolVersion: PROTOCOL_VERSION, agentInfo: SDK ? { name: 'claude-agent-sdk', version: SDK } : { name: 'coda-claude', version: '1' },
        agentCapabilities: { loadSession: true, sessionCapabilities: { additionalDirectories: {}, systemPrompt: {} }, _meta: { coda: { waits: {} } } },
        _meta: { steering: { supported: true } } }))
      // The SDK's own reading of these drops what its schema does not name, `systemPrompt` among them: they are read as sent.
      .onRequest('session/new', params => params ?? {}, ({ params }) => this.open(params))
      .onRequest('session/load', params => params ?? {}, ({ params }) => this.open(params, params.sessionId))
      .onRequest('session/set_config_option', ({ params }) => this.configure(params.configId, params.value))
      .onRequest('session/set_mode', async ({ params }) => { await this.configure('mode', params.modeId); return {}; })
      .onRequest('session/prompt', ({ params }) => this.prompt(params))
      .onRequest('_session/steering', params => params ?? {}, ({ params }) => this.steer(params))
      .onNotification('session/cancel', ({ params }) => {
        if (params.sessionId !== this.sessionId) return;
        // While the session moves to another query there is none to interrupt: the turn waiting on the move is stopped there.
        if (this.rerouting) this.cancelling = true;
        // Messages sent into the turn and not taken yet (steer) are stopped with it: else Claude Code would run them after.
        if (this.steering.size) this.dropRest({ stopReason: 'cancelled' });
        else void this.query?.interrupt().catch(() => {});
      })
      .onRequest('_coda/wait/stop', params => params, ({ params }) => this.stopWait(params))
      .connect(stream);
    this.client = this.connection.client;
    return this.connection;
  }
  notify(method, params) { void this.client?.notify(method, params).catch(() => {}); }
  update(sessionId, update) {
    // Coda takes a child session's updates once a wait has named it.
    if (sessionId !== this.sessionId && !this.children.has(sessionId)) {
      if (!this.early.has(sessionId)) this.early.set(sessionId, []);
      const early = this.early.get(sessionId), last = early.at(-1);
      if (CHUNKS.has(update.sessionUpdate) && last?.sessionUpdate === update.sessionUpdate && last.messageId !== undefined && last.messageId === update.messageId)
        early[early.length - 1] = { ...last, content: { type: 'text', text: last.content.text + update.content.text } };
      else early.push(update);
      return;
    }
    this.notify('session/update', { sessionId, update });
  }
  registered(sessionId) {
    this.children.add(sessionId);
    for (const update of this.early.get(sessionId) ?? []) this.notify('session/update', { sessionId, update });
    this.early.delete(sessionId);
  }
  options() { return configOptions(this.models, this.current); }

  async open({ cwd, mcpServers = [], additionalDirectories = [], systemPrompt }, resume) {
    if (this.phase !== 'new') throw failure('每个 Claude 进程只有一个会话', -32600);
    const instructions = sessionInstructions(systemPrompt);
    this.phase = 'starting';
    try {
      const dir = await realpath(cwd);
      if (!(await stat(dir)).isDirectory()) throw failure('cwd 不是目录', -32602);
      if (resume && !await this.sdk.getSessionInfo(resume, { dir })) throw failure('原生 Claude 会话不存在', -32002);
      const environment = await this.environment(this.env);
      if (this.phase !== 'starting') throw failure('Claude 会话在启动时已关闭', -32001);
      this.sessionId = resume ?? randomUUID(); this.cwd = dir;
      // Coda's servers are stdio ones; the SDK keys them by name.
      const servers = Object.fromEntries(mcpServers.filter(server => typeof server.command === 'string').map(({ name, command, args = [], env = [] }) =>
        [name, { command, args, ...(env.length ? { env: Object.fromEntries(env.map(variable => [variable.name, variable.value])) } : {}) }]));
      // What every query of the session starts with; a model of a chosen service runs in a query of its own (`reroute`).
      this.launch = {
        // Skipping every approval is a mode the user may switch to later; the SDK refuses it unless allowed at start.
        permissionMode: 'default', allowDangerouslySkipPermissions: true, settingSources: ['user', 'project', 'local'],
        // Coda's session instructions (what its clients render, what the project's plugins say) follow Claude Code's own.
        systemPrompt: { type: 'preset', preset: 'claude_code', ...(instructions ? { append: instructions } : {}) },
        // Sessions reach each other through Coda's send, which the user approves and both threads show. A native peer
        // message would start a turn Coda cannot attribute. Continuing a native subagent is in-process and unaffected.
        settings: { crossSessionInbound: 'refuse' },
        includePartialMessages: true, forwardSubagentText: true, cwd: dir,
        ...(Object.keys(servers).length ? { mcpServers: servers } : {}), ...(additionalDirectories.length ? { additionalDirectories } : {}),
        // Claude Code reports running and idle only when asked: idle is what ends a task's wait.
        env: { ...environment, CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' },
        // Stop supplies the complete list of scheduled wakeups. A CronCreate result alone cannot tell whether one was later
        // deleted or fired.
        hooks: { Stop: [{ hooks: [async input => {
          if (input.session_id === this.sessionId && Array.isArray(input.session_crons)) this.waits.scheduled(input.session_crons.filter(cron =>
            typeof cron?.id === 'string' && cron.id && typeof cron.schedule === 'string' && typeof cron.recurring === 'boolean').slice(0, 50));
          return {};
        }] }] },
        canUseTool: (toolName, input, context) => this.permission(toolName, input, context),
        onElicitation: (request, context) => this.elicitation(request, context),
        stderr: data => process.stderr.write(data),
      };
      const listed = listedModels(this.services, this.env.CODA_PLUGIN_STATE);
      this.start(resume ? { resume } : { sessionId: this.sessionId });
      const initialization = await this.initialized(), served = await listed;
      if (this.phase !== 'starting') throw failure('Claude 会话在初始化时结束', -32001);
      this.models = [...claudeModels(initialization.models), ...served]; this.commands = initialization.commands ?? [];
      // Who the session runs as, for the「Claude」panel (limits.mjs): the windows it reports are that account's, and
      // only while the panel is of that account.
      const email = initialization.account?.email;
      this.account = typeof email === 'string' && email.trim() ? accountHash(email) : null;
      if (this.env.CODA_PLUGIN_STATE) new ClaudeSessionLimits({ path: join(this.env.CODA_PLUGIN_STATE, 'limits.json') }).startedAs(this.account);
      this.current.model = this.models[0]?.id;
      this.phase = 'running';
      return { ...(resume ? {} : { sessionId: this.sessionId }), configOptions: this.options() };
    } catch (error) {
      await this.close();
      throw error instanceof RequestError ? error : failure(error?.message || 'Claude 会话启动失败');
    }
  }
  // A query of the session, reading a prompt stream of its own: on Claude's own models, or on `model` of a chosen
  // service, which it runs with that service as its API and that model for every role. One started after the session
  // opened goes on with the model, mode and effort chosen.
  start(at, model) {
    this.input = new InputStream();
    const entry = this.served(model);
    const settings = { ...this.launch.settings, ...(this.current.effort ? { effortLevel: this.current.effort } : {}),
      ...(entry ? serviceSettings(this.services.find(service => service.ref === entry.service), entry.model) : {}) };
    this.serviceModel = entry ? model : null;
    this.query = this.sdk.query({ prompt: this.input, options: { ...this.launch, ...at, settings,
      ...(this.phase === 'running' ? { permissionMode: this.current.mode, model: entry ? entry.model : this.current.model } : {}) } });
    this.pump = this.consume(this.query);
  }
  async initialized() {
    let timer;
    return Promise.race([this.query.initializationResult(),
      this.pump.then(() => { throw failure('Claude 会话在初始化时结束', -32001); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(failure('Claude 初始化超时', -32001)), this.initializationTimeoutMs); })])
      .finally(() => clearTimeout(timer));
  }
  // The model chosen is of another service than the query's (Claude's own, or a chosen service's): the session goes on in a
  // query started for it, resuming what the last one said. Before a turn, as Coda sets a session's model before each.
  async reroute() {
    const previous = this.query;
    this.query = null; this.input.close();
    try { previous.close(); } catch {}
    await this.pump;
    if (this.phase !== 'running') throw failure('Claude 会话未在运行', -32001);
    // One that cannot be started, or does not start, ends the session, as one that ends of itself does: no later turn waits on it.
    try {
      const said = await this.sdk.getSessionInfo(this.sessionId, { dir: this.cwd });
      this.start(said ? { resume: this.sessionId } : { sessionId: this.sessionId }, this.current.model);
      if (this.title) this.title.query = this.query;
      await this.initialized();
    } catch (error) {
      this.end(this.query, error);
      throw error instanceof RequestError ? error : failure(error?.message || 'Claude 会话启动失败');
    }
  }
  // The chosen services' model that `model` is; null for one of Claude's own.
  served(model) { return this.models.find(m => m.id === model && m.model) ?? null; }
  // Whether the next turn runs in another query than this one: on another service's model, or back on Claude's own.
  rerouted() { return (this.served(this.current.model)?.id ?? null) !== this.serviceModel; }
  async configure(configId, value) {
    if (this.phase !== 'running') throw failure('Claude 会话未在运行', -32001);
    if (configId === 'mode') {
      if (!MODES.some(mode => mode.id === value)) throw failure('审批模式不可用', -32602);
      await this.query.setPermissionMode(value); this.current.mode = value;
    } else if (configId === 'model') {
      if (!this.models.some(model => model.id === value)) throw failure('模型不可用', -32602);
      // Between Claude's own models the query switches; to or from a service's, the next turn runs in another one, and
      // what this one still runs would end with it.
      const switching = (this.served(value)?.id ?? null) !== this.serviceModel;
      if (switching && (this.prompts.size || this.waits.pending)) throw failure('后台任务、子 Agent 或定时唤醒还没结束，结束后才能换到这个模型', -32602);
      if (!switching && !this.serviceModel) await this.query.setModel(value);
      this.current.model = value;
      // An effort chosen for the last model that this one does not have is no choice of it: the model's own goes on.
      if (this.current.effort !== null && !this.models.find(model => model.id === value).efforts.includes(this.current.effort)) {
        await this.query.applyFlagSettings({ effortLevel: null }); this.current.effort = null;
      }
    } else if (configId === 'effort') {
      const effort = value === MODEL_EFFORT ? null : value;
      if (effort !== null && !this.models.find(model => model.id === this.current.model)?.efforts.includes(effort)) throw failure('推理强度不适用于当前模型', -32602);
      await this.query.applyFlagSettings({ effortLevel: effort }); this.current.effort = effort;
    } else throw failure(`没有设置项 ${configId}`, -32602);
    return { configOptions: this.options() };
  }
  // Answered when the native result that names this input arrives; accepting it into the input says nothing yet.
  async prompt({ prompt }) {
    if (this.phase !== 'running') throw failure('Claude 会话未在运行', -32001);
    if (this.rerouted()) {
      if (!this.rerouting) { this.cancelling = false; this.rerouting = this.reroute().finally(() => { this.rerouting = null; }); }
      await this.rerouting;
      // Stopped while it moved: the input is not given to the new query.
      if (this.cancelling) { this.cancelling = false; return { stopReason: 'cancelled' }; }
    }
    const id = randomUUID(), content = prompt.filter(block => block.type === 'text').map(block => block.text).join('\n');
    const answered = new Promise((resolve, reject) => this.prompts.set(id, { resolve, reject }));
    this.input.push({ type: 'user', uuid: id, session_id: this.sessionId, parent_tool_use_id: null, message: { role: 'user', content } });
    this.heard(content);
    return answered;
  }
  // A message into the turn going (docs/agent-protocol.md「插话」): Claude Code takes one sent with priority `next` into the
  // turn it runs at its next tool round, and runs one the turn ended before as a turn of its own right after, which the
  // prompt waits for too (result): either way it is that prompt's. With no prompt of Coda's going, Coda sends it as the next.
  // A result names at most 64 of the messages it took in (the SDK's user_message_uuids): few enough go in at a time that each is
  // named; one more is Coda's to send as the next turn, as it is with no turn going.
  steer({ prompt }) {
    if (this.phase !== 'running' || !this.prompts.size || this.ending) return { outcome: 'promptRequired', reason: 'noRunningTurn' };
    if (this.steering.size >= STEERING_LIMIT) return { outcome: 'promptRequired', reason: 'tooManyPending' };
    const id = randomUUID(), content = prompt.filter(block => block.type === 'text').map(block => block.text).join('\n');
    this.steering.add(id);
    this.input.push({ type: 'user', uuid: id, session_id: this.sessionId, parent_tool_use_id: null, priority: 'next', message: { role: 'user', content } });
    this.heard(content);
    return { outcome: 'injected' };
  }
  // What was said into the prompt and is not taken yet is not to run after it ends, stopped or failed: Claude Code drops it
  // (cancelQueued), and the prompt ends as `outcome` once nothing of it goes on — at the drop's receipt when no native turn
  // is going (one held, whose own turn ended), else as the turn going ends (result).
  dropRest(outcome) {
    this.ending = outcome;
    void this.query?.interrupt({ cancelQueued: true }).then(receipt => {
      for (const id of receipt?.cancelled ?? []) this.steering.delete(id);
      if (this.held && !this.turning) this.settle(this.held, this.ending);
    }, () => {});
  }
  // The prompt answered: as it ended, and with nothing of it left to take.
  settle(id, { stopReason, failure: error }) {
    const prompt = this.prompts.get(id);
    this.prompts.delete(id); this.held = null; this.ending = null; this.steering.clear();
    if (!prompt) return;
    // What ended before this turn ended was taken in by it.
    this.waits.settled();
    if (error) prompt.reject(failure(error)); else prompt.resolve({ stopReason });
  }
  // What is said to the session goes into what its title is made of.
  heard(content) {
    this.titleContext = ((this.titleContext ?? '') + '\n' + content + '\n').slice(-1000);
    if (this.title) { this.title.append(this.titleContext); this.titleContext = ''; }
  }
  async stopWait({ waitId }) {
    const taskId = this.phase === 'running' ? this.waits.stop(waitId) : null;
    if (taskId === null) throw failure('没有可以停止的等待项', -32602);
    if (taskId) await this.query.stopTask(taskId);
    return {};
  }

  permission(toolName, input, { signal, ...context }) {
    if (!['starting', 'running'].includes(this.phase)) return Promise.resolve(denied);
    this.begin();
    // A subagent's request is in its session.
    const sessionId = this.waits.childSession(context.agentID) ?? this.sessionId;
    return toolName === 'AskUserQuestion'
      ? this.ask('elicitation/create', questionForm({ sessionId, toolCallId: context.toolUseID, input }), signal, { behavior: 'deny', message: '问答已失效' })
      : this.ask('session/request_permission', permissionRequest({ sessionId, toolName, input, context }), signal, denied);
  }
  elicitation(request, { signal }) {
    if (!['starting', 'running'].includes(this.phase)) return Promise.resolve({ action: 'cancel' });
    this.begin();
    return this.ask('elicitation/create', elicitationForm({ sessionId: this.sessionId, request }), signal, { action: 'cancel' });
  }
  // Asked of Coda until it answers; withdrawn (`$/cancel_request`) once the SDK no longer waits for the answer.
  async ask(method, { params, answer }, signal, fallback) {
    if (signal?.aborted) return fallback;
    const withdrawn = new AbortController(), withdraw = () => withdrawn.abort();
    signal?.addEventListener('abort', withdraw, { once: true });
    this.withdrawals.add(withdrawn);
    try {
      const response = await Promise.race([this.client.request(method, params, { cancellationSignal: withdrawn.signal }),
        new Promise(resolve => withdrawn.signal.addEventListener('abort', () => resolve(null), { once: true }))]);
      return withdrawn.signal.aborted ? fallback : answer(response);
    } catch { return fallback; } finally { signal?.removeEventListener('abort', withdraw); this.withdrawals.delete(withdrawn); }
  }

  async consume(query) {
    let error;
    try {
      for await (const message of query) {
        try { this.receive(message); }
        catch (failed) { process.stderr.write(`Claude 消息处理失败：${failed.message}\n`); }
      }
    } catch (value) { if (this.phase !== 'closing') error = value; }
    // The session ends with its query; one it moved off, for another model's, ends with nothing to say.
    if (query === this.query) this.end(query, error);
  }
  // The session ends with its query: what waits on it is let go, and the entry told unless it was closing.
  end(query, error) {
    if (this.phase === 'ended') return;
    const intended = this.phase === 'closing';
    this.phase = 'ended'; this.input.close(); this.steering.clear(); this.held = null; this.ending = null;
    for (const withdrawn of this.withdrawals) withdrawn.abort();
    for (const { reject } of this.prompts.values()) reject(failure(error?.message ?? 'Claude 会话已结束'));
    this.prompts.clear();
    try { query?.close(); } catch {}
    if (!intended) this.onEnded(error);
  }
  receive(m) {
    const parent = m.parent_tool_use_id ?? null;
    this.begin(m.type === 'user' && !parent && m.origin ? { origin: m.origin, text: text(m.message?.content) } : {});
    switch (m.type) {
      case 'system': return this.system(m);
      case 'stream_event': return this.stream(m.event, parent);
      case 'assistant': return this.assistant(m, parent);
      case 'user': return this.toolResults(m, parent);
      case 'result': return this.result(m);
      case 'rate_limit_event': if (this.env.CODA_PLUGIN_STATE) new ClaudeSessionLimits({ path: join(this.env.CODA_PLUGIN_STATE, 'limits.json') }).observe(m.rate_limit_info, this.account ?? null);
    }
  }
  system(m) {
    switch (m.subtype) {
      case 'init': {
        if (m.session_id !== this.sessionId) return;
        this.turning = true;
        this.terminal = m.terminal_slash_commands ?? [];
        // Its effort is the one applied, the model's own included: what was chosen stays what it was. A query on the
        // service's model reports it by that service's name for it.
        this.current = { ...this.current, model: this.serviceModel ?? reportedModel(this.models, this.current.model, m.model), mode: m.permissionMode ?? this.current.mode };
        if (!this.title) {
          const sessionId = this.sessionId;
          this.title = new SessionTitle({ sdk: this.sdk, query: this.query, cwd: this.cwd, sessionId, alive: () => ['starting', 'running'].includes(this.phase),
            publish: title => this.update(sessionId, { sessionUpdate: 'session_info_update', title }) });
          this.title.append(this.titleContext ?? ''); this.titleContext = '';
          void this.title.refresh();
        }
        // Every native turn opens with an init. One no prompt of Coda's began, and no handling already holds, is Claude's own.
        if (!this.prompts.size && !this.waits.handling) this.opening = m;
        else this.announce(m);
        return;
      }
      case 'commands_changed': this.commands = m.commands ?? []; return this.announceCommands();
      case 'status': case 'compact_boundary': {
        if (m.permissionMode && m.permissionMode !== this.current.mode) {
          this.current.mode = m.permissionMode;
          this.update(this.sessionId, { sessionUpdate: 'config_option_update', configOptions: this.options() });
        }
        if (m.status === 'compacting' && !this.compaction?.active) this.compaction = { id: m.uuid ?? randomUUID(), active: true };
        if (m.status === 'compacting' || m.subtype === 'compact_boundary' || this.compaction?.active) {
          this.compaction ??= { id: m.uuid ?? randomUUID(), active: false };
          this.compaction.active = m.status === 'compacting';
          this.update(this.sessionId, { sessionUpdate: 'compaction_update', compactionId: this.compaction.id,
            status: this.compaction.active ? 'in_progress' : m.compact_result === 'failed' ? 'failed' : 'completed', error: m.compact_error ?? null });
          if (!this.compaction.active) this.compaction = null;
        }
        return;
      }
      case 'local_command_output': {
        const said = m.content ?? m.stdout;
        if (typeof said === 'string') this.update(this.sessionId, { sessionUpdate: 'agent_message_chunk', messageId: m.uuid, content: { type: 'text', text: said } });
        return;
      }
      case 'session_state_changed': if (m.state === 'idle') this.waits.settled(); return;
      case 'task_started': return this.waits.started(m, { start: true });
      case 'task_updated': {
        if (m.patch?.is_backgrounded === true) this.waits.backgrounded(m.task_id);
        if (m.patch?.description) this.waits.renamed(m.task_id, m.patch.description);
        return this.waits.ended(m.task_id, m.patch?.status);
      }
      case 'task_notification': return this.waits.ended(m.task_id, m.status, { outputFile: m.output_file });
      case 'background_tasks_changed': if (Array.isArray(m.tasks)) this.waits.snapshot(m.tasks);
    }
  }
  // A turn Claude began on its own is told by what it handles, before anything said or asked in it; its opening message, when
  // that comes first, may say what that is.
  begin(opening) {
    if (!this.opening) return;
    const init = this.opening; this.opening = null;
    this.waits.takeUp(opening);
    this.announce(init);
  }
  // What a turn's init says: the settings the session runs with, and its commands.
  announce(init) {
    this.update(this.sessionId, { sessionUpdate: 'config_option_update', configOptions: this.options() });
    this.announceCommands();
  }
  // Until the native init says which commands are the terminal's own, the list is not known.
  announceCommands() {
    if (this.terminal === null) return;
    this.update(this.sessionId, { sessionUpdate: 'available_commands_update', availableCommands: this.commands.filter(c => !this.terminal.includes(c.name))
      .map(c => ({ name: c.name, description: c.description ?? '', ...(c.argumentHint ? { input: { hint: c.argumentHint } } : {}) })) });
  }
  chunk(sessionId, type, messageId, said) {
    if (!said) return;
    this.update(sessionId, { sessionUpdate: type === 'text' ? 'agent_message_chunk' : 'agent_thought_chunk', ...(messageId ? { messageId } : {}),
      content: { type: 'text', text: said } });
  }
  stream(event, parent) {
    const owner = parent ?? 'root', sessionId = parent ?? this.sessionId;
    if (event?.type === 'message_start') {
      this.streams.set(owner, event.message.id);
      this.streamed.set(event.message.id, new Map());
      // Kept for the messages streaming now; a message whose complete form came long ago is not.
      if (this.streamed.size > 64) this.streamed.delete(this.streamed.keys().next().value);
      if (parent) this.waits.model(parent, event.message.model);
      return;
    }
    const apiId = this.streams.get(owner), blocks = this.streamed.get(apiId);
    if (!blocks) return;
    if (event.type === 'content_block_start' && ['text', 'thinking'].includes(event.content_block?.type)) {
      const block = { type: event.content_block.type, sent: 0, confirmed: false }, said = event.content_block.text ?? event.content_block.thinking ?? '';
      blocks.set(event.index, block); block.sent += said.length; this.chunk(sessionId, block.type, apiId, said);
    } else if (event.type === 'content_block_delta' && ['text_delta', 'thinking_delta'].includes(event.delta?.type)) {
      const block = blocks.get(event.index), said = event.delta.text ?? event.delta.thinking ?? '';
      if (!block) return;
      block.sent += said.length; this.chunk(sessionId, block.type, apiId, said);
    }
  }
  assistant(m, parent) {
    const sessionId = parent ?? this.sessionId, apiId = m.message?.id, blocks = this.streamed.get(apiId);
    if (parent) this.waits.model(parent, m.message?.model);
    for (const block of m.message?.content ?? []) {
      if (block.type === 'tool_use') {
        this.tools.add(block.id);
        this.update(sessionId, { sessionUpdate: 'tool_call', toolCallId: block.id, title: block.name, rawInput: block.input, status: 'in_progress' });
      } else if (['text', 'thinking'].includes(block.type)) {
        const said = block.text ?? block.thinking ?? '';
        // One complete packet carries one block of the message: the first streamed one of its kind not yet confirmed.
        const streamed = [...(blocks?.values() ?? [])].find(b => b.type === block.type && !b.confirmed);
        if (streamed) streamed.confirmed = true;
        this.chunk(sessionId, block.type, apiId, said.slice(streamed?.sent ?? 0));
        if (!parent && block.type === 'text') this.title?.append(said);
      }
    }
  }
  toolResults(m, parent) {
    for (const block of Array.isArray(m.message?.content) ? m.message.content : []) {
      if (block.type !== 'tool_result' || !this.tools.has(block.tool_use_id)) continue;
      const said = text(block.content);
      this.update(parent ?? this.sessionId, { sessionUpdate: 'tool_call_update', toolCallId: block.tool_use_id, status: block.is_error ? 'failed' : 'completed',
        rawOutput: m.tool_use_result ?? block.content, content: [{ type: 'content', content: { type: 'text', text: said } }] });
      // Claude Code says where a command it put in the background writes in the launch's result.
      const path = said.match(/Output is being written to: (\S+?\.output)\b/)?.[1];
      if (path) this.waits.outputFile(block.tool_use_id, path);
    }
  }
  result(m) {
    const usage = m.usage ?? {}, windows = Object.values(m.modelUsage ?? {});
    this.update(this.sessionId, { sessionUpdate: 'usage_update', used: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
      size: Math.max(0, ...windows.map(w => w.contextWindow ?? 0)), cost: { amount: m.total_cost_usd ?? 0, currency: 'USD' } });
    this.turning = false;
    const ids = m.user_message_uuids ?? (m.user_message_uuid ? [m.user_message_uuid] : []);
    // A message sent into the prompt's turn (steer) is the prompt's, and so is the turn Claude Code runs it in when the prompt's
    // own ended before taking it: the prompt is answered once none is left to take. Stopped or failed with some not taken
    // yet, it ends once those are dropped (dropRest); one ending already ends as it was to.
    const steered = ids.filter(id => this.steering.delete(id)).length > 0;
    const id = ids.find(id => this.prompts.has(id)) ?? (steered ? this.held : undefined);
    const cancelled = interrupted(m), failed = !cancelled && (m.is_error || m.subtype !== 'success');
    if (id) {
      const outcome = this.ending ?? (failed ? { failure: errorText(m) } : { stopReason: cancelled ? 'cancelled' : 'end_turn' });
      if (this.ending || !this.steering.size) this.settle(id, outcome);
      else { this.held = id; if (cancelled || failed) this.dropRest(outcome); }
    } else if (this.waits.handling) {
      // A turn of Claude's own has no reply to fail: what went wrong is said in it.
      if (failed) this.chunk(this.sessionId, 'text', m.uuid, errorText(m));
      this.waits.finished();
    } else if (failed && this.prompts.size) {
      // A failure of the session itself names no input: none of those given can be said to have run.
      for (const prompt of this.prompts.values()) prompt.reject(failure(errorText(m)));
      this.prompts.clear();
    }
    void this.title?.refresh(!failed && !cancelled);
  }
  async close() {
    if (this.phase === 'ended' || this.phase === 'closing') return this.pump;
    this.phase = 'closing'; this.input.close();
    for (const withdrawn of this.withdrawals) withdrawn.abort();
    try { this.query?.close(); } catch {}
    if (this.pump) await this.pump; else this.phase = 'ended';
  }
}
