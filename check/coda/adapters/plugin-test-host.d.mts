// Types of what a plugin's module queries and answers by (docs/plugins.md「调用」, coda#2749 3.1 and 第 7 节), and of the test
// host (plugin-test-host.mjs), and of the records (coda#2749 3.7). All on the trial surface: they may change from one
// version of Coda to the next. Only these members of `coda` are typed here; the others are not yet.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Readable, Writable } from 'node:stream';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
/** A record: its protocol and its ID, the space's one. */
export type Ref = { kind: string; id: string };
/**
 * A record this plugin writes, as it names it: its protocol and the plugin's own key (1–256 characters: a device's udid,
 * `account:group`, a source's name). Its ID is derived by the host from this backend, the plugin, the kind and the key,
 * the same every time; the plugin makes no ID, nor keeps a table from its keys to IDs.
 */
export type KeyRef = { kind: string; key: string };
/** A record a call is of, as its handler is given it: with its `key` when it is this plugin's own on this machine. */
export type HandledRef = Ref & { key?: string };
/** How much a call that failed did: nothing, some of it, or none can say. */
export type Effects = 'none' | 'some' | 'unknown';

/** A failed call, as its caller sees it and as `coda.error` makes it. */
export interface CallError extends Error {
  code: string;
  effects?: Effects;
  retryAfterMs?: number;
}

export interface QueryOptions {
  /** Going off, the call is given up: it fails as an `AbortError`. */
  signal?: AbortSignal;
  /** Milliseconds; at most the operation's own `timeout`, or 30 seconds. */
  timeout?: number;
}

export interface CallOptions {
  /**
   * The call's idempotency key, by default a new one: made again with the same key and the same content, it is the same call,
   * not done again, its outcome the first one's; with other content it is refused (`idempotency_conflict`, `none`).
   */
  id?: string;
  /** Going off, the call is cancelled and not waited on: it fails as an `AbortError`. */
  signal?: AbortSignal;
  /** Milliseconds it is waited on; past them it is given up (its callee asked to cancel) and fails as a `TimeoutError`. */
  timeout?: number;
  /** How the call goes, as its handler says it (`ctx.progress`): a hint; only the latest is kept, and it may be lost. */
  onProgress?(value: Json): void;
}

/**
 * Who is before the page that made a doing call: Coda's own client on this machine, or a device, with its name if known.
 * A call forwarded to the backend that holds the record has no `local` but the `machine` it was made from (that one's ID),
 * a device kept as it is: so `{ machine }` or `{ machine, device, name? }`.
 */
export type Caller = { local: true } | { device: string; name?: string } | { machine: string; device?: string; name?: string };

/** What a handler of a call is given beside its input. A handler of a query, and `resume`, have no `progress` nor `ask`. */
export interface Context {
  /** This call's ID, the host's, unique: the same for the same caller's same request. */
  id: string;
  /** The record the call is of; with its `key` when it is this plugin's own. */
  record: HandledRef;
  /**
   * Goes off when the caller gives up or cancels (`AbortError`) or the deadline passes (a query's `timeout`, a doing
   * call's `TimeoutError`). A doing call's handler still ends it: thrown its reason, it is cancelled or timed out.
   */
  signal: AbortSignal;
  /** When the call's time is up, in milliseconds since the epoch; a doing call may have none. */
  deadline: number | null;
  /** `coda.query` under this call: given up on with it, and given at most the time it has left. Only queries. */
  query: Coda['query'];
  /**
   * `coda.spawn` under this call: ended as `signal` goes off, and, still running, once the call has ended (its handler
   * returned or threw, or the host ended it). One `name`d outlives it.
   */
  spawn: Coda['spawn'];
  /** A doing call's: how it goes, a hint; only the latest is kept, and it may be lost. */
  progress?(value: Json): void;
  /** A doing call's: a question to whoever answers it, its answer once given; one at a time. */
  ask?(question: Json): Promise<Json>;
  /**
   * A doing call's handler's, and its `resume`'s: `coda.call` made by this call, so that it is cancelled as this call is;
   * given up on with it, and given at most the time it has left. Made again by the same `id` in `resume`, it is the call
   * made before the process ended, its outcome waited on again.
   */
  call?: Coda['call'];
  /**
   * A doing call's, made from a plugin's page: who is before that page, as Coda knows it, never as the page says. None
   * for a call a module (`coda.call`), a command (`coda call`) or a flow makes.
   */
  caller?: Caller;
}

