import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolCallFields, toolResultContent } from '../../../plugins/claude/agent/tools.mjs';
import { permissionRequest } from '../../../plugins/claude/agent/permissions.mjs';

test('native tools have ACP kinds, including background commands, legacy names and task plans', () => {
  const groups = {
    execute: ['Bash', 'BashOutput', 'KillBash', 'KillShell', 'TaskOutput', 'TaskStop', 'Monitor'],
    read: ['Read', 'NotebookRead'], edit: ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'],
    search: ['Grep', 'Glob', 'LS'], fetch: ['WebFetch', 'WebSearch'],
    think: ['TodoWrite', 'EnterPlanMode', 'ExitPlanMode', 'TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList', 'ReportFindings', 'ProposeGoal'],
    other: ['Task', 'Agent', 'mcp__server__Bash', 'mcp__server__Edit', 'UnknownTool', 'toString', 'AskUserQuestion', 'Skill',
      'ListMcpResources', 'RefreshMcpTools', 'Mcp', 'ReadMcpResourceDir', 'ReadMcpResource', 'SendFeedback', 'ClaudeDesign',
      'Projects', 'Workflow', 'CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup', 'RemoteTrigger', 'ShowOnboardingRolePicker',
      'OfferChromeSetup', 'ReadNotifications', 'ProposeSkills', 'Artifact', 'PushNotification', 'EnterWorktree', 'ExitWorktree'],
  };
  for (const [kind, names] of Object.entries(groups)) for (const name of names) {
    assert.deepEqual(toolCallFields(name, {}), { title: name, kind, rawInput: {} }, name);
  }
});

test('titles show the command, pattern, query or URL on one bounded line; input stays intact', () => {
  const cases = [
    ['Bash', { command: 'git status --short\nprintf done', description: 'a description' }, 'git status --short'],
    ['Monitor', { command: 'tail -f app.log' }, 'tail -f app.log'],
    ['Grep', { pattern: 'tool_call', path: '/repo' }, 'tool_call'],
    ['Glob', { pattern: '**/*.swift' }, '**/*.swift'], ['LS', { path: '/repo' }, '/repo'],
    ['WebFetch', { url: 'https://example.com', prompt: 'summarize' }, 'https://example.com'],
    ['WebSearch', { query: 'ACP tool calls' }, 'ACP tool calls'],
    ['Bash', { command: 'x'.repeat(201) }, `${'x'.repeat(199)}…`],
    ['Bash', { command: '😀'.repeat(201) }, `${'😀'.repeat(199)}…`],
    ['Bash', { command: 'pwd\r\nls' }, 'pwd'], ['Bash', { command: 'pwd\rls' }, 'pwd'],
    ['TaskStop', { task_id: 'bg-1' }, 'TaskStop'],
    ['Agent', { command: 'ls', file_path: '/x' }, 'Agent'],
  ];
  for (const [name, input, title] of cases) {
    Object.freeze(input);
    const fields = toolCallFields(name, input);
    assert.equal(fields.title, title);
    assert.strictEqual(fields.rawInput, input);
  }
});

test('file tools name their locations; Read offsets are one-based and never invented from a limit', () => {
  for (const name of ['Read', 'Edit', 'MultiEdit', 'Write', 'NotebookRead', 'NotebookEdit']) {
    const notebook = name.startsWith('Notebook'), path = notebook ? '/work/book.ipynb' : '/work/Foo.swift';
    const fields = toolCallFields(name, { [notebook ? 'notebook_path' : 'file_path']: path });
    assert.deepEqual(fields.locations, [{ path }]);
    assert.equal(fields.title, `${fields.kind === 'read' ? '读取' : '编辑'} ${path}`);
  }
  for (const offset of [0, 1, 42]) assert.deepEqual(toolCallFields('Read', { file_path: '/x', offset }).locations, [{ path: '/x', line: Math.max(1, offset) }]);
  for (const offset of [undefined, -1, 1.5, '42', Infinity, NaN]) assert.deepEqual(toolCallFields('Read', { file_path: '/x', offset, limit: 10 }).locations, [{ path: '/x' }]);
  assert.equal(toolCallFields('mcp__server__Read', { file_path: '/x' }).locations, undefined);
});

