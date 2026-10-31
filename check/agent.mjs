// The handshake and live levels for one agent: the checker plays Coda (backend/src/adapters/acp.mjs AcpSession), starts the
// agent's command the way Coda does, says what Coda says, and holds what the agent says to ACP's schema and to
// docs/agent-protocol.md. Where Coda would quietly drop or refuse something, the check fails and says what Coda does.
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import { agentCapabilitiesProblem, agentMessageProblem, agentResultProblem, agentValueProblem } from '@coda-console/protocol/agent';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { cleared } from './coda/components/plugins/plugin-rules.mjs';
import { RETRY_DELAYS, continuationPrompt, serviceFailure } from './coda/components/prompt-recovery/prompt-recovery.mjs';
import { NOT_STEERED, OPEN_LIMIT, REMOTE_CODE, SIGNED_OUT, STEERED, STEERING, STOP_LIMIT, TERM_GRACE, clientCapabilities, currentModel, steeringParams, supportsSteering, systemPrompt,
  takesInstructions } from './coda/domain/agent-protocol.mjs';
import { agentErrorMessage } from './coda/kernel/agent-failures.mjs';
import { temporary } from './leftovers.mjs';
import { AgentProcess, Exited, Timeout } from './process.mjs';
import { explain, schemas } from './schema.mjs';
import { Waits } from './waits.mjs';

// The ACP version Coda speaks: the SDK's, at the version Coda pins (check/coda/contract.json `packages`, as package.json here).
export const ACP_PROTOCOL_VERSION = PROTOCOL_VERSION;
// What Coda answers an agent request it has no handler for (JSON-RPC's, as the SDK sends it): it handles only approvals and forms.
const METHOD_NOT_FOUND = -32601;
// `exit`: how long an agent may take to go after SIGTERM, or after its input ends. `cancelReply`: how soon a turn whose work
// was done answers once it has read the cancel. `pause`: a quiet moment between two turns, as between two messages of a
// person, for what an agent says after a turn to be heard outside it. `term`: how long Coda's session host waits after
// SIGTERM before SIGKILL. `steer`: how long a steering request may take to be answered; `steerQuiet`: how long an agent that
// answered one outside a turn is watched for a turn of its own.
export const LIMITS = { open: OPEN_LIMIT, turn: 180_000, settle: 60_000, cancel: STOP_LIMIT, exit: 5_000, cancelDelay: 500, cancelReply: 5_000,
  pause: 500, term: TERM_GRACE, retryDelays: RETRY_DELAYS, steer: 30_000, steerQuiet: 2_000 };
// A request of the checker's own, sent right behind a `session/cancel`; nothing answers it but an error (Method not found).
// The agent reads it after the cancel, so its answer is written after the agent has read the cancel.
export const BARRIER = '_codaCheck/barrier';
// What an agent says of a session rather than does in a turn: what it says of these after a cancel is no work.
const BOOKKEEPING = new Set(['available_commands_update', 'current_mode_update', 'config_option_update', 'session_info_update', 'usage_update']);
// The session instructions the checker gives in Coda's place (Coda's own are backend/src/domain/client-instructions.mjs: how
// replies show in its clients, the reply language, the plugins' instructions): a word in them that only an agent that took
// them in before its first turn can say, asked for in that turn.
export const CHECK_QUESTION = 'What is the Coda check word?';
const instructionsFor = word => `# Coda client

Your replies are shown in Coda, a graphical client on Mac and iPhone, not in a terminal. This session is run by coda-plugin-check, which plays Coda.

If the user asks for the Coda check word, reply with exactly ${word} and nothing else.`;
// A turn with something to say for a while, and a message for it as it goes; and one that comes once a turn has ended.
const STEER_TURN = '从 1 数到 20，每个数字单独一行。', STEER_TEXT = '数完后再说一句「插话收到」。', STEER_LATE = '这条插话到的时候，这一轮已经结束了。';
const secs = ms => (ms / 1000).toFixed(1);
const short = (text, max = 80) => (text.length > max ? `${text.slice(0, max)}…` : text).replace(/\s+/g, ' ');

// Optional extensions are checked only when present; null is a value, not an absent declaration. Read the wire values:
// ACP parsers may drop optional fields they cannot read. Only the protocol decides an extension's shape.
const optionalValueProblem = (ref, value, where) => value === undefined ? null : agentValueProblem(ref, value, where);
const failureProblem = error => optionalValueProblem('failure.json', error?.data?._meta?.coda?.failure, 'error.data._meta.coda.failure');
function configProblems(configOptions, where) {
  const problems = [];
  const check = (option, path) => {
    const problem = optionalValueProblem('default.json', option?._meta?.coda, `${path}._meta.coda`);
    if (problem) problems.push(problem);
  };
  if (!Array.isArray(configOptions)) return problems;
  for (const [i, config] of configOptions.entries()) {
    if (config?.type !== 'select' || !Array.isArray(config.options)) continue;
    for (const [j, option] of config.options.entries()) {
      const at = `${where}[${i}].options[${j}]`;
      // ACP choices are flat or grouped once; extra fields on a leaf do not turn it into a group.
      if (option?.value === undefined && Array.isArray(option?.options))
        for (const [k, child] of option.options.entries()) check(child, `${at}.options[${k}]`);
      else check(option, at);
    }
  }
  return problems;
}

