import { constants, watch } from 'node:fs';
import { open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { homedir } from 'node:os';
import { KimiSubagentBridge, loopUpdate } from './subagents.mjs';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && /^[\w-]+$/.test(value);
const unread = () => null;

// What Kimi keeps of a session in its own files (KIMI_CODE_HOME): its tasks, its main agent's turns, the crons it scheduled
// (`cron.add` / `cron.delete` / `cron.cursor` on the main wire) and its subagents' own conversations, which its ACP does
// not tell. These files are an implementation detail, not an ACP contract. Accept only the layout inspected in 2.1.1; a
// new version simply loses this observation.
export const SUPPORTED = '2.1.1';
// Bounded ordinary-file reads also prevent a broken index/FIFO from holding up
// the entry. No paths, prompts, task output or credentials leave this module.
async function read(path, limit, signal) {
  signal.throwIfAborted();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error('Unsupported file');
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      signal.throwIfAborted();
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > stat.size) throw new Error('File changed during observation');
    return buffer.toString('utf8', 0, length);
  } finally { await file.close(); }
}
async function contained(root, path) {
  const actual = await realpath(path), rel = relative(root, actual);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Foreign path');
  return actual;
}

// The session `sessionId` that Kimi keeps for `cwd`. `startedAt`: when this agent process started; a subagent's run from
// before it is another process's, whose conversation is not told again.
export function kimiSession({ sessionId, cwd, env = {}, version, startedAt = 0 }) {
  const home = env.KIMI_CODE_HOME || join(env.HOME || homedir(), '.kimi-code');
  let directory;
  let subagents;
  // Lines of the main wire whose goal and turns were already given (`main`). The first look gives what it finds as of
  // its end: the wire before it is another process's, or this one's from before it looked.
  let given = null;
  return {
  // Calls `changed` whenever the session's files may have changed, and once its watches are in place; `lost` if one
  // breaks. Its directory is watched whole; its main agent's wire is a file appended to, whose watch (that of a file) is
  // in place once the event loop has polled after it was asked for, so the main turn's end is heard even before the
  // directory's watch has begun. Nothing is watched before an observation found the directory.
  watch(changed, lost) {
    if (!directory) return null;
    const watchers = [];
    let closed = false;
    const close = () => { closed = true; for (const watcher of watchers) watcher.close(); };
    const follow = (path, options) => {
      const watcher = watch(path, options, () => { if (!closed) changed(); });
      watcher.on('error', () => { if (closed) return; close(); lost(); });
      watcher.unref();
      watchers.push(watcher);
    };
    try { follow(directory, { recursive: true }); } catch { close(); return null; }
    try { follow(join(directory, 'agents/main/wire.jsonl'), {}); } catch {}
    setImmediate(() => setImmediate(() => { if (!closed) changed(); }));
    return { close };
  },
  // What the files say now: every task record of its agents and the subagent runs its main agent's wire tells of (`tasks`),
  // when its main agent last ended a turn (`turnEndedAt`, 0 for never), every cron the wire still tells of (`crons`, each
  // `waiting`, `handling`, `done` or `cancelled`, with the created time and fire cursor its next fire is counted from) and
  // the schedule config that count uses (`schedule`), and what its subagents said since the last look, to `emit` as their
  // own sessions' updates. `main` is what the main wire added since the last look, in its order, for turns.mjs: the goal
  // as it changes, each main turn as it begins and ends, and what is said in a goal's or Coda's prompt's turn (as ACP
  // updates); it opens with the goal and the turns still going as of the last look. A cron's prompt and a goal's objective
  // do not leave here, only a short title cut from the first line. Null when the files are not this session's, or not laid
  // out as understood; a read that fails (a file being written) throws. A cron or goal event that is not the shape
  // understood is skipped, so one of them cannot hide the tasks.
  async observe({ signal, emit = () => {} }) {
    if (version !== SUPPORTED) return unread('unsupported_version');
    if (!identifier(sessionId) || !isAbsolute(home ?? '') || !isAbsolute(cwd ?? '')) return unread('unbound_session');
    const root = await realpath(join(home, 'sessions')), workspace = await realpath(cwd);
    if (!directory) {
      const index = await read(join(home, 'session_index.jsonl'), 16 * 1024 * 1024, signal);
      let match;
      for (const line of index.split('\n')) {
        if (!line.trim()) continue;
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        if (entry?.sessionId === sessionId) match = entry;
      }
      if (!match || typeof match.sessionDir !== 'string' || typeof match.workDir !== 'string' ||
        await realpath(match.workDir) !== workspace) return unread('unbound_session');
      directory = await contained(root, match.sessionDir);
    }
    const session = await contained(root, directory);
    const state = JSON.parse(await read(join(session, 'state.json'), 1024 * 1024, signal));
    if (state.version !== 2 || state.id !== sessionId || typeof state.cwd !== 'string' ||
      await realpath(state.cwd) !== workspace || !object(state.agents) || !object(state.agents.main)) return unread('unsupported_layout');
    const agents = Object.keys(state.agents);
    if (agents.length > 256 || !agents.every(identifier)) return unread('unsupported_layout');

    const records = [];
    for (const id of agents) {
      const agent = await contained(session, join(session, 'agents', id));
      let tasks;
      try { tasks = await contained(agent, join(agent, 'tasks')); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      const files = await readdir(tasks, { withFileTypes: true });
      if (files.length > 4096) return unread('unsupported_layout');
      for (const file of files) {
        signal.throwIfAborted();
        if (!file.name.endsWith('.json')) continue;
        if (!file.isFile()) return unread('unsupported_layout');
        const task = JSON.parse(await read(join(tasks, file.name), 1024 * 1024, signal));
        if (!object(task) || !identifier(task.taskId) || file.name !== `${task.taskId}.json` ||
          !['agent', 'process'].includes(task.kind) || typeof task.status !== 'string') return unread('unsupported_layout');
        if (task.status !== 'running' && (!['completed', 'failed', 'killed', 'lost', 'timed_out'].includes(task.status) ||
          !Number.isSafeInteger(task.endedAt) || task.endedAt <= 0)) return unread('unsupported_layout');
        records.push(task);
      }
    }

    subagents ??= new KimiSubagentBridge({ session, root, readBounded: read, contained, startedAt });
    let tasks = records;
    try { tasks = await subagents.sync({ agents, state, tasks: records, signal, emit }); } catch {}
    // A task's end can enqueue a notification that starts another main turn: what it ended with is handled once a turn of
    // the main agent ended after it.
    const wire = await read(join(session, 'agents/main/wire.jsonl'), 32 * 1024 * 1024, signal);
    const lines = wire.trimEnd().split('\n');
    const metadata = JSON.parse(lines.shift());
    if (metadata.type !== 'metadata' || metadata.protocol_version !== '1.5') return unread('unsupported_layout');
    // `cron.delete` is written when a fire is delivered and when CronDelete removes a job during a turn that is not that
    // fire. Which one it was is kept with the job: the open `cron_job` turn, that turn once it ended, or the delete that
    // landed inside some other turn already going. A delete before any such turn is not a cancel: the fire's turn.prompt
    // is written after the delete. `cron.cursor` is the ideal minute that fire advanced to.
    const crons = new Map();
    const span = { turn: null };
    // Main turns begun and not yet ended. Kimi writes the next turn's start before the end of the one it follows.
    const going = new Map();
    const main = [];
    let turnEndedAt = 0, goal = null, loopTurn = null;
    const since = () => {
      if (goal) main.push({ type: 'goal', id: goal.id, title: goal.title, active: goal.active });
      for (const [turnId, turn] of going) if (turn.kind) main.push({ type: 'turn', turnId, ...turn });
    };
    const from = given ?? lines.length;
    for (let i = 0; i < lines.length; i++) {
      signal.throwIfAborted();
      if (i === from) since();
      const fresh = i >= from, event = JSON.parse(lines[i]);
      if (event.type === 'cron.add') noteCron(crons, event);
      else if (event.type === 'cron.delete') dropCron(crons, event, span.turn);
      else if (event.type === 'cron.cursor') noteCursor(crons, event);
      else if (event.type === 'agent.turn.started' || (event.type === 'turn.prompt' && event.agentId === 'main')) {
        if (!span.turn || span.turn.turnId !== event.turnId) span.turn = { turnId: event.turnId, time: event.time, prompted: false, jobId: undefined };
        if (!going.has(event.turnId)) going.set(event.turnId, {});
        if (event.type === 'turn.prompt') {
          noteFire(crons, event, span.turn);
          const turn = { kind: turnKind(event.origin), time: event.time };
          going.set(event.turnId, turn);
          if (fresh) main.push({ type: 'turn', turnId: event.turnId, ...turn });
        }
      } else if (event.type === 'turn.ended') {
        if (event.agentId !== 'main' || !going.has(event.turnId) || !['completed', 'cancelled', 'failed', 'blocked'].includes(event.reason) ||
          !Number.isSafeInteger(event.time) || event.time <= 0) return unread('unsupported_layout');
        going.delete(event.turnId);
        turnEndedAt = event.time;
        for (const cron of crons.values()) if (cron.fireTurn === event.turnId) cron.fireEnded = true;
        if (span.turn?.turnId === event.turnId) span.turn = null;
        if (fresh) main.push({ type: 'ended', turnId: event.turnId, reason: event.reason });
      } else if (event.type === 'goal.create' || event.type === 'goal.update' || event.type === 'goal.clear') {
        const next = noteGoal(goal, event);
        if (next === goal) continue;
        goal = next;
        if (fresh) main.push({ type: 'goal', id: goal.id, title: goal.title, active: goal.active });
      } else if (event.type === 'context.append_loop_event' && event.agentId === 'main' && object(event.event)) {
        // A call's result names no turn: it is of the turn its call was made in, the one the loop is in.
        if (event.event.turnId !== undefined) loopTurn = Number(event.event.turnId);
        const kind = going.get(loopTurn)?.kind;
        if (!fresh || (kind !== 'goal' && kind !== 'user')) continue;
        const update = loopUpdate(event.event, { messageId: event.event.uuid, toolCallId: `${loopTurn}:${event.event.toolCallId}` });
        if (update) main.push({ type: 'update', turnId: loopTurn, update });
      }
    }
    if (from >= lines.length) since();
    given = lines.length;
    return { tasks, turnEndedAt, main, schedule: await cronClock(home, env, signal),
      crons: [...crons.values()].map(publishCron) };
  } };
}

// Who began a main turn: Coda's prompt (`user`), the goal (`goal`), or something else Kimi took up.
function turnKind(origin) {
  if (origin?.kind === 'user') return 'user';
  return origin?.kind === 'system_trigger' && origin.name === 'goal_continuation' ? 'goal' : 'other';
}
// Kimi's goal as its wire leaves it: `active` while Kimi keeps continuing toward it. Each time it turns active it is
// waited on afresh (`id`), since a wait that ended cannot begin again. A clear ends it.
function noteGoal(goal, event) {
  if (event.type === 'goal.clear') return goal?.active ? { ...goal, active: false } : goal;
  if (event.type === 'goal.create') {
    if (!identifier(event.goalId) || typeof event.objective !== 'string') return goal;
    return { goalId: event.goalId, runs: 1, id: event.goalId, title: event.objective.split(/\r?\n/, 1)[0].trim().slice(0, 100),
      active: event.status === undefined || event.status === 'active' };
  }
  if (!goal || typeof event.status !== 'string' || (event.goalId !== undefined && event.goalId !== goal.goalId)) return goal;
  const active = event.status === 'active';
  if (active === goal.active) return goal;
  return active ? { ...goal, runs: goal.runs + 1, id: `${goal.goalId}:${goal.runs + 1}`, active } : { ...goal, active };
}

// A cron.add that is not the shape from 2.1.1 is ignored. A later add of the same id replaces it.
function noteCron(crons, event) {
  const task = event.task;
  if (!object(task) || !identifier(task.id) || typeof task.cron !== 'string' || !task.cron.trim() || task.cron.length > 200 ||
    typeof task.recurring !== 'boolean' || !Number.isSafeInteger(task.createdAt) || task.createdAt <= 0) return;
  const lastFiredAt = Number.isFinite(task.lastFiredAt) && task.lastFiredAt > 0 ? task.lastFiredAt : undefined;
  crons.set(task.id, { id: task.id, schedule: task.cron.trim(), recurring: task.recurring, title: cronTitle(task.prompt),
    createdAt: task.createdAt, lastFiredAt, deletedAt: undefined, fireTurn: undefined, fireEnded: false, explicitCancel: false });
}
function dropCron(crons, event, turn) {
  if (!Array.isArray(event.ids) || !Number.isSafeInteger(event.time) || event.time <= 0) return;
  for (const id of event.ids) {
    const cron = crons.get(id);
    if (!cron) continue;
    cron.deletedAt = event.time;
    // CronDelete runs inside a turn that has already started and is not this job's fire. The fire's own delete is written
    // while no such turn is open, before `turn.prompt`.
    if (cron.fireTurn === undefined && turn?.prompted && turn.jobId !== id && Number.isSafeInteger(turn.time) && turn.time <= event.time) cron.explicitCancel = true;
  }
}
function noteCursor(crons, event) {
  if (!identifier(event.id) || !Number.isFinite(event.lastFiredAt) || event.lastFiredAt <= 0) return;
  const cron = crons.get(event.id);
  if (cron) cron.lastFiredAt = event.lastFiredAt;
}
function noteFire(crons, event, turn) {
  if (Number.isSafeInteger(event.time)) turn.time = event.time;
  turn.prompted = true;
  const origin = event.origin;
  if (!object(origin) || origin.kind !== 'cron_job' || !identifier(origin.jobId)) return;
  const cron = crons.get(origin.jobId);
  if (!cron) return;
  cron.fireTurn = event.turnId;
  cron.fireEnded = false;
  cron.explicitCancel = false;
  turn.jobId = origin.jobId;
}
// The first clause of the prompt, without the command that follows it. Empty when there is nothing to show.
function cronTitle(prompt) {
  if (typeof prompt !== 'string') return '';
  return prompt.split(/\r?\n/, 1)[0].trim().split(/[`（(:：]/, 1)[0].trim().slice(0, 100);
}
function publishCron(cron) {
  const firing = cron.fireTurn !== undefined && !cron.fireEnded;
  // A one-shot's fire, and a recurring one removed as it fired, finished with that turn. Said even when the turn was never
  // seen open, so a look that finds only the end does not report it cancelled.
  const finished = cron.fireEnded && (!cron.recurring || cron.deletedAt !== undefined);
  const phase = firing ? 'handling' : (finished ? 'done' : (cron.explicitCancel ? 'cancelled' : 'waiting'));
  return { id: cron.id, schedule: cron.schedule, recurring: cron.recurring, title: cron.title, phase, createdAt: cron.createdAt,
    ...(cron.lastFiredAt !== undefined ? { lastFiredAt: cron.lastFiredAt } : {}) };
}

// Kimi's `[cron]` table (config.toml, keys snake_cased) and the cron env vars, as 2.1.1 reads them. `noJitter` only when
// the env is exactly `1` or the file says true. A clock `file:` of a relative path, or a table that cannot be read, is
// not reliable: the caller then leaves `at` off. A missing file is the default, which is reliable. `disabled` and
// `manualTick` do not fire on the schedule.
async function cronClock(home, env, signal) {
  let text = '';
  try { text = await read(join(home, 'config.toml'), 1024 * 1024, signal); }
  catch (error) {
    if (error.name === 'AbortError') throw error;
    if (error.code !== 'ENOENT') return { reliable: false };
  }
  const table = parseCronTable(text);
  if (!table.reliable) return { reliable: false };
  const file = table.values;
  const noJitter = env.KIMI_CRON_NO_JITTER === '1' ? true : file.noJitter === true;
  const disabled = env.KIMI_DISABLE_CRON === '1' ? true : file.disabled === true;
  const manualTick = env.KIMI_CRON_MANUAL_TICK === '1' ? true : file.manualTick === true;
  if (disabled || manualTick) return { reliable: false };
  const clock = typeof env.KIMI_CRON_CLOCK === 'string' ? env.KIMI_CRON_CLOCK : typeof file.clock === 'string' ? file.clock : undefined;
  const asOf = await clockNow(clock, signal);
  if (asOf === null) return { reliable: false };
  return { reliable: true, noJitter, ...(asOf === undefined ? {} : { asOf }) };
}
// The `[cron]` table only. Other tables are skipped, so a config without one keeps the default. A value of a key the
// schedule depends on that is not a scalar makes the table unusable.
function parseCronTable(text) {
  let inCron = false, reliable = true;
  const values = {};
  for (let line of text.split('\n')) {
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line.trim().startsWith('[')) {
      const header = tomlHeader(line);
      if (!header) { if (inCron) reliable = false; continue; }
      inCron = !header.array && header.name === 'cron';
      continue;
    }
    if (!inCron || /^\s*(?:#.*)?$/.test(line)) continue;
    const keyValue = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(line);
    if (!keyValue) { reliable = false; continue; }
    const key = keyValue[1].replace(/_([a-z])/g, (_, ch) => ch.toUpperCase());
    const value = parseTomlScalar(stripTomlComment(keyValue[2]).trim());
    if (value === undefined) { if (key === 'noJitter' || key === 'clock' || key === 'disabled' || key === 'manualTick') reliable = false; continue; }
    values[key] = value;
  }
  return { reliable, values };
}
function tomlHeader(line) {
  const body = stripTomlComment(line).trim();
  const array = /^\[\[(.+)\]\]$/.exec(body), table = array ? null : /^\[(.+)\]$/.exec(body);
  if (!array && !table) return null;
  return { array: Boolean(array), name: (array ?? table)[1].trim() };
}
function stripTomlComment(value) {
  let quote = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quote) {
      if (quote === '"' && ch === '\\') { i += 1; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '#') return value.slice(0, i);
  }
  return value;
}
function parseTomlScalar(raw) {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw.startsWith("'")) { const literal = /^'([^'\n]*)'$/.exec(raw); return literal ? literal[1] : undefined; }
  if (raw.startsWith('"')) return parseBasicString(raw);
  if (/^[+-]?(?:\d+\.\d*|\d*\.\d+|\d+)(?:[eE][+-]?\d+)?$/.test(raw)) { const n = Number(raw); return Number.isFinite(n) ? n : undefined; }
  return undefined;
}
function parseBasicString(raw) {
  if (!raw.endsWith('"') || raw.length < 2) return undefined;
  let out = '';
  for (let i = 1; i < raw.length - 1; i++) {
    if (raw[i] === '"') return undefined;
    if (raw[i] !== '\\') { out += raw[i]; continue; }
    const esc = raw[++i];
    const map = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
    if (Object.hasOwn(map, esc)) { out += map[esc]; continue; }
    if (esc === 'u') {
      const hex = raw.slice(i + 1, i + 5);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) return undefined;
      out += String.fromCharCode(Number.parseInt(hex, 16));
      i += 4;
      continue;
    }
    return undefined;
  }
  return out;
}
// 2.1.1: empty, `system` or an unknown scheme is the system clock (`undefined` here, so the caller uses its own now).
// `file:` of an absolute path is that file's first line, and Date.now() when it cannot be read — except a relative
// path, which depends on Kimi's cwd and is `null` (not reliable).
async function clockNow(spec, signal) {
  if (spec === undefined || spec === '' || spec === 'system' || !spec.startsWith('file:')) return undefined;
  const path = spec.slice('file:'.length);
  if (path === '') return undefined;
  if (!isAbsolute(path)) return null;
  signal.throwIfAborted();
  let file;
  try { file = await open(path, constants.O_RDONLY); }
  catch { return undefined; }
  try {
    const buffer = Buffer.alloc(64);
    const { bytesRead } = await file.read(buffer, 0, 64, 0);
    const line = buffer.toString('utf8', 0, bytesRead).split('\n', 1)[0]?.trim() ?? '';
    if (!line) return undefined;
    const parsed = Number(line);
    return Number.isFinite(parsed) ? parsed : undefined;
  } catch { return undefined; }
  finally { await file.close(); }
}
