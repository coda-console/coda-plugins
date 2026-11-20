// A plugin host for a plugin's own tests (coda#2749 第 7 节), on the trial surface (docs/plugins.md「模块」): the module's
// real `coda` and its handlers' real `ctx`, as the plugin host makes them (adapters/plugin-modules.mjs), with no backend —
// only the channel to it is this one's. A plugin's tests activate their module with `coda`, call its handlers as a caller
// would (`call`), a query or a doing call, call one off with a signal or a timeout, see each failure with its code as a
// caller does, and see a doing call's progress and answer its questions; and hand a doing call to its `resume` as the
// backend does once the process that had it ended (`resume`); query what its module registered with `coda.self.handle` as its own
// processes do (`self`); and call the operations its commands implement, run as the backend runs them
// (adapters/plugin-command.mjs). How the backend hosts a doing call beyond that (handing it
// over, the grace after it is called off, when `resume` is called and for how long) is the backend's, and its tests'.
//
//   const host = createTestHost({ plugin: { id: 'translator', protocols, protocolImplementations: ['translator/service@1'] } });
//   await activate(host.coda);
//   await host.call({ kind: 'translator/service@1', id: 'default' }, 'translate', { text: 'x' });
//
// What the module queries (`coda.query`, `ctx.query`) of a record of a protocol it implements its own handlers answer; of
// another's, `call` given. A doing call it makes (`coda.call`, `ctx.call`) its own handlers answer, of a protocol it implements. Its settings (`coda.settings`) are those the test gives, or sets again with `setSettings`, which
// tells the module's `onChange` as the backend does. The events the test delivers (`emit`) go to its handlers (`coda.on`),
// which may name only what it subscribes to by its `uses`, as the backend has it. What it starts (`coda.spawn`, `ctx.spawn`) is a real child process of
// the test's, its streams and its end relayed as the backend relays them (adapters/process-relay.mjs), with no token and
// no entry in a registry: ended with the call or the module only as the test ends it, or as the host closes. The records
// (`coda.get`, `list`, `watch`, `put`, `delete`, `replace`, coda#2749 3.7) are those it writes, on this one machine, by its
// keys (their IDs derived as the backend derives them, of `TEST_OWNER`), and the others' the test gives (`records`), held
// to what the backend holds them to (components/protocols/record-rules.mjs, the kinds' schemas) but the record directory's
// size. Anything else of the backend's it asks is refused. A command implementing an operation is started as the module's
// processes are, with no token: what it asks with `coda` (`progress`, `ask`, `query`, `self`) is not answered here, but by the backend's.
import { CORE_PROTOCOLS, protocolHasRecords } from '@coda-console/protocol/protocol';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { ContractError } from '../domain/errors.mjs';
import { ProtocolTypes } from '../components/protocols/types.mjs';
import { commandOf, implementations } from '../components/plugins/plugin-rules.mjs';
import { subscribed } from '../components/plugins/plugin-extensions.mjs';
import { checkGiven, checkHeld, checkKept, groupType, keptStatus } from '../components/concurrency-groups/schemas.mjs';
import { validate } from '../components/protocols/types.mjs';
import { LOCAL_KINDS, checkLabels, checkReplace, checkWrite, labelled, picked, readFilter, readRef, recordId, writeRef } from '../components/protocols/record-rules.mjs';
import { canonical } from '../domain/values.mjs';
import { checkInput, checkRequest, checkResult, limit, stopped } from './call-limit.mjs';
import { Clock } from './clock.mjs';
import { callEnv, fileCommand, queryCommand, queryId, settle, startPluginCommand } from './plugin-command.mjs';
import { pluginModules } from './plugin-modules.mjs';
import { checkNamed, relayProcess, unstarted } from './process-relay.mjs';
import { cancelOf, failed, failureOf, givenUp, outcomeOf } from './provider-api.mjs';

