// The plugin host's local API. `handle` keeps a plugin's operation handlers in `operations`, by kind and operation, for the protocols
// its manifest implements.
import { ContractError } from '../domain/errors.mjs';
import { abortError, bounded, checkResult, EFFECTS, timeoutError } from './call-limit.mjs';
export { abortError };

const CODE = /^[a-z][a-z0-9_]{0,63}$/;
const sayable = ({ code, effects, retryAfterMs }) => typeof code === 'string' && CODE.test(code)
  && (effects === undefined || EFFECTS.includes(effects)) && (retryAfterMs === undefined || (Number.isSafeInteger(retryAfterMs) && retryAfterMs >= 0));
// `coda.error`: a failure a handler throws, with its code, how much it did (`effects`, unsaid `unknown`) and how long its
// caller had better wait before asking again.
export function codaError(code, message, { effects, retryAfterMs } = {}) {
  if (!sayable({ code, effects, retryAfterMs })) throw new TypeError('coda.error(code, message, { effects?, retryAfterMs? })：code 是小写字母、数字和「_」，effects 是 none、some 或 unknown，retryAfterMs 是非负整数毫秒');
  return new ContractError(code, String(message), { effects, retryAfterMs });
}
// A failure as it crosses the plugin host's channel. One that says no code, or not as `coda.error` would, is the handler's
// own, of which nothing is known (`handler_error`, `unknown`), whatever `effects` it says. What goes out is made first, and
// its envelope is what 1 MiB is of (`bounded`, adapters/call-limit.mjs). `effects`, given: what it says instead, whatever
// the handler says — a query's, `none`, as it only reads.
export function failureOf(error, effects = null) {
  const message = String(error?.message ?? error);
  if (!error || typeof error !== 'object' || !sayable(error)) return bounded({ code: 'handler_error', message, effects: effects ?? 'unknown' });
  return bounded({ code: error.code, message, effects: effects ?? error.effects ?? 'unknown', ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }) });
}
// What crossed the channel as an error, an error again: a failure as `failureOf` says it, or a message alone.
export function failed(said) {
  if (!said || typeof said !== 'object') return new Error(String(said));
  const { code, message, effects, retryAfterMs } = failureOf(said);
  return new ContractError(code, message, { effects, retryAfterMs });
}
// Why a call was called off, as it crosses the channel, and as its handler's `ctx.signal` goes off with it again: its caller
// gave up (`AbortError`), or its deadline passed (a query's `timeout`; a doing call's `TimeoutError`, coda#2749 3.3).
export const cancelOf = reason => ['AbortError', 'TimeoutError'].includes(reason?.name) ? { name: reason.name } : failureOf(reason);
export const canceled = said => said?.name === 'AbortError' ? abortError() : said?.name === 'TimeoutError' ? timeoutError() : failed(said);
// A call its caller gave up on with `signal`: failing with the reason it went off with itself — of a handler's `ctx.signal`,
// the reason the call it is made under was called off with (`AbortError`, `TimeoutError`), which the handler, throwing it,
// ends that call by — whatever it is (`abort` takes any value), and, an object that can take it, saying how much was done
// (`effects`) unless it says so already.
export function givenUp(signal, effects) {
  const reason = signal.reason;
  if (Object.isExtensible(reason) && reason.effects === undefined) reason.effects = effects;
  return reason;
}
// What a module's handler of a doing call ended with (adapters/plugin-modules.mjs `run`), as the call's outcome (coda#2749
// 3.2): called off, as it said; failed, as `failureOf` says; completed, with a result as the operation (`found`) has it and
// within 1 MiB, or else a `handler_error` of unknown effect.
export function outcomeOf(found, name, said) {
  if (said?.outcome === 'canceled') return { outcome: 'canceled' };
  if (said?.outcome === 'failed') return { outcome: 'failed', error: failureOf(said.error) };
  try {
    checkResult(found, name, said?.result);
    return { outcome: 'completed', result: said.result };
  } catch (error) { return { outcome: 'failed', error: { code: 'handler_error', message: error.message, effects: 'unknown' } }; }
}

// A handler of an operation of a protocol the plugin implements, kept in `operations` as `{ run, resume }`: a function, or
// (`coda.handle`, coda#2749 3.1) `{ run, resume? }`, `resume` kept for what a later host does with it. `self` is no protocol
// (`invalid_input`): a query only the plugin's own processes make, which no manifest lists (`coda self`, docs/plugins.md
// 「只给自己用的查询」), is registered by its name with `coda.self.handle` and kept under `self`, which no protocol's name is.
function registrar(plugin, operations) {
  const register = (kind, operation, entry) => {
    const id = JSON.stringify([kind, operation]);
    if (operations.has(id)) throw new TypeError(`已登记：${kind}/${operation}`);
    operations.set(id, entry);
    return { dispose: () => { if (operations.get(id) === entry) operations.delete(id); } };
  };
  return {
    handle(kind, operation, handler) {
      const { run, resume } = typeof handler === 'function' ? { run: handler } : handler ?? {};
      if (typeof kind !== 'string' || !kind || typeof operation !== 'string' || !operation || typeof run !== 'function'
        || (resume !== undefined && typeof resume !== 'function')) throw new TypeError('handle(协议名, 操作, handler 或 { run, resume? })');
      if (kind === 'self') throw new ContractError('invalid_input', 'self 不是协议：只给自己用的查询用 coda.self.handle(名字, handler) 登记', { effects: 'none' });
      if (!(plugin.protocolImplementations ?? []).includes(kind)) throw new TypeError(`插件 ${plugin.id} 没有实现 ${kind}`);
      return register(kind, operation, { run, resume });
    },
    self(name, handler) {
      if (typeof name !== 'string' || !name || typeof handler !== 'function') throw new TypeError('self.handle(名字, handler)');
      return register('self', name, { run: handler });
    },
  };
}

