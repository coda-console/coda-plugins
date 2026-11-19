import { createHash } from 'node:crypto';

// What a session is told when it goes on after a failed turn, and by which rule: pure, shared by the places that resume one.
// A turn's own retries (components/prompt-recovery/recovery.mjs) say only `continuationPrompt`; the rule
// (`resumeChoice`) and when a delegation goes on (`resumePlan`) are a workflow step's agent's (components/workflows), a
// session's call of another's (components/prompt-recovery/call-resumes.mjs) and a root session's resumes after a quota stop
// or a process exit.
export const continuationPrompt = '继续完成当前任务，沿用已有上下文和已完成的工作，从尚未完成的部分接着执行。';
// What a session is told when a turn of it was cut off and what came of it is not known (a lost connection, a restart of the
// backend or of the host): check what was done before going on, from what is not done, with the task for reference.
export const verifyPrompt = task => `上一轮执行中断，结果未知（例如断网、宿主掉线或后端重启）。请先核对已有上下文、工作区与正在进行的任务，确认中断前的操作结果，避免重复执行已完成或结果不明的操作；沿用原任务和已完成的工作，从尚未完成的部分继续。\n\n原任务参考（用于核对进度，不要从头重做）：\n${task}`;
// What a session is told when it goes on after a failed turn, by one rule wherever that is done (a delegation, resumePlan
// below; a root session's quota or process-exit resume, components/workflows/quota-resumes.mjs):
// `continue`, to go on, for a turn after the one its input began (`turnId` is not the input's turn), or once the agent took
// the input (`failure.input` `accepted`; or the input `delivered`, but not for a quota: a turn ended by one is settled so
// whatever happened, so only the agent's word counts); `original`, the input again, when the agent said it never took it
// (`not_accepted`; `again` where something else says it was kept as it was); `verify`, the input with a check first, when
// nothing says. `input`: the input the turn began from as its operation keeps it, `{ turnId, inputState }`; none for a turn
// no input began.
export const resumeChoice = (failure, turnId, input, { quota = false, again = 'original' } = {}) =>
  failure?.input === 'accepted' || (input?.inputState === 'delivered' && !quota) || turnId !== input?.turnId ? 'continue'
    : failure?.input === 'not_accepted' ? again : 'verify';
// The request a workflow's `send-session` message is submitted as (application/coda-actions.mjs): one per session and key,
// so that a resume it sent is known again by the key it was sent under (components/workflows/quota-resumes.mjs).
export const sendRequestId = (threadId, key) => `send:${threadId}:${createHash('sha256').update(key).digest('hex').slice(0, 32)}`;
// The words of a choice: `task`, the input's, for the two that carry it; `go` the caller's own for going on.
export const resumeText = (choice, task, go) => ({ original: task, continue: go, verify: verifyPrompt(task) })[choice];
// Whether and when a delegation goes on after one of its attempts failed, by one rule wherever that is done: a workflow
// step's agent (docs/workflows.md「Agent 步骤」, components/workflows/workflow-jobs.mjs) and a session's call of another
// (docs/subagent-design.md「失败后续跑」, components/prompt-recovery/call-resumes.mjs). An attempt fails as it fails, and the
// delegation goes on in the same session after one that failed in a way worth going on from — the service unavailable or
// the outcome unknown (`service`), the quota spent (`quota`), a login to be done again (`auth`, of which the user is
// alerted) —, at the time this gives; it hands the failure back only once that gives up. `known`: what the delegation keeps
// of its attempts, `resume` how it went on so far; `standing`: how the session stands for the attempt that failed, judged by
// the turn that ended it (`endTurn`, with what its agent said of its failure), not whatever turn came after, and the
// operation of the input it began from (`operation`: its stage and error, `turnId` and `inputState`, as
// kernel.sessions standing gives them). Null for a failure not worth going on from (one the agent named no
// category for, a stop, a cancel, an input that could not be prepared); `exhausted` once the waiting allowed is spent.
// `prompt`: what the next call says, by the one rule every resume shares (domain/resume-prompt resumeChoice): `continue`,
// `original` or `verify`; also `verify` for an outcome unknown the agent said nothing of.
export const MINUTE = 60_000, HOUR = 60 * MINUTE;
export const RESUME = { service: { delays: [MINUTE, 5 * MINUTE, 15 * MINUTE, 30 * MINUTE], budget: 6 * HOUR },
  quota: { delay: HOUR, budget: 24 * HOUR, after: 2 * MINUTE }, auth: { delay: 10 * MINUTE, budget: 24 * HOUR } };
