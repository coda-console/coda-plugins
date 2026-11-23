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
// Whatever cannot be read (no file, another shape, a failed read) is skipped without a word: the session goes on as plain ACP.
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const START = /^(?:Created At: [^\n]*\n)?Tool is running as a background task with task id: (\S+)\nTask Description: /;
const END = /<SYSTEM_MESSAGE>\n\[Message\] [^\n]* content=Task id "([^"]+)" (finished|was canceled) with result:\n/;
const CUT = /\n<truncated \d+ bytes>\n/;
const EXIT = /^Command exited with code (-?\d+)\./m;
const TERMINAL = new Set(['completed', 'failed']);

export class Background {
  // `send(params)` writes one `_coda/wait`; `home` is where agy keeps `.gemini`; `interval` is how often the transcript is read.
  constructor({ send, home = homedir(), interval = 1000 }) {
    Object.assign(this, { send, home, interval });
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
    this.watch(session);
    this.sessions.delete(sessionId);
  }

  closeAll() {
    for (const sessionId of [...this.sessions.keys()]) this.closeSession(sessionId);
  }

  // What the transcript has gained since the first call of the session was seen (before that is not this run's).
  scan(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    let text = '';
    try { text = this.read(session); } catch { return; }
    for (const line of text.split('\n')) {
      let step; try { step = JSON.parse(line); } catch { continue; }
      if (typeof step?.content === 'string') this.step(sessionId, session, step);
    }
    this.watch(session);
  }

  open(sessionId) {
    const dir = join(this.home, '.gemini/antigravity-cli/brain', sessionId, '.system_generated');
    const file = join(dir, 'logs/transcript.jsonl');
    let offset = 0; try { offset = statSync(file).size; } catch { /* not there yet: all of it is new */ }
    const session = { id: sessionId, dir, file, offset, rest: Buffer.alloc(0), calls: new Map(), tasks: new Set(), timer: null };
    this.sessions.set(sessionId, session);
    return session;
  }

  // Read while a call or a task is open.
  watch(session) {
    const busy = session.tasks.size > 0 || [...session.calls.values()].some(call => !call.waitId);
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
}