// What a module queries and answers by (coda#2749 3.1–3.5, 6): `handle` an operation of a protocol it implements, a query
// or a doing call, its handler's return value the result and what it throws the failure; `self.handle` a query of its own
// processes'; `query` a query of any record's, through the backend's unified call
// (`send(request, signal)`), failing as one that did nothing (`none`), as it only reads, or, given up on with its `signal`,
// with that signal's reason itself, `none` added unless it says its own `effects` (`givenUp`) — a handler's `ctx.signal`'s
// `TimeoutError`, of its own doing call, `unknown`, thrown as it is; `error`, a failure to throw. `within(signal, deadline)`: `query` as
// a handler's `ctx.query` is, given up on as the call it is made under is, and given at most the time left of it. Doing an
// operation (one not `safe`, an `idempotent` one too) is no query: it is a call (`callingAPI`).
export function queryingAPI({ send, plugin, operations }) {
  const register = registrar(plugin, operations);
  async function query(record, operation, input = {}, options = {}, within = null) {
    if (!record || typeof record.kind !== 'string' || typeof record.id !== 'string' || typeof operation !== 'string' || !operation)
      throw new TypeError('query({ kind, id }, 操作, 输入?, { signal?, timeout? })');
    const { signal = null, timeout = null } = options ?? {};
    if (options?.id !== undefined) throw new TypeError('查询两边都不留，没有 options.id');
    if (timeout !== null && !(Number.isSafeInteger(timeout) && timeout > 0)) throw new TypeError('timeout 须为正整数毫秒');
    const given = within ? (signal ? AbortSignal.any([signal, within.signal]) : within.signal) : signal;
    if (given?.aborted) throw givenUp(given, 'none');
    try { return await send({ record: { kind: record.kind, id: record.id }, operation, input, timeout, deadline: within?.deadline ?? null }, given); }
    catch (error) {
      if (!(given?.aborted && error === given.reason) && Object.isExtensible(error)) error.effects = 'none';
      throw error;
    }
  }
  return {
    handle: register.handle,
    self: Object.freeze({ handle: register.self }),
    query: (record, operation, input, options) => query(record, operation, input, options),
    error: codaError,
    within: (signal, deadline) => (record, operation, input, options) => query(record, operation, input, options, { signal, deadline }),
  };
}

// What a module does by (docs/plugins.md「做事的调用」): `call` a doing operation of any record's (one not `safe`, an
// `idempotent` one too), through the call kernel from the plugin's address (`send(request, signal, onProgress)`): its result, or a
// failure as `failed` says, one cancelled an `AbortError`, one past its time a `TimeoutError`, each with its `code` and
// `effects`. `options.id`, its idempotency key: the same call again, or refused (`idempotency_conflict`) for other content.
// Given up on with its `signal`, it fails as an `AbortError` at once, the call cancelled. `within(signal, deadline, under)`:
// `call` as a doing call's handler's `ctx.call` is, made by that call (the backend's request `under` which it came), given
// up on as it is, and given at most the time it has left.
export function callingAPI(send) {
  const named = error => error?.code === 'canceled' ? Object.assign(error, { name: 'AbortError' }) : error?.code === 'timeout' ? Object.assign(error, { name: 'TimeoutError' }) : error;
  async function call(record, operation, input = {}, options = {}, within = null) {
    if (!record || typeof record.kind !== 'string' || typeof record.id !== 'string' || typeof operation !== 'string' || !operation)
      throw new TypeError('call({ kind, id }, 操作, 输入?, { id?, signal?, timeout?, onProgress? })');
    const { id = null, signal = null, timeout = null, onProgress = null } = options ?? {};
    if (id !== null && !(typeof id === 'string' && id && id.length <= 2048)) throw new TypeError('id 须为不超过 2048 字的字符串');
    if (timeout !== null && !(Number.isSafeInteger(timeout) && timeout > 0)) throw new TypeError('timeout 须为正整数毫秒');
    if (onProgress !== null && typeof onProgress !== 'function') throw new TypeError('onProgress 须为函数');
    const given = within ? (signal ? AbortSignal.any([signal, within.signal]) : within.signal) : signal;
    if (given?.aborted) throw givenUp(given, 'none');
    try {
      return await send({ record: { kind: record.kind, id: record.id }, operation, input, id, timeout, deadline: within?.deadline ?? null,
        under: within?.under ?? null, progress: onProgress !== null }, given, onProgress);
    } catch (error) { throw named(error); }
  }
  return {
    call: (record, operation, input, options) => call(record, operation, input, options),
    within: (signal, deadline, under) => (record, operation, input, options) => call(record, operation, input, options, { signal, deadline, under }),
  };
}

// What is left of `coda.protocols` beside `register` (adapters/plugin-modules.mjs): `resolve`, a record's service as this
// machine reaches it, and `upload`, an upload of this machine a post to a session names.
export function providerAPI({ call, connection }) {
  return {
    async resolve(ref, service) {
      const { resource, path } = await call('resolve', [ref, service]);
      const api = connection();
      return { resource, url: `${api.url}${path}`, headers: { authorization: `Bearer ${api.token}` } };
    },
    // `{ id, name, size, mime?, duration?, …, path }`.
    upload: id => call('upload', [id]),
  };
}
