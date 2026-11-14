// A provider's failure is judged once (agent/errors.mjs classifyProviderFault), whether OpenCode fails the prompt with it
// (its errorName) or announces a long wait on it (the HTTP status). One table, each fault through every path it reaches.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyOpenCodeError, classifyProviderFault } from '../../../plugins/opencode/agent/errors.mjs';
import { LongRetries } from '../../../plugins/opencode/agent/retries.mjs';

const NOW = Date.parse('2026-10-23T12:00:00Z');
const WAIT = 420_000;
const ZEN = 'macmini2 Zen: OpenCode Zen: Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go';
const WORKBUDDY = 'WorkBuddy: 用量已超出限制，将在 2026-10-24 17:42:38 重置';
const CAPACITY = 'Zen: OpenCode Go 2: Upstream request failed: [ttft_admission_refused] the cell is at capacity; retry shortly (after 5 s)';

// `name`: OpenCode's errorName on a failed prompt; `status`: the provider's status on a long wait. A fault with only one of them
// reaches only that path (a dropped connection has no status).
const FAULTS = [
  { name: 'provider.quota', message: 'Quota exceeded', kind: 'quota_exhausted' },
  { name: 'provider.free-limit', status: 402, message: ZEN, kind: 'quota_exhausted' },
  { name: 'provider.rate-limit', status: 429, message: WORKBUDDY, kind: 'quota_exhausted' },
  { name: 'provider.internal', status: 503, message: ZEN, kind: 'quota_exhausted' },
  { name: 'provider.rate-limit', status: 429, message: 'Too Many Requests', kind: 'service_unavailable' },
  { name: 'provider.internal', status: 502, message: 'Upstream request failed: Bad Gateway', kind: 'service_unavailable' },
  { name: 'provider.internal', status: 429, message: CAPACITY, kind: 'service_unavailable' },
  { name: 'provider.timeout', status: 408, message: 'Timeout', kind: 'service_unavailable' },
  { name: 'provider.transport', message: 'dial tcp 100.124.1.28:3425: connect: connection refused', kind: 'service_unavailable' },
  { name: 'provider.auth', status: 401, message: 'Too Many Requests', kind: null },
  { name: 'provider.auth', status: 403, message: ZEN, kind: null },
  { name: 'provider.content-filter', status: 400, message: 'Content filtered', kind: null },
  { name: 'provider.invalid-request', status: 400, message: 'context_length_exceeded', kind: null },
  { name: 'provider.invalid-request', status: 404, message: 'Too Many Requests', kind: null },
];

const receipt = ({ name, message }) => classifyOpenCodeError({ jsonrpc: '2.0', id: 9, error: { code: -32603, message: `Internal error: ${message}`, data: { service: 'session', errorName: name } } })
  .error.data?._meta?.coda?.failure;
const wait = ({ status, message }) => {
  const waits = new LongRetries(() => {}, () => NOW);
  waits.toAgent({ jsonrpc: '2.0', id: 1, method: 'session/prompt', params: { sessionId: 'ses_a', prompt: [] } });
  waits.fromAgent({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'ses_a', update: { sessionUpdate: 'session_info_update',
    _meta: { 'opencode/retry': { attempt: 1, nextRetryAt: new Date(NOW + WAIT).toISOString(), error: { message, status } } } } } });
  return waits.fromAgent({ jsonrpc: '2.0', id: 1, result: { stopReason: 'cancelled' } }).error.data?._meta.coda.failure;
};
const expected = ({ kind }, retryAfterMs) => kind === null ? undefined : kind === 'quota_exhausted' ? { kind } : { kind, input: 'accepted', ...retryAfterMs && { retryAfterMs } };

test('the same fault gets the same category on a failed prompt, on a long wait and from the classifier itself', () => {
  for (const fault of FAULTS) {
    const label = `${fault.name} ${fault.status}: ${fault.message}`;
    assert.equal(classifyProviderFault(fault), fault.kind, label);
    if (fault.status !== undefined) assert.equal(classifyProviderFault({ status: fault.status, message: fault.message }), fault.kind, `status only: ${label}`);
    assert.deepEqual(receipt(fault), expected(fault), `receipt: ${label}`);
    if (fault.status !== undefined) assert.deepEqual(wait(fault), expected(fault, WAIT), `wait: ${label}`);
  }
});