const refused = (code, message) => new ContractError(code, message, { effects: 'none' });
// What starts a command implementing an operation: a child of the test's, in a group of its own, registered nowhere.
const unregistered = { spawn: (_owner, _entry, file, args, options) => spawn(file, args, { ...options, detached: true }), remove: () => {} };
// This machine's backend, as the records the module writes name their holder, and where they are.
export const TEST_OWNER = 'test-host';
const open = { type: 'object' };

// `plugin`: the plugin under test as its manifest has it — its `id`, the `protocols` it defines, the
// `protocolImplementations` it handles (a protocol's name, or `{ kind, commands }`) and the named `processes` it declares —
// and its `path` and `state` directories.
// `call(record, operation, input, { signal, deadline })`: what answers the module's queries of records of protocols it does not implement. `clock`: what
// the calls' deadlines go by (adapters/clock.mjs), for a test to move. `settings`: the plugin's settings to begin with.
// `records`: others' records the module reads, each `{ kind, id, spec, status?, labels?, plugin?, owner?, location? }`,
// another machine's (`owner`, by default `other`; `plugin`, by default the plugin under test) or, `owner` this one's
// (`TEST_OWNER`), another plugin's here (`plugin`, by default `other`). `protocols`: others' protocol definitions, of the
// event groups the plugin uses (its `uses`), as the backend reckons what its `coda.on` may name
// (components/plugins/plugin-events.mjs `subscribed`).
export function createTestHost({ plugin = {}, call = null, clock = new Clock(), settings = {}, records = [], protocols = [] } = {}) {
  // The protocols as the backend compiles them: Coda's own, those of its concurrency groups (RunGroups.attach), those it
  // keeps out of the record directory, and the plugin's.
  const types = new ProtocolTypes();
  for (const { name, spec, status, operations = {} } of [...Object.values(CORE_PROTOCOLS), { ...groupType, name: groupType.kind },
    ...(plugin.protocols ?? []).filter(protocolHasRecords)]) types.register({ kind: name, spec, status, operations });
  for (const kind of LOCAL_KINDS) if (!types.types.has(kind)) types.register({ kind, spec: open, status: open, operations: {} });
  const manifest = { protocolImplementations: implementations(plugin.protocolImplementations ?? []) };
  const implemented = manifest.protocolImplementations.map(entry => entry.kind);
  const operationOf = (kind, operation) => types.types.get(kind)?.operations.get(operation);
  // The plugin, and what the backend would have of it and of the other plugins as its catalog: its protocols, what it
  // implements and uses, and the others' protocols.
  const id = plugin.id ?? 'test', entry = { id, protocols: plugin.protocols ?? [], protocolImplementations: manifest.protocolImplementations, uses: plugin.uses ?? {} };
  const catalog = new Map([[id, entry], [' ', { protocols }]]);
  const described = { id, path: plugin.path ?? process.cwd(), state: plugin.state ?? null, protocolImplementations: implemented,
    events: subscribed(entry, catalog, () => null) };
  // Requests to the module waiting for its answer, the module's queries under way, and the doing calls handed to it, with what
  // their caller is told of them, by the request's ID each.
  const waiting = new Map(), querying = new Map(), runs = new Map();
  // The processes the module started, by the key it gave each, until they have exited.
  const started = new Map();
  let next = 0, current = JSON.parse(JSON.stringify(settings));
  // Goes off as the host closes: the commands running are killed with it.
  const ending = new AbortController();
  // What the module sends the backend, taken after the turn it is sent in, as over a process's channel.
  const modules = pluginModules({ send: message => queueMicrotask(() => taken(message)) });
  // `coda.pluginSetup`, a part the backend provides, is there as the module has it, but fails: the test host has no backend to ask.
  const setup = () => ({ retry: async () => { throw refused('unsupported', '测试宿主不提供 coda.pluginSetup'); } });
  const coda = modules.adopt(described, randomUUID(), [['pluginSetup', setup]]);
  // The records, by kind, each an entry (`{ owner, location, id, plugin, local, spec, status, labels?, version }`) by its holder and
  // ID, and the keys of those of each kind the plugin holds, by their IDs (record-rules.mjs `recordId`); and the module's
  // watches of them, by the watch's key, each with what it was last told.
  let version = 0;
  const kept = new Map(), held = new Map(), watching = new Map();
  const idOf = (kind, key) => recordId(TEST_OWNER, described.id, kind, key);
  const keyOf = entry => JSON.stringify([entry.owner, entry.id]);
  const entryOf = ({ owner, location, id, plugin, spec, status, labels }) =>
    ({ owner, location, id, plugin, local: owner === TEST_OWNER, spec, status, ...(labels === null ? {} : { labels }), version: String(++version) });
  const kindOf = kind => {
    if (typeof kind !== 'string' || !types.types.has(kind)) throw refused('not_found', `没有协议：${kind}`);
    if (!kept.has(kind)) { kept.set(kind, new Map()); held.set(kind, new Map()); }
    return kept.get(kind);
  };
  for (const { kind, id, spec, status = {}, labels = null, owner = 'other', location = owner, plugin = owner === TEST_OWNER ? 'other' : described.id } of records)
    kindOf(kind).set(keyOf({ owner, id }), entryOf({ owner, location, id, plugin, spec, status, labels }));
  // As the plugin reads them: its own with their keys.
  const listed = (kind, filter) => {
    const { scope, id, labels } = readFilter(filter), records = kindOf(kind), mine = held.get(kind);
    return [...records.values()].filter(entry => (scope === 'available' || entry.local) && (id === undefined || entry.id === id) && labelled(entry.labels, labels))
      .sort(({ local: one }, { local: other }) => Number(other) - Number(one))
      .map(entry => entry.local && mine.has(entry.id) ? { ...entry, key: mine.get(entry.id) } : entry);
  };
  // The record a call is of, as the module's handler is given it (`ctx.record`): the plugin's own with its key.
  const recordFor = ({ kind, id }) => held.get(kind)?.has(id) ? { kind, id, key: held.get(kind).get(id) } : { kind, id };
  // Written as the backend writes it (components/protocols/providers.mjs), all of it or, refused, none of it: by the
  // plugin's key, its ID derived from it; made by a plugin implementing its kind, then its holder's alone; its spec and
  // status as its kind's schemas have them, defaults filled in, one not given as Coda keeps it (schemas.mjs `keptStatus`: a
  // group's of capacity 1 `free` unless it is lent); unchanged, no new version; what it leaves of the groups'
  // names checked as a whole. Then each watch of the kind is told what moved, as the plugin host tells it
  // (components/plugins/plugin-host.mjs). Answered with the entries of the IDs `fn` says, as the plugin reads them.
  function written(kind, fn) {
    const records = new Map(kindOf(kind)), mine = new Map(held.get(kind));
    // Coda's kinds only this machine keeps (record-rules.mjs `LOCAL_KINDS`), as the backend refuses them
    // (components/protocols/providers.mjs `writing`).
    if (LOCAL_KINDS.has(kind)) throw refused('forbidden', `插件不能写 ${kind}：它的记录只在本机，由 Coda 自己维护`);
    const hold = key => {
      const id = idOf(kind, key), at = keyOf({ owner: TEST_OWNER, id });
      if (records.has(at) ? !mine.has(id) : !implemented.includes(kind)) throw refused('forbidden', `插件 ${described.id} 不能写 ${kind}/${key}`);
      return [id, at];
    };
    const put = (key, value) => {
      checkWrite(value); checkGiven(kind, value);
      const [id, at] = hold(key), before = records.get(at), given = structuredClone(value), { spec, labels = null } = given, type = types.types.get(kind);
      validate(type.spec, spec, `${kind}.spec`);
      const status = Object.hasOwn(given, 'status') ? given.status : keptStatus(kind, spec, before ?? null);
      validate(type.status, status, `${kind}.status`); checkLabels(labels);
      checkHeld({ kind, id, spec, status });
      mine.set(id, key);
      if (!before || canonical([before.spec, before.status, before.labels ?? null]) !== canonical([spec, status, labels]))
        records.set(at, entryOf({ owner: TEST_OWNER, location: TEST_OWNER, id, plugin: described.id, spec, status, labels }));
      return id;
    };
    const remove = key => { const [id, at] = hold(key); records.delete(at); mine.delete(id); };
    let answer;
    try {
      answer = fn({ put, remove, mine });
      checkKept(kind, [...records.values()].filter(({ local }) => local));
    } catch (error) { throw error instanceof ContractError ? error : refused('invalid_input', error.message); }
    kept.set(kind, records); held.set(kind, mine);
    for (const [key, watch] of watching) {
      if (watch.kind !== kind) continue;
      const now = new Map(listed(kind, watch.filter).map(entry => [keyOf(entry), entry])), events = [];
      for (const [id, entry] of now) if (canonical(entry) !== canonical(watch.seen.get(id) ?? null)) events.push({ type: watch.seen.has(id) ? 'MODIFIED' : 'ADDED', id, object: entry });
      for (const [id, entry] of watch.seen) if (!now.has(id)) events.push({ type: 'DELETED', id, object: entry });
      watch.seen = now;
      // A copy, as a message over the channel is: what the module does with it is none of the records.
      if (events.length) modules.receive({ method: 'changed', params: { watch: key, events: structuredClone(events) } });
    }
    const entry = id => listed(kind, { scope: 'local', id })[0];
    return Array.isArray(answer) ? answer.map(entry) : answer === null ? null : entry(answer);
  }
  const recordRequests = {
    getRecord: ([ref]) => { const read = readRef(ref); return picked(listed(read.kind, { id: read.id })); },
    listRecords: ([kind, filter]) => listed(kind, filter),
    putRecord: ([ref, value]) => written(ref?.kind, ({ put }) => put(writeRef(ref).key, value)),
    deleteRecord: ([ref]) => written(ref?.kind, ({ remove }) => { remove(writeRef(ref).key); return null; }),
    replaceRecords: ([kind, entries]) => written(kind, ({ put, remove, mine }) => {
      const given = new Set(checkReplace(entries).map(key => idOf(kind, key)));
      for (const [id, key] of [...mine]) if (!given.has(id)) remove(key);
      return entries.map(({ key, ...value }) => put(key, value));
    }),
  };

  function taken(message) {
    if (!message.method) {
      const asked = waiting.get(message.id);
      waiting.delete(message.id);
      if (message.error !== undefined) asked?.reject(failed(message.error)); else asked?.resolve(message.result);
      return;
    }
    if (message.method === 'cancel') return querying.get(message.params?.id)?.abort();
    if (message.method === 'progress') return runs.get(message.params?.run)?.onProgress?.(message.params.value);
    if (message.method === 'drained') return started.get(message.params?.process)?.drained(message.params);
    if (message.method === 'kill') return started.get(message.params?.process)?.kill(message.params.signal);
    if (message.method === 'unwatch') return watching.delete(message.params?.watch);
    if (message.id === undefined) return;
    const reply = answer => modules.receive({ id: message.id, ...answer });
    // Answered with a copy, as over the channel: a record read is not the one kept.
    const answered = work => Promise.resolve().then(work).then(result => reply({ result: structuredClone(result ?? null) }), error => reply({ error: failureOf(error) }));
    if (message.method === 'spawn') return answered(() => spawned(message.params));
    if (message.method === 'input') {
      return answered(() => {
        const running = started.get(message.params?.process);
        if (!running) throw new ContractError('not_found', '进程已经结束');
        return running.input(message.params);
      });
    }
    if (message.method === 'settings') return reply({ result: JSON.parse(JSON.stringify(current)) });
    // A doing call's question, answered as its caller's `answer` says; one at a time, as the backend has it
    // (components/plugins/hosted-calls.mjs `question`).
    if (message.method === 'question') {
      const run = runs.get(message.params?.run);
      return Promise.resolve().then(() => {
        if (!run?.answer) throw new ContractError('not_ready', '这次调用的调用方不回答提问');
        if (run.asking) throw new ContractError('invalid_state', '上一个提问还没有回答，不能再问', { effects: 'none' });
        run.asking = true;
        return Promise.resolve(run.answer(message.params.question)).finally(() => { run.asking = false; });
      }).then(result => reply({ result }), error => reply({ error: failureOf(error) }));
    }
    // A record read or written, as the backend answers it once what the module wrote before is done.
    if (message.method === 'provider' && Object.hasOwn(recordRequests, message.params?.method)) {
      return answered(() => {
        try { return recordRequests[message.params.method](message.params.args); } catch (error) {
          throw error instanceof ContractError ? new ContractError(error.code, error.message, { effects: 'none' }) : refused('invalid_input', error.message);
        }
      });
    }
    // A kind's records watched: each entry, by its holder and ID (`{ type, id, entry }` to the module's listeners).
    if (message.method === 'watch' && types.types.has(message.params?.collection)) {
      return answered(() => {
        const { collection: kind, selector } = message.params, entries = listed(kind, selector);
        // Keyed as the module keys it: by the one plugin here.
        watching.set(JSON.stringify([kind, selector, described.id]), { kind, filter: selector, seen: new Map(entries.map(entry => [keyOf(entry), entry])) });
        return { items: entries.map(entry => ({ id: keyOf(entry), object: entry })), entries: true };
      });
    }
    // A doing call the module makes (`coda.call`, `ctx.call`): handed to its own handler of it, as `call` hands one, given
    // its `timeout`, at most what is left of the call it is made under; an idempotency key is not kept here. One only Coda
    // calls (`codaOnly`, a group's `lend` and `return`) is refused, as the backend refuses it
    // (components/plugins/plugin-callers.mjs): the test calls it, as Coda, with `call`.
    if (message.method === 'call') {
      const { record, operation, input, timeout, deadline, progress } = message.params, controller = new AbortController();
      querying.set(message.id, controller);
      return Promise.resolve().then(() => {
        const found = operationOf(record?.kind, operation);
        if (found?.codaOnly) throw refused('forbidden', `${record.kind}/${operation} 只由 Coda 调用，插件不能调`);
        if (!found || found.safe || !implemented.includes(record.kind)) throw refused('not_found', `测试宿主里没有做事的操作 ${record?.kind}/${operation} 的处理函数`);
        const left = deadline === null ? Infinity : deadline - clock.now(), within = Math.min(timeout ?? Infinity, left);
        return run(record, operation, input, found, { signal: controller.signal, timeout: within === Infinity ? null : within,
          onProgress: progress ? value => modules.receive({ method: 'callProgress', params: { id: message.id, value } }) : null });
      }).then(result => reply({ result }), error => reply({ error: failureOf(error) })).finally(() => querying.delete(message.id));
    }
    if (message.method !== 'query') return reply({ error: `测试宿主没有后端，不答 ${message.method}` });
    const { record, operation, input, timeout, deadline } = message.params, controller = new AbortController();
    querying.set(message.id, controller);
    query(record, operation, input, { signal: controller.signal, deadline: Math.min(timeout ? clock.now() + timeout : Infinity, deadline ?? Infinity) })
      .then(result => reply({ result }), error => reply({ error: failureOf(error) }))
      .finally(() => querying.delete(message.id));
  }
  // A process the module starts, as a child of the test's own, with the test's environment and what `env` adds; in the
  // plugin's directory unless `cwd` says. A named one only as the manifest names it, as the backend has it; its output goes
  // nowhere: there is no log here. One that does not start fails as the backend's does.
  async function spawned(params) {
    if (params.name !== null) checkNamed(described.id, plugin.processes, params.name);
    let child;
    try {
      child = spawn(params.command, params.args, { cwd: params.cwd ?? described.path, env: { ...process.env, ...params.env },
        stdio: params.name === null ? 'pipe' : 'ignore' });
    } catch (error) { throw unstarted(params.command, error); }
    if (!child.pid) throw unstarted(params.command, await new Promise(resolve => child.once('error', resolve)));
    started.set(params.process, { child, ...relayProcess(child, params.process, message => modules.receive(message)) });
    child.on('close', () => started.delete(params.process));
    return { pid: child.pid };
  }
  // A query as the backend's unified call takes it: only of a `safe` operation, checked and given what a call goes by
  // (adapters/call-limit.mjs); of a protocol the plugin implements, handed to its module, of another's, to `call`. However it
  // fails, it did nothing (`none`), whatever its handler says; given up on with its caller's `signal`, it fails with that
  // signal's reason itself, as the backend's `coda.query` does (`givenUp`: `none` unless it says its own `effects`).
  async function query(record, operation, input, { signal = null, deadline = null } = {}) {
    const found = operationOf(record?.kind, operation);
    if (!found) throw refused('not_found', `没有这个操作：${record?.kind}/${operation}`);
    if (!found.safe) throw refused('unsupported', `${record.kind}/${operation} 不是只读的操作（safe），不能查询：做事经调用内核`);
    const own = implemented.includes(record.kind);
    if (!own && !call) throw refused('not_found', `测试宿主里没有 ${record.kind} 的 provider`);
    const name = `${record.kind}/${operation}`, request = { record: recordFor(record), operation, input,
      requestId: randomUUID(), parent: { kind: 'plugin', id: described.id }, awaited: true };
    const limited = limit(clock, found, { signal, deadline }), given = () => signal?.aborted ? givenUp(signal, 'none') : null;
    try {
      checkInput(found, name, input); checkRequest(request);
      if (limited.signal.aborted) throw limited.signal.reason;
      const command = own && commandOf(manifest, record.kind, operation);
      const answer = command ? queried(command, { ...request, id: queryId(request), deadline: limited.deadline }, limited.signal) : own ? handed(request, limited)
        : call(record, operation, input, { signal: limited.signal, deadline: limited.deadline });
      const result = await Promise.race([answer, stopped(limited.signal)]);
      checkResult(found, name, result);
      return result;
    } catch (error) {
      throw given() ?? Object.assign(limited.signal.aborted ? limited.signal.reason : error, { effects: 'none' });
    } finally { limited.end(); }
  }
  // Handed to the module as the plugin host hands it (`query`); called off, its handler's `ctx.signal` goes off with why.
  function handed(request, limited) {
    return new Promise((resolve, reject) => {
      const id = ++next;
      waiting.set(id, { resolve, reject });
      limited.signal.addEventListener('abort', () => {
        if (waiting.delete(id)) modules.receive({ method: 'cancel', params: { id, reason: cancelOf(limited.signal.reason) } });
      }, { once: true });
      modules.receive({ id, method: 'query', params: { plugin: described, request, deadline: limited.deadline } });
    });
  }

  // A run of the plugin's command `file` implementing an operation, as the backend runs one (components/plugins/plugin-host.mjs
  // `startCommand`): `sh -c` from the plugin's directory, the call's input as JSON on its standard input, its record, ID,
  // deadline and caller in its environment (`callEnv`); cancelled (`cancel`), its group asked to end, and made to once the grace has
  // passed on the host's clock; the host closing kills it at once.
  const commanded = (file, call, cancel) => startPluginCommand(fileCommand(file), { cwd: described.path, env: { ...process.env, ...callEnv(call) },
    clock, timeoutMs: Infinity, signal: ending.signal, cancel, input: JSON.stringify(call.input), start: unregistered, label: `${described.id} · ${file}` });
  // A query its command answers, as the backend's (`queryCommand`).
  const queried = (file, call, signal) => queryCommand(() => commanded(file, call, signal), signal);
  // A doing call its command has (`runCommand`): what it said, as a module's handler says it, as the command ended; called off
  // with `signal`, or past its deadline, its command is stopped, and it ends as cancelled, or as timed out.
  async function commandRun(file, call, signal) {
    const cancel = new AbortController(), running = commanded(file, call, cancel.signal).done;
    let late = false;
    const off = timedOut => () => { late = timedOut; cancel.abort(); };
    const given = off(false), unarm = call.deadline === null ? () => {} : clock.at(call.deadline, off(true));
    if (signal?.aborted) given(); else signal?.addEventListener('abort', given, { once: true });
    try {
      const ran = await running;
      const { result, error } = settle(late && ran.canceled ? { ...ran, canceled: false, timedOut: true } : ran);
      return error ? { outcome: 'failed', error } : { outcome: 'completed', result };
    } finally { unarm(); signal?.removeEventListener('abort', given); }
  }

  // A doing call of a protocol the plugin implements, handed to its module as the backend hands it (coda#2749 3.2–3.4): its
  // input checked as the operation has it, its deadline its `timeout` from now or the operation's own, or none; called
  // off with `signal`, or past its deadline, its handler's `ctx.signal` goes off (`AbortError`, `TimeoutError`) and its
  // handler ends it still. Its result as the module's outcome says (`outcomeOf`); failed, thrown with its code; cancelled,
  // thrown as `canceled`. Each progress is given to `onProgress`, each question to `answer`, which answers it. `caller`, who
  // is before the page that made it (`ctx.caller`, `CODA_CALLER`), or none, as for a call not made from a page.
  async function run(record, operation, input, found, { signal, timeout, onProgress, answer, caller }) {
    const name = `${record.kind}/${operation}`, at = timeout ?? found.timeout;
    const call = { id: randomUUID(), record: recordFor(record), operation, input, deadline: at ? clock.now() + at : null, ...(caller ? { caller } : {}) };
    try { checkInput(found, name, input); checkRequest(call); } catch (error) { throw Object.assign(error, { effects: 'none' }); }
    const command = commandOf(manifest, record.kind, operation);
    if (command) return ended(found, name, await commandRun(command, call, signal));
    const id = ++next, off = reason => () => modules.receive({ method: 'cancel', params: { id, reason: { name: reason } } });
    const given = off('AbortError'), unarm = call.deadline === null ? () => {} : clock.at(call.deadline, off('TimeoutError'));
    runs.set(id, { onProgress, answer });
    try {
      return ended(found, name, await new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        modules.receive({ id, method: 'run', params: { plugin: described, call } });
        if (signal?.aborted) given(); else signal?.addEventListener('abort', given, { once: true });
      }));
    } finally { runs.delete(id); unarm(); signal?.removeEventListener('abort', given); }
  }
  // A doing call's result as the module's outcome says (`outcomeOf`); failed, thrown with its code; cancelled, thrown as
  // `canceled`.
  function ended(found, name, said) {
    const outcome = outcomeOf(found, name, said);
    if (outcome.outcome === 'failed') throw failed(outcome.error);
    if (outcome.outcome === 'canceled') throw new ContractError('canceled', '调用被取消了');
    return outcome.result;
  }

  return {
    // The plugin's `coda`, for its module's `activate`.
    coda,
    // Calls the plugin's module (or, for another's record, `call`) as a caller would: its result, or a failure with its
    // `code`, `effects` and `retryAfterMs`. A query given up on with `signal` fails as an `AbortError`, past `timeout` as a
    // `timeout`; a doing call of a protocol the plugin implements ends as its handler ends it (`run`), made from a page
    // when it has a `caller`.
    call(record, operation, input = {}, { signal = null, timeout = null, onProgress = null, answer = null, caller = null } = {}) {
      const found = operationOf(record?.kind, operation);
      if (found && !found.safe && implemented.includes(record.kind)) return run(record, operation, input, found, { signal, timeout, onProgress, answer, caller });
      return query(record, operation, input, { signal, deadline: timeout ? clock.now() + timeout : null });
    },
    // A query of the module's own (`coda self <名字>`, docs/plugins.md「只给自己用的查询」), handed to what it registered with
    // `coda.self.handle` as the backend hands it (components/plugins/plugin-host.mjs `querySelf`): its result, given 30 seconds by
    // the host's clock; or its failure, `not_found` for a name it did not register. Given up on before it is handed over, it is
    // not handed over: nothing done.
    async self(operation, input = {}, { signal = null } = {}) {
      const limited = limit(clock, {}, { signal });
      try {
        if (limited.signal.aborted) throw Object.assign(limited.signal.reason, { effects: 'none' });
        const request = { record: { kind: 'self', id: described.id }, operation, input, requestId: randomUUID(),
          parent: { kind: 'plugin', id: described.id }, awaited: true };
        const result = await Promise.race([handed(request, limited), stopped(limited.signal)]);
        checkResult({}, `self/${operation}`, result);
        return result;
      } catch (error) { throw Object.assign(error, { effects: 'none' }); } finally { limited.end(); }
    },
    // A doing call of a protocol the plugin implements, left by a process of the plugin's that ended before its handler did,
    // handed to its operation's `resume` as the backend hands it (coda#2749 3.6), with the call's `deadline` (`ctx.deadline`),
    // or none, and its `caller` (`ctx.caller`), or none: asked to be cancelled (`canceled`), or past its deadline, its `ctx.signal` gone off already as an
    // `AbortError` or a `TimeoutError`; its result, or its failure, as `call`'s; with no `resume`, interrupted, of unknown
    // effect, as the backend ends it then.
    async resume(record, operation, { id = randomUUID(), input = {}, progress = null, canceled = false, deadline = null, caller = null } = {}) {
      const found = operationOf(record?.kind, operation), name = `${record?.kind}/${operation}`;
      if (!found || found.safe || !implemented.includes(record.kind)) throw refused('not_found', `插件没有实现做事的操作 ${name}`);
      const halted = canceled ? { name: 'AbortError' } : deadline !== null && deadline <= clock.now() ? { name: 'TimeoutError' } : null;
      const call = { id, record: recordFor(record), operation, input, deadline, progress, canceled,
        ...(caller ? { caller } : {}), ...(halted ? { halted } : {}) }, at = ++next;
      const said = await new Promise((resolve, reject) => {
        waiting.set(at, { resolve, reject });
        modules.receive({ id: at, method: 'resume', params: { plugin: described, call } });
      });
      if (said === null) throw new ContractError('interrupted', `插件没有给 ${name} 写 resume`, { effects: 'unknown' });
      return ended(found, name, said);
    },
    // An event delivered to the module as the backend delivers one (components/plugins/plugin-events.mjs), a copy of it: to
    // the handlers of its name (`coda.on`) now, none of it kept. `{ name, kind, subject, project, data, publisher }`.
    emit: event => modules.receive({ method: 'event', params: { plugin: described.id, event: structuredClone(event) } }),
    // What the module has registered so far: `{ operations: [{ kind, operation }], self: [name], events: [name] }`, by
    // `coda.handle`, `coda.self.handle` and `coda.on`.
    registered: () => modules.registered(described),
    // The plugin's settings written again, as `Plugins.setSettings` leaves them: what the module's `settings.get` gives from now
    // on, and what its `settings.onChange` listeners are told, which have been by the time this is done.
    setSettings: async next => {
      current = JSON.parse(JSON.stringify(next));
      await modules.receive({ method: 'settingsChanged', params: { plugin: described.id, settings: JSON.parse(JSON.stringify(current)) } });
    },
    // What the module started ends (`services`, and its processes, killed), as when the host stops; and the commands running.
    close: () => {
      ending.abort();
      clock.close();
      for (const { child } of started.values()) child.kill('SIGKILL');
      return modules.stop();
    },
  };
}
