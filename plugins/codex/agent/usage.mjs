// What a prompt used, as `PromptResponse.usage` says it (Coda's per-turn token collection): the increase of the session's thread counts
// over the turn, not the last model response codex-acp answers with. Codex's `thread/tokenUsage/updated` carries `total` (the
// thread's count so far) and `last` (the latest response's alone), and codex-acp keeps both but answers with `last`, so a turn of several
// model calls told only the final one.
//
// Every thread of the session counts: the session's own and its subagents', each told as its thread says it, from the subscription's own
// handlers (the one place each event of a thread passes once, and before codex-acp parts the subagents' by what the client supports:
// without the capability they reach it as the session's own, and with it they are held back until their session is made and handled again).
// Per thread the increase is the total against the total last seen of it, so a notification seen twice, or the one
// codex-acp's `thread/resume` replays (below), adds nothing twice. What is counted is held until a prompt is answered and told then,
// so a subagent still running when its parent's turn is answered is told by the answer that comes after it.
//   - Codex may start a subagent's turn before the parent tells of the subagent (its thread ID), when the subagent has no handler yet and
//     the client drops what it says. The turn's start and its count are kept (the first and the latest of them, which is all the increase
//     needs) until the parent tells of the thread, and counted then, in the session that tells of it; one never told of is never counted
//     (a thread of Codex's own, as a reviewer's).
//   - A thread not seen before starts from `total - last`, the count before its first response in this process.
//   - Codex replays the thread's count when it is resumed (a session loaded, or moved to another model service): that notification is
//     of the turn before, one this process saw no `turn/started` of, so it sets what was seen and counts nothing.
//   - `total` falls when Codex resets the count as the context fills: what can be confirmed then is that response's own `last`,
//     never a negative increase.
// A prompt that sent no model request (`/status`) has no increase and no usage. Cache writes are part of `input` in Codex's count as
// cache reads are: the uncached input leaves out both.
import { services } from './providers.mjs';

const FIELDS = ['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens'];
const counts = value => Object.fromEntries(FIELDS.map(field => [field, Number.isSafeInteger(value?.[field]) && value[field] > 0 ? value[field] : 0]));
const sum = (a, b) => Object.fromEntries(FIELDS.map(field => [field, a[field] + b[field]]));
const none = value => FIELDS.every(field => value[field] === 0);
const bare = modelId => modelId?.replace(/\[[^\]]*\]$/, '');

// Codex's counts as Coda's four (thinking is in the output; `thoughtTokens` is only its part).
function told(value) {
  const input = Math.max(0, value.inputTokens - value.cachedInputTokens - value.cacheWriteInputTokens);
  return { inputTokens: input, outputTokens: value.outputTokens, cachedReadTokens: value.cachedInputTokens, cachedWriteTokens: value.cacheWriteInputTokens };
}

export class SessionUsage {
  seen = new Map(); started = new Set(); spent = new Map(); models = new Map();
  // What Codex tells of the session's threads, as codex-acp's event handler is given it.
  notice({ method, params }) {
    if (method === 'turn/started') this.started.add(params.turn.id);
    else if (method === 'thread/tokenUsage/updated') this.count(params);
    else if (method === 'item/started' || method === 'item/completed') {
      // The model a subagent was spawned on, when the spawn says one; else it runs on its parent's.
      const { item } = params, spawned = item.type === 'collabAgentToolCall' && item.tool === 'spawnAgent' ? item.receiverThreadIds : item.type === 'subAgentActivity' ? [item.agentThreadId] : [];
      if (typeof item.model === 'string' && item.model) for (const threadId of spawned) this.models.set(threadId, item.model);
    }
  }
  count({ threadId, turnId, tokenUsage }) {
    const total = counts(tokenUsage.total), last = counts(tokenUsage.last), before = this.seen.get(threadId);
    this.seen.set(threadId, total);
    if (!this.started.has(turnId)) return;
    const grown = before && FIELDS.every(field => total[field] >= before[field]);
    const increase = !before ? last : grown ? Object.fromEntries(FIELDS.map(field => [field, total[field] - before[field]])) : last;
    this.spent.set(threadId, sum(this.spent.get(threadId) ?? counts(), increase));
  }
  // The usage of what was counted since the last answer, or null where nothing was. `rootThreadId`: the session's own thread. `own`: its
  // model as `{ model }` (Codex's) or `{ service, asked }` (a service's), null where that is not known.
  take(rootThreadId, own) {
    const spent = [...this.spent].filter(([, value]) => !none(value));
    this.spent = new Map();
    if (!spent.length) return null;
    const all = spent.map(([, value]) => value).reduce(sum), four = told(all);
    const ownModel = own?.asked ?? own?.model, buckets = new Map();
    // Usage by model, where a subagent runs on another model than its parent: each bucket needs a name to be told, as the parent's
    // is known, and a subagent's is on the parent's service when the parent is on one (a thread runs on one provider).
    for (const [threadId, value] of spent) {
      const asked = threadId === rootThreadId ? ownModel : this.models.get(threadId) ?? ownModel;
      const label = !own ? null : asked === ownModel ? own : own.service ? { service: own.service, asked } : { model: asked };
      const key = JSON.stringify(label), before = buckets.get(key);
      buckets.set(key, { label, value: before ? sum(before.value, value) : value });
    }
    const named = [...buckets.values()];
    return { totalTokens: four.inputTokens + four.outputTokens + four.cachedReadTokens + four.cachedWriteTokens, ...four, thoughtTokens: all.reasoningOutputTokens,
      ...(named.length > 1 && named.every(({ label }) => label) ? { breakdown: named.map(({ label, value }) => ({ ...label, ...told(value) })) } : {}) };
  }
}

