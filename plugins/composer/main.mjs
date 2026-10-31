// 输入框模式：交接和子会话沿用 Coda 内置实现，Ultra 的模板与提示逻辑来自原 Ultra 插件。
import { CUSTOM, OFF, STILL_ON, on, templateName, templateValue, templates, withTemplates } from './ultra.mjs';

export function activate(coda) {
  coda.composerModes.register('handoff', { send: () => ({ create: { handoff: true } }) });
  coda.composerModes.register('subagent', {
    enter({ session }) {
      if (session.parentThreadId) throw new Error('请从根会话创建子会话');
    },
    send: ({ values }) => ({ create: { handoff: true, parent: true, replyTo: values.replyTo ?? 'parent' } }),
  });
  // ! 的命令执行由 Coda 处理，回调不改写发送结果。
  coda.composerModes.register('shell', { send: () => ({}) });
  const read = async projectId => templates(JSON.parse((await coda.environment(projectId)).CODA_PLUGIN_SETTINGS ?? '{}')['composer.templates']);
  coda.composerModes.register('ultra', {
    // 参数沿用清单声明，模板选项从当前设置读取。
    async enter({ projectId, parameters }) {
      const all = await read(projectId), [first] = all.keys();
      return { parameters: withTemplates(parameters, [...all.keys()]),
        values: { template: first === undefined ? CUSTOM : templateValue(first), subagents: all.get(first) ?? [] } };
    },
    async change({ projectId, values, changed }) {
      if (changed !== 'template') return { values: { ...values, template: CUSTOM } };
      const name = templateName(values.template), rows = name === null ? undefined : (await read(projectId)).get(name);
      return { values: rows ? { ...values, subagents: rows } : values };
    },
    send({ values, sent, changedSinceSent }) {
      if (sent === 0 || changedSinceSent) return { tell: on(values.subagents ?? []) };
      return { tell: STILL_ON };
    },
    // 新任务里还未发送就退出时，没有会话，也不需要撤销提示。
    async exit({ session, sent }) {
      if (session && sent > 0) await coda.tell(session.id, OFF);
    },
  });
  coda.composerModes.register('loop', { send: ({ values }) => ({ loop: { every: values.every } }) });
}
