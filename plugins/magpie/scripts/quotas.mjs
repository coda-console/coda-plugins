// The panel「Magpie 额度」: what is left of each subscription, plan and balance Magpie serves, as its gateway says
// (GET /v1/magpie/quotas), a card each — every one Magpie has, those Coda's own panels show too. A window is a bar of what
// is left, with the vendor's own count where it gives one and when it starts again; a balance and the resets left are a
// line each; a reading that failed says why. A gateway that does not answer fails the reading, with why on standard error.
import { GATEWAY } from './setup.mjs';

const line = text => String(text).slice(0, 80);
const fraction = remaining => Math.min(1, Math.max(0, Number(remaining) / 100));

function meter(window) {
  if (window.unlimited) return { type: 'meter', label: line(window.name), value: '不限' };
  return { type: 'meter', label: line(window.name), value: line(window.display || `已用 ${Math.round(window.used)}%`),
    fraction: fraction(window.remaining), ...(window.resetsAt ? { time: window.resetsAt, timeLabel: '重置' } : {}) };
}

function card(quota) {
  const subtitle = [quota.plan, quota.alias || quota.user].filter(Boolean).join(' · ');
  const items = [...(quota.windows ?? []).map(meter),
    ...(quota.balance ? [{ type: 'stat', label: '余额', value: line(quota.balance) }] : []),
    ...(quota.resets?.count ? [{ type: 'stat', label: '可用重置', value: `${quota.resets.count} 次` }] : []),
    ...(quota.error ? [{ type: 'error', text: line(quota.error) }] : [])].slice(0, 20);
  return { type: 'card', title: line(quota.name || quota.provider), ...(subtitle ? { subtitle: line(subtitle) } : {}), items };
}

async function main() {
  let response;
  try { response = await fetch(`http://${GATEWAY}/v1/magpie/quotas`, { signal: AbortSignal.timeout(20_000) }); }
  catch { console.error(`Magpie 网关没有在 http://${GATEWAY} 应答`); process.exit(1); }
  if (!response.ok) { console.error(`Magpie 网关没能读出额度（HTTP ${response.status}）`); process.exit(1); }
  const { data } = await response.json();
  console.log(JSON.stringify({ items: (data ?? []).slice(0, 50).map(card) }));
}

await main();
