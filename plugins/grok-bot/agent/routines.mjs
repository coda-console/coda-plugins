// Routine execution stays in Grok. Only run records are mirrored; executor
// transcripts are neither queried nor inferred from the main conversation.
export const ROUTINE_POLL_MS = 5000;
export class RoutineWatch {
  constructor({ client, bot, saved, clock, commit, notify, error }) {
    Object.assign(this, { client, bot, saved, clock, commit, notify, error });
    this.controller = new AbortController();
    this.registered = new Set();
    this.activeHint = false;
    this.saved.runs ??= {};
  }
  hint(active) {
    if (active !== undefined) this.activeHint = active;
    if (this.flight) { this.again = true; return this.flight; }
    this.clock.clearTimeout(this.timer);
    this.flight = (async () => {
      do { this.again = false; await this.refresh(); } while (this.again && !this.controller.signal.aborted);
    })().catch(error => { if (!this.controller.signal.aborted) {
      this.error(error);
      if (error.status === 401 || error.status === 403) this.close();
    } }).finally(() => {
      this.flight = null;
      if (!this.controller.signal.aborted && (this.activeHint || Object.values(this.saved.runs).some(r => r.status === 'running')))
        this.timer = this.clock.setTimeout(() => { void this.hint(); }, ROUTINE_POLL_MS);
    });
    return this.flight;
  }
  activity(run, state, title) {
    this.notify({ waitId: `grok-routine:${this.bot}:${run.id}`, kind: 'task', state, title });
  }
  async refresh() {
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(30_000)]);
    const [agents, automations] = await Promise.all([
      this.client.request('ListGrokBotSubagents', { agentId: this.bot }, { signal }),
      this.client.request('ListGrokBotAgentAutomations', { agentId: this.bot }, { signal }),
    ]);
    if (this.controller.signal.aborted) return;
    const executors = new Set((agents.subagents ?? []).map(a => a.subagentId));
    this.activeHint = executors.size > 0;
    const returned = new Set();
    const baseline = !this.saved.routinesInitialized;
    for (const item of automations.automations ?? []) {
      const record = JSON.parse(item.recordJson);
      if (typeof record.name !== 'string' || !Array.isArray(record.runs)) throw new Error('Grok Routine 记录格式已变化');
      for (const raw of record.runs) {
        if (typeof raw.id !== 'string' || typeof raw.status !== 'string' || !Number.isFinite(raw.startedAt) || (raw.status !== 'running' && !Number.isFinite(raw.finishedAt)))
          throw new Error('Grok Routine 运行记录缺少 ID、状态或时间');
        const run = { id: raw.id, name: record.name, status: raw.status, startedAt: raw.startedAt, finishedAt: raw.finishedAt,
          automationId: item.automationId, requestId: raw.requestId, executorId: `sand-subagent-${raw.id}` };
        returned.add(run.id);
        const before = this.saved.runs[run.id];
        // Completed history on first selection is a baseline, not new work.
        if ((baseline && run.status !== 'running') || (before && before.status === run.status && run.status !== 'running')) {
          this.saved.runs[run.id] = run; continue;
        }
        const title = `定时任务「${run.name}」`;
        if (!this.registered.has(run.id)) {
          this.registered.add(run.id);
          this.activity(run, 'waiting', `${title}运行中`);
        }
        if (run.status !== 'running') {
          const seconds = Math.max(0, Math.round((run.finishedAt - run.startedAt) / 1000));
          this.activity(run, run.status === 'ok' ? 'done' : 'failed', `${title}${run.status === 'ok' ? '成功' : `失败（${run.status}）`}（${seconds} 秒）`);
        }
        this.saved.runs[run.id] = run;
      }
    }
    for (const run of Object.values(this.saved.runs)) {
      if (run.status === 'running' && !returned.has(run.id) && !executors.has(run.executorId)) {
        if (!this.registered.has(run.id)) this.activity(run, 'waiting', `定时任务「${run.name}」核对结果`);
        this.activity(run, 'failed', `定时任务「${run.name}」已不可见，无法确认结果；请在 Grok 客户端查看`);
        run.status = 'unavailable';
      }
    }
    this.saved.routinesInitialized = true;
    this.commit();
  }
  close() { this.controller.abort(); this.clock.clearTimeout(this.timer); }
}
