// One card per managed account, including the login imported on first use. Pure rendering, with no credential access.
import { createHash } from 'node:crypto';

const CARD_ITEMS = 20, ACCOUNTS = 40, BYTES = 60 * 1024;
const line = (value, max = 80) => typeof value === 'string' ? [...value.replace(/\s+/g, ' ').trim()].slice(0, max).join('') : '';
const unixTime = value => typeof value === 'number' && Number.isFinite(new Date(value * 1000).getTime()) ? new Date(value * 1000).toISOString() : null;
export function utc8(seconds) {
  const d = new Date(seconds * 1000 + 8 * 3600_000);
  return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')} ${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}
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
function credits(result) {
  const summary = result?.rateLimitResetCredits;
  if (!Number.isSafeInteger(summary?.availableCount)) return null;
  const listed = (summary.credits ?? []).filter(c => c?.status === 'available' && c.resetType === 'codexRateLimits' && typeof c.id === 'string' && c.id)
    .sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity));
  return { count: summary.availableCount, listed };
}

// The selection is a preference; running turns finish before adopting it.
const choice = (account, chosen) => chosen
  ? { type: 'button', label: '已选择', action: 'select', args: { account }, disabled: true }
  : { type: 'button', label: '切换使用', action: 'select', args: { account } };

// A managed account's card, from its quota (`result`) or why it could not be read (`error`).
export function card(account, chosen, { result, error }) {
  const name = line(account.alias), buttons = [choice(account.identity, chosen),
    { type: 'button', label: '移除账号', action: 'remove', args: { account: account.identity },
      confirm: `移除 ${line(name, 60)} 在插件中保存的登录？${chosen ? '\n移除后需要选择或添加账号才能继续会话。' : ''}` }], items = [];
  if (error) items.push({ type: 'error', text: `暂时无法获取额度：${error}` });
  else {
    items.push(...windows(result));
    const resets = credits(result);
    if (resets) {
      const first = resets.listed[0];
      if (first && resets.count > 0) buttons.push({ type: 'button', label: '使用完全重置', action: 'reset', args: { account: account.identity, creditId: first.id },
        confirm: `使用 ${line(name, 60)} 的完全重置？\n用最早到期的那一次（${first.expiresAt == null ? '不会过期' : `${utc8(first.expiresAt)} 到期，UTC+8`}）。成功后消耗 1 次，无法撤销。` });
      const room = CARD_ITEMS - buttons.length - items.length - 1;
      items.push({ type: 'stat', label: '完全重置', value: `剩余 ${resets.count} 次` },
        ...resets.listed.slice(0, Math.max(0, room)).map((c, i) => ({ type: 'stat', label: `第 ${i + 1} 次`, value: c.expiresAt == null ? '不会过期' : `${utc8(c.expiresAt)} 到期` })));
    }
    if (!items.length) items.push({ type: 'error', text: '暂时无法获取额度：Codex 没有给出额度窗口' });
  }
  // Who it is and in which workspace, as the Codex panel says it (the manager's identity is the workspace's account ID
  // hashed): Coda's group view shows the same one once. None when its email is not known.
  const email = account.alias.includes('@') ? account.alias.trim().toLowerCase() : '';
  return { type: 'card', title: name, ...(line(account.plan) ? { subtitle: line(account.plan) } : {}),
    ...(email ? { identity: `codex:${createHash('sha256').update(`${email}\n${account.identity}`).digest('hex')}` } : {}),
    items: [...buttons, ...items].slice(0, CARD_ITEMS) };
}

// Empty on a new machine: Coda offers this panel's signIn under「添加资源」. Existing accounts can be added to or signed
// in again from the panel's login menu. No special "local account" remains after the first-use import.
export async function panel(accounts, chosen, read, { at = 4 } = {}) {
  if (!accounts.length && chosen === null) return { items: [] };
  const shown = accounts.slice(0, ACCOUNTS), cards = new Array(shown.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(at, shown.length) }, async () => {
    for (let i; (i = next++) < shown.length;) {
      const account = shown[i];
      let reading;
      try { reading = { result: await read(account) }; } catch (error) { reading = { error: error.message }; }
      cards[i] = card(account, chosen === account.identity, reading);
    }
  }));
  const items = [{ type: 'markdown', text: '通过本面板的「重新登录」添加其他账号或更新已有登录。所选账号在新会话和两轮之间生效。' }];
  if (chosen && !accounts.some(a => a.identity === chosen)) items.push({ type: 'error', text: '所选账号尚未在插件中登录，请重新登录该账号或选择其他账号。' });
  if (accounts.length && !chosen) items.push({ type: 'markdown', text: '请选择一个账号供 Codex 会话使用。' });
  // Within what a panel may print (64 KiB), with room for the line counting those left out.
  let bytes = Buffer.byteLength(JSON.stringify(items));
  for (const each of cards) {
    const size = Buffer.byteLength(JSON.stringify(each)) + 1;
    if (bytes + size > BYTES) break;
    items.push(each); bytes += size;
  }
  const left = accounts.length - items.filter(item => item.type === 'card').length;
  return { items: [...items, ...(left > 0 ? [{ type: 'markdown', text: `另有 ${left} 个账号没有列出` }] : [])] };
}
export const outcomes = { nothingToReset: '当前额度无需重置', alreadyRedeemed: '这次重置已被使用', noCredit: '这次重置已不可用' };
