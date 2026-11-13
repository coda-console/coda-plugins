// 模式只补充发出的一条；参数、预设、发送计数和去向执行由 Coda 维护。
import { OFF, on, reminder } from './ultra.mjs';

export async function activate(coda) {
  const register = (id, handler) => coda.protocols.register('coda/submission@1', id, ({ spec }) => {
    const mode = spec.modes.find(mode => mode.mode === `composer/${id}`);
    return mode ? handler(spec, mode) : null;
  });
  // 空 Agent 不写进目标，由会话办事员沿用 spec.agent（含 settings）。
  const agent = values => values.agent == null ? {} : { agent: values.agent };
  register('handoff', ({ thread }, { values }) => ({
    divert: true,
    targets: [{ kind: 'thread', handoffSource: thread, ...agent(values), open: true }],
  }));
  register('subagent', ({ thread }, { values }) => ({
    divert: true,
    targets: [{ kind: 'thread', handoffSource: thread, parentThreadId: thread,
      replyTo: values.replyTo, ...agent(values), open: true }],
  }));
  register('shell', ({ thread }) => ({
    divert: true,
    targets: [thread ? { kind: 'message', thread, run: true } : { kind: 'thread', run: true, open: true }],
  }));
  // 新会话还没有上一轮，第一条由这里带完整说明；已有会话的提醒全部由下面的 watch 给，用户发消息的那一轮不会有两份。
  const created = [];
  const listOf = values => values.subagents ?? [];
  register('ultra', (spec, { values }) => {
    const createsThread = spec.defaultTarget.kind === 'thread' || spec.modes.some(({ mode }) =>
      mode === 'composer/handoff' || mode === 'composer/subagent');
    if (!createsThread) return null;
    while (created.length && Date.now() - created[0].at >= 60_000) created.shift();
    created.push({ key: JSON.stringify(listOf(values)), at: Date.now() });
    return { tell: [on(listOf(values))] };
  });
  register('loop', ({ thread }, { values }) => ({
    divert: true,
    targets: [{ kind: 'loop', thread, every: values.every }],
  }));

  // 只放内存。每个开着 Ultra 的会话输入框一份：list 是名单，sent 是 Ultra 已收下的条数，
  // told 是这个会话收到过说明，full 是下一次要给完整说明（首次、改名单、压缩）。
  const states = new Map(), running = new Set();
  // 给下一轮读的提醒：要完整说明的给完整说明，其余给短提醒。
  const remind = async (id, state) => {
    const text = state.full ? on(state.list) : reminder(state.list);
    state.full = false;
    state.told = true;
    await coda.tell(id, text);
  };
  // 先看会话的轮，启动时才知道哪些会话正在跑。
  const threads = await coda.watch('threads', async ({ type, id, object }) => {
    const was = running.has(id);
    if (type === 'DELETED' || object.turn == null) running.delete(id); else running.add(id);
    const state = states.get(id);
    if (was && !running.has(id) && state) await remind(id, state);
  });
  const composers = await coda.watch('coda/composer@1', async ({ type, id, object }) => {
    if (type === 'DELETED') { states.delete(id); return; }
    const thread = object.spec.thread;
    if (!thread) return; // 新任务输入框不提醒，它创建的会话各自处理。
    const mode = object.spec.modes.find(mode => mode.mode === 'composer/ultra');
    const state = states.get(id);
    if (!mode) {
      states.delete(id);
      // 重启后不知道说明是否送出过，按 Ultra 发过判断。
      if (state && (state.told || state.sent > 0)) await coda.tell(thread, OFF);
      return;
    }
    const sent = object.status.modes.find(mode => mode.mode === 'composer/ultra')?.sent ?? 0, list = listOf(mode.values), key = JSON.stringify(list);
    if (!state) {
      const now = Date.now(), index = created.findIndex(entry => entry.key === key && now - entry.at < 60_000);
      if (index >= 0) created.splice(0, index + 1); // 新会话的第一条已带完整说明。
      const next = { list, key, sent, told: index >= 0, full: index < 0 };
      states.set(id, next);
      if (next.full && !running.has(thread)) await remind(thread, next);
      return;
    }
    const compacted = state.sent > 0 && sent === 0;
    state.sent = sent;
    state.list = list;
    if (compacted || key !== state.key) state.full = true;
    state.key = key;
    if (state.full && !running.has(thread)) await remind(thread, state);
  });
  return { dispose() { composers.dispose(); threads.dispose(); } };
}