/** Its return value is the result; what it throws, the failure (`coda.error`, or anything else as `handler_error`). */
export type Handler = (input: Json, ctx: Context) => Json | Promise<Json>;
/** A doing call handed to a process of the plugin's that ended before its handler did. */
export interface Interrupted {
  /** The call's ID, as its handler was given it (`ctx.id`). */
  id: string;
  record: HandledRef;
  op: string;
  input: Json;
  /** The last progress its handler gave, only a hint: no evidence of what was done. */
  progress: Json | null;
  /** Whether it was asked to be cancelled. */
  canceled: boolean;
  /** The calls it made that have ended; not filled yet: a `resume` makes its calls again by their `id` to learn how they ended. */
  children: { record: Ref; op: string; outcome: Json }[];
}
/**
 * Says how such a call ended, as a handler does, once a later process of the plugin's has the module activated: its
 * return value the result, what it throws the failure. Given 30 seconds; its `ctx` is a query's handler's (no `progress`
 * nor `ask`). Asked to be cancelled, or past its deadline, before it is called, its `ctx.signal` has gone off already
 * (`AbortError`, `TimeoutError`). It may be called more than once, its process ending meanwhile: it only says, and does
 * nothing.
 */
export type Resume = (call: Interrupted, ctx: Context) => Json | Promise<Json>;

export interface Disposable { dispose(): void }

export interface SpawnOptions {
  /** Its working directory; by default the plugin's directory. */
  cwd?: string;
  /** Added over the environment of the plugin's processes. */
  env?: Record<string, string>;
  /**
   * One of the names the manifest's `contributes.processes` declares: the process outlives the call or the module that
   * started it, until it exits or the plugin is uninstalled. One at a time: while one of the name runs, another fails
   * (`conflict`). It has no input, and its output goes to `<plugin's state directory>/processes/<name>.log`, written anew
   * each time it starts and never rotated: its handle's streams are `null`.
   */
  name?: string;
}

/** A process the host started for the module, as Node's ChildProcess has the most of it. */
export interface Process {
  pid: number;
  /** `null` for a named one, as for a ChildProcess whose stdio is not piped. */
  stdin: Writable | null;
  /**
   * Read it, or `resume()` it to drop it: what is not read holds the process once a window of it waits. `null` for a
   * named one: its output is in its log.
   */
  stdout: Readable | null;
  stderr: Readable | null;
  /**
   * Once the process has exited and all of `stdout` and `stderr` is in them, ended. Fails (`interrupted`) if the
   * plugin's host stops first: the host ends the process.
   */
  exited: Promise<{ code: number | null; signal: string | null }>;
  /** Sends it `signal` (SIGTERM by default), the process alone, as `ChildProcess.kill` does. */
  kill(signal?: string): void;
}

export interface Settings {
  /** This plugin's own settings as they are now (secrets are not among them); asked each time. */
  get(): Promise<Json>;
  /** Told the new settings after they are written; `dispose()` stops it, as does the module stopping. */
  onChange(fn: (settings: Json) => void): Disposable;
}

