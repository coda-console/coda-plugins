// 造多台机器的 board 回包：用真的 aggregateLeaderboard 和 summarizeBuckets，和模块发给页面的一致。
import { aggregateLeaderboard, buildArchiveBodies, buildTodayBody, summarizeBuckets } from '../../../plugins/token-board/lib/usage.mjs';

export const A = `ed25519:${'a'.repeat(64)}`, B = `ed25519:${'b'.repeat(64)}`, C = `ed25519:${'c'.repeat(64)}`;
export const DAY = Date.UTC(2026, 10, 20);
const FROM = DAY, TO = DAY + 4 * 3_600_000;
export const X = { id: 'x', name: 'Mac' }, Y = { id: 'y', name: 'rig' };

export const bucket = (start, input) => ({ start, agent: 'claude', model: 'opus', input, output: 0, cacheRead: 0, cacheWrite: 0, turns: 1, reportedTurns: 1 });
export const dayRec = (author, sourceId, buckets, version = 1, month = '2026-11') => ({ author, kind: 'coda/token-day', id: `${sourceId}/${month}`, version, body: buildArchiveBodies(buckets)[month], local: false });

export const todayRec = (author, sourceId, buckets, now, version = 1) => ({ author, kind: 'coda/token-today', id: sourceId, version, body: buildTodayBody(buckets, { now }), local: false });

// 一台机器的 board 回包：selfAuthor 为 null 就是没有 Accord 身份；local 为 null 是本机用量没读到；excluded 是这台已弃用的旧来源 ID；
// window 换掉默认的查询窗口 [from, to)；today 是读到的当天曲线记录。
export function reply({ selfAuthor, sourceId, local = [], excluded = [], records = [], today = [], friends = [], window = [FROM, TO] }) {
  const board = aggregateLeaderboard({ selfAuthor, selfSourceId: sourceId, excludedSourceIds: excluded, localBuckets: local, dayRecords: records, todayRecords: today, friends, from: window[0], to: window[1] });
  return { type: 'board', accord: Boolean(selfAuthor), selfAuthor, errors: [], truncated: { usage: false, friends: false, profiles: false }, local: local && summarizeBuckets(local, { from: window[0], to: window[1] }),
    retired: excluded, people: board.entries.map(({ author, shortId, self, shared, name, emoji, color }) => ({ author, shortId, self, shared, name, emoji, color })), sources: board.sources };
}
