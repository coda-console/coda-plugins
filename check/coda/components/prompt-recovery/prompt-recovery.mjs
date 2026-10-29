import { randomUUID } from 'node:crypto';
import { ContractError } from '../../domain/errors.mjs';
import { agentFailure } from '../../kernel/agent-failures.mjs';

// Plugins report facts about a failed request; Coda owns the policy. No provider names or error-text matching here.
export function serviceFailure(error) {
  const failure = agentFailure(error);
  return failure?.kind === 'service_unavailable' ? failure : null;
}
// The former capacity/model-unavailable policy, shared by every agent that reports a service failure.
export const RETRY_DELAYS = [15_000, 30_000, 60_000];
export const continuationPrompt = '继续完成当前任务，沿用已有上下文和已完成的工作，从尚未完成的部分接着执行。';

export class PromptRecovery {
  constructor(kernel, { clock, prompt, delays = RETRY_DELAYS }) {
    this.kernel = kernel; this.store = kernel.store; this.clock = clock;
    this.prompt = prompt; this.delays = delays; this.retries = new Map();
  }
  pending(run) { return this.retries.get(run)?.waiting === true; }
  schedule(run, error) {
    const failure = serviceFailure(error);
    if (!failure || run.commandInput || run.autonomous || !run.turn || this.kernel.closing || this.kernel.sessions.adopting) return false;
    // The plugin supplies the upstream wait as a fact; Coda keeps its one-minute retry budget.
    if ((failure.retryAfterMs ?? 0) > RETRY_DELAYS.at(-1)) return false;
    const retry = this.retries.get(run) ?? { attempt: 0 };
    if (this.store.turn(run.turn.id).stopRequestedAt !== null || retry.attempt === this.delays.length) return false;
    retry.delay = Math.max(this.delays[retry.attempt++], failure.retryAfterMs ?? 0); retry.waiting = true;
    this.retries.set(run, retry);
    if (failure.input === 'accepted') this.store.markRunning(run.turn.id);
    this.store.expireRequests(run.turn.id);
    return true;
  }
  wake(run) { this.retries.get(run)?.wake?.(); }
  wakeAll() { for (const run of this.retries.keys()) this.wake(run); }
  async finish(run, waiting) {
    try {
      for (;;) {
        try { await waiting; }
        catch (error) { if (error.code !== 'agent_error' || !this.pending(run)) throw error; }
        if (!run.requestId || !this.pending(run)) return;
        const retry = this.retries.get(run), { kernel } = this;
        if (kernel.closing || run.stopped) throw new ContractError('connection_lost', 'Agent 执行连接中断');
        await new Promise(resolve => {
          const cancel = this.clock.at(kernel.now() + retry.delay, () => this.wake(run));
          retry.wake = () => { cancel(); retry.wake = null; resolve(); };
        });
        if (!run.requestId) return; // Stopped while waiting.
        if (kernel.closing || run.stopped) throw new ContractError('connection_lost', 'Agent 执行连接中断');
        retry.waiting = false;
        const input = this.store.input(this.store.operation(run.requestId).inputId), promptId = randomUUID();
        this.store.run('UPDATE operations SET prompt_id = ?, updated_at = ? WHERE request_id = ?', promptId, kernel.now(), run.requestId);
        run.feed.beginPrompt();
        // The persisted original receipt survives a rejected continuation, including after machine recovery.
        waiting = run.prompt(input.state === 'delivered' ? continuationPrompt : this.prompt(run.requestId), promptId);
      }
    } finally { this.wake(run); this.retries.delete(run); }
  }
}
