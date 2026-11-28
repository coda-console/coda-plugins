// 造目录里 token-board/usage@1 的记录条目（页面 watch 到的样子 `{ owner, location, local, id, version, spec }`）：本机用量、这台的状态、镜像来的签名记录。
// 记录体用真的 buildArchiveBodies、buildTodayBody 造，和模块写出去的一致。
import { buildArchiveBodies, buildTodayBody } from '../../../plugins/token-board/lib/usage.mjs';

export const A = `ed25519:${'a'.repeat(64)}`, B = `ed25519:${'b'.repeat(64)}`, C = `ed25519:${'c'.repeat(64)}`;
export const DAY = Date.UTC(2026, 10, 20);
export const NOW = DAY + 4 * 3_600_000;
export const X = { id: 'x', name: 'Mac' }, Y = { id: 'y', name: 'rig' };
const DAY_KIND = 'coda/token-day', TODAY_KIND = 'coda/token-today';

export const bucket = (start, input) => ({ start, agent: 'claude', model: 'opus', input, output: 0, cacheRead: 0, cacheWrite: 0, turns: 1, reportedTurns: 1 });

let count = 0;
const entry = (machine, spec) => ({ owner: machine.id, location: machine.name, local: machine.id === 'x', id: `record-${++count}`, version: String(count), spec });

// 一台的状态记录。
export const stateOf = (machine, { author = null, share = true, syncState = 'synced', lastSyncAt = null, error = null, withdrawal = null, friends = [] } = {}) =>
  entry(machine, { record: 'state', share, syncState, lastSyncAt, error, withdrawal, author, friends });

// 一台的本机用量记录（月块日归档与 48 小时曲线两条）：author 是写它时的作者，legacy 是这台已弃用的旧来源 ID。
export const usageOf = (machine, { author, sourceId, buckets, legacy = [], now = NOW, month = '2026-11' }) => [
  entry(machine, { record: 'usage', kind: DAY_KIND, id: `${sourceId}/${month}`, author, sourceId, legacy, body: buildArchiveBodies(buckets)[month] }),
  entry(machine, { record: 'usage', kind: TODAY_KIND, id: sourceId, author, sourceId, legacy, body: buildTodayBody(buckets, { now }) }),
];

// 一台镜像来的签名记录。
export const mirrorOf = (machine, { author, kind, id, version = 1, body }) => entry(machine, { record: 'mirror', author, kind, id, version, body });
export const mirrorDay = (machine, author, sourceId, buckets, version = 1, month = '2026-11') => mirrorOf(machine, { author, kind: DAY_KIND, id: `${sourceId}/${month}`, version, body: buildArchiveBodies(buckets)[month] });
export const mirrorToday = (machine, author, sourceId, buckets, version = 1, now = NOW) => mirrorOf(machine, { author, kind: TODAY_KIND, id: sourceId, version, body: buildTodayBody(buckets, { now }) });
