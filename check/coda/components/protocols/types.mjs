import Ajv from 'ajv';

// Only JSON Schema rules: no coercion, custom keywords or executable constraints. Only the type's schemas
// supply defaults. An absent field without a declared default stays absent.
const ajv = new Ajv({ allErrors: true, addUsedSchema: false });
const defaults = new Ajv({ allErrors: true, addUsedSchema: false, useDefaults: true });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

const compile = (schema, compiler = ajv) => {
  const check = compiler.compile(schema);
  if (check.$async) throw new TypeError('协议只允许同步 JSON Schema 校验');
  return check;
};

export function validate(check, value, who) {
  if (!check(value)) throw new TypeError(`${who}: ${ajv.errorsText(check.errors)}`);
}

export class ProtocolTypes {
  constructor() { this.types = new Map(); }
  register({ kind, spec, status, contributions = {}, participants }, registered = () => {}) {
    if (typeof kind !== 'string' || !/^[a-z][a-zA-Z0-9-]*$/.test(kind) || this.types.has(kind)) throw new TypeError(`协议类型无效或已登记：${kind}`);
    if (spec?.type !== 'object' || status?.type !== 'object') throw new TypeError(`${kind}: spec 与 status 须为对象 schema`);
    if (typeof participants !== 'function' || !object(contributions)) throw new TypeError(`${kind}: 需要 participants 与 contributions`);
    const properties = {};
    for (const [field, { merge, schema }] of Object.entries(contributions)) {
      const type = merge === 'append' ? 'array' : merge === 'or' ? 'boolean' : null;
      if (!type || schema?.type !== type || spec?.properties?.[field]?.type !== type) {
        throw new TypeError(`${kind}.${field}: 补充只允许 append 列表或 or 开关，单值栏不可补充`);
      }
      Object.defineProperty(properties, field, { value: schema, enumerable: true });
    }
    const type = { kind, participants, contributions: structuredClone(contributions),
      spec: compile(spec, defaults), status: compile(status, defaults),
      // Before supplementation only merge operands must be shaped correctly. Required fields and counts apply to the
      // complete spec, so a participant can supply a required list that the initial object does not have yet.
      base: compile({ type: 'object', properties: Object.fromEntries(Object.entries(properties).map(([field, schema]) => [field, { type: schema.type }])) }),
      answer: compile({ type: 'object', properties, additionalProperties: false }, defaults) };
    registered(type);
    this.types.set(kind, type);
    return type;
  }
  get(kind) {
    const type = this.types.get(kind);
    if (!type) throw new TypeError(`未登记协议类型：${kind}`);
    return type;
  }
}

export function checkParticipants(answers) {
  const seen = new Set();
  for (const { plugin, key } of answers) {
    const id = JSON.stringify([plugin, key]);
    if (typeof plugin !== 'string' || !plugin || typeof key !== 'string' || !key || seen.has(id)) throw new TypeError(`参与者无效或重复：${id}`);
    seen.add(id);
  }
}

// Each answer is atomic. Append in participant identity order, preserving each answer's own list order and duplicates;
// neither the participants' enumeration nor their completion order supplies precedence.
export function mergeContributions(type, spec, answers) {
  validate(type.base, spec, `${type.kind}.spec`);
  checkParticipants(answers);
  const replies = structuredClone(answers);
  for (const reply of replies) if (reply.value === null) reply.value = {};
  for (const { plugin, key, value } of replies) validate(type.answer, value, `插件 ${plugin}（${key}）的补充`);
  const result = structuredClone(spec);
  for (const { value } of replies.sort((a, b) => compare(a.plugin, b.plugin) || compare(a.key, b.key))) {
    for (const [field, added] of Object.entries(value)) {
      const merged = type.contributions[field].merge === 'append' ? [...(result[field] ?? []), ...structuredClone(added)] : (result[field] ?? false) || added;
      Object.defineProperty(result, field, { value: merged, enumerable: true, writable: true, configurable: true });
    }
  }
  validate(type.spec, result, `${type.kind}.spec`);
  return result;
}
