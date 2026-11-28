// 目录里 token-board/usage@1 的记录合成页面要的两块：「我」是各台本机用量的合计，好友榜每个（作者, 来源）只算一次——本机的优先，否则取各台镜像里版本最大的。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarize } from '../../../plugins/token-board/lib/merge.mjs';
import { DIGITS, NO_NAME, SAKURA, XS_A, XS_B } from '../../helpers/accord-keys.mjs';
import { A, B, C, DAY, NOW, X, Y, bucket, mirrorDay, mirrorOf, mirrorToday, stateOf, usageOf } from './boards.mjs';

const WINDOW = { from: DAY, to: NOW + 1 };
const inputOf = (summary, author) => summary.board.entries.find(entry => entry.author === author)?.input;
const displayIds = summary => Object.fromEntries(summary.board.entries.map(entry => [entry.author, entry.displayId]));

test('「我」：各台本机用量的合计（不分作者、分模型也相加），机器名取条目的 location', () => {
  const summary = summarize([
    ...usageOf(X, { author: A, sourceId: 'x', buckets: [bucket(DAY + 1000, 100)] }),
    ...usageOf(Y, { author: null, sourceId: 'y', buckets: [bucket(DAY + 2000, 30)] }),
    ...usageOf({ id: 'z', name: 'NAS' }, { author: C, sourceId: 'z', buckets: [bucket(DAY + 3000, 7)] }),
  ], WINDOW);
  assert.deepEqual(summary.mine.machines, ['Mac', 'rig', 'NAS']);
  assert.equal(summary.mine.input, 137);
  assert.equal(summary.mine.turns, 3);
  assert.deepEqual(summary.mine.models.map(model => [model.model, model.totalTokens]), [['opus', 137]]);
  assert.deepEqual(summarize([], WINDOW).mine.machines, []);
});

test('同一来源只算一次，本机用量记录优先于镜像：别的设备读到的旧副本（版本再高）压不过本机的', () => {
  const mac = [bucket(DAY + 1000, 100)], rig = [bucket(DAY + 2000, 30)];
  const summary = summarize([
    stateOf(X, { author: A }), stateOf(Y, { author: A }),
    ...usageOf(X, { author: A, sourceId: 'x', buckets: mac }), ...usageOf(Y, { author: A, sourceId: 'y', buckets: rig }),
    // 各台镜像来的对方副本：落后的数（版本却更高），本机数据更新，以它为准。
    mirrorDay(X, A, 'y', [bucket(DAY + 2000, 20)], 9), mirrorToday(X, A, 'y', [bucket(DAY + 2000, 20)], 9),
    mirrorDay(Y, A, 'x', [bucket(DAY + 1000, 70)], 1), mirrorToday(Y, A, 'x', [bucket(DAY + 1000, 70)], 1),
  ], WINDOW);
  assert.equal(summary.board.entries.length, 1);
  assert.equal(inputOf(summary, A), 130);
  assert.equal(summary.board.entries[0].turns, 2);
  assert.equal(summary.board.entries[0].self, true);
  assert.equal(summary.mine.input, 130);
});

test('好友的记录被几台镜像到：只算一次，按（作者, kind, id）取版本最大的那条，不看哪台', () => {
  const summary = summarize([
    stateOf(X, { author: A, friends: [B] }), stateOf(Y, { author: A, friends: [B] }),
    mirrorDay(X, B, 'phone', [bucket(DAY + 1000, 50)], 3), mirrorDay(Y, B, 'phone', [bucket(DAY + 1000, 80)], 4),
    mirrorToday(X, B, 'phone', [bucket(DAY + 1000, 50)], 5), mirrorToday(Y, B, 'phone', [bucket(DAY + 1000, 80)], 2),
  ], WINDOW);
  assert.equal(inputOf(summary, B), 50, '今天窗口取曲线：曲线版本 5 的那份（50）；日归档被曲线盖住不取');
  const week = summarize([
    stateOf(X, { author: A, friends: [B] }),
    mirrorDay(X, B, 'phone', [bucket(DAY - 86_400_000, 50)], 3), mirrorDay(Y, B, 'phone', [bucket(DAY - 86_400_000, 80)], 4),
  ], { from: DAY - 6 * 86_400_000, to: NOW + 1 });
  assert.equal(inputOf(week, B), 80, '同一块日归档取版本 4 的');
});

