// The events of this machine's protocols (docs/plugins.md「事件」), each as its protocol's definition says it (`events`,
// @coda-console/protocol definition.json): those of Coda's own definitions (application/host-protocols.mjs),
// and those the plugins of the catalog define. An event is known by its name, one on this machine: a plugin defining one
// another plugin's protocol has is refused as it is installed (components/plugins/plugin-source-rules.mjs catalogProblem).
// Its version is its protocol's major version.
import { newAjv } from '@coda-console/protocol/validate';

// The events of protocol `kind` (`events` as its definition has them), each `{ name, kind, payload, starts, ends, codaOnly }`:
// `payload`, the JSON Schema of what it says; `starts`, whether it may start a workflow's run (false: only handed to those
// going for its subject already); `ends`, whether it ends its subject; `codaOnly`, whether the protocol is Coda's own, its
// events Coda's alone to publish.
const eventsOf = (kind, events = {}, codaOnly = false) => Object.entries(events).map(([name, event]) =>
  ({ name, kind, payload: event.payload, starts: event.starts !== false, ends: event.ends === true, codaOnly }));

// The names of the events a plugin's own protocols define.
export const definedEvents = plugin => (plugin.protocols ?? []).flatMap(definition => Object.keys(definition.events ?? {}));

// Every event on this machine, by name: of Coda's definitions `coda` (each `{ kind, events }`) and those of
// the plugins of `catalog` (plugin ID → its catalog entry). Coda's own are never another's: a definition of the same name
// does not take one of them over.
export function protocolEvents(catalog, coda = []) {
  return new Map([...[...catalog.values()].flatMap(plugin => (plugin.protocols ?? []).flatMap(({ name, events }) => eventsOf(name, events))),
    ...[...coda].flatMap(({ kind, events }) => eventsOf(kind, events, true))]
    .map(event => [event.name, event]));
}

// The check of what an event says (`payload`, its JSON Schema), compiled the one way it is here, as the protocol package
// compiles a definition's schemas (@coda-console/protocol protocol.mjs definitionProblem): as installing it and reading
// the catalog again check (eventsProblem), as it is published (payloadProblem). Once each, as long as it is read; throws
// when it does not compile.
const ajv = newAjv({ ownProperties: true, addUsedSchema: false, strict: false }), compiled = new WeakMap();
function payloadCheck(payload) {
  if (typeof payload !== 'object') return ajv.compile(payload);
  if (!compiled.has(payload)) compiled.set(payload, ajv.compile(payload));
  return compiled.get(payload);
}
// Why the payload schema of an event of a plugin's protocols does not compile here, or null.
export function eventsProblem(plugin) {
  for (const { name, events = {} } of plugin.protocols ?? []) for (const [event, { payload }] of Object.entries(events)) {
    try { payloadCheck(payload); } catch (e) { return `协议 ${name} 的事件 ${event} 的 payload 不是可用的 JSON Schema：${e.message}`; }
  }
  return null;
}
// Why what an event says is not as its payload schema has it, or null: the schema not compiling too.
export function payloadProblem(event, value) {
  let check;
  try { check = payloadCheck(event.payload); } catch (e) { return `没法按事件 ${event.name}（${event.kind}）的格式查：它的 payload schema 编不过（${e.message}）`; }
  return check(value) ? null : `不合事件 ${event.name}（${event.kind}）的格式：${ajv.errorsText(check.errors, { dataVar: 'payload' })}`;
}
