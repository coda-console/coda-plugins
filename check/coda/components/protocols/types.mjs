import Ajv2020 from 'ajv/dist/2020.js';
import { parseProtocolName } from '@coda-console/protocol/protocol';
import { AGENTS, GROUPS, THREADS } from '../../domain/resource-kinds.mjs';

// The resource kinds an invocation may name until the resource is a protocol of its own (docs/plugins.md「调用」): `threads`,
// `agents`, `groups`. Only Coda's own core operations use these; a plugin defines protocols under its namespace.
const KINDS = new Set([AGENTS, GROUPS, THREADS]);
export const resourceKind = value => KINDS.has(value);

// Only JSON Schema rules: no coercion, custom keywords or executable constraints. Only the type's schemas
// supply defaults. An absent field without a declared default stays absent.
const options = { allErrors: true, addUsedSchema: false, strict: true, strictTypes: false, strictRequired: false, allowUnionTypes: true };
const ajv = new Ajv2020(options);
const defaults = new Ajv2020({ ...options, useDefaults: true });
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
  register({ kind, spec, status, operations = {}, contributions = {}, participants = () => [] }, registered = () => {}, replace = false) {
    if (!(parseProtocolName(kind) || resourceKind(kind)) || (this.types.has(kind) && !replace)) throw new TypeError(`协议名无效或已登记：${kind}`);
    if (spec?.type !== 'object' || status?.type !== 'object') throw new TypeError(`${kind}: spec 与 status 须为对象 schema`);
    if (typeof participants !== 'function' || !object(contributions)) throw new TypeError(`${kind}: 需要 participants 与 contributions`);
    // Each operation is an input and either an immediate result or a run reference, as the protocol package defines them.
    // `join` names an input field holding the run of an open call that the operation adds to instead of opening one;
    // `safe`, one that only reads and answers at once, whose request and answer neither side keeps.
    if (!object(operations)) throw new TypeError(`${kind}: operations 须为对象`);
    const compiled = new Map();
    for (const [name, operation] of Object.entries(operations)) {
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(name) || !object(operation)) throw new TypeError(`${kind}.${name}: 操作名或定义无效`);
      const run = operation.run === true, join = operation.join;
      if (run === Object.hasOwn(operation, 'result') || !operation.input) throw new TypeError(`${kind}.${name}: 操作要写 input，并恰写 result 或 run`);
      if (join !== undefined && (!run || typeof join !== 'string' || !join)) throw new TypeError(`${kind}.${name}: join 只能用于运行，并写出输入里的字段`);
      compiled.set(name, { input: compile(operation.input), ...(run ? { run } : { result: compile(operation.result) }), ...(join ? { join } : {}),
        ...(operation.safe === true ? { safe: true } : {}) });
    }
    const properties = {};
    for (const [field, { merge, schema }] of Object.entries(contributions)) {
      const type = merge === 'append' ? 'array' : merge === 'or' ? 'boolean' : null;
      if (!type || schema?.type !== type || spec?.properties?.[field]?.type !== type) {
        throw new TypeError(`${kind}.${field}: 补充只允许 append 列表或 or 开关，单值栏不可补充`);
      }
      Object.defineProperty(properties, field, { value: schema, enumerable: true });
    }
    const type = { kind, participants, contributions: structuredClone(contributions), operations: compiled,
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
