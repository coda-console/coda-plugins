import { createHash } from 'node:crypto';

// What the「Codex」resource type shows of a login (docs/plugins.md「内置插件：Codex」), from what Codex's app-server says of
// it: `account/read` and `account/rateLimits/read`; with「多账号」on, of each managed account (manager.mjs). Kept apart from the
// commands so the tests can hand it answers.

const VALUES = 8, ACCOUNTS = 40, BYTES = 60 * 1024;
const line = (value, max = 80) => typeof value === 'string' ? [...value.replace(/\s+/g, ' ').trim()].slice(0, max).join('') : '';
// The account a resource is, compared across machines by Coda's group view (its `identity`): who signed in and in which
// ChatGPT workspace, as the quota is one person's in one workspace (one email may sign in to several, and a workspace has
// many members). A hash of the email and of the workspace's account ID hashed as codex-account keeps it; none where Codex
// does not say both.
const hash = text => createHash('sha256').update(text).digest('hex');
const identity = (account, workspace) => {
  const email = line(account.email, 320).toLowerCase();
  return email && typeof workspace === 'string' && workspace ? { identity: `codex:${hash(`${email}\n${hash(workspace)}`)}` } : {};
};
const unixTime = value => typeof value === 'number' && Number.isFinite(new Date(value * 1000).getTime()) ? new Date(value * 1000).toISOString() : null;
// A credit's expiry in a figure's text: a time mark, which each client writes in its own time zone (Coda's
// docs/agent-protocol.md「文字里的时刻」).
const mark = seconds => `<t:${unixTime(seconds)}>`;

// A value per window of each limit, of what is left and when it resets; unknown is said as unknown, never a zero. A limit's
// name is said only when there are several.
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

// The full resets left: the count is Codex's word (its list of them may be capped or missing). Those listed are the
// available ones, earliest to expire first; one without an expiry never expires.
export function credits(result) {
  const summary = result?.rateLimitResetCredits;
  if (!Number.isSafeInteger(summary?.availableCount)) return null;
  const listed = (summary.credits ?? []).filter(c => c?.status === 'available' && c.resetType === 'codexRateLimits' && typeof c.id === 'string' && c.id)
    .sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity));
  return { count: summary.availableCount, listed };
}

// The login as a resource: its windows, then its full resets left, timed by the one to expire first; its button for a full
// reset (that one, named in its question).
export function resource(account, result, workspace) {
  const name = line(account.email) || '本机登录';
  const values = windows(result), resets = credits(result), buttons = [];
  if (resets) {
    const first = resets.listed[0], expires = first?.expiresAt == null ? null : unixTime(first.expiresAt);
    values.splice(VALUES - 1, Infinity, { label: '完全重置', value: `剩余 ${resets.count} 次`, ...(expires ? { time: expires } : {}) });
    if (first && resets.count > 0) buttons.push({ label: '使用完全重置', action: 'reset', args: { creditId: first.id },
      confirm: `使用 ${line(name, 60)} 的完全重置？\n用最早到期的那一次（${first.expiresAt == null ? '不会过期' : `${mark(first.expiresAt)} 到期`}）。成功后消耗 1 次，无法撤销。` });
  }
  if (!values.length) throw new Error('暂时无法获取额度：Codex 没有给出额度窗口');
  return { name, ...identity(account, workspace), values: values.slice(0, VALUES), buttons };
}

// A failure that only signing in again cures, of a managed account: its login missing, expired, unreadable or another's (thrown
// by the manager as this).
export class SignInAgain extends Error {}
// Whether what Codex said is that its login is gone, expired or revoked, or its file unreadable, or a managed account's login is
// no good: what signing in again cures. Any other failure of a reading (the network, a timeout, a server's error, Codex itself,
// a store that cannot be read) is not, and is left to fail the command.
export const needsSignIn = error => error instanceof SignInAgain || /authentication required|not (logged|signed) in|unauthori[sz]ed|\b401\b|token[^.]*\b(expired|invalid|revoked)\b|auth\.json|failed to (load|read) auth/i.test(error?.message ?? '');

