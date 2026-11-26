// 本机对话投影：按本机个人身份分目录，每个会话一个 JSON 文件（临时文件 + rename 原子替换，目录 0700、文件 0600）。
// 三个量严格分开：eventId 只管消息身份（按作者 + eventId 幂等去重）；sentAt 是发送方时间，只显示；
// localSeq 是会话内本机入库的严格递增序号（从 1 起），离线补进来的旧消息也拿新的更大序号，所以 head 一定前进。
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { invalidInput } from './envelope.mjs';
import { isAuthor, isConversationId } from './identity.mjs';

const CURSOR = /^[1-9]\d{0,15}$/;
// read 一页的 UTF-8 JSON 至多这么多字节（宿主信封上限 1 MiB），留 256 字节给页外壳。
const PAGE_BYTES = 768 * 1024, PAGE_SHELL = 256;
const digest = text => createHash('sha256').update(text).digest('hex').slice(0, 24);

function cursorOf(name, value) {
  if (typeof value !== 'string' || !CURSOR.test(value)) throw invalidInput(`${name} 游标不合法`);
  return Number(value);
}

const view = message => ({
  id: `${message.author}/${message.id}`,
  cursor: String(message.localSeq),
  sender: message.author,
  text: message.text,
  ...(message.parts ? { parts: message.parts } : {}),
  ...(message.about ? { about: message.about } : {}),
  createdAt: new Date(message.sentAt).toISOString(),
});

const files = async dir => {
  try { return (await readdir(dir)).filter(name => /^[0-9a-f]{24}\.json$/.test(name)); } catch (e) { if (e?.code === 'ENOENT') return []; throw e; }
};

/** stateDir 下存过会话的各个人身份（会话文件里记的 root）。 */
export async function storedRoots(stateDir) {
  const found = [];
  let dirs;
  try { dirs = await readdir(join(stateDir, 'roots')); } catch (e) { if (e?.code === 'ENOENT') return found; throw e; }
  for (const dir of dirs) {
    const [name] = await files(join(stateDir, 'roots', dir));
    if (!name) continue;
    const { root } = JSON.parse(await readFile(join(stateDir, 'roots', dir, name), 'utf8'));
    if (isAuthor(root) && dir === digest(root)) found.push(root);
  }
  return found;
}

// 一页里能留下几条：从新的一头（keepNewest）或旧的一头起留，放不下就停，至少一条。
function fitting(views, keepNewest) {
  let total = PAGE_SHELL, kept = 0;
  for (const one of keepNewest ? views.toReversed() : views) {
    total += Buffer.byteLength(JSON.stringify(one)) + 1;
    if (kept && total > PAGE_BYTES) break;
    kept++;
  }
  return kept;
}

