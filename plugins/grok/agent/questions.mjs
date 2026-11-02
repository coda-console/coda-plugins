// What Grok asks the user (its `ask_user_question` tool), which it asks of the client with a request of its own,
// `_x.ai/ask_user_question` { sessionId, toolCallId, questions: [{ question, options: [{ label, description }], multiSelect }] }:
// asked of Coda as an ACP form in plain JSON Schema, and answered as Grok takes it, `{ outcome: 'accepted', answers }` with
// each question's text naming its answer (a list for several), or `{ outcome: 'cancelled' }`.
export const ASK = '_x.ai/ask_user_question';

// The choice that says the answer is the one written beside it: ACP forms carry no rule that one of two fields be filled,
// so the question stays required and this is one of its choices.
export const OTHER = 'coda:other';

export function questionForm({ sessionId, toolCallId, questions }) {
  questions = Array.isArray(questions) ? questions : [];
  const properties = {};
  questions.forEach((q, i) => {
    const choices = [...(q.options ?? []).map(o => ({ const: o.label, title: o.label + (o.description ? ` — ${o.description}` : '') })),
      { const: OTHER, title: '其他（写在下面）' }];
    properties[`q${i}`] = { title: q.question, ...(q.multiSelect
      ? { type: 'array', items: { anyOf: choices }, minItems: 1 } : { type: 'string', oneOf: choices }) };
    properties[`q${i}_other`] = { type: 'string', title: '其他' };
  });
  const params = { sessionId, ...(toolCallId ? { toolCallId } : {}), mode: 'form', message: 'Grok 需要你的回答',
    requestedSchema: { type: 'object', properties, required: questions.map((_, i) => `q${i}`) } };
  const answer = response => {
    if (response?.action !== 'accept') return { outcome: 'cancelled' };
    const content = response.content ?? {};
    return { outcome: 'accepted', answers: Object.fromEntries(questions.map((q, i) => {
      const other = String(content[`q${i}_other`] ?? '').trim() || '其他', pick = value => value === OTHER ? other : value;
      const value = content[`q${i}`];
      return [q.question, Array.isArray(value) ? value.map(pick) : pick(value)];
    })) };
  };
  return { params, answer };
}
