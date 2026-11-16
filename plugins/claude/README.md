# Claude

Claude SDK Agent：Coda 基于 Claude Agent SDK 写的 ACP 入口，一个进程一个 SDK 会话；资源页的「Claude」显示会话报告的额度，可从 Coda 登录。

## MCP 配置不进命令行

Coda 交来的 MCP 服务（含 `coda` 服务 `env` 里的令牌 `CODA_TOKEN`）若交给 SDK 的 `mcpServers`，会被写成 `--mcp-config '<JSON>'` 放进 Claude 进程的命令行参数，同一台机器上别的用户看得见。
入口改为：会话打开时在系统临时目录下 `mkdtemp` 建目录（0700），把 `{ mcpServers }` 写进里面的 `mcp.json`（0600），用 `extraArgs` 交 `--mcp-config <路径>`。
入口这一侧，令牌不再进命令行，只写进这个文件；会话结束（进程被关、查询自己结束）时连目录一起删。进程崩溃留下的目录不另外清理：令牌随托管记录作废，系统临时目录也会自己回收。没有 MCP 服务的会话不建目录。

## 临时目录

Claude Code 自己会在系统临时目录下建 `claude-<uid>/<cwd 编码>/<原生会话号>/`（里面是 `scratchpad`、`tasks`），它没有回收，会话多了会写满磁盘。
Coda 给会话一个临时目录时（环境变量 `CODA_SESSION_TMP`，绝对路径），入口把它交给 Claude Code 的环境变量 `CLAUDE_CODE_TMPDIR`，上面的目录就建在
`<CODA_SESSION_TMP>/claude-<uid>/…` 下，系统提示里告诉模型的 scratchpad 路径也跟着变；`resume` 恢复的原生会话照样生效，选了模型服务而另起的查询也一样。
实地核对过（SDK 0.3.322）：新会话与 `resume` 的 scratchpad 都在给定目录下。

- **什么时候没有：** `CODA_SESSION_TMP` 没有值时不设 `CLAUDE_CODE_TMPDIR`，和以前一样放在系统临时目录。旧的后端（含已发布的正式版）和没有状态根的后端不给这个变量。
- **谁回收：** Coda。它在启动 Agent 之前建好这个目录，会话归档、宽限期到了、进程关掉之后连同里面的东西一起删；插件不删，也不监听归档。
- 已经留在 `/private/tmp/claude-*` 下的存量目录不在这里处理。
- 上一节的 `coda-claude-mcp-*` 会话结束时由入口自己删，不在这个目录里。

## 会话怎样结束、结束后怎么答

SDK 的查询自己结束（Claude 进程被杀、崩溃、正常退出）时，入口把原因记下来：查询抛的错误文字（SDK 已把原生进程的退出码或信号和 stderr 末尾几行写在里面），没有错误就写「Claude SDK 查询结束，没有给出错误」。
原因写进插件的 stderr 日志（`Claude 会话结束：…`），并放进还在进行的那一轮的错误信息（`Claude 会话已结束：…`）。Coda 主动关闭的会话不写日志。

这些错误都标 `session_ended`（原生会话或进程已结束，不是上游服务的问题，Coda 不按服务故障重试）。`input` 只写插件能确定的：正在跑的那一轮的输入是 `accepted`，排在它后面没跑过的是 `not_accepted`，没有一轮在跑时输入有没有被读走说不准，不写。

会话已结束后再来的 `session/prompt` 当场拒绝，错误文字是 `Claude 会话未在运行：<原因>`，标 `session_ended`、`input: "not_accepted"`（输入没有进原生会话，Coda 整条重发）。
换模型服务时重启查询失败、输入还没交给新查询的，同样是 `session_ended` + `not_accepted`；失败本身已带别的类别（如额度、服务）的保留原类别，类别允许 `input` 时补上 `not_accepted`（`auth_required` 不带 `input`，原样保留）。设置项请求（`session/set_config_option`）只带原因，不带标记。

## 失败怎样分类

一轮失败时，入口（`agent/errors.mjs` 的 `claudeFailure`，纯函数）只按最终错误标失败类别（协议 `failure.json`），重试策略归 Coda，插件里没有重试或等待。
Claude Code 自己的重试（`system/api_retry`，登记为隐藏）发生在轮次结果之前；重试用尽后才有带 `error` 类别的合成助手消息和失败的 `result`，只有它们到分类函数，所以重试中的轮次不会提前失败。

