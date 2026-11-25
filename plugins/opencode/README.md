# OpenCode

OpenCode Agent：接入原生子会话的状态、过程与停止，跟踪后台命令。

不声明 `systemPrompt`；会话指令由 Coda 后端在新会话第一次非斜杠命令的用户输入前送入单独的文本块，恢复会话不再送，插件不用处理。

模型服务的失败只在 `agent/errors.mjs` 的 `classifyProviderFault` 判一次，OpenCode 回执（按 `errorName`）与长等待（按重试事件 `error` 的 `type`，它与 `errorName` 同一套 `provider.*`，另看 `status` 与原文）都调用它：401/403 一律不标；其余状态码带服务自己说额度用尽的原文，标 `quota_exhausted`；408、429、5xx、容量拒绝、连接失败、超时标 `service_unavailable`；认证、内容过滤、请求无效、上下文超长不标。长等待另带 OpenCode 排定的重试等待 `retryAfterMs`。

上下文压缩（`/compact` 或自动压缩）不经本插件转换：Coda 的 `initialize` 声明 `session.compaction`，OpenCode 在该能力下自己发 `compaction_update`，入口原样转发给 Coda。

每轮用量的口径在 `agent/usage.mjs` 换算一次：OpenCode 的 `outputTokens` 不含思考量（核对的是插件实际运行的 `~/.opencode/bin/opencode` 2.1.4：`outputTokens = tokens.output`，`totalTokens = input + output + reasoning + cache.read + cache.write`，`thoughtTokens` 仅在 reasoning 大于 0 时给出），而 Coda 把思考量算在输出里，所以回执里 `outputTokens` 是非负安全整数、`thoughtTokens` 是正安全整数且两者之和仍是安全整数时，把它并入 `outputTokens`，`thoughtTokens` 仍照报作输出里的细分；`totalTokens` 与其余字段原样转发，其余回执（无思考量、字段缺失、负数、小数、非数字）原样转发。
