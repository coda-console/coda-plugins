// Random sequences of what Coda and Claude Code may do, each in any order the two sides' messages can cross in, run against the
// Claude entry's session as it is (#222). Its outside is stood in for: Coda (client), the SDK's query, the title, the clock;
// each step drives it synchronously, and after each the rules of turn-rules.mjs are checked of what Coda saw. A failure is
// cut to its shortest sequence and printed with its seed. CLAUDE_TURNS_SEED replays a seed, CLAUDE_TURNS_RUNS and
// CLAUDE_TURNS_STEPS run more.
//
// Not yet: subagents, a compaction Coda asks for, a move to another model's query, the process ending.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeSession } from '../../../plugins/claude/agent/session.mjs';
import { Seen, broken } from './turn-rules.mjs';

const SEED = Number(process.env.CLAUDE_TURNS_SEED ?? 222);
const RUNS = Number(process.env.CLAUDE_TURNS_RUNS ?? (process.env.CLAUDE_TURNS_SEED ? 1 : 10000));
const STEPS = Number(process.env.CLAUDE_TURNS_STEPS ?? 60);

function generator(seed) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return Object.assign(next, { int: n => Math.floor(next() * n), pick: list => list[Math.floor(next() * list.length)] });
}

// The session with its outside stood in for, and Claude Code as the model has it: what it was given and not taken (`queue`),
// the turn going, the notices of tasks' ends it is yet to run (`notices`), its background tasks, its wakeups, the interrupts
// asked of it, and what results named or it dropped (`closed`).
function world() {
  const seen = new Seen(), w = { seen, prompts: [], unanswered: null, failure: null, n: 0 };
  const sdk = w.sdk = { queue: [], turn: null, notices: [], tasks: new Map(), crons: new Map(), idle: false, interrupts: [], closed: new Set(), latched: false };
  // A clock that moves only as the steps do.
  let tick = 0;
  const now = () => Date.UTC(2026, 5, 1) + tick * 1000;
  w.tick = () => { tick++; };
  w.fail = violation => { if (violation && !w.failure) w.failure = violation; };
  const session = w.session = new ClaudeSession({ sdk: {}, env: {}, now });
  session.waits.now = now;
  Object.assign(session, { phase: 'running', sessionId: 'S', title: { append() {}, async refresh() {} } });
  session.client = { notify: (method, params) => { if (method === '_coda/wait') w.fail(seen.wait(params)); return Promise.resolve(); }, request: () => new Promise(() => {}) };
  // What Coda writes reaches Claude Code in order: an interrupt asked before is handled before this comes.
  session.input = { push: m => { for (const asked of sdk.interrupts) if (!asked.applied) reach(w, asked); sdk.queue.push({ uuid: m.uuid, next: m.priority === 'next' }); sdk.idle = false; w.given = m.uuid; }, close() {} };
  // An interrupt's receipt comes when the model says (receipt): until then the session waits on it.
  session.query = {
    interrupt: options => {
      const asked = { options, applied: false }, receipt = { then: done => { asked.done = done; return receipt; }, catch: () => receipt };
      sdk.interrupts.push(asked);
      return receipt;
    },
    async stopTask(taskId) { (sdk.stops ??= []).push(taskId); }, close() {} };
  w.emit = m => session.receive({ session_id: 'S', uuid: `m${++w.n}`, parent_tool_use_id: null, ...m });
  w.snapshot = () => w.emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [...sdk.tasks.values()].filter(task => task.backgrounded)
    .map(task => ({ task_id: task.id, run_id: task.runId, task_type: 'local_bash', description: task.id })) });
  return w;
}
// The one a step picks among those there are then (by its number, so that a step still picks one in a shorter sequence).
const nth = (list, i) => list[i % list.length];

