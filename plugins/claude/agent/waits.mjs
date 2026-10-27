// What Claude Code keeps going beside a turn, told to Coda as waits of its own (docs/agent-protocol.md「_coda/wait」): its
// background tasks and subagents as the SDK reports them, and the wakeups it scheduled as its Stop hook lists them. A
// subagent's session is the tool call that launched it; continued (SendMessage), it is another run under the same session.
// What a subagent launches (`parent_task_id`) is told in that subagent's session, once a wait has told Coda that session.
// A task that ends while no turn goes will wake Claude for its result: until a turn takes it up, or the session says idle,
// it is still waited on. A turn Claude begins on its own handles what woke it (`takeUp`): what its opening message names,
// else the tasks that ended, else the one wakeup due, else a wait of the turn's own, told only once the turn says or asks
// something (`claim`); what it handles ends with that turn.
const FINAL = { completed: 'done', failed: 'failed', killed: 'cancelled', stopped: 'cancelled', ended: 'done' };
const open = state => state === 'waiting' || state === 'handling';
const cut = (value, limit) => typeof value === 'string' && value ? value.slice(0, limit) : undefined;

export class ClaudeWaits {
  // `say`: a wait's report, and its session when that is a subagent's; `going`: whether a turn goes; `registered`: a subagent's
  // session is known.
  constructor({ say, going = () => false, registered = () => {}, now = Date.now }) {
    this.say = say; this.going = going; this.registered = registered; this.now = now;
    this.tasks = new Map(); this.crons = new Map(); this.own = new Set(); this.turns = 0;
    // Commands in the foreground, by task id: each is its own tool call, which the turn (or the subagent) blocks on.
    this.foreground = new Map();
    // What is known of a launching tool call before its task is: a subagent's model, a command's output file.
    this.models = new Map(); this.outputs = new Map();
  }
  get handling() { return this.own.size > 0 || [...this.tasks.values(), ...this.crons.values()].some(w => w.state === 'handling'); }
  // Whether anything is still waited on: what ends with the Claude process that runs it.
  get pending() { return this.own.size > 0 || [...this.tasks.values(), ...this.crons.values()].some(w => open(w.state)); }
  report(wait, state, fields = {}) {
    wait.state = state;
    const params = { waitId: wait.waitId, state, ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) };
    // Kept while the session it is in is not yet told (`named`).
    if (wait.held) wait.held.push(params); else this.say(params, wait.sessionId);
  }
  // A task begun (`task_started`, `start`), or listed among those in the background (`listed`).
  started(native, { start = false, listed = false } = {}) {
    if (native.ambient || typeof native.task_id !== 'string' || !native.task_id) return;
    // A command in the foreground is not waited on until it is put in the background (`backgrounded`). A subagent in the
    // foreground still is: its session is that card's.
    if (native.is_backgrounded === false && native.task_type !== 'local_agent' && !this.tasks.has(native.task_id)) {
      this.foreground.set(native.task_id, native);
      return;
    }
    const known = this.tasks.get(native.task_id);
    if (known) {
      if (listed) known.listed = true;
      // A snapshot names no tool call and may come before its run's start, even after its end: that start says the launching
      // call, and with it a subagent's session. A start of the run already known is that run's, never another.
      const sameRun = native.run_id && known.runId ? native.run_id === known.runId : !known.toolUseId;
      if (start && sameRun && !known.toolUseId && native.tool_use_id) {
        const toolUseId = cut(native.tool_use_id, 200), subagent = known.kind === 'subagent';
        Object.assign(known, { toolUseId, runId: known.runId ?? native.run_id }, subagent ? { childSessionId: toolUseId } : {});
        if (open(known.state)) this.report(known, known.state, { childSessionId: subagent ? toolUseId : undefined, toolCallId: toolUseId,
          outputFile: subagent ? undefined : this.outputs.get(toolUseId), model: subagent ? this.models.get(toolUseId) : undefined });
        if (subagent && !known.held) this.named(known);
        // An end held for its session is told now while a turn goes, which takes it in.
        if (known.final !== undefined && known.state === 'waiting' && this.going()) { this.report(known, known.final); known.final = undefined; }
        return;
      }
      // Only a start of another run under another call brings a subagent that ended back; snapshots and repeats cannot.
      if (!start || sameRun || known.kind !== 'subagent' || (open(known.state) && known.final === undefined) || !native.tool_use_id || native.tool_use_id === known.toolUseId) return;
      // Its last run ends before the next begins; one the turn going handles leaves it to a wait of the turn's own.
      if (known.state === 'handling' && this.own.size === 0) this.hold();
      if (known.final !== undefined) { this.report(known, known.final); known.final = undefined; }
      known.run++; Object.assign(known, { waitId: `${known.taskId}#${known.run}`, toolUseId: native.tool_use_id, runId: native.run_id });
      this.report(known, 'waiting', { kind: 'subagent', title: cut(native.description, 500) ?? '子 Agent', childSessionId: known.childSessionId,
        stoppable: true, model: this.models.get(known.childSessionId) });
      return;
    }
    const subagent = native.task_type === 'local_agent', toolUseId = cut(native.tool_use_id, 200);
    const task = { taskId: native.task_id, waitId: native.task_id.slice(0, 200), run: 1, kind: subagent ? 'subagent' : 'task', toolUseId, runId: native.run_id,
      listed: listed || native.is_backgrounded === true, parentTaskId: native.parent_task_id, ...(subagent ? { childSessionId: toolUseId ?? native.task_id.slice(0, 200) } : {}) };
    if (task.parentTaskId) {
      const parent = this.tasks.get(task.parentTaskId);
      if (parent?.toolUseId && !parent.held) task.sessionId = parent.childSessionId; else task.held = [];
    }
    this.tasks.set(task.taskId, task);
    this.report(task, 'waiting', { kind: task.kind, title: cut(native.description, 500) ?? (subagent ? '子 Agent' : '后台任务'), stoppable: true,
      childSessionId: task.childSessionId, toolCallId: toolUseId, outputFile: this.outputs.get(toolUseId),
      model: subagent ? this.models.get(task.childSessionId) : undefined });
    if (subagent && !task.held) this.named(task);
  }
  // A subagent's session told to Coda: what it said there comes after, and what it launched is told there, held reports first.
  named(subagent) {
    this.registered(subagent.childSessionId);
    if (!subagent.toolUseId) return;
    for (const task of this.tasks.values()) {
      if (!task.held || task.parentTaskId !== subagent.taskId) continue;
      const held = task.held;
      task.held = undefined; task.sessionId = subagent.childSessionId;
      for (const params of held) this.say(params, task.sessionId);
      if (task.kind === 'subagent') this.named(task);
    }
  }
  // A command in the foreground put in the background: from now on it is waited on, as begun there.
  backgrounded(taskId) {
    const native = this.foreground.get(taskId);
    if (!native) return;
    this.foreground.delete(taskId);
    this.started({ ...native, is_backgrounded: true }, { start: true });
  }
  renamed(taskId, description) {
    const task = this.tasks.get(taskId);
    if (task && open(task.state) && cut(description, 500)) this.report(task, task.state, { title: cut(description, 500) });
  }
  // A task's end (`status` as the SDK says it; `ended` when it left the list without one): told now while a turn goes, which
  // takes in its result; otherwise once a turn has taken it up.
  ended(taskId, status, { outputFile } = {}) {
    this.foreground.delete(taskId);
    const task = this.tasks.get(taskId), final = FINAL[status];
    if (!task || !final || !open(task.state)) return;
    if (task.final !== undefined) { if (status !== 'ended') task.final = final; return; }
    const fields = { outputFile: cut(outputFile, 4096) };
    // A subagent whose session is not yet known ends once it is (`started`), or as the turn or the session settles.
    if (task.state === 'handling' || !this.going() || (task.kind === 'subagent' && !task.toolUseId)) {
      Object.assign(task, { final, endedAt: this.now() });
      if (fields.outputFile) this.report(task, task.state, fields);
    } else this.report(task, final, fields);
  }
  snapshot(list) {
    const live = new Set(list.map(native => native.task_id));
    for (const task of this.tasks.values()) if (task.listed && !live.has(task.taskId)) this.ended(task.taskId, 'ended');
    for (const native of list) { this.backgrounded(native.task_id); this.started(native, { listed: true }); }
  }
  // The Stop hook's list of the wakeups the session has, complete each time.
  scheduled(list) {
    const listed = new Set();
    for (const native of list) {
      listed.add(native.id);
      if (this.crons.has(native.id)) continue;
      const cron = { waitId: native.id.slice(0, 200), schedule: native.schedule, recurring: native.recurring, prompt: native.prompt, at: nextRun(native.schedule, this.now()) };
      this.crons.set(native.id, cron);
      this.report(cron, 'waiting', { kind: 'timer', title: cut(native.prompt, 100) ?? cut(native.schedule, 500), detail: cut(native.schedule, 4000),
        recurring: native.recurring, stoppable: false, at: cron.at === null ? undefined : new Date(cron.at).toISOString() });
    }
    for (const [id, cron] of this.crons) {
      if (listed.has(id) || !open(cron.state)) continue;
      if (cron.state === 'handling') cron.final = 'done'; else this.report(cron, 'done');
    }
  }
  // The tasks that ended since the last turn: taken in by the turn that ended now, or not to wake Claude now it is idle.
  settled() {
    for (const task of this.tasks.values()) if (task.final !== undefined && task.state === 'waiting') { this.report(task, task.final); task.final = undefined; }
  }
  // A turn Claude began on its own: what it handles. `origin`, `text`: its opening message's, when that came first.
  takeUp({ origin, text } = {}) {
    const pending = [...this.tasks.values()].filter(task => task.final !== undefined && task.state === 'waiting');
    const crons = [...this.crons.values()].filter(cron => open(cron.state));
    // What its opening message names: the wakeup that fired, the run a notice is of, the subagent a message is from.
    const named = origin?.kind === 'task-notification' ? origin.subkind === 'scheduled-trigger' ? crons.filter(cron => cron.prompt && cron.prompt === text)
      : [...this.tasks.values()].filter(task => origin.runId && task.runId === origin.runId)
      : origin?.kind === 'peer' ? [...this.tasks.values()].filter(task => origin.senderTaskId && task.taskId === origin.senderTaskId) : [];
    // Handled means ended (Coda places its card there and lets it be stopped no more): a subagent's message is the report it
    // handed back only once it has ended; one still running says how it goes (SendMessage).
    let handled = origin?.kind === 'peer' ? named.filter(task => pending.includes(task)) : named.filter(wait => open(wait.state));
    // One that names nothing known is taken for what else ended, else the one wakeup due. One that names what was taken in
    // already (Claude Code's turn for the notice of a subagent whose report an earlier turn read) or what still runs is not.
    if (!named.length) handled = pending.sort((a, b) => a.endedAt - b.endedAt);
    if (!named.length && !handled.length) {
      // Which came due is not told: the one due, or else the only one there is.
      const due = crons.filter(cron => cron.at !== null && cron.at <= this.now() + 60_000);
      if ((due.length || crons.length) === 1) handled = due.length ? due : crons;
    }
    if (handled.length) for (const wait of handled) this.report(wait, 'handling');
    // Nothing to take up: told as a wait of its own once it says or asks something. One that says nothing is not told at
    // all, as that turn for a notice, which reaches no model.
    else this.unclaimed = true;
  }
  claim() { if (this.unclaimed) { this.unclaimed = false; this.hold(); } }
  hold() {
    const own = { waitId: `turn-${++this.turns}` };
    this.own.add(own);
    this.report(own, 'handling', { kind: 'task', title: 'Claude 自主继续', stoppable: false });
  }
  // That turn's end: what it handled ended with it, a recurring wakeup waits for its next time.
  finished({ error, title } = {}) {
    // Processing a successful task's result can fail. Give that failure its own activity instead of changing the task's
    // outcome, and leave recurring wakeups scheduled. There may already be a turn-owned activity (hold).
    this.unclaimed = false;
    if (error && !this.own.size) this.hold();
    for (const task of this.tasks.values()) if (task.state === 'handling') { this.report(task, task.final ?? 'done'); task.final = undefined; }
    for (const cron of this.crons.values()) {
      if (cron.state !== 'handling') continue;
      if (cron.final !== undefined || !cron.recurring) { this.report(cron, 'done'); continue; }
      cron.at = nextRun(cron.schedule, this.now());
      this.report(cron, 'waiting', { at: cron.at === null ? undefined : new Date(cron.at).toISOString() });
    }
    for (const own of this.own) this.report(own, error ? 'failed' : 'done', error ? { title, detail: cut(error, 4000) } : {});
    this.own.clear();
  }
  // A stop Coda asks of a wait: the task to stop when it still goes (null: none). One that ended and is yet to be taken in is
  // not waited for any more: it ends now ('').
  stop(waitId) {
    const task = [...this.tasks.values()].find(task => task.waitId === waitId && open(task.state));
    if (!task) return null;
    if (task.final === undefined) return task.taskId;
    if (task.state === 'waiting') { this.report(task, task.final); task.final = undefined; }
    return '';
  }
  childSession(agentId) { return typeof agentId === 'string' ? this.tasks.get(agentId)?.childSessionId ?? null : null; }
  // A subagent's actual model, from its own replies (which can come before its task).
  model(toolUseId, model) {
    if (typeof model !== 'string' || !model.trim() || model === '<synthetic>') return;
    this.models.set(toolUseId, model);
    const task = [...this.tasks.values()].find(task => task.childSessionId === toolUseId && open(task.state));
    if (task && task.model !== model) { task.model = model; this.report(task, task.state, { model: cut(model, 200) }); }
  }
  // Where a command put in the background writes, as its launch said.
  outputFile(toolUseId, path) {
    this.outputs.set(toolUseId, path);
    const task = [...this.tasks.values()].find(task => task.toolUseId === toolUseId && task.kind === 'task' && open(task.state));
    if (task) this.report(task, task.state, { outputFile: cut(path, 4096) });
  }
}

