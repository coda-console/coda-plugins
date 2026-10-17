import { createHash } from 'node:crypto';

// What the「Grok」panel shows (docs/plugins.md「内置插件：Grok」): who is signed in and the plan's coding credits, as the
// CLI itself answers them (`_x.ai/auth/check_subscription`, `_x.ai/auth/info`, `_x.ai/billing`: what its `/usage` reads).
const line = (value, max = 80) => typeof value === 'string' ? [...value.replace(/\s+/g, ' ').trim()].slice(0, max).join('') : '';
const instant = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

// The name they gave xAI and their plan, never their email or tokens. Null when the CLI says no one is signed in: the
// login lapsed or was revoked though the file is still there.
export function account(subscription, info) {
  if (subscription?.authenticated === false) return null;
  if (subscription?.authenticated !== true || !subscription.meta) throw new Error('Grok 没有说明登录状态');
  const email = typeof info?.email === 'string' ? info.email.trim().toLowerCase() : '';
  // The account compared across machines by Coda's group view, as a hash of the email: the email itself stays here.
  return { name: [line(info?.firstName), line(info?.lastName)].filter(Boolean).join(' '), plan: line(subscription.meta.subscription_tier),
    ...(email ? { id: createHash('sha256').update(email).digest('hex').slice(0, 32) } : {}) };
}
// The share of the plan's allowance left this period (an absent share is zero used, as protobuf JSON leaves zeros out),
// and pay-as-you-go spending once a cap is set. A prepaid balance is money, not a share, and is not shown.
export function windows(document) {
  const config = document && typeof document === 'object' ? document.config : null;
  if (!config || typeof config !== 'object') return [];
  const cents = value => typeof value?.val === 'number' && Number.isFinite(value.val) ? Math.abs(value.val) : 0;
  const limit = cents(config.monthlyLimit);
  const used = typeof config.creditUsagePercent === 'number' && Number.isFinite(config.creditUsagePercent) ? Math.min(100, Math.max(0, config.creditUsagePercent))
    : limit > 0 ? Math.min(100, cents(config.used) / limit * 100) : 0;
  const type = config.currentPeriod?.type, left = Math.round(100 - used), resets = instant(config.currentPeriod?.end ?? config.billingPeriodEnd);
  const meters = [{ type: 'meter', label: type === 'USAGE_PERIOD_TYPE_WEEKLY' ? '7 天' : type === 'USAGE_PERIOD_TYPE_MONTHLY' ? '月度' : '额度',
    value: `剩余 ${left}%`, fraction: left / 100, ...(resets ? { time: resets, timeLabel: '重置' } : {}) }];
  // A zero amount still arrives as `{}`; the older shape leaves on-demand spending out, and it is what went past the allowance.
  const cap = cents(config.onDemandCap);
  const onDemand = config.onDemandUsed != null ? cents(config.onDemandUsed) : Math.max(0, cents(config.used) - limit);
  if (cap > 0) {
    const share = Math.round(Math.max(0, cap - onDemand) / cap * 100);
    meters.push({ type: 'meter', label: '按需用量', value: `剩余 ${share}%`, fraction: share / 100 });
  }
  return meters;
}
// The panel from what the CLI answered; nothing when no one is signed in.
export function panel([subscription, info, billing]) {
  const who = account(subscription, info);
  if (!who) return { items: [] };
  const meters = windows(billing);
  return { items: [{ type: 'card', title: who.name || 'Grok', ...(who.plan ? { subtitle: who.plan } : {}), ...(who.id ? { identity: `grok:${who.id}` } : {}),
    items: meters.length ? meters : [{ type: 'error', text: '暂时无法获取额度：Grok 没有给出额度' }] }] };
}
