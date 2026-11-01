# Grok Bot

把 xAI 云端 Grok Bot 的**原生主会话**接到 Coda。Coda 消息原样发送；回复、运行状态、活动摘要和选择卡片自动镜像，不需要 Bot 调用专门的汇报工具。定时任务仍由 Grok Routine 执行。与 Grok CLI 插件 `grok` 无关，本插件与 Agent ID 均为 `grok-bot`。

Coda 中用 Grok Bot 的双眼圆脸机器人图标标识本插件，与 Grok CLI 的标志区分。图标随文字颜色适配浅深色，约每 5 秒眨眼一次；原生菜单和系统“减少动态效果”下保持睁眼。

## 安装与登录

此插件仍在内部调试，清单限定 `coda.channels: ["preview"]`，只供预览版 Coda 后端安装和更新。以目标后端的通道为准，不是 Mac / iPhone 客户端的版本；正式版后端会显示限制原因。该约束需要支持通道校验的 Coda 后端，公开 npm 包及未声明限制的旧版本仍可被直接下载。

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

巡检日程与内容在 Grok Routine 中配置，Coda 不创建巡检计时器。收到 subagents/automations 变化通知或 `hasRunningSubagents` 时刷新运行记录；活动期间每 5 秒核对，空闲时不持续轮询。首次连接只建立已结束记录的基线，重连补齐新记录。只保存最近 200 条已结束记录及仍运行的记录，已淘汰的旧历史不会反复显示。

每个 Routine run 显示一条活动，例如「定时任务「Coda 巡检」运行中 → 成功（72 秒）」；失败或记录丢失会明确说明。run ID 对应 executor ID `sand-subagent-<runId>`。executor 内部正文、命令与输出不追踪。主会话结论的 requestId 与 automation run 的 requestId 不同，没有验证到直接关联字段，所以不把并发结论猜测归属到某条 run。

订阅正常到期、游标重置后静默重连；暂时失败只写日志并退避。连续 3 次失败才在会话提示一次，认证失效立即提示，恢复后提示一次。Routine 刷新采用相同策略。

插件声明 `lifecycle: "external"`，主会话订阅和 Routine 用 `_coda/wait kind: "observation"` 保持观测，Coda 显示呼吸状态；自主运行用 handling/waiting 切换观测到的轮次。Coda 的未结束等待项会阻止 Agent 空闲回收；退出、断网或归档时不镜像，重新加载后按游标补齐。Grok 的 Routine 执行不依赖 Coda 在线。Coda 不根据这些轮次建立自动回复权，也不把巡检文字自动交给委派方。

其他会话通过 `send` 委派时，消息带原请求编号和回传地址。Bot 按任务约定调用 `coda_send`，用 `replyTo` 指定原请求编号并发送结果；`final` 默认 `true`，`false` 用于约定的进展或需要对方处理的问题。回传会唤醒原会话，不再建立反向等待。升级插件后需同步远端的 `coda-bot.mjs` 与本技能，让 Bot 的工具声明包含回传参数。

## Coda 数据与授权工具（可选）

