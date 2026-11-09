// What Coda sees of a Claude session's turns and waits, and the rules that hold of it however the two sides' messages cross
// (#222). Only what Coda is told is read: the waits (`_coda/wait`) and the answers to its prompts; of the agent's side,
// only whether a turn goes, whether it said idle, and what it still has.
const FINAL = new Set(['done', 'failed', 'cancelled']);

export class Seen {
  waits = new Map(); answers = new Map();
  get handling() { return [...this.waits.values()].some(wait => wait.state === 'handling'); }
  // A wait's report: what it breaks of rule 4, if anything. Its state only moves on; only a wakeup goes from handling back to
  // waiting, and nothing comes after an end.
  wait({ waitId, state, kind, title }) {
    const known = this.waits.get(waitId);
    if (!known) {
      this.waits.set(waitId, { state, kind });
      return kind && title ? null : `规则 4：${waitId} 第一次报告没有 kind 或 title`;
    }
    const from = known.state;
    known.state = state;
    if (FINAL.has(from)) return `规则 4：${waitId} 已经 ${from}，又报了 ${state}`;
    if (from === 'handling' && state === 'waiting' && known.kind !== 'timer') return `规则 4：${waitId} 从 handling 回到 waiting`;
    return null;
  }
  // A prompt answered: what it breaks of rule 3. `closed`: a result named it, or the agent's side dropped it.
  answer(prompt, closed) {
    const times = (this.answers.get(prompt) ?? 0) + 1;
    this.answers.set(prompt, times);
    if (times > 1) return `规则 3：prompt ${prompt} 答复了 ${times} 次`;
    return closed ? null : `规则 3：prompt ${prompt} 在收进它的 result、取消或丢弃之前就答复了`;
  }
}

// Rules 1–3 between two steps: what they break, if anything. `turning`: a turn goes (from its init to its result); `idle`:
// the agent's side said idle and nothing came since; `running`: background tasks it runs; `queued`: messages given it and not
// taken; `prompts`: those Coda sent.
export function broken(seen, { turning, idle, running, queued, prompts }) {
  const waits = state => [...seen.waits].filter(([, wait]) => state(wait)).map(([waitId]) => waitId);
  const handling = waits(wait => wait.state === 'handling');
  if (!turning && handling.length) return `规则 1：没有轮次在进行，${handling.join('、')} 还在 handling`;
  if (!idle || queued) return null;
  const open = running ? [] : waits(wait => !FINAL.has(wait.state) && wait.kind !== 'timer');
  if (open.length) return `规则 2：已 idle、没有后台任务，${open.join('、')} 还没结束`;
  const unanswered = prompts.filter(prompt => !seen.answers.has(prompt));
  return unanswered.length ? `规则 3：已 idle，prompt ${unanswered.join('、')} 还没答复` : null;
}
