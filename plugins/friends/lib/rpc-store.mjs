// 好友签名网关的本机状态：插件状态目录下 `rpc/` 里的四样东西。
//   grants.json    授权表（持有方）：本机授权行是权威，撤权先落盘。授权行的 `restrict` 是授权的范围（仅限目录），没有就是整台机器。
//                  表里有任何一行带 `restrict` 时文件的 `v` 是 2，否则是 1：旧版读到 v2 的表按「损坏」停止准入，不会把仅限目录的授权当整台机器放行。
//   inflight.json  在途与去重表（持有方）：键是 (调用方作者, 请求号)，状态只进不退，终态先落盘。
//   outgoing.json  发出表（调用方）：本人查账用；也存着请求正文与核对回答要的各项（发出时的作者、持有方、授权号、摘要），重启后收尾、补发取消、撤回都照它。
//   ledger-YYYY-MM.jsonl  操作记录（持有方）：每个请求一行，拒绝按「作者、原因、分钟」合并成一行，留 90 天。
//   clock.json     持有方见过的最大时刻：本机时钟大幅回拨时据此暂停准入。
// 表文件与操作记录的月份文件都原子写入（临时文件 + rename，文件 0600、目录 0700）。读出来不是合法 JSON、或形状不对，就抛 `corrupt`，调用方据此停止准入，
// 绝不当成空表继续；文件不存在才是空表。同一个 store 里所有读改写排成一条队。
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, readdir, rename, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isAuthor, rebuildExecInput, requestDigest, restrictOk } from './rpc-format.mjs';

const MINUTE = 60_000, DAY = 24 * 60 * MINUTE;
export const LIMITS = Object.freeze({
  inflight: Object.freeze({ author: 8, total: 32 }),
  executing: Object.freeze({ author: 4, total: 8 }),
  perMinute: Object.freeze({ author: 30, total: 120 }),
  table: 4096,
});
// 在途与同时执行超限时给调用方的重试提示（每分钟新请求超限的，按最早一条滑出窗口的时刻算）。
export const BUSY_RETRY_MS = 5_000;
// 去重行过期后留多久，与回答签出后留多久（到期由持有方撤回）各算各的。
export const KEEP_AFTER_EXPIRY_MS = DAY, ANSWER_KEEP_MS = DAY, LEDGER_KEEP_MS = 90 * DAY;
/** 回答到期的时刻：签出（终态）时刻之后 24 小时；持有方到时撤回。 */
export const answerDueAt = finishedAt => finishedAt + ANSWER_KEEP_MS;
export const SUMMARY_CHARS = 80;
const TERMINAL = ['completed', 'failed', 'canceled'], STATES = ['admitted', 'submitted', ...TERMINAL];
// cancel_pending：取消没发出去，待发；canceled：取消已发出。
const OUT_STATES = ['sent', 'cancel_pending', 'canceled', 'finished'];

const isPlain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = value => typeof value === 'string' && value !== '';
const isTime = value => Number.isSafeInteger(value) && value >= 0;
const optional = (value, check) => value === undefined || check(value);
const isTarget = value => isPlain(value) && ['owner', 'provider', 'kind', 'id'].every(key => isText(value[key]));

const invalid = message => Object.assign(new Error(message), { code: 'invalid_input', effects: 'none' });
const corrupt = (name, why) => Object.assign(new Error(`好友调用的状态文件 ${name} 损坏（${why}），已停止使用，不会当成空表继续`), { code: 'corrupt', file: name, effects: 'none' });
export const isCorrupt = error => error?.code === 'corrupt';

// ---- 条目的形状 ----