test('旧来源（retired）一律不要：本机记录里的 legacy，在同一作者下，别台镜像的旧副本也不算', () => {
  const summary = summarize([
    stateOf(X, { author: A, friends: [B] }),
    ...usageOf(X, { author: A, sourceId: 'machine-1', legacy: ['old-uuid'], buckets: [bucket(DAY + 1000, 100)] }),
    mirrorDay(Y, A, 'old-uuid', [bucket(DAY + 1000, 100)]), mirrorToday(Y, A, 'old-uuid', [bucket(DAY + 1000, 100)]),
    mirrorToday(Y, A, 'tablet', [bucket(DAY + 1000, 7)]),
    mirrorToday(Y, B, 'old-uuid', [bucket(DAY + 1000, 5)]),
  ], WINDOW);
  assert.equal(inputOf(summary, A), 107, '本机 + 兄弟机器，不含旧 UUID');
  assert.equal(inputOf(summary, B), 5, '别人的同名来源 ID 不受影响');
});

test('某个来源有新版记录时，不读它的旧版 coda/token-usage；只有旧版的好友照旧读', () => {
  const legacy = (author, source) => mirrorOf(Y, { author, kind: 'coda/token-usage', id: `2026-11-20/${source}`, body: { blocks: { '01:00': { claude: { opus: { input: 11, output: 0, cacheRead: 0, cacheWrite: 0, turns: 1, reportedTurns: 1 } } } } } });
  const summary = summarize([
    stateOf(X, { author: A, friends: [B, C] }),
    mirrorToday(Y, B, 'phone', [bucket(DAY + 1000, 50)]), legacy(B, 'phone'),
    legacy(C, 'old-phone'),
  ], WINDOW);
  assert.equal(inputOf(summary, B), 50);
  assert.equal(inputOf(summary, C), 11);
});

test('时间窗：今天取曲线，近 7 天曲线盖不到的日子取日归档，不双计', () => {
  const old = bucket(DAY - 3 * 86_400_000 + 36_000_000, 100), recent = bucket(DAY + 3_600_000, 40);
  const records = [stateOf(X, { author: A, friends: [B] }), mirrorDay(Y, B, 'phone', [old, recent]), mirrorToday(Y, B, 'phone', [old, recent])];
  assert.equal(inputOf(summarize(records, WINDOW), B), 40, '今天：曲线里的 40，日归档里今天的那份被曲线盖住');
  assert.equal(inputOf(summarize(records, { from: DAY - 6 * 86_400_000, to: NOW + 1 }), B), 140, '近 7 天：3 天前的日归档 + 今天曲线');
  assert.equal(inputOf(summarize(records, { from: DAY, to: DAY + 1800_000 }), B), 0);
});

test('没分享的好友不进排名，另给个数：没有记录、记录被撤回（空记录体）的都算；自己总在榜上', () => {
  const summary = summarize([
    stateOf(X, { author: A, friends: [B, C, SAKURA] }),
    mirrorToday(Y, B, 'phone', [bucket(DAY + 1000, 50)]),
    mirrorOf(Y, { author: C, kind: 'coda/token-today', id: 'phone', version: 3, body: {} }),
  ], WINDOW);
  assert.deepEqual(summary.board.entries.map(entry => [entry.author, entry.self, entry.rank]), [[B, false, 1], [A, true, 2]]);
  assert.equal(summary.board.unshared, 2);
  assert.equal(summary.board.friends, 3);
});

test('撤回的记录版本更高：压过别台留着的旧副本，不算分享', () => {
  const summary = summarize([
    stateOf(X, { author: A, friends: [B] }),
    mirrorToday(X, B, 'phone', [bucket(DAY + 1000, 50)], 1), mirrorOf(Y, { author: B, kind: 'coda/token-today', id: 'phone', version: 2, body: {} }),
  ], WINDOW);
  assert.deepEqual(summary.board.entries.map(entry => entry.author), [A]);
  assert.equal(summary.board.unshared, 1);
});

