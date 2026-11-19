// Coda's own protocol of the tokens the turns hosted here used, `coda/usage@1`: one record, this machine's (`local`), and its
// query `buckets`, the counts kept per UTC ten minutes, agent and model (domain/usage.mjs, usage_buckets). Nothing but the counts
// is said: no session, directory, text or cost. The record is read through (Protocols.serve), nothing is kept of it, it is
// no section and not in the record directory: another machine's is not read.
import { createHash } from 'node:crypto';
import { requireCondition as check } from '../domain/errors.mjs';
import { USAGE_BUCKET_MS } from '../domain/usage.mjs';
import { canonical } from '../domain/values.mjs';

export const USAGE = 'coda/usage@1';
export const USAGE_LOCAL_ID = 'local';
export const MAX_USAGE_SPAN_MS = 90 * 24 * 60 * 60 * 1000;
// About a fortnight of active buckets at a read, and the envelope of a call is far under 1 MiB even with 200-character
// four-byte model names.
export const MAX_USAGE_LIMIT = 500;

const time = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };

export const USAGE_PROTOCOL = {
  kind: USAGE,
  title: '用量',
  spec: { type: 'object', properties: { bucketMs: { type: 'integer', minimum: 1 } }, required: ['bucketMs'], additionalProperties: false },
  status: { type: 'object', additionalProperties: false },
  operations: {
    // The buckets starting in `[from, to)`, newest first, of an agent and a model if given; `truncated` when more than `limit` are.
    buckets: { safe: true,
      input: {
        type: 'object',
        properties: {
          from: time,
          to: time,
          agent: { type: 'string', minLength: 1, maxLength: 100 },
          model: { type: 'string', minLength: 1, maxLength: 200 },
          limit: { type: 'integer', minimum: 1, maximum: MAX_USAGE_LIMIT },
        },
        required: ['from', 'to'],
        additionalProperties: false,
      },
      result: {
        type: 'object',
        properties: {
          buckets: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                start: time,
                agent: { type: 'string', minLength: 1 },
                model: { type: 'string', minLength: 1 },
                input: time,
                output: time,
                cacheRead: time,
                cacheWrite: time,
                turns: time,
                reportedTurns: time,
              },
              required: ['start', 'agent', 'model', 'input', 'output', 'cacheRead', 'cacheWrite', 'turns', 'reportedTurns'],
              additionalProperties: false,
            },
          },
          truncated: { type: 'boolean' },
        },
        required: ['buckets', 'truncated'],
        additionalProperties: false,
      } },
  },
  // What a plugin may ask for in its `uses` (docs/plugins.md「用到的权限」), on trial while the protocol is not stable.
  permissions: {
    read: { title: '查看本机的 Token 用量统计', trial: true, read: true, operations: ['buckets'] },
  },
};

const record = () => {
  const spec = { bucketMs: USAGE_BUCKET_MS }, status = {};
  return { kind: USAGE, id: USAGE_LOCAL_ID, provider: 'coda', createdAt: new Date(0).toISOString(), creationSequence: 0, spec, status,
    revision: `local:${createHash('sha256').update(canonical([spec, status])).digest('hex').slice(0, 16)}` };
};
export const usageRecords = () => ({
  get: id => id === USAGE_LOCAL_ID ? record() : null,
  list: () => [record()],
});

// Its query through the unified call (components/protocols/calls.mjs `handle`): `buckets`, read from the store as it keeps them,
// for this machine's callers alone: the record's ID is the same on every machine, so a call another backend sends is refused.
export function usageQueries(calls, { store }) {
  calls.handle(USAGE, 'buckets', ({ input }) => {
    check(input.from <= input.to, 'invalid_input', 'from 不能大于 to');
    check(input.to - input.from <= MAX_USAGE_SPAN_MS, 'invalid_input', '单次查询时间跨度不能超过 90 天');
    for (const [name, value] of [['agent', input.agent], ['model', input.model]])
      check(value === undefined || (!value.includes('\0') && value.trim().length > 0), 'invalid_input', `${name} 不能为空或含 NUL`);
    const limit = input.limit ?? MAX_USAGE_LIMIT;
    if (input.from === input.to) return { buckets: [], truncated: false };
    const rows = store.usageBuckets({ from: input.from, to: input.to, agent: input.agent, model: input.model, limit: limit + 1 });
    return { buckets: rows.slice(0, limit).map(row => ({ start: row.bucketStart, agent: row.agent, model: row.model, input: row.input, output: row.output,
      cacheRead: row.cacheRead, cacheWrite: row.cacheWrite, turns: row.turns, reportedTurns: row.reportedTurns })), truncated: rows.length > limit };
  }, { admit: ({ caller }) => check(caller === calls.self(), 'forbidden', '用量统计只在本机读取') });
}