| 最终错误 | 标记 |
| --- | --- |
| 明确的用量或余额用尽（`You've hit your … limit`、`Credit balance is too low` 等） | `quota_exhausted`，上游给出窗口重置时间时带 `resetAt` |
| 网络：`ECONNRESET`、`ECONNREFUSED`、`ETIMEDOUT`、`ENOTFOUND`、`EAI_AGAIN`、`socket hang up`、`fetch failed`、`Unable to connect to API`、`Request timed out`、TLS 握手失败、传输中断 | `service_unavailable` |
| 上游：5xx、408、`overloaded_error`、529、`api_error`；Claude Code 的 `overloaded`、`server_error` 类别 | `service_unavailable` |
| Cloudflare 的拦截或挑战页（状态码加 `cloudflare`、`cf-ray`、`Just a moment`、`Attention Required`），先于「认证失败」判断：Claude Code 把它的 403 页报成 `authentication_failed`，这里不再当认证失败 | `service_unavailable` |
| 登录凭据明确失效：`Failed to authenticate: OAuth session expired and could not be refreshed`（Claude Code 自己的文案，真实样本）；类别须是 `authentication_failed` 或没有类别，且不是用量、服务故障 | `auth_required`，`login: "Anthropic OAuth"` |
| API key 错或缺失（`Invalid API key`）、权限不足、仅有 401 或 403、上下文超长、账单、请求参数错误、证书错误、普通 429、被中止 | 不标 |

证书与 TLS 配置错误（正文里出现 `certificate` 或 `altnames`，如 `unable to get local issuer certificate`、`certificate has expired`、`Hostname/IP does not match certificate's altnames`；以及不带这个词的 Node 证书错误码，如 `DEPTH_ZERO_SELF_SIGNED_CERT`、`UNABLE_TO_VERIFY_LEAF_SIGNATURE`）先按文字排除，**即使 Claude Code 把它们归在 `server_error`**：它把连接错误合成为 `Unable to connect to API: <原因>` 并标 `server_error`，代理拦截 TLS、没配 `NODE_EXTRA_CA_CERTS` 这类永久性配置错误重试也不会好，照普通错误报，完整原因留给用户。

`auth_required` 以普通执行错误（-32603）报，不带 `input`、`retryAfterMs`、`resetAt`。

`service_unavailable` 的 `input` 是 `accepted`：失败来自轮次的结果，原生会话已经收下并开始处理这一轮；会话自身失败时仍在排队、从未运行的 prompt 是 `not_accepted`，Coda 重投原输入。文字里有 `Retry-After` 或 `retry after` 时带 `retryAfterMs`（毫秒）。

## 认不出的东西

Claude Code 会自己长出新东西：SDK 升级带来新的消息类型，服务端让模型返回新的内容块，模型多了新的原生工具。
入口不认识时若悄悄丢掉，用户就看不到本该看到的。入口为此有三层防范：

1. **登记**（`agent/registry.mjs`）：锁定的 SDK 的每种消息（`SDKMessage` 的类型与子类型，如 `system/init`）、助手消息与用户消息里的每种内容块，
   各注明转给 Coda 还是明确不显示，附一句原因。SDK 没有声明、却照样转来的几种内部消息（`system/post_turn_summary` 等）也登记为不显示。
2. **升级检查**（`test/plugins/claude/sdk-registry.mjs`，`npm test` 里跑）：用 TypeScript 编译器的类型检查器（仓库的 devDependency `typescript`）
   读锁定 SDK 入口导出的 `SDKMessage`，展开联合取每个成员 `type`、`subtype` 的字面量，再顺着助手、用户消息 `message.content` 的元素类型
   展开内容块的联合取 `type`，有没登记的就失败并列出来。别名、交叉类型、再导出与泛型都由检查器解析；`type`、`subtype` 不全是字符串字面量的
   （比如 `string`）判失败并说出是哪个成员，不会悄悄放过。
3. **运行时报告**：Coda 在 `initialize` 的 `clientCapabilities._meta.coda.unrecognized` 里表示收，入口才发 `_coda/unrecognized`
   （协议 5.4.0，`docs/agent-protocol.md`「没适配的东西」），同一会话同一 `name` 只报一次；没表示就什么都不发，下面的后备显示照旧。
   - 没登记的消息报 `sdk:<type>/<subtype>`（没有子类型的报 `sdk:<type>`），没登记的内容块报 `block:<type>`，都是 `kind: output`。
     消息和助手消息里的内容块带文字的（`text`，字符串或文字块的 `content`，消息的 `message.content`）照常显示成 Claude 的回复，报 `lost: false`；
     没有文字的报 `lost: true` 并附一句说明。结果、助手与用户消息、流式事件、额度事件不论子类型都按类型处理，子类型没登记也报 `lost: false`。
   - 用户消息是给模型的输入（工具结果、Claude Code 补的说明等），不是 Claude 说的话：里面没登记的内容块只报不显示，`lost: true`，
     会话里留一条「没有显示」的说明。
   - 每轮开始的 `system/init` 列出模型能用的工具，和已知清单 `agent/known-tools.json` 对照，清单里没有的报 `tool:<名字>`（`kind: tool`、`lost: false`）。
     MCP 工具（`mcp__` 开头）是用户配的，不比。清单是锁定 SDK 在本入口的启动选项下 `system/init` 列出的工具，加上入口另外认识的
     （`agent/tools.mjs` 里的、旧版 Claude Code 的）。