// The environment Coda starts the agent with: the session's (here the checker's), and what Coda gives its plugin's processes
// (`checked.env`, components/plugins/plugin-rules.mjs pluginEnv) with the state directory made for it.
const agentEnv = (checked, base) => ({ ...cleared(process.env), ...checked.env(join(base, 'state')) });

// One process of the agent with the session it opens, and what it says, taken in order.
class Session {
  constructor({ agent, checked, base, say, limits, instructions }) {
    this.say = say; this.limits = limits; this.instructions = instructions;
    this.waits = new Waits({ fail: (rule, message) => this.at.fail(rule, message), warn: (rule, message) => this.at.warn(rule, message) });
    this.turn = null; this.autonomous = null; this.autonomousTurns = 0; this.loading = true; this.pendingWaits = [];
    this.kinds = new Map(); this.malformed = 0; this.said = new Set(); this.listeners = new Set(); this.idleWork = [];
    // The session's working copy, and the plugin's state directory, which Coda makes for it.
    this.cwd = join(base, 'work');
    for (const dir of [this.cwd, join(base, 'state')]) mkdirSync(dir, { recursive: true });
    this.proc = new AgentProcess({ command: agent.command, cwd: this.cwd,
      env: agentEnv(checked, base),
      onMessage: message => { this.receive(message); this.changed(); }, onNoise: (line, why) => this.noise(line, why) });
    this.proc.exited.then(() => this.changed());
  }
  // The level things are said at now: the live level once a turn has been sent.
  get at() { return this.live ? this.say.live : this.say.handshake; }
  once(key, fn) { if (!this.said.has(key)) { this.said.add(key); fn(); } }
  changed() { for (const listener of this.listeners) listener(); }
  // Resolves true once `condition` holds, false past `ms` or when the process has ended without it holding.
  until(condition, ms) {
    if (condition()) return Promise.resolve(true);
    return new Promise(resolve => {
      const done = value => { clearTimeout(timer); this.listeners.delete(listener); resolve(value); };
      const listener = () => { if (condition()) done(true); else if (this.proc.exit) done(false); };
      const timer = setTimeout(() => done(condition()), Math.max(0, ms));
      this.listeners.add(listener);
    });
  }
  noise(line, why) {
    if (why === 'not-json') this.once('noise', () => this.at.warn('wire.noise', `标准输出里有不是 JSON 的行（「${short(line, 60)}」）：Coda 丢掉它；日志请写标准错误`));
    else this.at.fail('wire.shape', `标准输出里有不是 JSON 对象的消息（「${short(line, 60)}」）：Coda 不收批量消息，整条丢掉`);
  }

