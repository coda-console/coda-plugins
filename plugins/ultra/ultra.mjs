// What Ultra tells the agent, and how its parameters move (README.md): the templates the setting lists, the parameters a
// mode entered offers, and the three things said — on, still on, off. Ultra makes this session the coordinator and its
// Coda child sessions the executors. Nothing here talks to Coda: main.mjs does.

// What the parameter 模板 holds: a template, by its name, or the list made by hand. Apart, so that no name a template is
// given is taken for the hand-made list; each is shown by its label, the hand-made one as 自定义.
export const CUSTOM = 'custom';
export const templateValue = name => `template:${name}`;
export const templateName = value => typeof value === 'string' && value.startsWith('template:') ? value.slice('template:'.length) : null;

// The templates the setting `ultra.templates` lists: by name, in the order each first appears, each its rows as the mode's
// parameter `subagents` has them. A row with no name or no agent is none.
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

// The mode's parameters with the templates there are to choose among, and the hand-made list beside them; the first is
// what entering takes.
// A template's name as an option is shown: as long as Coda takes a label (100 UTF-16 units, as JavaScript counts), in whole characters.
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

// One sub-agent as spawn takes it: its agent, model, effort, approval mode and options, then when it is the one.
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
    'Your work is to understand requirements, decompose tasks, define interfaces and acceptance criteria, dispatch workers, inspect their evidence, ' +
      'assign follow-ups and summarize results. Delegate implementation, detailed investigation, test writing, test/build execution and failure fixes, ' +
      'including critical-path work. Do not edit deliverable files or take worker tasks back under integration or verification. ' +
      'Small targeted reads and read-only spot checks for planning or acceptance are allowed; broader exploration, integration edits and validation go to workers.',
    'While Ultra is on, delegate only through Coda\'s `spawn`, even when using your own agent and model. ' +
      'Do not use the runtime\'s native subagent or delegation tools unless the user explicitly requests them.',
    'Make a short plan and delegate worker tasks even when they must run sequentially. Give each child a concrete, self-contained task, ' +
      'acceptance criteria and a write scope no other active session touches. In its task, explicitly tell it to act as an executor: ' +
      'do the assigned work itself, do not inherit your coordinator-only role, and do not delegate further unless explicitly assigned to do so; ' +
      'any further delegation must also use Coda. Results come back on their own. Review the evidence and assign fixes to workers; do not redo their work.',
    'If `spawn` refuses because concurrency is full, wait for an existing Coda session to finish and free a slot. ' +
      'If `spawn` is unavailable, report the blocker and continue only coordination that does not depend on it. ' +
      'Neither case permits taking over worker tasks or falling back to native subagents.',
    subagents.length
      ? `Choose each session's agent from this list by what the task is, giving spawn these values; for work it does not cover, use your own agent and model:\n${subagents.map(line).join('\n')}`
      : 'Start each Coda session with `spawn` using your own agent and model.',
  ].join('\n\n');
}
export const STILL_ON = 'Ultra coordinator mode is still on: keep planning, dispatch and acceptance in this session; ' +
  'delegate implementation, detailed investigation, tests/builds and fixes, including critical-path work, only through Coda\'s `spawn`. ' +
  'Tell children to execute their tasks, not inherit your coordinator role. Wait when concurrency is full; report unavailable spawn. ' +
  'Do not take over worker tasks or use native subagent tools unless the user explicitly overrides these rules.';
export const OFF = 'The user turned off Ultra: its coordinator-only role and Coda-only delegation rule no longer apply; follow the usual execution and delegation instructions. ' +
  'Start Coda sessions only when the user, AGENTS.md or a skill asks for it.';
// How many messages go by between reminders that it is still on.
export const REMIND_EVERY = 10;