/** 本机 selfRoot 在 stateDir 下的会话投影。所有操作按调用顺序串行。 */
export function createStore(stateDir, selfRoot) {
  if (!isAuthor(selfRoot)) throw new TypeError('selfRoot 不是合法的 Accord 公钥');
  const root = join(stateDir, 'roots', digest(selfRoot));
  const loaded = new Map();
  let tail = Promise.resolve(), counter = 0;
  const serial = run => { const result = tail.then(run); tail = result.catch(() => {}); return result; };

  const remember = (conv, saved) => {
    const messages = saved?.messages ?? [];
    const state = { messages, peer: saved?.peer ?? null, seen: new Map(messages.map(m => [`${m.author}\n${m.id}`, m.localSeq])) };
    loaded.set(conv, state);
    return state;
  };

  async function load(conv) {
    if (loaded.has(conv)) return loaded.get(conv);
    let saved = null;
    try { saved = JSON.parse(await readFile(join(root, `${digest(conv)}.json`), 'utf8')); } catch (e) { if (e?.code !== 'ENOENT') throw e; }
    return remember(conv, saved);
  }

  async function save(conv, state) {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const target = join(root, `${digest(conv)}.json`), temporary = `${target}.${process.pid}.${++counter}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify({ v: 1, conv, root: selfRoot, peer: state.peer, messages: state.messages })}\n`, { mode: 0o600 });
      await rename(temporary, target);
    } catch (e) { await rm(temporary, { force: true }).catch(() => {}); throw e; }
  }

  // 一批事件入库：已见的 O(1) 跳过，每个有新消息的会话只落盘一次；落盘失败的会话整批回滚。
  async function add(events, peer) {
    const results = [], touched = new Map();
    for (const event of events) {
      const state = await load(event.conv), key = `${event.author}\n${event.id}`;
      if (state.seen.has(key)) { results.push({ inserted: false, localSeq: state.seen.get(key) }); continue; }
      const message = { author: event.author, id: event.id, sentAt: event.sentAt, localSeq: state.messages.length + 1, text: event.text,
        ...(event.parts ? { parts: event.parts } : {}), ...(event.about ? { about: event.about } : {}) };
      if (!touched.has(event.conv)) touched.set(event.conv, { state, count: state.messages.length, peer: state.peer });
      state.messages.push(message);
      state.seen.set(key, message.localSeq);
      if (peer !== undefined) state.peer = peer;
      results.push({ inserted: true, localSeq: message.localSeq });
    }
    for (const [conv, { state, count, peer: before }] of touched) {
      try { await save(conv, state); } catch (e) {
        for (const message of state.messages.splice(count)) state.seen.delete(`${message.author}\n${message.id}`);
        state.peer = before;
        throw e;
      }
    }
    return results;
  }

  return {
    /** 入库 parseEventRecord 解出的 `ok` 事件：`{ inserted, localSeq }`，重复的不改已有序号；`peer` 记进会话元数据。 */
    ingest: (event, peer) => serial(async () => (await add([event], peer))[0]),

    /** 同一对端的一批事件入库：各自的 `{ inserted, localSeq }`。 */
    ingestAll: (events, peer) => serial(() => add(events, peer)),

    /** 本身份存过的会话：`[{ conv, peer, head }]`。 */
    conversations: () => serial(async () => {
      const found = [];
      for (const name of await files(root)) {
        const saved = JSON.parse(await readFile(join(root, name), 'utf8'));
        const state = loaded.get(saved.conv) ?? remember(saved.conv, saved);
        if (state.messages.length) found.push({ conv: saved.conv, peer: state.peer, head: String(state.messages.length) });
      }
      return found;
    }),

    /** `author` 的事件 `eventId` 是否已在会话 `conv` 里入库；`eventId` 不是字符串为 false。 */
    hasEvent: (conv, author, eventId) => serial(async () => typeof eventId === 'string' && (await load(conv)).seen.has(`${author}\n${eventId}`)),

    /** 会话最新的游标（最大 localSeq 的十进制串），还没有消息为 null。 */
    head: conv => serial(async () => {
      const { messages } = await load(conv);
      return messages.length ? String(messages.length) : null;
    }),

    /** coda/session@1 的 read：`{ messages, cursor, more }`，消息总按 localSeq 升序。 */
    readMessages: (conv, { after, before, limit = 50 } = {}) => serial(async () => {
      if (!isConversationId(conv)) throw invalidInput('会话 ID 不合法');
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalidInput('limit 须为 1 到 100 的整数');
      if (after !== undefined && before !== undefined) throw invalidInput('after 与 before 不能同时带');
      const afterSeq = after === undefined ? undefined : cursorOf('after', after);
      const beforeSeq = before === undefined ? undefined : cursorOf('before', before);
      const { messages } = await load(conv), count = messages.length;
      // localSeq 从 1 连续递增、不删除，所以 localSeq 为 n 的消息就是 messages[n - 1]。
      // 超出字节预算时：after 页裁掉较新的，最新页与 before 页裁掉较旧的，都置 more。
      if (afterSeq !== undefined) {
        const views = messages.slice(afterSeq, afterSeq + limit).map(view), page = views.slice(0, fitting(views, false));
        return { messages: page, cursor: page.length ? page.at(-1).cursor : null, more: page.length < views.length || afterSeq + limit < count };
      }
      const end = beforeSeq === undefined ? count : Math.min(beforeSeq - 1, count), start = Math.max(0, end - limit);
      const views = messages.slice(start, end).map(view), page = views.slice(views.length - fitting(views, true));
      return { messages: page, cursor: page.length ? page.at(-1).cursor : null, more: start > 0 || page.length < views.length };
    }),
  };
}