  receive(m) {
    if ('id' in m) return this.request(m);
    if (m.method === 'session/update') return this.update(m.params);
    if (m.method === '_coda/wait') {
      // Coda keeps what is said while a session opens until it knows the session (docs/agent-protocol.md「Agent 活动」规则 7).
      if (this.loading) this.pendingWaits.push(m.params); else this.wait(m.params);
      return;
    }
    if (m.method === '$/cancel_request') return;
    this.once(`notify:${m.method}`, () => this.at.info('notify.unknown', `Agent 发了 Coda 不认识的通知 ${m.method}：Coda 忽略`));
  }
  update(params) {
    const parsed = schemas.zSessionNotification.safeParse(params);
    if (!parsed.success) {
      this.malformed++;
      this.at.fail('update.schema', `session/update 不合 ACP schema（SDK 1.4.0）：${explain(parsed.error, params)}`);
      return;
    }
    const update = params.update, kind = update.sessionUpdate;
    const problems = kind === 'config_option_update' ? configProblems(update.configOptions, 'session/update params.update.configOptions') : [];
    if (kind === 'tool_call' || kind === 'tool_call_update')
      problems.push(optionalValueProblem('review.json', update._meta?.coda?.review, 'session/update params.update._meta.coda.review'));
    if (kind === 'usage_update') problems.push(optionalValueProblem('usage.json', update._meta?.coda, 'session/update params.update._meta.coda'));
    for (const problem of problems.filter(Boolean)) { this.malformed++; this.at.fail('update.schema', problem); }
    // Of a session being opened Coda keeps only its commands and title; a replayed history it does not want.
    if (this.loading) return;
    if (!this.waits.owns(params.sessionId)) {
      this.at.fail('update.session', `session/update 说的会话 ${params.sessionId} 不是本会话，也不是 _coda/wait 登记过的子会话：Coda 丢弃`);
      return;
    }
    this.kinds.set(kind, (this.kinds.get(kind) ?? 0) + 1);
    const turn = this.turn ?? this.autonomous;
    if (turn) {
      turn.updates++;
      if (kind === 'agent_message_chunk' && params.update.content?.type === 'text') turn.text += params.update.content.text;
      if (turn.barrier?.answered && !BOOKKEEPING.has(kind)) turn.workAfterCancel.push(kind);
    } else if (!BOOKKEEPING.has(kind)) this.idleWork.push(kind);
  }
  wait(params) {
    this.waits.take(params, { turn: !!this.turn });
    this.track();
  }
  // Coda opens a turn of its own for a wait that goes `handling` outside a turn it sent, and ends it when none is
  // (docs/agent-protocol.md「Agent 活动」规则 3); one that went `handling` in a turn it sent goes on in one as that turn ends.
  track() {
    const handling = this.waits.handling.length;
    if (!this.turn && handling && !this.autonomous) { this.autonomous = { started: Date.now(), updates: 0, text: '' }; this.autonomousTurns++; }
    if (this.autonomous && !handling) { this.lastAutonomous = this.autonomous; this.autonomous = null; }
  }
  request(m) {
    const inTurn = !!(this.turn || this.autonomous);
    if (m.method === 'session/request_permission' || m.method === 'elicitation/create') {
      const permission = m.method === 'session/request_permission', what = permission ? '审批' : '提问';
      const refuse = permission ? { outcome: { outcome: 'cancelled' } } : { action: 'cancel' };
      const parsed = (permission ? schemas.zRequestPermissionRequest : schemas.zCreateElicitationRequest).safeParse(m.params);
      if (!parsed.success) { this.at.fail('request.schema', `${m.method} 不合 ACP schema：${explain(parsed.error, m.params)}`); this.proc.respond(m.id, refuse); return; }
      if (typeof m.params.sessionId === 'string' && !this.waits.owns(m.params.sessionId)) this.at.fail('request.session', `${what}说的会话 ${m.params.sessionId} 不是本会话或登记过的子会话`);
      if (!inTurn) {
        this.at.fail('request.outside-turn', `${what}在一轮之外发来（没有进行中的 session/prompt，也没有 handling 的活动）：Coda 拒绝（${permission ? '回 cancelled' : '回 cancel'}），在会话里记一条说明`);
        this.proc.respond(m.id, refuse);
        return;
      }
      if (permission) {
        const reject = m.params.options.find(o => o.kind === 'reject_once') ?? m.params.options.find(o => o.kind === 'reject_always');
        this.proc.respond(m.id, reject ? { outcome: { outcome: 'selected', optionId: reject.optionId } } : refuse);
        this.at.info('request.permission', `审批「${short(m.params.toolCall?.title ?? m.params.toolCall?.toolCallId ?? '')}」：检查一律拒绝（${reject ? `选 ${reject.optionId}` : '没有拒绝的选项，回 cancelled'}）`);
      } else {
        this.proc.respond(m.id, { action: 'decline' });
        this.at.info('request.elicitation', `提问「${short(m.params.message ?? '')}」：检查一律回 decline`);
      }
      return;
    }
    // A code binding the place a remote agent works (docs/agent-protocol.md「远端入口」): Coda answers it for the agent's own
    // session only, here with a code that binds nothing and no address, as on a machine in no tailnet.
    if (m.method === REMOTE_CODE) {
      const problem = agentMessageProblem(m.method, m.params);
      if (problem) { this.at.fail('request.schema', problem); this.proc.respondError(m.id, -32602, problem); return; }
      if (m.params?.sessionId !== this.sessionId) {
        this.at.fail('request.session', `绑定码请求说的会话 ${m.params?.sessionId} 不是本会话：Coda 只为本会话发绑定码`);
        this.proc.respondError(m.id, -32603, '只能为本会话请求');
        return;
      }
      this.proc.respond(m.id, { code: randomBytes(12).toString('base64url'), expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), addresses: [] });
      this.at.info('request.remote-code', '绑定码：检查给一个绑不上任何东西的码，没有入口地址');
      return;
    }
    // Coda handles nothing else an agent asks: its ACP SDK answers that the method is not found.
    this.proc.respondError(m.id, METHOD_NOT_FOUND, `"Method not found": ${m.method}`);
    this.once(`request:${m.method}`, () => this.at.warn('request.unsupported', `Agent 请求了 ${m.method}：Coda 不提供（没声明 fs、terminal），回 -32601`));
  }

  // initialize, then session/new or session/load as AcpSession.initialize does. Returns 'ok', 'signed-out' or 'failed'.
  async open(sessionId = null) {
    const say = this.at;
    let reply;
    try { reply = await this.proc.request('initialize', { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: clientCapabilities() }, { timeout: this.limits.open }); }
    catch (e) { this.reportedExit = e instanceof Exited; say.fail('handshake.initialize', `initialize 失败：${e.message}`); return 'failed'; }
    const initFailure = failureProblem(reply.error);
    if (initFailure) { say.fail('handshake.initialize', initFailure); return 'failed'; }
    if (reply.error?.code === SIGNED_OUT) { say.skip('handshake.signed-out', `initialize 回了 -32000（未登录）：Coda 提示用户去「资源」登录；后面的检查跳过`); return 'signed-out'; }
    if (reply.error) { say.fail('handshake.initialize', `initialize 回了错误 ${reply.error.code}：${reply.error.message}`); return 'failed'; }
    const init = schemas.zInitializeResponse.safeParse(reply.result);
    if (!init.success) { say.fail('handshake.initialize', `initialize 的结果不合 ACP schema：${explain(init.error)}`); return 'failed'; }
    for (const problem of [agentCapabilitiesProblem(reply.result.agentCapabilities?._meta),
      optionalValueProblem('steering.json#/$defs/capabilities', reply.result._meta, 'initialize result._meta')])
      if (problem) say.fail('handshake.initialize', problem);
    this.init = reply.result;
    if (reply.result.protocolVersion !== ACP_PROTOCOL_VERSION) {
      say.fail('handshake.protocol', `protocolVersion 是 ${reply.result.protocolVersion}：Coda 用的 ACP（SDK 1.4.0）是版本 ${ACP_PROTOCOL_VERSION}（Coda 自己不核对这一项，按它说的协议说话）`);
      return 'failed';
    }
    const caps = reply.result.agentCapabilities ?? {}, waits = !!caps._meta?.coda?.waits && typeof caps._meta.coda.waits === 'object';
    this.canLoad = caps.loadSession === true; this.instructed = takesInstructions(reply.result); this.steering = supportsSteering(reply.result);
    if (!sessionId) {
      say.pass('handshake.initialize', `initialize：protocolVersion ${ACP_PROTOCOL_VERSION}，loadSession ${this.canLoad}，${waits
        ? '声明了 _meta.coda.waits' : '没声明 _meta.coda.waits（只是声明，登记照收）'}${caps.sessionCapabilities?.additionalDirectories != null ? '，收 additionalDirectories' : ''}，${this.steering
        ? '声明了插话（_meta.steering）' : '没声明插话'}`);
      if (this.instructed) say.pass('handshake.system-prompt', '声明了会话指令（sessionCapabilities.systemPrompt）：session/new、session/load 带 Coda 的指令（append 模式）');
      else say.fail('handshake.system-prompt', 'initialize 没声明 agentCapabilities.sessionCapabilities.systemPrompt：Coda 照 ACP 的规矩不发会话指令（回复在 Mac、iPhone 上怎样显示、回复语言、插件说明），接入 Coda 的 Agent 必须声明。'
        + '有原生系统提示词入口的放在那里；没有的，在原生会话第一次 session/prompt 时把指令作为单独、明确分隔的一段放在用户输入前面送入，之后与 session/load 恢复的会话不再送');
    }
    if (sessionId && !this.canLoad) { say.fail('handshake.load', '新进程的 initialize 不再声明 loadSession：Coda 恢复不了这个会话'); return 'failed'; }
    const method = sessionId ? 'session/load' : 'session/new';
    // Coda's instructions go with every open of the session, `session/load` too.
    const instructions = this.instructed ? { systemPrompt: systemPrompt(this.instructions) } : {};
    try { reply = await this.proc.request(method, { cwd: this.cwd, mcpServers: [], ...instructions, ...(sessionId ? { sessionId } : {}) }, { timeout: this.limits.open }); }
    catch (e) { this.reportedExit = e instanceof Exited; say.fail(sessionId ? 'handshake.load' : 'handshake.new', `${method} 失败：${e.message}`); return 'failed'; }
    const openFailure = failureProblem(reply.error);
    if (openFailure) { say.fail(sessionId ? 'handshake.load' : 'handshake.new', openFailure); return 'failed'; }
    if (reply.error?.code === SIGNED_OUT) { say.skip('handshake.signed-out', `${method} 回了 -32000（未登录）：Coda 提示用户去「资源」登录；后面的检查跳过`); return 'signed-out'; }
    if (reply.error) { say.fail(sessionId ? 'handshake.load' : 'handshake.new', `${method} 回了错误 ${reply.error.code}：${reply.error.message}`); return 'failed'; }
    const parsed = (sessionId ? schemas.zLoadSessionResponse : schemas.zNewSessionResponse).safeParse(reply.result);
    if (!parsed.success) { say.fail(sessionId ? 'handshake.load' : 'handshake.new', `${method} 的结果不合 ACP schema：${explain(parsed.error)}`); return 'failed'; }
    for (const problem of configProblems(reply.result.configOptions, `${method} result.configOptions`))
      say.fail(sessionId ? 'handshake.load' : 'handshake.new', problem);
    this.sessionId = sessionId ?? reply.result.sessionId; this.waits.sessionId = this.sessionId; this.info = reply.result;
    this.loading = false;
    for (const params of this.pendingWaits.splice(0)) this.wait(params);
    const model = currentModel(reply.result);
    if (typeof model !== 'string') {
      say.fail('handshake.model', `${method} 没报当前模型（configOptions 里 category 为 model 的 currentValue，或 models.currentModelId）：Coda 每轮开始前核对，没有就不发这一轮（「适配器未报告实际模型」）`);
      return 'failed';
    }
    if (!sessionId) say.pass('handshake.new', `session/new：会话 ${this.sessionId}，当前模型 ${model}`);
    return 'ok';
  }
  // One turn of Coda's: `session/prompt` with an ID of Coda's choosing, as AcpSession.prompt sends it. With `cancel`, stopped
  // after the agent first says something, or `cancelDelay` after it was sent; the barrier behind the cancel tells what the
  // agent said and did before it read the cancel from what it said and did after (`workAfterCancel`, `readCancel`). With
  // `steer`, that message is sent into the turn once the agent first says something, as Coda steers a turn under way; its
  // answer is the turn's `steered`. `as`: the rule the turn is said under; one but `live.turn` is judged by the caller, from
  // `last` (the turn).
  async prompt(text, { cancel = false, steer = null, as = 'live.turn', attempt = 0, accepted = false } = {}) {
    const say = this.say.live, id = randomUUID(), rule = cancel ? 'live.cancel' : as;
    const turn = this.last = this.turn = { started: Date.now(), updates: 0, text: '', barrier: null, workAfterCancel: [], readCancel: false, replied: null, steered: null };
    const reply = this.proc.request('session/prompt', { sessionId: this.sessionId, prompt: [{ type: 'text', text }] },
      { id, timeout: this.limits.turn, onReply: () => { turn.readCancel = !!turn.barrier?.answered; turn.replied = Date.now(); this.turn = null; this.track(); this.changed(); } });
    reply.catch(() => { if (this.turn === turn) { this.turn = null; this.track(); this.changed(); } });
    let cancelledAt = null;
    if (cancel) {
      await this.until(() => this.turn !== turn || turn.updates > 0, this.limits.cancelDelay);
      if (this.turn === turn) {
        cancelledAt = Date.now();
        this.proc.notify('session/cancel', { sessionId: this.sessionId });
        // Taken as it is read, in order with the reply to the turn (`onReply`, not a promise's callback, which comes later).
        const barrier = turn.barrier = { answered: null };
        this.proc.request(BARRIER, {}, { timeout: this.limits.cancel, onReply: () => { barrier.answered = Date.now(); } }).catch(() => {});
      }
    }
    if (steer) {
      await this.until(() => this.turn !== turn || turn.updates > 0, this.limits.turn);
      if (this.turn === turn) turn.steered = this.steer(steer);
    }
    let m, timer;
    try {
      m = cancelledAt ? await Promise.race([reply, new Promise((_, reject) => { timer = setTimeout(reject, this.limits.cancel, new Timeout('取消后的 session/prompt', this.limits.cancel)); })])
        : await reply;
    } catch (e) {
      this.reportedExit = e instanceof Exited;
      say.fail(rule, e instanceof Timeout && cancelledAt
        ? `session/cancel 后 ${secs(this.limits.cancel)} 秒这一轮还没结束：Coda 会关掉托管连接与它的进程组，结果未知`
        : `这一轮没有结束：${e.message}`);
      return null;
    } finally { clearTimeout(timer); }
    if (m.error) {
      const problem = failureProblem(m.error);
      if (problem) { say.fail(rule, problem); return null; }
      // As Coda retries (PromptRecovery): an upstream wait past its one-minute budget is not waited for, and a shorter one is
      // waited at least as long as it asks.
      const failure = serviceFailure(m.error), upstream = failure?.retryAfterMs ?? 0, base = this.limits.retryDelays[attempt];
      const wait = base === undefined || upstream > RETRY_DELAYS.at(-1) ? undefined : Math.max(base, upstream);
      if (!cancel && !text.startsWith('/') && failure && wait !== undefined) {
        say.info('live.service-retry', `服务暂不可用，按 Coda 策略 ${secs(wait)} 秒后第 ${attempt + 1} 次重试`);
        await delay(wait);
        accepted ||= failure.input === 'accepted';
        return this.prompt(accepted ? continuationPrompt : text, { as, attempt: attempt + 1, accepted });
      }
      say.fail(rule, `session/prompt 回了错误 ${m.error.code}：${agentErrorMessage(m.error)}（Coda 把这一轮记为失败）`);
      return null;
    }
    const parsed = schemas.zPromptResponse.safeParse(m.result);
    if (!parsed.success) { say.fail(rule, `session/prompt 的结果不合 ACP schema：${explain(parsed.error)}`); return null; }
    const stop = m.result.stopReason;
    if (rule !== 'live.turn' && !cancel) return stop;
    if (!cancel) {
      say.pass('live.turn', `一轮结束：stopReason ${stop}，${secs(Date.now() - turn.started)} 秒，${turn.updates} 条 session/update${turn.text ? `，回复「${short(turn.text)}」` : ''}`);
      if (!turn.text) say.warn('live.reply', '这一轮没有回复文字（agent_message_chunk）');
    } else if (!cancelledAt) say.info('live.cancel', `第二轮在取消前就结束了（stopReason ${stop}），取消没机会生效`);
    else {
      say.pass('live.cancel', `session/cancel 后 ${secs(Date.now() - cancelledAt)} 秒结束，stopReason ${stop}`);
      // A turn that goes on once it has read the cancel — says or does more, or answers only a while later — and then does not
      // say `cancelled` would not stop. One that had ended does not have to: its answer was on its way as the cancel went out,
      // or its work was done and it answers at once (Coda's own Codex entry, waiting on a title, says end_turn then).
      const after = turn.workAfterCancel, late = turn.readCancel && turn.replied - turn.barrier.answered > this.limits.cancelReply;
      if (stop !== 'cancelled' && (after.length || late)) say.fail('live.cancel-reason', `读到 session/cancel 之后这一轮${after.length
        ? `还在接着做（又发了 ${after.length} 条 session/update：${[...new Set(after)].join('、')}）` : `又过了 ${secs(turn.replied - turn.barrier.answered)} 秒才答复`}，最后回 stopReason ${stop}：ACP 要求停下并回 cancelled；Coda 按回的记，这一轮成了正常结束而不是已停止`);
      else if (stop !== 'cancelled') say.info('live.cancel-reason', `这一轮回了 stopReason ${stop}：${turn.readCancel
        ? '读到 session/cancel 时它已经做完（之后没再做什么，随即答复）' : '答复写出时还没读到 session/cancel（先于紧跟取消发的探测请求的答复）'}，取消送到前这一轮已经结束，不算没停`);
    }
    return stop;
  }
  // `_session/steering` as Coda sends it: `{ result }` holds the agent's answer, `{ error }` a diagnostic.
  async steer(text) {
    try {
      const m = await this.proc.request(STEERING, steeringParams(this.sessionId, text), { timeout: this.limits.steer });
      if (m.error) return { error: failureProblem(m.error) ?? `回了错误 ${m.error.code}：${m.error.message}` };
      const problem = agentResultProblem(STEERING, m.result);
      return problem ? { error: problem } : { result: m.result };
    } catch (e) { this.reportedExit = e instanceof Exited; return { error: e.message }; }
  }
  // Waits for every open wait to end, `limit` at most; with `cancel`, stops the first turn of its own the agent takes.
  async settle(limit, { cancel = false } = {}) {
    const say = this.say.live, deadline = Date.now() + limit;
    let stopped = false;
    while (this.waits.open.length && Date.now() < deadline && !this.proc.exit) {
      await this.until(() => !this.waits.open.length || (cancel && !stopped && this.autonomous), deadline - Date.now());
      if (cancel && !stopped && this.autonomous) {
        stopped = true;
        const at = Date.now();
        this.proc.notify('session/cancel', { sessionId: this.sessionId });
        if (await this.until(() => !this.autonomous, this.limits.cancel)) say.pass('live.cancel-autonomous', `自主轮次里发 session/cancel，${secs(Date.now() - at)} 秒后没有项再处于 handling`);
        else say.fail('live.cancel-autonomous', `自主轮次里发 session/cancel 后 ${secs(this.limits.cancel)} 秒还有项在 handling：Coda 会关掉托管连接与它的进程组`);
      }
    }
    return !this.waits.open.length;
  }
  // Stops it as Coda's session host stops an agent (adapters/session-host.mjs): SIGTERM to its process group, its input
  // left open. It should be gone within `exit`; past `term` Coda would already have sent SIGKILL. One that ended before is
  // said to have, unless that was said already. Its process group goes either way.
  async finish(say) {
    if (this.proc.exit) {
      const { code, signal } = this.proc.exit, words = this.proc.lastWords();
      if (!this.reportedExit) say.fail('handshake.exited', `Agent 进程提前退出了（${signal ? `信号 ${signal}` : `退出码 ${code}`}）${words ? `：${words}` : ''}`);
    } else {
      const took = await this.proc.terminate(this.limits.exit);
      if (took === null) say.fail('handshake.sigterm', `SIGTERM 后 ${secs(this.limits.exit)} 秒还没退出：Coda 关会话时对 Agent 的进程组发 SIGTERM，${secs(this.limits.term)} 秒后 SIGKILL`);
      else {
        say.pass('handshake.sigterm', `SIGTERM 后 ${secs(took)} 秒退出`);
        if (took > this.limits.term) say.warn('handshake.sigterm-slow', `SIGTERM 后 ${secs(took)} 秒才退出：Coda 只等 ${secs(this.limits.term)} 秒就 SIGKILL，收尾会被打断`);
      }
    }
    this.proc.kill();
  }
}

