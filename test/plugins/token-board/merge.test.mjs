// 视图里几台机器的 board 回包按人合并：同一个（作者, 来源）只算一次，同一身份的几台本机用量相加，读不到的不进合计并标不完整。
// 回包用真的 aggregateLeaderboard 和 summarizeBuckets 造，和模块发给页面的一致。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LOCAL_FAILED, STALE_PLUGIN, mergeBoards } from '../../../plugins/token-board/lib/merge.mjs';
import { DIGITS, NO_NAME, SAKURA, XS_A, XS_B, ZYV } from '../../helpers/accord-keys.mjs';
import { A, B, C, DAY, X, Y, bucket, dayRec, reply, todayRec } from './boards.mjs';

const member = (machine, board) => ({ machine, board });
const displayIds = merged => Object.fromEntries(merged.entries.map(e => [e.author, e.displayId]));
const inputOf = (merged, author) => merged.entries.find(e => e.author === author)?.input;

test('同一作者的两台各有本机数据，又互相读到对方已发布的副本：合计不重复，各取自己的本机数据', () => {
  const mac = [bucket(DAY + 1000, 100)], rig = [bucket(DAY + 2000, 30)];
  // 对方发布的副本：Mac 读到的 rig 副本落后（20，版本 9 反而更高），rig 读到的 Mac 副本也落后（70）。本机数据更新，以它为准。
  const merged = mergeBoards([
    member(X, reply({ selfAuthor: A, sourceId: 'x', local: mac, records: [dayRec(A, 'x', mac), dayRec(A, 'y', [bucket(DAY + 2000, 20)], 9)] })),
    member(Y, reply({ selfAuthor: A, sourceId: 'y', local: rig, records: [dayRec(A, 'y', rig), dayRec(A, 'x', [bucket(DAY + 1000, 70)], 1)] })),
  ]);
  assert.equal(merged.entries.length, 1);
  assert.equal(inputOf(merged, A), 130);
  assert.equal(merged.entries[0].turns, 2);
  assert.deepEqual(merged.entries[0].models.map(m => [m.model, m.totalTokens]), [['opus', 130]]);
  assert.equal(merged.entries[0].self, true);
  assert.equal(merged.incomplete, false);
});

test('榜单展示名：昵称 #4 位尾号，无昵称的公钥给 8 位短码，同一个公钥多台只算一次', () => {
  const first = member(X, reply({ selfAuthor: SAKURA, sourceId: 'x', friends: [{ author: DIGITS }, { author: NO_NAME }] }));
  const second = member(Y, reply({ selfAuthor: SAKURA, sourceId: 'y' }));
  assert.deepEqual(displayIds(mergeBoards([first, second])), { [SAKURA]: 'sakura #8283', [DIGITS]: '07 #3120', [NO_NAME]: 'ffffffff' });
  assert.deepEqual(displayIds(mergeBoards([second])), { [SAKURA]: 'sakura #8283' });
});

test('榜单展示名：同昵称、尾号末 4 位不同的各显示 4 位', () => {
  const sameName = SAKURA.slice(0, -4) + '3d2a';
  const merged = mergeBoards([member(X, reply({ selfAuthor: SAKURA, sourceId: 'x', friends: [{ author: sameName }] }))]);
  assert.deepEqual(displayIds(merged), { [SAKURA]: 'sakura #8283', [sameName]: 'sakura #3514' });
});

test('榜单展示名：同昵称且末 4 位尾号相同时向左加位到能区分，加位范围包括只出现在另一台机器上的作者', () => {
  const first = member(X, reply({ selfAuthor: XS_A, sourceId: 'x', friends: [{ author: SAKURA }] }));
  assert.deepEqual(displayIds(mergeBoards([first])), { [XS_A]: 'xs #4084', [SAKURA]: 'sakura #8283' });
  const second = member(Y, reply({ selfAuthor: XS_B, sourceId: 'y' }));
  assert.deepEqual(displayIds(mergeBoards([first, second])), { [XS_A]: 'xs #04084', [XS_B]: 'xs #14084', [SAKURA]: 'sakura #8283' });
  const third = member({ id: 'z', name: 'NAS' }, reply({ selfAuthor: ZYV, sourceId: 'z', friends: [{ author: XS_B }] }));
  assert.deepEqual(displayIds(mergeBoards([first, third])), { [XS_A]: 'xs #04084', [XS_B]: 'xs #14084', [SAKURA]: 'sakura #8283', [ZYV]: 'zyv #4103' });
});

