// 好友签名网关的调用方：好友（持有方）把他机器上一条 remote-exec/machine@1 记录的 exec 授给本机此刻的作者，这里把那条授权登记成本机的
// 一条代理记录（种类同样是 remote-exec/machine@1，provider 是 friends），接住对它的 exec：签调用请求（friends/rpc-call）发给持有方的机器钥匙，
// 等它签的回答（friends/rpc-answer），把结局交回去。格式、窗口与规则以 coda#3011 为准。
//
// - 发现：网关已有的 Accord 变化通知与每 15 秒的兜底，翻页读全 friends/rpc-grant。合格的授权：作者是好友表里某条无冲突通道背后的机器钥匙
//   （`machine`；不看是否已绑定：持有方个人证书过期时这一行是未绑定、机器钥匙仍在，授出的照常可用），受众与正文的 grantee 恰好是本机此刻的作者，正文的 holder 就是作者（verifyGrant）。
// - 代理记录：`friend:<持有方机器钥匙前 16 位>:<授权号>`，spec 取授权记录的、名字改成 `<机器名>@<好友称呼>`，labels 记持有方机器钥匙与授权号。
//   同一授权在空间里只留一条：候选是与持有方有这样一条通道的机器，机器 ID 最小的那台留下，其余删掉自己这条（没有通道的不留）；
//   可用性在留下的那台上单独算，不参与选主。授权撤回（目录里这一号已不在，或只剩撤回后的空正文）就删掉；
//   对端换了机器钥匙、本机作者变了、签不了、授权记录说不可用，只标为不可用。
// - exec：请求按序列化字节量，先写发出表（连同请求正文与核对回答要的各项）再签；回答按「持有方机器钥匙、种类、派生的回答 id」精确读，
//   逐项核对授权号、请求号、摘要。等待与查询都挂在调用的 signal 上；交出终态之前再看一次是否已取消、已到期、本机作者变了、
//   好友表里是否仍有这把持有方机器钥匙（好友被移除或换了钥匙，旧机器的回答不交）。请求签出之后读回答失败只当这一回没读到，接着等；
//   拿不到受信终态的都是效果未知。75 秒没有回执（在途查询挂着也算）、调用被取消、调用到期，都先发取消（同号更高版本），
//   发不出去的记为待发，有效期内补发。
// - 请求拿到结局就撤回，拿不到的过期后撤回，都按发出时的作者署名：签不了或本机作者不是它，就推迟到能签、作者切回来，或过了保留期。
//   处理函数还没了结（重启后等 resume 收尾）的发出项不动。
// - 本机作者变了：旧作者下的代理记录停用，正在等的请求不再处理，要等重新授予。
// - 签名只经网关的内部入口（signRpc、retractRpc）。
import { isDeepStrictEqual } from 'node:util';
import { CARD_KIND, PROFILE_KIND, mergeFriendRows } from './friends.mjs';
import { readNotes } from './notes.mjs';
import { KIND_ANSWER, KIND_CALL, KIND_GRANT, MAX_WINDOW_MS, PROTOCOL, answerId, callRecord, cancelRecord, isAuthor, rebuildExecInput, requestId,
  signerOf, verifyAnswer, verifyGrant } from './rpc-format.mjs';
import { KEEP_AFTER_EXPIRY_MS } from './rpc-store.mjs';

const ACCORD = { kind: 'coda/accord@1', id: 'local' };
export const POLL_MS = 15_000, ACK_MS = 75_000, RESUME_MS = 30_000;
const TERMINAL = ['completed', 'failed', 'canceled'];
const LABEL_HOLDER = 'friends-holder', LABEL_GRANT = 'friends-grant';
export const LOST = '命令可能仍在好友的机器上执行，结果不会再送达；重跑之前先检查';
export const UNSUPPORTED = '经好友的机器暂不支持拉取与推送；用 exec 分段读写（如 `sed -n`、`base64`），截短时完整输出在 outputDir 里';

/** 代理记录的 key：`friend:` + 持有方机器钥匙（`ed25519:` 之后）的前 16 位 + `:` + 授权号。 */
export const proxyKey = (holder, grant) => `friend:${holder.slice('ed25519:'.length, 'ed25519:'.length + 16)}:${grant}`;

