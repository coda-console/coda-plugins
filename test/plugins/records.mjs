import { ProtocolTypes, validate } from '../../check/coda/components/protocols/types.mjs';

// The records of `coda.replace`, kept as Coda's host keeps them: each has the plugin that holds it, writing the ID of another
// plugin's is refused, and `replace` clears only what the calling plugin holds, of that kind. The definitions are those of
// Coda's concurrency groups (components/concurrency-groups/schemas.mjs, entities.mjs).
const text = { type: 'string', minLength: 1 };
const definitions = {
  'coda/group@1': { spec: { type: 'object', additionalProperties: false, required: ['name', 'plugin', 'attributes', 'unique'],
    properties: { name: text, plugin: text, attributes: { type: 'object', additionalProperties: { type: 'string' } }, unique: { type: 'array', items: text } } },
  status: { type: 'object', additionalProperties: false }, first: {} },
  'coda/entity@1': { spec: { type: 'object', additionalProperties: false, required: ['name', 'category', 'plugin', 'attributes', 'capacity'],
    properties: { name: text, category: text, plugin: text, attributes: { type: 'object', additionalProperties: { type: 'string' } }, capacity: { type: 'integer', minimum: 1 } } },
  status: { type: 'object', additionalProperties: false, properties: { state: { enum: ['free', 'held', 'returning', 'failed'] }, message: { type: 'string' } } },
  first: {} },
  'coda/link@1': { spec: { type: 'object', additionalProperties: false, required: ['entity', 'protocol', 'endpoint', 'reach', 'plugin'],
    properties: { entity: text, protocol: text, endpoint: text, plugin: text, reach: { type: 'object', required: ['scope'], properties: { scope: { enum: ['machine', 'machines', 'space'] }, machines: { type: 'array', items: text } } } } },
  status: { type: 'object', additionalProperties: false }, first: {} },
};
const types = new ProtocolTypes();
for (const [kind, { spec, status }] of Object.entries(definitions)) types.register({ kind, spec, status, participants: () => [] });

// `records` is shared between the plugins of one host: `{ owner, kind, id, spec, status }` by `kind/id`.
// An item is `{ id, spec, status?, labels? }`: any other key is refused, as the host does (record-rules.mjs).
export function recordsHost(plugin, records = new Map()) {
  const replace = async (kind, items) => {
    const type = types.get(kind), ids = new Set();
    for (const { id, spec, status, labels, ...rest } of items) {
      if (Object.keys(rest).length) throw Object.assign(new Error(`unknown keys ${Object.keys(rest)}`), { code: 'invalid_input' });
      assert(typeof id === 'string' && id && !ids.has(id), `bad or repeated id ${id}`); ids.add(id);
      validate(type.spec, spec, 'spec');
      if (status !== undefined) validate(type.status, status, 'status');
      const held = records.get(`${kind}/${id}`);
      if (held && held.owner !== plugin) throw new Error(`${id} is held by ${held.owner}`);
    }
    for (const [key, held] of records) if (held.kind === kind && held.owner === plugin && !ids.has(held.id)) records.delete(key);
    for (const { id, spec, status } of items) {
      const held = records.get(`${kind}/${id}`);
      // A status not written is the one held, or empty for a new record: the entity's `state` is optional, no `state` being free
      // (entity-lifecycle.mjs in Coda). What is kept is checked against the definition, as what is written is.
      const kept = status ?? held?.status ?? definitions[kind].first;
      validate(type.status, kept, 'status');
      records.set(`${kind}/${id}`, { owner: plugin, kind, id, spec, status: kept });
    }
  };
  return { records, coda: { plugin: { id: plugin }, replace } };
}
const assert = (ok, message) => { if (!ok) throw new Error(message); };
export const held = (records, kind) => [...records.values()].filter(row => row.kind === kind);
