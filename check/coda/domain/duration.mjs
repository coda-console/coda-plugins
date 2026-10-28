// ISO 8601 durations (`P30D`, `PT6H`), as JSON Schema's `format: duration` is and bpmn-engine reads its timers
// (@0dep/piso): what plugin settings, panels and workflows all write a length of time in.
import { parseDuration } from '@0dep/piso';

// A duration, not negative.
export function isDuration(text) {
  if (typeof text !== 'string' || !text || text.length > 200) return false;
  try { return parseDuration(text).result.sign !== -1; } catch { return false; }
}
// How long a duration is, counted back from `at` (a month is the one before it).
export const durationMs = (text, at = Date.now()) => at - parseDuration(text).getStartAt(new Date(at)).getTime();