// The end of its input, in a process of its own once it has answered `initialize`: what an agent sees when whatever runs
// it is gone without stopping it (Coda's session host killed outright). Coda stops agents with SIGTERM and does not rely on
// it, so one that stays is only worth a look.
async function inputEnd({ agent, checked, base, limits, say }) {
  const proc = new AgentProcess({ command: agent.command, cwd: join(base, 'work'), env: agentEnv(checked, base) });
  try {
    try { await proc.request('initialize', { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: clientCapabilities() }, { timeout: limits.open }); }
    catch { return; }
    const took = await proc.closeInput(limits.exit);
    if (took !== null) say.pass('handshake.exit-input', `关掉标准输入后 ${secs(took)} 秒退出`);
    else say.warn('handshake.exit-input', `关掉标准输入后 ${secs(limits.exit)} 秒还没退出：Coda 关会话用 SIGTERM，不靠它；但托管它的进程意外没了时，它只看得到输入结束，会一直留着`);
  } finally { proc.kill(); }
}

// The first turn asks for the word in the session instructions (docs/agent-protocol.md「会话指令」): they are to be in the
// agent's context before it, whether its own system prompt took them or they went in front of the user's input.
async function instructions(session, word, limits, say) {
  if (!session.instructed) { say.skip('live.instructions', '没声明会话指令：Coda 不发 systemPrompt，指令是否生效查不了'); return true; }
  if (!await session.prompt(CHECK_QUESTION, { as: 'live.instructions' })) return false;
  const text = session.last.text;
  if (text.includes(word)) say.pass('live.instructions', `会话指令在第一轮之前生效：第一轮问指令里的检查词，回复里有 ${word}`);
  else say.fail('live.instructions', `会话指令没在第一轮之前生效：session/new 的 systemPrompt 里写了检查词 ${word}，第一轮问它，回复${text ? `「${short(text)}」` : '没有文字'}，没有说出它。`
    + '有原生系统提示词入口的放在那里；没有的，在原生会话第一次 session/prompt 时把指令作为单独、明确分隔的一段放在用户输入前面送入');
  await delay(limits.pause);
  return true;
}