// The resources: none without a login (the type is then offered under「添加资源」), the login for one. A login Codex says is no
// longer good is said on its row, which keeps「重新登录」 at hand; one not signed in with ChatGPT has no windows to read. A quota
// that cannot be read for any other reason throws.
export async function resources(server) {
  const { account, workspaceRouting } = await server.request('account/read', { refreshToken: false });
  const workspace = workspaceRouting?.chatgptAccountId;
  if (!account) return { resources: [] };
  if (account.type !== 'chatgpt') return { resources: [{ name: '本机登录', values: [{ value: '不是 ChatGPT 登录，没有额度' }], buttons: [] }] };
  let result;
  try { result = await server.request('account/rateLimits/read'); }
  catch (error) {
    if (!needsSignIn(error)) throw error;
    return { resources: [{ name: line(account.email) || '本机登录', ...identity(account, workspace), values: [], buttons: [], error: line(`登录已失效，请重新登录：${error.message}`) }] };
  }
  return { resources: [resource(account, result, workspace)] };
}

// What a full reset came to, as one line on the row when it did not reset anything.
export const outcomes = { nothingToReset: '当前额度无需重置', alreadyRedeemed: '这次重置已被使用', noCredit: '这次重置已不可用' };

// What the resources are when Codex says its login is no good (`needsSignIn`): the one row says so. The type's record is still
// written, so its sign-in stays offered.
export const unreadable = error => ({ resources: [{ name: '本机登录', values: [], buttons: [], error: line(`登录已失效，请重新登录：${error.message}`) }] });

// A managed account, from its quota (`result`) or why its login is no good (`error`, a line): the one sessions use says so first;
// its windows, then its full resets left, timed by the one to expire first; switching to it, a full reset (the one to
// expire first, named in its question) and removing it. The selection is a preference; running turns finish before
// adopting it.
export function managedResource(account, chosen, { result, error }) {
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
  // Who it is and in which workspace, as this machine's own login says it (the manager's identity is the workspace's account ID
  // hashed): Coda's group view shows the same one once. None when its email is not known.
  const email = account.alias.includes('@') ? account.alias.trim().toLowerCase() : '';
  return { name, ...(email ? { identity: `codex:${hash(`${email}\n${account.identity}`)}` } : {}),
    values: values.slice(0, VALUES), ...(error ? { error: line(error) } : {}), buttons };
}

// The managed accounts' resources, each read by `read` (at most `at` at once). Empty on a new machine: Coda offers the type's
// signIn under「添加资源」. Existing accounts can be added to or signed in again from a row's「重新登录」. A selection of an account
// not signed in here is a row of its own, saying so. An account whose quota cannot be read for any other reason says so on its
// row while another account's was read; when none was, the source is what is wrong, and the first of them throws.
export async function managedResources(accounts, chosen, read, { at = 4 } = {}) {
  if (!accounts.length && chosen === null) return { resources: [] };
  const shown = accounts.slice(0, ACCOUNTS), readings = new Array(shown.length), unread = new Map();
  let next = 0, ok = 0;
  await Promise.all(Array.from({ length: Math.min(at, shown.length) }, async () => {
    for (let i; (i = next++) < shown.length;) {
      const account = shown[i];
      try { readings[i] = managedResource(account, chosen === account.identity, { result: await read(account) }); ok++; }
      catch (error) {
        if (!needsSignIn(error)) { unread.set(i, error); continue; }
        readings[i] = managedResource(account, chosen === account.identity, { error: error instanceof SignInAgain ? error.message : `登录已失效，请重新登录：${error.message}` });
      }
    }
  }));
  // Every reading is ended first, so that none is left holding an account's lock.
  if (unread.size && !ok) throw unread.values().next().value;
  const WHY = '暂时无法获取额度：';
  for (const [i, { message }] of unread) readings[i] = managedResource(shown[i], chosen === shown[i].identity, { error: message.startsWith(WHY) ? message : WHY + message });
  const out = chosen && !accounts.some(a => a.identity === chosen) ? [{ name: '所选账号', values: [], buttons: [], error: '尚未在插件中登录：重新登录它，或切换到其他账号' }] : [];
  // The selected account when it is not signed in here comes first, as a row of its own; the record stays within 64 KiB, and
  // rows past it are left out.
  let bytes = Buffer.byteLength(JSON.stringify(out));
  for (const each of readings) {
    const size = Buffer.byteLength(JSON.stringify(each)) + 1;
    if (bytes + size > BYTES) break;
    out.push(each); bytes += size;
  }
  return { resources: out };
}

// What the managed accounts are when they cannot be read for want of a login (an old one that cannot be imported, say): the one
// row says why. The type's record is still written, so its sign-in stays offered, which is how to add an account without it.
export const managedUnreadable = error => ({ resources: [{ name: 'Codex 账号', values: [], buttons: [], error: line(error.message) }] });
