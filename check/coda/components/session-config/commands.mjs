import { requireCondition as check } from '../../domain/errors.mjs';
import { AGENT_ID, keys, object, text } from '../../domain/values.mjs';

// What a session runs with: its model, effort and mode, and the agent's other config options by their ID (`options`: a
// choice's ID, or on and off for a switch), as the agent's catalog offers them (coda-protocol docs/agent-protocol.md「ACP 部分」).
// Absence means resolve the adapter default. Actual values belong to Turn.
export const OPTIONS_LIMIT = 20;
export function configOptions(value) {
  if (value === undefined) return undefined;
  object(value, '配置项');
  const entries = Object.entries(value);
  check(entries.length <= OPTIONS_LIMIT, 'invalid_input', `配置项至多 ${OPTIONS_LIMIT} 个`);
  for (const [id, option] of entries) {
    check(id.length > 0 && id.length <= 100 && !/[\0\n]/.test(id), 'invalid_input', '配置项的 ID 无效');
    check(typeof option === 'boolean' || (typeof option === 'string' && option.length > 0 && option.length <= 200 && !option.includes('\0')),
      'invalid_input', `配置项 ${id} 的值须为开关或选项 ID`);
  }
  return value;
}
export function settings(value = {}) {
  object(value, '模型设置');
  keys(value, ['model', 'effort', 'mode', 'options']);
  const options = configOptions(value.options);
  return { ...Object.fromEntries(['model', 'effort', 'mode'].filter(key => value[key] !== undefined).map(key => [key, text(value[key], key)])),
    ...(options ? { options } : {}) };
}

// Upload IDs as the client names them are the request's identity. What is on disk is read once, when the
// message is first accepted: an agent may since have changed or removed the file, and a replay must still match.
export function attachments(value = []) {
  check(Array.isArray(value) && value.length <= 20 && new Set(value).size === value.length, 'invalid_input', '附件列表无效');
  return value.map(id => text(id, '附件标识', 100));
}
// A message without files keeps the request identity it always had.
export const withAttachments = (value, ids) => ids.length ? { ...value, attachments: ids } : value;
// Passages the user picked from the conversation, kept apart from their own words. Together they stay
// within a message's length, which keeps a request under the 1 MiB body limit.
export function quotes(value = []) {
  check(Array.isArray(value) && value.length <= 20, 'invalid_input', '引用列表无效');
  const passages = value.map(passage => text(passage, '引用', 20_000));
  check(passages.reduce((sum, passage) => sum + passage.length, 0) <= 100_000, 'invalid_input', '引用合计超过 100000 字');
  return passages;
}

