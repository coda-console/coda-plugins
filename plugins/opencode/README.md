# OpenCode

OpenCode Agent：接入原生子会话的状态、过程与停止，跟踪后台命令。

清单的 `modes` 里 `manual`、`auto`、`full` 都是 `null`（`build`／`plan` 是 Agent 模式，不是审批档；工具权限沿用运行机配置），`safe` 是 `["plan"]`，`default` 是 `auto`。

不声明 `systemPrompt`；会话指令由 Coda 后端在新会话第一次非斜杠命令的用户输入前送入单独的文本块，恢复会话不再送，插件不用处理。

模型服务的失败只在 `agent/errors.mjs` 的 `classifyProviderFault` 判一次，OpenCode 回执（按 `errorName`）与长等待（按重试事件 `error` 的 `type`，它与 `errorName` 同一套 `provider.*`，另看 `status` 与原文）都调用它：401/403 一律不标；其余状态码带服务自己说额度用尽的原文，标 `quota_exhausted`；408、429、5xx、容量拒绝、连接失败、超时标 `service_unavailable`；认证、内容过滤、请求无效、上下文超长不标。长等待另带 OpenCode 排定的重试等待 `retryAfterMs`。

上下文压缩（`/compact` 或自动压缩）不经本插件转换：Coda 的 `initialize` 声明 `session.compaction`，OpenCode 在该能力下自己发 `compaction_update`，入口原样转发给 Coda。

每轮用量的口径在 `agent/usage.mjs` 换算一次：OpenCode 的 `outputTokens` 不含思考量（核对的是插件实际运行的 `~/.opencode/bin/opencode` 2.1.4：`outputTokens = tokens.output`，`totalTokens = input + output + reasoning + cache.read + cache.write`，`thoughtTokens` 仅在 reasoning 大于 0 时给出），而 Coda 把思考量算在输出里，所以回执里 `outputTokens` 是非负安全整数、`thoughtTokens` 是正安全整数且两者之和仍是安全整数时，把它并入 `outputTokens`，`thoughtTokens` 仍照报作输出里的细分；`totalTokens` 与其余字段原样转发，其余回执（无思考量、字段缺失、负数、小数、非数字）原样转发。

回执 `usage` 的模型身份（Coda 的 docs/plugins.md「Coda 的用量记录」）以 OpenCode 确认过的当前模型为准，不看 Coda 发过什么设置请求：入口从 OpenCode 的答复里读各会话 `model` 选项的当前值——`session/new`、`session/load`、`session/set_config_option` 答复里的 `configOptions`，以及它自己发的 `config_option_update`；所以会话一打开就选在服务的模型上（Coda 不再发设置请求）也认得，设置被拒绝时保持原来的。`session/prompt` 发出时就定下这一轮的身份，结算用定下的，不用结算时刻的。选的是所选模型服务里的模型（值是 `<provider ID>/<模型 ID>`）时，`usage` 顶层带 `service`（由注入地址 `…/resources/<接口种类>/<UUID><路径>` 得到的 `coda://<接口种类>/<UUID>`）与 `asked`（去掉 provider 前缀的裸模型 ID）；地址不是这个形状，或选的是 OpenCode 自己的模型，两者都不带。OpenCode 的回执没有上游实际型号，不报 `served`。Coda 对真实会话不发 `session/close`、`session/delete`（只对只读的探测会话发，先 delete 再 close），会话随进程结束；入口收到这两个请求时也清掉该会话的记录。