// 授权行：`restrict`（可省）是授权的范围：`{ dirs }`，没有是整台机器，旧行就是这样；`holder.machine` 是授予时本机的机器钥匙（持有方始终以机器出现）；`target.owner` 是目标记录所在的后端：本机的，或同一空间里本机作网关授出的别的机器；`granteePerson` 是被授权的好友当时是不是个人作者
// （好友表的 `certified`，宿主还不写时是 null）。
const isFlag = value => typeof value === 'boolean';
// 授权号以外的各项：新授权在 store 里查重没命中才生成授权号，先按这些校验。
const grantFieldsOk = entry => isPlain(entry) && isPlain(entry.holder) && isAuthor(entry.holder.machine)
  && isAuthor(entry.grantee) && (entry.granteePerson === null || isFlag(entry.granteePerson)) && isTarget(entry.target) && Array.isArray(entry.ops) && entry.ops.length === 1 && entry.ops[0] === 'exec'
  && isTime(entry.createdAt) && optional(entry.restrict, restrictOk) && optional(entry.revokedAt, isTime) && optional(entry.endedBy, isText) && optional(entry.retractedAt, isTime);
const grantOk = entry => grantFieldsOk(entry) && isText(entry.id);

// 在途项按状态校验：非终态要有完整的子调用参数（固定目标、重建后的输入；幂等键与最晚启动时刻每项都有），且不带结局与「已签出」；
// 终态带结局或「已签出」之一（签出后结局释放，留下终态时刻；回答撤回后另记一笔）；取消标记与取消时刻成对出现。
// 终态还带着要写进操作记录的那一行（`ledger`），写进去以后去掉。`version` 是准入时那条请求的版本，取消须比它新。
const inflightOk = entry => {
  // 存的是重建后的 exec 输入：按 rpc-format 的重建规则能原样重建（结果与存的完全相同）才算。
  const inputOk = input => { const rebuilt = rebuildExecInput(input); return rebuilt.ok && isDeepStrictEqual(rebuilt.input, input); };
  // `restrict` 是提交那一刻读到的授权范围（null 是整台机器），执行时才带上；准入时没有它。
  const callOk = call => isPlain(call) && isTarget(call.target) && inputOk(call.input) && optional(call.restrict, value => value === null || restrictOk(value));
  if (!(isPlain(entry) && isAuthor(entry.caller) && isText(entry.request) && isText(entry.grant) && isText(entry.digest) && isText(entry.key)
    && isTime(entry.notAfter) && isTime(entry.admittedAt) && STATES.includes(entry.state)
    && optional(entry.call, callOk) && optional(entry.canceled, value => value === true) && optional(entry.canceledAt, isTime) && optional(entry.canceledBy, isText)
    && optional(entry.signed, value => value === true) && optional(entry.outcome, outcome => isPlain(outcome) && isTime(outcome.finishedAt))
    && optional(entry.finishedAt, isTime) && optional(entry.retracted, value => value === true) && optional(entry.version, Number.isSafeInteger)
    && optional(entry.ledger, row => row?.outcome !== 'rejected' && completedRowOk(row)))) return false;
  if (entry.ledger !== undefined && !TERMINAL.includes(entry.state)) return false;
  if ((entry.canceled === undefined) !== (entry.canceledAt === undefined) || (entry.canceledBy !== undefined && entry.canceled === undefined)) return false;
  if (!TERMINAL.includes(entry.state)) return callOk(entry.call) && entry.outcome === undefined && entry.signed === undefined;
  return entry.signed === true ? entry.outcome === undefined : entry.outcome !== undefined;
};

// 发出项：`body` 是签出的请求正文（补发取消要用原文），`author`（发出时的本机作者）、`holder`、`grant`、`digest` 取自它；
// `settled` 是处理函数已经了结这次调用（run 结束，或重启后 resume 收尾），之前清扫不动它。
const outgoingOk = entry => isPlain(entry) && isText(entry.request) && isText(entry.call) && isText(entry.key) && isText(entry.machine)
  && (entry.parent === null || isText(entry.parent)) && isTime(entry.expiresAt) && OUT_STATES.includes(entry.state)
  && isAuthor(entry.author) && isAuthor(entry.holder) && isText(entry.grant) && isText(entry.digest) && isPlain(entry.body) && optional(entry.settled, value => value === true);

