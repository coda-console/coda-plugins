// What the locked Claude Agent SDK sends, and what this entry does with each (README「认不出的东西」): every message type and
// subtype of its SDKMessage, and every content block type of an assistant's and a user's message, shown in Coda or not, with
// why. An SDK upgrade registers what it brings: the check over the SDK's declarations (test/plugins/claude/sdk-registry.mjs)
// fails while any is missing. What comes that is not here all the same, and a native tool not in known-tools.json, is told to
// Coda (`_coda/unrecognized`, docs/agent-protocol.md「没适配的东西」).
import { readFileSync } from 'node:fs';

const shown = why => ({ shown: true, why }), hidden = why => ({ shown: false, why });
const failed = shown('一轮失败结束：报执行失败与用量');
const tasks = shown('后台任务与子 Agent，报成等待项（waits.mjs）');
const hooks = hidden('钩子的运行过程与输出，是运行机配置的事，不是 Claude 说的话');
// Neither in SDKMessage nor kept back: the SDK passes these on as they come (its readMessages).
const internal = hidden('SDK 没有声明、却照样转来的内部消息，不是 Claude 说的话');

// By type, and subtype where the type has them (messageName).
export const MESSAGES = {
  assistant: shown('Claude 说的话、思考与工具调用，按内容块（ASSISTANT_BLOCKS）'),
  user: shown('工具的结果转成工具调用的结果，其余按内容块（USER_BLOCKS）'),
  stream_event: shown('文字与思考边生成边显示；其余内容块在完整的助手消息里处理'),
  'result/success': shown('一轮的结束：答复这一轮的 prompt，报用量'),
  'result/error_during_execution': failed,
  'result/error_max_turns': failed,
  'result/error_max_budget_usd': failed,
  'result/error_max_structured_output_retries': failed,
  rate_limit_event: shown('额度窗口写进资源「Claude」读的 limits.json，额度耗尽时随执行失败报'),
  'system/init': shown('每轮开始：设置项、可用命令与标题，并对照已知的原生工具'),
  'system/commands_changed': shown('可用命令'),
  'system/status': shown('审批模式的变化与压缩的进度'),
  'system/compact_boundary': shown('压缩完成，及压缩前后的上下文'),
  'system/local_command_output': shown('斜杠命令的输出，作为 Claude 的回复显示'),
  'system/session_state_changed': shown('会话空闲时了结等待项'),
  'system/task_started': tasks,
  'system/task_updated': tasks,
  'system/task_notification': tasks,
  'system/background_tasks_changed': tasks,
  'system/task_progress': hidden('后台任务的进度摘要；等待项只报开始与结束'),
  'system/api_retry': hidden('请求在重试，还没有结果；最后失败随这一轮的结果报'),
  'system/control_request_progress': hidden('只给 side_question 控制请求报进度，入口不发这种请求'),
  'system/model_refusal_fallback': hidden('拒答后换模型重试的提示；重试的回答照常显示'),
  'system/model_refusal_no_fallback': hidden('拒答的提示；拒答由这一轮的助手消息与结果报'),
  'system/hook_started': hooks,
  'system/hook_progress': hooks,
  'system/hook_response': hooks,
  'system/plugin_install': hidden('Claude Code 插件的安装进度'),
  'system/thinking_tokens': hidden('思考用量的估计，只给进度指示用；思考的文字另外转'),
  'system/worker_shutting_down': hidden('远程控制的 worker 停下的原因，入口不用远程控制'),
  'system/notification': hidden('Claude Code 终端里的通知，不是 Claude 说的话'),
  'system/files_persisted': hidden('文件存到云端的结果，入口不用这个功能'),
  'system/memory_recall': hidden('召回的记忆，已作为上下文交给模型'),
  'system/elicitation_complete': hidden('链接表单完成的确认；表单本身经 onElicitation 转给 Coda'),
  'system/permission_denied': hidden('被拒的工具调用；拒绝的原因在工具结果里，随工具调用显示'),
  'system/mirror_error': hidden('会话记录镜像（SessionStore）写入失败，入口不用镜像'),
  'system/informational': hidden('终端里的提示行（状态、钩子的反馈），不是 Claude 说的话'),
  tool_progress: hidden('工具运行中的心跳；工具调用本身照常显示'),
  auth_status: hidden('登录过程的输出，入口不在会话里登录'),
  tool_use_summary: hidden('几个工具调用的摘要；工具调用本身已逐个显示'),
  prompt_suggestion: hidden('猜用户下一句的建议，入口没有打开 promptSuggestions'),
  conversation_reset: hidden('/clear 之类开了新的对话；Coda 的会话记录照旧'),
  'system/post_turn_summary': internal,
  'system/task_summary': internal,
  'system/session_metadata': internal,
  active_goal: internal,
  autocompact_state: internal,
};