test('同一条好友记录被两台读到：只算一次，两份版本不同时用最新的', () => {
  const phone = [bucket(DAY + 1000, 10)];
  const same = mergeBoards([
    member(X, reply({ selfAuthor: A, sourceId: 'x', friends: [{ author: B }], records: [dayRec(B, 'phone', phone)] })),
    member(Y, reply({ selfAuthor: A, sourceId: 'y', friends: [{ author: B }], records: [dayRec(B, 'phone', phone)] })),
  ]);
  assert.equal(inputOf(same, B), 10);
  assert.equal(same.entries.length, 2, '好友只出一行');
  const newer = mergeBoards([
    member(X, reply({ selfAuthor: A, sourceId: 'x', friends: [{ author: B }], records: [dayRec(B, 'phone', [bucket(DAY + 1000, 10)], 1)] })),
    member(Y, reply({ selfAuthor: A, sourceId: 'y', friends: [{ author: B }], records: [dayRec(B, 'phone', [bucket(DAY + 1000, 30)], 3)] })),
  ]);
  assert.equal(inputOf(newer, B), 30);
  // 好友的另一个来源只被一台读到：照常并上。
  const split = mergeBoards([
    member(X, reply({ selfAuthor: A, sourceId: 'x', friends: [{ author: B }], records: [dayRec(B, 'phone', phone)] })),
    member(Y, reply({ selfAuthor: A, sourceId: 'y', friends: [{ author: B }], records: [dayRec(B, 'phone', phone), dayRec(B, 'tablet', [bucket(DAY + 1000, 5)])] })),
  ]);
  assert.equal(inputOf(split, B), 15);
});

test('一台读不到：合计只含读到的，并带不完整的标记；旧版插件的回包同样按读不到处理', () => {
  const mac = [bucket(DAY + 1000, 100)];
  const board = reply({ selfAuthor: A, sourceId: 'x', local: mac });
  const down = mergeBoards([member(X, board), { machine: Y, problem: '连不上' }]);
  assert.equal(inputOf(down, A), 100);
  assert.equal(down.locals[0].totalTokens, 100);
  assert.equal(down.incomplete, true);
  assert.deepEqual(down.problems, [{ machine: Y, reason: '连不上' }]);
  const { sources, ...old } = reply({ selfAuthor: A, sourceId: 'y', local: [bucket(DAY + 2000, 30)] });
  const stale = mergeBoards([member(X, board), member(Y, old)]);
  assert.equal(inputOf(stale, A), 100, '旧回包的本机用量不并进来');
  assert.deepEqual(stale.problems, [{ machine: Y, reason: STALE_PLUGIN }]);
  assert.equal(stale.incomplete, true);
  assert.equal(mergeBoards([member(X, board)]).incomplete, false);
});

test('两台身份不同：出来两个人，每人各一块用量，都是「我」', () => {
  const merged = mergeBoards([
    member(X, reply({ selfAuthor: A, sourceId: 'x', local: [bucket(DAY + 1000, 100)] })),
    member(Y, reply({ selfAuthor: C, sourceId: 'y', local: [bucket(DAY + 2000, 300)] })),
  ]);
  assert.deepEqual(merged.entries.map(e => [e.rank, e.author, e.input, e.self]), [[1, C, 300, true], [2, A, 100, true]]);
  assert.deepEqual(merged.locals.map(l => [l.author, l.machines.map(m => m.id), l.input]), [[A, ['x'], 100], [C, ['y'], 300]]);
});

