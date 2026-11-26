// 本机对话投影：按本机个人身份分目录，每个会话一个 JSON 文件（临时文件 + rename 原子替换，目录 0700、文件 0600）。
// 三个量严格分开：eventId 只管消息身份（按作者 + eventId 幂等去重）；sentAt 是发送方时间，只显示；
// localSeq 是会话内本机入库的严格递增序号（从 1 起），离线补进来的旧消息也拿新的更大序号，所以 head 一定前进。
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { invalidInput } from './envelope.mjs';
import { isAuthor, isConversationId } from './identity.mjs';

const CURSOR = /^[1-9]\d{0,15}$/;
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

/** 本机 selfRoot 在 stateDir 下的会话投影。所有操作按调用顺序串行。 */
export function createStore(stateDir, selfRoot) {
  if (!isAuthor(selfRoot)) throw new TypeError('selfRoot 不是合法的 Accord 公钥');
  const root = join(stateDir, 'roots', digest(selfRoot));
  const loaded = new Map();
  let tail = Promise.resolve(), counter = 0;
  const serial = run => { const result = tail.then(run); tail = result.catch(() => {}); return result; };

  async function load(conv) {
    if (loaded.has(conv)) return loaded.get(conv);
    let saved = null;
    try { saved = JSON.parse(await readFile(join(root, `${digest(conv)}.json`), 'utf8')); } catch (e) { if (e?.code !== 'ENOENT') throw e; }
    const messages = saved?.messages ?? [];
    const state = { messages, seen: new Map(messages.map(m => [`${m.author}\n${m.id}`, m.localSeq])) };
    loaded.set(conv, state);
    return state;
  }

  async function save(conv, state) {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const target = join(root, `${digest(conv)}.json`), temporary = `${target}.${process.pid}.${++counter}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify({ v: 1, conv, messages: state.messages })}\n`, { mode: 0o600 });
      await rename(temporary, target);
    } catch (e) { await rm(temporary, { force: true }).catch(() => {}); throw e; }
  }

  return {
    /** 入库 parseEventRecord 解出的 `ok` 事件：`{ inserted, localSeq }`，重复的不改已有序号。 */
    ingest: event => serial(async () => {
      const state = await load(event.conv), key = `${event.author}\n${event.id}`;
      if (state.seen.has(key)) return { inserted: false, localSeq: state.seen.get(key) };
      const message = { author: event.author, id: event.id, sentAt: event.sentAt, localSeq: state.messages.length + 1, text: event.text,
        ...(event.parts ? { parts: event.parts } : {}), ...(event.about ? { about: event.about } : {}) };
      state.messages.push(message);
      try { await save(event.conv, state); } catch (e) { state.messages.pop(); throw e; }
      state.seen.set(key, message.localSeq);
      return { inserted: true, localSeq: message.localSeq };
    }),

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
      if (afterSeq !== undefined) {
        const page = messages.slice(afterSeq, afterSeq + limit);
        return { messages: page.map(view), cursor: page.length ? String(page.at(-1).localSeq) : after, more: afterSeq + limit < count };
      }
      const end = beforeSeq === undefined ? count : Math.min(beforeSeq - 1, count), start = Math.max(0, end - limit);
      const page = messages.slice(start, end);
      return { messages: page.map(view), cursor: page.length ? String(page.at(-1).localSeq) : null, more: start > 0 };
    }),
  };
}