// 代理记录此刻不能用的原因 → 当场失败的码与说明（都没发出请求，effects 是 none）。
const PROBLEMS = {
  missing: ['not_found', '本机没有这条好友授权的代理记录'],
  channel: ['unavailable', '好友的授权记录不在了，或和这位好友的通道已断开、对端的机器钥匙已不是授权记录的作者'],
  author: ['invalid_state', '本机的签名身份变了，授给旧身份的授权已停用，要请好友重新授予'],
  sign: ['invalid_state', '本机没有可用的签名证书，好友调用的请求发不出去'],
  off: ['unavailable', '好友那台机器的远程执行此刻不可用'],
};

/**
 * `store`：rpc-store（用其中的发出表）；`signRpc`、`retractRpc`、`onAccord`、`pages`：网关的内部签名、撤回入口、Accord 变化通知、翻页读取；
 * `dir`：插件状态目录（读本机备注，给代理记录起名）。`now`、`timers` 可换（测试用）。
 */
export function createCaller(coda, { store, signRpc, retractRpc, onAccord, pages, dir, now = Date.now, timers = globalThis, pollMs = POLL_MS, ackMs = ACK_MS } = {}) {
  let stopped = false, timer = null, ticking = Promise.resolve(), queued = null, self = null, markReady;
  const ready = new Promise(resolve => { markReady = resolve; });
  // 代理记录 key → { holder, grant, grantee, spec, offered（授权记录说可用）, present（上一遍按此刻的作者与通道核对合格）}。
  const known = new Map();
  const waiters = new Set(); // 正在等回答的调用
  // 本机作者的代次：Accord 变化通知里的作者与上一次看到的不同就加一（第一次看到不算），换走再换回也算两次。
  let generation = 0, lastAuthor = null;
  const handles = [], subscriptions = [];
  const fail = (code, text, effects = 'none') => coda.error(code, text, { effects });

  async function identity() {
    let accord = null;
    try { accord = await coda.get(ACCORD); } catch { /* 没有 Accord：没有身份 */ }
    const friends = Array.isArray(accord?.status?.friends) ? accord.status.friends : [];
    // 认持有方只看机器钥匙与冲突，不看是否已绑定（见文件头）。
    return { ...signerOf(accord), friends: friends.filter(friend => !friend.conflict && isAuthor(friend.machine)) };
  }
  // 本机与持有方这把机器钥匙之间的通道。
  const channelOf = (me, holder) => me.friends.find(friend => friend.machine === holder);

  function problemOf(grant, me) {
    if (!grant) return 'missing';
    // 授给的作者已不是本机此刻的作者：先报这个，它的授权记录这时也核对不过。重启后还没重新发现的（grantee 未知）按通道报。
    if (grant.grantee && grant.grantee !== me.author) return 'author';
    if (!grant.present || !channelOf(me, grant.holder)) return 'channel';
    if (!me.canSign) return 'sign';
    return grant.offered ? null : 'off';
  }

  // ---- 发现与代理记录 ----

  async function sync() {
    const me = await identity();
    if (!isAuthor(me.author)) return;
    // 没有带机器钥匙的通道，就不会有合格的授权：不读目录。
    const read = me.friends.length ? await pages({ kind: KIND_GRANT, includeAudience: true }, Infinity) : { records: [], truncated: false };
    const found = new Map();
    for (const record of read.records) {
      if (record?.local === true) continue;
      const friend = channelOf(me, record?.author);
      if (!friend) continue;
      const checked = verifyGrant(record, { self: me.author, peer: record.author });
      if (checked.ok) found.set(proxyKey(record.author, checked.body.grant), { friend, body: checked.body });
    }
    // 本机已有的代理记录（含重启前登记的）都要跟上。
    const mine = new Map((await coda.list(PROTOCOL, { scope: 'local' })).filter(entry => entry.plugin === coda.plugin.id && entry.key).map(entry => [entry.key, entry]));
    for (const [key, entry] of mine) {
      self ??= entry.owner;
      const holder = entry.labels?.[LABEL_HOLDER], grant = entry.labels?.[LABEL_GRANT];
      if (!known.has(key) && isAuthor(holder) && grant) known.set(key, { holder, grant, grantee: null, spec: entry.spec, offered: false, present: false });
    }
    const names = found.size ? await namesOf([...found.values()].map(one => one.friend)) : new Map();
    for (const [key, { friend, body }] of found) {
      known.set(key, { holder: body.holder, grant: body.grant, grantee: body.grantee, spec: { ...body.spec, name: `${body.spec.name}@${names.get(friend.node)}` },
        offered: body.available, present: true });
    }
    for (const [key, grant] of known) {
      if (stopped) return;
      if (!found.has(key) && !read.truncated) {
        grant.present = false;
        // 通道还在、而目录里这一号已经没有（或只剩撤回的空正文）：确认是撤回。通道不在时目录可能只是停止了跟随，不删。
        if (channelOf(me, grant.holder) && await retracted(grant)) {
          if (mine.has(key)) await coda.delete({ kind: PROTOCOL, key });
          known.delete(key);
          continue;
        }
      }
      await register(key, grant, me, mine.get(key));
    }
  }

  // 好友称呼：与好友页同一个函数（本机备注、好友名片名、短公钥依次取）。
  async function namesOf(friends) {
    const [profiles, cards] = await Promise.all([pages({ kind: PROFILE_KIND }), pages({ kind: CARD_KIND })]);
    const notes = dir ? await readNotes(dir) : {};
    return new Map(mergeFriendRows({ friends, profiles: profiles.records, cards: cards.records, notes }).map(row => [row.node, row.title]));
  }

  async function retracted({ holder, grant }) {
    const read = await coda.query(ACCORD, 'records', { kind: KIND_GRANT, author: holder, id: grant, limit: 1 });
    return !(read?.records ?? []).some(record => record.author === holder && record.id === grant && Object.keys(record.body ?? {}).length > 0);
  }

  // 写本机这条代理记录，再去重：候选是与持有方有通道的机器（它们才登记代理记录），机器 ID 最小的留下；本机不是候选、
  // 或空间里有 ID 更小的同一授权的代理记录，就删掉自己这条。可用性只写在留下的那条上，不参与比较。
  // 本机的机器 ID 取自本机写过的代理记录（还没有时先写一次）。
  async function register(key, grant, me, existing) {
    const labels = { [LABEL_HOLDER]: grant.holder, [LABEL_GRANT]: grant.grant };
    const value = { spec: grant.spec, status: { available: problemOf(grant, me) === null }, labels };
    const candidate = Boolean(channelOf(me, grant.holder));
    const others = candidate ? (await coda.list(PROTOCOL, { labels })).filter(entry => !entry.local) : [];
    const beaten = owner => others.some(entry => entry.owner < owner);
    if (!candidate || (self && beaten(self))) {
      if (existing) await coda.delete({ kind: PROTOCOL, key });
      return;
    }
    if (!(existing && ['spec', 'status', 'labels'].every(field => isDeepStrictEqual(existing[field], value[field])))) {
      const written = await coda.put({ kind: PROTOCOL, key }, value);
      self ??= written?.owner ?? null;
    }
    if (self && beaten(self)) await coda.delete({ kind: PROTOCOL, key });
  }

  // ---- exec ----

  async function run(input, ctx) {
    await ready;
    const me = await identity(), grant = known.get(ctx.record?.key), problem = problemOf(grant, me);
    if (problem) throw fail(...PROBLEMS[problem]);
    const rebuilt = rebuildExecInput(input);
    if (!rebuilt.ok) throw fail('invalid_input', rebuilt.message);
    const request = requestId(ctx.id), createdAt = now();
    // 超过 56 KiB（按序列化字节，含取消版本多出的字段）的，callRecord 当场以 invalid_input、none 拒绝。
    const record = callRecord({ caller: me.author, holder: grant.holder, grant: grant.grant, request, input: rebuilt.input, createdAt,
      expiresAt: Math.min(ctx.deadline ?? Infinity, createdAt + MAX_WINDOW_MS) });
    const parent = ctx.caller?.parent;
    const entry = await store.addOutgoing({ call: ctx.id, key: ctx.record.key, machine: ctx.caller?.machine, parent: parent ? `${parent.kind}:${parent.id}` : null, body: record.body });
    // 从发出到交出结局一直在听：其间看到过本机作者变了，就记在 waiter.stale 上，交出结局时还在。
    const watch = track(entry, ctx.signal);
    try {
      let answer;
      try {
        try { await signRpc(record); } catch (e) {
          // 没发出去：发出表里这一项按已了结处理，清扫时撤回（多半什么也不用撤）并清掉。
          await store.setOutgoingState(request, 'finished').catch(() => {});
          throw e;
        }
        answer = await wait(entry, ctx.signal, watch);
        await store.setOutgoingState(request, 'finished').catch(() => {});
      } finally {
        await store.settleOutgoing(request).catch(() => {});
        kick();
      }
      // 交出结局的这一刻再看一次（最后一次等待之后，此后不再有 await）：已取消、已到期的按取消、到期结束，本机作者变了就停用，
      // 好友表里已没有这把持有方机器钥匙就不采用；都不交这份结局。好友那边已有终态，不再发取消。读作者也挂在 signal 上。
      let me = { author: null, friends: [] };
      try { me = await watch.guard(identity()); } catch (e) { if (e !== ctx.signal.reason) throw e; }
      if (ctx.signal.aborted) {
        if (ctx.signal.reason?.name === 'TimeoutError') throw fail('timeout', `调用到期，结局没有交出；${LOST}（请求号 ${request}）`, 'unknown');
        throw ctx.signal.reason;
      }
      if (watch.waiter.stale || me.author !== entry.author) throw staleError(request);
      if (!channelOf(me, entry.holder)) throw holderGone(request);
      return outcomeOf(answer);
    } finally {
      watch.dispose();
    }
  }
  const cancelNote = sent => sent ? '已请好友的机器取消' : '取消没能发出，会在请求有效期内重试';
  const staleError = request => fail('invalid_state', `本机的签名身份变了，不再等这次调用的回答；${LOST}（请求号 ${request}）`, 'unknown');
  const holderGone = request => fail('interrupted', `好友已移除或换了机器钥匙，不采用旧机器的回答；${LOST}（请求号 ${request}）`, 'unknown');

  // 一次调用从发出到交出结局的监听：waiter 登记在 waiters 里，Accord 变化叫醒它，看到本机作者变了就置 stale（只置不清）；
  // guard 让一个等待随 signal 中止。dispose 之前一直在听。
  function track(entry, signal) {
    let pending = false, wake = null;
    const waiter = { author: entry.author, request: entry.request, stale: false,
      poke() { if (wake) { wake(); wake = null; } else pending = true; },
      next() { if (pending) { pending = false; return Promise.resolve(); } return new Promise(resolve => { wake = resolve; }); } };
    const aborted = new Promise((resolve, reject) => {
      if (signal.aborted) reject(signal.reason); else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    aborted.catch(() => {});
    waiters.add(waiter);
    return { waiter, guard: promise => Promise.race([promise, aborted]), dispose: () => waiters.delete(waiter) };
  }

  // 等一条请求的回答（`entry` 是发出项）：Accord 变化通知与兜底查询叫醒，每次精确读一回；有 running 算收到回执，有终态就给回那条回答。
  // 请求已签出：读失败只当这一回没读到，下次叫醒再读，不把读取的错误当成结局。等待与每次读取都挂在 signal 上，取消、到期一来就停下；
  // 收到回执之前，每次读取还和 75 秒的回执期限竞速，期限一到不等在途查询，它之后的结果不管。
  async function wait(entry, signal, { waiter, guard }) {
    const { request } = entry;
    let acked = false, late = false, ack;
    const overdue = new Promise(resolve => { ack = timers.setTimeout(() => { late = true; waiter.poke(); resolve(null); }, ackMs); });
    const read = () => readAnswer(entry, signal).catch(() => null);
    try {
      for (;;) {
        if (signal.aborted) throw signal.reason;
        if (waiter.stale) throw staleError(request);
        const answer = await guard(acked ? read() : Promise.race([read(), overdue]));
        if (answer && TERMINAL.includes(answer.state)) return answer;
        if (answer) acked = true;
        if (!acked && late) {
          const sent = await sendCancel(entry);
          throw fail('peer_offline', `${ackMs / 1000} 秒内没有收到好友机器的回执，${cancelNote(sent)}；${LOST}（请求号 ${request}）`, 'unknown');
        }
        await guard(waiter.next());
      }
    } catch (e) {
      if (!signal.aborted || e !== signal.reason) throw e;
      // 调用被取消（AbortError）或到期（TimeoutError）：先发取消。取消照原因抛出；到期以 timeout、unknown 结束。
      const sent = await sendCancel(entry);
      if (e?.name === 'TimeoutError') throw fail('timeout', `调用到期，${cancelNote(sent)}；${LOST}（请求号 ${request}）`, 'unknown');
      throw e;
    } finally {
      timers.clearTimeout(ack);
    }
  }

  // 按「持有方机器钥匙、种类、回答 id」精确读；作者是这把钥匙、受众恰好是发出时的本机作者，授权号、请求号、摘要都与发出项一致，才算数。
  async function readAnswer(entry, signal) {
    const read = await coda.query(ACCORD, 'records', { kind: KIND_ANSWER, author: entry.holder, id: answerId(entry.author, entry.request), includeAudience: true, limit: 1 },
      signal ? { signal } : undefined);
    for (const record of read?.records ?? []) {
      const checked = verifyAnswer(record, { self: entry.author, peer: entry.holder });
      if (checked.ok && checked.body.grant === entry.grant && checked.body.request === entry.request && checked.body.digest === entry.digest) return checked.body;
    }
    return null;
  }

  // 交出结局：completed 给结果，failed 照它的错误抛，canceled 按取消。
  function outcomeOf(answer) {
    if (answer.state === 'completed') return answer.result;
    const { code, message, effects } = answer.error ?? { code: answer.state, message: '好友的机器没有说明原因', effects: 'unknown' };
    throw fail(answer.state === 'canceled' ? 'canceled' : code, message, effects);
  }

  // 取消：同一请求号的更高版本，带 cancel: true。发出去记 canceled；发不出去（离线、证书不可用）记 cancel_pending，清扫时在有效期内补发。
  // 给回是否发出去了。
  async function sendCancel(entry) {
    let sent = true;
    try { await signRpc(cancelRecord(entry.body, now())); } catch { sent = false; }
    await store.setOutgoingState(entry.request, sent ? 'canceled' : 'cancel_pending').catch(() => {});
    return sent;
  }

  // 重启后收尾，整个过程至多 30 秒（等就绪、读发出项、补发取消、读回答、写盘都算在内）：按原调用号算出请求号，照发出项里存的作者、持有方、
  // 授权号、摘要读一次回答。有终态给终态；超时、读不出、没有终态、本机作者已不是发出时的那个，一律 interrupted、unknown，不再重发请求。
  // 第一次异步等待之前就记下本机作者的代次，其间作者变过（哪怕又换回来）代次就不同。交出终态之前（写盘之后）再读一次身份：
  // 代次变了、此刻作者不是发出时的那个，或好友表里已没有这把持有方机器钥匙，也是 interrupted、unknown。
  // 超时后 `halted` 让还在跑的查找停下：不再补发、不再查询、不再写盘；查找没写成的了结标记另行补写，不等它。
  async function resume(call) {
    const request = requestId(call.id);
    const born = generation;
    let halted = false, settled = false, gone = false, limit;
    const lookup = async () => {
      await ready;
      const entry = halted ? null : await store.getOutgoing(request);
      if (!entry || halted) return null;
      const mine = (await identity()).author === entry.author;
      if (halted) return null;
      if (mine && call.canceled && ['sent', 'cancel_pending'].includes(entry.state)) await sendCancel(entry);
      const answer = mine && !halted ? await readAnswer(entry) : null;
      if (halted) return null;
      const terminal = answer && TERMINAL.includes(answer.state) ? answer : null;
      // 结局已核对过：之后写盘失败只是本机记账没记上（清扫时照发出项补），结局照样交出。
      try {
        if (terminal) await store.setOutgoingState(request, 'finished');
        if (halted) return null;
        await store.settleOutgoing(request);
        settled = true;
      } catch { /* 见上 */ }
      if (!terminal) return null;
      const me = await identity();
      if (halted || generation !== born || me.author !== entry.author) return null;
      gone = !channelOf(me, entry.holder);
      return gone ? null : terminal;
    };
    const expired = new Promise(resolve => { limit = timers.setTimeout(() => { halted = true; resolve(null); }, RESUME_MS); });
    let answer = null;
    try { answer = await Promise.race([lookup(), expired]); } catch { /* 读不出、写不进：同没有终态 */ } finally { timers.clearTimeout(limit); }
    halted = true;
    if (!settled) store.settleOutgoing(request).catch(() => {});
    kick();
    if (gone) throw holderGone(request);
    if (!answer) throw fail('interrupted', `插件重启了，没等到好友机器的结局；${LOST}（请求号 ${request}）`, 'unknown');
    return outcomeOf(answer);
  }

  // 好友授给本机的代理记录（给好友页读，只读）：给了 `friend`（好友的公钥）就只列这位好友的，按他通道背后的机器钥匙筛。
  // 状态：available 可用，或 PROBLEMS 里的原因（off、channel、author、sign）。
  async function list({ friend } = {}) {
    if (friend !== undefined && !isAuthor(friend)) throw fail('invalid_input', 'friend 须是好友的公钥（ed25519:…）');
    await ready;
    const me = await identity(), holders = new Set(me.friends.filter(one => friend === undefined || one.author === friend).map(one => one.machine));
    return [...known].filter(([, grant]) => friend === undefined || holders.has(grant.holder))
      .map(([key, grant]) => ({ key, grant: grant.grant, holder: grant.holder, name: grant.spec.name, os: grant.spec.os, user: grant.spec.user, status: problemOf(grant, me) ?? 'available' }));
  }

  // ---- 请求的撤回 ----

  // 清扫发出表，都按发出时的作者（`entry.author`）签：
  // - 取消待发的：有效期内补发；
  // - 处理函数已了结、拿到结局或过了 expiresAt 的：撤回请求再清掉发出项；还没了结的（等重启后的 resume）不动；
  // - 签不了、或本机作者此刻不是它：推迟，不删；过了保留期（expiresAt 之后 24 小时）还是不能签的，不再惦记，清掉。
  async function sweep() {
    const me = await identity();
    for (const entry of await store.listOutgoing()) {
      if (stopped) return;
      const at = now(), signable = me.canSign && me.author === entry.author, overdue = at >= entry.expiresAt + KEEP_AFTER_EXPIRY_MS;
      try {
        if (entry.state === 'cancel_pending' && at < entry.expiresAt) { if (signable) await sendCancel(entry); continue; }
        if (!overdue && !(entry.settled && (entry.state === 'finished' || at >= entry.expiresAt))) continue;
        if (signable) await retractRpc({ kind: KIND_CALL, id: entry.request, author: entry.author });
        else if (!overdue) continue;
        await store.removeOutgoing(entry.request);
      } catch { /* 离线：下次再撤 */ }
    }
  }

  // ---- 节拍 ----

  function tick() {
    if (queued) return queued;
    const run = ticking.then(async () => {
      queued = null;
      for (const work of [sync, sweep]) {
        if (stopped) return;
        try { await work(); } catch { /* 下一拍再来 */ }
      }
    });
    queued = run;
    ticking = run.catch(() => {});
    return run;
  }
  const kick = () => { if (!stopped) tick().catch(() => {}); };
  const schedule = () => {
    if (stopped) return;
    timer = timers.setTimeout(() => {
      for (const waiter of waiters) waiter.poke();
      tick().finally(schedule);
    }, pollMs);
    timer?.unref?.();
  };

  // 本机 Accord 变了：可能来了回答或授权；本机作者变了，在等的请求不再处理。
  function onAccordChange({ type, entry } = {}) {
    const { author } = signerOf(type === 'DELETED' ? null : entry);
    if (isAuthor(author)) {
      if (lastAuthor && author !== lastAuthor) generation++;
      lastAuthor = author;
    }
    for (const waiter of waiters) {
      if (isAuthor(author) && author !== waiter.author) waiter.stale = true;
      waiter.poke();
    }
    kick();
  }

  return {
    // 测试与诊断用：推一拍（发现、去重、撤回）。
    tick: () => tick(),
    list,
    async start() {
      // 处理函数先同步登记，宿主在 activate 之后交来的调用不会落空；它们等第一遍发现做完再看。
      handles.push(coda.handle(PROTOCOL, 'exec', { run, resume }));
      const streams = Promise.all(['pull', 'push'].map(name => coda.stream(PROTOCOL, name, () => { throw fail('unsupported', UNSUPPORTED); })));
      try {
        for (const handle of await streams) { if (stopped) handle?.dispose?.(); else handles.push(handle); }
        if (onAccord) subscriptions.push(onAccord(onAccordChange));
        if (stopped) return;
        schedule();
        await tick();
      } finally { markReady(); }
    },
    stop() {
      stopped = true;
      if (timer) timers.clearTimeout(timer);
      timer = null;
      for (const one of [...handles.splice(0), ...subscriptions.splice(0)]) one?.dispose?.();
      markReady();
    },
  };
}