test('Edit, MultiEdit and Write add exact diffs without losing supplied content or empty strings', () => {
  const result = Object.freeze({ type: 'content', content: { type: 'text', text: 'saved' } });
  const content = Object.freeze([result]);
  const edits = Object.freeze([
    Object.freeze({ old_string: 'before\n', new_string: 'after\n', replace_all: true }),
    Object.freeze({ old_string: '', new_string: 'added' }),
    Object.freeze({ old_string: 'removed', new_string: '' }),
  ]);
  const diffs = edits.map(edit => ({ type: 'diff', path: '/x', oldText: edit.old_string, newText: edit.new_string }));
  const input = Object.freeze({ file_path: '/x', edits });
  const multi = toolCallFields('MultiEdit', input, content);
  assert.deepEqual(multi.content, [...diffs, result]);
  assert.strictEqual(multi.rawInput, input);
  assert.strictEqual(multi.content.at(-1), result);
  for (const [i, edit] of edits.entries()) assert.deepEqual(toolCallFields('Edit', { file_path: '/x', ...edit }, content).content, [diffs[i], result]);
  for (const value of ['', 'new file\n']) assert.deepEqual(toolCallFields('Write', { file_path: '/x', content: value }, content).content,
    [{ type: 'diff', path: '/x', oldText: null, newText: value }, result]);
  assert.equal(toolCallFields('NotebookEdit', { notebook_path: '/x', new_source: 'cell source' }).content, undefined, 'cell source is not a whole notebook diff');
});

test('missing or malformed fields retain the raw input without creating invalid locations or diffs', () => {
  for (const name of ['Bash', 'Read', 'Edit', 'MultiEdit', 'Write', 'WebFetch']) for (const input of [undefined, null, {}, [], 'input', { file_path: 42, command: 12 }]) {
    const fields = toolCallFields(name, input);
    assert.equal(fields.title, name);
    assert.strictEqual(fields.rawInput, input);
    assert.equal(fields.locations, undefined);
    assert.equal(fields.content, undefined);
  }
  assert.equal(toolCallFields('Edit', { file_path: '/x', old_string: null, new_string: 'new' }).content, undefined);
  assert.equal(toolCallFields('Write', { file_path: '/x', content: 42 }).content, undefined);
  assert.equal(toolCallFields('MultiEdit', { file_path: '/x', edits: [null, {}, { old_string: 'old' }] }).content, undefined);
});

test('permission cards include the diff and the reason, and allowing preserves the original input', () => {
  const input = Object.freeze({ file_path: '/x', old_string: 'old', new_string: 'new' });
  const { params, answer } = permissionRequest({ sessionId: 'session', toolName: 'Edit', input, context: { toolUseID: 'edit-1', decisionReason: 'outside cwd' } });
  assert.deepEqual(params.toolCall, {
    toolCallId: 'edit-1', status: 'pending', title: '编辑 /x', kind: 'edit', rawInput: input, locations: [{ path: '/x' }],
    content: [{ type: 'diff', path: '/x', oldText: 'old', newText: 'new' }, { type: 'content', content: { type: 'text', text: 'outside cwd' } }],
  });
  assert.strictEqual(answer({ outcome: { outcome: 'selected', optionId: 'allow-once' } }).updatedInput, input);
});

test('Write completion replaces a creation preview with the actual overwritten file and accepted content', () => {
  const preview = toolCallFields('Write', { file_path: '/x', content: 'proposed\n' }).content;
  const text = { type: 'content', content: { type: 'text', text: 'saved' } };
  const result = { type: 'update', filePath: '/x', originalFile: 'a\nb\n', content: 'a\nc\n', structuredPatch: [], userModified: true };
  assert.deepEqual(toolResultContent('Write', [...preview, text], result), [
    { type: 'diff', path: '/x', oldText: 'a\nb\n', newText: 'a\nc\n' }, text,
  ]);
  assert.deepEqual(toolResultContent('Write', preview, { ...result, type: 'create', originalFile: null }), [
    { type: 'diff', path: '/x', oldText: null, newText: 'a\nc\n' },
  ]);
  assert.deepEqual(toolResultContent('Write', preview, { ...result, originalFile: '', content: '' }), [
    { type: 'diff', path: '/x', oldText: '', newText: '' },
  ]);
});

