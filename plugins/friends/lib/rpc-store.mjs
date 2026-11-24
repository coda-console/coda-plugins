// 好友签名网关的本机状态：插件状态目录下 `rpc/` 里的四样东西。
//   grants.json    授权表（持有方）：本机授权行是权威，撤权先落盘。
//   inflight.json  在途与去重表（持有方）：键是 (调用方作者, 请求号)，状态只进不退，终态先落盘。
//   outgoing.json  发出表（调用方）：本人查账用。
//   ledger-YYYY-MM.jsonl  操作记录（持有方）：每个请求一行，拒绝按「作者、原因、分钟」合并成一行，留 90 天。
// 表文件与操作记录的月份文件都原子写入（临时文件 + rename，文件 0600、目录 0700）。读出来不是合法 JSON、或形状不对，就抛 `corrupt`，调用方据此停止准入，
// 绝不当成空表继续；文件不存在才是空表。同一个 store 里所有读改写排成一条队。
import { createHash } from 'node:crypto';
import { chmod, mkdir, open, readFile, readdir, rename, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isAuthor, rebuildExecInput } from './rpc-format.mjs';

const MINUTE = 60_000, DAY = 24 * 60 * MINUTE;
export const LIMITS = Object.freeze({
  inflight: Object.freeze({ author: 8, total: 32 }),
  executing: Object.freeze({ author: 4, total: 8 }),
  perMinute: Object.freeze({ author: 30, total: 120 }),
  table: 4096,
});
// 在途与同时执行超限时给调用方的重试提示（每分钟新请求超限的，按最早一条滑出窗口的时刻算）。
export const BUSY_RETRY_MS = 5_000;
export const KEEP_AFTER_EXPIRY_MS = DAY, LEDGER_KEEP_MS = 90 * DAY;
export const SUMMARY_CHARS = 80;
const TERMINAL = ['completed', 'failed', 'canceled'], STATES = ['admitted', 'submitted', ...TERMINAL];
const OUT_STATES = ['sent', 'canceled', 'finished'];

const isPlain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = value => typeof value === 'string' && value !== '';
const isTime = value => Number.isSafeInteger(value) && value >= 0;
const optional = (value, check) => value === undefined || check(value);
const isTarget = value => isPlain(value) && ['owner', 'provider', 'kind', 'id'].every(key => isText(value[key]));

const invalid = message => Object.assign(new Error(message), { code: 'invalid_input', effects: 'none' });
const corrupt = (name, why) => Object.assign(new Error(`好友调用的状态文件 ${name} 损坏（${why}），已停止使用，不会当成空表继续`), { code: 'corrupt', file: name, effects: 'none' });
export const isCorrupt = error => error?.code === 'corrupt';

// ---- 条目的形状 ----

const grantOk = entry => isPlain(entry) && isText(entry.id) && isPlain(entry.holder) && isAuthor(entry.holder.root) && isText(entry.holder.machine)
  && isAuthor(entry.grantee) && isTarget(entry.target) && Array.isArray(entry.ops) && entry.ops.length === 1 && entry.ops[0] === 'exec'
  && isTime(entry.createdAt) && optional(entry.revokedAt, isTime);

// 在途项按状态校验：非终态要有完整的子调用参数（固定目标、重建后的输入；幂等键与最晚启动时刻每项都有），且不带结局与「已签出」；
// 终态带结局或「已签出」之一（签出后结局释放）；取消标记与取消时刻成对出现。
const inflightOk = entry => {
  // 存的是重建后的 exec 输入：按 rpc-format 的重建规则能原样重建（结果与存的完全相同）才算。
  const inputOk = input => { const rebuilt = rebuildExecInput(input); return rebuilt.ok && isDeepStrictEqual(rebuilt.input, input); };
  const callOk = call => isPlain(call) && isTarget(call.target) && inputOk(call.input);
  if (!(isPlain(entry) && isAuthor(entry.caller) && isText(entry.request) && isText(entry.grant) && isText(entry.digest) && isText(entry.key)
    && isTime(entry.notAfter) && isTime(entry.admittedAt) && STATES.includes(entry.state)
    && optional(entry.call, callOk) && optional(entry.canceled, value => value === true) && optional(entry.canceledAt, isTime)
    && optional(entry.signed, value => value === true) && optional(entry.outcome, outcome => isPlain(outcome) && isTime(outcome.finishedAt)))) return false;
  if ((entry.canceled === undefined) !== (entry.canceledAt === undefined)) return false;
  if (!TERMINAL.includes(entry.state)) return callOk(entry.call) && entry.outcome === undefined && entry.signed === undefined;
  return entry.signed === true ? entry.outcome === undefined : entry.outcome !== undefined;
};

