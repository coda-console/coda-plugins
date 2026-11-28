// 页面把目录里 token-board/usage@1 的记录合成页面要的两块：纯函数，不碰 Coda 的 Node API；页面和单测都加载它
// （身份展示名取自 WebView 标准库 coda-view://lib/v1/accord.js）。
//
// 记录有三种（spec.record）：
// - usage：一台机器的本机用量（月块日归档的一块，或 48 小时曲线），带作者、sourceId 与弃用的旧来源 ID；
// - state：这台的分享状态、本机作者与好友网关给的好友作者；
// - mirror：好友与自己别的设备的签名记录（kind、id、version、body），各台镜像来的可能是同一条的不同版本。
// 「我」是各台 usage 的合计（不分作者）。好友榜每个（作者, sourceId）只算一次：有那台本机用量记录的用本机的，否则取各台镜像里
// （作者, kind, id）版本最大的一条；同一作者下 retired 的旧来源一律不要；窗口的拼法、旧版 coda/token-usage 的取舍都在 aggregateLeaderboard 里。
// 已知边界：好友撤回记录后，还没同步到的那台会让旧数多显示一会儿，不处理。

import { identityTitles } from 'coda-view://lib/v1/accord.js';
import { aggregateLeaderboard, DAY_ARCHIVE_KIND, FIELDS, isWithdrawn, sourceOf, Tally, TODAY_CURVE_KIND, USAGE_RECORD_KIND } from './usage.mjs';

const ALL = 'all';   // 「我」的合计不分作者：聚合时把各台本机用量当同一个作者
const keyOf = (...parts) => JSON.stringify(parts);
// 签名记录的写法；本机用量记录没有版本（同一来源只取本机的，不比版本）。
const asRecord = (spec, author, version) => ({ author, kind: spec.kind, id: spec.id, version, body: spec.body });
// 撤回留下的空记录体：好友撤回了就是没分享。
const withdrawn = spec => !Object.keys(spec.body).length || isWithdrawn(spec.kind, spec.body);

function aggregate(records, authors, from, to) {
  return aggregateLeaderboard({
    friends: authors.map(author => ({ author })), from, to,
    dayRecords: records.filter(record => record.kind === DAY_ARCHIVE_KIND), todayRecords: records.filter(record => record.kind === TODAY_CURVE_KIND),
    legacyUsageRecords: records.filter(record => record.kind === USAGE_RECORD_KIND),
  });
}

/**
 * entries：目录里本协议的记录条目 `{ owner, location, local, version, id, spec }`；`[from, to)` 是时间窗。
 * 返回：
 * - `mine`：各台本机用量的合计与分模型（Tally 的结果），`machines` 是有本机用量记录的机器名（条目的 `location`）；
 *   每个型号另带 `machines`：按机器拆开的用量 `{ machine, ...计数, totalTokens }`，每台机器自己的记录单独走一遍聚合（日归档与曲线不双计），只列有用量或回合的机器；
 * - `board`：好友榜 `{ friends, entries, unshared }`：`friends` 是好友（不含自己）的人数；`entries` 是分享了的人（含「我」），已按总 Token 排名，
 *   每项带 `author`、`displayId`（`昵称 #4位尾号`，同昵称且尾号相撞时向左加位）、`self`、`rank`、合计与分模型；`unshared` 是没分享的好友个数；
 * - `states`：各台的状态记录 `{ id, owner, machine, ...spec }`，页面拿它画分享开关与页脚。
 */
