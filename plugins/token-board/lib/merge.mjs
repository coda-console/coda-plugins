// 页面把视图里各台机器的 board 回包按人合并成一份：纯函数，不碰 Coda 的 Node API；页面和单测都加载它。
//
// 两台都可能读到同一位好友的记录、都读到对方发布的副本，按作者直接相加会重复，所以合并靠回包里的 sources：
// 每个 (作者, 来源) 的合计，和它是不是这台自己的本机数据。同一个 (作者, 来源) 只算一次：有那台来源自己的本机数据就用它；否则依次比：
// 1. 当天曲线记录（coda/token-today）的版本 todayVersion，高的赢，一份有一份没有就有的赢。曲线一个来源只有一条、每次发布覆盖，版本由发布方签出，
//    各台读到的可直接比，不受归档分块变化影响；不比合计，因为旧曲线盖不满查询窗口时后端改用整日归档，把窗口外的用量也算进来，旧副本的合计反而更大；
// 2. todayVersion 相同，或两份都没有曲线记录（只有旧版记录的来源）：比 Token 合计大的，再比回合数。
// 已知边界：好友撤回记录后，还没同步到的那台会让旧数多显示一会儿，不处理。
// 某台已弃用的旧来源 ID（回包的 retired，不受本机用量读没读到影响）在同一作者下统一不要；再按作者汇总，排序沿用 aggregateLeaderboard。

import { Tally, compareEntries, shortAuthor } from './usage.mjs';

export const STALE_PLUGIN = '这台的 Token 消耗榜插件需要更新';
export const LOCAL_FAILED = '读不到本机用量';

const addModels = (tally, usage) => { for (const model of usage.models ?? []) tally.add(model); };
const fresher = (a, b) => (a === undefined ? false : b === undefined || a > b);
const better = (source, held) => {
  if (source.local || held.local) return source.local && !held.local;
  if (source.todayVersion !== held.todayVersion) return fresher(source.todayVersion, held.todayVersion);
  return (source.totalTokens - held.totalTokens || source.turns - held.turns) > 0;
};

// Accord 公钥昵称规则 v1：从最高位起每次读 7 位，最多读 36 组。
function accordId(author) {
  if (typeof author !== 'string' || !/^ed25519:[0-9a-f]{64}$/.test(author)) return null;
  const bytes = author.slice(8).match(/../g).map(pair => Number.parseInt(pair, 16));
  let id = '';
  for (let group = 0; group < 36; group++) {
    let value = 0;
    for (let bit = group * 7; bit < (group + 1) * 7; bit++) {
      value = (value << 1) | ((bytes[bit >> 3] >> (7 - (bit & 7))) & 1);
    }
    if (value < 78) id += String.fromCharCode(97 + value % 26);
    else if (value < 88) id += String(value - 78);
    else if (id.length >= 2) break;
  }
  return id.length >= 2 ? id : null;
}

/**
 * members：视图里的每台机器 `{ machine: { id, name }, board }`（读到了回包）、`{ machine, problem }`（读不到，problem 是原因）或 `{ machine, pending: true }`（还在等回包）。
 * 没带 `sources` 的回包来自旧版插件，按读不到处理；回包里本机用量没读到（`local` 为 null）的，榜单照用，但记一条 `partial` 的 problem。
 * 返回：
 * - `entries`：榜单，每个作者一行，带消歧后的 `displayId`；
 * - `locals`：本机用量，每个身份一块 `{ author, machines, ...合计与分模型, truncated }`；同一身份（selfAuthor）的几台相加，没有身份的每台各算一块；
 * - `problems`：`[{ machine, reason, partial? }]`，`pending`：还在等回包的机器；`incomplete` 为真表示合计还不全；
 * - `readable`：有没有读到回包的机器；`friends`：读到回包的机器里有没有哪台有好友（回包的 `friendCount`，与榜上谁是「我」无关）；`accord`、`noAccord`（读到了但没有 Accord 身份的机器）、`errors`（各台回包里的提示 `{ machine, text }`）、`truncated`。
 */
export function mergeBoards(members) {
  const problems = [], pending = [], boards = [];
  for (const { machine, board, problem, pending: waiting } of members) {
    if (problem) problems.push({ machine, reason: problem });
    else if (waiting) pending.push(machine);
    else if (!Array.isArray(board?.sources)) problems.push({ machine, reason: STALE_PLUGIN });
    else {
      boards.push({ machine, board });
      if (board.local == null) problems.push({ machine, reason: LOCAL_FAILED, partial: true });
    }
  }

  const retired = new Set();
  for (const { board } of boards) for (const id of board.retired ?? []) retired.add(JSON.stringify([board.selfAuthor, id]));
  const chosen = new Map();
  for (const { board } of boards) {
    for (const source of board.sources) {
      const key = JSON.stringify([source.author, source.sourceId]), held = chosen.get(key);
      if (!source.local && retired.has(key)) continue;
      if (!held || better(source, held)) chosen.set(key, source);
    }
  }

  const people = new Map();
  const person = author => {
    if (!people.has(author)) people.set(author, { author, self: false, shared: false, tally: new Tally() });
    return people.get(author);
  };
  for (const { board } of boards) {
    for (const entry of board.people ?? []) {
      const one = person(entry.author);
      one.self ||= entry.self === true;
      one.shared ||= entry.shared === true;
    }
  }
  for (const source of chosen.values()) addModels(person(source.author).tally, source);
  const ids = new Map(), counts = new Map();
  for (const author of people.keys()) {
    const id = accordId(author);
    ids.set(author, id);
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const entries = [...people.values()].map(({ tally, ...one }) => {
    const id = ids.get(one.author);
    const displayId = id ? (counts.get(id) > 1 ? `${id}(${one.author.slice(-4)})` : id) : `${shortAuthor(one.author)}…`;
    return { ...one, displayId, ...tally.result() };
  }).sort(compareEntries);
  entries.forEach((entry, index) => { entry.rank = index + 1; });

  const groups = new Map();
  for (const { machine, board } of boards.filter(({ board }) => board.local != null)) {
    const key = board.selfAuthor ?? `machine:${machine.id}`;
    if (!groups.has(key)) groups.set(key, { author: board.selfAuthor ?? null, machines: [], tally: new Tally(), truncated: false });
    const group = groups.get(key);
    group.machines.push(machine);
    group.truncated ||= board.truncated?.usage === true;
    addModels(group.tally, board.local ?? {});
  }
  const locals = [...groups.values()].map(({ tally, ...group }) => ({ ...group, ...tally.result() }));

  return {
    entries, locals, problems, pending, readable: boards.length > 0, incomplete: problems.length > 0 || pending.length > 0,
    friends: boards.some(({ board }) => board.friendCount > 0),
    accord: boards.some(({ board }) => board.accord),
    noAccord: boards.filter(({ board }) => !board.accord).map(({ machine }) => machine),
    errors: boards.flatMap(({ machine, board }) => (board.errors ?? []).map(text => ({ machine, text }))),
    truncated: { friends: boards.some(({ board }) => board.truncated?.friends) },
  };
}
