// ISO 8601 durations (`P30D`, `PT6H`), as JSON Schema's `format: duration` is and bpmn-engine reads its timers
// (@0dep/piso): what plugin settings, panels and workflows all write a length of time in. And a length of time as whoever
// is told it reads it, in words.
import { parseDuration } from '@0dep/piso';

// A duration, not negative.
export function isDuration(text) {
  if (typeof text !== 'string' || !text || text.length > 200) return false;
  try { return parseDuration(text).result.sign !== -1; } catch { return false; }
}
// How long a duration is, counted back from `at` (a month is the one before it).
export const durationMs = (text, at = Date.now()) => at - parseDuration(text).getStartAt(new Date(at)).getTime();

// How long, in words, for whom it is told to: to the second under a minute, to the minute after.
export function duration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
}
