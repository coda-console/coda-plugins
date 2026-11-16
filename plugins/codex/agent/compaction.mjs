// Codex's context compaction is told to Coda as ACP `compaction_update` (Coda keeps one 「整理上下文」 record per compactionId and
// notes a compaction when one completes), not as codex-acp's tool card or its "context compacted" text. The locked Codex says
// a compaction as an item (`contextCompaction`, started and completed, its id the compactionId); the deprecated
// `thread/compacted` carries no item and only its turn, so the one of the two a turn's compaction came as is the one told:
// the other, if it comes too, is not, and a compaction is never counted twice.
const turns = new WeakMap();

// `event` is the item event or the legacy notification's params; `status` the item's (`in_progress`, `completed`), none for the notification.
export function codexCompactionUpdate(handler, event, status) {
  const source = event.item ? 'item' : 'legacy', last = turns.get(handler);
  if (last?.turnId === event.turnId && last.source !== source) return null;
  turns.set(handler, { turnId: event.turnId, source });
  return { sessionUpdate: 'compaction_update', compactionId: event.item?.id ?? `${event.turnId}:compacted`, status: status ?? 'completed' };
}

export function reportedCodexCompactions(source) {
  const patches = [
    ['        return createContextCompactionStartUpdate(event.item);', 'codexCompactionUpdate(this, event, "in_progress")'],
    ['        return createContextCompactionCompleteUpdate(event.item);', 'codexCompactionUpdate(this, event, "completed")'],
    ['        return this.createContextCompactedEvent();', 'codexCompactionUpdate(this, notification.params)'],
  ];
  for (const [before, call] of patches) {
    if (source.split(before).length !== 2) throw new Error('codex-acp compaction patch no longer matches the locked adapter');
    source = source.replace(before, `        return ${call};`);
  }
  return `import { codexCompactionUpdate } from ${JSON.stringify(import.meta.url)};\n${source.replace(/^#![^\n]*\n/, '')}`;
}