// Each action: whether it can come now (`when`), what of it is chosen (`gen`, kept with the step so a replay does the same),
// and what it does (`apply`: false when what it names is not there, as in a sequence cut short).
const ACTIONS = {
  // Coda: at most one prompt not answered, sent only while it sees no turn going (none handling); steered into it while it
  // goes; stopped at any time.
  prompt: {
    when: w => !w.unanswered && !w.seen.handling,
    apply: w => {
      const label = `p${w.prompts.length + 1}`;
      const answered = w.session.prompt({ prompt: [{ type: 'text', text: label }] });
      answered.catch(() => {});
      w.prompts.push(label); w.unanswered = label;
      const pending = w.session.prompts.get(w.given), uuid = w.given;
      for (const key of ['resolve', 'reject']) {
        const settle = pending[key];
        pending[key] = value => { w.fail(w.seen.answer(label, w.sdk.closed.has(uuid))); if (w.unanswered === label) w.unanswered = null; settle(value); };
      }
    },
  },
  steer: {
    when: w => !!w.unanswered,
    apply: w => void w.session.steer({ prompt: [{ type: 'text', text: 'steer' }] }),
  },
  cancel: { when: () => true, apply: w => w.session.cancel({ sessionId: 'S' }) },
  stopWait: {
    when: w => tasks(w).length > 0,
    gen: (w, r) => ({ wait: r.int(64) }),
    apply: (w, { wait }) => void w.session.stopWait({ waitId: nth(tasks(w), wait) }).catch(() => {}),
  },

  // Claude Code. A turn begins with its init: for what it was given (one message, or several sent close together as one,
  // sdk.d.ts SDKResultMessage.user_message_uuids), maybe with notices queued beside them.
  begin: {
    when: w => !w.sdk.turn && w.sdk.queue.length > 0 && !answering(w),
    gen: (w, r) => ({ batch: 1 + r.int(Math.min(3, w.sdk.queue.length)), notices: r() < 0.3 }),
    apply: (w, { batch, notices }) => {
      const { sdk } = w;
      sdk.turn = { meta: false, taken: sdk.queue.splice(0, batch).map(m => m.uuid), foreground: new Set(), interrupted: sdk.latched, asked: [] };
      if (notices) sdk.notices = [];
      sdk.latched = false; sdk.idle = false;
      w.emit({ type: 'system', subtype: 'init', model: 'm', permissionMode: 'default' });
    },
  },
  // A turn of its own (meta), for a task's end or a wakeup that fires; its opening message may say which (SDKMessageOrigin
  // task-notification: runId, subkind scheduled-trigger).
  wake: {
    when: w => !w.sdk.turn && (w.sdk.notices.length > 0 || w.sdk.crons.size > 0) && !answering(w),
    gen: (w, r) => {
      const cron = !w.sdk.notices.length || (w.sdk.crons.size > 0 && r() < 0.4);
      return cron ? { cron: r.int(64), origin: r() < 0.6 } : { notices: 1 + r.int(w.sdk.notices.length), origin: r() < 0.6 };
    },
    apply: (w, { cron, notices, origin }) => {
      const { sdk } = w;
      const fired = cron !== undefined && nth([...sdk.crons.values()], cron);
      if (cron !== undefined ? !fired : sdk.notices.length < notices) return false;
      const taken = fired ? [] : sdk.notices.splice(0, notices);
      if (fired && !fired.recurring) sdk.crons.delete(fired.id);
      sdk.turn = { meta: true, taken: [], foreground: new Set(), interrupted: sdk.latched, asked: [] };
      sdk.latched = false; sdk.idle = false;
      w.emit({ type: 'system', subtype: 'init', model: 'm', permissionMode: 'default' });
      if (origin) w.emit({ type: 'user', message: { role: 'user', content: fired ? fired.prompt : `<task-notification>${taken[0].task}</task-notification>` },
        origin: fired ? { kind: 'task-notification', subkind: 'scheduled-trigger' } : { kind: 'task-notification', runId: taken[0].runId } });
    },
  },
  // In a turn: it says something, runs a tool, asks for a permission, starts tasks, schedules wakeups.
  say: { when: w => live(w), apply: w => w.emit({ type: 'assistant', message: { id: `a${++w.n}`, content: [{ type: 'text', text: '说' }] } }) },
  // A tool round, between which the turn takes in what is queued: every one marked `next`; a turn of its own any of them
  // (sdk.d.ts SDKAssistantMessage.user_message_uuid: "a queued user message folded in mid-turn"; fixture-sdk.mjs fold).
  // Notices queued may go in too.
  tool: {
    when: w => live(w),
    gen: (w, r) => ({ fold: r.int(w.sdk.queue.length + 1), notices: r() < 0.5 }),
    apply: (w, { fold, notices }) => {
      const { sdk } = w, id = `tool${++w.n}`;
      w.emit({ type: 'assistant', message: { id: `a${id}`, content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'true' } }] } });
      w.emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
      const taken = sdk.turn.meta ? sdk.queue.splice(0, fold) : sdk.queue.filter(m => m.next);
      sdk.queue = sdk.queue.filter(m => !taken.includes(m));
      sdk.turn.taken.push(...taken.map(m => m.uuid));
      if (notices) sdk.notices = [];
    },
  },
  permission: {
    when: w => live(w),
    apply: w => {
      const asked = new AbortController();
      w.sdk.turn.asked.push(asked);
      void w.session.permission('Bash', { command: 'true' }, { signal: asked.signal, toolUseID: `tool${++w.n}` });
    },
  },
  // A task begun: in the background at once (its place in the list before or after task_started, sdk.d.ts
  // SDKBackgroundTasksChangedMessage), or in the foreground, blocking the turn until it ends or is put in the background
  // (SDKTaskStartedMessage.is_backgrounded).
  task: {
    when: w => live(w),
    gen: (w, r) => ({ foreground: r() < 0.3, listedFirst: r() < 0.5 }),
    apply: (w, { foreground, listedFirst }) => {
      const id = `t${++w.n}`, task = { id, runId: `run-${id}`, backgrounded: !foreground };
      w.sdk.tasks.set(id, task);
      if (foreground) w.sdk.turn.foreground.add(id);
      if (listedFirst && !foreground) w.snapshot();
      w.emit({ type: 'system', subtype: 'task_started', task_id: id, run_id: task.runId, tool_use_id: `tool-${id}`, task_type: 'local_bash', description: id, is_backgrounded: !foreground });
      if (!listedFirst && !foreground) w.snapshot();
    },
  },
  background: {
    when: w => !!w.sdk.turn && w.sdk.turn.foreground.size > 0,
    gen: (w, r) => ({ task: r.int(64) }),
    apply: (w, { task: i }) => {
      const task = nth([...w.sdk.turn.foreground], i);
      w.sdk.turn.foreground.delete(task);
      w.sdk.tasks.get(task).backgrounded = true;
      w.emit({ type: 'system', subtype: 'task_updated', task_id: task, run_id: w.sdk.tasks.get(task).runId, patch: { is_backgrounded: true } });
      w.snapshot();
      w.emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tool-${task}`, content: 'Command running in background' }] } });
    },
  },
  // A task's end, in a turn or out of one: told by task_notification, task_updated or both, then the list without it. One in the
  // background leaves a notice that wakes Claude Code unless a turn takes it in first; one in the foreground answers its call.
  end: {
    when: w => w.sdk.tasks.size > 0,
    gen: (w, r) => ({ task: r.int(64), how: r.pick(['notification', 'updated', 'both']), status: r.pick(['completed', 'completed', 'failed', 'stopped']) }),
    apply: (w, { task: i, how, status }) => {
      const { sdk } = w, task = nth([...sdk.tasks.values()], i), { id } = task;
      sdk.tasks.delete(id);
      if (how !== 'notification') w.emit({ type: 'system', subtype: 'task_updated', task_id: id, run_id: task.runId, patch: { status: status === 'stopped' ? 'killed' : status } });
      if (how !== 'updated') w.emit({ type: 'system', subtype: 'task_notification', task_id: id, run_id: task.runId, tool_use_id: `tool-${id}`,
        status, output_file: `/tmp/${id}.output`, summary: id });
      if (!task.backgrounded) {
        sdk.turn.foreground.delete(id);
        return void w.emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tool-${id}`, content: 'done' }] } });
      }
      w.snapshot();
      sdk.notices.push({ task: id, runId: task.runId });
      sdk.idle = false;
    },
  },
  // The list of background tasks, again, at any time (a level signal).
  listed: { when: () => true, apply: w => w.snapshot() },
  // Wakeups made or deleted in a turn (CronCreate, CronDelete): its Stop hook lists those it has as it ends.
  schedule: {
    when: w => live(w),
    gen: (w, r) => ({ recurring: r() < 0.4, due: r() < 0.7 }),
    apply: (w, { recurring, due }) => {
      const id = `c${++w.n}`;
      w.sdk.crons.set(id, { id, schedule: due ? '* * * * *' : '0 0 1 1 *', recurring, prompt: `wake ${id}` });
    },
  },
  unschedule: {
    when: w => live(w) && w.sdk.crons.size > 0,
    gen: (w, r) => ({ cron: r.int(64) }),
    apply: (w, { cron }) => void w.sdk.crons.delete(nth([...w.sdk.crons.keys()], cron)),
  },
  // The turn's end: its Stop hook (unless it was stopped), then its result, naming what it took in (user_message_uuids). It can
  // fail, and ends as stopped once an interrupt reached it. It counts the messages still queued behind it (queued_turn_count),
  // notices not among them.
  result: {
    when: w => !!w.sdk.turn && w.sdk.turn.foreground.size === 0,
    gen: (w, r) => ({ failed: r() < 0.15 }),
    apply: (w, { failed }) => {
      const { sdk } = w, turn = sdk.turn;
      // What the Stop hook in session.mjs gives the waits.
      if (!turn.interrupted) w.session.waits.scheduled([...sdk.crons.values()]);
      for (const id of turn.taken) sdk.closed.add(id);
      sdk.turn = null;
      const named = turn.taken.slice(0, 64);
      w.emit({ type: 'result', subtype: failed ? 'error_during_execution' : 'success', is_error: failed, ...(failed ? { errors: ['这一轮失败了'] } : {}),
        stop_reason: turn.interrupted ? 'interrupt' : 'end_turn', ...(named.length ? { user_message_uuid: named.at(-1), user_message_uuids: named } : {}),
        queued_turn_count: sdk.queue.length, usage: {}, modelUsage: {}, total_cost_usd: 0 });
      for (const asked of turn.asked) asked.abort();
    },
  },
  // An interrupt reaches Claude Code: the turn going stops; asked with cancelQueued, what is queued is dropped, notices with it
  // (sdk.d.ts interrupt cancel_queued). One with no turn going and a message about to start one stops that turn as it begins
  // (the first-command prewait latch). Its receipt comes after, before or after the stopped turn's result, but before another
  // turn begins: Claude Code answers the request once it has handled it.
  interrupt: {
    when: w => w.sdk.interrupts.some(asked => !asked.applied),
    apply: w => reach(w, w.sdk.interrupts.find(asked => !asked.applied)),
  },
  receipt: {
    when: w => w.sdk.interrupts[0]?.applied === true,
    apply: w => { const asked = w.sdk.interrupts.shift(); asked.done?.(asked.receipt); },
  },
  // Nothing left to run: no turn, nothing given or noticed, no interrupt unanswered.
  idle: {
    when: w => !w.sdk.turn && !w.sdk.queue.length && !w.sdk.notices.length && !w.sdk.interrupts.length && !w.sdk.idle,
    apply: w => { w.sdk.idle = true; w.emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' }); },
  },
};
function reach(w, asked) {
  const { sdk } = w;
  asked.applied = true;
  if (sdk.turn) sdk.turn.interrupted = true;
  else if (sdk.queue.length) sdk.latched = true;
  if (!asked.options?.cancelQueued) return void (asked.receipt = { still_queued: sdk.queue.map(m => m.uuid) });
  const cancelled = sdk.queue.map(m => m.uuid);
  for (const id of cancelled) sdk.closed.add(id);
  sdk.queue = []; sdk.notices = []; sdk.latched = false;
  asked.receipt = { still_queued: [], cancelled };
}
// A turn that can still say and do things: one an interrupt reached only ends.
const live = w => !!w.sdk.turn && !w.sdk.turn.interrupted;
// An interrupt handled and not yet answered.
const answering = w => w.sdk.interrupts.some(asked => asked.applied);

