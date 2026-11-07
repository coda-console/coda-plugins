import { createHash } from 'node:crypto';

// What the「Codex」resource type shows of a login (docs/plugins.md「内置插件：Codex」), from what Codex's app-server says of
// it: `account/read` and `account/rateLimits/read`. Kept apart from the commands so the tests can hand it answers.

const VALUES = 8;
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
  const values = windows(result), resets = credits(result), actions = [];
  if (resets) {
    const first = resets.listed[0], expires = first?.expiresAt == null ? null : unixTime(first.expiresAt);
    values.splice(VALUES - 1, Infinity, { label: '完全重置', value: `剩余 ${resets.count} 次`, ...(expires ? { time: expires } : {}) });
    if (first && resets.count > 0) actions.push({ label: '使用完全重置', action: 'reset', args: { creditId: first.id },
      confirm: `使用 ${line(name, 60)} 的完全重置？\n用最早到期的那一次（${first.expiresAt == null ? '不会过期' : `${mark(first.expiresAt)} 到期`}）。成功后消耗 1 次，无法撤销。` });
  }
  return { name, ...identity(account, workspace), values: values.slice(0, VALUES),
    ...(values.length ? {} : { error: '暂时无法获取额度：Codex 没有给出额度窗口' }), ...(actions.length ? { actions } : {}) };
}

// The resources: none without a login (the type is then offered under「添加资源」), the login for one. Quota Codex cannot
// read is said on its row, which keeps「重新登录」 at hand; one not signed in with ChatGPT has no windows to read.
export async function resources(server) {
  const { account, workspaceRouting } = await server.request('account/read', { refreshToken: false });
  const workspace = workspaceRouting?.chatgptAccountId;
  if (!account) return { resources: [] };
  if (account.type !== 'chatgpt') return { resources: [{ name: '本机登录', values: [{ value: '不是 ChatGPT 登录，没有额度' }] }] };
  let result;
  try { result = await server.request('account/rateLimits/read'); }
  catch (error) { return { resources: [{ name: line(account.email) || '本机登录', ...identity(account, workspace), error: line(`暂时无法获取额度：${error.message}`) }] }; }
  return { resources: [resource(account, result, workspace)] };
}

// What a full reset came to, as one line on the row when it did not reset anything.
export const outcomes = { nothingToReset: '当前额度无需重置', alreadyRedeemed: '这次重置已被使用', noCredit: '这次重置已不可用' };