// The composer mode a message was sent in (docs/plugins.md「输入框模式」), as it was then: `<plugin>/<mode>`, its title and
// icon, which its bubble shows however the plugin changes later.
export function modeMark(value) {
  object(value, '输入框模式');
  keys(value, ['id', 'title', 'icon']);
  check(typeof value.id === 'string' && /^[a-z][a-z0-9-]{0,39}\/[a-z][a-z0-9-]{0,39}$/.test(value.id), 'invalid_input', '输入框模式须写成「插件/模式」');
  return { id: value.id, title: text(value.title, '模式名', 40), icon: text(value.icon, '模式图标', 100) };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function firstMessage(value) {
  object(value, '首次发送');
  keys(value, ['requestId', 'projectId', 'title', 'agent', 'checkout', 'settings', 'text', 'attachments', 'quotes', 'handoffSource', 'parentThreadId',
    'replyTo', 'threadId', 'extensionParent', 'mode', 'initiatedBy']);
  const initiatedBy = value.initiatedBy === undefined ? {} : (() => {
    const source = object(value.initiatedBy, '发起会话');
    keys(source, ['threadId', 'title']);
    check(UUID.test(source.threadId ?? ''), 'invalid_input', '发起会话标识须为 UUID');
    check(!value.parentThreadId && !value.extensionParent && !value.handoffSource, 'invalid_input', '发起的会话须为独立会话');
    return { initiatedBy: { threadId: source.threadId, title: text(source.title, '发起会话标题') } };
  })();
  const handoff = value.handoffSource === undefined ? {} : { handoffSource: text(value.handoffSource, '交接来源', 100) };
  const parent = value.parentThreadId === undefined ? {} : { parentThreadId: text(value.parentThreadId, '父会话', 100) };
  check(!parent.parentThreadId || handoff.handoffSource === parent.parentThreadId, 'invalid_input', '子会话必须引用父会话上下文');
  // Whom a child the user starts answers (#1904「回复权」): its parent, as a call of the parent's would (`parent`, the
  // default), or the user who started it (`sender`): under its parent all the same, which is where it belongs, not whom it
  // answers. Only the one that is not the default is kept, so that a request saying the default is the same request.
  check(value.replyTo === undefined || parent.parentThreadId && ['parent', 'sender'].includes(value.replyTo), 'invalid_input', '子会话的回报对象无效');
  const reply = value.replyTo === 'sender' ? { replyTo: 'sender' } : {};
  // Which agents may run is the store's to say (its plugin installed); here only that it names one.
  check(typeof value.agent === 'string' && AGENT_ID.test(value.agent), 'invalid_input', 'Agent 不可用');
  // A session an extension starts for a parent session this kernel does not keep (docs/subagent-design.md「扩展作为调用方」):
  // the extension names it, so that a retry finds it and the parent knows it before the answer comes, and says who calls
  // it — `caller`, which every later call of that parent's must name again, `threadId` and `title` of the parent, and
  // `location`, where the parent is, in words — all as the extension knows them. Only an extension may say so
  // (transport/http.mjs); the child works in a worktree of its own, and is nobody's child here.
  const outside = value.extensionParent === undefined ? {} : (() => {
    const p = object(value.extensionParent, '父会话');
    keys(p, ['caller', 'threadId', 'title', 'location']);
    check(UUID.test(value.threadId ?? ''), 'invalid_input', '扩展发起的子会话须带会话标识（UUID）');
    check(value.parentThreadId === undefined && value.handoffSource === undefined && value.checkout?.kind === 'worktree', 'invalid_input',
      '扩展发起的子会话只在新工作树里开始');
    return { threadId: value.threadId, extensionParent: { caller: text(p.caller, '调用方', 200), threadId: text(p.threadId, '父会话', 100),
      title: typeof p.title === 'string' ? p.title.slice(0, 200) : '', ...(typeof p.location === 'string' && p.location ? { location: p.location.slice(0, 200) } : {}) } };
  })();
  check(value.threadId === undefined || value.extensionParent !== undefined || value.initiatedBy !== undefined,
    'invalid_input', '只有 Agent 发起的会话可以指定会话标识');
  if (value.threadId !== undefined) check(UUID.test(value.threadId), 'invalid_input', '会话标识须为 UUID');
  const checkout = object(value.checkout, '工作位置');
  keys(checkout, ['kind', 'baseRef']);
  check(['original', 'worktree', 'handoff'].includes(checkout.kind), 'invalid_input', '工作位置无效');
  if (checkout.kind !== 'worktree') {
    check(checkout.baseRef === undefined, 'invalid_input', '此工作位置不接受起点分支');
    check(checkout.kind !== 'handoff' || handoff.handoffSource, 'invalid_input', '沿用工作目录需要交接来源');
  } else {
    text(checkout.baseRef, '起点分支', 500);
    check(!checkout.baseRef.startsWith('-') && !/[\r\n]/.test(checkout.baseRef), 'invalid_input', '起点分支无效');
  }
  const message = text(value.text, '消息', 100_000), passages = quotes(value.quotes);
  return withAttachments({
    ...handoff,
    ...initiatedBy,
    ...parent,
    ...reply,
    ...outside,
    ...(value.threadId === undefined ? {} : { threadId: value.threadId }),
    requestId: text(value.requestId, '请求标识', 100),
    projectId: text(value.projectId, '目录标识', 100),
    title: text(value.title ?? message.trim().slice(0, 80), '会话标题'),
    agent: value.agent,
    checkout: checkout.kind === 'worktree' ? { kind: 'worktree', baseRef: checkout.baseRef } : { kind: checkout.kind },
    settings: settings(value.settings),
    text: message,
    ...(passages.length ? { quotes: passages } : {}),
    ...(value.mode === undefined ? {} : { mode: modeMark(value.mode) }),
  }, attachments(value.attachments));
}

// Agent tool calls. The calling agent may ask for the child's approval mode (as an agent reference gives it) but never one
// more unattended than its parent's hands on (see `delegateMode`), so a manually approved session cannot start an
// unattended one. `turn` is a ticket checked inside the commit transaction and
// is not part of request equality: a replay may arrive after the turn has ended.
export function childSpawn(value) {
  object(value, 'spawn');
  keys(value, ['turn', 'requestId', 'agent', 'prompt', 'title', 'model', 'effort', 'mode', 'options', 'checkout', 'project']);
  check([undefined, 'shared', 'worktree'].includes(value.checkout), 'invalid_input', 'checkout 必须是 shared 或 worktree');
  check(typeof value.agent === 'string' && AGENT_ID.test(value.agent), 'invalid_input', 'agent 须为 Agent 的 ID（agents 工具列出的），或用户给的 Agent 引用 coda://agents/…');
  const prompt = text(value.prompt, 'prompt', 100_000);
  return { turn: text(value.turn, 'turn', 100), requestId: text(value.requestId, 'requestId', 100), agent: value.agent, prompt,
    title: text(value.title ?? prompt.trim().slice(0, 80), 'title'), checkout: value.checkout ?? 'shared',
    ...(value.project === undefined ? {} : { project: text(value.project, 'project', 200) }),
    settings: settings(Object.fromEntries(['model', 'effort', 'mode', 'options'].filter(k => value[k] !== undefined).map(k => [k, value[k]]))) };
}

// A remote client asks the user to open a root session: in the project's own directory (`checkout` shared, the default) or
// in a new worktree of its default branch (`worktree`). No parent is supplied by the agent.
export function newSession(value) {
  object(value, 'new_session');
  keys(value, ['turn', 'requestId', 'project', 'agent', 'prompt', 'title', 'model', 'effort', 'mode', 'options', 'checkout']);
  text(value.project, 'project', 200);
  return childSpawn(value);
}
