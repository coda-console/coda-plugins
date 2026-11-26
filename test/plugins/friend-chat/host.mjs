// 好友对话的测试宿主：每一端是一台装了 friend-chat 的机器（../../helpers/mock-coda.mjs 的内存 coda，记录按 coda/session@1 校验），
// 几端共用一本 Accord 账本：记录按到达顺序排、version 是签名者自己的时间，按页吐；发布记进账本并像 Coda 一样告诉各端的 watch。
// 时钟可控：`now` 与证书到期定时器都由测试推进，不睡眠。
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SESSION_PROTOCOL } from '@coda-console/protocol/protocol';
import { pointProblem } from '@coda-console/protocol/validate';
import { createMockCoda, TEST_OWNER } from '../../helpers/mock-coda.mjs';
import { startService } from '../../../plugins/friend-chat/lib/service.mjs';

export const SESSION = 'coda/session@1', ACCORD = 'coda/accord@1', EVENT = 'friend-chat/event';
export const START = 1_800_000_000_000;
export const ACTIVE = { active: true, until: START + 86_400_000 };
export const author = digit => `ed25519:${digit.repeat(64)}`;
export const MACHINE = author('f');
export const friend = (who, extra) => ({ node: `n-${who.slice(8, 12)}`, author: who, bound: true, certified: true, ...extra });

export function manualClock(start = START) {
  let now = start, next = 0;
  const timers = new Map();
  const clock = {
    timers,
    // `script`：接下来几次读时钟依次给出的时刻（读一次走到那里），读完照常。
    script: [],
    now() { if (clock.script.length) now = clock.script.shift(); return now; },
    setTimer(fn, ms) { const id = ++next; timers.set(id, { fn, ms, at: now + ms }); return id; },
    clearTimer(id) { timers.delete(id); },
    // 推进时间，到点的定时器依次跑完（它们是 async 的）。
    // 只走时间，不跑定时器（模拟异步写挂起期间时间流逝）。
    pass(ms) { now += ms; },
    async advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now && timers.delete(id)) await timer.fn();
    },
  };
  return clock;
}

/** 一本账本，各端共用。`deliver` 把一条记录按到达顺序追加并通知各端。 */
export function network() {
  const net = { ledger: [], sides: [], version: 1000 };
  net.notify = async () => { for (const side of net.sides) await side.accord.notify(); };
  net.deliver = async record => { net.ledger.push(structuredClone(record)); await net.notify(); };
  net.settled = () => Promise.all(net.sides.map(side => side.service?.settled()));
  return net;
}

// 一端的 Accord：身份、证书、好友表可换；records 只给本端身份看得到的（作者是它或在 audience 里）。
function accordOf(net, { root, certificate = ACTIVE, friends = [], pageSize = 200 }) {
  const accord = { root, certificate, friends, pageSize, queries: [], calls: [], listeners: new Set(), onPublish: null, beforePublish: null, failure: null };
  const visible = record => record.author === accord.root || record.audience?.includes(accord.root);
  Object.assign(accord, {
    entry: () => ({ kind: ACCORD, id: 'local', local: true, version: '1',
      spec: { author: accord.certificate === null ? MACHINE : accord.root },
      status: { certificate: accord.certificate === null ? null : { root: accord.root, key: MACHINE, ...accord.certificate }, friends: structuredClone(accord.friends) } }),
    async notify() { for (const listener of [...accord.listeners]) listener({ type: 'MODIFIED', id: 'local', entry: accord.entry() }); },
    async change(next) { Object.assign(accord, next); await accord.notify(); },
    async query(ref, operation, input) {
      assert.deepEqual([ref, operation], [{ kind: ACCORD, id: 'local' }, 'records']);
      accord.queries.push(structuredClone(input));
      const rows = net.ledger.filter(record => record.kind === input.kind && visible(record));
      const from = Number(input.cursor ?? 0), page = rows.slice(from, from + accord.pageSize), more = from + accord.pageSize < rows.length;
      return { records: structuredClone(page), truncated: more, ...(more ? { nextCursor: String(from + accord.pageSize) } : {}) };
    },
    async call(ref, operation, input, options) {
      assert.deepEqual([ref, operation], [{ kind: ACCORD, id: 'local' }, 'publish']);
      accord.calls.push({ input: structuredClone(input), options });
      await accord.beforePublish?.();
      if (accord.failure) throw accord.failure;
      assert.equal(input.expectAuthor, accord.root, '预期作者是本机个人身份');
      const old = net.ledger.findIndex(record => record.kind === input.kind && record.id === input.id && record.author === accord.root);
      if (old < 0) net.ledger.push({ kind: input.kind, author: accord.root, id: input.id, version: ++net.version, body: structuredClone(input.body), audience: [...input.audience] });
      await accord.onPublish?.(net.ledger.at(-1));
      await net.notify();
      return { author: accord.root, kind: input.kind, id: input.id, version: net.version, audience: input.audience };
    },
    async watch(kind, listener, filter) {
      assert.deepEqual([kind, filter], [ACCORD, { id: 'local' }]);
      accord.listeners.add(listener);
      listener({ type: 'ADDED', id: 'local', entry: accord.entry() });
      return { dispose: () => accord.listeners.delete(listener) };
    },
  });
  return accord;
}

