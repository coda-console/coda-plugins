// What the Codex panel shows of a login (docs/plugins.md「内置插件：Codex」), from what Codex's app-server says of it:
// `account/read` and `account/rateLimits/read`. Kept apart from the commands so the tests can hand it answers.

const CARD_ITEMS = 20;
const line = (value, max = 80) => typeof value === 'string' ? [...value.replace(/\s+/g, ' ').trim()].slice(0, max).join('') : '';
// The account a card shows, compared across machines by Coda's group view (its panel cards' `identity`): the ChatGPT
// account's email, which this login's card also shows.
const identity = account => line(account.email, 180) ? { identity: `codex:${line(account.email, 180).toLowerCase()}` } : {};
const unixTime = value => typeof value === 'number' && Number.isFinite(new Date(value * 1000).getTime()) ? new Date(value * 1000).toISOString() : null;
// A credit's expiry as the clients write times (UTC+8), here because a figure's value is text.
export function utc8(seconds) {
  const d = new Date(seconds * 1000 + 8 * 3600_000);
  return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')} ${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

// A bar per window of each limit, of what is left. A limit's name is said only when there are several.
export function windows(result) {
  const byID = result?.rateLimitsByLimitId ? Object.values(result.rateLimitsByLimitId) : [];
  const limits = (byID.length ? byID : [result?.rateLimits]).filter(Boolean);
  return limits.flatMap(limit => ['primary', 'secondary'].flatMap(key => {
    const w = limit[key]; if (!w) return [];
    const minutes = w.windowDurationMins;
    const duration = minutes === 300 ? '5 小时' : minutes === 10080 ? '7 天' : Number.isSafeInteger(minutes) && minutes > 0 ? `${minutes} 分钟` : '额度';
    const used = typeof w.usedPercent === 'number' && w.usedPercent >= 0 && w.usedPercent <= 100 ? w.usedPercent : null;
    const left = used === null ? null : Math.round(100 - used), resets = unixTime(w.resetsAt);
    return [{ type: 'meter', label: `${limits.length > 1 ? `${line(limit.limitName ?? limit.limitId, 40) || '额度'} · ` : ''}${duration}`,
      ...(left === null ? {} : { value: `剩余 ${left}%`, fraction: left / 100 }),
      ...(resets ? { time: resets, timeLabel: '重置' } : {}) }];
  }));
}

// The full resets left: the count is Codex's word (its list of them may be capped or missing). Those listed are the
// available ones, earliest to expire first; one without an expiry never expires.
export function credits(result) {
  const summary = result?.rateLimitResetCredits;
  if (!Number.isSafeInteger(summary?.availableCount)) return null;
  const listed = (summary.credits ?? []).filter(c => c?.status === 'available' && c.resetType === 'codexRateLimits' && typeof c.id === 'string' && c.id)
    .sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity));
  return { count: summary.availableCount, listed };
}

// The login's card: its button for a full reset (the one to expire first, named in its question), its windows, then its
// resets one line each.
export function card(account, result) {
  const name = line(account.email) || '本机登录';
  const items = windows(result), resets = credits(result);
  if (resets) {
    const first = resets.listed[0];
    const lines = resets.listed.map((c, i) => ({ type: 'stat', label: `第 ${i + 1} 次`, value: c.expiresAt == null ? '不会过期' : `${utc8(c.expiresAt)} 到期` }));
    const room = CARD_ITEMS - items.length - (first ? 2 : 1);
    items.push({ type: 'stat', label: '完全重置', value: `剩余 ${resets.count} 次` }, ...lines.slice(0, Math.max(0, room)));
    if (first && resets.count > 0) items.unshift({ type: 'button', label: '使用完全重置', action: 'reset', args: { creditId: first.id },
      confirm: `使用 ${line(name, 60)} 的完全重置？\n用最早到期的那一次（${first.expiresAt == null ? '不会过期' : `${utc8(first.expiresAt)} 到期，UTC+8`}）。成功后消耗 1 次，无法撤销。` });
  }
  if (!items.length) items.push({ type: 'error', text: '暂时无法获取额度：Codex 没有给出额度窗口' });
  return { type: 'card', title: name, ...(line(account.planType) ? { subtitle: line(account.planType) } : {}), ...identity(account), items: items.slice(0, CARD_ITEMS) };
}

// The panel: nothing without a login (it is then offered under「添加资源」), a card for one. Quota Codex cannot read stays
// on the card, which keeps「重新登录」 at hand; one not signed in with ChatGPT has no windows to read.
export async function panel(server) {
  const { account } = await server.request('account/read', { refreshToken: false });
  if (!account) return { items: [] };
  if (account.type !== 'chatgpt') return { items: [{ type: 'card', title: '本机登录', subtitle: line(account.type),
    items: [{ type: 'markdown', text: '不是用 ChatGPT 账号登录的，没有额度可显示' }] }] };
  let result;
  try { result = await server.request('account/rateLimits/read'); }
  catch (error) {
    return { items: [{ type: 'card', title: line(account.email) || '本机登录', ...(line(account.planType) ? { subtitle: line(account.planType) } : {}), ...identity(account),
      items: [{ type: 'error', text: `暂时无法获取额度：${error.message}` }] }] };
  }
  return { items: [card(account, result)] };
}

// What a full reset came to, as one line for the panel when it did not reset anything.
export const outcomes = { nothingToReset: '当前额度无需重置', alreadyRedeemed: '这次重置已被使用', noCredit: '这次重置已不可用' };
