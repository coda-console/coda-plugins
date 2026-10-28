// `_coda/wait` as Coda takes it: Coda's validWait first (check/coda/domain/agent-protocol.mjs), then the rules of
// docs/agent-protocol.md「Agent 活动」. Where Coda drops a report without a word, the checker fails it: an agent that relies
// on it is not heard.
import { validWait, WAIT_STATES } from './coda/domain/agent-protocol.mjs';

export const TERMINAL = new Set(['done', 'failed', 'cancelled']);
const LIMITS = { sessionId: 200, waitId: 200, kind: 50, title: 500, detail: 4000, childSessionId: 200, model: 200, outputFile: 4096, toolCallId: 200 };

// The first part of validWait a report fails, in words (validWait decides; this only says why).
export function whyInvalid(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return 'params 须为对象';
  for (const key of ['sessionId', 'waitId']) if (typeof p[key] !== 'string' || !p[key]) return `缺 ${key}`;
  if (!WAIT_STATES.has(p.state)) return `state 只能是 ${[...WAIT_STATES].join('、')}，现为 ${JSON.stringify(p.state)}`;
  for (const [key, max] of Object.entries(LIMITS)) if (p[key] !== undefined && (typeof p[key] !== 'string' || p[key].length > max)) return `${key} 须为不超过 ${max} 字的文本`;
  for (const key of ['stoppable', 'recurring']) if (p[key] !== undefined && typeof p[key] !== 'boolean') return `${key} 须为 true 或 false`;
  if (p.at !== undefined && !(typeof p.at === 'string' && Number.isFinite(Date.parse(p.at)))) return `at 读不出时间：${JSON.stringify(p.at)}`;
  return '不合 validWait';
}

export class Waits {
  constructor(say) {
    this.say = say; this.sessionId = null; this.children = new Set(); this.waits = new Map();
    this.registered = []; this.changes = 0;
  }
  owns(id) { return id === this.sessionId || this.children.has(id); }
  get open() { return [...this.waits.values()].filter(w => !TERMINAL.has(w.state)); }
  get handling() { return this.open.filter(w => w.state === 'handling'); }
  // One report, in order with the session's updates; `turn`: whether a turn of Coda's was under way as it came.
  take(p, { turn }) {
    if (!validWait(p)) { this.say.fail('wait.invalid', `_coda/wait 被 Coda 丢弃：${whyInvalid(p)}（${(JSON.stringify(p) ?? String(p)).slice(0, 160)}）`); return; }
    if (!this.owns(p.sessionId)) { this.say.fail('wait.session', `_coda/wait 说的会话 ${p.sessionId} 不是本会话，也不是登记过的子会话：Coda 丢弃`); return; }
    const key = `${p.sessionId}\0${p.waitId}`, known = this.waits.get(key);
    if (known && TERMINAL.has(known.state)) {
      this.say.fail('wait.after-terminal', `活动 ${p.waitId} 已经 ${known.state}，之后又报 ${p.state}：终态是最终的，同一个 waitId 再说什么都不算`);
      return;
    }
    this.changes++;
    if (!known) {
      const kind = p.kind ?? 'task';
      if (TERMINAL.has(p.state)) {
        this.say.warn('wait.first-terminal', `活动 ${p.waitId} 第一次报告就是 ${p.state}：Coda 不登记它`);
        this.waits.set(key, { waitId: p.waitId, kind, state: p.state });
        return;
      }
      // Coda takes both as they are: a subagent whose session it is not told shows no transcript of its own, a timer without
      // `at` no time (Coda's own Claude entry leaves it out when it cannot work out the next run).
      if (kind === 'subagent' && !p.childSessionId) this.say.warn('wait.subagent-child', `子 Agent ${p.waitId} 没带 childSessionId：Coda 照收，但认不出它的会话：那个会话说的话与报的活动丢弃，审批与提问拒绝，委派清单里点开没有过程，也不能继续同一个子 Agent`);
      if (kind === 'timer' && p.at === undefined) this.say.warn('wait.timer-at', `定时 ${p.waitId} 没带 at（下次触发的时刻）：Coda 照收，只是显示不出下次时间`);
      const wait = { waitId: p.waitId, sessionId: p.sessionId, kind, state: p.state, title: p.title, stoppable: p.stoppable === true, inTurn: turn };
      this.waits.set(key, wait);
      this.registered.push(wait);
    } else {
      if (p.kind !== undefined && p.kind !== known.kind) this.say.warn('wait.kind-changed', `活动 ${p.waitId} 的 kind 从 ${known.kind} 改成 ${p.kind}：Coda 按第一次的算`);
      known.state = p.state;
      if (p.stoppable !== undefined) known.stoppable = p.stoppable;
    }
    if (p.childSessionId) this.children.add(p.childSessionId);
  }
}
