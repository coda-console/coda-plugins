// The commands agy 1.5.15 moves into the background, told to Coda as `_coda/wait` tasks from the session's transcript. The ACP
// updates and the transcript steps are shaped as the real ones of one session were (a run_command with WaitMsBeforeAsync 10000
// that was still running, task-342, until the user stopped it, and the finished and truncated results of other sessions); the
// command and the paths are shortened and made anonymous.
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { agentMessageProblem } from '@coda-console/protocol/agent';
import { Background } from '../../../plugins/antigravity/agent/background.mjs';
import { CHILD, COMMAND, CALL, PROMPT, ROLE, S, SUMMARY, TIMEOUT, UNAVAILABLE, acp, answer, apiError, canceled, denied, finished, idle, input, launched, record, reported, running, stopped, taskResult } from './background-fixture.mjs';

// A home with agy's directories of the session, and a Background over it that records what it tells Coda.
export function setup(t, { transcript = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'antigravity-background-'));
  const dir = join(home, '.gemini/antigravity-cli/brain', S, '.system_generated');
  const file = join(dir, 'logs/transcript.jsonl');
  mkdirSync(join(dir, 'logs'), { recursive: true }); mkdirSync(join(dir, 'tasks'));
  if (transcript) writeFileSync(file, '');
  const sent = [];
  const background = new Background({ send: params => sent.push(params), home });
  t.after(() => { background.closeAll(); rmSync(home, { recursive: true, force: true }); });
  const log = n => { const path = join(dir, 'tasks', `task-${n}.log`); writeFileSync(path, ''); return path; };
  const append = (...steps) => { for (const step of steps) appendFileSync(file, `${JSON.stringify(step)}\n`); background.scan(S); };
  const start = (updates = [acp('tool_call', 'in_progress')]) => { for (const update of updates) background.observe(S, update); };
  return { home, dir, file, sent, background, log, append, start };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('a command agy moves into the background is told to Coda as a task: the command, its log, tied to the call', t => {
  const { sent, start, append, log } = setup(t);
  start([acp('tool_call', 'in_progress'), acp('tool_call_update', 'pending'), acp('tool_call_update', 'in_progress')]);
  assert.deepEqual(sent, [], 'nothing is known of it from ACP');
  const path = log(342);
  append(running(342, COMMAND, path));
  assert.deepEqual(sent, [{ sessionId: S, waitId: `${S}/task-342`, kind: 'task', state: 'waiting', toolCallId: CALL, title: SUMMARY, detail: COMMAND, outputFile: path }]);
  for (const params of sent) assert.equal(agentMessageProblem('_coda/wait', params), null);
});

test('the task ends as the transcript says: done, failed by its exit code, cancelled', t => {
  const { sent, start, append } = setup(t);
  const commands = [['sleep 1', 'one'], ['sleep 2', 'two'], ['sleep 3', 'three'], ['sleep 4', 'four']];
  start(commands.map(([command], i) => acp('tool_call', 'in_progress', { command, id: `call_${i}` })));
  commands.forEach(([command], i) => append(running(10 + i, command)));
  assert.equal(sent.length, 4);
  append(finished(10), finished(11, 'Command exited with code 2.\n\nCommand output:\nboom\r\n'), canceled(12),
    finished(13, "The tool's output was truncated due to being too long. You can find the full output in a file at file:///home/user/output.txt.\n\nHere is a preview with the middle of the output truncated:\nCommand exited with code 1.\n\nCommand output:\nx"));
  assert.deepEqual(sent.slice(4).map(({ waitId, state }) => [waitId, state]), [[`${S}/task-10`, 'done'], [`${S}/task-11`, 'failed'], [`${S}/task-12`, 'cancelled'], [`${S}/task-13`, 'failed']]);
  append(finished(10), canceled(10));
  assert.equal(sent.length, 8, 'an ended task is not told again');
});

test('the user stopping the turn: the card fails with exit code -1 and the task is told cancelled, after the card', async t => {
  const { sent, start, append, background } = setup(t);
  start();
  append(running(342, COMMAND));
  background.observe(S, stopped());
  assert.equal(sent.length, 1, 'after the update the entry forwards');
  await settle();
  assert.deepEqual(sent.at(-1), { sessionId: S, waitId: `${S}/task-342`, state: 'cancelled' });
  append(canceled(342));
  assert.equal(sent.length, 2, 'the transcript saying it too changes nothing');
});