test('Edit replace_all and MultiEdit completion report every actual patch hunk, not one input replacement', () => {
  const preview = toolCallFields('Edit', { file_path: '/x', old_string: 'before', new_string: 'proposed', replace_all: true }).content;
  const result = { filePath: '/x', originalFile: 'before\nmiddle\nbefore\n', replaceAll: true, userModified: true,
    structuredPatch: [
      { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-before', '+accepted'] },
      { oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, lines: ['-before', '+accepted', '\\ No newline at end of file'] },
    ] };
  for (const name of ['Edit', 'MultiEdit']) assert.deepEqual(toolResultContent(name, preview, result), [
    { type: 'diff', path: '/x', oldText: 'before\n', newText: 'accepted\n' },
    { type: 'diff', path: '/x', oldText: 'before\n', newText: 'accepted' },
  ]);
  assert.deepEqual(toolResultContent('Edit', preview, { ...result, structuredPatch: [
    { oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: ['-before', '+accepted', ' middle', '-before', '+accepted'] },
  ] }), [{ type: 'diff', path: '/x', oldText: 'before\nmiddle\nbefore\n', newText: 'accepted\nmiddle\naccepted\n' }]);
});

test('empty or staged actual changes clear previews; a large overwritten file uses its patch when available', () => {
  const preview = toolCallFields('Write', { file_path: '/x', content: 'new\n' }).content;
  const result = { type: 'update', filePath: '/x', originalFile: null, content: 'new\n', structuredPatch: [] };
  assert.deepEqual(toolResultContent('Write', preview, result), [], 'unknown previous contents are not a file creation');
  assert.deepEqual(toolResultContent('Edit', preview, { filePath: '/x', structuredPatch: [] }), []);
  assert.deepEqual(toolResultContent('Write', preview, { ...result, staged: true, originalFile: 'old\n' }), []);
  assert.deepEqual(toolResultContent('Write', preview, { ...result, structuredPatch: [
    { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] },
  ] }), [{ type: 'diff', path: '/x', oldText: 'old\n', newText: 'new\n' }]);
});

test('failed, unstructured or unrelated results retain the last diff without mutating it', () => {
  const content = Object.freeze([{ type: 'diff', path: '/x', oldText: 'old', newText: 'new' }]);
  const result = { filePath: '/x', originalFile: 'old', content: 'accepted', structuredPatch: [] };
  assert.strictEqual(toolResultContent('Write', content, result, true), content);
  assert.strictEqual(toolResultContent('mcp__server__Write', content, result), content);
  for (const value of [undefined, 'saved', {}, { filePath: '/x' }, { filePath: '/x', structuredPatch: [null] }]) {
    assert.strictEqual(toolResultContent('Write', content, value), content);
  }
});

test('structured patches preserve each side\'s final newline, including context and empty files', () => {
  const noNewline = '\\ No newline at end of file';
  const cases = [
    { oldText: 'foo', newText: 'foo\n', lines: ['-foo', noNewline, '+foo'] },
    { oldText: 'foo\n', newText: 'foo', lines: ['-foo', '+foo', noNewline] },
    { oldText: 'foo', newText: 'bar', lines: ['-foo', noNewline, '+bar', noNewline] },
    { oldText: 'foo\n', newText: 'bar\n', lines: ['-foo', '+bar'] },
    { oldText: 'foo\ntail', newText: 'bar\ntail', lines: ['-foo', '+bar', ' tail', noNewline] },
    { oldText: '', newText: 'foo\n', lines: ['+foo'] },
    { oldText: '', newText: 'foo', lines: ['+foo', noNewline] },
    { oldText: 'foo', newText: '', lines: ['-foo', noNewline] },
    { oldText: 'foo\n', newText: 'foo\n\n', lines: [' foo', '+'] },
    { oldText: 'foo\r\n', newText: 'bar\r\n', lines: ['-foo\r', '+bar\r'] },
  ];
  for (const { oldText, newText, lines } of cases) {
    const preview = toolCallFields('Edit', { file_path: '/x', old_string: oldText, new_string: newText }).content;
    const result = { filePath: '/x', structuredPatch: [{ lines }] };
    for (const name of ['Edit', 'MultiEdit', 'Write']) assert.deepEqual(toolResultContent(name, preview, result), [
      { type: 'diff', path: '/x', oldText, newText },
    ], `${name}: ${JSON.stringify({ oldText, newText })}`);
  }
});