test('没有好友（没装好友插件、没有身份）：friends 为 0，榜上只有自己', () => {
  assert.equal(summarize([stateOf(X, { author: A })], WINDOW).board.friends, 0);
  assert.equal(summarize([stateOf(X)], WINDOW).board.friends, 0);
  assert.deepEqual(summarize([stateOf(X)], WINDOW).board.entries, []);
});

test('榜按总 Token 降序、再按回合数，排名从 1 起；各台状态里的作者都是「我」', () => {
  const summary = summarize([
    stateOf(X, { author: A, friends: [B, C] }), stateOf(Y, { author: C, friends: [B] }),
    ...usageOf(X, { author: A, sourceId: 'x', buckets: [bucket(DAY + 1000, 10)] }),
    ...usageOf(Y, { author: C, sourceId: 'y', buckets: [bucket(DAY + 1000, 300)] }),
    mirrorToday(Y, B, 'phone', [bucket(DAY + 1000, 50)]),
  ], WINDOW);
  assert.deepEqual(summary.board.entries.map(entry => [entry.author, entry.rank, entry.self]), [[C, 1, true], [B, 2, false], [A, 3, true]]);
});

test('展示名：昵称 #4 位尾号，无昵称的公钥给 8 位短码；同昵称且末 4 位尾号相同时向左加位，包括只在别台状态里出现的作者', () => {
  const shown = (...friends) => displayIds(summarize([stateOf(X, { author: SAKURA, friends }), stateOf(Y, { author: XS_A }), ...friends.map(friend => mirrorToday(Y, friend, 'phone', [bucket(DAY + 1000, 1)]))], WINDOW));
  assert.deepEqual(shown(DIGITS, NO_NAME), { [SAKURA]: 'sakura #8283', [XS_A]: 'xs #4084', [DIGITS]: '07 #3120', [NO_NAME]: 'ffffffff' });
  assert.deepEqual(shown(XS_B), { [SAKURA]: 'sakura #8283', [XS_A]: 'xs #04084', [XS_B]: 'xs #14084' });
});

test('分层的型号行跨来源合并：同一型号名下的请求项相加，轮数只算一次，好友副本也按型号名并进来', () => {
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, reportedTurns: 0 };
  const row = (over, start = DAY + 1000) => ({ start, person: '', agent: 'codex', service: null, asked: 'gpt-5', served: null, ...zero, ...over });
  const mine = [row({ served: 'gpt-5-2025', input: 900 }), row({ turns: 2, reportedTurns: 2 })];
  const theirs = [row({ served: 'gpt-5-2025', input: 100 }), row({ turns: 1, reportedTurns: 1 })];
  const summary = summarize([stateOf(X, { author: A, friends: [B] }), ...usageOf(X, { author: A, sourceId: 'x', buckets: mine }), mirrorToday(Y, B, 'phone', theirs)], WINDOW);
  assert.deepEqual(summary.mine.models.map(model => [model.model, model.totalTokens, model.turns]), [['gpt-5-2025', 900, 2]]);
  assert.deepEqual(summary.board.entries.find(entry => entry.author === B).models.map(model => [model.model, model.totalTokens, model.turns]), [['gpt-5-2025', 100, 1]]);
});

test('状态记录原样交给页面：带机器名和记录 ID，页面用它画开关与页脚、对它调 set-share', () => {
  const state = stateOf(Y, { author: A, share: false, syncState: 'disabled', lastSyncAt: 5, error: '出错' });
  const { states } = summarize([state], WINDOW);
  assert.deepEqual(states, [{ id: state.id, owner: 'y', machine: 'rig', record: 'state', share: false, syncState: 'disabled', lastSyncAt: 5, error: '出错', withdrawal: null, author: A, friends: [] }]);
});