/**
 * A record as it is read (`get`, `list`, `watch`): its holder's backend (`owner`) and the machine it is on (`location`),
 * its own ID, the plugin that holds it (`plugin`; `coda` for Coda's own), the key this plugin named it by (only of its own
 * on this machine; no other plugin, nor any other machine, is told it), whether it is this machine's (`local`: the holder's original; another's is a copy, which only its holder
 * writes), its spec and status as written, the records they refer to by their IDs (`get` reads them wherever they are
 * held), its labels, and a version that changes as it does. In a space every machine's records are read on every other but
 * Coda's composers and submissions, only on the machine that wrote them, and its runs and cards, which the catalog does not take.
 */
export interface Entry {
  owner: string;
  location: string;
  id: string;
  plugin: string;
  key?: string;
  local: boolean;
  spec: { [key: string]: Json };
  status: { [key: string]: Json };
  labels?: Record<string, string>;
  version: string;
}
/**
 * A record as `put` writes it, and `replace` each: its spec and its labels (none: none) whole; its status as given, or, not
 * given, as the record has it (a new one's empty), as a status is the one's that keeps it so.
 */
export interface RecordValue {
  spec: { [key: string]: Json };
  status?: { [key: string]: Json };
  labels?: Record<string, string>;
}
/** `local`: this machine's records only; `available` (by default): every machine's in the space. `id`: of that ID only. */
export interface RecordFilter { scope?: 'local' | 'available'; id?: string }
/** A record read anew, made or gone: by its ID, as it is now, or as it was last. */
export interface RecordChange { type: 'ADDED' | 'MODIFIED' | 'DELETED'; id: string; entry: Entry }

/** An event, as a module's handler of it is given it (`coda.on`). */
export interface Event {
  /** Its name, the full dotted one (`pull_request.closed`), one on this machine. */
  name: string;
  /** The protocol it is of, with its major version (`github/pull-request@1`): the event's version. */
  kind: string;
  /** What it is about, `<kind>:<id>`. */
  subject: string;
  /** The ID of the project of this machine it was published in. */
  project: string;
  /** What it says, as its protocol's payload schema has it. */
  data: { [key: string]: Json };
  /** The ID of the plugin that published it; `coda` for Coda's own. */
  publisher: string;
}