test('the card ending on its own ends the task by its exit code: 0 done, -1 cancelled, any other failed, whichever status says it', async t => {
  const { sent, start, append, background } = setup(t);
  const ends = [['completed', 0, 'done'], ['completed', 2, 'failed'], ['completed', -1, 'cancelled'], ['failed', 2, 'failed'], ['failed', -1, 'cancelled'], ['failed', undefined, 'failed'], ['completed', undefined, 'done']];
  start(ends.map((_, i) => acp('tool_call', 'in_progress', { command: `job ${i}`, id: `c${i}` })));
  ends.forEach((_, i) => append(running(i + 1, `job ${i}`)));
  ends.forEach(([status, code], i) => background.observe(S, acp('tool_call_update', status, { id: `c${i}`, command: `job ${i}`, rawOutput: { output: 'x', ...(code === undefined ? {} : { exit_code: code }) } })));
  await settle();
  assert.deepEqual(sent.slice(ends.length).map(({ state }) => state), ends.map(([, , state]) => state));
});

test('IsDaemon: a server left running is told as a task that is not waited for, tied to its card, which is left as agy says it; a command that is waited for says nothing of it', t => {
  const { sent, start, append } = setup(t);
  start([acp('tool_call', 'in_progress', { command: 'npm run dev', id: 'd', input: { IsDaemon: true } }), acp('tool_call', 'in_progress', { command: 'npm test', id: 'w', input: { IsDaemon: false } })]);
  append(running(5, 'npm run dev'), running(6, 'npm test'));
  assert.equal(sent[0].awaited, false);
  assert.equal('awaited' in sent[1], false);
  assert.deepEqual(sent.map(params => params.toolCallId), ['d', 'w']);
});

test('a step cut in its middle is told by the two ends of its command; without the log line the layout of agy gives the log, and a log that is not there tells no output file', t => {
  const { sent, start, append, log } = setup(t);
  const long = `echo start ${'x'.repeat(3000)} end`;
  start([acp('tool_call', 'in_progress', { command: long }), acp('tool_call', 'in_progress', { command: `${long.slice(0, 40)} other`, id: 'other' })]);
  const step = running(7, `${long.slice(0, 100)}\n<truncated 2900 bytes>\n${long.slice(-100)}`);
  append(step);
  assert.deepEqual([sent[0].detail, sent[0].toolCallId, 'outputFile' in sent[0]], [long, CALL, false], 'log 7 is not there');
  start([acp('tool_call', 'in_progress', { command: 'sleep 9', id: 'n' })]);
  const path = log(8);
  append(running(8, 'sleep 9'));
  assert.equal(sent[1].outputFile, path);
});

test('a task belongs to the call whose whole command it is: sleep 1 is not sleep 10, whichever is older', t => {
  const { sent, start, append } = setup(t);
  start([acp('tool_call', 'in_progress', { command: 'sleep 10', id: 'ten' }), acp('tool_call', 'in_progress', { command: 'sleep 1', id: 'one' })]);
  append(running(1, 'sleep 1'));
  assert.deepEqual(sent.map(params => params.toolCallId), ['one']);
  append(running(2, 'sleep 10'));
  assert.deepEqual(sent.map(params => params.toolCallId), ['one', 'ten']);
  start([acp('tool_call', 'in_progress', { command: 'sleep', id: 'bare' })]);
  append(running(3, 'sleep 1000'));
  assert.equal(sent.length, 2, 'a description that only begins like a command is not it');
});

test('two open calls that fit a task: it is registered for neither, and stays plain ACP', t => {
  const { sent, start, append } = setup(t);
  start([acp('tool_call', 'in_progress', { id: 'first' }), acp('tool_call', 'in_progress', { id: 'second' })]);
  append(running(1, COMMAND));
  const long = `echo start ${'x'.repeat(3000)} end`;
  start([acp('tool_call', 'in_progress', { command: long, id: 'l1' }), acp('tool_call', 'in_progress', { command: long, id: 'l2' })]);
  append(running(2, `${long.slice(0, 100)}\n<truncated 2900 bytes>\n${long.slice(-100)}`));
  assert.deepEqual(sent, []);
});