test('「我」每个型号按机器拆分：同一台的日归档与曲线不双计，只列有用量的机器，按 Token、回合、机器名排序', () => {
  const other = (start, input, model) => ({ ...bucket(start, input), model });
  const mac = [bucket(DAY + 1000, 100), bucket(DAY + 4000, 20), other(DAY + 2000, 5, 'haiku')], rig = [bucket(DAY + 3000, 30)], nas = [bucket(DAY + 3000, 30)];
  const summary = summarize([
    ...usageOf(X, { author: A, sourceId: 'x', buckets: mac }), ...usageOf(Y, { author: A, sourceId: 'y', buckets: rig }), ...usageOf({ id: 'z', name: 'NAS' }, { author: A, sourceId: 'z', buckets: nas }),
  ], WINDOW);
  const view = model => summary.mine.models.find(m => m.model === model).machines.map(m => [m.machine, m.input, m.turns, m.totalTokens]);
  assert.deepEqual(view('opus'), [['Mac', 120, 2, 120], ['NAS', 30, 1, 30], ['rig', 30, 1, 30]]);
  assert.deepEqual(view('haiku'), [['Mac', 5, 1, 5]]);
  for (const model of summary.mine.models) for (const field of ['input', 'output', 'cacheRead', 'cacheWrite', 'turns', 'reportedTurns', 'totalTokens']) assert.equal(model.machines.reduce((n, m) => n + m[field], 0), model[field], `${model.model} ${field}`);
  assert.ok(summary.board.entries.every(entry => entry.models.every(model => !('machines' in model))), '好友榜不带机器名');
});

// 「我」的型号总计与设备拆分出自同一份按机器各算的结果：两边的 Token 与回合逐项守恒。
const FIELD_NAMES = ['input', 'output', 'cacheRead', 'cacheWrite', 'turns', 'reportedTurns', 'totalTokens'];
function assertConserved(mine) {
  for (const model of mine.models) for (const field of FIELD_NAMES) assert.equal(model.machines.reduce((n, m) => n + m[field], 0), model[field], `${model.model} ${field}`);
  for (const field of FIELD_NAMES) assert.equal(mine.models.reduce((n, model) => n + model[field], 0), mine[field], field);
}
const zeros = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, reportedTurns: 0 };
const layer = over => ({ start: DAY + 1000, person: '', agent: 'codex', service: null, asked: 'gpt-5', served: null, ...zeros, ...over });

test('「我」两台设备同一请求名跑到不同实际型号：型号总计与设备拆分的回合一致，各台的回合记在各自的型号上', () => {
  const mac = [layer({ served: 'gpt-5-a', input: 100 }), layer({ turns: 2, reportedTurns: 2 })], rig = [layer({ served: 'gpt-5-b', input: 40 }), layer({ turns: 3, reportedTurns: 3 })];
  const { mine } = summarize([...usageOf(X, { author: A, sourceId: 'x', buckets: mac }), ...usageOf(Y, { author: A, sourceId: 'y', buckets: rig })], WINDOW);
  assert.deepEqual(mine.models.map(model => [model.model, model.totalTokens, model.turns, model.machines.map(m => [m.machine, m.totalTokens, m.turns])]),
    [['gpt-5-a', 100, 2, [['Mac', 100, 2]]], ['gpt-5-b', 40, 3, [['rig', 40, 3]]]]);
  assert.equal(mine.turns, 5);
  assertConserved(mine);
});

test('「我」一台只有纯回合请求行、另一台有实际型号 Token 行：不抛错，结果守恒；空用量也安全', () => {
  const mac = [layer({ turns: 2, reportedTurns: 2 })], rig = [layer({ served: 'gpt-5-a', input: 40 })];
  const { mine } = summarize([...usageOf(X, { author: A, sourceId: 'x', buckets: mac }), ...usageOf(Y, { author: A, sourceId: 'y', buckets: rig })], WINDOW);
  assert.deepEqual(mine.models.map(model => [model.model, model.totalTokens, model.turns, model.machines.map(m => [m.machine, m.totalTokens, m.turns])]),
    [['gpt-5-a', 40, 0, [['rig', 40, 0]]], ['gpt-5', 0, 2, [['Mac', 0, 2]]]]);
  assertConserved(mine);
  const empty = summarize([], WINDOW).mine;
  assert.deepEqual([empty.machines, empty.models, empty.totalTokens, empty.turns], [[], [], 0, 0]);
});