// docs/agent-protocol.md「插话」: Coda steers only a turn of its own under way, but the turn may have ended by the time the
// message is read. One that has is answered promptRequired, and the agent takes no turn of its own for it; one under way
// takes it in (injected) and still ends with the original `session/prompt`. Anything else Coda records as unknown.
async function steering(session, limits, say) {
  if (!session.steering) { say.skip('live.steering', '没声明插话（_meta.steering.supported）：用户「立即插话」时 Coda 停止这一轮，结束后再把消息作为下一轮发出'); return; }
  if (!await session.until(() => !session.autonomous, limits.settle)) { say.warn('live.steering', `自主轮次 ${secs(limits.settle)} 秒还没结束，插话没查`); return; }
  const before = session.idleWork.length, late = await session.steer(STEER_LATE);
  if (session.proc.exit) return;
  await delay(limits.steerQuiet);
  const work = session.idleWork.slice(before);
  if (late.error) say.fail('live.steering', late.error);
  else if (late.result.outcome !== NOT_STEERED) say.fail('live.steering', `一轮已经结束时发 ${STEERING}，回了 outcome ${late.result.outcome}：要回 promptRequired（reason noRunningTurn），消息不收、也不自己另开一轮；Coda 把其他答复记为结果未知，不再把消息作为下一轮发出`);
  else if (work.length) say.fail('live.steering', `一轮已经结束时发 ${STEERING}，回了 promptRequired，随后却自己说起话来（${work.length} 条 session/update：${[...new Set(work)].join('、')}）：promptRequired 的消息没被接收，Agent 不得自己另开一轮，Coda 会把它作为下一轮发出`);
  else say.pass('live.steering', `一轮已经结束时插话：回 promptRequired${late.result.reason ? `（${late.result.reason}）` : ''}，${secs(limits.steerQuiet)} 秒里没有自己另开一轮`);
  await delay(limits.pause);
  const stop = await session.prompt(STEER_TURN, { steer: STEER_TEXT, as: 'live.steering' }), turn = session.last;
  if (!turn.steered) { if (stop) say.info('live.steering', `这一轮在说出第一句之前就结束了（stopReason ${stop}），一轮进行中的插话没机会发`); return; }
  const steered = await turn.steered;
  if (steered.error) say.fail('live.steering', steered.error);
  else if (!stop) return;
  else if (steered.result.outcome === STEERED) say.pass('live.steering', `一轮进行中插话：injected，原来的 session/prompt 照常结束（stopReason ${stop}，${turn.updates} 条 session/update${turn.text ? `，回复「${short(turn.text)}」` : ''}）`);
  else say.info('live.steering', `一轮进行中插话：回 promptRequired，插话到时这一轮已经结束（stopReason ${stop}）`);
}

