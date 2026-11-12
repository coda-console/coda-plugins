# Grok

Grok Agent：适配运行机上 Grok CLI 的 ACP 与审批模式；资源页的「Grok」显示账号与额度，可从 Coda 安装和登录。

不声明 `systemPrompt`；会话指令由 Coda 后端在新会话第一次非斜杠命令的用户输入前送入单独的文本块，恢复会话不再送，插件不用处理。
