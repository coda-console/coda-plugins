// What a prompt used, as `PromptResponse.usage` says it (Coda's per-turn token collection): this turn's increment, `inputTokens` the
// uncached input, the cache reads and writes beside it. Grok (ACP, checked on 1.0.77) says it in the response's `_meta.usage` instead,
// per turn, with its `inputTokens` counting the cached tokens too: those are taken out of it. `_meta` stays as Grok sent it (Coda
// does not read it; other ACP clients may), and a response that already has a `usage` of its own keeps it.
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

// The `usage` to add to a successful prompt response `result`, or null where there is none to add.
export function promptUsage(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result) || (result.usage !== undefined && result.usage !== null)) return null;
  const raw = result._meta?.usage;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const input = count(raw.inputTokens), output = count(raw.outputTokens), read = count(raw.cachedReadTokens);
  const write = count(raw.cachedWriteTokens) ?? count(raw.cacheCreationTokens);
  if (input === null && output === null && read === null && write === null) return null;
  const uncached = input === null ? null : Math.max(0, input - (read ?? 0) - (write ?? 0));
  return {
    // The sum ACP's own Usage asks for, where the input and output are both there to make it.
    ...(uncached !== null && output !== null ? { totalTokens: uncached + output + (read ?? 0) + (write ?? 0) } : {}),
    ...(uncached === null ? {} : { inputTokens: uncached }),
    ...(output === null ? {} : { outputTokens: output }),
    ...(read === null ? {} : { cachedReadTokens: read }),
    ...(write === null ? {} : { cachedWriteTokens: write }),
  };
}