// A step done; what the session throws while it is fails it too.
function apply(w, act) {
  try { return ACTIONS[act.action].apply(w, act); } catch (error) { w.fail(`异常：${error.message}`); }
}
// After each step, the rules of what Coda saw.
function check(w) {
  const { sdk } = w;
  w.fail(broken(w.seen, { turning: !!sdk.turn, idle: sdk.idle, running: [...sdk.tasks.values()].some(task => task.backgrounded),
    queued: sdk.queue.length > 0, prompts: w.prompts }));
  return w.failure;
}
// The tasks Coda was told of, which it may ask stopped.
function tasks(w) { return [...w.seen.waits].filter(([id, wait]) => wait.kind === 'task' && !id.startsWith('turn-')).map(([id]) => id); }
// One step chosen at random among those that can come now.
function step(w, r) {
  const names = Object.keys(ACTIONS).filter(name => ACTIONS[name].when(w));
  const name = r.pick(names);
  return { action: name, ...ACTIONS[name].gen?.(w, r) };
}
// The steps played from the start; the first rule broken, and at which step.
function play(steps) {
  const w = world();
  for (const [i, act] of steps.entries()) {
    const action = ACTIONS[act.action];
    if (!action.when(w) || apply(w, act) === false) continue;
    w.tick();
    if (check(w)) return { failure: w.failure, at: i, w };
  }
  return null;
}
function generate(seed) {
  const r = generator(seed), w = world(), steps = [];
  for (let i = 0; i < STEPS; i++) {
    const act = step(w, r);
    steps.push(act);
    apply(w, act);
    w.tick();
    if (check(w)) return steps;
  }
  return null;
}
// The failing prefix, cut down while the same rule still breaks: a step at a time, until none can go.
function shrink(steps) {
  const rule = s => play(s)?.failure.slice(0, 4);
  const first = play(steps), want = first.failure.slice(0, 4);
  let best = steps.slice(0, first.at + 1);
  for (let progress = true; progress;) {
    progress = false;
    for (let i = best.length - 1; i >= 0; i--) {
      const shorter = best.toSpliced(i, 1);
      if (rule(shorter) === want) { best = shorter; progress = true; }
    }
    const ended = play(best);
    best = best.slice(0, ended.at + 1);
  }
  return best;
}
function describe(steps) {
  const { failure } = play(steps);
  return [failure, ...steps.map((act, i) => `  ${i + 1}. ${act.action}${Object.keys(act).length > 1 ? ' ' + JSON.stringify(Object.fromEntries(Object.entries(act).filter(([key]) => key !== 'action'))) : ''}`)].join('\n');
}

