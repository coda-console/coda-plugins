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

// The steps of a turn: the user's input, the model's answer, and the upstream errors agy writes as SYSTEM / ERROR_MESSAGE steps. The two
// error texts and the shape of the permission denial (a GENERIC step with status ERROR, which ended a real session) are real ones.
const AT = '2026-11-17T06:50:04Z';
export const UNAVAILABLE = 'API error (attempt 1): UNAVAILABLE (code 503): No capacity available for model gemini-4-carbon-high on the server';
export const TIMEOUT = 'API error (attempt 3): request failed: stream idle timeout (5m0s): context deadline exceeded';
export const input = n => ({ step_index: n, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: AT, content: '<USER_REQUEST>\nrun the checks\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-17T14:46:12+08:00.\n</ADDITIONAL_METADATA>' });
export const answer = n => ({ step_index: n, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: AT, model: 'gemini-4-carbon-high', input_tokens: 278526, cache_read_tokens: 0, output_tokens: 763, content: 'The checks pass.' });
export const apiError = (n, error = UNAVAILABLE) => ({ step_index: n, source: 'SYSTEM', type: 'ERROR_MESSAGE', status: 'DONE', error, created_at: AT });
export const denied = n => ({ step_index: n, source: 'MODEL', type: 'GENERIC', status: 'ERROR', created_at: AT, content: 'Created At: 2026-11-16T18:57:09+08:00\nCompleted At: 2026-11-16T18:57:09+08:00',
  error: 'permission check failed for mcp "probe_unique/probe_echo": user denied permission for mcp(probe_unique/probe_echo)\nDo not attempt to circumvent this denial.' });

// The files of agy 1.5.15 about the sub-agents of a session (shaped as the real ones of a session that started five research sub-agents
// were; the ids are kept, the texts and paths are shortened): subagents/<child>.json, and the messages of the inboxes.
export const CHILD = 'e6ba51f9-78ab-4939-b20f-8c571ac825f8';
export const ROLE = 'Protocol & Skew Auditor';
export const PROMPT = 'You are auditing the protocol and version-skew compatibility between v0.3.33 and HEAD. Use read_file and grep_search only.';
export const record = (state = 'SUBAGENT_STATE_ALIVE', id = CHILD) => ({ conversationId: id, subagentDescriptor: { typeName: 'research', role: ROLE }, state, spawnStepIndex: 37, workspaceUris: ['file:///work'] });
const tool = (conversationId, name, id, args) => ({ tool: { conversationId, stepIndex: 33, toolCall: { id, name, argumentsJson: JSON.stringify(args) } } });
export const launched = (parent = S) => ({ id: '30de1bb0-922a-4aa3-8563-382096d1c3d6', recipient: CHILD, sender: parent, priority: 'MESSAGE_PRIORITY_HIGH', timestamp: '2026-11-21T08:07:29.533606Z',
  renderDetails: { messageTitle: 'Message from Parent Agent' }, content: PROMPT, sourceMetadata: tool(parent, 'invoke_subagent', 'call_1205125400927200966', { Prompt: PROMPT, Role: ROLE }) });
export const reported = (n = 1, from = CHILD, content = '# Protocol & Version-Skew Compatibility Audit\n\n## Executive Summary\n\nNo breaking change.') => ({ id: `0000000${n}-ffff-4b4b-8cc3-bd7bd42e3d9b`, recipient: S, sender: from, priority: 'MESSAGE_PRIORITY_HIGH', timestamp: '2026-11-21T08:23:50.222165Z',
  renderDetails: { messageTitle: `Message from ${ROLE} (research)` }, content, sourceMetadata: tool(from, 'send_message', 'call_22613045560459048', { Message: 'x', Recipient: S }) });
export const idle = (n = 2, id = CHILD) => ({ id: `0000000${n}-ffff-4b4b-8cc3-bd7bd42e3d9b`, recipient: S, sender: 'system', priority: 'MESSAGE_PRIORITY_HIGH', timestamp: '2026-11-21T08:18:14.141220Z',
  content: `Subagent ${id} has gone idle. This was the subagent's most recent response: Waiting for the exported diff files from parent.` });
// What a command that finished leaves in the same inbox: from `<session>/task-N`, no child's.
export const taskResult = (n = 3) => ({ id: `0000000${n}-ffff-4b4b-8cc3-bd7bd42e3d9b`, recipient: S, sender: `${S}/task-${n}`, priority: 'MESSAGE_PRIORITY_HIGH', timestamp: '2026-11-21T08:05:34.272979Z',
  content: `Task id "${S}/task-${n}" finished with result:\nCommand exited with code 0.`, sourceMetadata: tool(S, 'run_command', 'call_8139280161351875403', { CommandLine: 'ls' }) });
