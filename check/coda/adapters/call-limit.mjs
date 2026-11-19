// What a call goes by (docs/plugins.md「调用」), the same for the backend's unified call (components/protocols/calls.mjs)
// and a plugin's test host (adapters/plugin-test-host.mjs): the operation's own `timeout`, or 30 seconds, from now on
// `clock` (adapters/clock.mjs), or the caller's `deadline` when that is earlier; its input and result as the operation's
// definition has them (`found`, as components/protocols/types.mjs compiles it); its envelope at most 1 MiB encoded.
import { ContractError, requireCondition as check } from '../domain/errors.mjs';

export const TIMEOUT = 30_000, ENVELOPE = 1024 * 1024;
const encoded = value => Buffer.byteLength(JSON.stringify(value));
// A request's envelope, refused past 1 MiB.
export const checkRequest = request => check(encoded(request) <= ENVELOPE, 'invalid_input', '调用信封超过 1 MiB');
// `name`: the record's protocol and the operation, as said in a refusal.
export const checkInput = (found, name, input) => check(found.input(input), 'invalid_input', `${name} 的输入无效`);
// An operation that opens a run (`run: true`) has no result of its own to check.
export function checkResult(found, name, result) {
  check(!found.result || found.result(result), 'internal_error', `${name} 的结果无效`);
  check(encoded({ result }) <= ENVELOPE, 'handler_error', `${name} 的回答超过 1 MiB`);
}
// How much a call that failed did (docs/plugins.md「调用」): nothing, some of it, or none can say.
export const EFFECTS = ['none', 'some', 'unknown'];
// A failure is an envelope too, `{ error: said }`, `said` its `code`, `message`, `effects` and `retryAfterMs` as they go out,
// all strings and numbers. One that says what it may not (`effects` of none of these, a `retryAfterMs` that is no whole
// number of milliseconds) is `handler_error`, `unknown`; one whose envelope encoded then passes 1 MiB is so with a message that
// says so: wherever the failure takes shape (the plugin host's channel, the unified call).
export const FAILURE_TOO_BIG = { code: 'handler_error', message: '调用失败，原错误的信息超过 1 MiB，已丢弃', effects: 'unknown' };
export function bounded(said) {
  const { effects, retryAfterMs } = said;
  const fine = (effects === undefined || EFFECTS.includes(effects)) && (retryAfterMs === undefined || (Number.isSafeInteger(retryAfterMs) && retryAfterMs >= 0));
  const out = fine ? said : { code: 'handler_error', message: said.message, effects: 'unknown' };
  return encoded({ error: out }) <= ENVELOPE ? out : { ...FAILURE_TOO_BIG };
}
// A call its caller gave up on.
export const abortError = effects => Object.assign(new Error('调用方已放弃这次调用'), { name: 'AbortError', ...(effects ? { effects } : {}) });
// A doing call past its deadline (coda#2749 3.3), as its handler's `ctx.signal` goes off with it: thrown, a `timeout` that
// may have been done.
export const timeoutError = () => Object.assign(new ContractError('timeout', '调用超过了期限', { effects: 'unknown' }), { name: 'TimeoutError' });
// The call's `signal` goes off at its `deadline`, as a `timeout`, or when the caller's own does, as an `AbortError`.
// `end()` once settled.
export function limit(clock, found, { signal, deadline } = {}) {
  const at = Math.min(clock.now() + (found.timeout ?? TIMEOUT), deadline ?? Infinity);
  const controller = new AbortController();
  const given = () => controller.abort(abortError());
  const passed = () => controller.abort(new ContractError('timeout', '调用超过了期限，没有等到回答'));
  if (signal?.aborted) given(); else signal?.addEventListener('abort', given, { once: true });
  let unarm = () => {};
  if (at <= clock.now()) passed(); else unarm = clock.at(at, passed);
  return { signal: controller.signal, deadline: at, end: () => { unarm(); signal?.removeEventListener('abort', given); } };
}
// Goes off with the signal's reason, for what a call waits on to race; never unhandled once what it races has settled.
export const stopped = signal => {
  const promise = new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  promise.catch(() => {});
  return promise;
};