const outgoingOk = entry => isPlain(entry) && isText(entry.request) && isText(entry.call) && isText(entry.key) && isText(entry.machine)
  && (entry.parent === null || isText(entry.parent)) && isTime(entry.expiresAt) && OUT_STATES.includes(entry.state);

const TABLES = {
  grants: { file: 'grants.json', field: 'grants', ok: grantOk, keyOf: entry => entry.id },
  inflight: { file: 'inflight.json', field: 'entries', ok: inflightOk, keyOf: entry => inflightKey(entry.caller, entry.request) },
  outgoing: { file: 'outgoing.json', field: 'entries', ok: outgoingOk, keyOf: entry => entry.request },
};

/** 在途表的键：(调用方作者, 请求号)。 */
export const inflightKey = (caller, request) => `${caller}/${request}`;

// ---- 文件 ----

let counter = 0;
async function writeAtomic(dir, name, text) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const target = join(dir, name), temporary = join(dir, `${name}.${process.pid}.${++counter}.tmp`);
  try {
    const handle = await open(temporary, 'w', 0o600);
    try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, target);
  } catch (e) { await rm(temporary, { force: true }).catch(() => {}); throw e; }
}

// 整张表的毛病：形状不对、有项不合格、键与项对不上；没毛病给 null。读盘与每次写入都过它。
function tableProblem({ field, ok, keyOf }, parsed) {
  if (!isPlain(parsed) || parsed.v !== 1 || !isPlain(parsed[field])) return '形状不对';
  for (const [key, entry] of Object.entries(parsed[field])) if (!ok(entry) || keyOf(entry) !== key) return `项 ${key} 形状不对`;
  return null;
}

async function readTable(dir, table) {
  const { file, field } = table;
  let text;
  try { text = await readFile(join(dir, file), 'utf8'); } catch (e) {
    if (e?.code === 'ENOENT') return {};
    throw e;
  }
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw corrupt(file, '不是合法的 JSON'); }
  const problem = tableProblem(table, parsed);
  if (problem) throw corrupt(file, problem);
  return parsed[field];
}

function writeTable(dir, table, entries) {
  const value = { v: 1, [table.field]: entries }, problem = tableProblem(table, value);
  if (problem) throw invalid(`${table.file} 要写的内容不合格：${problem}`);
  return writeAtomic(dir, table.file, `${JSON.stringify(value, null, 2)}\n`);
}

// ---- 操作记录 ----

const monthOf = at => new Date(at).toISOString().slice(0, 7);
const LEDGER = /^ledger-(\d{4})-(\d{2})\.jsonl$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** 命令的摘要：前 80 个字符与整条命令的 sha256；操作记录默认只存这个，不存命令全文。 */
export const commandInfo = text => ({ summary: [...text].slice(0, SUMMARY_CHARS).join(''), sha256: createHash('sha256').update(text).digest('hex') });

// 一行的形状：字段是固定的一组，多一项少一项都不行（命令全文、cwd、stdin 进不来）。写入前校验新行，读月份文件时校验每一行。
const hasKeys = (value, required, optionalKeys = []) => isPlain(value) && required.every(key => Object.hasOwn(value, key))
  && Object.keys(value).every(key => required.includes(key) || optionalKeys.includes(key));
const rejectionRowOk = row => hasKeys(row, ['v', 'at', 'friend', 'outcome', 'code', 'count']) && row.v === 1 && isTime(row.at) && isAuthor(row.friend)
  && isText(row.code) && Number.isSafeInteger(row.count) && row.count >= 1;
