// 模块插件单测用的极简内存 `coda`：只实现被测插件模块实际用到的接口，不含 Coda 后端的任何实现。
//   records：get / list / watch / put / delete / replace，内存里按插件的 key 写，ID 由 key 派生（../plugins/records.mjs）；
//   handle / self.handle / settings / views.register / stream / serve：登记处理函数，经返回对象的 `call` `self` `stream` `serve` 当调用方去问；
//   spec、status、操作的输入输出按协议定义校验（@coda-console/protocol/validate 的 pointProblem）。
// 并发组（coda/group@1）的写入只照 Coda 对组记录的几条规定：status 归 Coda、组名无空白、本机组名唯一、lends 只给容量 1。
//
//   const host = createMockCoda({ plugin: { id: 'android', protocols }, settings, records });
//   await activate(host.coda);
//   await host.call({ kind, id }, 'lend', { holder });
import { isDeepStrictEqual } from 'node:util';
import { readFrames, writeFrames } from '@coda-console/protocol/frames';
import { pointProblem } from '@coda-console/protocol/validate';
import { recordId, validKey } from '../plugins/records.mjs';

// 本机的后端：写进来的记录归它，`owner` 为它的是本机的记录。
export const TEST_OWNER = '7e57a057-0000-4000-8000-000000000000';
const GROUP = 'coda/group@1';

const fail = (code, message, effects = 'none') => Object.assign(new Error(message), { code, effects });
// 值不合 schema 就按 invalid_input 失败；`schema` 缺省（协议没给出）不校验。
const check = (schema, value, where) => {
  const problem = schema && pointProblem(schema, value, where);
  if (problem) throw fail('invalid_input', problem);
};

// 登记一个处理函数：撤销时从表里拿掉，并让它手上的请求停下（`signal`）。
function registry() {
  const entries = new Map();
  return {
    add(key, fn) {
      if (entries.has(key)) throw new TypeError(`已登记：${key}`);
      const ended = new AbortController(), entry = { fn, ended };
      entries.set(key, entry);
      return { dispose() { if (entries.get(key) === entry) entries.delete(key); ended.abort(); } };
    },
    get: key => entries.get(key),
    clear() { for (const { ended } of entries.values()) ended.abort(); entries.clear(); },
  };
}

// 组记录按 Coda 对它的规定检查（spec 已给出）；`records`：本机此刻所有组记录。
function checkGroup(spec, records) {
  if (!/^\S{1,100}$/.test(spec.name)) throw fail('invalid_input', `组名：1–100 个非空白字符，不是 ${JSON.stringify(spec.name)}`);
  const missing = (spec.unique ?? []).find(key => !spec.attributes?.[key]);
  if (missing !== undefined) throw fail('invalid_input', `组 ${spec.name} 的 unique 列了没有或为空的属性 ${missing}`);
  if (spec.lends && (spec.capacity ?? 1) !== 1) throw fail('invalid_input', `组 ${spec.name} 写了 lends，容量须为 1`);
  const same = records.filter(entry => entry.spec.name === spec.name);
  if (same.length > 1) throw fail('conflict', `本机已有组 ${spec.name}（${same.map(entry => `${entry.plugin} 的 ${entry.id}`).join('，')}）`);
}

