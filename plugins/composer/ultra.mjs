// Ultra 的模板、参数和进入／持续／退出提示（见 README.md）。主会话负责协调，Coda 子会话负责执行。
// 委派规则改编自 oh-my-claudecode 的 docs/CLAUDE.md，见 THIRD_PARTY_NOTICES.md；与 Coda 的交互在 main.mjs。

// 模板参数区分命名模板与手动名单，避免模板名与「自定义」选项冲突。
export const CUSTOM = 'custom';
export const templateValue = name => `template:${name}`;
export const templateName = value => typeof value === 'string' && value.startsWith('template:') ? value.slice('template:'.length) : null;

// composer.templates 按名称和首次出现的顺序分组，生成 subagents 参数；忽略没有名称或 Agent 的行。
export function templates(rows) {
  const out = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (typeof row?.template !== 'string' || !row.template.trim() || typeof row.who?.agent !== 'string' || !row.who.agent) continue;
    const name = row.template.trim();
    if (!out.has(name)) out.set(name, []);
    out.get(name).push({ who: row.who, ...(typeof row.when === 'string' && row.when.trim() ? { when: row.when.trim() } : {}) });
  }
  return out;
}

// 参数选项包含模板和自定义名单，默认选择第一个模板。
// 选项标签按完整字符截断到 Coda 接受的 100 个 UTF-16 单元。
const label = name => {
  let out = '';
  for (const character of name) { if (out.length + character.length > 100) break; out += character; }
  return out;
};
export function withTemplates(declared, names) {
  return { ...declared, properties: { ...declared.properties, template: { ...declared.properties.template,
    enum: [...names.map(templateValue), CUSTOM], enumItemLabels: [...names.map(label), '自定义'],
    default: names.length ? templateValue(names[0]) : CUSTOM } } };
}

// 按 spawn 接受的格式列出子 Agent、模型、推理强度、审批模式、配置项及适用任务。
function line({ who, when }) {
  const options = who.options && Object.keys(who.options).length ? `options=${JSON.stringify(who.options)}` : null;
  const fields = [`agent=${who.agent}`, who.model && `model=${who.model}`, who.effort && `effort=${who.effort}`, who.mode && `mode=${who.mode}`, options];
  return `- ${fields.filter(Boolean).join(' ')}${when ? `: ${when}` : ''}`;
}

export function on(subagents) {
  return [
    'The user turned on Ultra coordinator mode for this session. It stays on until you are told it is off. ' +
      'Any earlier instruction to start Coda sessions only when asked no longer applies. Explicit user instructions override these rules; ' +
      'an ordinary request to implement work does not itself override your coordinator role.',
    'Conserve the lead agent\'s tokens and context while preserving quality. You MUST delegate the main execution of non-trivial work, ' +
      'including sequential and critical-path work. Keep task framing, difficult decisions, dispatch, evidence-based acceptance and final synthesis in this session.',
    'Delegate for: multi-file changes, refactors, debugging, reviews, planning, research, verification.\n' +
      'Work directly for: trivial ops, small clarifications, single commands.',
    'Judge the trivial-work exception by the whole request: it must already be understood and need only a brief answer or an obvious localized action. ' +
      'Do not split substantial work into single commands to execute it yourself. If it grows into investigation or debugging, delegate. ' +
      'Small targeted reads and read-only spot checks for task framing or acceptance are allowed; broader exploration, implementation, tests/builds and fixes go to workers.',
    'While Ultra is on, delegate only through Coda\'s `spawn`, even when using your own agent and model. ' +
      'Do not use the runtime\'s native subagent or delegation tools unless the user explicitly requests them.',
    'Give each child a concrete, self-contained outcome, relevant context, acceptance criteria and a write scope no other active session touches. ' +
      'Keep related work with one worker and reuse it for follow-ups. Ask for concise conclusions, file/source references, actual check results and unresolved issues, not bulk logs. ' +
      'In its task, explicitly tell it to act as an executor: ' +
      'do the assigned work itself, do not inherit your coordinator role, and do not delegate further unless explicitly assigned to do so; ' +
      'any further delegation must also use Coda. Results come back on their own. Review the evidence and assign fixes to workers; do not repeat their searches, edits or routine checks.',
    'If `spawn` refuses because concurrency is full, wait for an existing Coda session to finish and free a slot. ' +
      'If `spawn` is unavailable, report the blocker and continue only coordination that does not depend on it. ' +
      'Neither case expands the trivial-work exception or permits falling back to native subagents.',
    subagents.length
      ? `Choose each session's agent from this list by what the task is, giving spawn these values; for work it does not cover, use your own agent and model:\n${subagents.map(line).join('\n')}`
      : 'Start each Coda session with `spawn` using your own agent and model.',
  ].join('\n\n');
}
export const STILL_ON = 'Ultra is still on. Conserve the lead agent\'s tokens and context: you MUST delegate non-trivial execution through Coda\'s `spawn`, ' +
  'including sequential and critical-path work. Judge tiny work by the whole request; do not split it into commands or repeat workers\' work. ' +
  'Keep coordination and acceptance here; tell children to execute. Wait when concurrency is full; report unavailable spawn. ' +
  'No native subagents unless explicitly requested.';
export const OFF = 'The user turned off Ultra: its delegation-first role and Coda-only delegation rule no longer apply; follow the usual execution and delegation instructions. ' +
  'Start Coda sessions only when the user, AGENTS.md or a skill asks for it.';