test('随机的轮次与等待项序列里，Coda 看到的始终守规则（#222）', async () => {
  for (let run = 0; run < RUNS; run++) {
    // What the sessions left to settle (their answers, their withdrawn asks) settles between runs.
    await null;
    const seed = SEED + run, steps = generate(seed);
    if (!steps) continue;
    const shortest = shrink(steps);
    assert.fail(`种子 ${seed}（CLAUDE_TURNS_SEED=${seed} 重放），缩短到 ${shortest.length} 步：\n${describe(shortest)}`);
  }
});

// Sequences the random ones found, played as they are: #222, and what main then did to a prompt it was answering.
const SEQUENCES = {
  // Claude Code's own turn for a task's end takes in a prompt Coda sent before it saw that turn: what the turn handled ends.
  '自己开的一轮收进 Coda 的 prompt（#222）': [{ action: 'prompt' }, { action: 'begin', batch: 1, notices: true }, { action: 'task', foreground: false, listedFirst: false },
    { action: 'result', failed: false }, { action: 'end', task: 23, how: 'updated', status: 'completed' }, { action: 'wake', notices: 1, origin: false },
    { action: 'prompt' }, { action: 'tool', fold: 1, notices: false }, { action: 'result', failed: false }],
  // A steer while the prompt is still queued, then a stop: both dropped, the prompt answered as stopped.
  '还在排队的 prompt 与插话一起被丢弃': [{ action: 'prompt' }, { action: 'steer' }, { action: 'cancel' }, { action: 'interrupt' }, { action: 'receipt' }, { action: 'idle' }],
  // A turn of Claude Code's own fails, naming no input, with Coda's prompt queued behind it: that prompt runs after.
  '没点名输入的失败轮次后还有排队的 prompt': [{ action: 'prompt' }, { action: 'begin', batch: 1, notices: false }, { action: 'schedule', recurring: false, due: false },
    { action: 'result', failed: false }, { action: 'prompt' }, { action: 'wake', cron: 31, origin: true }, { action: 'result', failed: true }],
  // The prompt waits on a steer its turn left; Claude Code's own turn comes first, and the steer is dropped while it goes.
  '等插话的 prompt 在别的轮次进行时丢了插话': [{ action: 'prompt' }, { action: 'cancel' }, { action: 'begin', batch: 1, notices: false },
    { action: 'schedule', recurring: true, due: false }, { action: 'steer' }, { action: 'receipt' }, { action: 'result', failed: false },
    { action: 'wake', cron: 59, origin: false }, { action: 'interrupt' }, { action: 'receipt' }, { action: 'result', failed: false }, { action: 'idle' }],
};
for (const [name, steps] of Object.entries(SEQUENCES)) test(`固定序列：${name}`, () => assert.equal(play(steps)?.failure ?? null, null));