// `plugin`：被测插件的 `id`、`state` 目录、清单里的 `protocols`（校验记录与操作）；`settings`：开始时的设置；
// `records`：别处的记录 `{ kind, id, spec, status?, owner?, location?, plugin? }`：`owner` 缺省为 `other`（别的机器的），
// 为 TEST_OWNER 时是本机上别的插件（`plugin` 缺省 `other`）的；`protocols`：别的插件的协议定义。
export function createMockCoda({ plugin = {}, settings = {}, records = [], protocols = [] } = {}) {
  const id = plugin.id ?? 'test';
  const definitions = new Map([...protocols, ...(plugin.protocols ?? [])].map(definition => [definition.name, definition]));
  const handlers = registry(), selfHandlers = registry(), streams = registry(), services = registry();
  let current = structuredClone(settings), version = 0;
  const listeners = new Set();

  // 记录：按种类，各为一份「持有者与 ID → 条目」；本插件写的另记 ID → key。
  const kept = new Map(), held = new Map(), watching = new Set();
  const place = (owner, recordId) => JSON.stringify([owner, recordId]);
  const of = kind => { if (!kept.has(kind)) { kept.set(kind, new Map()); held.set(kind, new Map()); } return kept.get(kind); };
  const entry = ({ owner, location = owner, id, plugin: by, spec, status = {}, labels }) =>
    ({ owner, location, id, plugin: by, local: owner === TEST_OWNER, spec, status, ...(labels === undefined ? {} : { labels }), version: String(++version) });
  for (const { kind, owner = 'other', plugin: by = owner === TEST_OWNER ? 'other' : id, ...rest } of records)
    of(kind).set(place(owner, rest.id), entry({ owner, plugin: by, ...rest }));

  const asRead = (kind, one) => structuredClone(one.local && held.get(kind).has(one.id) ? { ...one, key: held.get(kind).get(one.id) } : one);
  const matching = (kind, { scope = 'available', id: only } = {}) => [...of(kind).values()]
    .filter(one => (scope === 'available' || one.local) && (only === undefined || one.id === only))
    .sort((a, b) => Number(b.local) - Number(a.local)).map(one => asRead(kind, one));

  // 一次写：`change(records, mine)` 在副本上改，合格才换上，再把变化告诉这一类的监听。
  function written(kind, change) {
    const before = of(kind), next = new Map(before), mine = new Map(held.get(kind));
    const result = change(next, mine);
    if (kind === GROUP) {
      const local = [...next.values()].filter(one => one.local);
      for (const one of local) checkGroup(one.spec, local);
    }
    kept.set(kind, next); held.set(kind, mine);
    for (const [at, one] of next) if (before.get(at) !== one) tell(kind, before.has(at) ? 'MODIFIED' : 'ADDED', one);
    for (const [at, one] of before) if (!next.has(at)) tell(kind, 'DELETED', one);
    return result;
  }
  function tell(kind, type, one) {
    for (const watch of watching) {
      if (watch.kind !== kind || (watch.scope !== 'available' && !one.local) || (watch.id !== undefined && watch.id !== one.id)) continue;
      Promise.resolve().then(() => watch.listener({ type, id: one.id, entry: asRead(kind, one) })).catch(() => {});
    }
  }
  // 一条记录按插件的 key 写进副本：只写 { spec, status?, labels? }；组的 status 归 Coda（容量 1 的 free，更大的没有）。
  function put(next, mine, kind, key, value) {
    if (!validKey(key) || key.includes('\0')) throw fail('invalid_input', `记录 key 须为 1–256 个字符的文本，不是 ${JSON.stringify(key)}`);
    if (!value || Object.keys(value).some(name => !['spec', 'status', 'labels'].includes(name))) throw fail('invalid_input', '记录只写 { spec, status?, labels? }');
    const recordKey = recordId(id, kind, key), at = place(TEST_OWNER, recordKey), old = next.get(at), definition = definitions.get(kind);
    if (kind === GROUP && 'status' in value) throw fail('invalid_input', `${kind} 的 status 归 Coda 维护，插件只写 spec`);
    const status = kind === GROUP ? ((value.spec.capacity ?? 1) === 1 ? { state: 'free' } : {}) : value.status ?? old?.status ?? {};
    check(definition?.spec, value.spec, 'spec'); check(definition?.status, status, 'status');
    mine.set(recordKey, key);
    const same = old && isDeepStrictEqual(old.spec, value.spec) && isDeepStrictEqual(old.status, status) && isDeepStrictEqual(old.labels, value.labels);
    if (!same) next.set(at, entry({ owner: TEST_OWNER, location: 'local', id: recordKey, plugin: id, spec: value.spec, status, labels: value.labels }));
    return { ...next.get(at), key };
  }

  const coda = {
    plugin: { id, path: plugin.path ?? process.cwd(), state: plugin.state ?? null },
    async get({ kind, id: recordId }) {
      const [found] = matching(kind, { id: recordId });
      if (!found) throw fail('not_found', `没有记录 ${kind}/${recordId}`);
      return found;
    },
    async list(kind, filter) { return matching(kind, filter); },
    // 先把现有的告诉它（ADDED），之后每次变化再告诉。
    async watch(kind, listener, { scope = 'available', id: only } = {}) {
      const watch = { kind, listener, scope, id: only };
      watching.add(watch);
      for (const one of matching(kind, { scope, id: only })) Promise.resolve().then(() => watch.listener({ type: 'ADDED', id: one.id, entry: one })).catch(() => {});
      return { dispose() { watching.delete(watch); } };
    },
    async put({ kind, key }, value) { return structuredClone(written(kind, (next, mine) => put(next, mine, kind, key, value))); },
    async delete({ kind, key }) {
      written(kind, (next, mine) => {
        const recordKey = recordId(id, kind, key);
        next.delete(place(TEST_OWNER, recordKey)); mine.delete(recordKey);
      });
    },
    // 本插件在这一类里的记录整份换成 `items`（各 `{ key, spec, … }`），不在其中的撤下；全成或全不成。
    async replace(kind, items) {
      if (!Array.isArray(items) || items.some(item => !item || typeof item !== 'object' || 'id' in item)) throw fail('invalid_input', 'replace 的记录须为 [{ key, spec, … }]，不带 id');
      if (new Set(items.map(item => item.key)).size !== items.length) throw fail('invalid_input', 'replace 的记录 key 重复');
      return structuredClone(written(kind, (next, mine) => {
        const entries = items.map(({ key, ...value }) => put(next, mine, kind, key, value));
        for (const [at, one] of next) if (one.local && one.plugin === id && !entries.some(({ id: kept }) => kept === one.id)) { next.delete(at); mine.delete(one.id); }
        return entries;
      }));
    },
    handle: (kind, operation, fn) => handlers.add(`${kind}/${operation}`, fn),
    self: { handle: (name, fn) => selfHandlers.add(name, fn) },
    settings: {
      get: async () => structuredClone(current),
      onChange(listener) { listeners.add(listener); return { dispose() { listeners.delete(listener); } }; },
    },
    views: { register() { return { dispose() {} }; } },
    // `(request, { record, input, caller, signal }) => Response`：`signal` 在调用方走掉或登记撤销时响。
    stream: (kind, name, fn) => streams.add(`${kind}/${name}`, fn),
    // `(request, { caller, signal }) => Response`
    serve: (service, fn) => services.add(service, fn),
    frames: Object.freeze({ read: readFrames, write: writeFrames }),
    error: (code, message, options) => fail(code, message, options?.effects),
  };

  // 处理函数的 signal：登记撤销，或调用方走掉（请求的 signal 响）。
  function handlerSignal(found, request) {
    const gone = new AbortController();
    for (const from of [found.ended.signal, request.signal]) from.addEventListener('abort', () => gone.abort(from.reason), { once: true });
    return gone.signal;
  }
  // 问一个处理函数。
  const ask = (found, request, context) => found.fn(request, { ...context, signal: handlerSignal(found, request) });
  const recordFor = ({ kind, id: recordId }) => held.get(kind)?.has(recordId) ? { kind, id: recordId, key: held.get(kind).get(recordId) } : { kind, id: recordId };

  return {
    coda,
    // 调用方调本插件登记的操作（`coda.handle`）：输入、结果按协议定义校验，失败带 `code`。
    async call(record, operation, input = {}) {
      const found = handlers.get(`${record?.kind}/${operation}`);
      if (!found) throw fail('not_found', `插件没有登记 ${record?.kind}/${operation}`);
      const definition = definitions.get(record.kind)?.operations?.[operation];
      check(definition?.input, input, '输入');
      const result = await found.fn(structuredClone(input), { record: recordFor(record), signal: found.ended.signal });
      check(definition?.result, result ?? null, '结果');
      return structuredClone(result ?? null);
    },
    // 本插件登记的自用查询（`coda.self.handle`），没有登记的是 not_found。
    async self(name, input = {}) {
      const found = selfHandlers.get(name);
      if (!found) throw fail('not_found', `插件没有登记 self ${name}`);
      return structuredClone(await found.fn(structuredClone(input), { signal: found.ended.signal }) ?? null);
    },
    // 一个记录的流：协议定义里有这个流，方法只收 GET、POST（http 形状）；read 形状的参数取自查询串，按定义的 input 校验。
    async stream(record, name, request, { caller = { local: true } } = {}) {
      const definition = definitions.get(record?.kind)?.streams?.[name], found = streams.get(`${record?.kind}/${name}`);
      if (!definition || !found) throw fail('not_found', `插件没有登记 ${record?.kind} 的流 ${name}`);
      if (!['GET', 'POST'].includes(request.method)) throw fail('method_not_allowed', `${record.kind} 的流 ${name} 只收 GET、POST`);
      const input = (definition.shape ?? 'read') === 'read' ? Object.fromEntries(new URL(request.url).searchParams) : {};
      check(definition.input, input, '参数');
      return ask(found, request, { record: recordFor(record), input, caller });
    },
    async serve(service, request, { caller = { local: true } } = {}) {
      const found = services.get(service);
      if (!found) throw fail('not_found', '插件没有登记这个流式服务');
      return ask(found, request, { caller });
    },
    // 设置换成 `next`，告诉 onChange 的监听；等它们到这一轮事件循环（再慢的留着不等）。
    async setSettings(next) {
      current = structuredClone(next);
      const told = [...listeners].map(async listener => listener(structuredClone(current)));
      await Promise.race([Promise.allSettled(told), new Promise(resolve => setImmediate(resolve))]);
    },
    close() { for (const one of [handlers, selfHandlers, streams, services]) one.clear(); listeners.clear(); watching.clear(); },
  };
}
