// The commands agy 1.5.15 moves into the background, told to Coda as `_coda/wait` tasks from the session's transcript. The ACP
// updates and the transcript steps are shaped as the real ones of one session were (a run_command with WaitMsBeforeAsync 10000
// that was still running, task-342, until the user stopped it, and the finished and truncated results of other sessions); the
// command and the paths are shortened and made anonymous.
import { pathToFileURL } from 'node:url';

export const S = 'c94a5096-f799-4d8a-be8d-e5623b27ce0c';
export const CALL = 'call_1946860740160464019';
export const COMMAND = "node - <<'EOF'\nimport http from 'node:http';\nconsole.log('captured: mac-light.png');\nEOF";
export const SUMMARY = 'Render friends 0.4.0 view in headless Chrome for visual inspection';

// The updates of that call, in the order agy sent them (journal seq 1303–1310).
export const acp = (sessionUpdate, status, { command = COMMAND, id = CALL, input = {}, ...extra } = {}) => {
  const args = { CommandLine: command, WaitMsBeforeAsync: 10000, toolSummary: SUMMARY, ...input };
  return { sessionUpdate, toolCallId: id, name: 'run_command', args, status, kind: 'execute', title: command, rawInput: args, ...extra };
};
export const stopped = () => acp('tool_call_update', 'failed', {
  rawOutput: { output: 'Command was terminated by signal or canceled.\n\nNo output from the command.', exit_code: -1 },
  content: [{ type: 'content', content: { type: 'text', text: 'Command was terminated by signal or canceled.\n\nNo output from the command.' } }],
});

// The transcript steps (transcript.jsonl, steps 342 and 346).
export const running = (n, description, log) => ({ step_index: n, source: 'MODEL', type: 'GENERIC', status: 'RUNNING', created_at: '2026-11-23T15:54:05Z',
  content: `Created At: 2026-11-23T23:54:05+08:00\nTool is running as a background task with task id: ${S}/task-${n}\nTask Description: ${description}${log ? `\nTask logs are available at: ${pathToFileURL(log)}` : ''}` });
export const message = (n, text) => ({ step_index: n + 4, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', created_at: '2026-11-23T17:59:48Z',
  content: `The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-23T17:59:48Z sender=${S}/task-${n} priority=MESSAGE_PRIORITY_LOW content=Task id "${S}/task-${n}" ${text}\n</SYSTEM_MESSAGE>` });
export const canceled = n => message(n, 'was canceled with result:\nTool execution was canceled\nLog: file:///home/user/x.log');
export const finished = (n, result = 'Command exited with code 0.\n\nCommand output:\ncaptured\r\n') => message(n, `finished with result:\n${result}\nLog: file:///home/user/x.log`);
