# Grok Bot

把 xAI 云端 Grok Bot 的**原生主会话**接到 Coda。Coda 消息原样发送；回复、运行状态、活动摘要和选择卡片自动镜像，不需要 Bot 调用专门的汇报工具。定时任务仍由 Grok Routine 执行。与 Grok CLI 插件 `grok` 无关，本插件与 Agent ID 均为 `grok-bot`。

## 安装与登录

1. 在 Coda 安装 Grok Bot，在空目录（例如 Bot）新建 Grok Bot 会话。
2. 发送 `/login`，打开会话中的官方登录链接完成账号登录。手机可能停在 **Completing sign-in**，请再点 **Continue**。适配器会轮询并更新 Bot 列表。
3. 在「这是哪个 Bot」按名称或 ID 选择。一个 Bot 对应一个 Coda 会话，避免重复镜像。
4. 正常发送消息。Grok 客户端里的主会话消息，以及 Routine 结束后主 Agent 自然发送的结论，都会作为 Coda 自主轮次呈现。

凭据保存在 `CODA_PLUGIN_STATE/native-auth.json`，权限 0600；不读取桌面客户端凭据库。收到认证拒绝时，用本插件登录所得的 refreshToken 尝试官方 OAuth 续期并保存轮换凭据；没有 refreshToken 或续期失败时提示 `/login` 重新登录。续期仅用假服务端测试，尚未实测真实 token 到期。配置项探测不会自动登录，也不为未选择 Bot 的会话留下状态文件。

Coda 的 `systemPrompt` 接受格式校验，但不发送给 Grok、不保存，也不拼进用户消息。Bot 的设定和 Skill 留在 Grok，避免改变原生会话的设定与截断用户正文；Coda 工具的授权由后端实施。

## 设置与运行记录

| 设置 | 含义 |
| --- | --- |
| `grok-bot.telemetry` | 可选看板基地址，只能读取其 `/api/` 路径 |
| `grok-bot.turnTimeout` | 默认 `PT30M`，Coda 等待一轮的上限；超时不自动重发，云端未必停止 |

巡检日程与内容在 Grok Routine 中配置，Coda 不创建巡检计时器。收到 subagents/automations 变化通知或 `hasRunningSubagents` 时刷新运行记录；活动期间每 5 秒核对，空闲时不持续轮询。首次连接只建立已结束记录的基线，重连补齐新记录。

每个 Routine run 显示一条活动，例如「定时任务「Coda 巡检」运行中 → 成功（72 秒）」；失败或记录丢失会明确说明。run ID 对应 executor ID `sand-subagent-<runId>`。executor 内部正文、命令与输出不追踪。主会话结论的 requestId 与 automation run 的 requestId 不同，没有验证到直接关联字段，所以不把并发结论猜测归属到某条 run。

主会话订阅用 `_coda/wait` 保持活动；自主运行用 handling/waiting 切换轮次。Coda 的未结束等待项会阻止 Agent 空闲回收；退出、断网或归档时不镜像，重新加载后按游标补齐。Grok 的 Routine 执行不依赖 Coda 在线。

## Coda 数据与授权工具（可选）

发送 `/bind`，按返回说明让 Bot 下载 `remote/coda-bot.mjs` 和 `remote/SKILL.md` 到 `/workspace/.coda-bot/`，执行 `net`、`bind <address> <code>`。绑定需要 [Coda 远端 Agent 入口](https://github.com/coda-console/coda/pull/2006)。

在 Grok Bot 设置添加自定义 stdio MCP：

```sh
node /workspace/.coda-bot/coda-bot.mjs mcp <Coda-sessionId>
```

`net` 将 Tailscale 状态放在 `/workspace/.coda-bot/tailscale/`；缺软件时安装，恢复守护进程，必要时显示登录链接。多个 Bot 共用云电脑，MCP 命令必须指定各自的 Coda sessionId。`bind` 只确认工具绑定，不再向 Bot 交付 Coda systemPrompt。

工具包括 `read_thread`、`read_tool_call`、`agents`、`status`、`workflow_status`、`workflow_list`、`telemetry`、`machines`、`machine_diagnostics`、`new_session`、`send`（MCP 名加 `coda_` 前缀）。Coda 工具调用保留完整输入输出；轮外只读调用仅写日志，不开启空轮次。`new_session` 在目标目录开独立会话，`send` 给已有会话发消息，均由 Coda 授权卡片批准；稳定 requestId、turn 票据和后台 send 结果由适配器处理。

诊断工具需在 Coda 安装并为目录启用内置「机器诊断」插件（`diagnostics` MCP），参见 [诊断工具](https://github.com/coda-console/coda/pull/2003)；遥测端点参见 [遥测 JSON 接口](https://github.com/coda-console/coda/pull/2004)。没有 new_session 的旧 Coda 会如实报不可用。

## 从 0.1.7 升级

1. 删除不再需要的「Coda 消息」Webhook Routine（`coda`）。
2. **保留「Coda 巡检」定时 Routine（`coda-2`）**。先由用户确认，再通过原生消息让 Bot 自己把 Routine 指令中的 `coda_input`、`coda_say`、`coda_done` 改成「有发现就在对话里告诉用户」。
3. 升级插件、完成原生登录并重新选择 Bot。在云电脑重新下载 `coda-bot.mjs`、`SKILL.md`，重启 MCP；按 `/bind` 说明核对工具绑定。

旧 Webhook bots 表不再使用；`coda_input`、`coda_say`、`coda_done` 及适配器对应远端方法已移除。本次代码更新不会自行修改线上 Routine。

## 协议与验证边界

使用 Grok Bot **0.78.1** 的私有 Connect 协议（`api2.cursor.sh`），请求带客户端版本头，协议客户端独立在 `agent/native.mjs`，以后可替换正式接口。只读参考社区 [grok-bot-sdk 协议说明](https://github.com/RongleCat/grok-bot-sdk/blob/main/docs/api/protocol.md)（MIT），未复制其实现或厂商代码。

这是未获稳定性保证的私有接口，上游升级可能使登录、字段或接口失效；错误会显示在会话中。[Cursor 服务条款 §1.5](https://cursor.com/terms-of-service) 限制逆向工程等行为（法律不允许此限制的情况除外），使用前需评估该条款风险。

- SetStatus 只提供名称/说明，映射为 tool_call 标题和状态，不伪造云端工具输入输出。thinking 只显示“正在思考”，不是思考正文。
- 按 requestId/turnId 归并，结束后的心跳读取历史核对，匹配正文与结束状态都到达才结束 ACP 轮次。没有正文会继续等待到 turnTimeout；上游没有“最后正文已落盘”标志，极迟消息仍作为补充显示，不静默丢弃。
- entryId、updatedSeq 和正文摘要保存在游标状态中；断线按游标重连，游标失效分页读历史补齐并去重，不重发用户消息。首次选择只建立历史基线，不灌入旧聊天。正文被服务端省略或消息类型不支持时明确提示去 Grok 客户端查看。
- Stop 调 InterruptGrokBotAgentRun。widget 选项变成 Coda 卡片，选择后交回 RespondGrokBotWidget；未选择则不代答。auto-review 尚未实测，收到 awaiting 时提示去 Grok 客户端处理，并记事件日志。

实机已验证官方登录、Bot 列表、原生发送/状态/活动/回复、Interrupt、widget 选择交回、Routine run 与 executor ID 的关联，以及无需任何 Coda 汇报工具也会出现的主会话结论（结束状态比正文早 121 ms）。完整新适配器尚未真机部署；自动续期、auto-review、executor 内部过程未实测。适配器测试使用假原生服务端与假时钟。
