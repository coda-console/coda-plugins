// 好友对话的运行时：把 coda/accord@1 里的 friend-chat/event 同步进本机投影，投影成 coda/session@1 记录，
// 实现 read、post，并以 avatar 流服务供应几何纹头像。
import { createHash } from 'node:crypto';
import { buildMessageEvent, EVENT_KIND, parseEventRecord } from './envelope.mjs';
import { dmConversationId, identityTitle, isAuthor, renderIdenticonPng, resolveAccordPeers } from './identity.mjs';
import { createStore, storedRoots } from './store.mjs';

export const SESSION = 'coda/session@1';
const ACCORD = { kind: 'coda/accord@1', id: 'local' };
const AVATAR = 'avatar';
const AVATAR_PATH = /^\/ed25519\/([0-9a-f]{64})\.png$/;
const AVATAR_CACHE = 256;
const KEY = /^(ed25519:[0-9a-f]{64}):(ed25519:[0-9a-f]{64})$/;
const MAX_DELAY = 2 ** 31 - 1;
const SWITCHED = '本机已换成另一个个人身份，这段对话只能查看';
const EXPIRED = '本机签名证书已过期，打开客户端后自动续期';
const NOT_FRIEND = '对方已不是你的好友';

const hexOf = author => author.slice('ed25519:'.length);
// 单聊运行时只认这两人之间的 dm 会话；grp: 等别的会话不入库、不投影。
const isDm = (root, peer, conv) => isAuthor(peer) && peer !== root && conv === dmConversationId(root, peer);
const keyOf = (root, peer) => `${root}:${peer}`;
function parseKey(key) {
  const match = typeof key === 'string' ? KEY.exec(key) : null;
  return match && match[1] !== match[2] ? { root: match[1], peer: match[2] } : null;
}