test('同一身份的几台本机用量相加（分模型也相加）；没有身份的机器各算一块', () => {
  const merged = mergeBoards([
    member(X, reply({ selfAuthor: A, sourceId: 'x', local: [bucket(DAY + 1000, 100), { ...bucket(DAY + 1000, 7), model: 'haiku' }] })),
    member(Y, reply({ selfAuthor: A, sourceId: 'y', local: [bucket(DAY + 2000, 30)] })),
    member({ id: 'z', name: 'nas' }, reply({ selfAuthor: null, sourceId: 'z', local: [bucket(DAY + 3000, 4)] })),
    member({ id: 'w', name: 'pi' }, reply({ selfAuthor: null, sourceId: 'w', local: [bucket(DAY + 3000, 2)] })),
  ]);
  assert.deepEqual(merged.locals.map(l => [l.machines.map(m => m.name), l.input, l.turns]), [[['Mac', 'rig'], 137, 3], [['nas'], 4, 1], [['pi'], 2, 1]]);
  assert.deepEqual(merged.locals[0].models.map(m => [m.model, m.input]), [['opus', 130], ['haiku', 7]]);
  assert.deepEqual(merged.noAccord.map(m => m.id), ['z', 'w']);
  assert.equal(merged.accord, true);
});

test('只有一台时，合并结果和这台自己的回包一致', () => {
  const board = reply({ selfAuthor: A, sourceId: 'x', local: [bucket(DAY + 1000, 100)], friends: [{ author: B }], records: [dayRec(B, 'phone', [bucket(DAY + 1000, 10)])] });
  const merged = mergeBoards([member(X, board)]);
  assert.deepEqual(merged.entries.map(e => [e.rank, e.author, e.input, e.turns, e.self, e.shared, e.models.map(m => m.model)]), [[1, A, 100, 1, true, true, ['opus']], [2, B, 10, 1, false, true, ['opus']]]);
  assert.equal(merged.locals.length, 1);
  assert.equal(merged.locals[0].totalTokens, board.local.totalTokens);
});

test('榜单按总量降序排名；提示与截断带上是哪台', () => {
  const merged = mergeBoards([
    member(X, { ...reply({ selfAuthor: A, sourceId: 'x', friends: [{ author: B }], records: [dayRec(B, 'phone', [bucket(DAY + 1000, 50)])] }), errors: ['读不到好友的用量'], truncated: { usage: true, friends: true } }),
    member(Y, reply({ selfAuthor: A, sourceId: 'y', friends: [{ author: B }], local: [bucket(DAY + 2000, 20)] })),
  ]);
  assert.deepEqual(merged.entries.map(e => [e.rank, e.author]), [[1, B], [2, A]]);
  assert.deepEqual(merged.errors, [{ machine: X, text: '读不到好友的用量' }]);
  assert.equal(merged.truncated.friends, true);
  assert.equal(merged.locals[0].truncated, true);
});

test('同一来源的几份副本：取 Token 合计大的，合计相同再比回合数；分片单独更新、周块并成整月都不受版本号影响', () => {
  const nov = input => [bucket(DAY + 1000, input)];
  const merged = (a, b) => mergeBoards([
    member(X, reply({ selfAuthor: A, sourceId: 'x', friends: [{ author: B }], records: a })),
    member(Y, reply({ selfAuthor: A, sourceId: 'y', friends: [{ author: B }], records: b })),
  ]);
  // 分片单独更新：两台都读到无关的十月归档 v50，十一月分别是 v1 的 10 和 v2 的 30。
  const phone = (version, input) => [dayRec(B, 'phone', [bucket(Date.UTC(2026, 9, 5), 1)], 50, '2026-10'), dayRec(B, 'phone', nov(input), version)];
  assert.equal(inputOf(merged(phone(1, 10), phone(2, 30)), B), 30);
  assert.equal(inputOf(merged(phone(2, 30), phone(1, 10)), B), 30, '谁先遍历到都一样');
  // 周块并成整月：旧的周块 v50、v51、v52（和 153）读到 10，新的整月 v53 读到 30。
  const emptyWeek = (n, version) => ({ author: B, kind: 'coda/token-day', id: `phone/2026-11-w${n}`, version, body: { v: 2, days: {} }, local: false });
  const weeks = [emptyWeek(1, 50), emptyWeek(2, 51), { ...dayRec(B, 'phone', nov(10), 52), id: 'phone/2026-11-w3' }];
  assert.equal(inputOf(merged(weeks, [dayRec(B, 'phone', nov(30), 53)]), B), 30);
  assert.equal(inputOf(merged([dayRec(B, 'phone', nov(30), 53)], weeks), B), 30);
  // 合计相同，回合数多的是新的。
  const turns = n => [{ ...bucket(DAY + 1000, 10), turns: n }];
  assert.equal(mergeBoards([member(X, reply({ selfAuthor: A, sourceId: 'x', friends: [{ author: B }], records: [dayRec(B, 'phone', turns(1))] })),
    member(Y, reply({ selfAuthor: A, sourceId: 'y', friends: [{ author: B }], records: [dayRec(B, 'phone', turns(4))] }))]).entries.find(e => e.author === B).turns, 4);
});

