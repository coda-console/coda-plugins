// Coda's backend/test/fixture-sdk.mjs at ef1d2311: the Claude SDK stood in for, as the Claude entry's tests use it.
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
// The queries started in this process, by session: a test in the same process can say what the SDK says (`emit`).
export const queries = new Map();
export function fixtureSdk(argv = []) {
  const models = [{ value: 'fixture-model', displayName: 'Fixture model', resolvedModel: 'fixture-model-v1', description: 'Fixture capabilities', supportedEffortLevels: ['low', 'high'] },
    { value: 'other-model', displayName: 'Other model', supportedEffortLevels: ['high'] },
    { value: 'fixture-alias', displayName: 'Fixture alias', resolvedModel: 'fixture-model-v1', supportedEffortLevels: ['high'] },
    { value: 'fixture-model-v1[1m]', displayName: 'Fixture long context', resolvedModel: 'fixture-model-v1', supportedEffortLevels: ['high'] },
    { value: 'claude-custom-1', displayName: 'Custom', supportedEffortLevels: [] }];
  const commands = [{ name: 'fixture', description: 'Fixture command' }];
  const path = (cwd, id) => join(cwd, `.sdk-${id}.json`);
  class Query {
    // The background tasks that have not ended, as the SDK lists them whenever the list changes.
    alive = new Map();
    usage = { input_tokens: 10 };
    queue = []; wake = null; closed = false; controller = new AbortController();
    constructor({ prompt, options }) {
      this.options = options; this.id = options.resume ?? options.sessionId; this.model = options.model ?? models[0].value; this.mode = options.permissionMode ?? 'default';
      this.effort = options.settings?.effortLevel;
      this.entries = options.resume ? JSON.parse(readFileSync(path(options.cwd, this.id))) : [];
      this.persist(); queries.set(this.id, this);
      // What the client writes is read as it comes (`received`, all of it), and turns run one at a time: a message marked `next`
      // that comes while one runs is taken into it at its next tool round (fold), as Claude Code does; else it runs after it.
      this.inbox = []; this.received = [];
      void (async () => { for await (const m of prompt) { if (this.closed) break; this.received.push(m); this.inbox.push(m); this.arrived?.(); } })();
      void (async () => { while (!this.closed) { const m = this.paused ? undefined : this.inbox.shift(); if (m) await this.respond(m); else await new Promise(r => { this.arrived = r; }); } })();
    }
    persist() { writeFileSync(path(this.options.cwd, this.id), JSON.stringify(this.entries)); }
    emit(message) { this.queue.push({ session_id: this.id, uuid: randomUUID(), ...message }); this.wake?.(); }
    // What is given is not taken until the test lets it (the function returned), as while a turn of Claude Code's own goes on.
    pause() { this.paused = true; return () => { this.paused = false; this.arrived?.(); }; }
    // What it says from now on is not read until the test lets it (the function returned): said, as the entry has not read it yet.
    hold() { let release; const held = new Promise(r => { release = r; }); this.queue.push(() => held); this.wake?.(); return release; }
    system(subtype, payload = {}) { this.emit({ type: 'system', subtype, ...payload }); }
    // Like the real SDK, every turn opens with a root init, including turns a finished task wakes.
    init() {
      this.system('init', { model: models.find(m => m.value === this.model)?.resolvedModel ?? this.model,
        permissionMode: this.mode, effort: this.effort, terminal_slash_commands: ['terminal-only'] });
    }
    async initializationResult() { return { models, commands }; }
    // A hook runs where it comes among the messages, as the CLI's control requests do.
    async *[Symbol.asyncIterator]() {
      while (!this.closed) {
        const next = this.queue.shift();
        if (typeof next === 'function') await next();
        else if (next) yield next;
        else await new Promise(r => { this.wake = r; });
      }
    }
    stop(crons) {
      return new Promise((resolve, reject) => { this.queue.push(() => this.options.hooks.Stop[0].hooks[0]({ session_id: this.id, session_crons: crons }).then(resolve, reject)); this.wake?.(); });
    }
    async respond(input) {
      this.controller = new AbortController(); this.inputId = input.uuid; this.folded = [];
      // `hold-idle:<prompt>`: the prompt as given, and the session's idle held back until `.release-idle` is in the checkout, so
      // that what happens between a turn's result and its idle (the native side not yet confirmed) can be placed exactly.
      const given = input.message.content, held = typeof given === 'string' && given.startsWith('hold-idle:');
      const text = held ? given.slice('hold-idle:'.length) : given;
      this.entries.push({ type: 'user', text, uuid: input.uuid }); this.persist();
      this.init();
      this.system('session_state_changed', { state: 'running' });
      // Tests place the exact SDK error/result sequence themselves, without a timer or an implicit result racing it.
      if (text === 'manual') return;
      if (text === 'permission' || text === 'cancelled-permission') {
        const abort = text === 'cancelled-permission' ? setTimeout(() => this.controller.abort(), 200) : null;
        const answer = await this.options.canUseTool('Bash', { command: 'echo fixture' }, { signal: this.controller.signal,
          toolUseID: 'tool-approval', suggestions: [{ type: 'addRules', destination: 'session', behavior: 'allow', rules: [{ toolName: 'Bash', ruleContent: 'echo fixture' }] }] });
        clearTimeout(abort); this.text(JSON.stringify(answer));
      } else if (text === 'mcp-servers') { this.text(JSON.stringify(this.options.mcpServers ?? null));
      } else if (text === 'rate-limit') {
        // What the CLI sends as a window moves: the one that limits now at the top, every window in `unifiedWindows`.
        this.emit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.91, resetsAt: 4102444800,
          unifiedWindows: { five_hour: { utilization: 0.11, resetsAt: 4102444800 - 86400 }, seven_day: { utilization: 0.91, resetsAt: 4102444800 } } } });
        this.text('额度已报告');
      } else if (text === 'questions') {
        const answer = await this.options.canUseTool('AskUserQuestion', { questions: [
          { question: '选一个', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false },
          { question: '选多个', options: [{ label: 'X' }, { label: 'Y' }], multiSelect: true },
        ] }, { signal: this.controller.signal });
        this.text(JSON.stringify(answer));
      } else if (text === 'form' || text === 'url') {
        const request = text === 'url' ? { mode: 'url', url: 'https://example.com/authorize', message: '登录后确认', elicitationId: 'url-1' } : {
          mode: 'form', message: '填写数字', requestedSchema: { type: 'object', properties: { n: { type: 'integer', minimum: 1 } }, required: ['n'], additionalProperties: false } };
        this.text(JSON.stringify(await this.options.onElicitation(request, { signal: this.controller.signal })));
      } else if (text === 'stream') {
        const id = randomUUID();
        this.emit({ type: 'stream_event', event: { type: 'message_start', message: { id } } });
        this.emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
        this.emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'first ' } } });
        await new Promise(r => setTimeout(r, 700));
        this.emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'second' } } });
        while (!this.closed && !existsSync(join(this.options.cwd, '.finish-stream'))) await new Promise(r => setTimeout(r, 10));
        if (this.closed) return;
        this.text('first second', id);
      } else if (text === 'background' || text === 'background-followup' || text === 'background-idle' || text === 'background-busy') {
        this.emit({ type: 'assistant', message: { id: randomUUID(), content: [{ type: 'tool_use', id: 'tool-bg', name: 'Bash', input: { command: 'echo fixture' } }] } });
        this.emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-bg', content: 'Command running in background with ID: fake.' }] } });
        this.system('task_started', { task_id: 'bg-1', tool_use_id: 'tool-bg', task_type: 'local_bash', description: '后台测试', is_backgrounded: true });
        const tasks = [{ task_id: 'bg-1', task_type: 'local_bash', description: '后台测试' }];
        this.alive.set('bg-1', tasks[0]);
        if (text === 'background-busy') {
          // A second command the agent never cleans up: the session stays running for good.
          this.system('task_started', { task_id: 'bg-2', tool_use_id: 'tool-bg', task_type: 'local_bash', description: '遗留后台', is_backgrounded: true });
          tasks.push({ task_id: 'bg-2', task_type: 'local_bash', description: '遗留后台' });
        }
        this.system('background_tasks_changed', { tasks });
        this.text('后台已启动');
      } else if (text === 'background-second') {
        // A second command, started in a turn of its own and never cleaned up: alongside the first, if that still goes on.
        this.emit({ type: 'assistant', message: { id: randomUUID(), content: [{ type: 'tool_use', id: 'tool-bg2', name: 'Bash', input: { command: 'echo second' } }] } });
        this.emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-bg2', content: 'Command running in background with ID: fake2.' }] } });
        this.system('task_started', { task_id: 'bg-2', tool_use_id: 'tool-bg2', task_type: 'local_bash', description: '第二个后台', is_backgrounded: true });
        this.alive.set('bg-2', { task_id: 'bg-2', task_type: 'local_bash', description: '第二个后台' });
        this.system('background_tasks_changed', { tasks: [...this.alive.values()] });
        this.text('第二个后台已启动');
      } else if (text === 'background-scheduled') {
        // A task and a wakeup, both of the turn: the call is held by both. The task is the one to go last (`.finish-background`),
        // and can be made to take its time to die (`.ignore-stop`).
        this.emit({ type: 'assistant', message: { id: randomUUID(), content: [{ type: 'tool_use', id: 'tool-bg', name: 'Bash', input: { command: 'echo fixture' } }] } });
        this.emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-bg', content: 'Command running in background with ID: fake.' }] } });
        this.system('task_started', { task_id: 'bg-1', tool_use_id: 'tool-bg', task_type: 'local_bash', description: '后台测试', is_backgrounded: true });
        this.alive.set('bg-1', { task_id: 'bg-1', task_type: 'local_bash', description: '后台测试' });
        this.system('background_tasks_changed', { tasks: [...this.alive.values()] });
        this.emit({ type: 'assistant', message: { id: randomUUID(), content: [{ type: 'tool_use', id: 'cron-call', name: 'CronCreate',
          input: { cron: '47 11 23 9 *', recurring: false, prompt: 'fixture followup' } }] } });
        this.emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'cron-call',
          content: 'Scheduled one-shot task cron-1. Session-only.' }] } });
        await this.stop([{ id: 'cron-1', schedule: '47 11 23 9 *', recurring: false, prompt: 'fixture followup' }]);
        this.text('后台与定时已安排');
      } else if (text === 'scheduled') {
        this.emit({ type: 'assistant', message: { id: randomUUID(), content: [{ type: 'tool_use', id: 'cron-call', name: 'CronCreate',
          input: { cron: '47 11 23 9 *', recurring: false, prompt: 'fixture followup' } }] } });
        this.emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'cron-call',
          content: 'Scheduled one-shot task cron-1. Session-only.' }] } });
        await this.stop([{ id: 'cron-1', schedule: '47 11 23 9 *', recurring: false, prompt: 'fixture followup' }]);
        this.text('定时检查已安排');
      } else if (text === 'scheduled-second') {
        // A second wakeup, scheduled in a turn of its own; the snapshot lists it first.
        await this.stop([{ id: 'cron-2', schedule: '48 11 23 9 *', recurring: false, prompt: 'second followup' },
            { id: 'cron-1', schedule: '47 11 23 9 *', recurring: false, prompt: 'fixture followup' }]);
        this.text('第二个定时检查已安排');
      } else if (text === 'cancel-scheduled') {
        await this.stop([]);
        this.text('定时检查已取消');
      } else if (text === 'tool-round') {
        // A tool call that goes on until `.finish-tool` is in the checkout, and the round after it.
        this.emit({ type: 'assistant', message: { id: randomUUID(), content: [{ type: 'tool_use', id: 'tool-round', name: 'Bash', input: { command: 'sleep' } }] } });
        while (!this.closed && !existsSync(join(this.options.cwd, '.finish-tool'))) await new Promise(r => setTimeout(r, 10));
        if (this.closed) return;
        this.emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-round', content: 'slept' }] } });
        this.fold();
        this.text('工具之后的回答');
      } else if (text === 'until-end' || text === 'fail-end') {
        // No tool round: the turn ends once `.end-turn` is in the checkout, whatever came meanwhile; `fail-end` ends failed.
        this.text('等着结束');
        while (!this.closed && !existsSync(join(this.options.cwd, '.end-turn'))) await new Promise(r => setTimeout(r, 10));
        if (this.closed) return;
      } else if (text === 'missing-tool-result') {
        this.emit({ type: 'assistant', message: { id: randomUUID(), content: [{ type: 'tool_use', id: 'orphan-tool', name: 'Bash', input: {} }] } });
        while (!this.closed && !existsSync(join(this.options.cwd, '.finish-missing-tool'))) await new Promise(r => setTimeout(r, 10));
        if (this.closed) return;
        this.text('带未确认工具的回答');
      } else if (text === 'quoted') {
        this.emit({ type: 'assistant', message: { id: randomUUID(), content: [{ type: 'tool_use', id: 'cat', name: 'Read', input: {} }] } });
        this.emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'cat', content: 'Command running in background with ID: fake.' }] } });
        this.text('只是文案');
      } else if (text === 'delayed') await new Promise(r => { this.timer = setTimeout(r, 900); this.cancelWait = r; });
      // Until interrupted, however long that takes on a loaded machine. It says so first: an interrupt that came before
      // this message reached the agent would not end it.
      else if (text === 'hold') { this.text('holding'); await new Promise(r => { this.cancelWait = r; }); }
      else if (text === '/commands') {
        this.system('commands_changed', { commands: [...commands, { name: 'terminal-only', description: 'local terminal command' },
          { name: 'new-skill', description: 'New skill', argumentHint: 'argument' }] });
      } else if (text === '/compact') {
        // As Claude Code compacts: a status while it goes, the boundary with what it left, and what the command says; when a test
        // says so, the status that it failed (`compactFails`), or only what the command says, compacting nothing (`compactSays`);
        // `compactHeld`: it goes on until the test lets it, or it is interrupted.
        if (this.compactSays) this.system('local_command_output', { content: this.compactSays });
        else if (this.compactFails) { this.system('status', { status: 'compacting' }); this.system('status', { status: null, compact_result: 'failed', compact_error: 'API Error' }); }
        else {
          this.system('status', { status: 'compacting' });
          while (this.compactHeld && !this.closed && !this.controller.signal.aborted) await new Promise(r => setTimeout(r, 10));
          if (this.controller.signal.aborted) this.system('status', { status: null, compact_result: 'failed', compact_error: 'Compaction interrupted' });
          else {
            // The status can finish before the boundary arrives; exercise the reverse order too.
            if (!this.compactBoundaryFirst) this.system('status', { status: null, compact_result: 'success' });
            this.system('compact_boundary', { compact_metadata: { trigger: 'manual', pre_tokens: 180000, post_tokens: 9000 } });
            if (this.compactBoundaryFirst) this.system('status', { status: null, compact_result: 'success' });
            this.system('local_command_output', { content: 'Compacted' });
          }
        }
      } else if (text === 'history') this.text(this.entries.filter(e => e.type === 'user').map(e => e.text).join('|'));
      // The checker's question about the session instructions, answered from the system prompt as a model would.
      else if (text === 'What is the Coda check word?') this.text(/reply with exactly (\S+) and nothing else/.exec(this.options.systemPrompt?.append ?? '')?.[1] ?? '不知道');
      else this.text(text);
      // As the SDK says it: at most 64 of the messages the turn took in are named.
      this.emit({ type: 'result', ...(text === 'fail-end' ? { subtype: 'error_during_execution', is_error: true, errors: ['原生这一轮失败了'] } : { subtype: 'success', is_error: false }),
        stop_reason: this.controller.signal.aborted ? 'interrupt' : 'end_turn', user_message_uuid: input.uuid, user_message_uuids: [input.uuid, ...this.folded].slice(0, 64),
        usage: { input_tokens: 10 }, modelUsage: { [this.model]: { contextWindow: 1000 } }, total_cost_usd: 0 });
      if (text === 'stream' && existsSync(join(this.options.cwd, '.delay-stream-idle'))) {
        while (!this.closed && !existsSync(join(this.options.cwd, '.finish-stream-idle'))) await new Promise(r => setTimeout(r, 10));
        if (this.closed) return;
      }
      if (text === 'background-busy') return void this.backgroundBusy();
      if (held) {
        while (!this.closed && !existsSync(join(this.options.cwd, '.release-idle'))) await new Promise(r => setTimeout(r, 10));
        if (this.closed) return;
      }
      this.system('session_state_changed', { state: 'idle' });
      if (text === 'background-followup') void this.backgroundFollowup();
      if (text === 'background-idle') void this.backgroundIdle();
      if (text === 'scheduled') void this.scheduledFollowup();
      if (text === 'background-scheduled') { void this.scheduledFollowup(); void this.backgroundIdle(); }
    }
    async scheduledFollowup() {
      while (!this.closed && !existsSync(join(this.options.cwd, '.fire-scheduled'))) await new Promise(r => setTimeout(r, 10));
      if (this.closed) return;
      this.system('session_state_changed', { state: 'running' });
      this.init();
      this.text('定时检查执行中');
      while (!this.closed && !existsSync(join(this.options.cwd, '.finish-scheduled'))) await new Promise(r => setTimeout(r, 10));
      if (this.closed) return;
      await this.stop([]);
      this.text('定时检查完成');
      this.emit({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', usage: {} });
      this.system('session_state_changed', { state: 'idle' });
    }
    // The session never leaves running: a woken turn has only its init and result to mark it.
    async backgroundBusy() {
      const gate = async name => {
        while (!this.closed && !existsSync(join(this.options.cwd, name))) await new Promise(r => setTimeout(r, 10));
        return !this.closed;
      };
      for (const round of [1, 2]) {
        if (!await gate(`.finish-background-${round}`)) return;
        if (round === 1) {
          this.system('task_notification', { task_id: 'bg-1', status: 'completed' });
          this.system('background_tasks_changed', { tasks: [{ task_id: 'bg-2', task_type: 'local_bash', description: '遗留后台' }] });
        }
        this.init();
        this.text(`被唤醒的第 ${round} 轮`);
        if (!await gate(`.finish-woken-${round}`)) return;
        this.emit({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', usage: {} });
      }
    }
    async backgroundIdle() {
      while (!this.closed && !existsSync(join(this.options.cwd, '.finish-background'))) await new Promise(r => setTimeout(r, 10));
      if (this.closed) return;
      this.system('task_notification', { task_id: 'bg-1', status: 'completed' });
      this.system('background_tasks_changed', { tasks: [] });
      this.system('session_state_changed', { state: 'idle' });
    }
    async backgroundFollowup() {
      const gate = async name => {
        while (!this.closed && !existsSync(join(this.options.cwd, name))) await new Promise(r => setTimeout(r, 10));
        return !this.closed;
      };
      if (!await gate('.finish-background')) return;
      this.system('task_notification', { task_id: 'bg-1', status: 'completed' });
      this.alive.delete('bg-1');
      this.system('background_tasks_changed', { tasks: [...this.alive.values()] });
      // The task's completion and the autonomous running edge need not be adjacent.
      if (!await gate('.resume-background')) return;
      this.system('session_state_changed', { state: 'running' });
      this.init();
      this.text('自主收尾进行中');
      if (!await gate('.finish-followup')) return;
      this.text('完整最终结论');
      this.emit({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', usage: {} });
      this.system('session_state_changed', { state: 'idle' });
    }
    // The messages marked `next` that came while the turn ran, taken into it at a tool round: each said, and named by the result.
    fold() {
      for (const m of this.inbox.filter(m => m.priority === 'next')) { this.folded.push(m.uuid); this.text(`插话：${m.message.content}`); }
      this.inbox = this.inbox.filter(m => m.priority !== 'next');
    }
    // `usage`: what each response of the main thread says it carried and wrote to the cache.
    text(text, id = randomUUID(), parent = null) {
      const uuid = randomUUID(); this.entries.push({ type: 'assistant', text, uuid }); this.persist();
      this.emit({ type: 'assistant', uuid, parent_tool_use_id: parent, message: { id, content: [{ type: 'text', text }], ...(this.usage && !parent ? { usage: this.usage } : {}) } });
    }
    async setModel(model) { this.model = model; }
    async setPermissionMode(mode) { this.mode = mode; }
    async applyFlagSettings(settings) { this.effort = settings.effortLevel; }
    // `cancelQueued`: the messages that came and are not taken yet go too, as Claude Code cancels them (`interrupts`: each asked).
    async interrupt(options) {
      (this.interrupts ??= []).push(options ?? null);
      if (argv.includes('--ignore-cancel')) return new Promise(() => {});
      const cancelled = options?.cancelQueued ? this.inbox.splice(0).map(m => m.uuid) : [];
      this.controller.abort(); clearTimeout(this.timer); this.cancelWait?.(); return { still_queued: this.inbox.map(m => m.uuid), ...(options?.cancelQueued ? { cancelled } : {}) };
    }
    async stopTask(id) {
      // A task that takes its time to die: the stop is asked and the task goes on, until it ends of itself.
      if (existsSync(join(this.options.cwd, '.ignore-stop'))) return;
      this.system('task_updated', { task_id: id, patch: { status: 'killed' } });
      this.system('background_tasks_changed', { tasks: [] });
      this.system('session_state_changed', { state: 'running' });
      this.init();
      this.text('自主收尾');
      this.emit({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', usage: {} });
      this.system('session_state_changed', { state: 'idle' });
    }
    close() { this.closed = true; this.controller.abort(); clearTimeout(this.timer); this.cancelWait?.(); this.wake?.(); this.arrived?.(); }
  }
  return { query: options => new Query(options),
    getSessionInfo: (id, { dir }) => existsSync(path(dir, id)) ? { sessionId: id } : undefined, renameSession: async () => {} };
}
// As the SDK of a Claude process of its own (substitute.mjs), with that process's arguments.
export const { query, getSessionInfo, renameSession } = fixtureSdk(process.argv);