### 升级 SDK 时

1. 升 `@anthropic-ai/claude-agent-sdk` 的 PR（Dependabot 开的，或手动改版本并更新 `package-lock.json`）先要让 `npm test` 里的升级检查通过：
   `node test/plugins/claude/sdk-registry.mjs` 列出新 SDK 有、登记表没有的消息类型与内容块。
2. 逐个看新 SDK 的 `sdk.d.ts` 与它带的 `@anthropic-ai/sdk`：要显示的在 `agent/session.mjs` 里处理，再登记为转给 Coda；不显示的登记并写明原因。
   检查读不出声明时，按报错补读法或改登记，不要跳过。
3. 用新 SDK 跑一轮真实会话，把新出现的原生工具加进 `agent/known-tools.json`（会话里没登记的工具会报成 `tool:<名字>`，遥测按 Agent 版本计数）；
   要按读写、命令等显示的，同时在 `agent/tools.mjs` 里归类。

### SDK 0.3.312 → 0.3.322（2026-11-13）

依据 npm 发布包的 `sdk.d.ts` 对比和 [SDK CHANGELOG](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md)；消息联合只新增 `system/session_writes_lost`，内容块类型无新增。保持升级前功能，不打开新的开关。

| 新消息、事件或字段 | 去向 |
| --- | --- |
| `system/session_writes_lost`；`error_code: ENOSPC/EDQUOT`、`lost: transcript/global_config`、`transcript_session_ids` | `registry.mjs` 登记为有意忽略。SDK 明确允许忽略；已收到的结果不变，Coda 自己的记录照旧，不将其报为没适配。 |
| `task_type: mcp_task` | `waits.mjs` 的普通 `task`（与 `local_bash` 一样），沿用开始、转后台、快照、结束、停止；不打开 `CLAUDE_AUTO_BACKGROUND_TASKS`。 |
| result 的 `credential_expires_at`（成功与失败均可带） | 有意不消费；登录仍由现有认证及资源路径管理，不增加到期时间展示或跨层参数。 |
| `startup_failure_reason: sandbox_required_unavailable / initialize_not_first / config_file_invalid` | 仍按 `result/error_during_execution` 处理，`errors` 原文经 `errorText`、`claudeFailure` 报执行失败；不额外按原因改变重试策略。 |
| hook 回调失败的 warning | 既有 `system/notification` 登记为运行机通知、有意不显示；不启用新增 `HookCallbackMatcher.onFailure: block`。默认 `continue` 不变。 |
| `agentProgressSummaries` 延后或省略摘要 | 既有 `system/task_progress` 有意忽略；等待项靠生命周期，不靠心跳或摘要。 |
| control initialize 的 `hook_on_failure_supported`；响应的 `pending_elicitation_requests` | SDK 控制层使用；插件只取模型、命令、账号，不自行接管控制响应或重放表单。现有表单继续经 `onElicitation`。 |
| `set_has_subscribers` 控制请求、MCP call 的 `check_permissions`、readFile 的 `lossy` | 控制层接口，插件不调用；不增加订阅、直接 MCP 调用或文件读取功能。 |
| 真实会话 init 的 `ArtifactComments / ArtifactData / DesignSync / SendToProject / SendToProjectContext` | 补进 `known-tools.json`；沿用通用工具调用及结果，不误报未适配。发布包 `BUILTIN_TOOL_NAMES` 两版相比没有新增名。 |
| `TaskCreate` 结果的 `task.description`；Read 不再返回 `file_unchanged` | 沿用 `tool_result` 的既有工具结果处理，不按这些字段分支。 |
| `prewarm` 进入 `/core`；`Settings.permissions.blockWritesOutsideWorkingDirectories / blockReadsExemptPaths / workingDirectoriesAsGiven / denyInsteadOfPrompting`、`disableReplyCheck / disableWindowsBashCommandSplit`；`PushNotificationInput.status` 可省略 | 有意不启用；继续使用现有 `query`、Stop hook 和设置。 |

ACP 2.6.0 只使用默认 stable v1。逐项经过真实连接的解析测试：`initialize` 保留 `clientCapabilities._meta.coda.unrecognized`；`new/load` 保留目录、MCP 配置及其环境变量、`systemPrompt`、`_meta`；`prompt` 保留文本及内容块的 `_meta`；配置值与模式照常到达处理器；`_session/steering`、`_coda/wait/stop`、`_coda/session/compact` 沿用原自有解析器。未发现 Coda 用到的字段被新版裁掉，因而没有新增解析器。`new/load` 原注释中“schema 不认识 systemPrompt”在 2.6.0 已不成立。
