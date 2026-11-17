import { createHash } from 'node:crypto';
import { ProtocolTypes, validate } from '../../check/coda/components/protocols/types.mjs';

// The records of `coda.replace`, kept as Coda's host keeps them: each has the plugin that holds it, and `replace` clears only
// what the calling plugin holds, of that kind. The definitions are those of
// Coda's concurrency groups (components/concurrency-groups/schemas.mjs, entities.mjs).
const text = { type: 'string', minLength: 1 };
const definitions = {
  'coda/group@1': { spec: { type: 'object', additionalProperties: false, required: ['name', 'attributes', 'unique'],
    properties: { name: text, attributes: { type: 'object', additionalProperties: { type: 'string' } }, unique: { type: 'array', items: text } } },
  status: { type: 'object', additionalProperties: false }, first: {} },
  'coda/entity@1': { spec: { type: 'object', additionalProperties: false, required: ['name', 'category', 'attributes', 'capacity'],
    properties: { name: text, category: text, attributes: { type: 'object', additionalProperties: { type: 'string' } }, capacity: { type: 'integer', minimum: 1 } } },
  status: { type: 'object', additionalProperties: false, properties: { state: { enum: ['free', 'held', 'returning', 'failed'] }, message: { type: 'string' } } },
  first: {} },
  'coda/link@1': { spec: { type: 'object', additionalProperties: false, required: ['entity', 'protocol', 'endpoint', 'reach'],
    properties: { entity: text, protocol: text, endpoint: text, reach: { type: 'object', required: ['scope'], properties: { scope: { enum: ['machine', 'machines', 'space'] }, machines: { type: 'array', items: text } } } } },
  status: { type: 'object', additionalProperties: false }, first: {} },
};
const types = new ProtocolTypes();
for (const [kind, { spec, status }] of Object.entries(definitions)) types.register({ kind, spec, status, participants: () => [] });

// `records` is shared between the plugins of one host: `{ owner, kind, id, key?, spec, status }` by `kind/id`. A plugin gives
// only its own `key`; the ID is the host's, derived from the plugin, the kind and the key (`recordId`). A record without a key
// is one an earlier version left. An item is `{ key, spec, status?, labels? }`: any other key is refused, as the host does
// (record-rules.mjs), and so is an `id`. The entries returned, in the order given, carry the key, for they are the writer's.
export function recordsHost(plugin, records = new Map()) {
  const replace = async (kind, items) => {
    const type = types.get(kind), keys = new Set();
    for (const { key, spec, status, labels, ...rest } of items) {
      if (Object.keys(rest).length) throw Object.assign(new Error(`unknown keys ${Object.keys(rest)}`), { code: 'invalid_input' });
      assert(validKey(key) && !keys.has(key), `bad or repeated key ${key}`); keys.add(key);
      validate(type.spec, spec, 'spec');
      if (status !== undefined) validate(type.status, status, 'status');
    }
    // What this plugin holds of this kind and is not given again goes, those without a key among them.
    for (const [at, held] of records) if (held.kind === kind && held.owner === plugin && !keys.has(held.key)) records.delete(at);
    return items.map(({ key, spec, status }) => {
      const id = recordId(plugin, kind, key), held = records.get(`${kind}/${id}`);
      // A status not written is the one held, or empty for a new record: the entity's `state` is optional, no `state` being free
      // (entity-lifecycle.mjs in Coda). What is kept is checked against the definition, as what is written is.
      const kept = status ?? held?.status ?? definitions[kind].first;
      validate(type.status, kept, 'status');
      const row = { owner: plugin, kind, id, key, spec, status: kept };
      records.set(`${kind}/${id}`, row);
      return structuredClone(row);
    });
  };
  return { records, coda: { plugin: { id: plugin }, replace } };
}
// The host's ID of a record: a UUID from the backend, the plugin, the kind and the key, the same each time.
export function recordId(plugin, kind, key) {
  const b = createHash('sha256').update(JSON.stringify(['backend:test', plugin, kind, key])).digest().subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50; b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export const validKey = key => typeof key === 'string' && key.length > 0 && key.length <= 256;
const assert = (ok, message) => { if (!ok) throw new Error(message); };
export const held = (records, kind) => [...records.values()].filter(row => row.kind === kind);