const sessions = new Map(), held = new Map();
const of = rootThreadId => sessions.get(rootThreadId) ?? sessions.set(rootThreadId, new SessionUsage()).get(rootThreadId);
export const usage = {
  notice: (rootThreadId, notification) => of(rootThreadId).notice(notification),
  // What a thread with no handler says that counts: the start of a turn, and its count (the first and the latest).
  held({ method, params }) {
    if (method !== 'turn/started' && method !== 'thread/tokenUsage/updated') return;
    const each = held.get(params.threadId) ?? held.set(params.threadId, { starts: [], first: null, last: null }).get(params.threadId);
    if (method === 'turn/started') each.starts.push({ method, params });
    else { each.first ??= { method, params }; each.last = { method, params }; }
  },
  // The session tells of the thread as its subagent: what was kept of it is counted as the thread's own events are.
  claim(rootThreadId, threadId) {
    const each = held.get(threadId);
    held.delete(threadId);
    if (each) for (const kept of new Set([...each.starts, each.first, each.last])) if (kept) of(rootThreadId).notice(kept);
  },
  // The usage a prompt of the session answers with. Its own model as it is told: the service and model asked of it when this prompt was
  // bound to them (providers.mjs), else Codex's own model's name (none for a service's model that was not bound: unknown).
  take(sessionState) {
    const model = bare(sessionState.currentModelId), requested = sessionState.codaRequested;
    return of(sessionState.sessionId).take(sessionState.sessionId, requested ?? (model && !services.served(model) ? { model } : null));
  },
};

const patches = [
  // Every notification of the session's threads, as the thread says it: the session's own, and each subagent's with its own thread ID.
  ['      this.discover(session, event);\n      session.current.dispatch(event);', '      codaUsage.notice(subscription.rootSessionId, event);\n      this.discover(session, event);\n      session.current.dispatch(event);', 1],
  ['        if (eventThreadId !== childSessionId) return;\n        this.discover(session, childEvent);', '        if (eventThreadId !== childSessionId) return;\n        codaUsage.notice(session.current.rootSessionId, childEvent);\n        this.discover(session, childEvent);', 1],
  // A thread's notification with no handler is kept, not dropped, and counted once the session tells of the thread (a subagent's first turn may begin before that).
  ['      if (handler) {\n        handler(notification);\n      }\n      return;', '      if (handler) {\n        handler(notification);\n      } else {\n        codaUsage.held(notification);\n      }\n      return;', 1],
  ['      session.children.add(childSessionId);\n      this.client.onServerNotification(childSessionId,', '      session.children.add(childSessionId);\n      codaUsage.claim(session.current.rootSessionId, childSessionId);\n      this.client.onServerNotification(childSessionId,', 1],
  // A prompt is answered with what its turn used, whichever way it ends (a command, a turn, a stop, a failure the session records).
  // Applies to the source providers.mjs patched: its answers are the ones that say the service and model.
  ['this.buildPromptUsage(sessionState.lastTokenUsage)', 'codaUsage.take(sessionState)', 4],
];
// Fails loudly once the locked adapter changes.
export function countedCodexUsage(source) {
  for (const [before, after, count] of patches) {
    if (source.split(before).length !== count + 1) throw new Error('codex-acp usage patch no longer matches the locked adapter');
    source = source.replaceAll(before, after);
  }
  return `import { usage as codaUsage } from ${JSON.stringify(import.meta.url)};\n${source.replace(/^#![^\n]*\n/, '')}`;
}
