// 好友签名网关的持有方：把本机一条 remote-exec/machine@1 记录的 exec 授给一位好友，收好友签名的调用请求（friends/rpc-call），
// 验过、核对本机授权后调本机那条记录的 exec，再签回答（friends/rpc-answer）发回去。格式、窗口、配额、恢复以 coda#3011 为准。
//
// - 授权表（rpc-store 的 grants.json）是权威：撤权与失效先落盘、不可逆，之后尚未提交的不再启动；授权记录（friends/rpc-grant）的发与撤
//   按授权号排成一条队，发不出去等能发了再补，撤回要等原作者能签时补发。
// - 请求经网关已有的 Accord 变化通知与每 15 秒的兜底查询发现，翻页读全（一轮读不完下一轮从游标续）；每条过 verifyCall 与准入的各项，
//   先写在途项再签 running，最后提交。证书不可用、时钟回拨只暂停新请求的准入，已知请求的取消照常处理。
// - 在途表是唯一的工作队列：准入、提交、终态（连同要记的那一行操作记录）、记账、签出、撤回答都落在它上面，重启与证书恢复后照它接着做；
//   这几步都做完的才会被清掉。
// - 签名只经网关的内部入口（signRpc、retractRpc），证书不可用时什么也不发。
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import { certStateOf, statusOf } from './friends.mjs';
import { KIND_ANSWER, KIND_CALL, KIND_GRANT, PROTOCOL, answerId, answerRecord, clockWentBack, grantRecord, idempotencyKey, isAuthor, rebuildExecInput,
  replayWindow, requestDigest, verifyCall } from './rpc-format.mjs';
import { commandInfo, inflightKey, isCorrupt } from './rpc-store.mjs';

const ACCORD = { kind: 'coda/accord@1', id: 'local' };
const PROVIDER = 'remote-exec';
const HOUR = 3_600_000;
export const POLL_MS = 15_000, ANSWER_KEEP_MS = 24 * HOUR;
// exec 不给 timeout 时 remote-exec 的默认时限（秒）；remote-exec 的操作时限比命令时限多 30 秒（630 对 600），收尾用。
const DEFAULT_TIMEOUT_S = 120, EXEC_GRACE_MS = 30_000;
// 重启后再取一个已提交的调用：原来的期限已过，也至少等这么久，让内核按幂等键交回结局。
const RESUME_MS = 30_000;
// 见过的最大时刻至多每分钟落一次盘。
const CLOCK_STEP_MS = 60_000;
// 失效落盘失败后重试的退避：从 1 秒起翻倍，至多 1 分钟。
const END_RETRY_MS = 1_000, END_RETRY_MAX_MS = 60_000;
const TERMINAL = ['completed', 'failed', 'canceled'];
// 状态文件里这几个坏了就停止准入；操作记录坏了只是记不下。
const ADMISSION_FILES = ['grants.json', 'inflight.json', 'clock.json'];
// 一观察到就让授权失效（写进授权表、不可逆）的原因，及记在授权行上的失效原因。
const ENDING = { root_changed: 'root_changed', target_missing: 'target_missing', target_changed: 'target_missing' };

// 准入与提交前核对不过的原因；提交前不过的，作为失败回答的 code 与 message。
const REASONS = {
  no_grant: '没有这条授权，或授权不是给这位好友的',
  revoked: '授权已撤销',
  root_changed: '本机的根换了，旧根下的授权已停用',
  not_friend: '和这位好友的通道已不在',
  target_missing: '授权的目标记录已不在本机',
  target_changed: '授权的目标不再是本机 remote-exec 提供的那条记录',
  expired: '过了最晚启动时刻',
};

const message = e => String(e?.message ?? e);
const invalid = text => Object.assign(new Error(text), { code: 'invalid_input', effects: 'none' });
const EFFECTS = ['none', 'some', 'unknown'];

/**
 * `store`：rpc-store；`signRpc`、`retractRpc`、`onAccord`、`pages`：网关的内部签名、撤回入口、Accord 变化通知、翻页读取。
 * `now` 是墙钟（窗口、时刻），`monotonic` 是单调时钟（只用来算操作记录里的耗时）。
 */
