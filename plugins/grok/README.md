# Grok

Grok Agent：适配运行机上 Grok CLI 的 ACP 与审批模式；资源页的「Grok」显示账号与额度，可从 Coda 安装和登录。

不声明 `systemPrompt`；会话指令由 Coda 后端在新会话第一次非斜杠命令的用户输入前送入单独的文本块，恢复会话不再送，插件不用处理。

压缩上下文（自动，或用户的 `/compact`）：入口把 Grok 的 `_x.ai/session_notification` 里的 `auto_compact_started`、`auto_compact_completed`、`auto_compact_failed`、`auto_compact_cancelled`（只取主会话的）原样转发后，另按 ACP `compaction_update` 报给 Coda：开始 `in_progress`，完成 `completed`，同一次压缩用同一个 `compactionId`；`/compact` 不报开始，只报完成。失败、取消两条在 Grok 1.0.77 上只在二进制里见到名字，没有实测，按 `failed` 报。

入口声明 ACP 的 `session/delete`：Grok 原生没有，入口自己拦下，改跑官方命令 `grok sessions delete <id>`（15 秒超时）。命令对不存在的会话也退出 0，所以以它的输出为准：`Deleted session` 回 `{}`，`No session found` 回 -32002，其他回 -32603 并带原因。会话还开在 Grok 里时可以直接删，之后 `session/close` 和结束进程都不会把它写回来（1.0.77 实测）。这样 Coda 探测模型和模式留下的空会话能被清掉；`sessions delete` 核对于 1.0.77，更旧的 CLI 没有它时回错误，不抬高最低版本（审批模式通知只核对过 1.0.52）。
