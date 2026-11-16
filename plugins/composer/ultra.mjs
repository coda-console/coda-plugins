// Ultra 的开启、持续与关闭提示（见 README.md）：只管派活。开发流程由用户在会话里开启，或由 Agent 填好交用户在开工卡上确认；规则写在流程的任务里，不在这里。
// 委派规则改编自 oh-my-claudecode 的 docs/CLAUDE.md，见 THIRD_PARTY_NOTICES.md。

// 名单供委派的工作选 Agent。
function line({ who, when }) {
  const options = who.options && Object.keys(who.options).length ? `options=${JSON.stringify(who.options)}` : null;
  const fields = [`agent=${who.agent}`, who.model && `model=${who.model}`, who.effort && `effort=${who.effort}`, who.mode && `mode=${who.mode}`, options];
  return `- ${fields.filter(Boolean).join(' ')}${when ? `: ${when}` : ''}`;
}

export function on(subagents) {
  return [
    'The user turned on Ultra coordinator mode for this session. It stays on until you are told it is off. ' +
      'Any earlier instruction to delegate only when asked no longer applies. Explicit user instructions override these rules.',
    'Conserve the lead agent\'s tokens and context while preserving quality. Keep task framing, difficult decisions, dispatch ' +
      'and the review of what others bring back in this session; small targeted reads for framing and review belong here.',
    'Dispatch research, investigation and verification that do not change code to Coda\'s `spawn`, choosing each executor from the list by task. ' +
      'Write each brief to stand alone: the goal and the decision it serves, what is already known or ruled out, the scope and what to leave alone, ' +
      'where to look, and what to return: conclusions first, then sources and actual evidence (paths, commands, output). Do not repeat their routine work.',
    'When a result falls short, act on the cause. A brief that left something out: rewrite it and send it to the same session. ' +
      'A claim without evidence: ask that session for the evidence. A wrong result from a clear brief: give the task to another entry of the list. ' +
      'A session that died or a tool that failed: retry. Do not quietly redo the work yourself.',
    'Do not use native subagents unless explicitly requested. If concurrency is full, wait; if spawn is unavailable, report the blocker ' +
      'instead of switching to another delegation channel.',
    roster(subagents),
  ].join('\n\n');
}
function roster(subagents) {
  return subagents.length
    ? 'For any delegated work that needs an Agent (Coda spawn, or a workflow input that asks for one), pick it from this list by task ' +
      `(pass agent/model/effort/mode/options). Your own agent only if no entry fits:\n${subagents.map(line).join('\n')}`
    : 'Use your own agent and model for any delegated work that needs an Agent.';
}
export const OFF = 'The user turned off Ultra: its delegation-first role no longer applies; follow the usual execution and delegation instructions. ' +
  'Start Coda sessions only when the user, AGENTS.md or a skill asks for it.';