test('what does not belong to an open call is not told: another command, a call that ended, a quoted step, a step from before', t => {
  const { sent, start, append, background, dir } = setup(t);
  appendFileSync(join(dir, 'logs/transcript.jsonl'), `${JSON.stringify(running(100, COMMAND))}\n`);
  start();
  append(running(1, 'ls -la'));
  append({ ...running(2, COMMAND), source: 'MODEL', status: 'DONE' }, { ...running(3, COMMAND), source: 'USER_EXPLICIT' });
  background.observe(S, acp('tool_call_update', 'completed', { rawOutput: { output: 'ok', exit_code: 0 } }));
  append(running(4, COMMAND));
  start([acp('tool_call', 'completed', { id: 'late' })]);
  append(running(5, COMMAND));
  assert.deepEqual(sent, []);
});

test('a step that quotes a finished task is not its end', t => {
  const { sent, start, append } = setup(t);
  start();
  append(running(342, COMMAND));
  append({ ...finished(342), source: 'MODEL', type: 'GENERIC' });
  assert.equal(sent.length, 1);
});

test('without a transcript, with one that is not readable, or with steps of another shape, the call is plain ACP and nothing is thrown', t => {
  const missing = setup(t, { transcript: false });
  missing.start();
  missing.background.scan(S); missing.background.scan('another');
  const locked = setup(t);
  locked.start();
  locked.append(running(1, COMMAND));
  chmodSync(locked.file, 0o000);
  locked.background.scan(S);
  const odd = setup(t);
  odd.start();
  appendFileSync(odd.file, 'not json\n[1]\n{"content":5}\nnull\n{"source":"MODEL","status":"RUNNING","content":"Tool is running as a background task with task id: x"}\n');
  odd.background.scan(S);
  odd.append({ ...running(1, COMMAND), content: 'Tool is running as a background task' });
  assert.deepEqual([missing.sent, odd.sent], [[], []]);
  assert.equal(locked.sent.length, 1, 'the one it read before the file closed to it');
});

test('a transcript that appears after the call is read from its start; a step still being written is read when it is whole, multibyte text too', t => {
  const { sent, start, file, background } = setup(t, { transcript: false });
  const command = 'echo 好友 名片';
  start([acp('tool_call', 'in_progress', { command })]);
  const bytes = Buffer.from(`${JSON.stringify(running(1, command))}\n`);
  const cut = bytes.indexOf(Buffer.from('好')) + 1;
  writeFileSync(file, bytes.subarray(0, cut));
  background.scan(S);
  assert.deepEqual(sent, []);
  appendFileSync(file, bytes.subarray(cut));
  background.scan(S);
  assert.equal(sent[0]?.detail, command);
});

test('the session ending, or agy ending, ends what is still in the background as cancelled, and then nothing more is told', t => {
  const { sent, start, append, background } = setup(t);
  start([acp('tool_call', 'in_progress'), acp('tool_call', 'in_progress', { command: 'make', id: 'b' })]);
  append(running(1, COMMAND), running(2, 'make'));
  background.closeSession(S);
  assert.deepEqual(sent.slice(2).map(({ waitId, state }) => [waitId, state]), [[`${S}/task-1`, 'cancelled'], [`${S}/task-2`, 'cancelled']]);
  background.closeSession(S); background.closeAll(); background.scan(S);
  append(finished(1));
  assert.equal(sent.length, 4);
});

// The turn that ACP ends with end_turn, and what its last step in the transcript says.
const turn = (t, ...steps) => {
  const c = setup(t);
  c.background.begin(S);
  c.append(...steps);
  return c;
};

test('end_turn with an upstream error as the last step since the prompt is a failure: its text, however many steps came before', t => {
  const { background } = turn(t, input(1), answer(2), apiError(3), apiError(4, TIMEOUT));
  assert.equal(background.finish(S, true), TIMEOUT);
  const second = turn(t, input(1), { ...apiError(2), error: `  ${UNAVAILABLE}\n` });
  assert.equal(second.background.finish(S, true), UNAVAILABLE, 'trimmed');
});

test('a turn that ends well is not a failure: an answer last, an error agy got over, a denied tool, a stop, another step, an error with no text', t => {
  assert.equal(turn(t, input(1), answer(2)).background.finish(S, true), null, 'the answer is last');
  assert.equal(turn(t, input(1), apiError(2), answer(3)).background.finish(S, true), null, 'agy retried and the model answered');
  assert.equal(turn(t, input(1), denied(2)).background.finish(S, true), null, 'a tool call with an error is not an upstream error');
  assert.equal(turn(t, input(1), apiError(2)).background.finish(S, false), null, 'the turn was stopped or refused, not ended');
  assert.equal(turn(t, input(1), { ...apiError(2), source: 'MODEL' }).background.finish(S, true), null);
  assert.equal(turn(t, input(1), { ...apiError(2), type: 'SYSTEM_MESSAGE' }).background.finish(S, true), null);
  assert.equal(turn(t, input(1), { ...apiError(2), error: undefined }).background.finish(S, true), null);
  assert.equal(turn(t, input(1), apiError(2, '  ')).background.finish(S, true), null);
});