export interface Coda {
  /** Handles an operation of a protocol the plugin implements: a query (`safe`) or a doing call (any other, `idempotent` among them). */
  handle(kind: string, operation: string, handler: Handler | { run: Handler; resume?: Resume }): Disposable;
  /** `self` is no protocol: `handle('self', …)` throws `invalid_input`. */
  self: {
    /**
     * Handles a query only the plugin's own processes make (`coda self <name> [input]`), listed in no manifest: its
     * `ctx.record` is `{ kind: 'self', id: <plugin's ID> }`; given 30 seconds; one not registered fails as `not_found`.
     */
    handle(name: string, handler: Handler): Disposable;
  };
  /** Queries a record: only a `safe` operation. Fails with a `CallError`, its `effects` always `none`. */
  query(record: Ref, operation: string, input?: Json, options?: QueryOptions): Promise<Json>;
  /**
   * Does an operation of a record that is not `safe` (an `idempotent` one too), as this plugin, through Coda's call kernel: its
   * result. Fails with a `CallError`, its `code` and `effects` as the callee said them; cancelled, as an `AbortError`; past
   * `timeout`, as a `TimeoutError`.
   */
  call(record: Ref, operation: string, input?: Json, options?: CallOptions): Promise<Json>;
  error(code: string, message: string, more?: { effects?: Effects; retryAfterMs?: number }): CallError;
  /**
   * Starts a process for the module: until it stops (the plugin host's process ends, the plugin is uninstalled), or, with
   * `name`, beyond it. What it leaves in its group as it exits is ended with it. Fails as `spawn_failed`: of `none`
   * effect if it never started, of `unknown` if it started and could not be registered (killed with its group at once).
   */
  spawn(command: string, args?: string[], options?: SpawnOptions): Promise<Process>;
  /** This plugin's own settings. */
  settings: Settings;
  /**
   * One record of a kind, of its ID (a record's ID is the space's one): this machine's, else the one another machine
   * holds; `null` for none. Read after what the module wrote before.
   */
  get(record: Ref): Promise<Entry | null>;
  /** The records of a kind, this machine's first; read after what the module wrote before. */
  list(kind: string, filter?: RecordFilter): Promise<Entry[]>;
  /**
   * Watches a kind's records: each there is given as `ADDED` first, then each change. Gone over again whole if the host
   * restarts (the module is activated anew). Done once the first are given.
   */
  watch(kind: string, fn: (change: RecordChange) => void, filter?: RecordFilter): Promise<Disposable>;
  /**
   * Makes or replaces a record this plugin holds (`RecordValue`), or makes one of a kind it implements, by its key; another's
   * it may not write (`forbidden`). What people read of it is in its spec. Done once it is read so, with its entry (its
   * `id`, the host's, and its `key`); refused (`invalid_input` for a key not 1–256 characters, an `id` given, or a value
   * its kind's schemas, or the space's 64 KiB a record, refuse; `conflict` for a group named as another here), nothing was
   * written. The module's writes are done one after another, as it made them.
   */
  put(record: KeyRef, value: RecordValue): Promise<Entry>;
  /** Deletes a record this plugin holds, by its key; one not there is no failure. */
  delete(record: KeyRef): Promise<void>;
  /**
   * Every record this plugin holds of a kind, given whole by their keys: each written as `put` writes it, and those it
   * holds and no longer gives deleted; another plugin's of the kind are left. All of it is done, or nothing; done, with
   * the entries given, in their order.
   */
  replace(kind: string, entries: (RecordValue & { key: string })[]): Promise<Entry[]>;
  /**
   * Publishes an event of a protocol the plugin defines or implements, not one of Coda's own (those only Coda publishes),
   * about `subject` in `project` (a project of this machine, by ID, the plugin applying there): done once Coda has checked
   * it, its delivery not waited for; refused (`invalid_input`), nothing was published.
   */
  emit(name: string, data: { [key: string]: Json }, options: { subject: string; project: string }): Promise<void>;
  /**
   * Handles an event the plugin subscribes to: one of an event group in its `uses`, any other throwing at once (`forbidden`).
   * Given each one published in a project the plugin applies in, at most once, while the module is activated; not sorted by
   * subject. What it throws is logged; the event is not given again.
   */
  on(name: string, fn: (event: Event) => void): Disposable;
  /** Trial. The plugin itself: its ID, its directory, and its state directory on this backend (`null` when the backend has no state root). */
  plugin: Readonly<{ id: string; path: string; state: string | null }>;
  /**
   * Trial. Local streaming services: `register` serves `id` on this machine (an HTTP handler, given the caller as Coda
   * names it), done once Coda has it; the handle's `dispose()` withdraws it and closes its connections.
   */
  services: Readonly<{
    register(id: string, handler: (request: IncomingMessage, response: ServerResponse, caller: Readonly<{ [key: string]: Json }>) => void | Promise<void>): Promise<{ dispose(): Promise<void> }>;
  }>;
  /** Trial. The plugin's own pages: `register` the provider of a view the manifest declares (`contributes.views`); its `open` is called each time one is opened. */
  views: Readonly<{ register(id: string, provider: { open(view: ViewInstance): void | Promise<void> }): { dispose(): void } }>;
  /** Trial. Protocol contributions and the records' services: a contributor to another protocol's records, a record's service as this machine reaches it, and an upload of this machine's. */
  protocols: Readonly<{
    register(kind: string, key: string, handler: (object: ProtocolObject, key: string) => Contribution | null | Promise<Contribution | null>): Disposable;
    resolve(record: Ref, service: string): Promise<{ resource: Ref; url: string; headers: Record<string, string> }>;
    upload(id: string): Promise<{ id: string; name: string; size: number; path: string; mime?: string; duration?: number; [key: string]: Json | undefined }>;
  }>;
  /** Trial. Tells a session's agent something, told with its next turn and waking nothing; `told` is `false` for a session archived. */
  tell(session: string, text: string): Promise<{ told: boolean }>;
  /** Trial. This machine's Coda API as its clients reach it (the path after `/v1/`): GET without a body, POST with one; the answer is JSON. */
  api(path: string, body?: Json): Promise<Json>;
  /** Trial. What Coda gives every process of the plugin's, for one the module starts itself; `plugin` is another installed plugin's, for a command of its the module runs. */
  environment(project?: string | null, options?: { plugin?: string }): Promise<Record<string, string>>;
  /** Trial. Runs an installed plugin's environment setup again, asked as this plugin; the test host's fails (`unsupported`). */
  pluginSetup: Readonly<{ retry(plugin: string): Promise<Json> }>;
}

