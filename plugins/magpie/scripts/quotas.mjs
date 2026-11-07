// The resource type「Magpie」: what is left of each subscription, plan and balance Magpie serves, as its gateway says
// (GET /v1/magpie/quotas), a resource each — every one Magpie has, those other types show too. A window is a value of what
// is left and when it starts again, as the other plugins say it (`剩余 N%`, `7 天`); a balance and the resets left are a
// value each; a reading that failed says why on its row. A gateway that does not answer fails the reading, with why on
// standard error.
import { GATEWAY } from './setup.mjs';

const line = text => String(text).slice(0, 80);
const WORDS = { Monthly: '月度', Weekly: '7 天', Daily: '1 天' };
// A window's name as the other plugins write one: `5 hours` is `5 小时`, `7 days` `7 天`; one of its own stays as Magpie says it.
const named = name => {
  const span = /^(\d+) (hour|day|week|month)s?$/.exec(name);
  return line(span ? `${span[1]} ${{ hour: '小时', day: '天', week: '周', month: '个月' }[span[2]]}` : WORDS[name] ?? name);
};

function value(window) {
  if (window.unlimited) return { label: named(window.name), value: '不限' };
  const left = Math.round(Math.min(100, Math.max(0, Number(window.remaining))));
  return { label: named(window.name), value: `剩余 ${left}%`, fraction: left / 100,
    ...(window.resetsAt && Number.isFinite(Date.parse(window.resetsAt)) ? { time: window.resetsAt } : {}) };
}

// A quota: its service and whose it is (the alias given it, else the user), its windows, balance and resets, as many as a
// resource has values, and what went wrong reading it.
function resource(quota) {
  const values = [...(quota.windows ?? []).map(value),
    ...(quota.balance ? [{ label: '余额', value: line(quota.balance) }] : []),
    ...(quota.resets?.count ? [{ label: '可用重置', value: `${quota.resets.count} 次` }] : [])].slice(0, 8);
  const name = line([quota.name || quota.provider, quota.alias || quota.user].filter(Boolean).join(' · ')) || 'Magpie';
  return { name, values, ...(quota.error ? { error: line(quota.error).replace(/[\r\n]+/g, ' ') } : {}) };
}

async function main() {
  let response;
  try { response = await fetch(`http://${GATEWAY}/v1/magpie/quotas`, { signal: AbortSignal.timeout(20_000) }); }
  catch { console.error(`Magpie 网关没有在 http://${GATEWAY} 应答`); process.exit(1); }
  if (!response.ok) { console.error(`Magpie 网关没能读出额度（HTTP ${response.status}）`); process.exit(1); }
  const { data } = await response.json();
  console.log(JSON.stringify({ resources: (data ?? []).slice(0, 50).map(resource) }));
}

await main();