test('only the steps since the prompt count: the error of an earlier turn is not this turn\'s, nor is a session not seen', t => {
  const { background, append, dir } = setup(t);
  appendFileSync(join(dir, 'logs/transcript.jsonl'), `${JSON.stringify(apiError(1))}\n`);
  background.begin(S);
  assert.equal(background.finish(S, true), null, 'written before the first prompt');
  background.begin(S);
  append(input(2), apiError(3));
  assert.equal(background.finish(S, true), UNAVAILABLE);
  background.begin(S);
  assert.equal(background.finish(S, true), null, 'a turn that wrote nothing has no step of its own');
  assert.equal(background.finish('another', true), null);
});

test('an error that arrives between prompts is not carried into the next turn', t => {
  const { background, append } = setup(t);
  background.begin(S);
  assert.equal(background.finish(S, true), null);
  append(apiError(1));
  background.begin(S);
  append(answer(2));
  assert.equal(background.finish(S, true), null);
});

test('an error is the turn\'s only after the turn\'s user input: one of the turn before, written once the prompt began, is not', t => {
  const late = setup(t);
  late.background.begin(S);
  late.append(apiError(1));
  assert.equal(late.background.finish(S, true), null, 'the 503 of the turn before, and this turn wrote and said nothing');
  const stale = setup(t);
  stale.background.begin(S);
  stale.append(apiError(1), input(2));
  assert.equal(stale.background.finish(S, true), null, 'the input is the last step');
  const own = setup(t);
  own.background.begin(S);
  own.append(apiError(1), input(2), apiError(3));
  assert.equal(own.background.finish(S, true), UNAVAILABLE, 'the turn\'s own, after its input');
  own.background.begin(S);
  own.append(input(4), answer(5));
  assert.equal(own.background.finish(S, true), null);
});

test('a turn that said something on ACP, or a late error: not a failure, whichever way the transcript lags', t => {
  // The error agy got over is the last step it has written so far, or the one of the turn before is written after this prompt began.
  const text = turn(t, input(1), apiError(2));
  text.background.spoke(S);
  assert.equal(text.background.finish(S, true), null, 'a reply text went out');
  const tool = setup(t);
  tool.background.begin(S);
  tool.background.spoke(S);
  tool.append(apiError(1));
  assert.equal(tool.background.finish(S, true), null, 'a tool that succeeded, and an error written only now');
  tool.background.begin(S);
  tool.append(input(2), apiError(3));
  assert.equal(tool.background.finish(S, true), UNAVAILABLE, 'the next turn said nothing: it is read again from the start');
});

test('no transcript, one that cannot be read, or steps of another shape: no failure, nothing thrown, and the next prompt is as before', t => {
  const missing = setup(t, { transcript: false });
  missing.background.begin(S);
  assert.equal(missing.background.finish(S, true), null);
  const locked = setup(t);
  locked.background.begin(S);
  locked.append(apiError(1));
  appendFileSync(locked.file, `${JSON.stringify(answer(2))}\n`);
  chmodSync(locked.file, 0o000);
  assert.equal(locked.background.finish(S, true), null, 'the error read earlier is not enough when the read at the end fails: the answer may be behind it');
  const odd = setup(t);
  odd.background.begin(S);
  appendFileSync(odd.file, 'not json\n[1]\nnull\n{"error":5,"source":"SYSTEM","type":"ERROR_MESSAGE"}\n');
  assert.equal(odd.background.finish(S, true), null);
  assert.equal(odd.sent.length, 0);
});

const put = (file, value) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, JSON.stringify(value)); };
const brain = home => join(home, '.gemini/antigravity-cli/brain');
// The files of the sub-agent CHILD of the session: its record and its launch, and what lands in the session's inbox.
const children = (c, file = `${CHILD}.json`) => ({
  record: (value = record(), name = file) => put(join(c.dir, 'subagents', name), value),
  launch: (value = launched()) => put(join(brain(c.home), CHILD, '.system_generated/messages/30de1bb0.json'), value),
  inbox: (name, value) => put(join(c.dir, 'messages', `${name}.json`), value),
});

