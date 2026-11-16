// Codex's context compaction is told to Coda as ACP `compaction_update` (Coda keeps one 「整理上下文」 record per compactionId and
// notes a compaction when one completes), not as codex-acp's tool card or its "context compacted" text. The locked Codex says
// a compaction as an item (`contextCompaction`, started and completed, its id the compactionId); the deprecated
// `thread/compacted` carries no item and only its turn, so the one of the two a turn's compaction came as is the one told:
// the other, if it comes too, is not, and a compaction is never counted twice. One started whose turn ends failed or
// interrupted without completing it is told `failed` then, so Coda's record does not stay in progress.
const turns = new WeakMap();

// `event` is the item event or the legacy notification's params; `status` the item's (`in_progress`, `completed`), none for the notification.
export function codexCompactionUpdate(handler, event, status) {
  const source = event.item ? 'item' : 'legacy', last = turns.get(handler);
  if (last?.turnId === event.turnId && last.source !== source) return null;
  turns.set(handler, { turnId: event.turnId, source, open: status === 'in_progress' ? event.item.id : null });
  return { sessionUpdate: 'compaction_update', compactionId: event.item?.id ?? `${event.turnId}:compacted`, status: status ?? 'completed' };
}

// The turn's end, as `turn/completed` says it.
export function codexCompactionEnded(handler, turn) {
  const state = turns.get(handler), id = state?.open;
  if (!id) return null;
  state.open = null;
  return turn.status === 'completed' ? null : { sessionUpdate: 'compaction_update', compactionId: id, status: 'failed', error: turn.error?.message ?? null };
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
  const ended = '        this.sessionState.currentTurnId = null;\n        return null;\n      case "thread/tokenUsage/updated":';
  if (source.split(ended).length !== 2) throw new Error('codex-acp compaction patch no longer matches the locked adapter');
  source = source.replace(ended, ended.replace('return null;', 'return codexCompactionEnded(this, notification.params.turn);'));
  return `import { codexCompactionUpdate, codexCompactionEnded } from ${JSON.stringify(import.meta.url)};\n${source.replace(/^#![^\n]*\n/, '')}`;
}
