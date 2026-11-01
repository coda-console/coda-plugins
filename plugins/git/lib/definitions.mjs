const text = { type: 'string', minLength: 1 };
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
export const SOURCE = 'gitSource';
export const SNAPSHOT = 'sourceSnapshot';
export const definitions = [
  { kind: SOURCE, spec: object({ path: text }, ['path']),
    status: object({ ready: { type: 'boolean' }, url: text, reason: text }) },
  { kind: SNAPSHOT, spec: {
    ...object({ source: text, mode: { enum: ['commit', 'worktree'] }, commit: text, run: text }, ['source', 'mode', 'run']),
    oneOf: [
      { properties: { mode: { const: 'commit' } }, required: ['commit'] },
      { properties: { mode: { const: 'worktree' } }, not: { required: ['commit'] } },
    ],
  }, status: object({ ready: { type: 'boolean' }, commit: text, ref: text, url: text, reason: text, released: { type: 'boolean' } }) },
];