const TABLES = {
  grants: { file: 'grants.json', field: 'grants', ok: grantOk, keyOf: entry => entry.id, version: entries => Object.values(entries).some(entry => entry?.restrict !== undefined) ? 2 : 1 },
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
function tableProblem({ field, ok, keyOf, version }, parsed) {
  if (!isPlain(parsed) || !isPlain(parsed[field]) || parsed.v !== (version?.(parsed[field]) ?? 1)) return '形状不对';
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
  const value = { v: table.version?.(entries) ?? 1, [table.field]: entries }, problem = tableProblem(table, value);
  if (problem) throw invalid(`${table.file} 要写的内容不合格：${problem}`);
  return writeAtomic(dir, table.file, `${JSON.stringify(value, null, 2)}\n`);
}

// ---- 操作记录 ----

const monthOf = at => new Date(at).toISOString().slice(0, 7);
const LEDGER = /^ledger-(\d{4})-(\d{2})\.jsonl$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** 命令的摘要：前 80 个字符与整条命令的 sha256；操作记录默认只存这个，不存命令全文。 */
export const commandInfo = text => ({ summary: [...text].slice(0, SUMMARY_CHARS).join(''), sha256: createHash('sha256').update(text).digest('hex') });

// 一行的形状：字段是固定的一组，多一项少一项都不行（命令全文、cwd、stdin 进不来）。`restrict` 是这次调用当时的授权范围，仅限目录的才有，没有是整台机器。写入前校验新行，读月份文件时校验每一行。
const hasKeys = (value, required, optionalKeys = []) => isPlain(value) && required.every(key => Object.hasOwn(value, key))
  && Object.keys(value).every(key => required.includes(key) || optionalKeys.includes(key));
const rejectionRowOk = row => hasKeys(row, ['v', 'at', 'friend', 'outcome', 'code', 'count']) && row.v === 1 && isTime(row.at) && isAuthor(row.friend)
  && isText(row.code) && Number.isSafeInteger(row.count) && row.count >= 1;
const completedRowOk = row => hasKeys(row, ['v', 'at', 'request', 'friend', 'grant', 'target', 'op', 'command', 'outcome', 'ms'], ['code', 'exitCode', 'restrict'])
  && row.v === 1 && isTime(row.at) && isText(row.request) && isAuthor(row.friend) && isText(row.grant)
  && hasKeys(row.target, ['kind', 'id', 'name']) && ['kind', 'id', 'name'].every(key => isText(row.target[key])) && row.op === 'exec'
  && hasKeys(row.command, ['summary', 'sha256']) && typeof row.command.summary === 'string' && [...row.command.summary].length <= SUMMARY_CHARS && typeof row.command.sha256 === 'string' && SHA256.test(row.command.sha256)
  && isText(row.outcome) && optional(row.code, isText) && optional(row.exitCode, value => value === null || Number.isSafeInteger(value)) && optional(row.restrict, restrictOk)
  && Number.isSafeInteger(row.ms) && row.ms >= 0;
// 合并后的拒绝行（outcome 是 rejected）与正常行各一套形状；两条写入路径与读取共用这一个判断。
const ledgerRowOk = row => isPlain(row) && (row.outcome === 'rejected' ? rejectionRowOk(row) : completedRowOk(row));

// ---- store ----

/**
 * `stateDir` 是插件状态目录，表与记录在它下面的 `rpc/`。`now` 与生成授权号的 `newId` 可换（测试用）。
 * 操作记录的顺手清扫失败（如跨截止日的月份文件损坏）不影响读写，用 `ledger_maintenance` 错误交给 `onMaintenanceError`（默认写到 stderr），下次再试。
 * 所有方法都是异步的、排成一条队；读到损坏的表就抛 `corrupt`（见 `isCorrupt`）。
 */
export function createRpcStore(stateDir, { now = Date.now, newId = randomUUID, onMaintenanceError = e => console.error(e.message) } = {}) {
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

  // 形状不对是调用方的错；`target` 是固定的 { owner, provider, kind, id }；`restrict` 是授权的范围，不给是整台机器。给 `{ created, entry }`。
  // 同一把机器钥匙、同一位好友、同一个目标已有没撤的授权：原样给回那一条（`created: false`），不生成授权号、不写盘（重试授予不会多出一条撤不干净的）。
  // 撤了的不算；`ended(grant)` 给原因的（调用方还没落盘的失效，同 markSubmitted）也不算。没命中才生成授权号、落盘（`created: true`）；生成的授权号已存在就拒绝，旧行不动。
  // 有效授权的匹配规则（一份）：同一把机器钥匙、同一位好友、同一个目标、没撤、也不在 `ended(grant)` 给了原因的失效里。addGrant 的去重与授予前的查询（findLiveGrant）共用它。
  const liveOf = (grants, { holder, grantee, target }, ended) => Object.values(grants).find(one => one.revokedAt === undefined && one.holder.machine === holder.machine
    && one.grantee === grantee && ['owner', 'provider', 'kind', 'id'].every(key => one.target[key] === target[key]) && !ended(one));
  const findLiveGrant = (match, ended = () => null) => serial(async () => liveOf(await load('grants'), match, ended) ?? null);

  const addGrant = ({ holder, grantee, granteePerson, target, createdAt, restrict }, ended = () => null) => serial(async () => {
    const fields = { holder, grantee, granteePerson, target, ops: ['exec'], createdAt, ...(restrict ? { restrict } : {}) };
    if (!grantFieldsOk(fields)) throw invalid('授权的各项不合格');
    const grants = await load('grants');
    const live = liveOf(grants, { holder, grantee, target }, ended);
    if (live) return { created: false, entry: live };
    const entry = { id: newId(), ...fields };
    if (grants[entry.id]) throw invalid(`授权号 ${entry.id} 已存在`);
    grants[entry.id] = entry;
    await save('grants', grants);
    return { created: true, entry };
  });

  // 撤权：先落盘再返回；已撤的不改撤回时刻。没有这条授权给 null。`endedBy` 写明不是本人撤的（目标不在了、本机的机器钥匙变了、被授权的好友换了作者而失效）。
  // 撤权与失效不可逆；授权记录的撤回另记（markGrantRetracted），要等原来那把机器钥匙能签时才补发。
  const revokeGrant = (id, at = now(), endedBy) => serial(async () => {
    const grants = await load('grants'), entry = grants[id];
    if (!entry) return null;
    if (entry.revokedAt === undefined) {
      grants[id] = { ...entry, revokedAt: at, ...(endedBy === undefined ? {} : { endedBy }) };
      await save('grants', grants);
    }
    return grants[id];
  });

  // 改一条有效授权的范围（`restrict` 不给是整台机器），先落盘再返回；之后的准入与提交（markSubmitted）读到的都是新范围，已经提交的调用不动。
  // 给 `{ ok: true, entry }`；没有这条授权是 `not_found`，已撤、已失效或 `ended(grant)` 给了原因（调用方还没落盘的失效）是 `revoked`。范围没变不写盘。
  const setRestrict = (id, restrict, ended = () => null) => serial(async () => {
    const grants = await load('grants'), entry = grants[id];
    if (!entry) return { ok: false, code: 'not_found' };
    if (entry.revokedAt !== undefined || ended(entry)) return { ok: false, code: 'revoked', entry };
    if (isDeepStrictEqual(entry.restrict, restrict ?? undefined)) return { ok: true, entry };
    const { restrict: old, ...rest } = entry;
    grants[id] = { ...rest, ...(restrict ? { restrict } : {}) };
    await save('grants', grants);
    return { ok: true, entry: grants[id] };
  });

  // 让 `match` 选中的、还有效的授权一并失效（同一个串行操作里落盘），`endedBy` 是原因；给回这次失效的那些。
  const endGrants = (match, endedBy, at = now()) => serial(async () => {
    const grants = await load('grants'), ended = Object.values(grants).filter(entry => entry.revokedAt === undefined && match(entry));
    if (!ended.length) return [];
    for (const entry of ended) grants[entry.id] = { ...entry, revokedAt: at, endedBy };
    await save('grants', grants);
    return ended.map(entry => grants[entry.id]);
  });

  // 授权记录已撤回（或本来就没发出去）：只对撤了的授权。
  const markGrantRetracted = (id, at = now()) => serial(async () => {
    const grants = await load('grants'), entry = grants[id];
    if (!entry || entry.revokedAt === undefined) return null;
    if (entry.retractedAt === undefined) {
      grants[id] = { ...entry, retractedAt: at };
      await save('grants', grants);
    }
    return grants[id];
  });

  // ---- 在途与去重 ----

  // 只清做完了的：结局签出、回答撤回、操作记录写进去了，且过期满 24 小时。没恢复的、没签出的、没撤回答的、没记账的一律留着。
  const purged = entries => Object.fromEntries(Object.entries(entries).filter(([, entry]) =>
    !(entry.retracted === true && entry.ledger === undefined && now() >= entry.notAfter + KEEP_AFTER_EXPIRY_MS)));

  // 表满时还能清的：结局已签出、回答已撤回、操作记录已写进去、已过期（不再承担去重）。回答到了撤回时刻还没撤成的也留着，等 sweep 撤完再腾位置。
  const reclaimable = entry => entry.signed === true && entry.retracted === true && entry.ledger === undefined && now() >= entry.notAfter;

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
   * `table_full`（实际保存的项已达 4096，清掉可清的之后仍满；不挤掉承担去重或交付的项）、`busy`（带 `limit`、`scope`、`retryAfterMs`）。
   * `canceled: true` 是取消先于请求到达：先留下标记，之后不会再启动。过期 24 小时的旧项顺手清掉；表按行数满了，再清已过期的可清项。
   * `refusal`（`{ state, ending, row }`，同 finish 的终态与那一行操作记录）是准入前就拒绝、要签回终态的：同样去重、算配额，但写进去的就是终态，
   * 不带子调用参数，盘上没有可执行的一刻。
   */
  const admit = ({ caller, request, grant, digest, key, notAfter, call, canceled, version, refusal }) => serial(async () => {
    const at = now(), base = { caller, request, grant, digest, key, notAfter, admittedAt: at, ...(version === undefined ? {} : { version }) };
    const entry = refusal ? { ...base, state: refusal.state, outcome: refusal.ending, ledger: refusal.row }
      : { ...base, state: 'admitted', call, ...(canceled ? { canceled: true, canceledAt: at } : {}) };
    if (!inflightOk(entry) || !call) throw invalid('在途项的各项不合格');
    const entries = purged(await load('inflight')), slot = inflightKey(caller, request), old = entries[slot];
    if (old) return old.digest === digest ? { ok: false, code: 'duplicate', entry: old } : { ok: false, code: 'digest_conflict', entry: old };
    if (Object.keys(entries).length >= LIMITS.table) {
      for (const [key, one] of Object.entries(entries)) if (reclaimable(one)) delete entries[key];
      if (Object.keys(entries).length >= LIMITS.table) return { ok: false, code: 'table_full' };
    }
    const verdict = tallyVerdict('inflight', counts(entries, caller).inflight) ?? rateVerdict(entries, caller);
    if (verdict) return verdict;
    entries[slot] = entry;
    await save('inflight', entries);
    return { ok: true, entry };
  });

  // 改一项：`change(entry, entries)` 给新的一项，或给 `{ ok: false, ... }` 拒绝；落盘后才返回。`updateNow` 须已在队里。
  const update = (caller, request, change) => serial(() => updateNow(caller, request, change));
  const updateNow = async (caller, request, change) => {
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
  };

  const get = (caller, request) => serial(async () => (await load('inflight'))[inflightKey(caller, request)] ?? null);

  // 标记已取消：已有终态的不改（`terminal`），已标记的不重复写。没有这一项给 `unknown`，调用方再用 `admit({ canceled: true })` 留标记。
  // `by` 是授权撤销或失效的原因（对方发来的取消不给）：记下它，结局里写明。
  const cancel = (caller, request, by) => update(caller, request, entry => {
    if (TERMINAL.includes(entry.state)) return { ok: false, code: 'terminal', entry };
    return entry.canceled ? entry : { ...entry, canceled: true, canceledAt: now(), ...(by === undefined ? {} : { canceledBy: by }) };
  });

  /**
   * admitted → submitted，提交给内核之前调用：已标了取消的不让提交（`canceled`）；同一个串行操作里读最新的授权行、按此刻判最晚启动时刻，
   * 授权没了、撤了或失效了给 `revoked`（`reason` 是失效的原因），过了最晚启动时刻给 `expired`；同时执行的配额也在这里判（`busy`）。
   * 提交的同一个串行操作里把授权此刻的范围记进 `call.restrict`（整台机器是 null），执行带的就是它：改范围与提交排在一条队里，
   * 要么提交读到新范围，要么这次调用就是在旧范围下提交的（已提交的不动），不会按旧范围准入、却不带限制地执行。
   * 已经是 submitted 的原样给回（重启后再提交用同一个幂等键，范围也还是提交时那份）；已是终态的给 `terminal`。
   * `ended(grant)` 是调用方另外的失效判定（还没落盘的失效），也在同一个串行操作里、决定提交的那一刻调用，给原因就当失效（`revoked`）。
   */
  const markSubmitted = (caller, request, ended = () => null) => serial(async () => {
    const grants = await load('grants');
    return updateNow(caller, request, (entry, entries) => {
      if (entry.state === 'submitted') return entry;
      if (TERMINAL.includes(entry.state)) return { ok: false, code: 'terminal', entry };
      if (entry.canceled) return { ok: false, code: 'canceled', entry };
      const grant = grants[entry.grant];
      if (!grant || grant.revokedAt !== undefined) return { ok: false, code: 'revoked', ...(grant?.endedBy ? { reason: grant.endedBy } : {}), entry };
      const reason = ended(grant);
      if (reason) return { ok: false, code: 'revoked', reason, entry };
      if (now() >= entry.notAfter) return { ok: false, code: 'expired', entry };
      return tallyVerdict('executing', counts(entries, caller).executing) ?? { ...entry, state: 'submitted', call: { ...entry.call, restrict: grant.restrict ?? null } };
    });
  });

  /**
   * 落终态：`outcome` 是 `{ state: 'completed'|'failed'|'canceled', finishedAt, result?, error? }`。终态先落盘，之后不得改回非终态、也不再改结局
   * （再落终态给 `terminal`，带原来那一项）。子调用的参数不再需要，一并去掉。`ledger` 是要写进操作记录的那一行，与终态一起落盘，
   * 写进操作记录后用 markLogged 去掉；中途退出了，重启后照它补写。
   */
  const finish = (caller, request, { state, ...rest }, ledger) => update(caller, request, entry => {
    if (!TERMINAL.includes(state)) throw invalid('终态须是 completed、failed 或 canceled');
    if (TERMINAL.includes(entry.state)) return { ok: false, code: 'terminal', entry };
    const { call, ...kept } = entry;
    return { ...kept, state, outcome: rest, ...(ledger === undefined ? {} : { ledger }) };
  });

  // 操作记录已写进去：去掉随终态落盘的那一行。
  const markLogged = (caller, request) => update(caller, request, entry => {
    if (entry.ledger === undefined) return entry;
    const { ledger, ...kept } = entry;
    return kept;
  });

  // 结局已签出：之后用不着结局的内容了，只留 `signed` 与终态时刻（到时撤回答用），表不会越长越大。
  const markSigned = (caller, request) => update(caller, request, entry => {
    if (!TERMINAL.includes(entry.state)) return { ok: false, code: 'not_terminal', entry };
    if (entry.signed) return entry;
    const { outcome, ...kept } = entry;
    return { ...kept, signed: true, finishedAt: outcome.finishedAt };
  });

  // 回答已撤回：只对签出过的项。
  const markRetracted = (caller, request) => update(caller, request, entry => {
    if (entry.signed !== true) return { ok: false, code: 'not_signed', entry };
    return entry.retracted ? entry : { ...entry, retracted: true };
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

  // ---- 见过的最大时刻 ----

  // 读出见过的最大时刻（没有给 null）；文件不对就是损坏。
  const readClock = () => serial(async () => {
    let text;
    try { text = await readFile(join(dir, 'clock.json'), 'utf8'); } catch (e) { if (e?.code === 'ENOENT') return null; throw e; }
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw corrupt('clock.json', '不是合法的 JSON'); }
    if (!isPlain(parsed) || parsed.v !== 1 || !isTime(parsed.maxSeen)) throw corrupt('clock.json', '形状不对');
    return parsed.maxSeen;
  });
  const writeClock = at => serial(() => {
    if (!isTime(at)) throw invalid('时刻不合格');
    return writeAtomic(dir, 'clock.json', `${JSON.stringify({ v: 1, maxSeen: at })}\n`);
  });

  // ---- 发出表 ----

  // `body` 是要签出的请求正文：请求号、期限、作者、持有方、授权号、摘要都取自它。
  const addOutgoing = ({ call, key, machine, parent = null, body }) => serial(async () => {
    const entry = { request: body?.request, call, key, machine, parent, expiresAt: body?.expiresAt, author: body?.caller, holder: body?.holder, grant: body?.grant,
      digest: isPlain(body) ? requestDigest(body) : undefined, body, state: 'sent' };
    const { request } = entry;
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
  const settleOutgoing = request => serial(async () => {
    const entries = await load('outgoing');
    if (!entries[request]) return null;
    entries[request] = { ...entries[request], settled: true };
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
  // 带显式 `at` 的写入共用的截止规则：已经超过 90 天的不落盘（落了也会马上被清掉），当作已处理。
  // 开头查一次，免得为旧行去清扫、读文件；清扫和读月份文件期间时钟可能走过截止线，写盘前再查一次。
  const pastKeep = at => at < now() - LEDGER_KEEP_MS;
  // 每天最多清一次：写账时清，没有新操作时靠 ledger.list 读出时顺手清。
  const sweepLedger = async () => {
    const day = Math.floor(now() / DAY);
    if (prunedDay === day) return;
    try { await pruneNow(); prunedDay = day; } catch (cause) {
      onMaintenanceError(Object.assign(new Error(`好友调用的操作记录清扫失败（${cause?.message ?? cause}），之后再试`), { code: 'ledger_maintenance', cause }));
    }
  };
  const ledgerPrepare = async () => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    await sweepLedger();
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

  // 保留 90 天：一个月的文件，整月都早于 90 天前才删（按 UTC 月）；跨截止日的那个月，重写时丢掉过期的行。
  async function pruneNow() {
    const cutoff = now() - LEDGER_KEEP_MS, removed = [];
    let names;
    try { names = await readdir(dir); } catch (e) { if (e?.code === 'ENOENT') return removed; throw e; }
    let failure;
    for (const name of names) {
      const match = LEDGER.exec(name);
      if (!match) continue;
      if (Date.UTC(Number(match[1]), Number(match[2]), 1) <= cutoff) { await unlink(join(dir, name)); removed.push(name); continue; }
      if (Date.UTC(Number(match[1]), Number(match[2]) - 1, 1) >= cutoff) continue;
      // 这个月清不了（文件损坏、写不进去）不拦着别的月份照常清；清完再抛。
      try {
        const rows = await readMonth(name), kept = rows.filter(row => row.at >= cutoff);
        if (kept.length < rows.length) await writeMonth(name, kept);
      } catch (e) { failure ??= e; }
    }
    if (failure) throw failure;
    return removed;
  }

  /**
   * 记一个请求的结局。`command` 是命令全文，只存前 80 字与 sha256；`cwd`、`stdin` 不收。
   * 行：`{ v:1, at, request, friend, grant, target:{kind,id,name}, op, command:{summary,sha256}, outcome, code?, exitCode?, restrict?, ms }`（`restrict` 是当时的授权范围，仅限目录的才有）。`at` 已超过 90 天的不落盘。
   */
  const appendLedger = ({ at = now(), request, friend, grant, target, op = 'exec', command, outcome, code, exitCode, restrict, ms }) => serial(async () => {
    if (typeof command !== 'string') throw invalid('command 须是命令全文，记录里只存摘要');
    const row = { v: 1, at, request, friend, grant, target: { kind: target?.kind, id: target?.id, name: target?.name }, op, command: commandInfo(command), outcome,
      ...(code === undefined ? {} : { code }), ...(exitCode === undefined ? {} : { exitCode }), ...(restrict ? { restrict } : {}), ms };
    if (!ledgerRowOk(row) || outcome === 'rejected') throw invalid('操作记录的各项不合格');
    if (pastKeep(at)) return row;
    await ledgerPrepare();
    const name = ledgerName(at), rows = await readMonth(name);
    if (pastKeep(at)) return row;
    rows.push(row);
    await writeMonth(name, rows);
    return row;
  });

  /**
   * 补写一个请求的那一行（`row` 是 appendLedger 那样的整行，命令已是摘要）：按「调用方 + 请求号」幂等，当月已有这一行就不再写。
   * 给 `{ written }`；`at` 已超过 90 天的不落盘，也给 `{ written: false }`（已处理，调用方可以去掉待补写的标记）。
   */
  const appendLedgerRow = row => serial(async () => {
    if (!completedRowOk(row)) throw invalid('操作记录的各项不合格');
    if (pastKeep(row.at)) return { written: false };
    await ledgerPrepare();
    const name = ledgerName(row.at), rows = await readMonth(name);
    if (rows.some(old => old.outcome !== 'rejected' && old.friend === row.friend && old.request === row.request) || pastKeep(row.at)) return { written: false };
    rows.push(row);
    await writeMonth(name, rows);
    return { written: true };
  });

  /** 记一次拒绝：同一个 (作者、原因、分钟) 合并成当月文件里的一行，`count` 累加，不为每条非法输入各写一行。 */
  const recordRejection = ({ friend, code, at = now() }) => serial(async () => {
    const row = { v: 1, at: Math.floor(at / MINUTE) * MINUTE, friend, outcome: 'rejected', code, count: 1 };
    if (!ledgerRowOk(row)) throw invalid('拒绝记录的各项不合格');
    if (pastKeep(row.at)) return row;
    await ledgerPrepare();
    const name = ledgerName(at), rows = await readMonth(name);
    if (pastKeep(row.at)) return row;
    const found = rows.findIndex(old => old.outcome === 'rejected' && old.friend === friend && old.code === code && old.at === row.at);
    if (found < 0) rows.push(row); else rows[found] = { ...rows[found], count: rows[found].count + 1 };
    await writeMonth(name, rows);
    return found < 0 ? row : rows[found];
  });

  /**
   * 最近的 `limit` 行（按 `at` 新的在前，同 `at` 的后写的在前），可按 `friend`、`outcome`、`request`、`grant` 筛。
   * 月份文件按月新的先读；一个月内的行不一定按 `at` 排，所以整月筛完、排好，才截到条数。月份文件损坏就抛 `corrupt`。
   * 超过 90 天的行不返回；读出时顺手清扫。
   */
  const readLedger = ({ limit = 100, friend, outcome, request, grant } = {}) => serial(async () => {
    await sweepLedger();
    const cutoff = now() - LEDGER_KEEP_MS;
    let names;
    try { names = (await readdir(dir)).filter(name => LEDGER.test(name)).sort().reverse(); } catch (e) { if (e?.code === 'ENOENT') return []; throw e; }
    const found = [];
    for (const name of names) {
      const rows = (await readMonth(name)).reverse().filter(row => row.at >= cutoff && (friend === undefined || row.friend === friend) && (outcome === undefined || row.outcome === outcome)
        && (request === undefined || row.request === request) && (grant === undefined || row.grant === grant));
      for (const one of rows.sort((a, b) => b.at - a.at)) found.push(one);
      if (found.length >= limit) break;
    }
    return found.slice(0, limit);
  });

  return {
    listGrants: () => serial(async () => Object.values(await load('grants'))),
    getGrant: id => serial(async () => (await load('grants'))[id] ?? null),
    addGrant, findLiveGrant, revokeGrant, setRestrict, endGrants, markGrantRetracted,
    admit, get, cancel, markSubmitted, finish, markLogged, markSigned, markRetracted, purge, quota, readClock, writeClock,
    listInflight: () => serial(async () => Object.values(await load('inflight'))),
    listOutgoing: () => serial(async () => Object.values(await load('outgoing'))),
    getOutgoing: request => serial(async () => (await load('outgoing'))[request] ?? null),
    addOutgoing, setOutgoingState, settleOutgoing, removeOutgoing,
    appendLedger, appendLedgerRow, recordRejection, readLedger, pruneLedger: () => serial(pruneNow),
  };
}
