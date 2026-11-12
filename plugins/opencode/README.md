# OpenCode

OpenCode Agent：接入原生子会话的状态、过程与停止，跟踪后台命令。

不声明 `systemPrompt`；会话指令由 Coda 后端在新会话第一次非斜杠命令的用户输入前送入单独的文本块，恢复会话不再送，插件不用处理。
