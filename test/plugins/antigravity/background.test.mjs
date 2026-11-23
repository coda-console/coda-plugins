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
import { COMMAND, CALL, S, SUMMARY, acp, canceled, finished, running, stopped } from './background-fixture.mjs';

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
