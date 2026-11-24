// 执行的时限。
export const DEFAULT_TIMEOUT = 120_000;
export const MAX_TIMEOUT = 600_000;

// 输入的 `timeout`（秒，不给用默认）规整成毫秒，不超过最长时限，再和 `deadline`（后端时钟上的毫秒时间戳，可以是 null）取早的。
// 已过期的 deadline 给 0。
export function timeLimit(seconds, deadline, now = Date.now()) {
  const asked = Math.min(seconds === undefined ? DEFAULT_TIMEOUT : seconds * 1000, MAX_TIMEOUT);
  return deadline == null ? asked : Math.max(0, Math.min(asked, deadline - now));
}