test('a sub-agent agy starts is told as one that is waited for: its role, its session, the launch as the description', t => {
  const c = setup(t);
  c.background.begin(S);
  const files = children(c);
  files.record(); files.launch();
  c.background.scan(S);
  const [wait] = c.sent;
  assert.deepEqual(wait, { sessionId: S, waitId: CHILD, kind: 'subagent', state: 'waiting', awaited: false, title: ROLE, childSessionId: CHILD, detail: PROMPT });
  assert.equal(agentMessageProblem('_coda/wait', wait), null);
  c.background.scan(S);
  assert.equal(c.sent.length, 1, 'once');
});

test('a sub-agent is found while the prompt is answered, by the clock, and afterwards for as long as it lives', async t => {
  const c = setup(t);
  c.background.interval = 20;
  c.background.begin(S);
  children(c).record();
  const until = async count => { for (let i = 0; i < 100 && c.sent.length < count; i++) await new Promise(resolve => setTimeout(resolve, 20)); };
  await until(1);
  assert.equal(c.sent[0]?.state, 'waiting');
  assert.equal(c.background.finish(S, true), null);
  children(c).inbox('1', idle());
  await until(2);
  assert.deepEqual(c.sent[1], { sessionId: S, waitId: CHILD, state: 'done' });
  assert.equal(c.background.sessions.get(S).timer, null, 'nothing left to wait for, nothing read');
});

test('a sub-agent ends as done when the system says it is idle, as cancelled when it is killed; what it sends, and what a command leaves, ends nothing', t => {
  const c = setup(t);
  c.background.begin(S);
  const files = children(c);
  files.record(); c.background.scan(S);
  files.inbox('a', taskResult());
  c.background.scan(S);
  assert.equal(c.sent.length, 1, 'a command that finished is not a sub-agent that answered');
  files.inbox('b', reported(1, CHILD, 'Still working: the diff of v0.3.33 is read, the report follows.'));
  c.background.scan(S);
  assert.equal(c.sent.length, 1, 'a child that is alive and says it is still working');
  files.inbox('c', reported());
  c.background.scan(S);
  assert.equal(c.sent.length, 1, 'nor does its report, which is not told from progress');
  files.inbox('d', idle());
  c.background.scan(S);
  files.inbox('e', idle());
  c.background.scan(S);
  assert.deepEqual(c.sent.slice(1), [{ sessionId: S, waitId: CHILD, state: 'done' }], 'once');

  const killed = setup(t);
  killed.background.begin(S);
  const other = children(killed);
  other.record(); killed.background.scan(S);
  other.record(record('SUBAGENT_STATE_KILLED')); killed.background.scan(S);
  assert.deepEqual(killed.sent.slice(1), [{ sessionId: S, waitId: CHILD, state: 'cancelled' }]);
  other.inbox('late', idle()); killed.background.scan(S);
  assert.equal(killed.sent.length, 2);
});

test('a state agy has not been seen to write ends nothing, whether the sub-agent is new or running: only the idle note or KILLED does', t => {
  const c = setup(t);
  c.background.begin(S);
  const files = children(c);
  files.record(); c.background.scan(S);
  files.record(record('SUBAGENT_STATE_IDLE')); c.background.scan(S);
  assert.equal(c.sent.length, 1);
  const other = 'c0ffee00-0000-4000-8000-000000000201';
  files.record(record('SUBAGENT_STATE_FINISHED', other), `${other}.json`); c.background.scan(S);
  assert.equal(c.sent.length, 1, 'a record first seen in a state that is not ALIVE is not told');
  files.inbox('i', idle()); c.background.scan(S);
  assert.deepEqual(c.sent.at(-1), { sessionId: S, waitId: CHILD, state: 'done' });
});

