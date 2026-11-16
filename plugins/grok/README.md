# Grok

Grok Agent：适配运行机上 Grok CLI 的 ACP 与审批模式；资源页的「Grok」显示账号与额度，可从 Coda 安装和登录。

不声明 `systemPrompt`；会话指令由 Coda 后端在新会话第一次非斜杠命令的用户输入前送入单独的文本块，恢复会话不再送，插件不用处理。

压缩上下文（自动，或用户的 `/compact`）：入口把 Grok 的 `_x.ai/session_notification` 里的 `auto_compact_started`、`auto_compact_completed`、`auto_compact_failed`、`auto_compact_cancelled`（只取主会话的）原样转发后，另按 ACP `compaction_update` 报给 Coda：开始 `in_progress`，完成 `completed`，同一次压缩用同一个 `compactionId`；`/compact` 不报开始，只报完成。失败、取消两条在 Grok 1.0.77 上只在二进制里见到名字，没有实测，按 `failed` 报。
