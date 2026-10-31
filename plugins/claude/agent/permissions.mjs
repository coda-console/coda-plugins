// A tool Claude asks to use, as an ACP permission request: allow once, each rule Claude suggests to stop asking (its whole
// sentence the option's name, the rule kept here), and deny. Why it asks is the tool call's content. Only an option offered
// can change Claude's permissions.
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { toolCallFields } from './tools.mjs';

const deny = { behavior: 'deny', message: '用户未批准此操作' };

export function permissionRequest({ sessionId, toolName, input, context = {} }) {
  // Identical suggestions would be two options that do the same thing.
  const suggestions = [...new Map((context.suggestions ?? []).map(change => [JSON.stringify(change), change])).values()];
  const options = [{ optionId: 'allow-once', name: '仅允许本次', kind: 'allow_once' },
    ...suggestions.map((change, i) => ({ optionId: `suggestion-${i}`, name: describeChange(change, input), kind: 'allow_always' })),
    { optionId: 'deny', name: '拒绝', kind: 'reject_once' }];
  const params = { sessionId, options, toolCall: { toolCallId: context.toolUseID ?? randomUUID(), status: 'pending',
    ...toolCallFields(toolName, input, context.decisionReason ? [{ type: 'content', content: { type: 'text', text: context.decisionReason } }] : []) } };
  const answer = response => {
    const { outcome, optionId } = response?.outcome ?? {};
    if (outcome !== 'selected') return deny;
    if (optionId === 'allow-once') return { behavior: 'allow', updatedInput: input };
    const change = suggestions[/^suggestion-(\d+)$/.exec(optionId ?? '')?.[1]];
    return change ? { behavior: 'allow', updatedInput: input, updatedPermissions: [change] } : deny;
  };
  return { params, answer };
}

// Two suggestions for the same tool are different grants; the name says what each allows, and where it is kept.
const scopes = { session: '本会话', cliArg: '本进程', localSettings: '本项目 · 本机', projectSettings: '本项目 · 共享', userSettings: '所有项目' };
const verbs = { allow: '允许', deny: '拒绝', ask: '每次询问' };
const modes = { default: '默认', acceptEdits: '自动允许修改文件', bypassPermissions: '跳过所有审批', plan: '计划', dontAsk: '不询问' };
const readTools = new Set(['Read', 'Glob', 'Grep']), editTools = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const shortPath = path => { const home = homedir(); return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path; };

function describeRule({ toolName, ruleContent }, input, verb) {
  if (ruleContent === undefined) return [`${verb}所有 ${toolName} 操作`];
  if (toolName === 'Bash') {
    if (ruleContent === input?.command) return [`${verb}这条完全相同的命令`];
    if (ruleContent.endsWith(':*')) return [`${verb}以此开头的命令`, ruleContent.slice(0, -2)];
    return [`${verb}命令`, ruleContent];
  }
  // Claude writes absolute paths in rules as `//abs/path`.
  const path = shortPath(ruleContent.replace(/^\/\//, '/'));
  if (readTools.has(toolName)) return [`${verb}读取`, path];
  if (editTools.has(toolName)) return [`${verb}修改`, path];
  if (toolName === 'WebFetch' && ruleContent.startsWith('domain:')) return [`${verb}访问`, ruleContent.slice(7)];
  return [`${verb} ${toolName}`, ruleContent];
}

export function describeChange(change, input) {
  const scope = scopes[change.destination] ?? change.destination ?? 'Agent 建议的范围', verb = verbs[change.behavior] ?? '允许';
  const rules = change.rules ?? [], listed = rules.map(r => `${r.toolName}(${r.ruleContent ?? ''})`).join('、');
  const directories = (change.directories ?? []).map(shortPath).join('、');
  const [what, target] = (() => {
    switch (change.type) {
      case 'addRules': case 'replaceRules': {
        const [added, target] = rules.length === 1 ? describeRule(rules[0], input, verb) : [`${verb} ${rules.length} 条规则`, listed];
        // Replacing drops the scope's existing rules of this behavior.
        return [change.type === 'replaceRules' ? `替换现有规则为：${added}` : added, target];
      }
      case 'removeRules': return [`移除${verb}规则`, listed];
      case 'addDirectories': return ['允许访问目录', directories];
      case 'removeDirectories': return ['移除目录', directories];
      case 'setMode': return [`切换为「${modes[change.mode] ?? change.mode}」模式`];
      default: return ['应用 Agent 建议的权限调整'];
    }
  })();
  return `${what}${target ? ` ${target}` : ''}（${scope}）`;
}
