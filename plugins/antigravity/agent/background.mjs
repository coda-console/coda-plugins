// agy moves a `run_command` that is still running after its `WaitMsBeforeAsync` into the background. The ACP card then stays
// `in_progress` with no content (agy 1.5.15 says nothing of it on ACP: no text, no field), and the task id and log of the task
// are in agy's own transcript of the session only, so Coda could not list it. This reads that transcript, read-only, and tells
// Coda the task as a `_coda/wait` (docs/agent-protocol.md「_coda/wait」):
//   start: a step of status RUNNING, "Tool is running as a background task with task id: <session>/task-N\nTask Description: <command>"
//          and a "Task logs are available at: file://…" line after the command (a step over about 2.5 KB has its middle replaced by
//          "\n<truncated N bytes>\n").
//          The ACP call it belongs to is the one open `execute` call whose command is that description (when the step is cut, whose
//          command has the two ends of it); none or several fit: not registered. The task id is not the toolCallId.
//   end:   a SYSTEM step, "content=Task id \"<task id>\" finished with result:\nCommand exited with code N." or "was canceled with
//          result:\nTool execution was canceled". The call's own ACP update that ends it, when it comes, ends the task, too.
// A command with `IsDaemon: true` is a server left running on purpose (T3 Code's reading of it, too): it is told with `awaited: false`.
// Its card is left as agy says it: a call that launched a wait is shown by Coda as moved to the background, and neither it nor a
// wait that is not awaited keeps the session from being at rest (docs/session-contracts.md「会话静止」), so no result is made up for it.
// The end by the card's ACP update: the exit code says the result (-1 is agy cancelling it).
// Two more things are read from the same file, and the same session directory: a turn that ACP ends with `end_turn` while its last step
// since the prompt is an upstream error (SYSTEM / ERROR_MESSAGE, `error` is the text) failed without saying so: `finish` returns the
// text, but only when the turn said nothing on ACP (`spoke`: a reply text, a tool that succeeded), because agy writes the transcript
// late and an error it got over could still be its last step; only when the error came after the user input step of this turn (an
// error written late for the turn before comes before it, or with none); and only from what this read got. And the
// sub-agents agy started (subagents.mjs) are told as `_coda/wait` of kind `subagent`.
// Whatever cannot be read (no file, another shape, a failed read) is skipped without a word: the session goes on as plain ACP.
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALIVE, KILLED, children, idled, launch } from './subagents.mjs';

const START = /^(?:Created At: [^\n]*\n)?Tool is running as a background task with task id: (\S+)\nTask Description: /;
const END = /<SYSTEM_MESSAGE>\n\[Message\] [^\n]* content=Task id "([^"]+)" (finished|was canceled) with result:\n/;
const CUT = /\n<truncated \d+ bytes>\n/;
const EXIT = /^Command exited with code (-?\d+)\./m;
const TERMINAL = new Set(['completed', 'failed']);

export class Background {
  // `send(params)` writes one `_coda/wait`; `home` is where agy keeps `.gemini`; `interval` is how often the transcript is read;
  // `waits()` is whether Coda takes `_coda/wait` (the sub-agents are looked for only then).
  constructor({ send, home = homedir(), interval = 1000, waits = () => true }) {
    Object.assign(this, { send, home, interval, waits });
    this.brain = join(home, '.gemini/antigravity-cli/brain');
    this.sessions = new Map();
  }

  // A tool_call or tool_call_update of a session, as agy sent it.
  observe(sessionId, update) {
    const id = update.toolCallId;
    let session = this.sessions.get(sessionId);
    const call = session?.calls.get(id);
    if (!call) {
      const input = update.rawInput ?? update.args;
      if (update.kind !== 'execute' || typeof input?.CommandLine !== 'string' || TERMINAL.has(update.status)) return;
      session ??= this.open(sessionId);
      session.calls.set(id, { command: input.CommandLine.trim(), summary: input.toolSummary, daemon: [true, 'true'].includes(input.IsDaemon) });
      this.watch(session);
      return;
    }
    if (!TERMINAL.has(update.status)) return;
    session.calls.delete(id);
    if (call.waitId) {
      const code = update.rawOutput?.exit_code;
      const state = code === -1 ? 'cancelled' : update.status === 'failed' || (code !== undefined && code !== 0) ? 'failed' : 'done';
      // After the card's own update, which the entry forwards when this returns.
      queueMicrotask(() => this.end(session, call.waitId, state));
    }
    this.watch(session);
  }

