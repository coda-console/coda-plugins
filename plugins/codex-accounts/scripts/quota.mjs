// One resource per managed account, including the login imported on first use (docs/plugins.md「内置插件：Codex 多账号」),
// of the type「Codex」 as the codex plugin's own login is. Pure rendering, with no credential access.
import { createHash } from 'node:crypto';

const VALUES = 8, ACCOUNTS = 40, BYTES = 60 * 1024;
// A failure that only signing in again cures: an account's login missing, expired, unreadable or another's (thrown by the
// manager as this), or Codex saying its login is no good. Any other failure of a reading (the network, a timeout, a server's
// error, a store that cannot be read) is not, and fails the command.
export class SignInAgain extends Error {}
export const needsSignIn = error => error instanceof SignInAgain
  || /authentication required|not (logged|signed) in|unauthori[sz]ed|\b401\b|token[^.]*\b(expired|invalid|revoked)\b|auth\.json|failed to (load|read) auth/i.test(error?.message ?? '');
const line = (value, max = 80) => typeof value === 'string' ? [...value.replace(/\s+/g, ' ').trim()].slice(0, max).join('') : '';
const unixTime = value => typeof value === 'number' && Number.isFinite(new Date(value * 1000).getTime()) ? new Date(value * 1000).toISOString() : null;
// A time in a figure's text, as a mark each client writes in its own time zone (Coda's docs/agent-protocol.md「文字里的时刻」).
const mark = seconds => `<t:${unixTime(seconds)}>`;
// A value per window of each limit, of what is left and when it resets; unknown is said as unknown, never a zero.
export function windows(result) {
  const byID = result?.rateLimitsByLimitId ? Object.values(result.rateLimitsByLimitId) : [];
  const limits = (byID.length ? byID : [result?.rateLimits]).filter(Boolean);
  return limits.flatMap(limit => ['primary', 'secondary'].flatMap(key => {
    const w = limit[key]; if (!w) return [];
    const minutes = w.windowDurationMins;
    const duration = minutes === 300 ? '5 小时' : minutes === 10080 ? '7 天' : Number.isSafeInteger(minutes) && minutes > 0 ? `${minutes} 分钟` : '额度';
    const used = typeof w.usedPercent === 'number' && w.usedPercent >= 0 && w.usedPercent <= 100 ? w.usedPercent : null;
    const left = used === null ? null : Math.round(100 - used), resets = unixTime(w.resetsAt);
    return [{ label: `${limits.length > 1 ? `${line(limit.limitName ?? limit.limitId, 40) || '额度'} · ` : ''}${duration}`,
      ...(left === null ? { value: '—' } : { value: `剩余 ${left}%`, fraction: left / 100 }),
      ...(resets ? { time: resets } : {}) }];
  }));
}
function credits(result) {
  const summary = result?.rateLimitResetCredits;
  if (!Number.isSafeInteger(summary?.availableCount)) return null;
  const listed = (summary.credits ?? []).filter(c => c?.status === 'available' && c.resetType === 'codexRateLimits' && typeof c.id === 'string' && c.id)
    .sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity));
  return { count: summary.availableCount, listed };
}

// A managed account, from its quota (`result`) or why its login is no good (`error`, a line): the one sessions use says so first;
// its windows, then its full resets left, timed by the one to expire first; switching to it, a full reset (the one to
// expire first, named in its question) and removing it. The selection is a preference; running turns finish before
// adopting it.
export function resource(account, chosen, { result, error }) {
  const name = line(account.alias), values = chosen ? [{ label: '状态', value: '正在使用' }] : [];
  const buttons = chosen ? [] : [{ label: '切换使用', action: 'select', args: { account: account.identity } }];
  if (!error) {
    const known = values.length;
    values.push(...windows(result));
    const resets = credits(result);
    if (resets) {
      const first = resets.listed[0], expires = first?.expiresAt == null ? null : unixTime(first.expiresAt);
      values.splice(VALUES - 1, Infinity, { label: '完全重置', value: `剩余 ${resets.count} 次`, ...(expires ? { time: expires } : {}) });
      if (first && resets.count > 0) buttons.push({ label: '使用完全重置', action: 'reset', args: { account: account.identity, creditId: first.id },
        confirm: `使用 ${line(name, 60)} 的完全重置？\n用最早到期的那一次（${first.expiresAt == null ? '不会过期' : `${mark(first.expiresAt)} 到期`}）。成功后消耗 1 次，无法撤销。` });
    }
    if (values.length === known) throw new Error(`暂时无法获取额度：Codex 没有给出${line(name, 40)}的额度窗口`);
  }
  buttons.push({ label: '移除账号', action: 'remove', args: { account: account.identity },
    confirm: `移除 ${line(name, 60)} 在插件中保存的登录？${chosen ? '\n移除后需要选择或添加账号才能继续会话。' : ''}` });
  // Who it is and in which workspace, as the Codex plugin says it (the manager's identity is the workspace's account ID
  // hashed): Coda's group view shows the same one once. None when its email is not known.
  const email = account.alias.includes('@') ? account.alias.trim().toLowerCase() : '';
  return { name, ...(email ? { identity: `codex:${createHash('sha256').update(`${email}\n${account.identity}`).digest('hex')}` } : {}),
    values: values.slice(0, VALUES), ...(error ? { error: line(error) } : {}), buttons };
}

// Empty on a new machine: Coda offers the type's signIn under「添加资源」. Existing accounts can be added to or signed in
// again from a row's「重新登录」. No special "local account" remains after the first-use import. A selection of an account
// not signed in here is a row of its own, saying so.
export async function resources(accounts, chosen, read, { at = 4 } = {}) {
  if (!accounts.length && chosen === null) return { resources: [] };
  const shown = accounts.slice(0, ACCOUNTS), readings = new Array(shown.length);
  let next = 0, failed;
  await Promise.all(Array.from({ length: Math.min(at, shown.length) }, async () => {
    for (let i; (i = next++) < shown.length;) {
      const account = shown[i];
      try { readings[i] = resource(account, chosen === account.identity, { result: await read(account) }); }
      catch (error) {
        if (!needsSignIn(error)) { failed ??= error; continue; }
        readings[i] = resource(account, chosen === account.identity, { error: error instanceof SignInAgain ? error.message : `登录已失效，请重新登录：${error.message}` });
      }
    }
  }));
  // Every reading is ended first, so that none is left holding an account's lock.
  if (failed) throw failed;
  const out = chosen && !accounts.some(a => a.identity === chosen) ? [{ name: '所选账号', values: [], buttons: [], error: '尚未在插件中登录：重新登录它，或切换到其他账号' }] : [];
  // The 当前选中的账号 when it is not signed in here comes first, as a row of its own; the record stays within 64 KiB, and
  // rows past it are left out.
  let bytes = Buffer.byteLength(JSON.stringify(out));
  for (const each of readings) {
    const size = Buffer.byteLength(JSON.stringify(each)) + 1;
    if (bytes + size > BYTES) break;
    out.push(each); bytes += size;
  }
  return { resources: out };
}
export const outcomes = { nothingToReset: '当前额度无需重置', alreadyRedeemed: '这次重置已被使用', noCredit: '这次重置已不可用' };

// What the resources are when the accounts cannot be read for want of a login (an old one that cannot be imported, say): the one
// row says why. The type's record is still written, so its sign-in stays offered, which is how to add an account without it.
export const unreadable = error => ({ resources: [{ name: 'Codex 账号', values: [], buttons: [], error: line(error.message) }] });