test('the sub-agents and reports from before the first prompt are not told; a record that is already over, or an inbox message not whole yet, are not either', t => {
  const c = setup(t);
  const files = children(c);
  files.record(); files.inbox('old', idle());
  c.background.begin(S);
  c.background.scan(S);
  files.record(record('SUBAGENT_STATE_KILLED', 'c0ffee00-0000-4000-8000-000000000001'), 'c0ffee00-0000-4000-8000-000000000001.json');
  put(join(c.dir, 'subagents', 'c0ffee00-0000-4000-8000-000000000002.json'), { conversationId: 'c0ffee00-0000-4000-8000-000000000002' });
  writeFileSync(join(c.dir, 'subagents', 'c0ffee00-0000-4000-8000-000000000003.json'), '{"conversationId":');
  writeFileSync(join(c.dir, 'subagents', 'notes.txt'), 'x');
  put(join(c.dir, 'subagents', 'c0ffee00-0000-4000-8000-000000000004.json'), record('SUBAGENT_STATE_ALIVE', 'another'));
  c.background.scan(S);
  assert.deepEqual(c.sent, []);
  const live = 'c0ffee00-0000-4000-8000-000000000005';
  files.record(record('SUBAGENT_STATE_ALIVE', live), `${live}.json`);
  writeFileSync(join(c.dir, 'messages', 'half.json'), `{"sender":"${live}"`);
  c.background.scan(S);
  assert.equal(c.sent.length, 1);
  writeFileSync(join(c.dir, 'messages', 'half.json'), JSON.stringify(idle(2, live)));
  c.background.scan(S);
  assert.deepEqual(c.sent[1], { sessionId: S, waitId: live, state: 'done' });
});

test('a sub-agent without a launch message, or without a role, is told all the same; a Coda that takes no _coda/wait is told nothing, and reads no more than the transcript', t => {
  const c = setup(t);
  c.background.begin(S);
  put(join(c.dir, 'subagents', `${CHILD}.json`), { conversationId: CHILD, subagentDescriptor: { typeName: 'research' }, state: 'SUBAGENT_STATE_ALIVE' });
  c.background.scan(S);
  assert.deepEqual(c.sent, [{ sessionId: S, waitId: CHILD, kind: 'subagent', state: 'waiting', awaited: false, title: 'research', childSessionId: CHILD }]);

  const home = mkdtempSync(join(tmpdir(), 'antigravity-background-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const sent = [];
  const background = new Background({ send: params => sent.push(params), home, waits: () => false });
  background.begin(S);
  put(join(brain(home), S, '.system_generated/subagents', `${CHILD}.json`), record());
  background.scan(S);
  assert.deepEqual(sent, []);
  assert.equal(background.sessions.get(S).timer, null);
  background.closeAll();
});

test('the session closing ends a sub-agent still working as cancelled, and then nothing more is told', t => {
  const c = setup(t);
  c.background.begin(S);
  children(c).record();
  c.background.scan(S);
  c.background.closeSession(S);
  assert.deepEqual(c.sent.slice(1), [{ sessionId: S, waitId: CHILD, state: 'cancelled' }]);
  c.background.closeAll(); c.background.scan(S);
  assert.equal(c.sent.length, 2);
});

test('a record with fields of the wrong type is told as well as it can be, or skipped, and the others are told: nothing is thrown', t => {
  const c = setup(t);
  c.background.begin(S);
  const id = n => `c0ffee00-0000-4000-8000-00000000010${n}`;
  const odd = [{ subagentDescriptor: { role: 5, typeName: ['x'] } }, { subagentDescriptor: 'research' }, { subagentDescriptor: null }, { subagentDescriptor: { role: {}, typeName: 'research' } }];
  odd.forEach((fields, n) => put(join(c.dir, 'subagents', `${id(n)}.json`), { conversationId: id(n), state: 'SUBAGENT_STATE_ALIVE', ...fields }));
  put(join(c.dir, 'subagents', `${id(9)}.json`), record('SUBAGENT_STATE_ALIVE', id(9)));
  put(join(c.dir, 'messages', 'odd.json'), 5);
  put(join(c.dir, 'messages', 'odd2.json'), { sender: 'system', content: { text: 'x' } });
  mkdirSync(join(brain(c.home), id(9), '.system_generated/messages'), { recursive: true });
  put(join(brain(c.home), id(9), '.system_generated/messages/odd.json'), [1]);
  c.background.scan(S);
  assert.deepEqual(c.sent.map(({ waitId, title }) => [waitId, title]), [[id(0), id(0)], [id(1), id(1)], [id(2), id(2)], [id(3), 'research'], [id(9), ROLE]]);
  assert.equal(c.sent.every(params => agentMessageProblem('_coda/wait', params) === null), true);
  assert.equal(c.background.finish(S, true), null);
});
