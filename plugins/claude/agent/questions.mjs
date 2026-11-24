// What Claude asks the user, as ACP forms in plain JSON Schema: its own questions (AskUserQuestion) and those of the MCP
// servers it runs (a form, or a link to open).
import { randomUUID } from 'node:crypto';

// The choice that says the answer is the one written beside it: ACP forms carry no rule that one of two fields be filled,
// so the question stays required and this is one of its choices.
export const OTHER = 'coda:other';

export function questionForm({ sessionId, toolCallId, input }) {
  const questions = Array.isArray(input?.questions) ? input.questions : [];
  const properties = {};
  questions.forEach((q, i) => {
    const choices = [...(q.options ?? []).map(o => ({ const: o.label, title: o.label + (o.description ? ` — ${o.description}` : '') })),
      { const: OTHER, title: '其他（写在下面）' }];
    properties[`q${i}`] = { title: q.question, description: q.header ?? '', ...(q.multiSelect
      ? { type: 'array', items: { anyOf: choices }, minItems: 1 } : { type: 'string', oneOf: choices }) };
    properties[`q${i}_other`] = { type: 'string', title: '其他' };
  });
  const params = { sessionId, ...(toolCallId ? { toolCallId } : {}), mode: 'form', message: 'Claude 需要你的回答',
    requestedSchema: { type: 'object', properties, required: questions.map((_, i) => `q${i}`) } };
  const answer = response => {
    if (response?.action !== 'accept') {
      // The host's own refusal of the form (coda-protocol「宿主当场拒绝表单」) carries its text; the model gets it as it is.
      const reason = response?.action === 'decline' ? response._meta?.coda?.reason : null;
      return { behavior: 'deny', message: typeof reason === 'string' && reason.trim() ? reason : '用户取消了问答' };
    }
    const content = response.content ?? {};
    return { behavior: 'allow', updatedInput: { ...input, answers: Object.fromEntries(questions.map((q, i) => {
      const other = String(content[`q${i}_other`] ?? '').trim() || '其他', pick = value => value === OTHER ? other : value;
      const value = content[`q${i}`];
      return [q.question, Array.isArray(value) ? value.map(pick).join(', ') : pick(value)];
    })) } };
  };
  return { params, answer };
}

// An MCP server's request (SDK onElicitation): its form as it is, or its link with nothing to fill in.
export function elicitationForm({ sessionId, request }) {
  if (request.mode === 'url') return { params: { sessionId, mode: 'url', message: request.message ?? '', url: request.url,
    elicitationId: request.elicitationId ?? randomUUID() }, answer: response => ({ action: response?.action ?? 'cancel' }) };
  return { params: { sessionId, mode: 'form', message: request.message ?? '', requestedSchema: request.requestedSchema ?? { type: 'object', properties: {} } },
    answer: response => ['accept', 'decline', 'cancel'].includes(response?.action) ? response : { action: 'cancel' } };
}
