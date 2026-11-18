import { createHash } from 'node:crypto';
import { ProtocolTypes, validate } from '../../check/coda/components/protocols/types.mjs';

// The records of `coda.replace`, kept as Coda's host keeps them: each has the plugin that holds it, and `replace` clears only
// what the calling plugin holds, of that kind. The definition is that of Coda's concurrency group
// (components/concurrency-groups/schemas.mjs `groupType`): a status being Coda's alone, a plugin gives none.
const text = { type: 'string', minLength: 1 };
const REACH = { type: 'object', properties: { scope: { type: 'string', enum: ['machine', 'machines', 'space'] }, machines: { type: 'array', items: text } },
  required: ['scope'], oneOf: [
    { properties: { scope: { enum: ['machine'] } }, not: { required: ['machines'] } },
    { properties: { scope: { enum: ['machines'] } }, required: ['machines'] },
    { properties: { scope: { enum: ['space'] } }, not: { required: ['machines'] } }] };
const HOLDER = { type: 'object', properties: { owner: text, location: text, runId: text }, required: ['owner', 'location', 'runId'], additionalProperties: false };
const definitions = {
  'coda/group@1': { spec: { type: 'object', additionalProperties: false, required: ['name', 'attributes', 'unique'],
    properties: { name: text, capacity: { type: 'integer', minimum: 1, maximum: 64, default: 1 },
      attributes: { type: 'object', additionalProperties: { type: 'string' } }, unique: { type: 'array', items: text }, reach: REACH,
      links: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['protocol', 'endpoint', 'reach'],
        properties: { protocol: text, endpoint: text, reach: REACH } } },
      lends: { type: 'boolean' } } },
  status: { type: 'object', additionalProperties: false, properties: { state: { enum: ['free', 'lending', 'held', 'returning', 'failed'] },
    holder: HOLDER, message: { type: 'string' } }, dependentRequired: { holder: ['state'], message: ['state'] } }, first: {} },
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
      checkHeld(spec, status);
    }
    // What this plugin holds of this kind and is not given again goes, those without a key among them.
    for (const [at, held] of records) if (held.kind === kind && held.owner === plugin && !keys.has(held.key)) records.delete(at);
    return items.map(({ key, spec, status }) => {
      const id = recordId(plugin, kind, key), held = records.get(`${kind}/${id}`);
      // A status not written is the one held, or empty for a new record: `state` is optional, no `state` being free. What is
      // kept is checked against the definition, as what is written is.
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
// What Coda holds a group written to besides its schema (schemas.mjs `checkHeld`, `checkGiven`): its status is Coda's, its name
// has no whitespace, what it marks unique it has, and one lent is of capacity 1.
function checkHeld(spec, status) {
  const missing = spec.unique.find(key => !spec.attributes[key]);
  assert(status === undefined && /^\S{1,100}$/.test(spec.name) && missing === undefined && (!spec.lends || spec.capacity === 1), `refused: ${spec.name}`);
}
export const validKey = key => typeof key === 'string' && key.length > 0 && key.length <= 256;
const assert = (ok, message) => { if (!ok) throw new Error(message); };
export const held = (records, kind) => [...records.values()].filter(row => row.kind === kind);