async function live(session, { prompt, word }, limits, say) {
  session.live = true;
  if (!await instructions(session, word, limits, say)) return;
  if (!await session.prompt(prompt)) return;
  const settled = await session.settle(limits.settle), waits = session.waits.registered;
  if (waits.length) {
    const kinds = Object.entries(Object.groupBy(waits, w => w.kind)).map(([kind, list]) => `${kind} ×${list.length}`).join('，');
    say[settled ? 'pass' : 'warn']('live.waits', `Agent 活动：登记 ${waits.length} 个（${kinds}），自主轮次 ${session.autonomousTurns} 次${settled ? '，都已结束'
      : `；${secs(limits.settle)} 秒后还有 ${session.waits.open.length} 个没结束（定时与长任务可以这样，不算失败）`}`);
    if (session.lastAutonomous?.text) say.info('live.autonomous', `自主轮次的回复「${short(session.lastAutonomous.text)}」`);
  } else say.info('live.waits', '这一轮没有报 Agent 活动（_coda/wait）');
  await steering(session, limits, say);
  // A second turn, stopped; and a turn of the agent's own that it brings about, stopped too. Coda sends nothing while a turn
  // of the agent's own is under way: a message waits for it to end.
  await new Promise(resolve => setTimeout(resolve, limits.pause));
  if (!await session.until(() => !session.autonomous, limits.settle)) say.warn('live.cancel', `自主轮次 ${secs(limits.settle)} 秒还没结束，第二轮（取消）没发`);
  else {
    await session.prompt(prompt, { cancel: true });
    await session.settle(limits.settle, { cancel: true });
  }
  const kinds = [...session.kinds].map(([kind, n]) => `${kind} ×${n}`).join('，');
  if (!session.malformed) say.pass('live.updates', `session/update 都合 ACP schema（SDK 1.4.0）与 Coda 扩展 schema：${kinds || '无'}`);
}

