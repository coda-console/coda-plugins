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

// A patch line includes its newline unless the immediately following marker says otherwise.
// Context belongs to both sides; a marker after '-' or '+' only applies to that side.
function patchText(lines, side) {
  return lines.map((line, i) => line.startsWith(side) || line.startsWith(' ')
    ? line.slice(1) + (lines[i + 1] === '\\ No newline at end of file' ? '' : '\n') : '').join('');
}

// A successful SDK result is authoritative: a Write may overwrite a file, and an Edit may replace
// many occurrences or be changed by the user. Keep previews only when no structured result is given.
export function toolResultContent(name, content, result, failed = false) {
  if (failed || !['Edit', 'MultiEdit', 'Write'].includes(name) || !string(result?.filePath)) return content;
  let diffs;
  if (result.staged === true) diffs = []; // SDK: held for review, the file is unchanged.
  else if (name === 'Write' && string(result.content)
    && (string(result.originalFile) || (result.type === 'create' && result.originalFile === null))) {
    diffs = [{ type: 'diff', path: result.filePath, oldText: result.originalFile, newText: result.content }];
  } else if (Array.isArray(result.structuredPatch)
    && result.structuredPatch.every(hunk => Array.isArray(hunk?.lines) && hunk.lines.every(string))) {
    // Each hunk carries both sides, including context. Do not merge distant hunks: that would
    // invent adjacent lines and can undercount independent replacements.
    diffs = result.structuredPatch.map(hunk => ({ type: 'diff', path: result.filePath,
      oldText: patchText(hunk.lines, '-'), newText: patchText(hunk.lines, '+'),
    }));
  }
  // An update whose original text was too large and whose patch is empty has no measurable diff;
  // in particular, do not keep the input preview that would report it as a newly created file.
  return diffs === undefined ? content : [...diffs, ...content.filter(block => block.type !== 'diff')];
}

// Pending calls must survive other tools finishing. Completed calls only serve repeated SDK results:
// keep the most recently completed 128 calls, with at most 4 MiB of estimated string storage.
// Evicted results are ignored, so they cannot overwrite the diff already sent to the client.
export class ToolCallCache {
  #pending = new Map(); #completed = new Map(); #bytes = 0;
  constructor({ maxCompleted = 128, maxBytes = 4 * 1024 * 1024 } = {}) {
    this.maxCompleted = maxCompleted; this.maxBytes = maxBytes;
  }
  #forget(id) {
    const entry = this.#completed.get(id);
    if (entry) { this.#bytes -= entry.bytes; this.#completed.delete(id); }
  }
  start(id, name, content) {
    this.#forget(id);
    this.#pending.set(id, { name, content });
  }
  finish(id, result, failed = false) {
    const previous = this.#pending.get(id) ?? this.#completed.get(id)?.tool;
    if (!previous) return undefined;
    const tool = { name: previous.name, content: toolResultContent(previous.name, previous.content, result, failed) };
    this.#pending.delete(id); this.#forget(id);
    // Two bytes per UTF-16 code unit, including ID and serialized field names; the count limit also
    // bounds object overhead. An oversized result is delivered once without evicting smaller entries.
    const bytes = 2 * (id.length + JSON.stringify(tool).length);
    if (bytes <= this.maxBytes) {
      this.#completed.set(id, { tool, bytes }); this.#bytes += bytes;
      while (this.#completed.size > this.maxCompleted || this.#bytes > this.maxBytes) this.#forget(this.#completed.keys().next().value);
    }
    return tool.content;
  }
}
