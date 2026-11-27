# Codex

Codex Agent：Codex 插件提供的入口运行 codex-acp，报告子 Agent、后台命令与命令的自动审核。资源页的「Codex」显示 Codex 自己的登录与额度；打开设置「多账号」（`codex.multipleAccounts`，默认关）后改为插件管理的多个账号（见下）。

实时的上下文压缩（自动或手动）作为 Coda 的「整理上下文」记录显示：开始报 `compaction_update` in_progress、完成报 completed，Coda 据此知道会话压缩过；回合失败或中断、压缩未完成时补报 failed，不再出「Compact conversation」工具卡。恢复会话时，历史里的压缩仍显示为「Compact conversation」工具卡，不上报，免得 Coda 把它当成新的压缩。

**Coda 自己的 MCP 服务器**（名为 `coda`、经后端的 mcp-shim 接入的那一个）在交给 Codex 时多带两项按服务器的设置：`default_tools_approval_mode = "approve"`（工具请求都交到 Coda 自己的权限边界）与 `tool_timeout_sec = 900`。Codex 对单次 MCP 工具调用默认只等 300 秒，到点就报 `timed out awaiting tools/call` 并取消；Coda 的工具里有远程执行，命令最长跑 10 分钟，所以给 Coda 的服务器 15 分钟。用户自己配的其他 MCP 服务器、以及 Codex 配置里本来就有的同名 `coda` 服务器不受影响，沿用它们自己的设置（没设就是 Codex 的 300 秒）。

**会话临时目录可写**：Coda 给会话一个临时目录时（环境变量 `CODA_SESSION_TMP`，绝对路径，`<状态根>/session-tmp/<会话ID>`），它加进 Codex workspace-write 沙箱的可写根，和 Coda 经 ACP 交来的附加目录同样处理（每一轮的沙箱策略与会话配置的 `sandbox_workspace_write.writable_roots`），从别的机器拉下来的文件可以原地改再推回去。只加这个会话自己的目录，不加 `session-tmp/`（别的会话的目录在它下面）；完全放开模式本来就能写，只读的沙箱策略不加；没有这个变量（旧的后端）或不是绝对路径时和以前一样。Codex 的 `TMPDIR` 不改。

**审批模式**：除 codex-acp 自带的 `read-only`（短名「按需审批」）、`agent`（「自动审批」）、`agent-full-access`（「完全访问」）外，入口给它的唯一一张模式表加了第四个 `manual`（「人工审批」）：`approvalPolicy: untrusted`、审批人是用户、workspace-write 沙箱且不开网络（`agent/manual-mode.mjs`，锚点对不上就启动失败）。Codex 要运行不在它可信命令里的命令时，经 ACP 的 `session/request_permission` 交给 Coda 由人答复；会话临时目录同样在它的可写根里。`read-only` 保留给已有会话，它是 `on-request`（由模型自己决定问不问）且允许写工作区，所以不归入 `safe`。清单的 `modes` 因此是 `manual: "manual"`、`auto: "agent"`、`full: "agent-full-access"`、`safe: []`、`default: "full"`，与未指定模式时的启动默认（完全访问）一致。

## 资源页：Codex 的登录与额度

资源页上的资源类型「Codex」：这台机器上 Codex 自己的登录（本机登录）和它的额度。打开「多账号」时它输出为空，「Codex」里是多账号管理的账号（类型 `accounts`，见下）。

- **来源**：记录命令 `scripts/resource.mjs` 以插件依赖的 Codex CLI（`@openai/codex`，codex-acp 也用它）临时启动 `app-server`，问完即关；
  `CODEX_HOME` 沿用后端的环境（不设就是 `~/.codex`），与 Codex 会话是同一个登录。账号问 `account/read`，额度问 `account/rateLimits/read`，
  令牌由 Codex 自己读取和续期，不经过脚本，也不进输出。凭据只在系统钥匙串里的登录同样认得。
- **显示**：没有登录时输出为空，「Codex」出现在「添加资源」里。用 ChatGPT 账号登录时一个资源，名字是账号邮箱（套餐不显示）：
  每个额度窗口一个读数（5 小时、7 天，时刻是重置时间；Codex 给出多组额度时读数名前加额度名，不知道比例的写「—」），
  然后「完全重置 剩余 N 次」（次数以 Codex 给的汇总为准），时刻是最早到期的那一次（没有到期时间的不写），合计至多 8 个读数。
  用 API Key 等别的方式登录时那一行写「不是 ChatGPT 登录，没有额度」。Codex 说登录没有了、过期或无效（认证文件读不了）时那一行写「登录已失效，请重新登录」和 Codex 说的原因，「···」里的「重新登录」仍在；别的读不到（网络、超时、服务端出错、Codex 没有给出任何额度窗口或重置次数）命令以非零退出，原因写在标准错误的最后一行，Coda 保留上一份记录，资源页显示「更新失败：原因」。