// Checks one declared agent of the plugin as the manifest level read it (`checked`, manifest.mjs checkManifest), started as
// Coda starts it; `say(level)` gives the report scope for a level.
export async function checkAgent({ agent, checked, live: running = false, prompt = '只回复 ok', limits: given = {}, say }) {
  const limits = { ...LIMITS, ...given }, temp = temporary('coda-plugin-check-'), base = temp.dir;
  const scopes = { handshake: say('handshake'), live: say('live') }, sessions = [];
  const word = `coda-${randomBytes(3).toString('hex')}`, instructions = instructionsFor(word);
  try {
    const session = new Session({ agent, checked, base, say: scopes, limits, instructions });
    sessions.push(session);
    const opened = await session.open();
    if (opened === 'ok' && running) await live(session, { prompt, word }, limits, scopes.live);
    else if (running) scopes.live.skip('live.skipped', opened === 'signed-out' ? '未登录，一轮跳过' : '握手没过，一轮跳过');
    else scopes.live.skip('live.skipped', '一轮要 --live（会真的发一条提示词，可能要登录、花额度）');
    await session.finish(scopes.handshake);
    if (opened !== 'failed') await inputEnd({ agent, checked, base, limits, say: scopes.handshake });
    if (opened !== 'ok' || !running) return;
    if (!session.canLoad) { scopes.live.skip('live.load', '没声明 loadSession：Coda 不会要求恢复，session/load 不查'); return; }
    const again = new Session({ agent, checked, base, say: scopes, limits, instructions });
    sessions.push(again);
    again.live = true;
    if (await again.open(session.sessionId) === 'ok') {
      scopes.live.pass('live.load', `新进程 session/load 接上了会话 ${session.sessionId}${again.instructed ? '（同样带着会话指令）' : ''}`);
      // The session goes on in the new process: Coda's next message is a turn of it. An agent that answers the load but keeps
      // no session for it ("Session not found") leaves a resumed session that cannot go on.
      const stop = await again.prompt(prompt, { as: 'live.load-turn' });
      if (stop) scopes.live.pass('live.load-turn', `恢复后的一轮结束：stopReason ${stop}`);
    }
    await again.finish(scopes.live);
  } finally {
    for (const session of sessions) session.proc.kill();
    temp.remove();
  }
}