test('来源 ID 迁移后：另一台读到的旧 UUID 副本不再计入，退役名单跨机生效，不受本机用量读没读到影响', () => {
  const mine = [bucket(DAY + 1000, 100)];
  const merged = mergeBoards([
    member(X, reply({ selfAuthor: A, sourceId: 'machine-1', excluded: ['old-uuid'], local: mine })),
    member(Y, reply({ selfAuthor: A, sourceId: 'y', local: [], records: [dayRec(A, 'old-uuid', mine), dayRec(A, 'machine-1', mine)] })),
  ]);
  assert.equal(inputOf(merged, A), 100);
  assert.equal(mergeBoards([member(Y, reply({ selfAuthor: A, sourceId: 'y', records: [dayRec(A, 'old-uuid', mine)] }))]).entries[0].input, 100, '没有读到那台，就没有排除名单');
  // 那台本机用量读失败：新 ID 的副本 100 和旧 UUID 的副本 100 只算 100。
  const failed = mergeBoards([
    member(X, reply({ selfAuthor: A, sourceId: 'machine-1', excluded: ['old-uuid'], local: null })),
    member(Y, reply({ selfAuthor: A, sourceId: 'y', local: [], records: [dayRec(A, 'old-uuid', mine), dayRec(A, 'machine-1', mine)] })),
  ]);
  assert.equal(inputOf(failed, A), 100);
});

test('还在等回包的成员算没读到：合计标不完整，不能当它不存在', () => {
  const merged = mergeBoards([member(X, reply({ selfAuthor: A, sourceId: 'x', local: [bucket(DAY + 1000, 100)] })), { machine: Y, pending: true }]);
  assert.deepEqual([merged.incomplete, merged.pending, merged.problems], [true, [Y], []]);
  assert.equal(mergeBoards([member(X, reply({ selfAuthor: A, sourceId: 'x' }))]).incomplete, false);
});

test('本机用量没读到：不交出零值的本机来源去压别的电脑读到的已发布副本，并记一条 partial 的问题', () => {
  const mine = [bucket(DAY + 1000, 100)];
  const failed = reply({ selfAuthor: A, sourceId: 'x', local: null });
  assert.equal(failed.local, null);
  assert.deepEqual(failed.sources, []);
  const merged = mergeBoards([member(X, failed), member(Y, reply({ selfAuthor: A, sourceId: 'y', local: [], records: [dayRec(A, 'x', mine)] }))]);
  assert.equal(inputOf(merged, A), 100);
  assert.deepEqual(merged.problems, [{ machine: X, reason: LOCAL_FAILED, partial: true }]);
  assert.equal(merged.incomplete, true);
  assert.deepEqual(merged.locals.map(l => l.machines.map(m => m.id)), [['y']], '读不到本机用量的这台不进用量块');
  // 自己发布过的副本在本机用量读不到时照常算。
  assert.equal(inputOf(mergeBoards([member(X, reply({ selfAuthor: A, sourceId: 'x', local: null, records: [dayRec(A, 'x', mine)] }))]), A), 100);
});

