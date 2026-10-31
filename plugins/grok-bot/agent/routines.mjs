// Routine execution stays in Grok. Only run records are mirrored; executor
// transcripts are neither queried nor inferred from the main conversation.
import { ConnectionHealth, authenticationError } from './health.mjs';
export const RUN_CACHE_LIMIT = 200;
export const ROUTINE_POLL_MS = 5000;
export class RoutineWatch {
  constructor({ client, bot, saved, clock, commit, notify, error, recovered, log }) {
    Object.assign(this, { client, bot, saved, clock, commit, notify, error, recovered, log });
    this.health = new ConnectionHealth({ error, recovered, log });
    this.controller = new AbortController();
    this.registered = new Set();
    this.activeHint = false;
    this.saved.runs ??= {};
  }
  hint(active) {
    if (this.controller.signal.aborted) return;
    if (active !== undefined) this.activeHint = active;
    if (this.flight) { this.again = true; return this.flight; }
    this.clock.clearTimeout(this.timer);
    this.flight = (async () => {
      do {
        this.again = false;
        await this.refresh();
        if (this.controller.signal.aborted) return;
        this.health.success();
      } while (this.again && !this.controller.signal.aborted);
    })().catch(error => { if (!this.controller.signal.aborted) {
      this.health.failure(error);
      if (authenticationError(error)) this.close();
    } }).finally(() => {
      this.flight = null;
      if (!this.controller.signal.aborted && (this.health.failures || this.activeHint || Object.values(this.saved.runs).some(r => r.status === 'running')))
        this.timer = this.clock.setTimeout(() => { void this.hint(); }, Math.max(ROUTINE_POLL_MS, this.health.delay));
    });
    return this.flight;
  }
  activity(run, state, title) {
    this.notify({ waitId: `grok-routine:${this.bot}:${run.id}`, kind: 'observation', state, title });
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
        if (((baseline || (!before && run.startedAt <= (this.saved.runsBefore ?? -1))) && run.status !== 'running') || (before && before.status === run.status && run.status !== 'running')) {
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
    // Keep every active run plus the newest completed records. The timestamp
    // floor prevents old server history being announced again after eviction.
    const completed = Object.values(this.saved.runs).filter(r => r.status !== 'running').sort((a, b) => b.startedAt - a.startedAt);
    for (const run of completed.slice(RUN_CACHE_LIMIT)) {
      this.saved.runsBefore = Math.max(this.saved.runsBefore ?? -1, run.startedAt);
      delete this.saved.runs[run.id];
      this.registered.delete(run.id);
    }
    this.saved.routinesInitialized = true;
    this.commit();
  }
  close() {
    this.controller.abort();
    this.clock.clearTimeout(this.timer);
    for (const id of this.registered) {
      const run = this.saved.runs[id];
      if (run?.status === 'running') this.activity(run, 'failed', `定时任务「${run.name}」已停止跟踪，结果未确认；Grok 中的任务未必停止`);
    }
    this.registered.clear();
  }
}
