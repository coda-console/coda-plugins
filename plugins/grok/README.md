# Grok

Grok Agent：适配运行机上 Grok CLI 的 ACP 与审批模式；资源页的「Grok」显示账号与额度，可从 Coda 安装和登录。

不声明 `systemPrompt`；会话指令由 Coda 后端在新会话第一次非斜杠命令的用户输入前送入单独的文本块，恢复会话不再送，插件不用处理。

入口声明 ACP 的 `session/delete`：Grok 原生没有，入口自己拦下，改跑官方命令 `grok sessions delete <id>`（15 秒超时），成功回 `{}`，失败回带原因的错误。这样 Coda 探测模型和模式留下的空会话能被清掉。