const completedRowOk = row => hasKeys(row, ['v', 'at', 'request', 'friend', 'grant', 'target', 'op', 'command', 'outcome', 'ms'], ['code', 'exitCode'])
  && row.v === 1 && isTime(row.at) && isText(row.request) && isAuthor(row.friend) && isText(row.grant)
  && hasKeys(row.target, ['kind', 'id', 'name']) && ['kind', 'id', 'name'].every(key => isText(row.target[key])) && row.op === 'exec'
  && hasKeys(row.command, ['summary', 'sha256']) && typeof row.command.summary === 'string' && [...row.command.summary].length <= SUMMARY_CHARS && typeof row.command.sha256 === 'string' && SHA256.test(row.command.sha256)
  && isText(row.outcome) && optional(row.code, isText) && optional(row.exitCode, value => value === null || Number.isSafeInteger(value))
  && Number.isSafeInteger(row.ms) && row.ms >= 0;
// 合并后的拒绝行（outcome 是 rejected）与正常行各一套形状；两条写入路径与读取共用这一个判断。
const ledgerRowOk = row => isPlain(row) && (row.outcome === 'rejected' ? rejectionRowOk(row) : completedRowOk(row));

// ---- store ----

/**
 * `stateDir` 是插件状态目录，表与记录在它下面的 `rpc/`。`now` 可换（测试用）。
 * 所有方法都是异步的、排成一条队；读到损坏的表就抛 `corrupt`（见 `isCorrupt`）。
 */
