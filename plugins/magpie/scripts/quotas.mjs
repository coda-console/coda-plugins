#!/usr/bin/env node
// The `coda/resource@1` record of the「Magpie」type, printed once: what is left of each subscription, plan and balance Magpie
// serves, as its gateway says (GET /v1/magpie/quotas), a resource each — every one Magpie has, those other types show too. A window is a value of what
// is left and when it starts again, as the other plugins say it (`剩余 N%`, `7 天`); a balance and the resets left are a
// value each; a subscription the gateway could not read says why on its row, the others as they are. A gateway that does not
// answer, or one that cannot say, fails the command (exit 1, the reason on the last line of its standard error), which keeps
// the record Coda has: Magpie has no login to offer.
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
// resource has values, and what went wrong reading it (that one row only: the others are as they are).
function resource(quota) {
  const values = [...(quota.windows ?? []).map(value),
    ...(quota.balance ? [{ label: '余额', value: line(quota.balance) }] : []),
    ...(quota.resets?.count ? [{ label: '可用重置', value: `${quota.resets.count} 次` }] : [])].slice(0, 8);
  const name = line([quota.name || quota.provider, quota.alias || quota.user].filter(Boolean).join(' · ')) || 'Magpie';
  return { name, values, buttons: [], ...(quota.error ? { error: line(quota.error).replace(/[\r\n]+/g, ' ') } : {}) };
}

// The whole reading (the request and its body) has 20 of the 30 seconds Coda allows, so that it ends with the reason rather
// than killed by Coda with nothing.
const budget = AbortSignal.timeout(20_000);
async function read() {
  let response, body;
  try { response = await fetch(`http://${GATEWAY}/v1/magpie/quotas`, { signal: budget }); }
  catch { throw new Error(budget.aborted ? '读取超时' : `Magpie 网关没有在 http://${GATEWAY} 应答`); }
  if (!response.ok) throw new Error(`Magpie 网关没能读出额度（HTTP ${response.status}）`);
  try { body = await response.json(); } catch (error) { throw new Error(budget.aborted ? '读取超时' : `Magpie 网关的答复读不了：${error.message}`); }
  if (!Array.isArray(body?.data)) throw new Error('Magpie 网关的答复读不了：没有额度列表');
  return body.data.slice(0, 50).map(resource);
}
try { console.log(JSON.stringify([{ key: 'quotas', spec: { type: 'quotas', title: 'Magpie', resources: await read() } }])); }
catch (error) { console.error(String(error.message).replace(/\s+/g, ' ')); process.exit(1); }
