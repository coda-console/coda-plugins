// 模式只补充发出的一条；参数、预设、发送计数和去向执行由 Coda 维护。
import { OFF, on } from './ultra.mjs';

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
  // 只放内存。每个开着 Ultra 的会话输入框一份：list 是名单，sent 是 Ultra 已收下的条数（关闭时判断发不发 OFF），
  // compactions 是 Coda 记的压缩次数，told 是这个会话收到过说明，needFull 是下次要给完整说明（首次、改名单）。
  const states = new Map(), running = new Set();
  const listOf = values => values.subagents ?? [];
  // 首次、改名单的完整说明只在两个时点给：用户在已有会话里发消息（这里），以及一轮结束（下面的 threads）；输入框的这两类变化只记状态。压缩后的立即给，见下面的输入框 watch。
  // 新会话还没有上一轮，第一条由这里带完整说明。
  register('ultra', (spec, { values }) => {
    const createsThread = spec.defaultTarget.kind === 'thread' || spec.modes.some(({ mode }) =>
      mode === 'composer/handoff' || mode === 'composer/subagent');
    if (createsThread) return { tell: [on(listOf(values))] };
    const state = states.get(spec.thread);
    if (!state?.needFull) return null;
    state.needFull = false;
    state.told = true;
    return { tell: [on(listOf(values))] };
  });
  register('loop', ({ thread }, { values }) => ({
    divert: true,
    targets: [{ kind: 'loop', thread, every: values.every }],
  }));

  // 给完整说明：tell 成功后才清待给标记、记已发；被拒绝（如超长）时标记保留，留给下一个时点补发。
  // 发送期间名单又改了（key 变了），新名单还没给，标记保留。
  const give = async (thread, state) => {
    const { key } = state;
    state.needFull = true;
    await coda.tell(thread, on(state.list));
    if (state.key === key) state.needFull = false;
    state.told = true;
  };
  // 先看会话的轮，一轮结束时只有要给完整说明的才 tell，其余不发。
  const threads = await coda.watch('threads', async ({ type, id, object }) => {
    const was = running.has(id);
    if (type === 'DELETED' || object.turn == null) running.delete(id); else running.add(id);
    const state = states.get(id);
    if (!was || running.has(id) || !state) return;
    if (state.needFull) await give(id, state);
  });
  // watch 返回前收到的 ADDED 是重放（插件重启）。
  let replayed = false;
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
    const sent = object.status.modes.find(mode => mode.mode === 'composer/ultra')?.sent ?? 0, list = listOf(mode.values);
    const compactions = object.status.compactions ?? 0;
    if (!state) {
      // 带着 Ultra 新建的会话，输入框与第一条同时写成 sent=1，第一条已带完整说明；刚进入 Ultra 时 sent=0。
      const carried = replayed && sent > 0;
      states.set(id, { list, key: JSON.stringify(list), sent, compactions, told: carried, needFull: !carried });
      return;
    }
    const key = JSON.stringify(list);
    if (key !== state.key) state.needFull = true;
    const compacted = compactions > state.compactions;
    Object.assign(state, { list, key, sent, compactions });
    if (!compacted) return;
    // 压缩后说明丢了：不等一轮结束或下一条消息，立即给。
    await give(thread, state);
  });
  replayed = true;
  return { dispose() { composers.dispose(); threads.dispose(); } };
}
