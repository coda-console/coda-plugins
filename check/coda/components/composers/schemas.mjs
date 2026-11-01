const string = { type: 'string', minLength: 1 };
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const array = items => ({ type: 'array', items });
const values = { type: 'object' };
const mode = { type: 'string', pattern: '^[a-z][a-z0-9-]{0,39}/[a-z][a-z0-9-]{0,39}$' };
const agent = object({ agent: string, settings: values });
// Defaults live on the selected branch, so AJV applies `open` to thread targets only.
export const target = {
  type: 'object', properties: { kind: { enum: ['message', 'thread', 'loop'] } }, required: ['kind'],
  allOf: [
    { if: { properties: { kind: { const: 'message' } } }, then: object({ kind: { const: 'message' }, thread: string, run: { type: 'boolean' } }, ['kind', 'thread']) },
    { if: { properties: { kind: { const: 'thread' } } }, then: object({ kind: { const: 'thread' }, agent: object({ agent: string, model: string, effort: string, mode: string, options: values }, ['agent']), settings: values,
      checkout: object({ kind: { enum: ['original', 'worktree', 'handoff'] }, baseRef: string }, ['kind']),
      handoffSource: string, parentThreadId: string, replyTo: { enum: ['parent', 'sender'] }, run: { type: 'boolean' }, open: { type: 'boolean', default: true } }, ['kind']) },
    { if: { properties: { kind: { const: 'loop' } } }, then: object({ kind: { const: 'loop' }, thread: string,
      every: { type: 'string', pattern: '^P(?:(?:0|1)D)?(?:T(?:[0-9]+H)?(?:[0-9]+M)?)?$' } }) },
  ],
};
const snapshotMode = object({ mode, values, sent: { type: 'integer', minimum: 0 }, changedSinceSent: { type: 'boolean' } });
export const composerType = { kind: 'composers', participants: () => [],
  spec: { ...object({ thread: string, project: string, modes: array(object({ mode, values })) }, ['modes']),
    oneOf: [{ required: ['thread'], not: { required: ['project'] } }, { required: ['project'], not: { required: ['thread'] } }] },
  status: object({ modes: array(object({ mode, sent: { type: 'integer', minimum: 0 }, changedSinceSent: { type: 'boolean' }, presets: { type: 'object', additionalProperties: array(object({ name: {}, values: array(values) })) } })) }) };
const tell = array({ type: 'string', minLength: 1, maxLength: 4000, pattern: '^[^\\u0000]*\\S[^\\u0000]*$' });
const targets = array(target), divert = { type: 'boolean' };
export const submissionType = { kind: 'submissions',
  participants: object => object.spec.modes.map(({ mode }) => { const [plugin, key] = mode.split('/'); return { plugin, key }; }),
  spec: object({ composer: string, thread: { type: ['string', 'null'] }, projectId: string, text: { type: 'string', minLength: 1, maxLength: 100000 },
    attachments: { ...array(string), maxItems: 20, uniqueItems: true }, quotes: { ...array({ type: 'string', maxLength: 20000 }), maxItems: 20 },
    agent, modes: array(snapshotMode), defaultTarget: target, tell, targets, divert },
  ['composer', 'thread', 'projectId', 'text', 'attachments', 'quotes', 'agent', 'modes', 'defaultTarget']),
  contributions: { tell: { merge: 'append', schema: tell }, targets: { merge: 'append', schema: targets }, divert: { merge: 'or', schema: divert } },
  status: object({ clearedDraftRevision: { type: ['integer', 'null'], minimum: 0 },
    results: array(object({ target, requestId: string, inputId: { type: ['string', 'null'], minLength: 1 },
      state: { enum: ['done', 'refused'] }, thread: string, code: string, message: string }, ['target', 'requestId', 'inputId', 'state'])) }) };
