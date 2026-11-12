# Kimi Code

Kimi Code Agent：Coda 的入口在运行机的 kimi acp 与 Coda 之间转发，读 Kimi 的会话文件报出后台命令与子 Agent；资源页的「Kimi」显示账号与额度，可从 Coda 安装和登录。

不声明 `systemPrompt`；会话指令由 Coda 后端在新会话第一次非斜杠命令的用户输入前送入单独的文本块，恢复会话不再送，插件不用处理。
