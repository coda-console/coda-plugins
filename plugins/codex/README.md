# Codex

Codex Agent：Codex 插件提供的入口运行 codex-acp，报告子 Agent、后台命令与命令的自动审核。额度与登录由账号来源插件接管；未接入账号来源时，资源页的「Codex」显示 Codex 自己的登录与额度。

实时的上下文压缩（自动或手动）作为 Coda 的「整理上下文」记录显示：开始报 `compaction_update` in_progress、完成报 completed，Coda 据此知道会话压缩过；回合失败或中断、压缩未完成时补报 failed，不再出「Compact conversation」工具卡。恢复会话时，历史里的压缩仍显示为「Compact conversation」工具卡，不上报，免得 Coda 把它当成新的压缩。

## 资源页：Codex 的登录与额度

资源页上的资源类型「Codex」：这台机器上 Codex 自己的登录（本机登录）和它的额度。接了账号来源（见下）时它输出为空，「Codex」里是账号插件管理的账号。

- **来源**：读取命令以插件依赖的 Codex CLI（`@openai/codex`，codex-acp 也用它）临时启动 `app-server`，问完即关；
  `CODEX_HOME` 沿用后端的环境（不设就是 `~/.codex`），与 Codex 会话是同一个登录。账号问 `account/read`，额度问 `account/rateLimits/read`，
  令牌由 Codex 自己读取和续期，不经过脚本，也不进输出。凭据只在系统钥匙串里的登录同样认得。
- **显示**：没有登录时输出为空，「Codex」出现在「添加资源」里。用 ChatGPT 账号登录时一个资源，名字是账号邮箱（套餐不显示）：
  每个额度窗口一个读数（5 小时、7 天，时刻是重置时间；Codex 给出多组额度时读数名前加额度名，不知道比例的写「—」），
  然后「完全重置 剩余 N 次」（次数以 Codex 给的汇总为准），时刻是最早到期的那一次（没有到期时间的不写），合计至多 8 个读数。
  用 API Key 等别的方式登录时那一行写「不是 ChatGPT 登录，没有额度」。读不到额度时那一行写「暂时无法获取额度」和 Codex 说的原因，「···」里的「重新登录」仍在。
- **身份**：额度是一个人在一个工作区的，身份是邮箱与工作区账号 ID 一起的哈希 `codex:<哈希>`；Codex 没给出邮箱或工作区时不带。
- **完全重置**：有可用的那一次时，行尾有「使用完全重置」，总是用最早到期的那一次；确认框写账号与这一次的到期时间。
  动作只兑换按钮指定的那一次（不让上游自己挑），没重置成（当前额度无需重置、这次已被使用或已不可用）时那一行写明。
- **登录**：`signIn` 运行同一个 CLI 的 `codex login --device-auth`，设备码登录要在 ChatGPT 账号安全设置或工作区权限里启用
  （[OpenAI 登录说明](https://learn.chatgpt.com/docs/auth)）。重新登录替换 `CODEX_HOME` 当前的登录；多账号管理器的活动账号若也用这个目录，同样被替换，
  管理器那边读取时仍会核对账号身份。
- **读取**：清单里 `maxAge` 是 `PT0S`，每次读取都重新查询，不复用上次的结果。Codex 本身启动不了或不答复时整块读取失败，保留上次结果并标明。

## 扩展点「账号来源」

扩展点 `account-source`：别的插件替 Codex 选账号（`codex-accounts` 就是）。没有插件接上时，Codex 用这台机器上自己的登录。

- **对话**：会话的 Codex 进程启动接上的第一个来源的命令（`sh -c`，`PATH` 最前面是 Coda 的 Node，`CODA_PLUGIN_PATH`、`CODA_PLUGIN_STATE` 是来源插件的），
  常驻，经标准输入输出一行一个 JSON 问它；来源退出了，下次问时再启动：

  | 问 | 答 |
  | --- | --- |
  | `{ "id", "method": "selected" }` | `{ "id", "result": { "account": { "id", "name" } } }`；`"account": null` 是不接管，保持 Codex 当前的登录 |
  | `{ "id", "method": "tokens", "params": { "account", "refresh"? } }` | `{ "id", "result": { "accessToken", "chatgptAccountId", "chatgptPlanType" } }` |

  答不了时回 `{ "id", "error": { "message" } }`，原因写进那一轮的失败里；全权接管的来源在还没选账号时就回错误。
  `tokens` 的 `refresh` 可选：为 `true` 时要求来源续期，不能返回已被 Codex 拒绝的旧令牌，令牌还没到期也要续。
- **什么时候换**：入口让 codex-acp 经账号桥（`agent/accounts.mjs`）运行 Codex：在开会话、恢复、分叉和每轮开始时问来源选的是谁。
  回 `null` 就什么都不做，Codex 保持当前的登录；选中的 ID 与当前已应用的相同时不读令牌；换到另一个 ID（包括 `native`，它没有特殊处理）才向来源要这个账号的令牌，
  经 app-server 的 `chatgptAuthTokens` 登录交给 Codex，再核对 Codex 登上的就是这个账号。
  有轮次在跑时不换，等这一连接上的轮次都结束再换。Codex 要续期时（`account/chatgptAuthTokens/refresh`）入口问来源要这个账号的令牌，带 `refresh: true`；
  Codex 当前的账号不是交过去的那个、或来源给的令牌属于另一个账号，就拒绝。
- **换不过去**：来源答不了、令牌不全或 Codex 登上的不是所选账号时，那一轮失败，写「没能换到所选的 Codex 账号 X：原因。去「资源」重新选择或登录」，
  不用之前的账号发出去。已交了账号时，ACP 自己的登录、登出被拒绝，免得盖掉所选的账号。
- 令牌只走账号桥与 app-server 之间的私有管道，不经 ACP，不进会话记录。连接显式指定了自己的 Codex 程序（`CODEX_PATH`）时不接账号桥。
  交令牌（`chatgptAuthTokens`）是 app-server 的实验接口：升级 codex-acp 或 Codex 时复核登录、`account/read` 的身份核对、续期请求与轮次边界。

「模型服务」设置、异步消息与提问见仓库根 README 的「模型服务」「Codex 异步消息与提问」。
