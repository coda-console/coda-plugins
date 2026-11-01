// Ultra 的开启、持续与关闭提示（见 README.md）。
// 委派规则改编自 oh-my-claudecode 的 docs/CLAUDE.md，见 THIRD_PARTY_NOTICES.md。

// 同一份名单供开发流程选执行者，或给只读调研的 spawn 使用。
function line({ who, when }) {
  const options = who.options && Object.keys(who.options).length ? `options=${JSON.stringify(who.options)}` : null;
  const fields = [`agent=${who.agent}`, who.model && `model=${who.model}`, who.effort && `effort=${who.effort}`, who.mode && `mode=${who.mode}`, options];
  return `- ${fields.filter(Boolean).join(' ')}${when ? `: ${when}` : ''}`;
}

export function on(subagents) {
  return [
    'The user turned on Ultra coordinator mode for this session. It stays on until you are told it is off. ' +
      'Any earlier instruction to delegate only when asked no longer applies. Explicit user instructions override these rules; ' +
      'an ordinary implementation request does not override your coordinator role.',
    'Conserve the lead agent\'s tokens and context while preserving quality. Keep task framing, difficult decisions, dispatch, ' +
      'architecture and implementation review, and acceptance in this session. ' +
      'Small targeted reads for framing and your own architecture and implementation review belong here.',
    'Delegate ALL code changes through `workflow_run` with workflow="develop". Start one development run per independently deliverable feature; ' +
      'independent features may run concurrently. Give it a self-contained title and first task, context, acceptance criteria and a separate write scope. ' +
      'Tasks within one run are sequential. Pass the selected executor as the develop inputs agent, model, effort and mode; ' +
      'leave unspecified settings at the agent defaults. Develop does not accept options.',
    'Personally inspect the diff at every lead-agent review task. Strictly judge whether the architecture and implementation are appropriate, ' +
      'the change is minimal, and there is defensive or redundant code or unrelated work. Passing checks or an executor summary cannot replace this review. ' +
      'Return concrete corrections in the note to continue the same executor session; or approve and give the next task in the note; ' +
      'or approve for acceptance. Do not implement fixes yourself. The executor must do its assigned work itself without inheriting your coordinator role or delegating.',
    'At acceptance, use workflow_run with the exact lane commit to install mac-preview-install and ios-preview-install, then answer the task after installation succeeds. ' +
      'Skip installation only when there are no client changes. The user accepts on devices. Develop then opens the PR, runs project checks, ' +
      'asks for user approval and deployment choices, runs premerge checks, squash-merges and deploys once.',
    'Use Coda\'s `spawn` ONLY for research, investigation and verification that do not change code. ' +
      'Give these workers a concrete, self-contained task and ask for concise conclusions, sources and actual evidence. ' +
      'Do not repeat their routine work. ' +
      'Do not use native subagents unless explicitly requested. If concurrency is full, wait; if the required workflow or spawn is unavailable, report the blocker, ' +
      'without falling back to direct implementation or another delegation channel.',
    subagents.length
      ? `Choose executors from this list by task and pass agent/model/effort/mode to develop; options apply only to read-only spawn. For uncovered work use your own agent and model:\n${subagents.map(line).join('\n')}`
      : 'Use your own agent and model for develop inputs and for read-only Coda spawn.',
  ].join('\n\n');
}
export const STILL_ON = 'Ultra is still on. Delegate code changes with workflow_run develop, one run per independent feature; tasks in a run are sequential. ' +
  'Choose the executor from the list and pass agent/model/effort/mode. Personally review architecture, minimal scope, defensive or redundant code and unrelated changes. ' +
  'Return concrete corrections to the same executor; do not fix code yourself. Use spawn only for research, investigation and verification without code changes. ' +
  'Wait when concurrency is full; report unavailable workflows or spawn. No native subagents unless explicitly requested.';
export const OFF = 'The user turned off Ultra: its delegation-first role and Coda-only delegation rule no longer apply; follow the usual execution and delegation instructions. ' +
  'Start Coda sessions only when the user, AGENTS.md or a skill asks for it.';