// How long a call that went on from an `auth` wait must have gone without failing again for the login to count as done:
// the user's alert is then taken back.
export const AUTH_PROBE = 5 * MINUTE;
// `agent`: the name of the session's agent, for what the user is told of a login to do.
const KINDS = { quota_exhausted: 'quota', service_unavailable: 'service', auth_required: 'auth' };
export function resumePlan(known, { endTurn: turn, operation }, now, agent = '') {
  const failure = turn?.failure, error = (turn?.error ?? operation?.error ?? '').replace(/^额度不足\s*/, '').replace(/\s+/g, ' ').trim().slice(0, 300);
  let kind, prompt, reason;
  const taken = operation?.inputState === 'delivered', again = known.resume?.prompt ?? 'original';
  // Stuck (an outcome unknown), unless the turn that ended the call said why it failed and was not stopped: a turn ahead of
  // its input in the session was stuck and stopped, and its own then ran into a quota, say. Stuck before its input began
  // a turn, nothing of it was handed over.
  if (known.stalled && !(KINDS[failure?.kind] && turn.stopRequestedAt == null)) [kind, prompt, reason] = ['service', !taken && !operation?.turnId ? again : 'verify', known.stalled];
  else if (known.outcome === 'cancelled' || !turn || turn.stopRequestedAt != null || ['failed', 'cancelled'].includes(operation?.stage)) return null;
  else if (KINDS[failure?.kind]) {
    kind = KINDS[failure.kind];
    prompt = resumeChoice(failure, turn.id, operation, { quota: kind === 'quota', again });
    reason = { quota: '额度不足', service: '服务暂不可用', auth: `要重新登录${agent ? ` ${agent}` : ''}${failure.login ? `（${failure.login}）` : ''}` }[kind];
  }
  // The agent's session ended under the turn (`session_ended`) is an outcome unknown as well, told by the rule.
  else if (turn.state === 'unknown' && (!failure || failure.kind === 'session_ended'))
    [kind, prompt, reason] = ['service', failure ? resumeChoice(failure, turn.id, operation, { again }) : 'verify', '结果未知'];
  else return null;
  const before = known.resume?.kind === kind ? known.resume : null, k = before ? before.k + 1 : 0, waited = before?.waited ?? 0;
  // A quota given a reset time still to come is waited for however long it is; a little after it, as the reset is the upstream's
  // estimate. One that is past or unreadable is no time at all: the quota then waits as one given none.
  const reset = kind === 'quota' ? Date.parse(failure.resetAt) : NaN;
  if (reset > now) return { kind, prompt, reason, error, k, waited, at: reset + RESUME.quota.after };
  const { delays, delay: each, budget } = RESUME[kind];
  const delay = each ?? Math.max(delays[Math.min(k, delays.length - 1)], failure?.retryAfterMs ?? 0);
  if (waited + delay > budget) return { exhausted: true, reason, error, budget };
  // What the user is alerted of a login to do names it by the agent's account, else the agent, from when it first stood in the way.
  const alert = kind === 'auth' ? { who: failure.login ?? agent, since: before?.alert?.since ?? now } : null;
  return { kind, prompt, reason, error, k, waited: waited + delay, at: now + delay, alert };
}
// A span of time as the lines below say it.
export const span = ms => ms >= HOUR ? `${ms / HOUR} 小时` : `${ms / MINUTE} 分钟`;
// Why a delegation is handed back failed after it went on (`resume`, as kept, `n` the times it went on): it waited all it was
// allowed (`plan` exhausted), or the failure now is not one to go on from (`plan` null). Null for one that never went on and
// fails as it failed.
export const gaveUpLine = (plan, resume) => plan
  ? `受阻（${plan.reason}），${resume ? `续跑 ${resume.n} 次后` : ''}等满 ${span(plan.budget)} 仍未恢复，不再续跑；最后一次：${plan.error || plan.reason}`
  : resume ? `此前续跑 ${resume.n} 次；这次的失败不能自动续跑` : null;
const clockTime = time => { const d = new Date(time), p = n => String(n).padStart(2, '0'); return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
// What a delegation held up until it goes on says of itself (`resume`, as kept): in a step's log and as the step line of its
// node, and as the line of a session's wait to go on. The clients write no `<t:…>` mark in these lines, so the time is the
// backend's clock's.
export const blockedLine = ({ reason, at, n }) => `受阻：${reason}，${clockTime(at)} 续（第 ${n} 次）`;
// What the conversation shows of a resume, by the choice; what the agent is told is the input itself (ProductService.inputPrompt).
export const RESUME_SAID = { original: '续跑：重发上一条消息', verify: '续跑：先核对再接着做', continue: '继续' };