/** The record or draft a protocol hands a contributor, without who created it: its `spec` and `status` are objects the protocol's schemas describe. */
export interface ProtocolObject {
  kind: string;
  id: string;
  spec: { [key: string]: Json };
  status: { [key: string]: Json };
}

/** What a contributor adds: only the fields the protocol declares as contributions, each of the value the protocol says (an object, not a list or a scalar); `null` adds nothing. */
export type Contribution = { [field: string]: Json };

/** A page of the plugin's, opened, as its view provider's `open` is given it. */
export interface ViewInstance {
  /** This opening's ID. */
  id: string;
  /** The view's ID. */
  view: string;
  /** What the page was opened beside: the session's ID, and the `args` of the button or card that opened it; `null` for none. */
  context: { session: string | null; args: Json | null };
  /** Who opened it: this machine's client (`{ local: true }`) or a device. */
  caller: { local?: boolean; device?: string; name?: string };
  /** Sends the page a message; `false` once the page is gone. */
  postMessage(message: Json): boolean;
  /** A collection handed to the page: `set` and `delete` give whether the page was told anything. */
  collection(name: string): {
    set(id: string, object: { [key: string]: Json }): boolean;
    delete(id: string): boolean;
    get(id: string): { [key: string]: Json } | undefined;
    keys(): string[];
  };
  /** Each returns a handle that stops it. */
  onMessage(fn: (message: Json) => void): Disposable;
  onContext(fn: (context: ViewInstance['context']) => void): Disposable;
  onClose(fn: () => void): Disposable;
}

/** A protocol a plugin implements, some of its operations by commands: operation name to the file that implements it. */
export interface ProtocolImplementation {
  kind: string;
  commands: Record<string, string>;
}

/** The plugin under test, as its manifest has it. Processes it starts are real children of the test's, with no token. */
export interface TestPlugin {
  id?: string;
  path?: string;
  state?: string;
  /** The protocols it defines (`contributes.protocols`). */
  protocols?: object[];
  /**
   * The protocols it implements (`contributes.protocolImplementations`): a protocol's name, its operations all its module's;
   * or `{ kind, commands }`, the operations in `commands` each implemented by a file of the plugin's (its path from `path`),
   * the rest its module's. Such a command is run as Coda runs it, its call in its environment as its `ctx` has it
   * (`CODA_RECORD_KIND`, `CODA_RECORD_ID`, `CODA_RECORD_KEY` of a record the plugin holds, `CODA_CALL_ID`, `CODA_DEADLINE`
   * when it has one, `CODA_CALLER`, the `caller` as JSON, when it has one), but with no token: `coda progress`, `coda ask`, `coda query` and `coda self` in it are not answered
   * by the test host.
   */
  protocolImplementations?: (string | ProtocolImplementation)[];
  /** The names of the processes it declares (`contributes.processes`): a named `spawn` of any other fails (`not_found`). */
  processes?: string[];
  /** The permission groups it uses (`uses`), by protocol: its event groups are the events its `coda.on` may name. */
  uses?: Record<string, string[]>;
}

