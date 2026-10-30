// What Ultra tells the agent, and how its parameters move (README.md): the templates the setting lists, the parameters a
// mode entered offers, and the three things said — on, still on, off — modelled on Codex's proactive multi-agent mode and
// Claude Code's Ultracode. Nothing here talks to Coda: main.mjs does.

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
    'The user turned on proactive delegation (Ultra). Any earlier instruction to start Coda sessions only when asked no longer applies; ' +
      'it stays on until you are told it is off. What the user asks in a message overrides it.',
    'When part of the work can run alongside yours and handing it off saves time or improves quality, start a Coda session for it with `spawn`. ' +
      'First make a short plan: keep the step you are blocked on, hand off side tasks. Give each session a concrete, self-contained task; for code, ' +
      'a write scope no other session touches. Go on with your own part while they work; results come back on their own. Do not redo what a session did. ' +
      'A spawn refused because too many sessions are at work is yours to do, or to start again once one is done.',
    subagents.length
      ? `Choose each session's agent from this list by what the task is, giving spawn these values; for work it does not cover, use your own agent and model:\n${subagents.map(line).join('\n')}`
      : 'Start each session with your own agent and model.',
  ].join('\n\n');
}
export const STILL_ON = 'Proactive delegation (Ultra) is still on.';
export const OFF = 'The user turned off proactive delegation (Ultra): start Coda sessions only when the user, AGENTS.md or a skill asks for it.';
// How many messages go by between reminders that it is still on.
export const REMIND_EVERY = 10;
