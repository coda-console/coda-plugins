// 抽象社交网关：实现 friends/social@1。业务无关——只认 kind、id、body；签名写入与记录查询全部透传 coda/accord@1，
// 自己不建第二份目录库，只在 outbox.json 里留还没发出去的 body（同步成功即释放）。所有会写盘、会外发的动作排成一条队，
// 发布、撤回、证书变化引起的冲洗互不交叉。
import { mergeFriendRows, statusOf } from './friends.mjs';
import { canSkip, canonicalHash, certStateOf, checkId, checkKind, checkPublish, entryKey, holdState, keyOf, retractKey, invalid, isPending, markRejected, markSynced,
  nextSeq, queuePublish, queueRetract, readOutbox, withState, writeOutbox } from './outbox.mjs';
import { readPolicy, setKindPaused } from './policy.mjs';

const ACCORD = { kind: 'coda/accord@1', id: 'local' };
const SOCIAL = 'friends/social@1';
const MAX_PAGES = 50;
const REJECTED = new Set(['invalid_input', 'forbidden']);
const message = e => String(e?.message ?? e);
const interrupted = effects => Object.assign(new Error('好友网关已停止'), { code: 'interrupted', effects });

export function createGateway(coda, dir) {
  let stopped = false, watching = null, chain = Promise.resolve();
  const handles = [];
  const stateDir = () => {
    if (!dir) throw new Error('这台机器没有插件状态目录，网关的待发队列存不下');
    return dir;
  };
  // 停了以后不再发起新的签名写入、策略写入：每个副作用之前、每次 await 回来都过一下它。
  const live = (effects = 'none') => { if (stopped) throw interrupted(effects); };
  // 所有写盘与外发排成一条队；停了以后排着的活不再做。
  const serial = work => {
    const run = chain.then(() => { live(); return work(); });
    chain = run.then(() => {}, () => {});
    return run;
  };
  // `save` 落待处理的意图，在签名之前；停了就不写。`persist` 落已经确认的结果（签名已成功，磁盘不能比远端旧），停了也要写。
  const save = async outbox => { live(); await writeOutbox(stateDir(), outbox); };
  const persist = outbox => writeOutbox(stateDir(), outbox);

  async function accordState() {
    const accord = await coda.get(ACCORD);
    return { accord, author: accord?.spec?.author ?? null, certState: certStateOf(accord) };
  }

  // 翻页读 coda/accord@1 的记录，至多 MAX_PAGES 页；cursor 重复就停，不会原地打转。
  async function pages(input) {
    const records = [], seen = new Set();
    let cursor;
    for (let page = 0; page < MAX_PAGES; page++) {
      const read = await coda.query(ACCORD, 'records', { ...input, limit: 200, ...(cursor ? { cursor } : {}) });
      records.push(...(read?.records ?? []));
      cursor = read?.nextCursor;
      if (!read?.truncated) return { records, truncated: false };
      if (!cursor || seen.has(cursor)) break;
      seen.add(cursor);
    }
    return { records, truncated: true };
  }

  // 本机在 Accord 里有没有这条记录。
  async function holds(kind, author, id) {
    const read = await coda.query(ACCORD, 'records', { kind, author, id, limit: 1 });
    return (read?.records ?? []).some(record => record?.local === true && record.id === id);
  }

  // 把一条待发或待撤的条目交给 coda/accord@1 发出去（撤回是 body 为空、audience 为空的发布）。
  async function attempt(entry, author) {
    live();
    const input = entry.desired === 'publish' ? { kind: entry.kind, id: entry.id, body: entry.body, audience: entry.audience }
      : { kind: entry.kind, id: entry.id, body: {}, audience: [] };
    try {
      const result = await coda.call(ACCORD, 'publish', input);
      return entry.desired === 'publish' ? { state: 'synced', entry: markSynced(entry, result?.author ?? author, Date.now()), result } : { state: 'retracted', entry: null };
    } catch (e) {
      if (e?.code === 'invalid_state') return { state: 'needs_cert', entry: withState(entry, 'needs_cert', message(e)), error: message(e) };
      if (REJECTED.has(e?.code)) return { state: 'error', entry: markRejected(entry, message(e)), error: message(e) };
      return { state: 'queued', entry: withState(entry, 'queued', message(e)), error: message(e) };
    }
  }

  // 读出待发队列；旧版残留的保留类型条目（如 friends/card）已被读表丢掉，这里把清理落盘，之后不再补发，也不挡着别的条目。
  async function purgeReserved() {
    const outbox = await readOutbox(stateDir());
    if (outbox.dropped) await persist(outbox);
    return outbox;
  }

  // 冲洗：能发的待发、待撤条目发出去；证书不对或 kind 暂停的只更新状态。
  async function flushNow() {
    const d = stateDir(), outbox = await purgeReserved();
    if (!Object.values(outbox).some(isPending)) return;
    const [{ author, certState }, { pausedKinds }] = await Promise.all([accordState(), readPolicy(d)]);
    let changed = false;
    for (const entry of Object.values(outbox).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))) {
      live();
      if (!isPending(entry)) continue;
      const key = keyOf(entry), hold = holdState(entry, certState, pausedKinds);
      if (hold) {
        if (entry.state !== hold) { outbox[key] = withState(entry, hold, entry.lastError); changed = true; }
        continue;
      }
      // 待撤的条目只替排队时的作者撤：作者换了，同一个 id 可能是另一个人的记录。
      // 没同步过的待撤条目，先确认本机在 Accord 里真有这条记录再签名；没有就清掉，不为从未发布的 id 生成墓碑。
      if (entry.desired === 'retract') {
        if (entry.targetAuthor !== author) continue;
        // 同一条记录之后有更晚的发布，这条旧撤回已被取代：那条发布这位作者已经同步了，旧撤回直接删；还待发的，旧撤回先留着不执行，
        // 等它发布成功时和 synced 一起落盘删除（被拒或中途停用，旧撤回就还在盘上）。
        const later = outbox[entryKey(entry.kind, entry.id)];
        if (later?.desired === 'publish' && (later.seq ?? 0) > (entry.seq ?? 0)) {
          if (later.state === 'synced' && later.lastAuthor === author) {
            live();
            delete outbox[key];
            await save(outbox);
            changed = false;
            continue;
          }
          if (isPending(later)) continue;
        }
        if (entry.lastSyncedHash === undefined) {
          let held;
          try { held = await holds(entry.kind, author, entry.id); } catch (e) {
            // 一条查不出来是临时故障，不拦着后面不相干的条目：它留作 queued 并记下错误，下一次冲洗再试。
            if (stopped) return;
            outbox[key] = withState(entry, 'queued', message(e));
            await persist(outbox);
            changed = false;
            continue;
          }
          if (stopped) return;
          if (!held) {
            delete outbox[key];
            await persist(outbox);
            changed = false;
            continue;
          }
        }
      }
      const done = await attempt(entry, author);
      if (done.entry) outbox[key] = done.entry; else delete outbox[key];
      if (done.state === 'synced') {
        const old = outbox[retractKey(done.entry.lastAuthor, entry.kind, entry.id)];
        if (old && (old.seq ?? 0) < (entry.seq ?? 0)) delete outbox[keyOf(old)];
      }
      await persist(outbox);
      changed = false;
      if (done.state === 'needs_cert') break;
    }
    if (changed) await persist(outbox);
  }

  // 本机网关记录：别的插件读它就知道网关在不在、证书和待发队列的情况。读不到 Accord 就不更新。
  async function refreshNow() {
    if (stopped) return;
    try {
      const { accord, author, certState } = await accordState();
      const outbox = dir ? await readOutbox(dir) : {}, { pausedKinds } = dir ? await readPolicy(dir) : { pausedKinds: [] };
      const until = accord?.status?.certificate?.until;
      const friends = Array.isArray(accord?.status?.friends) ? accord.status.friends : [];
      const status = { author, certState, ...(Number.isSafeInteger(until) && until >= 0 ? { certUntil: until } : {}),
        friendCount: friends.filter(friend => statusOf(friend) === 'bound').length, pendingCount: Object.values(outbox).filter(isPending).length, pausedKinds };
      if (!stopped) await coda.put({ kind: SOCIAL, key: 'local' }, { spec: { version: 1 }, status });
    } catch { /* 状态记录下一次动作会再写 */ }
  }
  const mutate = work => serial(async () => { try { return await work(); } finally { await refreshNow(); } });

  // ---- friends/social@1 的操作 ----

  async function friends({ includePending = false } = {}) {
    const { accord, author, certState } = await accordState();
    const list = Array.isArray(accord?.status?.friends) ? accord.status.friends : [];
    return { selfAuthor: author, certState, friends: mergeFriendRows(list).filter(row => includePending || row.status === 'bound') };
  }

  function records({ kind, author, id, limit, cursor, includeAudience }) {
    if (kind === 'binding') throw invalid('kind「binding」是保留类型，网关不读它');
    if (id !== undefined) checkId(id, { query: true });
    return coda.query(ACCORD, 'records', { kind, ...(author === undefined ? {} : { author }), ...(id === undefined ? {} : { id }),
      ...(limit === undefined ? {} : { limit }), ...(cursor === undefined ? {} : { cursor }), ...(includeAudience === undefined ? {} : { includeAudience }) });
  }

  function publish(input) {
    const item = checkPublish(input);
    return mutate(() => publishItem(item));
  }

  // publish 的本体，须已在队里（mutate）。
  async function publishItem(item) {
    const d = stateDir(), key = entryKey(item.kind, item.id), outbox = await readOutbox(d), prev = outbox[key];
    let current;
    try { current = await accordState(); } catch (e) {
      outbox[key] = withState(queuePublish(prev, item, nextSeq(outbox)), 'queued', message(e));
      await save(outbox);
      return { state: 'queued', error: message(e) };
    }
    live();
    const { author, certState } = current;
    // 新发布盖过这个作者排着的待撤，免得旧的待撤之后又把新内容撤了。
    const queuedRetract = author ? retractKey(author, item.kind, item.id) : null, prevRetract = outbox[queuedRetract];
    if (canSkip(prev, canonicalHash({ body: item.body, audience: item.audience }), author)) return { state: 'synced', skipped: true, author };
    const entry = queuePublish(prev, item, nextSeq(outbox)), hold = holdState(entry, certState, (await readPolicy(d)).pausedKinds);
    live();
    if (hold) {
      outbox[key] = withState(entry, hold);
      delete outbox[queuedRetract];
      await save(outbox);
      return { state: hold, author };
    }
    // 先把新内容的意图落盘（旧的已同步标记随之作废），再签名；签名后落盘失败，磁盘上也不会还当旧内容已同步。
    outbox[key] = entry;
    delete outbox[queuedRetract];
    await save(outbox);
    const done = await attempt(entry, author);
    if (done.state === 'error') {
      if (prev) outbox[key] = prev; else delete outbox[key];
      if (prevRetract) outbox[queuedRetract] = prevRetract;
      await persist(outbox);
      return { state: 'error', author, error: done.error };
    }
    outbox[key] = done.entry;
    await persist(outbox);
    if (done.state === 'synced') return { state: 'synced', author: done.entry.lastAuthor, ...(Number.isSafeInteger(done.result?.version) ? { version: done.result.version } : {}) };
    return { state: done.state, author, error: done.error };
  }

  function retract({ kind, id } = {}) {
    checkKind(kind);
    if (id !== undefined) checkId(id);
    return mutate(async () => {
      const d = stateDir(), outbox = await readOutbox(d);
      // 网关替这个作者同步过这条记录的痕迹：发布条目是这个作者同步的，或这个作者先前排过的待撤。
      const history = (entries, author, one) => {
        const published = entries[entryKey(kind, one)];
        return (published?.lastAuthor === author ? published : entries[retractKey(author, kind, one)])?.lastSyncedHash;
      };
      // `remote`：Accord 里本机已有的记录 id；`confirmed`：这份清单是读全了的（读全了又不在里面，才算远端没有）。
      let current, remote = new Set(), confirmed = false, truncated = false;
      try {
        current = await accordState();
        if (current.certState !== 'no_identity') {
          if (id === undefined) {
            const own = await pages({ kind, author: current.author });
            truncated = own.truncated;
            confirmed = !truncated;
            remote = new Set(own.records.filter(record => record?.local === true && typeof record.id === 'string').map(record => record.id));
          } else if (current.certState === 'active' && !history(outbox, current.author, id)) {
            confirmed = true;
            if (await holds(kind, current.author, id)) remote = new Set([id]);
          }
        }
      } catch (e) {
        live();
        return { state: 'error', count: 0, error: message(e) };
      }
      live();
      const { author } = current;
      let { certState } = current, count = 0, queued = 0, rejected, failed;
      // 没有身份：没有可撤的作者，只清本机还没发出去的待发；不排无主的待撤条目，免得将来换了身份被误撤。
      if (certState === 'no_identity') {
        const local = Object.entries(outbox).filter(([, entry]) => entry.kind === kind && (id === undefined || entry.id === id) && entry.desired === 'publish' && isPending(entry));
        for (const [key] of local) delete outbox[key];
        if (local.length) await save(outbox);
        return { state: 'no_identity', count: 0 };
      }
      // 别的作者排下的待撤条目不是这次的：不纳入、不删、不计数。
      const ids = id === undefined
        ? new Set([...Object.values(outbox).filter(entry => entry.kind === kind && (entry.desired === 'publish' || entry.targetAuthor === author)).map(entry => entry.id), ...remote])
        : new Set([id]);
      const sends = [];
      // 先把待撤的意图一次落盘，再逐条签名；每条撤完立刻落盘确认，中途停下也不会把已撤的当成还同步着。
      for (const one of ids) {
        const pubKey = entryKey(kind, one), key = retractKey(author, kind, one), published = outbox[pubKey], prevRetract = outbox[key];
        // 排下的待撤盖过这个作者没发出去的待发、或自己同步过的发布条目；别的作者同步的发布条目不动。
        const superseded = published && (isPending(published) || published.lastAuthor === author);
        // 网关没同步过它、远端也确认没有：只剩本机的待发条目，删掉就是撤回。
        if (history(outbox, author, one) === undefined && confirmed && !remote.has(one)) {
          if (superseded || prevRetract) { if (superseded) delete outbox[pubKey]; delete outbox[key]; count++; }
          continue;
        }
        const entry = queueRetract(published?.lastAuthor === author ? published : prevRetract, kind, one, author, nextSeq(outbox));
        if (superseded) delete outbox[pubKey];
        if (certState === 'active') { outbox[key] = entry; sends.push([one, superseded ? published : undefined, prevRetract]); } else { outbox[key] = withState(entry, certState); queued++; }
      }
      await save(outbox);
      // 意图已落盘，从这里起停用就不是什么都没做：effects 说 some。
      for (const [one, published, prevRetract] of sends) {
        live('some');
        const key = retractKey(author, kind, one), entry = outbox[key];
        if (certState !== 'active') { outbox[key] = withState(entry, certState); queued++; await persist(outbox); continue; }
        const done = await attempt(entry, author);
        if (done.state === 'retracted') { delete outbox[key]; count++; }
        else if (done.state === 'error') {
          rejected ??= done.error;
          if (prevRetract) outbox[key] = prevRetract; else delete outbox[key];
          if (published) outbox[entryKey(kind, one)] = published;
        }
        else {
          outbox[key] = done.entry;
          queued++;
          if (done.state === 'needs_cert') certState = 'needs_cert'; else failed ??= done.error;
        }
        await persist(outbox);
      }
      const state = rejected ? 'error' : queued ? (certState === 'active' ? 'queued' : certState) : 'retracted', error = rejected ?? failed;
      return { state, count, ...(queued ? { queued } : {}), ...(truncated ? { truncated } : {}), ...(error ? { error } : {}) };
    });
  }

  async function outbox({ kind } = {}) {
    const d = stateDir(), [{ author, certState }, { pausedKinds }, entries] = await Promise.all([accordState(), readPolicy(d), readOutbox(d)]);
    const items = Object.values(entries).filter(entry => kind === undefined || entry.kind === kind).map(entry =>
      ({ kind: entry.kind, id: entry.id, desired: entry.desired, state: entry.state,
        ...(entry.lastSyncedAt === undefined ? {} : { lastSyncedAt: entry.lastSyncedAt }), ...(entry.lastError === undefined ? {} : { lastError: entry.lastError }) }));
    return { author, certState, pausedKinds, pendingCount: Object.values(entries).filter(isPending).length, items };
  }

  const protocolHandlers = { friends, records, publish, retract, outbox };
  for (const [name, fn] of Object.entries(protocolHandlers)) handles.push(coda.handle(SOCIAL, name, input => fn(input ?? {})));

  // 证书变成可用就冲洗待发队列；任何变化都刷新网关记录。
  const onChange = ({ type, entry } = {}) => {
    const ready = type !== 'DELETED' && certStateOf(entry) === 'active';
    serial(async () => { if (ready) await flushNow(); await refreshNow(); }).catch(() => {});
  };

  return {
    // `coda self policy.get|policy.setKind` 的处理函数。
    policy: {
      'policy.get': () => readPolicy(stateDir()),
      'policy.setKind': ({ kind, paused } = {}) => {
        if (typeof paused !== 'boolean') throw invalid('paused 须是 true 或 false');
        return mutate(async () => {
          const policy = await setKindPaused(stateDir(), kind, paused, live);
          await flushNow();
          return policy;
        });
      },
    },
    async start() {
      if (dir) await serial(purgeReserved).catch(() => {});
      try { watching = await coda.watch(ACCORD.kind, onChange, { id: ACCORD.id }); } catch { /* 没有 Accord：网关记录照样写 */ }
      await serial(refreshNow).catch(() => {});
    },
    stop() {
      stopped = true;
      for (const handle of handles.splice(0)) handle?.dispose?.();
      watching?.dispose?.();
      watching = null;
    },
  };
}
