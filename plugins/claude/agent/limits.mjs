import { createHash } from 'node:crypto';

// The quota of the account Claude sessions run as, read from what the sessions themselves report. A setup token has no
// profile scope, so /usage cannot be asked with it; but the CLI sends a `rate_limit_event` whenever a window's rounded
// percentage or reset time moves, with the fraction of the window used and when it resets (SDKRateLimitInfo). The session
// (session.mjs) tells Coda each as `_coda/quota`, which Coda keeps in the directory.
// `unifiedWindows`, an internal field of newer CLIs, carries every window each time; the top-level fields, which every
// CLI sends, only the one that limits now.
const labels = { five_hour: '5 小时', seven_day: '7 天', seven_day_opus: 'Opus · 7 天', seven_day_sonnet: 'Sonnet · 7 天', seven_day_overage_included: 'Fable · 7 天' };

function reported(info) {
  const windows = info?.unifiedWindows && typeof info.unifiedWindows === 'object' ? { ...info.unifiedWindows } : {};
  if (info?.rateLimitType && !windows[info.rateLimitType]) windows[info.rateLimitType] = info;
  return Object.entries(windows);
}

// The account as a hash of its email, which is all that leaves the entry process: what Coda's group view compares across
// machines.
export const accountHash = email => createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 32);

// The windows an event reports, as `_coda/quota` carries them: what is not a known window with a used fraction and an epoch
// reset is left out.
export const quotaWindows = info => reported(info).flatMap(([id, w]) => {
  const used = w?.utilization, resets = w?.resetsAt;
  if (!Object.hasOwn(labels, id) || !(Number.isFinite(used) && used >= 0) || !(Number.isSafeInteger(resets) && resets > 0)) return [];
  return [{ id, label: labels[id], usedFraction: Math.min(1, used), resetsAt: new Date(resets * 1000).toISOString() }];
});
