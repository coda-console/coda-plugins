// The quota the「Antigravity」resource shows, from the report `agy -p /usage --output-format json` prints (the CLI's own
// read-only report: no turn, no quota spent, no conversation left behind). The groups and their buckets are the report's:
// models of a group share its limits, and the report has no plan name.
const WINDOWS = { weekly: '每周', '5h': '5 小时' };
const short = name => String(name ?? '').replace(/\s+/g, ' ').trim().replace(/\s+models?$/i, '');
const instant = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

// One value for each bucket that says what is left of it, in the report's order. A bucket with no ratio, one outside 0–1 or
// a disabled one is left out, never shown as full.
export function windows(report) {
  const groups = Array.isArray(report?.command?.data?.groups) ? report.command.data.groups : [];
  return groups.flatMap(group => (Array.isArray(group?.buckets) ? group.buckets : []).flatMap(bucket => {
    const left = bucket?.remaining_fraction;
    if (bucket?.disabled === true || typeof left !== 'number' || !Number.isFinite(left) || left < 0 || left > 1) return [];
    const percent = Math.round(left * 100), resets = instant(bucket.reset_time);
    const label = [...[short(group.name), WINDOWS[bucket.window] ?? bucket.window].filter(Boolean).join(' ')].slice(0, 80).join('');
    return [{ label, value: `剩余 ${percent}%`, fraction: percent / 100, ...(resets ? { time: resets } : {}) }];
  }));
}
