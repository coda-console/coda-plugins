// Claude Agent SDK 0.3.296's sdk-tools.d.ts, plus names used by older Claude Code sessions.
// Only native tool names carry these meanings; MCP tools and unknown tools stay `other`.
const kinds = new Map(Object.entries({
  execute: ['Bash', 'BashOutput', 'KillBash', 'KillShell', 'TaskOutput', 'TaskStop', 'Monitor'],
  read: ['Read', 'NotebookRead'],
  edit: ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'],
  search: ['Grep', 'Glob', 'LS'],
  fetch: ['WebFetch', 'WebSearch'],
  think: ['TodoWrite', 'EnterPlanMode', 'ExitPlanMode', 'TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList', 'ReportFindings', 'ProposeGoal'],
}).flatMap(([kind, names]) => names.map(name => [name, kind])));

const string = value => typeof value === 'string';
const firstLine = value => string(value) ? value.split(/\r\n|\r|\n/, 1)[0].trim() : '';
const short = value => { const chars = Array.from(firstLine(value)); return chars.length > 200 ? `${chars.slice(0, 199).join('')}…` : chars.join(''); };

// Pure presentation shared by calls and permission requests. rawInput is the SDK's original object.
// Existing content (e.g. why permission is needed) accompanies the diffs, never replaces them.
export function toolCallFields(name, rawInput, content = []) {
  const input = rawInput ?? {}, kind = kinds.get(name) ?? 'other';
  const path = ['read', 'edit'].includes(kind) ? (input.file_path ?? input.notebook_path) : undefined;
  const hasPath = string(path) && path.length > 0;
  let title = name;
  if (kind === 'execute') title = short(input.command) || name;
  if (kind === 'search') title = short(input.pattern ?? input.query ?? input.path) || name;
  if (kind === 'fetch') title = short(input.url ?? input.query) || name;
  if (hasPath) title = short(`${kind === 'read' ? '读取' : '编辑'} ${path}`);

  const diffs = [];
  if (hasPath) {
    if (name === 'Write' && string(input.content)) diffs.push({ type: 'diff', path, oldText: null, newText: input.content });
    const edits = name === 'Edit' ? [input] : name === 'MultiEdit' && Array.isArray(input.edits) ? input.edits : [];
    for (const edit of edits) {
      if (string(edit?.old_string) && string(edit?.new_string)) diffs.push({ type: 'diff', path, oldText: edit.old_string, newText: edit.new_string });
    }
  }
  const combined = [...diffs, ...content];
  return { title, kind, rawInput,
    ...(hasPath ? { locations: [{ path, ...(name === 'Read' && Number.isInteger(input.offset) && input.offset >= 0 ? { line: Math.max(1, input.offset) } : {}) }] } : {}),
    ...(combined.length ? { content: combined } : {}),
  };
}