/**
 * 一端：`root` 是它的个人身份；`dir` 给了就沿用（模拟重启），否则新建；`records` 是宿主里已有的记录（上次运行留下的）。
 * 返回 `{ host, coda, accord, clock, service, sessions(), read(), post(), writes }`。
 */
export async function side(t, net, { root, dir, records = [], clock = manualClock(), start = true, ...options }) {
  dir ??= await mkdtemp(join(tmpdir(), 'friend-chat-'));
  const host = createMockCoda({ plugin: { id: 'friend-chat', state: dir, protocols: [SESSION_PROTOCOL] }, records });
  const accord = accordOf(net, { root, ...options });
  const handlers = new Map(), writes = [];
  const coda = {
    ...host.coda,
    get: ref => ref.kind === ACCORD ? Promise.resolve(accord.entry()) : host.coda.get(ref),
    query: accord.query,
    watch: (kind, listener, filter) => kind === ACCORD ? accord.watch(kind, listener, filter) : host.coda.watch(kind, listener, filter),
    pointer: (service, path, extra) => ({ owner: TEST_OWNER, path: `plugins/friend-chat/services/${service}/${path}`, ...extra }),
    handle(kind, operation, fn) { handlers.set(operation, fn); return host.coda.handle(kind, operation, fn); },
    put: async (ref, value) => { writes.push(['put', ref.key]); await me.onWrite?.(); return host.coda.put(ref, value); },
    delete: ref => { writes.push(['delete', ref.key]); return host.coda.delete(ref); },
    replace: async (kind, items) => { writes.push(['replace', items.map(item => item.key)]); await me.onWrite?.(); return host.coda.replace(kind, items); },
  };
  // `onWrite`：每次写会话记录前等它（测试在写入挂起期间推进时钟）。
  const me = { dir, host, coda, accord, clock, handlers, writes, root, onWrite: null };
  me.sessions = async () => Object.fromEntries((await host.coda.list(SESSION, { scope: 'local' })).map(entry => [entry.key, entry]));
  me.session = async peer => (await me.sessions())[`${root}:${peer}`];
  me.read = async (peer, input = {}, key = `${root}:${peer}`) => {
    const entry = (await me.sessions())[key];
    assert.ok(entry, `没有会话记录 ${key}`);
    return host.call({ kind: SESSION, id: entry.id }, 'read', input);
  };
  // post 是运行：照 Coda 给处理函数的 ctx（id、record、signal、call）调；输入按 schema 校验，结果按 completed 的形状校验。
  me.post = async (peer, input, { id = `call-${Math.random()}`, signal = new AbortController().signal, key = `${root}:${peer}` } = {}) => {
    const problem = pointProblem(SESSION_PROTOCOL.operations.post.input, input, '输入');
    assert.equal(problem, null);
    const result = await handlers.get('post')(structuredClone(input), { id, record: { kind: SESSION, id: 'rec', key }, signal, call: accord.call });
    assert.deepEqual(Object.keys(result), ['message']);
    assert.deepEqual(Object.keys(result.message).sort(), ['cursor', 'id']);
    return result;
  };
  me.start = async () => {
    me.service = await startService(coda, clock);
    return me;
  };
  me.stop = async () => { await me.service?.stop(); me.service = null; };
  net.sides.push(me);
  t.after(async () => { await me.stop(); host.close(); await rm(dir, { recursive: true, force: true }); });
  return start ? me.start() : me;
}