export function createRpcStore(stateDir, { now = Date.now } = {}) {
  const dir = join(stateDir, 'rpc');
  let chain = Promise.resolve(), prunedDay = null;
  const serial = work => {
    const run = chain.then(work);
    chain = run.then(() => {}, () => {});
    return run;
  };
  const load = name => readTable(dir, TABLES[name]);
  const save = (name, entries) => writeTable(dir, TABLES[name], entries);

  // ---- 授权 ----

  // 授权号冲突、形状不对都是调用方的错；`target` 是固定的 { owner, provider, kind, id }。
  const addGrant = ({ id, holder, grantee, target, createdAt }) => serial(async () => {
    const entry = { id, holder, grantee, target, ops: ['exec'], createdAt };
    if (!grantOk(entry)) throw invalid('授权的各项不合格');
    const grants = await load('grants');
    if (grants[id]) throw invalid(`授权号 ${id} 已存在`);
    grants[id] = entry;
    await save('grants', grants);
    return entry;
  });

  // 撤权：先落盘再返回；已撤的不改撤回时刻。没有这条授权给 null。
  const revokeGrant = (id, at = now()) => serial(async () => {
    const grants = await load('grants'), entry = grants[id];
    if (!entry) return null;
    if (entry.revokedAt === undefined) {
      grants[id] = { ...entry, revokedAt: at };
      await save('grants', grants);
    }
    return grants[id];
  });

  // ---- 在途与去重 ----

  const live = entries => Object.values(entries).filter(entry => now() < entry.notAfter);
  const purged = entries => Object.fromEntries(Object.entries(entries).filter(([, entry]) => now() < entry.notAfter + KEEP_AFTER_EXPIRY_MS));

  const counts = (entries, caller) => {
    const tally = state => {
      const rows = Object.values(entries).filter(entry => state.includes(entry.state));
      return { author: rows.filter(entry => entry.caller === caller).length, total: rows.length };
    };
    return { inflight: tally(['admitted', 'submitted']), executing: tally(['submitted']) };
  };

  const busy = (limit, scope, retryAfterMs = BUSY_RETRY_MS) => ({ ok: false, code: 'busy', limit, scope, retryAfterMs });
  // 每分钟新请求：按已落盘的准入时刻（admittedAt）数一分钟的滑动窗口，写盘失败的请求不占名额。
  // 超限时 retryAfterMs 是再滑出一条、回到上限以内还要多久。
  const rateVerdict = (entries, caller) => {
    const at = now(), recent = Object.values(entries).filter(entry => at - entry.admittedAt < MINUTE).sort((a, b) => a.admittedAt - b.admittedAt);
    for (const [scope, rows, limit] of [['author', recent.filter(entry => entry.caller === caller), LIMITS.perMinute.author], ['total', recent, LIMITS.perMinute.total]])
      if (rows.length >= limit) return busy('perMinute', scope, rows[rows.length - limit].admittedAt + MINUTE - at);
    return null;
  };
  const tallyVerdict = (kind, counted) => {
    if (counted.author >= LIMITS[kind].author) return busy(kind, 'author');
    if (counted.total >= LIMITS[kind].total) return busy(kind, 'total');
    return null;
  };

  /**
   * 准入一个请求：同号去重、表容量、在途与每分钟配额都过了，才写入一项 `admitted`。给
   * `{ ok: true, entry }`，或 `{ ok: false, code }`：`duplicate`（同号同摘要，带原来那一项）、`digest_conflict`（同号不同摘要，原项不动）、
   * `table_full`（没过期的项已达 4096，不挤掉任何一项）、`busy`（带 `limit`、`scope`、`retryAfterMs`）。
   * `canceled: true` 是取消先于请求到达：先留下标记，之后不会再启动。过期 24 小时的旧项顺手清掉。
   */
  const admit = ({ caller, request, grant, digest, key, notAfter, call, canceled }) => serial(async () => {
    const at = now(), entry = { caller, request, grant, digest, key, notAfter, admittedAt: at, state: 'admitted', call, ...(canceled ? { canceled: true, canceledAt: at } : {}) };
    if (!inflightOk(entry) || !call) throw invalid('在途项的各项不合格');
    const entries = purged(await load('inflight')), slot = inflightKey(caller, request), old = entries[slot];
    if (old) return old.digest === digest ? { ok: false, code: 'duplicate', entry: old } : { ok: false, code: 'digest_conflict', entry: old };
    if (live(entries).length >= LIMITS.table) return { ok: false, code: 'table_full' };
    const verdict = tallyVerdict('inflight', counts(entries, caller).inflight) ?? rateVerdict(entries, caller);
    if (verdict) return verdict;
    entries[slot] = entry;
    await save('inflight', entries);
    return { ok: true, entry };
  });

  // 改一项：`change(entry, entries)` 给新的一项，或给 `{ ok: false, ... }` 拒绝；落盘后才返回。
  const update = (caller, request, change) => serial(async () => {
    const entries = await load('inflight'), slot = inflightKey(caller, request), entry = entries[slot];
    if (!entry) return { ok: false, code: 'unknown' };
    const next = change(entry, entries);
    if (next.ok === false) return next;
    if (next !== entry) {
      if (!inflightOk(next)) throw invalid('在途项的各项不合格');
      entries[slot] = next;
      await save('inflight', entries);
    }
    return { ok: true, entry: next };
  });

  const get = (caller, request) => serial(async () => (await load('inflight'))[inflightKey(caller, request)] ?? null);

  // 标记已取消：已有终态的不改（`terminal`），已标记的不重复写。没有这一项给 `unknown`，调用方再用 `admit({ canceled: true })` 留标记。
  const cancel = (caller, request) => update(caller, request, entry => {
    if (TERMINAL.includes(entry.state)) return { ok: false, code: 'terminal', entry };
    return entry.canceled ? entry : { ...entry, canceled: true, canceledAt: now() };
  });

  /**
   * admitted → submitted，提交给内核之前调用：已标了取消的不让提交（`canceled`），同时执行的配额也在这里判（`busy`）；
   * 已经是 submitted 的原样给回（重启后再提交用同一个幂等键）；已是终态的给 `terminal`。
   */
  const markSubmitted = (caller, request) => update(caller, request, (entry, entries) => {
    if (entry.state === 'submitted') return entry;
    if (TERMINAL.includes(entry.state)) return { ok: false, code: 'terminal', entry };
    if (entry.canceled) return { ok: false, code: 'canceled', entry };
    return tallyVerdict('executing', counts(entries, caller).executing) ?? { ...entry, state: 'submitted' };
  });

  /**
   * 落终态：`outcome` 是 `{ state: 'completed'|'failed'|'canceled', finishedAt, result?, error? }`。终态先落盘，之后不得改回非终态、也不再改结局
   * （再落终态给 `terminal`，带原来那一项）。子调用的参数不再需要，一并去掉。
   */
  const finish = (caller, request, { state, ...rest }) => update(caller, request, entry => {
    if (!TERMINAL.includes(state)) throw invalid('终态须是 completed、failed 或 canceled');
    if (TERMINAL.includes(entry.state)) return { ok: false, code: 'terminal', entry };
    const { call, ...kept } = entry;
    return { ...kept, state, outcome: rest };
  });

  // 结局已签出：之后用不着结局的内容了，只留 `signed`，表不会越长越大。
  const markSigned = (caller, request) => update(caller, request, entry => {
    if (!TERMINAL.includes(entry.state)) return { ok: false, code: 'not_terminal', entry };
    if (entry.signed) return entry;
    const { outcome, ...kept } = entry;
    return { ...kept, signed: true };
  });

  const purge = () => serial(async () => {
    const entries = await load('inflight'), kept = purged(entries);
    if (Object.keys(kept).length !== Object.keys(entries).length) await save('inflight', kept);
    return Object.keys(entries).length - Object.keys(kept).length;
  });

  /** 这位作者此刻的在途、同时执行数（含全机），以及只读的配额判定：`{ ok: true }` 或 `busy`。 */
  const quota = caller => serial(async () => {
    const entries = await load('inflight'), tally = counts(entries, caller);
    return { ...tally, verdict: tallyVerdict('inflight', tally.inflight) ?? rateVerdict(entries, caller) ?? { ok: true } };
  });

  // ---- 发出表 ----

  const addOutgoing = ({ request, call, key, machine, parent = null, expiresAt }) => serial(async () => {
    const entry = { request, call, key, machine, parent, expiresAt, state: 'sent' };
    if (!outgoingOk(entry)) throw invalid('发出项的各项不合格');
    const entries = await load('outgoing');
    entries[request] = entry;
    await save('outgoing', entries);
    return entry;
  });
  const setOutgoingState = (request, state) => serial(async () => {
    if (!OUT_STATES.includes(state)) throw invalid('发出项的状态不认识');
    const entries = await load('outgoing');
    if (!entries[request]) return null;
    entries[request] = { ...entries[request], state };
    await save('outgoing', entries);
    return entries[request];
  });
  const removeOutgoing = request => serial(async () => {
    const entries = await load('outgoing');
    if (!entries[request]) return false;
    delete entries[request];
    await save('outgoing', entries);
    return true;
  });

  // ---- 操作记录 ----

  const ledgerName = at => `ledger-${monthOf(at)}.jsonl`;
  const ledgerPrepare = async () => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    const day = Math.floor(now() / DAY);
    if (prunedDay !== day) { prunedDay = day; await pruneNow(); }
  };

  // 一个月份文件的全部行：解析错误或形状不对就是损坏，不跳过、不当空。
  async function readMonth(name) {
    let text;
    try { text = await readFile(join(dir, name), 'utf8'); } catch (e) {
      if (e?.code === 'ENOENT') return [];
      throw e;
    }
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    return lines.map((line, i) => {
      let row;
      try { row = JSON.parse(line); } catch { throw corrupt(name, `第 ${i + 1} 行不是合法的 JSON`); }
      if (!ledgerRowOk(row)) throw corrupt(name, `第 ${i + 1} 行形状不对`);
      return row;
    });
  }
  // 追加与合并都是读出整个月份文件、改完整份再原子换上：写到一半失败，更新前那份仍然完整可读。
  const writeMonth = (name, rows) => writeAtomic(dir, name, rows.length ? `${rows.map(row => JSON.stringify(row)).join('\n')}\n` : '');

  // 保留 90 天：一个月的文件，整月都早于 90 天前才删（按 UTC 月）。
  async function pruneNow() {
    const cutoff = now() - LEDGER_KEEP_MS, removed = [];
    let names;
    try { names = await readdir(dir); } catch (e) { if (e?.code === 'ENOENT') return removed; throw e; }
    for (const name of names) {
      const match = LEDGER.exec(name);
      if (match && Date.UTC(Number(match[1]), Number(match[2]), 1) <= cutoff) { await unlink(join(dir, name)); removed.push(name); }
    }
    return removed;
  }

  /**
   * 记一个请求的结局。`command` 是命令全文，只存前 80 字与 sha256；`cwd`、`stdin` 不收。
   * 行：`{ v:1, at, request, friend, grant, target:{kind,id,name}, op, command:{summary,sha256}, outcome, code?, exitCode?, ms }`。
   */
  const appendLedger = ({ at = now(), request, friend, grant, target, op = 'exec', command, outcome, code, exitCode, ms }) => serial(async () => {
    if (typeof command !== 'string') throw invalid('command 须是命令全文，记录里只存摘要');
    const row = { v: 1, at, request, friend, grant, target: { kind: target?.kind, id: target?.id, name: target?.name }, op, command: commandInfo(command), outcome,
      ...(code === undefined ? {} : { code }), ...(exitCode === undefined ? {} : { exitCode }), ms };
    if (!ledgerRowOk(row) || outcome === 'rejected') throw invalid('操作记录的各项不合格');
    await ledgerPrepare();
    const name = ledgerName(at), rows = await readMonth(name);
    rows.push(row);
    await writeMonth(name, rows);
    return row;
  });

  /** 记一次拒绝：同一个 (作者、原因、分钟) 合并成当月文件里的一行，`count` 累加，不为每条非法输入各写一行。 */
  const recordRejection = ({ friend, code, at = now() }) => serial(async () => {
    const row = { v: 1, at: Math.floor(at / MINUTE) * MINUTE, friend, outcome: 'rejected', code, count: 1 };
    if (!ledgerRowOk(row)) throw invalid('拒绝记录的各项不合格');
    await ledgerPrepare();
    const name = ledgerName(at), rows = await readMonth(name);
    const found = rows.findIndex(old => old.outcome === 'rejected' && old.friend === friend && old.code === code && old.at === row.at);
    if (found < 0) rows.push(row); else rows[found] = { ...rows[found], count: rows[found].count + 1 };
    await writeMonth(name, rows);
    return found < 0 ? row : rows[found];
  });

  /**
   * 最近的 `limit` 行（按 `at` 新的在前，同 `at` 的后写的在前），可按 `friend`、`outcome`、`request`、`grant` 筛。
   * 月份文件按月新的先读；一个月内的行不一定按 `at` 排，所以整月筛完、排好，才截到条数。月份文件损坏就抛 `corrupt`。
   */
  const readLedger = ({ limit = 100, friend, outcome, request, grant } = {}) => serial(async () => {
    let names;
    try { names = (await readdir(dir)).filter(name => LEDGER.test(name)).sort().reverse(); } catch (e) { if (e?.code === 'ENOENT') return []; throw e; }
    const found = [];
    for (const name of names) {
      const rows = (await readMonth(name)).reverse().filter(row => (friend === undefined || row.friend === friend) && (outcome === undefined || row.outcome === outcome)
        && (request === undefined || row.request === request) && (grant === undefined || row.grant === grant));
      for (const one of rows.sort((a, b) => b.at - a.at)) found.push(one);
      if (found.length >= limit) break;
    }
    return found.slice(0, limit);
  });

  return {
    listGrants: () => serial(async () => Object.values(await load('grants'))),
    getGrant: id => serial(async () => (await load('grants'))[id] ?? null),
    addGrant, revokeGrant,
    admit, get, cancel, markSubmitted, finish, markSigned, purge, quota,
    listInflight: () => serial(async () => Object.values(await load('inflight'))),
    listOutgoing: () => serial(async () => Object.values(await load('outgoing'))),
    getOutgoing: request => serial(async () => (await load('outgoing'))[request] ?? null),
    addOutgoing, setOutgoingState, removeOutgoing,
    appendLedger, recordRejection, readLedger, pruneLedger: () => serial(pruneNow),
  };
}