test('同一来源的副本先比当天曲线的版本：旧曲线盖不满窗口、改用整日归档而合计更大的那份，压不过新曲线', () => {
  const H = 3_600_000, M = 60_000, window = [DAY + 8 * H, DAY + 10 * H + 20 * M];   // UTC 08:00–10:20
  const oldCopy = [bucket(DAY + 7 * H, 100), bucket(DAY + 9 * H, 10)];             // 07:00 在窗口外，整日归档会把它算进来
  const newCopy = [bucket(DAY + 7 * H, 100), bucket(DAY + 9 * H, 10), bucket(DAY + 9 * H + 30 * M, 20)];
  const stale = { records: [dayRec(B, 'phone', oldCopy)], today: [todayRec(B, 'phone', oldCopy, DAY + 9 * H + 45 * M, 3)] };   // 曲线只盖到 10:00
  const fresh = { today: [todayRec(B, 'phone', newCopy, DAY + 10 * H + 10 * M, 7)] };                                           // 曲线盖满窗口
  const board = (machine, sourceId, copy) => member(machine, reply({ selfAuthor: A, sourceId, friends: [{ author: B }], window, ...copy }));
  assert.equal(board(X, 'x', stale).board.sources.find(s => s.author === B).input, 110, '旧副本自己算出 110');
  assert.equal(board(Y, 'y', fresh).board.sources.find(s => s.author === B).input, 30);
  assert.equal(inputOf(mergeBoards([board(X, 'x', stale), board(Y, 'y', fresh)]), B), 30);
  assert.equal(inputOf(mergeBoards([board(Y, 'y', fresh), board(X, 'x', stale)]), B), 30);
  // 一份有曲线记录、另一份没有：有的赢，哪怕没有的那份合计更大。
  const archiveOnly = { records: [dayRec(B, 'phone', oldCopy)] };
  assert.equal(inputOf(mergeBoards([board(X, 'x', archiveOnly), board(Y, 'y', fresh)]), B), 30);
  assert.equal(inputOf(mergeBoards([board(Y, 'y', fresh), board(X, 'x', archiveOnly)]), B), 30);
  // 版本相同：回到比合计。
  const sameVersion = { today: [todayRec(B, 'phone', [bucket(DAY + 9 * H, 5)], DAY + 10 * H + 10 * M, 7)] };
  assert.equal(inputOf(mergeBoards([board(X, 'x', sameVersion), board(Y, 'y', fresh)]), B), 30);
});

test('分层的型号行跨机器合并：同一型号名下的请求项相加，轮数只算一次，好友副本也按型号名并进来', () => {
  const svc = kind => `coda://${kind}/11111111-2222-3333-4444-555555555555`, zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, reportedTurns: 0 };
  const row = (start, over) => ({ start, person: '', agent: 'codex', service: svc('openai-responses'), asked: 'gpt-5', served: null, ...zero, ...over });
  const mac = [row(DAY + 1000, { turns: 2, reportedTurns: 2 }), row(DAY + 1000, { served: 'gpt-5-2025', input: 100 })];
  const rig = [row(DAY + 2000, { service: svc('anthropic-messages'), asked: 'gpt-5-2025', input: 30, turns: 1, reportedTurns: 1 })];
  const friend = [row(DAY + 3000, { asked: 'gpt-5-latest', served: 'gpt-5-2025', input: 7 }), row(DAY + 3000, { asked: 'gpt-5-latest', turns: 1, reportedTurns: 1 })];
  const merged = mergeBoards([
    member(X, reply({ selfAuthor: A, sourceId: 'x', local: mac, friends: [{ author: B }], records: [dayRec(B, 'phone', friend)] })),
    member(Y, reply({ selfAuthor: A, sourceId: 'y', local: rig, friends: [{ author: B }], records: [dayRec(B, 'phone', friend)] })),
  ]);
  const model = merged.locals[0].models;
  assert.deepEqual(model.map(m => [m.model, m.totalTokens, m.turns]), [['gpt-5-2025', 130, 3]]);
  assert.deepEqual(model[0].items.map(item => [item.asked, item.api, item.totalTokens, item.turns]), [['gpt-5', 'openai-responses', 100, 2], ['gpt-5-2025', 'anthropic-messages', 30, 1]]);
  assert.equal(merged.locals[0].turns, 3);
  const mine = merged.entries.find(e => e.author === A), theirs = merged.entries.find(e => e.author === B);
  assert.deepEqual(mine.models.map(m => [m.model, m.items.length]), [['gpt-5-2025', 2]]);
  assert.deepEqual(theirs.models.map(m => [m.model, m.totalTokens, m.turns, m.items.map(item => [item.asked, item.api])]), [['gpt-5-2025', 7, 1, [['gpt-5-latest', 'openai-responses']]]]);
});
