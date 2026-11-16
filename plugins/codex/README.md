# Codex

Codex Agent：Coda 自带的入口运行 codex-acp，报告子 Agent、后台命令与命令的自动审核。额度与登录由账号来源插件接管；未接入账号来源时，资源页的「Codex」显示 Codex 自己的登录与额度。

上下文压缩（自动或手动）作为 Coda 的「整理上下文」记录显示：开始报 `compaction_update` in_progress、完成报 completed，Coda 据此知道会话压缩过；不再出「Compact conversation」工具卡。