// The rules themselves, on what Coda is told.
test('判定函数认出四条规则', () => {
  const seen = new Seen();
  assert.equal(seen.wait({ waitId: 'a', state: 'waiting' }), '规则 4：a 第一次报告没有 kind 或 title');
  assert.equal(seen.wait({ waitId: 'b', state: 'handling', kind: 'task', title: 'B' }), null);
  assert.equal(broken(seen, { turning: false, idle: false, running: false, queued: false, prompts: [] }), '规则 1：没有轮次在进行，b 还在 handling');
  assert.equal(seen.wait({ waitId: 'b', state: 'waiting' }), '规则 4：b 从 handling 回到 waiting');
  assert.equal(seen.wait({ waitId: 'c', state: 'handling', kind: 'timer', title: 'C' }), null);
  assert.equal(seen.wait({ waitId: 'c', state: 'waiting' }), null);
  assert.equal(broken(seen, { turning: true, idle: true, running: false, queued: false, prompts: [] }), '规则 2：已 idle、没有后台任务，a、b 还没结束');
  assert.equal(broken(seen, { turning: true, idle: true, running: true, queued: false, prompts: ['p1'] }), '规则 3：已 idle，prompt p1 还没答复');
  assert.equal(seen.answer('p1', false), '规则 3：prompt p1 在收进它的 result、取消或丢弃之前就答复了');
  assert.equal(seen.answer('p1', true), '规则 3：prompt p1 答复了 2 次');
  assert.equal(seen.wait({ waitId: 'b', state: 'done' }), null);
  assert.equal(seen.wait({ waitId: 'b', state: 'done' }), '规则 4：b 已经 done，又报了 done');
});