export function summarize(entries, { from, to }) {
  const states = [], usage = [], mirrors = [];
  for (const entry of entries) {
    const record = entry.spec?.record;
    if (record === 'state') states.push(entry);
    else if (record === 'usage') usage.push(entry);
    else if (record === 'mirror') mirrors.push(entry.spec);
  }

  // 「我」按机器各算一遍（各自的窗口去重与回合归因），再把各台的型号行并成总计：设备明细与型号总计出自同一份结果，Token 与回合完全守恒。
  // 按稳定的设备标识（owner、没有就取来源 ID，再没有取展示名）分组，展示名只是标签，不当分组键；重名的设备在展示名后加设备标识的尾部区分，
  // 标签避开所有不重名设备的原名和已生成的标签：尾号相撞就向左加位，加到整个标识仍相撞再加编号。
  const byDevice = Map.groupBy(usage, entry => entry.owner || entry.spec.sourceId || entry.location), tally = new Tally(), perModel = new Map();
  const devices = [...byDevice].map(([device, group]) => ({ id: String(device), group, name: group[0].location }));
  const nameCount = Map.groupBy(devices, device => device.name);
  const taken = new Set(devices.filter(device => nameCount.get(device.name).length === 1).map(device => device.name));
  const machines = devices.map(({ id, group, name }) => {
    if (!name || nameCount.get(name).length === 1) return { machine: name, group };
    const candidates = [...Array.from({ length: Math.max(id.length - 3, 1) }, (_, i) => `${name} · ${id.slice(-(4 + i))}`), ...Array.from({ length: devices.length }, (_, i) => `${name} · ${id} #${i + 2}`)];
    const machine = candidates.find(label => !taken.has(label));
    taken.add(machine);
    return { machine, group };
  });
  for (const { machine, group } of machines) {
    for (const model of aggregate(group.map(({ spec }) => asRecord(spec, ALL, 0)), [ALL], from, to).entries[0].models) {
      tally.addModel(model);
      if (!machine || !(model.totalTokens > 0 || model.turns > 0)) continue;
      if (!perModel.has(model.model)) perModel.set(model.model, []);
      perModel.get(model.model).push({ machine, ...Object.fromEntries(FIELDS.map(field => [field, model[field]])), totalTokens: model.totalTokens });
    }
  }
  const totals = tally.result();
  const byUse = (a, b) => b.totalTokens - a.totalTokens || b.turns - a.turns || (a.machine < b.machine ? -1 : a.machine > b.machine ? 1 : 0);
  const mine = { machines: machines.map(({ machine }) => machine), ...totals, models: totals.models.map(model => ({ ...model, machines: (perModel.get(model.model) ?? []).sort(byUse) })) };

  const selves = new Set(states.map(({ spec }) => spec.author).filter(Boolean));
  const authors = [...new Set([...selves, ...states.flatMap(({ spec }) => spec.friends)])];
  const local = new Set(usage.filter(({ spec }) => spec.author).map(({ spec }) => keyOf(spec.author, spec.sourceId)));
  const retired = new Set(usage.filter(({ spec }) => spec.author).flatMap(({ spec }) => spec.legacy.map(id => keyOf(spec.author, id))));
  const latest = new Map();
  for (const spec of mirrors) {
    const key = keyOf(spec.author, spec.kind, spec.id);
    if (!latest.has(key) || spec.version > latest.get(key).version) latest.set(key, spec);
  }
  const records = [
    ...usage.filter(({ spec }) => spec.author).map(({ spec }) => asRecord(spec, spec.author, 0)),
    ...[...latest.values()].filter(spec => {
      const source = keyOf(spec.author, sourceOf(spec.kind, spec.id));
      return !local.has(source) && !retired.has(source) && !withdrawn(spec);
    }).map(spec => asRecord(spec, spec.author, spec.version)),
  ];
  // 展示名按这次榜单里的全部作者一起算：同昵称、末 4 位尾号相同的才向左加位。
  const titles = identityTitles(authors);
  const people = aggregate(records, authors, from, to).entries
    .map(person => ({ ...person, self: selves.has(person.author), shared: selves.has(person.author) || person.shared, displayId: titles.get(person.author) ?? '未知' }));
  const ranked = people.filter(person => person.shared).map((person, index) => ({ ...person, rank: index + 1 }));
  const board = { friends: people.filter(person => !person.self).length, entries: ranked, unshared: people.filter(person => !person.shared).length };

  return { mine, board, states: states.map(({ id, owner, location, spec }) => ({ id, owner, machine: location, ...spec })) };
}
