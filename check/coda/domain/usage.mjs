// What a turn the agent reported using, as a Coda turn's `usage` (the agent's own count of this turn, not a running total),
// brought to the counts usage_buckets keeps. Only this standard shape is read: nothing here knows an agent's own fields.
export const USAGE_BUCKET_MS = 600_000;

export function bucketStart(timeMs) {
  if (!Number.isSafeInteger(timeMs) || timeMs < 0) throw new TypeError('时间必须是非负整数毫秒');
  return Math.floor(timeMs / USAGE_BUCKET_MS) * USAGE_BUCKET_MS;
}

// A model's name as a session keeps it (domain/values.mjs text), as it is: not blank, at most `max` long, no NUL; null for one that is not.
export const modelName = (value, max = 200) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !value.includes('\0') ? value : null;

const FIELDS = [['inputTokens', 'input'], ['outputTokens', 'output'], ['cachedReadTokens', 'cacheRead'], ['cachedWriteTokens', 'cacheWrite']];
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

// The counts of one object, `{ ok, counts }` or `{ ok: false, reason }`: each given field (not undefined or null) a non-negative safe integer, at least one given.
function counts(raw, what) {
  const result = {};
  let given = 0;
  for (const [field, name] of FIELDS) {
    const value = raw[field];
    if (value === undefined || value === null) { result[name] = 0; continue; }
    if (!Number.isSafeInteger(value) || value < 0) return { ok: false, reason: `${what}的 ${field} 不是非负整数` };
    result[name] = value; given++;
  }
  return given ? { ok: true, counts: result } : { ok: false, reason: `${what}没有任何 token 字段` };
}

// `{ ok: true, usage: null }` for none reported; otherwise `{ ok: true, usage: { input, output, cacheRead, cacheWrite } }`, or
// `{ usage: { breakdown: [{ model, ...counts }] } }` of a turn that used several models (the only source then, the top
// level not counted beside it); `{ ok: false, reason }` for anything else, never thrown.
export function normalizeTurnUsage(raw) {
  if (raw === undefined || raw === null) return { ok: true, usage: null };
  if (!isObject(raw)) return { ok: false, reason: 'usage 不是对象' };
  if (!('breakdown' in raw)) {
    const top = counts(raw, 'usage');
    return top.ok ? { ok: true, usage: top.counts } : top;
  }
  const { breakdown } = raw;
  if (!Array.isArray(breakdown) || !breakdown.length) return { ok: false, reason: 'breakdown 不是非空数组' };
  const byModel = new Map();
  for (const item of breakdown) {
    if (!isObject(item)) return { ok: false, reason: 'breakdown 的项不是对象' };
    const model = modelName(item.model);
    if (!model) return { ok: false, reason: 'breakdown 的 model 不是 1–200 字、不含 NUL 的文本' };
    const each = counts(item, `模型 ${model}`);
    if (!each.ok) return each;
    const sum = byModel.get(model) ?? { model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    for (const [, name] of FIELDS) sum[name] += each.counts[name];
    if (!Number.isSafeInteger(sum.input) || !Number.isSafeInteger(sum.output) || !Number.isSafeInteger(sum.cacheRead) || !Number.isSafeInteger(sum.cacheWrite))
      return { ok: false, reason: `模型 ${model} 的合计超出安全整数` };
    byModel.set(model, sum);
  }
  return { ok: true, usage: { breakdown: [...byModel.values()] } };
}