- **身份**：额度是一个人在一个工作区的，身份是邮箱与工作区账号 ID 一起的哈希 `codex:<哈希>`；Codex 没给出邮箱或工作区时不带。
- **完全重置**：有可用的那一次时，行尾有「使用完全重置」，总是用最早到期的那一次；确认框写账号与这一次的到期时间。
  动作（操作 `act` 的 `reset`，`scripts/act.mjs`）只兑换按钮指定的那一次（不让上游自己挑），没重置成（当前额度无需重置、这次已被使用或已不可用）时那一行写明。
- **登录**：操作 `sign-in`（`scripts/sign-in.mjs`）运行同一个 CLI 的 `codex login --device-auth`，把它打印的链接与设备码用 `coda progress` 报给 Coda（报完才算登录结束，报失败登录就失败），20 秒内没有链接就失败，原因是那时 CLI 说的最后一行（之后被结束时 CLI 说什么不改它，退出码 0 也不算成功）；这套流程在 `scripts/device-login.mjs`；设备码登录要在 ChatGPT 账号安全设置或工作区权限里启用
  （[OpenAI 登录说明](https://learn.chatgpt.com/docs/auth)）。重新登录替换 `CODEX_HOME` 当前的登录。打开「多账号」时这个入口改为添加或更新多账号里的账号（`scripts/cli.mjs` 转给 `scripts/login.mjs`）。
- **读取**：记录命令不定时（清单里没有 `every`），资源页打开、点「刷新」和每个操作之后才运行，每次都重新查询。Codex 本身启动不了或不答复时命令以非零退出，原因写在标准错误的最后一行。

## 多账号

设置「多账号」（`codex.multipleAccounts`，开关，默认关）。关着时用这台机器上 Codex 自己的登录（上一节）；打开后由插件管理多个账号：
自动纳入已有登录，添加与移除账号、自动续期、查看额度和使用完全重置，所选账号在会话开始和两轮之间生效。账号的导入、添加与存放见仓库根 README 的「Codex 账号与额度」。

- **资源**：另一种资源类型 `accounts`，标题也叫「Codex」，每个账号一个资源，名字是别名（邮箱）；本机登录那一种（`login`）这时输出为空，登录入口仍在。
  额度与完全重置的读数同本机登录；会话正在用的那个多一个读数「状态 · 正在使用」。某个账号的登录没有了、过期或无效时，只写在它自己那一行；某个账号的额度读不到（网络、超时、服务端出错、Codex 没有给出它的任何额度）而别的账号读到了时，也只在它那一行写「暂时无法获取额度：原因」，别的账号照常显示；一个账号的额度都没读到、或账号列表读不了时，命令以非零退出，原因写在标准错误的最后一行，Coda 保留上一份记录，资源页显示「更新失败：原因」。
  所选的账号不在插件里时另有一行「所选账号」写明。至多 40 个账号、合计不超过 60 KiB。旧登录导入失败时记录照写：一行「Codex 账号」写原因，登录入口照常在。记录命令同是 `scripts/resource.mjs`。
- **按钮**（在「···」里；操作 `act`，`scripts/act.mjs` 在开关打开时按 `{ action, args }` 分派 `select`、`reset`、`remove`）：「切换使用」（先用这个账号核对一次，通过才记下；会话在下一个边界换过去）、
  「使用完全重置」（同本机登录，用这个账号的令牌）、「移除账号」（删掉插件保存的登录；移除的是正在用的，要再选或添加一个）。
- **身份**：知道邮箱的账号带与本机登录同一写法的身份（邮箱与工作区），同一账号在几台上、或与本机登录是同一个时，Coda 的资源页只显示一行。
- **登录**：操作 `sign-in` 运行 `scripts/cli.mjs login`，开关打开时它转给 `scripts/login.mjs`（Codex 的设备码登录，每次在私有目录里，登完核对才保存），设备码的上报与收尾同本机登录（`scripts/device-login.mjs`）。
- **会话**：入口让 codex-acp 经账号桥（`agent/accounts.mjs`）运行 Codex：在开会话、恢复、分叉和每轮开始时问账号管理（`scripts/manager.mjs`）选的是谁。
  选中的 ID 与当前已应用的相同时不读令牌；换到另一个才读这个账号的令牌，经 app-server 的 `chatgptAuthTokens` 登录交给 Codex，再核对 Codex 登上的就是这个账号。
  有轮次在跑时不换，等这一连接上的轮次都结束再换。Codex 要续期时（`account/chatgptAuthTokens/refresh`）入口为这个账号续期后再交；
  Codex 当前的账号不是交过去的那个、或续期后的令牌属于另一个账号，就拒绝。
- **换不过去**：还没选账号、所选账号的登录不可用或 Codex 登上的不是所选账号时，那一轮失败，写「没能换到所选的 Codex 账号 X：原因。去「资源」重新选择或登录」，
  不用之前的账号发出去。已交了账号时，ACP 自己的登录、登出被拒绝，免得盖掉所选的账号。
- 令牌只走账号桥与 app-server 之间的私有管道，不经 ACP，不进会话记录。连接显式指定了自己的 Codex 程序（`CODEX_PATH`）时不接账号桥。
  交令牌（`chatgptAuthTokens`）是 app-server 的实验接口：升级 codex-acp 或 Codex 时复核登录、`account/read` 的身份核对、续期请求与轮次边界。

「模型服务」设置、异步消息与提问见仓库根 README 的「模型服务」「Codex 异步消息与提问」。

回执 `usage` 的模型身份（Coda 的 docs/plugins.md「Coda 的用量记录」）：codex-acp 向 Codex 派发模型请求时，补丁把当时实际派发的型号绑在会话上；这一轮是服务里的模型时，`usage` 顶层带 `service`（由注入地址 `…/resources/<接口种类>/<UUID><路径>` 得到的 `coda://<接口种类>/<UUID>`）与 `asked`（发给服务的裸模型 ID）。地址不是这个形状、Codex 自己的模型、以及没有派发模型请求的 prompt（如切换模型后执行 `/status`）都不带；每个 prompt 开始时清掉上一轮的绑定。`/review`、`/goal` 这类由 codex-acp 另行派发轮次的命令，在注入服务上运行时的轮次目前不带 `service`、`asked`，用量退回按执行配置的模型 ID 记，数不会错也不会丢，只是暂时归不到服务那一行。不报 `served`。

**每轮的用量**（`agent/usage.mjs`）：codex-acp 的回执原本只带 Codex 最近一次模型响应的用量（`last`），一轮调用模型多次时只剩最后一笔，实测少算约 14 倍（长轮可少 200 倍以上）。补丁改为取这一轮内各线程累计量（`total`）的增量，三种回执（正常、命令、取消）都一样：
- 每个线程各记它上次见到的累计量，增量是这次累计减上次；线程第一次出现时基准是 `total − last`，所以恢复后的第一轮不含线程历史。Codex 在线程恢复时会重放一条当前累计量（属于上一次运行的轮次，本进程没见过它的 `turn/started`），这种通知只更新基准、不计数。
- 累计量变小（Codex 在上下文用满时重设计数）时按那一笔响应自己的 `last` 算，不出负数。
- 换算同以前：未缓存输入是 `inputTokens − cachedInputTokens − cacheWriteInputTokens`（缓存读、缓存写都含在 Codex 的输入里），缓存读 `cachedReadTokens`，缓存写 `cachedWriteTokens`（Codex 0.169 起的 `cacheWriteInputTokens`，现在都转发），输出含思考，`thoughtTokens` 是其中的思考部分。上下文占用（`usage_update`）仍取 `last`，没动。
- 这一轮没有增长的回执（`/status` 这类不调用模型的命令）不带 `usage`，不再重复带出上一轮的计数；`/review`、`/goal` 这类发起模型请求的命令照增量算。
- 子 Agent（原生子线程）的用量计入派生它的那一轮：子线程的 `thread/tokenUsage/updated` 以子线程 ID 区分、各自记基准，子线程后来新增的轮也算。记账在 codex-acp 订阅器的通知入口，每条原始事件只经过一次，在按客户端能力分流之前：Coda 现在发给 Agent 的能力里没有 `subagents`，子线程事件在 codex-acp 里是当作会话自己的事件交出去的，声明了原生子会话能力的客户端则要先暂存、建好子会话后再处理一遍，两种都不会漏记或记两次。Codex 可能先给子线程投递初始输入、让它的轮开始，之后父线程才发出带子线程 ID 的派生通知，此时适配器还没有这个子线程的处理器、会把它的通知丢掉：补丁在丢掉之前留下子线程的轮开始与用量（每个线程只留首条与最新一条用量，增量够用），父线程派生通知到了、认下这个子线程时再归到这一轮，只记一次；一直没被认领的线程（如 Codex 自己的审核子线程）不计。回执在父轮的子 Agent 等完后才发；父轮回执发出之后子线程才产生的用量（取消、等待超时后仍在跑的）计入下一份回执，不丢、不重。
- 以错误结束的轮次，其回执不带用量（Coda 对错误回执不采集用量），这一轮已发生的消耗随下一份回执上报，总量对，只是记在下一轮名下。
- 子 Agent 用的模型与父线程不同时（派生时指定了 `model`，`collabAgentToolCall`／`subAgentActivity` 的 `model`），回执带 `breakdown`：父线程一项，子 Agent 的各一项，各项带自己的四项计数；父线程在服务上时（上一段的 `service`、`asked`）子 Agent 的项带同一个 `service` 与自己的 `asked`（线程只在一个服务上运行），否则是 `model`。派生时没指定模型的子 Agent 用父线程的模型，并入父线程那一项；父线程的型号不明（服务的模型没有绑定到，如 `/review` 轮次）时不带 `breakdown`，只带合计。
异步提问被宿主当场拒绝（`decline` 带非空 `_meta.coda.reason`）时，交给 Codex 的是这段文字原文；不带 reason 的 `decline` 与 `cancel` 仍是「用户没有回答「<问题>」」。同步提问（`item/tool/requestUserInput`）由 codex-acp 回 `{ answers: {} }`，拿不到 reason。
