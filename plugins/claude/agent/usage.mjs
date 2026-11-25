// What a prompt used, as `PromptResponse.usage` says it (Coda's per-turn token collection): this turn's increment only, `inputTokens`
// the uncached input (the cached reads and writes not in it), the cache reads and writes beside it, and `breakdown` by model
// where the models are known (when it is there, it is the whole of what Coda counts; the top level is its sum). A model is told as
// `served` when the SDK names the one that ran (`canonicalModel`) and else by the SDK's own name as the unlayered `model` label; on a
// model service (providers.mjs) the usage says its `service` and `asked` instead (Coda's docs/plugins.md「Coda 的用量记录」).
//
// The SDK's result carries `modelUsage`, per model and cumulative over the query() call: main loop, Task subagents and all. This
// keeps what the last result said (`base`) and answers each result with the difference, so that a turn says what it used.
//   - A new session's query starts at 0: its first result is the first turn's own.
//   - A resumed one (session/load, or a query started again for another model's service) carries its transcript's totals in its
//     first result. Those are the history, not the turn: they become the base, and that turn goes by the result's `usage` (the main
//     loop of that turn alone, with no model told) in place of the difference. From the second result the differences hold again.
//   - A counter that went down is a reset (/clear): the model's turn is what it says now.
//   - A crash or startup failure says zeros with a subtype other than success: it says nothing, and the base stays as it was.
// A result no prompt of Coda's owns (a compaction Coda asked for, a turn Claude began on its own) moves the base and is not told
// as any prompt's: its tokens belong to no turn of the user's. What a prompt used is held from its results until it is answered
// (steering may take several results to answer one prompt); one that fails reports none.
const FIELDS = ['inputTokens', 'outputTokens', 'cachedReadTokens', 'cachedWriteTokens'];
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const total = counts => FIELDS.reduce((sum, field) => sum + (counts[field] ?? 0), 0);
const none = counts => total(counts) === 0;
const plus = (a, b) => ({
  inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens,
  // Unreported (null) stays so until something reports it.
  cachedReadTokens: a.cachedReadTokens === null && b.cachedReadTokens === null ? null : (a.cachedReadTokens ?? 0) + (b.cachedReadTokens ?? 0),
  cachedWriteTokens: a.cachedWriteTokens === null && b.cachedWriteTokens === null ? null : (a.cachedWriteTokens ?? 0) + (b.cachedWriteTokens ?? 0),
});
// A model's counts from the SDK's ModelUsage; null where it says none of them.
function fromModelUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const counts = [usage.inputTokens, usage.outputTokens, usage.cacheReadInputTokens, usage.cacheCreationInputTokens].map(count);
  if (counts.every(value => value === null)) return null;
  const [inputTokens, outputTokens, cachedReadTokens, cachedWriteTokens] = counts.map(value => value ?? 0);
  return { inputTokens, outputTokens, cachedReadTokens, cachedWriteTokens };
}
// The main loop's counts from a result's `usage` (the API's field names); null where it says none of them.
function fromApiUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const [inputTokens, outputTokens, cachedReadTokens, cachedWriteTokens] = [usage.input_tokens, usage.output_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens].map(count);
  if (inputTokens === null && outputTokens === null && cachedReadTokens === null && cachedWriteTokens === null) return null;
  return { inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0, cachedReadTokens, cachedWriteTokens };
}
const increase = (now, before) => !before || FIELDS.some(field => now[field] < before[field]) ? now
  : Object.fromEntries(FIELDS.map(field => [field, now[field] - before[field]]));

// What was used, by model (its `label`: `served` for the model the SDK says ran, else the SDK's own name as `model`), and what no model is told of.
class Spent {
  models = new Map(); loose = null;
  addModel(label, counts) {
    const key = JSON.stringify(label), before = this.models.get(key);
    this.models.set(key, { label, counts: before ? plus(before.counts, counts) : counts });
  }
  addLoose(counts) { this.loose = this.loose ? plus(this.loose, counts) : counts; }
  merge(other) {
    for (const { label, counts } of other.models.values()) this.addModel(label, counts);
    if (other.loose) this.addLoose(other.loose);
  }
  // `usage` for the response, or nothing where no token was used. `requested`: the `{ service, asked }` of the model service the
  // query ran on (`{}` for a service without a reference, null on Claude's own), told at the top level.
  report(requested) {
    const models = [...this.models.values()].filter(({ counts }) => !none(counts));
    const all = [...models.map(({ counts }) => counts), ...(this.loose && !none(this.loose) ? [this.loose] : [])];
    if (!all.length) return {};
    const sum = all.reduce(plus);
    const usage = { totalTokens: total(sum), inputTokens: sum.inputTokens, outputTokens: sum.outputTokens,
      ...(sum.cachedReadTokens === null ? {} : { cachedReadTokens: sum.cachedReadTokens }),
      ...(sum.cachedWriteTokens === null ? {} : { cachedWriteTokens: sum.cachedWriteTokens }), ...requested };
    // The breakdown is all that Coda counts when it is there: one that leaves out a part is not told. A service's one model is no
    // breakdown (the SDK's name for it is only the name asked, not the model that ran); of several, the one asked is told as that.
    if ((!this.loose || none(this.loose)) && (!requested || models.length > 1))
      usage.breakdown = models.map(({ label, counts }) => ({ ...(requested && label.model === requested.asked ? requested : label), ...counts }));
    return { usage };
  }
}

export class PromptUsage {
  base = new Map(); held = new Spent(); requested = null;
  // A query begins: a new session's from nothing, a resumed one's with its history (its first result says it). `requested`: the
  // `{ service, asked }` of the model service it runs on (`{}` for a service whose address gives no reference), null on Claude's own models.
  restarted(resumed, requested = null) { this.base = resumed ? null : new Map(); this.held = new Spent(); this.requested = requested; }
  // What this result's turn used (never throws: the result is handled whatever this makes of it).
  measure(m) {
    const spent = new Spent();
    try {
      const entries = Object.entries(m.modelUsage ?? {}).map(([key, usage]) => ({ key, usage, counts: fromModelUsage(usage) })).filter(entry => entry.counts);
      if (m.subtype !== 'success' && entries.every(entry => none(entry.counts))) return spent;
      if (this.base === null) {
        this.base = new Map(entries.map(entry => [entry.key, entry.counts]));
        const counts = fromApiUsage(m.usage);
        if (counts) spent.addLoose(counts);
        return spent;
      }
      for (const { key, usage, counts } of entries) {
        // A service's model is told by the name the SDK has it asked as, which is no model that ran; Claude's own by the canonical one.
        const canonical = !this.requested && typeof usage.canonicalModel === 'string' && usage.canonicalModel;
        spent.addModel(canonical ? { served: canonical } : { model: key }, increase(counts, this.base.get(key)));
        this.base.set(key, counts);
      }
    } catch {}
    return spent;
  }
  // The turn of a prompt of Coda's used this; told when the prompt is answered.
  hold(spent) { this.held.merge(spent); }
  // The prompt is answered with what it used (`usage` of the response, or nothing), or failed: it reports none.
  take() { const usage = this.held.report(this.requested); this.held = new Spent(); return usage; }
  drop() { this.held = new Spent(); }
}