  // The session ends: what it still has in the background is told cancelled.
  closeSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.calls.clear();
    for (const waitId of [...session.tasks]) this.end(session, waitId, 'cancelled');
    for (const id of [...session.live]) this.finishChild(session, id, 'cancelled');
    this.watch(session);
    this.sessions.delete(sessionId);
  }

  closeAll() {
    for (const sessionId of [...this.sessions.keys()]) this.closeSession(sessionId);
  }

  // What the transcript has gained since the first call of the session was seen (before that is not this run's). Whether it could be read.
  scan(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    let text = '', read = true;
    try { text = this.read(session); } catch { read = false; }
    for (const line of text.split('\n')) {
      let step; try { step = JSON.parse(line); } catch { continue; }
      if (!step || typeof step !== 'object') continue;
      if (step.source === 'USER_EXPLICIT' && step.type === 'USER_INPUT') session.input = true;
      session.last = step;
      session.lastAfterInput = session.input;
      if (typeof step.content === 'string') this.step(sessionId, session, step);
    }
    if (this.waits()) this.follow(session);
    this.watch(session);
    return read;
  }

  // A prompt of the session goes to agy: what is read from here is this turn's.
  begin(sessionId) {
    const known = this.sessions.get(sessionId);
    if (known) this.scan(sessionId);
    const session = known ?? this.open(sessionId);
    session.last = null;
    session.input = false;
    session.spoke = false;
    session.prompting = true;
    this.watch(session);
  }

  // The turn has said something on ACP: a reply text, or a tool that succeeded.
  spoke(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) session.spoke = true;
  }

  // The prompt is answered. With `endTurn`, the text of the upstream error the turn stopped on, or null: also when the transcript
  // could not be read just now, or the turn said something, which an error agy got over does not.
  finish(sessionId, endTurn) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const read = this.scan(sessionId);
    session.prompting = false;
    this.watch(session);
    const step = session.last;
    return endTurn && read && !session.spoke && session.lastAfterInput && step?.source === 'SYSTEM' && step.type === 'ERROR_MESSAGE' && typeof step.error === 'string' ? step.error.trim() || null : null;
  }

  open(sessionId) {
    const dir = join(this.brain, sessionId, '.system_generated');
    const file = join(dir, 'logs/transcript.jsonl');
    let offset = 0; try { offset = statSync(file).size; } catch { /* not there yet: all of it is new */ }
    const session = { id: sessionId, dir, file, offset, rest: Buffer.alloc(0), calls: new Map(), tasks: new Set(), timer: null,
      last: null, input: false, lastAfterInput: false, spoke: false, prompting: false, known: new Set(), live: new Set(), seen: new Set() };
    // The sub-agents and notes there already are belong to before.
    if (this.waits()) { session.known = new Set(children(dir).keys()); idled(dir, session.seen); }
    this.sessions.set(sessionId, session);
    return session;
  }

  // Read while a call, a task or a sub-agent is open, or a prompt is being answered.
  watch(session) {
    const busy = session.tasks.size > 0 || session.live.size > 0 || (session.prompting && this.waits()) || [...session.calls.values()].some(call => !call.waitId);
    if (busy && !session.timer) session.timer = setInterval(() => this.scan(session.id), this.interval).unref();
    else if (!busy && session.timer) { clearInterval(session.timer); session.timer = null; }
  }

  read(session) {
    const size = statSync(session.file).size;
    if (size <= session.offset) return '';
    const buffer = Buffer.alloc(size - session.offset);
    const fd = openSync(session.file, 'r');
    let count; try { count = readSync(fd, buffer, 0, buffer.length, session.offset); } finally { closeSync(fd); }
    session.offset += count;
    const all = Buffer.concat([session.rest, buffer.subarray(0, count)]);
    const end = all.lastIndexOf(10) + 1;
    session.rest = all.subarray(end);
    return all.subarray(0, end).toString('utf8');
  }

  step(sessionId, session, step) {
    const started = step.source === 'MODEL' && step.status === 'RUNNING' ? START.exec(step.content) : null;
    if (started) return this.start(sessionId, session, started[1], step.content.slice(started[0].length));
    const ended = step.source === 'SYSTEM' ? END.exec(step.content) : null;
    if (!ended || !session.tasks.has(ended[1])) return;
    const exit = EXIT.exec(step.content.slice(ended.index + ended[0].length, ended.index + ended[0].length + 1000));
    this.end(session, ended[1], ended[2] === 'was canceled' ? 'cancelled' : exit && exit[1] !== '0' ? 'failed' : 'done');
  }

  start(sessionId, session, taskId, rest) {
    const logged = /\nTask logs are available at: (file:\/\/\S+)/.exec(rest);
    const text = logged ? rest.slice(0, logged.index) : rest;
    // A step that is too long has its middle replaced by a marker: the command begins with what comes before it and ends with what follows.
    const cut = CUT.exec(text);
    const [head, tail] = (cut ? [text.slice(0, cut.index), text.slice(cut.index + cut[0].length)] : [text, '']).map(part => part.trim());
    if (!head || taskId.length > 200) return;
    // The whole command, or only when the step says it was cut, its two ends; with more than one call that fits, none is taken for it.
    const fits = [...session.calls].filter(([, call]) => !call.waitId && (cut ? call.command.startsWith(head) && call.command.endsWith(tail) : call.command === head));
    if (fits.length !== 1 || fits[0][0].length > 200) return;
    const [[toolCallId, call]] = fits;
    call.waitId = taskId;
    session.tasks.add(taskId);
    let log = join(session.dir, 'tasks', `${taskId.slice(taskId.lastIndexOf('/') + 1)}.log`);
    try { if (logged) log = fileURLToPath(logged[1]); } catch { /* keeps the one the layout gives */ }
    this.send({ sessionId, waitId: taskId, kind: 'task', state: 'waiting', toolCallId,
      title: (call.summary || call.command.split('\n')[0]).slice(0, 500), detail: call.command.slice(0, 4000),
      ...(existsSync(log) && log.length <= 4096 ? { outputFile: log } : {}), ...(call.daemon ? { awaited: false } : {}) });
  }

  end(session, waitId, state) {
    if (!session.tasks.delete(waitId)) return;
    this.send({ sessionId: session.id, waitId, state });
    this.watch(session);
  }

  // New sub-agents are told as waiting, and not awaited: the session is at rest with them running (agy 1.5.15 sends nothing when one has
  // done: its last report leaves the record ALIVE). Those the system says are idle, or whose record says KILLED, are ended. A message of
  // a child that is not that idle note (progress, a question, a report), and a state not seen before, say nothing of its end. What goes
  // wrong with one record is skipped with that record.
  follow(session) {
    const found = children(session.dir);
    const idle = idled(session.dir, session.seen);
    for (const [id, record] of found) {
      if (session.known.has(id)) continue;
      session.known.add(id);
      if (record.state !== ALIVE) continue;
      try {
        const { role, typeName } = record.subagentDescriptor ?? {};
        const detail = launch(join(this.brain, id, '.system_generated'), session.id);
        this.send({ sessionId: session.id, waitId: id, kind: 'subagent', state: 'waiting', awaited: false, title: ([role, typeName].find(name => typeof name === 'string' && name) ?? id).slice(0, 500), childSessionId: id,
          ...(detail ? { detail: detail.slice(0, 4000) } : {}) });
        session.live.add(id);
      } catch { /* this record only */ }
    }
    for (const id of [...session.live]) {
      const state = found.get(id)?.state;
      if (idle.has(id)) this.finishChild(session, id, 'done');
      else if (state === KILLED) this.finishChild(session, id, 'cancelled');
    }
  }

  finishChild(session, id, state) {
    session.live.delete(id);
    this.send({ sessionId: session.id, waitId: id, state });
  }
}