发送 `/bind`，按返回说明让 Bot 下载 `remote/coda-bot.mjs` 和 `remote/SKILL.md` 到 `/workspace/.coda-bot/`，执行 `net`、`bind <address> <code>`。绑定需要 [Coda 远端 Agent 入口](https://github.com/coda-console/coda/pull/2006)。

在 Grok Bot 设置添加自定义 stdio MCP：

```sh
node /workspace/.coda-bot/coda-bot.mjs mcp <Coda-sessionId>
```

`net` 将 Tailscale 状态放在 `/workspace/.coda-bot/tailscale/`；缺软件时安装，恢复守护进程，必要时显示登录链接。多个 Bot 共用云电脑，MCP 命令必须指定各自的 Coda sessionId。`bind` 只确认工具绑定，不再向 Bot 交付 Coda systemPrompt。

工具包括 `read_thread`、`read_tool_call`、`agents`、`status`、`workflow_status`、`workflow_list`、`telemetry`、`machines`、`machine_diagnostics`、`new_session`、`send`（MCP 名加 `coda_` 前缀）。Coda 工具调用保留完整输入输出；轮外只读调用仅写日志，不开启空轮次。`new_session` 在目标目录开独立会话（`agent` 可原样填用户给的 Agent 链接 `coda://agents/…`，由 Coda 解析出 Agent、机器与参数，需要支持链接的 Coda 后端），`send` 给已有会话发消息，均由 Coda 授权卡片批准；稳定 requestId、turn 票据和后台 send 结果由适配器处理。

巡检按远端 Skill 先开只归因的独立会话（不改代码、不开 PR），prompt 写清现象、证据、时间和版本，要求结论、证据链、置信度与是否建议修复。下次巡检读取结论，确认需要修复的代码问题才开修复会话，引用归因会话与结论并走完仓库 PR 流程；偶发、外部因素或用户暂不处理的问题只记忆。用户指定的 Agent、暂不处理事项等也写进记忆，开会话前先读取遵守，不在 Skill 固定模型或推理强度。卡片审批、不重复开会话、不轮询等规则照旧；GitHub 只读限制只约束 Bot 自己。

诊断工具需在 Coda 安装并为目录启用内置「机器诊断」插件（`diagnostics` MCP），参见 [诊断工具](https://github.com/coda-console/coda/pull/2003)；遥测端点参见 [遥测 JSON 接口](https://github.com/coda-console/coda/pull/2004)。没有 new_session 的旧 Coda 会如实报不可用。

## 从 0.1.7 升级

1. 删除不再需要的「Coda 消息」Webhook Routine（`coda`）。
2. **保留「Coda 巡检」定时 Routine（`coda-2`）**。先由用户确认，再通过原生消息让 Bot 自己把 Routine 指令中的 `coda_input`、`coda_say`、`coda_done` 改成「有发现就在对话里告诉用户」。
3. 升级插件、完成原生登录并重新选择 Bot。在云电脑重新下载 `coda-bot.mjs`、`SKILL.md`，重启 MCP；按 `/bind` 说明核对工具绑定。

旧 Webhook bots 表不再使用；`coda_input`、`coda_say`、`coda_done` 及适配器对应远端方法已移除。本次代码更新不会自行修改线上 Routine。

## 协议与验证边界

使用 Grok Bot **0.78.1** 的私有 Connect 协议（`api2.cursor.sh`），请求带客户端版本头，协议客户端独立在 `agent/native.mjs`，以后可替换正式接口。只读参考社区 [grok-bot-sdk 协议说明](https://github.com/RongleCat/grok-bot-sdk/blob/main/docs/api/protocol.md)（MIT），未复制其实现或厂商代码。

这是未获稳定性保证的私有接口，上游升级可能使登录、字段或接口失效；错误会显示在会话中。[Cursor 服务条款 §1.5](https://cursor.com/terms-of-service) 限制逆向工程等行为（法律不允许此限制的情况除外），使用前需评估该条款风险。

- 原生活动标题保留 detail，按 callId/tool/target/detail 识别活动。0.78.1 的 tool/target 是自由字符串；已有只读记录的 43 条 tool 活动均为 SetStatus，它只报告说明，不能据此推断底层命令或文件操作，因此 SetStatus 与未经验证的名称均报 ACP `other`。target 没有已验证的文件路径语义，不编造 locations 或输入输出。thinking 只显示“正在思考”，不是思考正文。
- Coda 代理工具的 kind：read_thread、read_tool_call、agents、status、workflow_status、workflow_list、machines、machine_diagnostics → `other`（数据查询，显示「调用 N 个工具」；Coda 会把没有路径的 `read` 调用也计为文件，不能用于这些查询）；telemetry → `fetch`（「联网 N 次」）；new_session、send → `other`。保留完整输入输出，没有文件位置就不报 locations。
- 按 requestId/turnId 归并。成功结算且主 Agent 无运行、撰写、重试、activity 或 awaiting 状态时才考虑收尾；再次出现主 Agent 活动会撤销待收尾状态。最后正文之后没有活动，立即核对历史并收尾；先回复又出现活动则等待后文，最多宽限 10 秒，再核对历史；完全无正文仍用 5 秒宽限。后文到达即可完成，不必等满宽限。hasRunningSubagents 属于独立 Routine 观测，不阻塞主轮次；heartbeat.serverTimeMs 只有时间，没有正文游标，不作为正文交付完成的保证。上游没有“最后正文已落盘”标志，超出宽限或取消/超时后的消息仍原样显示为 Bot 的话，不加前缀，不按正文去重。
- 10 秒宽限依据：2026-10-31 的 requestId `11223fc4-fbff-4364-a6d7-47911999652b`，只读历史中 t7s0/t7s1 正文时间为 15:34:39.339 / 15:34:51.225（SGT），相差 11.886 秒；Coda 的中间活动在 15:34:43.694 被收尾，t7s1 在 15:34:51.495 到达，晚 7.801 秒。历史不保留该次 settlement，不能把本地收尾时间当精确的原生 settledAtMs；10 秒是覆盖已知约 8 秒延迟的兜底，不是上游保证。正常“工具→最终正文→结算”不增加等待。
- entryId、updatedSeq 和正文摘要只保留按 updatedSeq 排序的最近 2000 条，每批条目合并写盘；更早条目若被服务端修订，会当作新条目呈现。断线按游标重连，游标失效分页读历史补齐并去重，不重发用户消息。首次选择只建立历史基线，不灌入旧聊天。正文被服务端省略或消息类型不支持时明确提示去 Grok 客户端查看。
- Stop 调 InterruptGrokBotAgentRun。widget 选项变成 Coda 卡片，选择后交回 RespondGrokBotWidget；未选择则不代答。auto-review 尚未实测，收到 awaiting 时提示去 Grok 客户端处理，并记事件日志。

实机已验证官方登录、Bot 列表、原生发送/状态/活动/回复、Interrupt、widget 选择交回、Routine run 与 executor ID 的关联，以及无需任何 Coda 汇报工具也会出现的主会话结论（结束状态比正文早 121 ms）。完整新适配器尚未真机部署；自动续期、auto-review、executor 内部过程未实测。适配器测试使用假原生服务端与假时钟。0.3.1 仅只读核对原生历史、订阅及已有协议/观察记录，没有向真实 Bot 发消息或运行新版适配器，也没有更新云电脑与 Routine。
