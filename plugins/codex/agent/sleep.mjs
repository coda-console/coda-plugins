// Codex's interruptible clock.sleep is a native display item, not a shell command or an AIR async task.
// Keep it in the adapter's normal session routing, including child sessions. waits.mjs turns this private metadata
// into a Coda background wait; the public ACP update stays valid while crossing codex-acp's schema.
export function codexSleepUpdate(item, state) {
  return { sessionUpdate: 'session_info_update', _meta: { coda: { sleep: { id: item.id, durationMs: item.durationMs, state } } } };
}

export function reportedCodexSleeps(source) {
  for (const [activity, state] of [['Started', 'waiting'], ['Completed', 'done']]) {
    const before = `        return this.subagents.legacyActivity${activity}(event.item);\n      case "sleep":`;
    if (source.split(before).length !== 2) throw new Error('codex-acp sleep patch no longer matches the locked adapter');
    source = source.replace(before, `${before}\n        return codexSleepUpdate(event.item, "${state}");`);
  }
  return `import { codexSleepUpdate } from ${JSON.stringify(import.meta.url)};\n${source.replace(/^#![^\n]*\n/, '')}`;
}

export function sleepTitle(durationMs) {
  for (const [unit, label] of [[3600000, '小时'], [60000, '分钟'], [1000, '秒']]) {
    if (durationMs >= unit && durationMs % unit === 0) return `等待 ${durationMs / unit} ${label}`;
  }
  return `等待 ${durationMs / 1000} 秒`;
}