// 由调用 ID 派生的事件 ID（UUID 形状）：同一次调用重试或恢复得到同一个，发布幂等。
function eventIdOf(callId) {
  const b = createHash('sha256').update(`friend-chat/post\n${callId}`).digest().subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50; b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** `coda`：插件宿主；`clock`：`{ now, setTimer, clearTimer }`，测试注入。 */
export async function startService(coda, { now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const stateDir = coda.plugin.state;
  const stores = new Map(), avatars = new Map();
  let accord = null, published = null, timer = null, stopped = false;
  let queue = Promise.resolve(), loop = null, dirty = false;

  const storeOf = root => { if (!stores.has(root)) stores.set(root, createStore(stateDir, root)); return stores.get(root); };
  // 同步与 post 的写库、写记录一个接一个。
  const exclusive = run => { const result = queue.then(run); queue = result.catch(() => {}); return result; };
  const avatarOf = author => coda.pointer(AVATAR, `ed25519/${hexOf(author)}.png`, { mime: 'image/png' });

  // 此刻的准入：`{ peers, canSign, active, until }`，canSign 另看证书的 until 是否已过。
  function standing(entry) {
    const peers = resolveAccordPeers(entry), certificate = entry?.status?.certificate, until = certificate?.until;
    return { peers, until, active: certificate?.active === true, canSign: peers.canSign && !(Number.isFinite(until) && until <= now()) };
  }
  // 这段对话此刻不能发的原因；能发为 null。
  function blocker({ peers, canSign }, root, peer) {
    if (peers.selfRoot === null) return peers.reason;
    if (root !== peers.selfRoot) return SWITCHED;
    if (!canSign) return peers.reason ?? EXPIRED;
    const friend = peers.friends.find(one => one.author === peer);
    return friend?.eligible ? null : friend?.unreachableReason ?? NOT_FRIEND;
  }

  // 读 Accord 里全部 friend-chat/event（version 是签名者的时间，补同步的旧消息会排在后面，所以每次翻完所有页），新的入库。
  async function ingest(peers) {
    const selfRoot = peers.selfRoot, store = storeOf(selfRoot);
    const byConv = new Map();
    for (const friend of peers.friends) if (friend.eligible) byConv.set(dmConversationId(selfRoot, friend.author), friend.author);
    for (const { conv, peer } of await store.conversations()) if (isDm(selfRoot, peer, conv)) byConv.set(conv, peer);
    const batches = new Map(), cursors = new Set();
    let cursor;
    do {
      const read = await coda.query(ACCORD, 'records', { kind: EVENT_KIND, limit: 200, ...(cursor ? { cursor } : {}) });
      for (const record of read?.records ?? []) {
        // 作者是自己就按 conv 反查对端，否则 conv 必须正是与作者的单聊。
        const peer = byConv.get(record?.body?.conv);
        if (!peer || (record.author !== selfRoot && record.author !== peer)) continue;
        const event = parseEventRecord(record, { selfRoot, peerAuthor: peer });
        if (event.status !== 'ok') continue;
        if (!batches.has(peer)) batches.set(peer, []);
        batches.get(peer).push(event);
      }
      cursor = read?.nextCursor;
      if (cursors.has(cursor)) break;
      cursors.add(cursor);
    } while (cursor);
    for (const [peer, events] of batches) await store.ingestAll(events, peer);
  }

  // 这一刻应有的 coda/session@1 记录：key → { spec, status }。
  async function projection(state) {
    const { selfRoot } = state.peers, entries = new Map();
    const roots = new Set(await storedRoots(stateDir));
    if (selfRoot) roots.add(selfRoot);
    for (const root of roots) {
      const heads = new Map();
      for (const { conv, peer, head } of await storeOf(root).conversations()) if (isDm(root, peer, conv)) heads.set(peer, head);
      if (root === selfRoot) for (const friend of state.peers.friends) if (friend.eligible && !heads.has(friend.author)) heads.set(friend.author, null);
      for (const [peer, head] of heads) {
        const reason = blocker(state, root, peer);
        if (reason !== null && head === null) continue;
        entries.set(keyOf(root, peer), {
          spec: { title: identityTitle(peer), container: { id: root, title: '好友对话' } },
          status: {
            participants: [
              { id: root, name: identityTitle(root), kind: 'person', self: true, avatar: avatarOf(root) },
              { id: peer, name: identityTitle(peer), kind: 'person', avatar: avatarOf(peer) },
            ],
            notify: true,
            ...(head === null ? {} : { head }),
            ...(reason === null ? { state: 'active' } : { state: 'unreachable', reason }),
          },
        });
      }
    }
    return entries;
  }

  // 首次整份 replace（清掉上次运行留下的），之后只写变了的、撤下没了的；写失败下次再整份对齐。写完按这轮的快照排到期重算。
  async function project() {
    const state = standing(accord), entries = await projection(state);
    const next = new Map([...entries].map(([key, value]) => [key, JSON.stringify(value)]));
    try {
      if (published === null) {
        await coda.replace(SESSION, [...entries].map(([key, value]) => ({ key, ...value })));
      } else {
        for (const [key, json] of next) if (published.get(key) !== json) await coda.put({ kind: SESSION, key }, entries.get(key));
        for (const key of published.keys()) if (!next.has(key)) await coda.delete({ kind: SESSION, key });
      }
      published = next;
    } catch (e) { published = null; throw e; }
    arm(state);
  }

  // 证书自然到期 Accord 不推送变更：没到 until 就到点重读一次；按可签算的这轮写完时已过 until，立即再算一轮。
  // 只读一次时钟，两者互补。
  function arm(state) {
    if (timer !== null) clearTimer(timer);
    timer = null;
    if (stopped || !state.active || !Number.isFinite(state.until)) return;
    const current = now();
    if (state.until > current) {
      timer = setTimer(async () => {
        timer = null;
        try { accord = await coda.get(ACCORD); } catch (e) { console.error('[friend-chat] 重读 Accord 失败：', e?.message ?? e); }
        request();
      }, Math.min(state.until - current, MAX_DELAY));
    } else if (state.canSign) request();
  }

  async function syncOnce() {
    const state = standing(accord);
    if (state.peers.selfRoot) await ingest(state.peers);
    await project();
  }

  // 要一轮同步：正在同步时只记下 dirty，跑完再跑一轮。
  function request() {
    dirty = true;
    loop ??= (async () => {
      while (dirty && !stopped) {
        dirty = false;
        try { await exclusive(syncOnce); } catch (e) { if (!stopped) console.error('[friend-chat] 同步失败：', e?.message ?? e); }
      }
      loop = null;
    })();
    return loop;
  }

  async function read(input, { record }) {
    const parsed = parseKey(record?.key);
    if (!parsed) throw coda.error('not_found', '会话不存在', { effects: 'none' });
    return storeOf(parsed.root).readMessages(dmConversationId(parsed.root, parsed.peer), input);
  }

  async function post(input, ctx) {
    const parsed = parseKey(ctx.record?.key);
    if (!parsed) throw coda.error('not_found', '会话不存在', { effects: 'none' });
    if (ctx.signal.aborted) throw ctx.signal.reason;
    if ((input.parts ?? []).some(part => part.type !== 'text')) throw coda.error('unsupported', '当前好友对话原型仅支持发送纯文本消息', { effects: 'none' });
    if (typeof input.text !== 'string' || !input.text || !input.text.isWellFormed()) throw coda.error('invalid_input', '消息文本须为非空的合法 UTF-8 字符串', { effects: 'none' });
    const { root, peer } = parsed;
    const reason = blocker(standing(await coda.get(ACCORD)), root, peer);
    if (reason !== null) throw coda.error('invalid_state', reason, { effects: 'none' });
    const conv = dmConversationId(root, peer), eventId = eventIdOf(ctx.id);
    const { recordId, body } = buildMessageEvent({ conv, id: eventId, sentAt: now(), text: input.text, parts: input.parts?.length ? input.parts : undefined });
    if (ctx.signal.aborted) throw ctx.signal.reason;
    try {
      await ctx.call(ACCORD, 'publish', { kind: EVENT_KIND, id: recordId, body, audience: [peer], expectAuthor: root }, { id: `publish:${ctx.id}` });
    } catch (e) {
      // 确知没发出才算取消或照原码失败；发没发出不确定的，即便已取消也是结果未知。
      if (e?.effects === 'none') {
        if (ctx.signal.aborted) throw ctx.signal.reason;
        throw coda.error(e.code ?? 'unavailable', e.message, { effects: 'none' });
      }
      throw coda.error('unknown', e?.message ?? String(e), { effects: 'unknown' });
    }
    // 已发出：不再看 signal，入库并推进 head；watch 先入库了也拿到同一个 localSeq。
    const event = parseEventRecord({ kind: EVENT_KIND, author: root, id: recordId, body }, { selfRoot: root, peerAuthor: peer });
    const { localSeq } = await exclusive(async () => {
      const result = await storeOf(root).ingest(event, peer);
      await project();
      return result;
    });
    return { message: { id: `${root}/${eventId}`, cursor: String(localSeq) } };
  }

  function avatar(request) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
    const url = new URL(request.url), match = url.search ? null : AVATAR_PATH.exec(url.pathname);
    if (!match) return new Response(null, { status: 404 });
    let png = avatars.get(match[1]);
    if (!png) {
      png = renderIdenticonPng(`ed25519:${match[1]}`);
      if (avatars.size >= AVATAR_CACHE) avatars.delete(avatars.keys().next().value);
      avatars.set(match[1], png);
    }
    return new Response(request.method === 'HEAD' ? null : png, { status: 200, headers: {
      'content-type': 'image/png', 'content-length': String(png.length), 'cache-control': 'private, max-age=31536000, immutable' } });
  }

  const handles = [
    coda.handle(SESSION, 'read', read),
    coda.handle(SESSION, 'post', post),
    coda.handle(SESSION, 'draft', () => ({})),
  ];
  const served = await coda.serve(AVATAR, avatar);
  const watcher = await coda.watch(ACCORD.kind, change => { accord = change.type === 'DELETED' ? null : change.entry; request(); }, { id: ACCORD.id });
  await (loop ?? request());

  return {
    /** 当前这轮（及尾随的）同步跑完。 */
    settled: () => loop ?? Promise.resolve(),
    async stop() {
      stopped = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
      watcher.dispose();
      for (const handle of handles) handle.dispose();
      await served.dispose();
      await loop;
    },
  };
}
