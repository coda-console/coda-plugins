// 模式只补充发出的一条；参数、预设、发送计数和去向执行由 Coda 维护。
import { OFF, STILL_ON, on } from './ultra.mjs';

export function activate(coda) {
  const register = (id, handler) => coda.protocols.register('submissions', id, ({ spec }) => {
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
  register('ultra', (spec, { values, sent, changedSinceSent }) => {
    // 本插件的交接、子会话或默认新任务会创建会话，第一条必须带完整规则。
    const createsThread = spec.defaultTarget.kind === 'thread' || spec.modes.some(({ mode }) =>
      mode === 'composer/handoff' || mode === 'composer/subagent');
    if (createsThread || sent === 0 || changedSinceSent) return { tell: [on(values.subagents ?? [])] };
    return sent % 10 === 0 ? { tell: [STILL_ON] } : null;
  });
  register('loop', ({ thread }, { values }) => ({
    divert: true,
    targets: [{ kind: 'loop', thread, every: values.every }],
  }));

  const previous = new Map();
  return coda.watch('composers', async ({ type, id, object }) => {
    const before = previous.get(id);
    // 删除输入框只释放记忆；关闭说明针对仍存在的会话输入框退出 Ultra。
    if (type === 'DELETED') { previous.delete(id); return; }
    const active = object.spec.modes.some(mode => mode.mode === 'composer/ultra');
    if (active) previous.set(id, object); else previous.delete(id);
    if (before && !active && before.spec.thread &&
        before.status.modes.some(mode => mode.mode === 'composer/ultra' && mode.sent > 0)) {
      await coda.tell(before.spec.thread, OFF);
    }
  });
}
