# Kimi Code

Kimi Code Agent：Coda 的入口在运行机的 kimi acp 与 Coda 之间转发，读 Kimi 的会话文件报出后台命令与子 Agent；资源页的「Kimi」显示账号与额度，可从 Coda 安装和登录。

不声明 `systemPrompt`；会话指令由 Coda 后端在新会话第一次非斜杠命令的用户输入前送入单独的文本块，恢复会话不再送，插件不用处理。

压缩上下文（自动，或用户的 `/compact`）：Kimi 的 ACP 只用一段文字说，所以读主 Agent 的 wire（`agents/main/wire.jsonl`）里的 `full_compaction.begin`、`full_compaction.complete`、`full_compaction.cancel`，按 ACP `compaction_update` 报给 Coda：开始 `in_progress`，完成 `completed`，取消 `failed`，同一次压缩用同一个 `compactionId`。和其余会话文件观察一样，只认核对过的 Kimi 版本；本进程启动前就开始的压缩只报结束。子 Agent 的压缩不报。
