// The Codex entry (plugins/codex/agent/reviews.mjs): Codex's own check of a call, a call of its own to codex-acp, reaches Coda
// as that call's review (docs/agent-protocol.md「工具调用的审核」).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexReviews } from '../../../plugins/codex/agent/reviews.mjs';
import { explain, schemas } from '../../../check/schema.mjs';

const update = (sessionId, u) => ({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: u } });
// As codex-acp 1.12.0 says a check: started, then completed, the event itself as the call's input or output.
const event = (reviewId, targetItemId, review, action = { type: 'command', source: 'unifiedExec', command: '/bin/zsh -lc "rm -rf ../build"', cwd: '/w' }) =>
  ({ threadId: 'root', turnId: 'turn', reviewId, targetItemId, decisionSource: 'agent', review, action });
const started = (sessionId, e) => update(sessionId, { sessionUpdate: 'tool_call', toolCallId: `guardian_assessment:${e.reviewId}`, kind: 'think',
  title: 'Guardian Review', status: 'in_progress', content: [{ type: 'content', content: { type: 'text', text: 'Status: In progress' } }], rawInput: e });
const completed = (sessionId, e) => update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: `guardian_assessment:${e.reviewId}`,
  status: e.review.status === 'approved' ? 'completed' : 'failed', content: [], rawOutput: e });
// What reaches Coda is ACP's.
const updates = messages => messages.map(m => {
  const parsed = schemas.zSessionNotification.safeParse(m.params);
  assert.ok(parsed.success, parsed.success || explain(parsed.error, m.params));
  return m.params.update;
});

test('a check of a call codex-acp told of already is an update of that call', () => {
  const reviews = new CodexReviews();
  const said = [
    update('root', { sessionUpdate: 'tool_call', toolCallId: 'mcp-1', title: 'mcp.coda.workflow_run', kind: 'execute', status: 'pending' }),
    started('root', event('a', 'mcp-1', { status: 'inProgress', riskLevel: null, userAuthorization: null, rationale: null })),
    completed('root', event('a', 'mcp-1', { status: 'approved', riskLevel: 'medium', userAuthorization: 'high', rationale: '用户要求跑这个流程' })),
  ].flatMap(message => reviews.fromAgent(message));
  assert.deepEqual(updates(said), [
    { sessionUpdate: 'tool_call', toolCallId: 'mcp-1', title: 'mcp.coda.workflow_run', kind: 'execute', status: 'pending' },
    { sessionUpdate: 'tool_call_update', toolCallId: 'mcp-1', _meta: { coda: { review: { state: 'reviewing' } } } },
    { sessionUpdate: 'tool_call_update', toolCallId: 'mcp-1', _meta: { coda: { review: { state: 'approved', reason: '用户要求跑这个流程', risk: 'medium' } } } },
  ]);
  assert.ok(said.every(m => m.params.sessionId === 'root'));
});

test('a check that begins before the call is told tells it, pending; codex-acp telling it later updates it', () => {
  const reviews = new CodexReviews();
  const said = [
    started('root', event('b', 'exec-1', { status: 'inProgress' })),
    completed('root', event('b', 'exec-1', { status: 'timedOut', riskLevel: 'high', rationale: '  ' })),
    update('root', { sessionUpdate: 'tool_call', toolCallId: 'exec-1', title: 'rm -rf ../build', kind: 'execute', status: 'failed', rawInput: { command: 'rm -rf ../build' } }),
    update('root', { sessionUpdate: 'tool_call_update', toolCallId: 'exec-1', status: 'failed' }),
    // The same call id in another session is another call.
    started('child', event('c', 'exec-1', { status: 'inProgress' }, { type: 'execve', source: 'shell', program: 'ls', argv: ['ls', '-la'], cwd: '/w' })),
  ].flatMap(message => reviews.fromAgent(message));
  assert.deepEqual(updates(said), [
    { sessionUpdate: 'tool_call', toolCallId: 'exec-1', _meta: { coda: { review: { state: 'reviewing' } } }, title: '/bin/zsh -lc "rm -rf ../build"', kind: 'execute', status: 'pending' },
    { sessionUpdate: 'tool_call_update', toolCallId: 'exec-1', _meta: { coda: { review: { state: 'denied', risk: 'high' } } } },
    { sessionUpdate: 'tool_call_update', toolCallId: 'exec-1', title: 'rm -rf ../build', kind: 'execute', status: 'failed', rawInput: { command: 'rm -rf ../build' } },
    { sessionUpdate: 'tool_call_update', toolCallId: 'exec-1', status: 'failed' },
    { sessionUpdate: 'tool_call', toolCallId: 'exec-1', _meta: { coda: { review: { state: 'reviewing' } } }, title: 'ls -la', kind: 'execute', status: 'pending' },
  ]);
});

test('a check that names no call, and everything else, passes as codex-acp said it', () => {
  const reviews = new CodexReviews();
  const unnamed = started('root', { ...event('d', null, { status: 'inProgress' }) });
  const others = [unnamed, update('root', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '好' } }),
    { jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn' } }];
  assert.deepEqual(others.flatMap(message => reviews.fromAgent(message)), others);
});

test('a check of another kind of action, begun before its call is told, tells the call with a title ACP takes', () => {
  const reviews = new CodexReviews();
  const actions = [
    [{ type: 'requestPermissions', reason: null, permissions: {} }, '申请更多权限'],
    [{ type: 'requestPermissions', reason: '需要写入 ~/.npm', permissions: {} }, '需要写入 ~/.npm'],
    [{ type: 'applyPatch', cwd: '/w', files: ['/w/a.txt'] }, '修改 /w/a.txt', 'edit'],
    [{ type: 'applyPatch', cwd: '/w', files: ['/w/a.txt', '/w/b.txt'] }, '修改 2 个文件', 'edit'],
    [{ type: 'networkAccess', target: '', host: 'registry.npmjs.org', protocol: 'https', port: 443 }, '访问 registry.npmjs.org', 'fetch'],
    [{ type: 'mcpToolCall', server: 'coda', toolName: 'send', connectorId: null, connectorName: null, toolTitle: null }, 'MCP send（coda）'],
    [{ type: 'writeStdin', processId: '42', chars: 'y' }, '向进程 42 写入输入', 'execute'],
    [{ type: 'unheardOf' }, '待审核的操作'],
  ];
  const said = updates(actions.flatMap(([action], index) => reviews.fromAgent(started('root', event(`r${index}`, `item-${index}`, { status: 'inProgress' }, action)))));
  assert.deepEqual(said.map(u => [u.sessionUpdate, u.title, u.kind]), actions.map(([, title, kind]) => ['tool_call', title, kind]));
});