// The next minute after `from` a five-field cron schedule matches, in local time (as Claude Code schedules); null when it
// cannot be read or never matches within five years.
export function nextRun(schedule, from = Date.now()) {
  const fields = typeof schedule === 'string' ? schedule.trim().split(/\s+/) : [];
  if (fields.length !== 5) return null;
  const [minutes, hours, days, months, weekdays] = fields.map((field, i) => values(field, ...[[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]][i]));
  if (![minutes, hours, days, months, weekdays].every(Boolean)) return null;
  if (weekdays.has(7)) weekdays.add(0);
  // Both day fields restricted: either matches.
  const day = date => fields[2] === '*' ? fields[4] === '*' || weekdays.has(date.getDay())
    : fields[4] === '*' ? days.has(date.getDate()) : days.has(date.getDate()) || weekdays.has(date.getDay());
  const t = new Date(from); t.setSeconds(0, 0); t.setMinutes(t.getMinutes() + 1);
  for (const limit = from + 5 * 366 * 86_400_000; t.getTime() < limit;) {
    if (!months.has(t.getMonth() + 1)) { t.setMonth(t.getMonth() + 1, 1); t.setHours(0, 0, 0, 0); }
    else if (!day(t)) { t.setDate(t.getDate() + 1); t.setHours(0, 0, 0, 0); }
    else if (!hours.has(t.getHours())) t.setHours(t.getHours() + 1, 0, 0, 0);
    else if (!minutes.has(t.getMinutes())) t.setMinutes(t.getMinutes() + 1, 0, 0);
    else return t.getTime();
  }
  return null;
}
function values(field, min, max) {
  const set = new Set();
  for (const part of field.split(',')) {
    const m = /^(?:(\*)|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) return null;
    const low = m[1] ? min : Number(m[2]), high = m[1] ? max : m[3] !== undefined ? Number(m[3]) : m[4] ? max : low, step = m[4] ? Number(m[4]) : 1;
    if (low < min || high > max || low > high || step < 1) return null;
    for (let v = low; v <= high; v += step) set.add(v);
  }
  return set;
}