export function createHolder(coda, { store, signRpc, retractRpc, onAccord, pages, now = Date.now, monotonic = () => performance.now(), timers = globalThis, pollMs = POLL_MS } = {}) {
  let stopped = false, corrupt = null, maxSeen = null, persistedClock = 0, timer = null, lastIdentity = null, lastRoot = null;
  let ticking = Promise.resolve(), queued = null, wantGrants = false;
  // 扫请求：一轮读不完时下一轮从 `scanCursor` 续；`passPresent` 是这一遍（可能跨几轮）见到的记录，整遍读完才拿它清 `seen`。
  let scanCursor = null, passPresent = new Set();
  const subscriptions = [];
  const seen = new Map(); // `${作者}/${请求号}` → 已经处理过的版本
  const drives = new Map(); // 在途键 → { again }：同一项同时只有一个在做
  const running = new Map(); // 在途键 → 已提交那次调用的 AbortController
  const since = new Map(); // 在途键 → 本进程开始经手它的单调时刻
  const availability = new Map(); // 目标记录 id → 上次看到的 available
  const dirtyGrants = new Set(); // 授权记录还没跟上（发或撤还没成）的授权号
  const grantQueues = new Map(); // 授权号 → 这条授权的发与撤排成的队
  // 待落盘的失效：`root:<旧根>`、`target:<目标 id>` → { match, endedBy, after }。落盘成功才去掉；在表里的授权一律当作已失效。
  // `after` 是事件之后才授出的授权号，不归这一笔失效管。重启后内存清空，由启动时的补查兜底。
  const pendingEnds = new Map();

  const fail = (code, text) => coda.error(code, text, { effects: 'none' });
  // 状态文件损坏：停止准入，授权列表与 coda self 能看出来。
  const note = e => { if (isCorrupt(e) && ADMISSION_FILES.includes(e.file)) corrupt ??= e.file; };

  async function identity() {
    let accord = null;
    try { accord = await coda.get(ACCORD); } catch { /* 没有 Accord：没有身份 */ }
    const friends = Array.isArray(accord?.status?.friends) ? accord.status.friends : [];
    return { root: accord?.spec?.author ?? null, certState: certStateOf(accord),
      bound: new Set(friends.filter(friend => statusOf(friend) === 'bound' && isAuthor(friend.author)).map(friend => friend.author)) };
  }
  const signing = me => me.certState === 'active' && isAuthor(me.root);

  async function targetOf({ kind, id }) {
    try { return await coda.get({ kind, id }); } catch (e) { if (e?.code === 'not_found') return null; throw e; }
  }
  const targetProblem = (grant, target) => {
    if (!target) return 'target_missing';
    if (target.local !== true || target.plugin !== grant.target.provider || target.owner !== grant.target.owner) return 'target_changed';
    return null;
  };
  // 授权此刻还能不能用来准入、提交：没撤（撤了的给失效原因）、根没换、好友绑定还在、目标仍是授权时那条本机 remote-exec 记录。
  // 读不出本机的根（没有身份）不算换根，给 `no_identity`。
  const grantProblem = (grant, me, target) => {
    if (!grant) return 'no_grant';
    if (grant.revokedAt !== undefined) return grant.endedBy ?? 'revoked';
    const pending = pendingEnd(grant);
    if (pending) return pending;
    if (!isAuthor(me.root)) return 'no_identity';
    if (me.root !== grant.holder.root) return 'root_changed';
    if (!me.bound.has(grant.grantee)) return 'not_friend';
    return targetProblem(grant, target);
  };
  // 这条授权在不在待落盘的失效里：在就给失效原因。
  function pendingEnd(grant) {
    for (const one of pendingEnds.values()) if (!one.after.has(grant.id) && one.match(grant)) return one.endedBy;
    return null;
  }
  // 事件里观察到的失效：先记进内存的表，再落盘；落盘失败不丢，按退避重试到成功为止。
  // 同一个键再来一次（同一目标又删一次、又从同一个根换走）：新条目替掉旧的。同键的 `match` 相同，旧条目管的授权（授出在旧事件之前）
  // 新条目都管，只是 `after` 从这次事件重新算；旧条目的重试不再做，免得按旧的 `after` 撤掉之后新授出的授权。
  function endGrants(key, match, endedBy) {
    const one = { match, endedBy, after: new Set() };
    pendingEnds.set(key, one);
    persistEnd(key, one, END_RETRY_MS);
  }
  function persistEnd(key, one, delay) {
    if (stopped || pendingEnds.get(key) !== one) return;
    store.endGrants(grant => !one.after.has(grant.id) && one.match(grant), one.endedBy).then(ended => {
      if (pendingEnds.get(key) === one) pendingEnds.delete(key);
      for (const grant of ended) dirtyGrants.add(grant.id);
      kick();
    }, e => {
      note(e);
      if (!stopped) timers.setTimeout(() => persistEnd(key, one, Math.min(delay * 2, END_RETRY_MAX_MS)), delay)?.unref?.();
    });
  }
  // 看到根换了、目标没了：授权就此失效，写进授权表（不等证书），授权记录的撤回留作待补。
  async function invalidate(grant, problem) {
    if (!grant || grant.revokedAt !== undefined || !ENDING[problem]) return;
    await store.revokeGrant(grant.id, now(), ENDING[problem]);
    dirtyGrants.add(grant.id);
  }

  // 本机时钟：比见过的最大时刻早 5 分钟以上就暂停准入；否则记下（至多每分钟落一次盘）。
  async function clockOk() {
    const at = now();
    if (clockWentBack(at, maxSeen)) return false;
    if (maxSeen === null || at > maxSeen) maxSeen = at;
    if (at - persistedClock >= CLOCK_STEP_MS) { persistedClock = at; await store.writeClock(at); }
    return true;
  }

  const reject = (friend, code) => isAuthor(friend) ? store.recordRejection({ friend, code }).catch(() => {}) : undefined;

  // ---- 授权记录 ----

  // 同一授权号的发与撤排成一条队，队里读最新的授权行再决定发还是撤。
  function syncGrant(id) {
    const run = (grantQueues.get(id) ?? Promise.resolve()).then(() => syncGrantNow(id));
    const tail = run.then(() => {}, () => {});
    grantQueues.set(id, tail);
    tail.then(() => { if (grantQueues.get(id) === tail) grantQueues.delete(id); });
    return run;
  }

  // 让一条授权在 Accord 里的样子跟上授权表，成了给 true，要等（没证书、原作者此刻签不了、中途撤了）给 false：
  // - 根换了、目标没了：先失效落盘；
  // - 撤了或失效的：用原作者签撤回，签过记下，已撤的绝不再发；
  // - 有效的：Accord 里的不一样就发（目标的 available 变了就是重发同号），签之前再读一次授权行，撤了就不发。
  async function syncGrantNow(id) {
    const me = await identity();
    let row = await store.getGrant(id), target = null;
    if (!row) return true;
    // 失效还没落盘：不发也不撤，等它落盘后再来。
    if (row.revokedAt === undefined && pendingEnd(row)) return false;
    if (row.revokedAt === undefined) {
      if (isAuthor(me.root) && me.root !== row.holder.root) row = await store.revokeGrant(id, now(), ENDING.root_changed);
      else {
        target = await targetOf(row.target);
        if (targetProblem(row, target)) row = await store.revokeGrant(id, now(), ENDING.target_missing);
      }
    }
    if (row.revokedAt !== undefined) {
      if (row.retractedAt !== undefined) return true;
      if (stopped || me.root !== row.holder.root || !signing(me)) return false;
      await retractRpc({ kind: KIND_GRANT, id, author: me.root });
      await store.markGrantRetracted(id);
      return true;
    }
    if (stopped || !signing(me)) return false;
    const record = grantRecord({ holder: row.holder.root, grantee: row.grantee, grant: row.id, spec: pickSpec(target.spec), available: target.status?.available === true, grantedAt: row.createdAt });
    const [mine] = (await coda.query(ACCORD, 'records', { kind: KIND_GRANT, author: me.root, id, limit: 1 }))?.records ?? [];
    // 签之前再读一次：撤了，或这时落进了待落盘的失效，都不发（失效落盘后再来撤）。
    const latest = await store.getGrant(id);
    if (stopped || latest?.revokedAt !== undefined || pendingEnd(latest)) return false;
    if (mine?.local !== true || !isDeepStrictEqual(mine.body, record.body)) await signRpc(record);
    return true;
  }
  const pickSpec = spec => ({ name: spec?.name, os: spec?.os, user: spec?.user, cwd: spec?.cwd });

  // 跟上一条授权：成了从待补里去掉，没成留着下次再补。
  async function settle(id) {
    let done = false;
    try { done = await syncGrant(id); } catch (e) { note(e); }
    if (done) dirtyGrants.delete(id); else dirtyGrants.add(id);
  }

  async function syncGrants(filter = () => true) {
    for (const grant of (await store.listGrants()).filter(filter)) {
      if (stopped) return;
      await settle(grant.id);
    }
  }

  // ---- 请求 ----

  // 一轮：从上一轮停下的游标续读（读不完照样记下游标）；准入暂停时只处理已知请求。整遍读完才按缺失清 `seen`。
  async function scan() {
    if (corrupt) return;
    const me = await identity();
    if (!isAuthor(me.root)) return;
    const grants = await store.listGrants();
    // 期望的发送方：本机此刻这个根授出过的被授权者（撤了的也算：他们还能取消已在跑的）。
    const grantees = new Set(grants.filter(grant => grant.holder.root === me.root).map(grant => grant.grantee));
    if (!grantees.size) return;
    const admitting = (await clockOk()) && signing(me);
    const read = await pages({ kind: KIND_CALL, includeAudience: true, ...(scanCursor ? { cursor: scanCursor } : {}) });
    for (const record of read.records) {
      if (stopped || corrupt) return;
      if (record?.local === true || record?.author === me.root) continue;
      const slot = `${record?.author}/${record?.id}`;
      passPresent.add(slot);
      if (seen.get(slot) === record?.version) continue;
      if (await consider(record, me, grantees, admitting)) seen.set(slot, record?.version);
    }
    if (read.nextCursor) { scanCursor = read.nextCursor; return; }
    // 这一遍读到了头才清；截断了又续不上（游标缺失或重复），下一轮从头再来一遍，不清。
    if (!read.truncated) for (const slot of seen.keys()) if (!passPresent.has(slot)) seen.delete(slot);
    scanCursor = null;
    passPresent = new Set();
  }

  // 一条请求：验签后的作者与受众、同号去重、取消，新的再走授权、窗口、配额、输入重建，准入后签 running 再交给 drive。
  // 处理完（含拒绝）给 true；准入暂停时的新请求给 false，留到恢复后再看。
  async function consider(record, me, grantees, admitting) {
    const author = record?.author;
    if (!grantees.has(author)) { await reject(author, 'bad_author'); return true; }
    const checked = verifyCall(record, { self: me.root, peer: author });
    if (!checked.ok) { await reject(author, checked.code); return true; }
    const { body } = checked, digest = requestDigest(body);
    const existing = await store.get(author, body.request);
    if (existing) {
      if (existing.digest !== digest) await reject(author, 'digest_conflict');
      // 取消：比准入时那条请求的版本新才算。
      else if (body.cancel === true) { if (existing.version === undefined || record.version > existing.version) await cancel(existing); }
      // 同号同摘要：不再准入，只补发已有的结局。
      else drive(author, body.request);
      return true;
    }
    if (!admitting) return false;
    const grant = await store.getGrant(body.grant);
    const problem = grant && grant.grantee !== author ? 'no_grant' : grantProblem(grant, me, grant ? await targetOf(grant.target) : null);
    if (problem) { await invalidate(grant, problem); await reject(author, problem); return true; }
    const window = replayWindow(body.createdAt, body.expiresAt, now());
    if (!window.ok) { await reject(author, window.code); return true; }
    const { verdict } = await store.quota(author);
    if (!verdict.ok) { await reject(author, verdict.code); return true; }
    const input = rebuildExecInput(body.input);
    if (!input.ok) { await reject(author, input.code); return true; }
    if (stopped) return false;
    const key = inflightKey(author, body.request);
    since.set(key, monotonic());
    const admitted = await store.admit({ caller: author, request: body.request, grant: grant.id, digest, key: idempotencyKey(author, body.request),
      notAfter: body.expiresAt, call: { target: grant.target, input: input.input }, canceled: body.cancel === true, version: record.version });
    if (!admitted.ok) { since.delete(key); await reject(author, admitted.code); return true; }
    // 取消先于请求到达：只留标记，直接答 canceled。
    if (body.cancel !== true) {
      try { await signRpc(answerRecord(answerBody(admitted.entry, grant, { state: 'running' }))); } catch { /* 没签出 running：照常往下，调用方收不到回执会自己取消 */ }
    }
    drive(author, body.request);
    return true;
  }

  const answerBody = (entry, grant, { state, finishedAt, result, error }) =>
    ({ holder: grant.holder.root, caller: entry.caller, grant: entry.grant, request: entry.request, digest: entry.digest, state, acceptedAt: entry.admittedAt, finishedAt, result, error });

  // 取消：没提交的标记后答 canceled；已提交的中止那次调用，结局照它实际的结束方式给。
  async function cancel(entry) {
    if (!TERMINAL.includes(entry.state)) {
      await store.cancel(entry.caller, entry.request);
      running.get(inflightKey(entry.caller, entry.request))?.abort();
    }
    drive(entry.caller, entry.request);
  }

  // ---- 在途项的推进 ----

  // 同一项同时只有一个在做；做的时候又被叫，做完再从头看一遍。
  function drive(caller, request) {
    const key = inflightKey(caller, request), current = drives.get(key);
    if (current) { current.again = true; return; }
    const job = { again: true };
    drives.set(key, job);
    (async () => {
      while (job.again && !stopped) {
        job.again = false;
        try { await step(caller, request); } catch (e) { note(e); }
      }
      drives.delete(key);
    })();
  }

  async function step(caller, request) {
    let entry = await store.get(caller, request);
    if (!entry) return;
    if (!since.has(inflightKey(caller, request))) since.set(inflightKey(caller, request), monotonic());
    if (entry.state === 'admitted') entry = await start(entry);
    if (entry?.state === 'submitted') entry = await execute(entry);
    if (!entry || !TERMINAL.includes(entry.state)) return;
    if (entry.ledger) entry = await log(entry);
    if (!entry.signed) await deliver(entry);
  }

  // 提交之前：标了取消的答 canceled；核对身份、好友绑定与目标，不过的答失败；然后在 store 的同一个串行操作里读最新的授权行、
  // 按此刻判最晚启动时刻，都过了才改成 submitted。同时执行的名额满了就留在 admitted，等有名额时再来；时钟回拨、读不出身份时也先等着。
  async function start(entry) {
    if (entry.canceled) return end(entry, canceledOutcome());
    if (clockWentBack(now(), maxSeen)) return null;
    const [me, grant] = await Promise.all([identity(), store.getGrant(entry.grant)]);
    const problem = grantProblem(grant, me, grant ? await targetOf(grant.target) : null);
    if (stopped || problem === 'no_identity') return null;
    if (problem) { await invalidate(grant, problem); return end(entry, refused(problem)); }
    // 待落盘的失效也在 store 的同一个串行操作里查：排队期间才观察到的失效同样挡住提交。
    const marked = await store.markSubmitted(entry.caller, entry.request, pendingEnd);
    if (marked.ok || marked.code === 'terminal') return marked.entry;
    if (marked.code === 'canceled') return end(marked.entry, canceledOutcome());
    if (marked.code === 'revoked' || marked.code === 'expired') return end(marked.entry, refused(marked.reason ?? marked.code));
    return null;
  }
  const refused = problem => ({ state: 'failed', error: { code: problem, message: `${REASONS[problem]}，命令没有启动`, effects: 'none' } });
  const canceledOutcome = () => ({ state: 'canceled', error: { code: 'canceled', message: '调用方取消了这次调用，命令没有启动', effects: 'none' } });

  // 调本机那条记录的 exec，带内核幂等键：重启后再调接上原来的调用、拿到它的结局，不会再执行一遍。已提交的撤权后照常跑完。
  async function execute(entry) {
    const key = inflightKey(entry.caller, entry.request), controller = new AbortController();
    running.set(key, controller);
    try {
      // 先登记中止的手柄、再读一次：取消落在这之前的，这里看得到；落在之后的，会经手柄中止。
      if ((await store.get(entry.caller, entry.request))?.canceled) controller.abort();
      const { target, input } = entry.call;
      const deadline = entry.notAfter + (input.timeout ?? DEFAULT_TIMEOUT_S) * 1000 + EXEC_GRACE_MS;
      let outcome;
      try {
        const result = await coda.call({ kind: target.kind, id: target.id }, 'exec', input, { id: entry.key, timeout: Math.max(deadline - now(), RESUME_MS), signal: controller.signal });
        outcome = { state: 'completed', result };
      } catch (e) {
        outcome = { state: 'failed', error: { code: String(e?.code ?? 'internal'), message: message(e), effects: EFFECTS.includes(e?.effects) ? e.effects : 'unknown' } };
      }
      // 停了就不再落盘、不签：下次启动用同一个幂等键取回结局。
      return stopped ? null : await end(entry, outcome);
    } finally {
      running.delete(key);
      kick();
    }
  }

  // 落终态（先落盘），连同要写进操作记录的那一行一起落：之后中途退出，重启照它补写。已有终态的不改。
  // 耗时用单调时钟，从本进程开始经手它算起（重启后接手的，从接手时算）。
  async function end(entry, { state, result, error }) {
    const finishedAt = now(), key = inflightKey(entry.caller, entry.request), { target, input } = entry.call;
    let name = target.id;
    try { name = (await targetOf(target))?.spec?.name || target.id; } catch { /* 名字只是展示 */ }
    const row = { v: 1, at: finishedAt, request: entry.request, friend: entry.caller, grant: entry.grant, target: { kind: target.kind, id: target.id, name }, op: 'exec',
      command: commandInfo(input.command), outcome: state, ...(error ? { code: error.code } : {}), ...(result && 'exitCode' in result ? { exitCode: result.exitCode } : {}),
      ms: Math.round(monotonic() - (since.get(key) ?? monotonic())) };
    const done = await store.finish(entry.caller, entry.request, { state, finishedAt, ...(result === undefined ? {} : { result }), ...(error === undefined ? {} : { error }) }, row);
    since.delete(key);
    return done.entry;
  }

  // 把随终态落盘的那一行写进操作记录（按调用方 + 请求号幂等），再去掉它。写不进去不吞掉：留在在途项上，下一次扫在途表时补写。
  async function log(entry) {
    try {
      await store.appendLedgerRow(entry.ledger);
      return (await store.markLogged(entry.caller, entry.request)).entry;
    } catch (e) { note(e); return entry; }
  }

  // 签结局（截到 60 KiB），然后标「已签出」。证书不可用、根换了，签不出去，留着等下次。
  async function deliver(entry) {
    const grant = await store.getGrant(entry.grant);
    if (!grant || stopped) return;
    await signRpc(answerRecord(answerBody(entry, grant, { state: entry.state, ...entry.outcome })));
    await store.markSigned(entry.caller, entry.request);
  }

  // 扫一遍在途表：没做完的接着做（恢复、记账、补签），签出 24 小时的撤回答（记账没成也照撤）；最后清掉这几步都做完、过期满 24 小时的。
  async function sweep() {
    const entries = await store.listInflight();
    let me = null;
    for (const entry of entries) {
      if (stopped) return;
      if (!entry.signed) { drive(entry.caller, entry.request); continue; }
      // 操作记录还没写成的另外接着补写，不挡着到期撤回答。
      if (entry.ledger) drive(entry.caller, entry.request);
      if (entry.retracted || now() < entry.finishedAt + ANSWER_KEEP_MS) continue;
      me ??= await identity();
      try { await retractAnswer(entry, me); } catch (e) { note(e); }
    }
    await store.purge();
  }
  async function retractAnswer(entry, me) {
    const grant = await store.getGrant(entry.grant);
    // 旧根署的回答本机不再能撤：不再惦记它。
    if (grant && grant.holder.root === me.root) {
      if (!signing(me)) return;
      await retractRpc({ kind: KIND_ANSWER, id: answerId(entry.caller, entry.request), author: me.root });
    }
    await store.markRetracted(entry.caller, entry.request);
  }

  // ---- 节拍 ----

  // 一次节拍：授权记录跟上（`grants` 时全部，否则只补待补的）、找请求、扫在途表。排成一条队，排着的只留一次。
  function tick({ grants = false } = {}) {
    wantGrants ||= grants;
    if (queued) return queued;
    const run = ticking.then(async () => {
      queued = null;
      if (stopped) return;
      const all = wantGrants;
      wantGrants = false;
      for (const work of [() => syncGrants(all ? undefined : grant => dirtyGrants.has(grant.id)), scan, sweep]) {
        if (stopped) return;
        try { await work(); } catch (e) { note(e); }
      }
    });
    queued = run;
    ticking = run.catch(() => {});
    return run;
  }
  const kick = () => { if (!stopped) tick().catch(() => {}); };
  const schedule = () => {
    if (stopped) return;
    timer = timers.setTimeout(() => { tick().finally(schedule); }, pollMs);
    // 兜底查询不该把进程拖住。
    timer?.unref?.();
  };

  // 本机 Accord 变了（网关已在 watch）：可能来了新请求；证书恢复或根换了，授权记录全部过一遍、结局补发。
  // 根从记下的根换成了别的：就地把旧根授出的授权一并失效落盘（撤回留给旧根能签时补发），不等后面再查。
  function onAccordChange({ type, entry } = {}) {
    const root = type === 'DELETED' ? null : entry?.spec?.author;
    if (isAuthor(root) && isAuthor(lastRoot) && root !== lastRoot) {
      const old = lastRoot;
      endGrants(`root:${old}`, grant => grant.holder.root === old, ENDING.root_changed);
    }
    if (isAuthor(root)) lastRoot = root;
    const current = type === 'DELETED' ? 'none' : `${certStateOf(entry)}/${entry?.spec?.author ?? ''}`;
    const changed = current !== lastIdentity;
    lastIdentity = current;
    tick({ grants: changed }).catch(() => {});
  }
  // 目标记录变了：没了就地把指向它的授权失效落盘（之后同 id 重建的也不再生效），再去补撤回；available 变了就重发它的授权记录。
  function onTarget({ type, id, entry } = {}) {
    if (type === 'DELETED') {
      availability.delete(id);
      endGrants(`target:${id}`, grant => grant.target.kind === PROTOCOL && grant.target.id === id, ENDING.target_missing);
      return;
    }
    const before = availability.get(id), after = entry?.status?.available === true;
    availability.set(id, after);
    if (before === undefined || before === after) return;
    store.listGrants().then(grants => { for (const grant of grants) if (grant.target.id === id) dirtyGrants.add(grant.id); kick(); }, note);
  }

  // ---- 授予、撤销与列出 ----

  async function grant({ friend, target } = {}) {
    if (stopped) throw fail('interrupted', '好友网关已停止');
    if (!isAuthor(friend)) throw invalid('friend 须是好友的公钥（ed25519:…）');
    if (!target || typeof target !== 'object' || target.kind !== PROTOCOL || typeof target.id !== 'string' || !target.id) throw invalid(`target 须是本机一条 ${PROTOCOL} 记录的 { kind, id }`);
    const entry = await targetOf(target);
    if (!entry) throw fail('not_found', `本机没有记录 ${target.kind}/${target.id}`);
    if (entry.local !== true) throw invalid('只能授出本机的记录');
    if (entry.plugin !== PROVIDER) throw invalid(`只能授出 ${PROVIDER} 提供的记录，这条是 ${entry.plugin ?? '未知插件'} 的`);
    const me = await identity();
    if (!me.bound.has(friend)) throw invalid('这位不是已绑定好友通道的好友');
    if (!signing(me)) throw fail('invalid_state', '本机没有可用的签名证书，不能授权');
    const row = await store.addGrant({ id: randomUUID(), holder: { root: me.root, machine: entry.owner }, grantee: friend,
      target: { owner: entry.owner, provider: entry.plugin, kind: target.kind, id: target.id }, createdAt: now() });
    for (const one of pendingEnds.values()) one.after.add(row.id);
    await settle(row.id);
    return describe(row, me, entry);
  }

  async function revoke({ grant: id } = {}) {
    if (typeof id !== 'string' || !id) throw invalid('grant 须是授权号');
    // 撤权先落盘：之后排队中、恢复中尚未提交的都不再启动（提交前在同一个串行操作里再读授权行）。
    const row = await store.revokeGrant(id);
    if (!row) throw fail('not_found', `没有授权 ${id}`);
    await settle(id);
    kick();
    return describe(row, await identity(), await targetOf(row.target).catch(() => null));
  }

  // 一条授权此刻的状态：available（可用）、target_off（目标已关）、target_missing（目标不在）、needs_cert（等证书）、
  // revoked（已撤）、root_changed（本机的根换了，旧根下的授权停用）。在待落盘的失效里的，与准入一样当作已失效。
  function describe(row, me, target) {
    const status = row.revokedAt !== undefined ? (row.endedBy ?? 'revoked') : pendingEnd(row)
      ?? (isAuthor(me.root) && row.holder.root !== me.root ? 'root_changed' : targetProblem(row, target) ? 'target_missing'
        : !signing(me) ? 'needs_cert' : target.status?.available === true ? 'available' : 'target_off');
    return { grant: row.id, friend: row.grantee, target: { kind: row.target.kind, id: row.target.id, name: target?.spec?.name ?? null },
      createdAt: row.createdAt, ...(row.revokedAt === undefined ? {} : { revokedAt: row.revokedAt }), status };
  }

  async function list() {
    const me = await identity();
    let grants = [];
    try { grants = await store.listGrants(); } catch (e) { note(e); if (!isCorrupt(e)) throw e; }
    const rows = [];
    for (const row of grants) rows.push(describe(row, me, await targetOf(row.target).catch(() => null)));
    return { certState: me.certState, admitting: !corrupt && !clockWentBack(now(), maxSeen), corrupt, grants: rows };
  }

  function ledger({ limit = 50, friend } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw invalid('limit 须是 1 到 1000 的整数');
    if (friend !== undefined && !isAuthor(friend)) throw invalid('friend 须是好友的公钥（ed25519:…）');
    return store.readLedger({ limit, ...(friend === undefined ? {} : { friend }) });
  }

  return {
    // `coda self` 的处理函数。
    self: { 'grants.list': list, 'grants.grant': grant, 'grants.revoke': revoke, 'ledger.list': ledger },
    tick: () => tick(),
    // 测试与诊断用：此刻还在推进的在途项数。
    busy: () => drives.size,
    // 测试与诊断用：此刻待落盘的失效有几笔。
    pendingEnds: () => pendingEnds.size,
    async start() {
      try { maxSeen = await store.readClock(); persistedClock = maxSeen ?? 0; } catch (e) { note(e); }
      if (stopped) return;
      lastRoot = (await identity()).root;
      if (onAccord) subscriptions.push(onAccord(onAccordChange));
      try { subscriptions.push(await coda.watch(PROTOCOL, onTarget)); } catch { /* 没有 remote-exec：授权照样能列 */ }
      if (stopped) { for (const one of subscriptions.splice(0)) one?.dispose?.(); return; }
      lastIdentity = null;
      schedule();
      await tick({ grants: true });
    },
    // 停了不再发起新的签名、落盘；已提交的调用不中止（内核按幂等键留着结局，下次启动取回）。
    stop() {
      stopped = true;
      if (timer) timers.clearTimeout(timer);
      timer = null;
      for (const one of subscriptions.splice(0)) one?.dispose?.();
    },
  };
}
