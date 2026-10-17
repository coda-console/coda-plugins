// What the「Kimi」panel shows (docs/plugins.md「内置插件：Kimi Code」): the signed-in account and its quota, from what the
// Kimi CLI's local server says (`/oauth/userinfo`, `/oauth/usage`, the same getManagedUsage its /status uses).
const line = (value, max = 80) => typeof value === 'string' ? [...value.replace(/\s+/g, ' ').trim()].slice(0, max).join('') : '';
const instant = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

// Who is signed in, as the CLI's own page shows it: the nickname and membership level, never the phone number or email
// that come with them. Null when Kimi refuses the login (revoked though the file is still there).
export function account(data) {
  if (data?.kind === 'error' && data.status === 401) return null;
  if (data?.kind !== 'ok' || !data.userInfo) throw new Error('Kimi 没有说明是谁登录的');
  const id = typeof data.userInfo.userId === 'string' || typeof data.userInfo.userId === 'number' ? line(String(data.userInfo.userId), 120) : '';
  return { name: line(data.userInfo.nickname), plan: line(data.userInfo.userLevelName), ...(id ? { id } : {}) };
}
// The windows the plan has (5 hours, 7 days, monthly; those it has not are skipped), then the booster balance. Bars of what
// is left; a used ratio unknown draws none.
export function windows(data) {
  if (data?.kind !== 'ok' || !data.quota) return null;
  const usages = data.quota.usages && typeof data.quota.usages === 'object' ? data.quota.usages : {};
  const ratio = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  const meters = [['limit5h', '5 小时'], ['limit7d', '7 天'], ['monthTotal', '月度']].flatMap(([key, label]) => {
    const used = ratio(usages[key]?.usedRatio);
    if (used === null) return [];
    const left = Math.round(100 - Math.min(100, used * 100)), resets = instant(usages[key].resetAt);
    return [{ type: 'meter', label, value: `剩余 ${left}%`, fraction: left / 100, ...(resets ? { time: resets, timeLabel: '重置' } : {}) }];
  });
  const wallet = data.quota.extraUsage;
  const [total, left] = [wallet?.totalCents, wallet?.balanceCents].map(v => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  if (wallet && total !== null && left !== null) {
    const share = total > 0 ? Math.round(Math.min(1, left / total) * 100) : 0;
    meters.push({ type: 'meter', label: 'Extra Usage 余额', value: `剩余 ${share}%`, fraction: share / 100 });
  }
  return meters;
}
export function card(who, usage) {
  const items = usage.error ? [{ type: 'error', text: `暂时无法获取额度：${usage.error}` }] : windows(usage.data) ?? [{ type: 'error', text: '暂时无法获取额度：Kimi 没有给出额度' }];
  // The account, compared across machines by Coda's group view: its user ID, which the card does not show.
  return { type: 'card', title: who.name || 'Kimi', ...(who.plan ? { subtitle: who.plan } : {}), ...(who.id ? { identity: `kimi:${who.id}` } : {}),
    items: items.length ? items : [{ type: 'error', text: '暂时无法获取额度：Kimi 没有给出额度' }] };
}
