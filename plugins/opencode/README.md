# OpenCode

OpenCode Agent：接入原生子会话的状态、过程与停止，跟踪后台命令。

不声明 `systemPrompt`；会话指令由 Coda 后端在新会话第一次非斜杠命令的用户输入前送入单独的文本块，恢复会话不再送，插件不用处理。

模型服务的失败只在 `agent/errors.mjs` 的 `classifyProviderFault` 判一次，OpenCode 回执（按 `errorName`）与长等待（按重试事件 `error` 的 `type`，它与 `errorName` 同一套 `provider.*`，另看 `status` 与原文）都调用它：服务自己说额度用尽的原文优先，不论状态码，标 `quota_exhausted`；408、429、5xx、容量拒绝、连接失败、超时标 `service_unavailable`；认证、内容过滤、请求无效、上下文超长不标。长等待另带 OpenCode 排定的重试等待 `retryAfterMs`。