export interface TestCallOptions extends QueryOptions {
  /** A doing call's progress, as its handler says it. */
  onProgress?(value: Json): void;
  /** Answers a doing call's question (`ctx.ask`); without it, the question fails. */
  answer?(question: Json): Json | Promise<Json>;
  /** A doing call's: made from a page this caller is before (`ctx.caller`, `CODA_CALLER`); without it, as a module's call. */
  caller?: Caller;
}

export interface TestHost {
  /** The plugin's `coda`, for its module's `activate`. */
  coda: Coda;
  /**
   * Calls the plugin's module as a caller would: a query, or a doing call, which ends as its handler ends it. An operation
   * one of its commands implements is run as Coda runs it: its input on standard input, its exit code first, its output
   * the result, checked as the operation defines it.
   */
  call(record: Ref, operation: string, input?: Json, options?: TestCallOptions): Promise<Json>;
  /**
   * Asks what the module registered with `coda.self.handle(name, …)`, as `coda self` does: its answer, or its failure;
   * `not_found` for a name not registered. Given up on with `signal`, it fails as an `AbortError`;
   * past 30 seconds, as a `timeout`.
   */
  self(name: string, input?: Json, options?: { signal?: AbortSignal }): Promise<Json>;
  /**
   * Hands a doing call left by an ended process to its operation's `resume`, as Coda does, with its `deadline` (epoch ms,
   * `ctx.deadline`) or none: `canceled`, or the deadline past by the host's clock, its `ctx.signal` has gone off already
   * (`AbortError`, `TimeoutError`); its result, or its failure; with no `resume`, an `interrupted` failure of unknown effect.
   */
  resume(record: Ref, operation: string, call?: { id?: string; input?: Json; progress?: Json | null; canceled?: boolean; deadline?: number | null; caller?: Caller }): Promise<Json>;
  /** Writes the plugin's settings again, as the backend does: `coda.settings.get` gives them, and `onChange` is told. */
  setSettings(settings: Json): Promise<void>;
  /** Delivers an event to the module as Coda does: to its handlers of the name (`coda.on`) now. */
  emit(event: Event): Promise<void>;
  /**
   * The events the module published (`coda.emit`), in order, each checked as Coda checks it but for its project: of a
   * protocol the plugin defines or implements, not one of Coda's own, as its payload schema has it.
   */
  emitted: Omit<Event, 'publisher'>[];
  /** What the module has registered so far: its operations (`coda.handle`), its own queries' names (`coda.self.handle`) and the events it handles (`coda.on`). */
  registered(): { operations: { kind: string; operation: string }[]; self: string[]; events: string[] };
  close(): Promise<unknown>;
}

export function createTestHost(options?: {
  plugin?: TestPlugin;
  /** The plugin's settings to begin with. */
  settings?: Json;
  /** What the calls' deadlines go by (`Clock` of clock.mjs), for a test to move; by default the wall clock. */
  clock?: { now(): number; at(time: number, fn: () => void): () => void; close(): void };
  /** Answers the module's queries of records of protocols it does not implement. */
  call?: (record: Ref, operation: string, input: Json, options: { signal: AbortSignal | null; deadline: number | null }) => Json | Promise<Json>;
  /**
   * Others' records the module reads: another machine's (`owner`, by default `other`; `location`, by default its owner;
   * `plugin`, the plugin that holds it, by default the plugin under test), or, `owner` `TEST_OWNER`, another plugin's on this
   * one (`plugin` by default `other`), which the module may not write. What the module writes is on
   * this machine (`TEST_OWNER`). The space's 64 KiB a record is not held to here.
   */
  records?: (Ref & RecordValue & { plugin?: string; owner?: string; location?: string })[];
  /** Others' protocol definitions the plugin uses event groups of. */
  protocols?: object[];
}): TestHost;
/** This machine's backend in the test host: the `owner` and `location` of the records the module writes. */
export const TEST_OWNER: string;