const results = hidden('服务端工具的结果，给模型读的');
const assistants = hidden('助手一方的内容块，不出现在用户消息里');
const upload = hidden('交给代码执行容器的文件');

export const ASSISTANT_BLOCKS = {
  text: shown('Claude 说的话'),
  thinking: shown('思考'),
  tool_use: shown('工具调用'),
  redacted_thinking: hidden('加密的思考，没有可读的文字'),
  server_tool_use: hidden('服务端自己执行的工具的调用；Claude Code 的工具走 tool_use'),
  web_search_tool_result: results,
  web_fetch_tool_result: results,
  advisor_tool_result: results,
  code_execution_tool_result: results,
  bash_code_execution_tool_result: results,
  text_editor_code_execution_tool_result: results,
  tool_search_tool_result: results,
  mcp_tool_use: hidden('API 的 MCP 连接器；Claude Code 的 MCP 工具走 tool_use'),
  mcp_tool_result: hidden('API 的 MCP 连接器的结果；Claude Code 的 MCP 工具走 tool_result'),
  container_upload: upload,
  compaction: hidden('服务端压缩出的摘要，给模型接着用；压缩由 status 与 compact_boundary 报'),
  fallback: hidden('拒答后换模型的标记，之后的内容照常显示'),
};

export const USER_BLOCKS = {
  tool_result: shown('工具调用的结果'),
  text: hidden('用户的输入（Coda 自己有），或 Claude Code 给模型补的说明；唤醒一轮的开场文字交给等待项认领'),
  image: hidden('给模型看的图片'),
  document: hidden('给模型读的文档'),
  search_result: hidden('给模型的检索结果'),
  container_upload: upload,
  thinking: assistants,
  redacted_thinking: assistants,
  tool_use: assistants,
  server_tool_use: assistants,
  web_search_tool_result: assistants,
  web_fetch_tool_result: assistants,
  code_execution_tool_result: assistants,
  bash_code_execution_tool_result: assistants,
  text_editor_code_execution_tool_result: assistants,
  tool_search_tool_result: assistants,
};

// The native tools known here: what the locked SDK's init lists as this entry starts it, and the names it knows otherwise
// (tools.mjs, older Claude Code). An MCP server's (`mcp__…`) are the user's, never compared.
export const KNOWN_TOOLS = new Set(JSON.parse(readFileSync(new URL('./known-tools.json', import.meta.url), 'utf8')));

// A message's name here: its type, and its subtype where it has one.
export const messageName = m => typeof m.subtype === 'string' ? `${m.type}/${m.subtype}` : m.type;

// What is told to Coda: once a name in the session (a process has one), and only when Coda takes it (its initialize's
// `_meta.coda.unrecognized`, `taken`).
export class Unrecognized {
  taken = false; told = new Set();
  // `tell`: the notification's params but its session.
  constructor(tell) { this.tell = tell; }
  report(kind, name, lost, detail) {
    name = name.slice(0, 200);
    if (!this.taken || this.told.has(name)) return;
    this.told.add(name);
    this.tell({ kind, name, lost, ...(detail ? { detail } : {}) });
  }
  // The native tools a turn's init lists that are not known here.
  tools(names) {
    for (const name of names) if (!name.startsWith('mcp__') && !KNOWN_TOOLS.has(name)) this.report('tool', `tool:${name}`, false);
  }
}
