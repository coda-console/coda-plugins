# Antigravity

把 [Google Antigravity](https://antigravity.google/cli) 的 Agent 接进 Coda。清单经一个薄转发入口（`agent/entry.mjs`）启动运行机上的 `agy acp`（Antigravity CLI 的 ACP 服务），
先找 `~/.local/bin/agy`，没有再用 PATH。每个会话一个进程。

入口改六处，其余消息原样双向转发。第一处：把 `initialize` 答复里的 `additionalDirectories` 能力去掉，Coda 就不再给它传附加目录；
`session/new`、`session/load`、`session/resume` 里若仍带 `additionalDirectories` 也删掉。原因：agy 1.5.9 收到附加目录后，
没给 Cwd 的命令默认跑在**字典序最前的附加根**，而不是会话的工作副本（实测规律，不是上游的保证；数组顺序、`session/load` 都不改变它）；
不传附加目录时命令就在工作副本里跑。

第二处是虚拟模式 `full`（「全部放行」），见下面「全部放行」一节。第三处是配置探测：入口在 `initialize` 声明 `_meta.coda.probe`，
带探测标记的 `session/new` 由入口用本机的目录缓存应答，不转给 agy，见「已知限制」的「配置探测」。
第四处：agy 内部重试模型请求时会发一条 `agent_message_chunk`，整段文本形如 `⚠ API error (attempt 1): request failed: stream idle timeout (5m0s): context deadline exceeded`，
Coda 会把它存成回复正文，像答到一半出错，其实这一轮还在跑。入口不转发这一种（整段去掉首尾空白后恰为单行此格式），原文写到插件自己的 stderr；
多行或夹在正文里的同样字样照常转发。重试用尽后最终失败的那一轮怎样结束，由第六处按会话记录判断，不由这条提示判断。

第五处：agy 把跑得久的命令转到后台，ACP 上看不出来；入口只读 agy 自己的会话记录，把它们作为 `_coda/wait` 后台任务报给 Coda，见「已知限制」的「后台命令」。
agy 起的子 Agent 也同样只读它自己的文件，报成 `kind: subagent` 的 `_coda/wait`，见「已知限制」的「子 Agent」。

第六处：agy 有时在上游模型请求最终失败后仍回 `end_turn`，ACP 上看起来像正常结束；入口只读会话记录，这一轮在 ACP 上没出过任何回复文字或成功的工具结果、且记录最后一步是上游错误时，才把这一轮改以错误结束，拿不准一律照转 `end_turn`，见「已知限制」的「隐藏的失败」。

需要带会话指令兜底的 Coda（2026-11-13 部署版，coda#2500）或更新版本；旧版 Coda 不会给 Antigravity 送入会话指令。

要求 Antigravity CLI **1.5.9 及以上**：`agy acp` 从 1.5.0 才有，Auto 模式与模式保持的修复在 1.5.4，上下文用量在 1.5.8；
插件的核对（`--agent` 握手、`--live` 一轮）都跑在 1.5.9 上。

## 安装

1. **运行机装 Antigravity CLI**：插件的设置动作（`scripts/setup.mjs`）在你安装或更新插件时于每台机器上运行：没有 `agy` 就用官方安装程序装上，
   低于 1.5.9 就用 `agy update` 升级，新的不动；已有的 `agy` 跑不起来时只说明原因并失败，不替你删它。资源页「Antigravity」的「安装」是操作 `install`，指向同一个 `scripts/setup.mjs`（结果 `{}`，说明写在标准错误）。
   也可以自己装：

   ```sh
   curl -fsSL https://antigravity.google/cli/install.sh | bash
   ```

   装到 `~/.local/bin/agy`（`--dir` 可改位置）。官方安装程序在 `~/.local/bin/agy` 已存在时什么都不做，所以升级用 `agy update`；二进制自己也会在后台更新。
   自己用上面那行装，安装程序最后运行的 `agy install` 会把 `~/.local/bin` 写进已有的 shell 配置（`.bashrc`、`.zshrc`）的 PATH。
   设置动作不改你的 shell 配置：它在一个临时目录当 `HOME` 的环境里运行安装程序，并用 `--dir` 把二进制装进真正的 `~/.local/bin`，
   安装程序的暂存文件与 shell 配置改动都落在临时目录，装完即删；要让 `agy` 进终端的 PATH，自己加。
   启动命令先找 `~/.local/bin/agy`，找不到再用 `PATH` 上的 `agy`：Coda 后端服务的 `PATH` 不一定有 `~/.local/bin`。

2. **登录**，三选一：
   - **资源页**：「资源 › 添加资源」里选「Antigravity」，Coda 显示授权链接，在浏览器里用 Google 账号确认，把授权页给的授权码贴回 Coda。
   - **运行机的终端**（用运行 Coda 后端的那个账户）：

     ```sh
     agy acp --login      # 打印授权链接，贴回授权码（或落地页的完整网址），回车；成功打印「Logged in as <邮箱>.」
     ```

   - API key、Vertex 等其他认证方式：见 [Antigravity CLI 官方文档](https://antigravity.google/docs)，插件不处理。

   登录保存在这台机器的系统钥匙串里（macOS 钥匙串，条目服务 `gemini`、账号 `antigravity`；Linux 用 Secret Service），由 Antigravity CLI 自己续期。
   未登录时 `session/new` 回 -32000「Authentication required」，Coda 提示「Antigravity 未登录」。

3. **在 Coda 里装插件**：「设置 › 插件 › 从仓库添加…」，仓库填 `coda-console/coda-plugins`，读取后选「Antigravity」。
   确认里能看到会运行的命令原文：

   ```sh
   exec "$CODA_NODE" "$CODA_PLUGIN_PATH/agent/entry.mjs"
   exec "$CODA_NODE" "$CODA_PLUGIN_PATH/scripts/setup.mjs"
   ```

   装好后新任务的 Agent 选择里出现 Antigravity。插件在空间里共享，设置动作在每台机器上各装一次；装不上的那台，会话启动失败并提示清单的 `setupHint`。

## 在 Coda 里是什么样

| 设置 | 来源 |
| --- | --- |
| 模型、思考档位 | Antigravity 给的配置项 `model`、`thought_level`：Gemini 4 系列，账号里有的 Claude、GPT-OSS 也在其中。在 Coda 里切换不写回 `~/.gemini/antigravity-cli/settings.json` |
| 工作模式 | `default`、`accept-edits`、`auto`、`plan`，加上插件虚拟的 `full`「全部放行」（「工作模式」，没选时用 Antigravity 自己的默认）；清单的 `modes.manual` 指向 `default`、`modes.auto` 指向 `auto`、`modes.full` 指向 `full`、`modes.safe` 是 `["plan"]`、`modes.default` 为 `null`（Agent 报什么算什么），供委派子会话与流程步骤的「人工审批」「自动审批」「全部放行」使用 |
| 审批 | `default` 与 `accept-edits` 下跑命令发 `session/request_permission`，选项是 `allow`（allow_once）与 `deny`（reject_once），Mac 与 iPhone 出审批卡片；`auto` 对安全命令不再询问；`full` 下一律不出卡片 |
| 恢复 | Antigravity 声明 `loadSession`，后端或托管重启后用 `session/load` 接着聊 |
| skills | 读工作副本的 `.agents/skills`（清单的 `skillsDir`） |
| 上下文占用、标题 | Antigravity 报 `usage_update` 与会话标题更新 |
| 模型列表何时重读 | `~/.gemini/antigravity-cli/settings.json` 变了时 |
| 资源页 | 登录后显示一条「Antigravity」，读数是各模型组的每周、每 5 小时剩余比例与重置时间（如「Gemini 每周」「Claude and GPT 5 小时」，组与周期按报告动态给出），最后是 CLI 版本。额度来自官方的只读报告 `agy -p /usage --output-format json`（CLI 1.1.11 起支持，插件要求 1.5.9 及以上）：由 CLI 自己回答，不开会话、不花额度、不留对话，插件不读 token；这一次运行只设 `AGY_CLI_DISABLE_AUTO_UPDATE=true`，在系统临时目录里跑。整次读取给自己 25 秒（宿主只给 30 秒）：版本和额度都只用剩下的时间并留 1 秒输出，剩下不到 3 秒就不再查额度，命令失败，原因是「暂时无法获取额度：读取超时」。读数最多 8 条：额度最多 7 条，CLI 版本始终在最后。读不到额度（退出非 0、超时、报告不是成功、没有可显示的桶）时命令以非零退出，标准错误的最后一行是「暂时无法获取额度：原因」（原因是 CLI stderr 的首行，没有才写退出码），Coda 保留上一份记录，资源页显示「更新失败：原因」；缺比例、不在 0–1 内或标了 `disabled` 的桶不显示。登录状态只查钥匙串条目在不在（macOS 用 `security find-generic-password -s gemini -a antigravity`，只查条目，不读内容），也不读邮箱；钥匙串问不出来时命令同样以非零退出并写明原因，不当作登出（Linux 的细节见下）。记录命令是 `scripts/resource.mjs`，不定时（没有 `every`），资源页打开、点「刷新」和每个操作之后运行；登录了却找不到 CLI、或 CLI 低于所需版本时，记录照写：一行说明，登录与安装入口照常在；CLI 读不出版本则命令以非零退出。登录是操作 `sign-in`（`scripts/sign-in.mjs`）：运行 `agy acp --login`，把它打印的授权链接用 `coda progress` 报给 Coda（只认完整的行，两路输出各自成行；报完才算登录结束，报失败登录就失败；20 秒内没有链接就失败，原因是那时 CLI 说的最后一行），再用 `coda ask` 要授权码、写进 CLI 的标准输入；CLI 已退出就不再问，码交出后 CLI 说的话不传出 |

## 已知限制

| 功能 | 情况 |
| --- | --- |
| Auto 的审批 | Auto 对不可逆操作仍会请求审批：无人值守的子会话遇到会停下等人，要不停就选「全部放行」。官方文档说明 Auto 需要终端沙箱，企业账号与沙箱不可用的机器可能没有 Auto |
| 全部放行 | 插件自己实现，Antigravity 没有这个模式（`full`、`yolo` 回 -32602，按会话的配置项和 `_meta` 也不起效）。选了它，入口给 agy 的底层模式是 `default`，之后 agy 发来的每条 `session/request_permission`，入口直接答复 `allow_once` 的选项，不转给 Coda，所以 Mac 与 iPhone 都不出审批卡片；用 `allow_once` 而不是 `allow_always`，免得把放行写进 agy 的项目权限。选项里没有 `allow_once` 就照常转给 Coda。会话中途可以切进切出，当场生效、不重启进程；切到别的模式即停止代答，agy 自己报出别的模式（例如退出 plan）也算离开。agy 拒绝切换时，会话不进入全部放行。切换那一瞬间已在路上的审批不处理。记录在入口进程里，每个会话一个进程，重启后用 `session/load` 接着聊时回到 `default`，要再选一次。它和 agy 的 `--dangerously-skip-permissions`、settings 里的 `toolPermission: always-proceed` 不同：那两个只在进程启动时读，按进程或整台机器生效，插件都不用，也不碰你的 `settings.json` |
| 会话指令 | Antigravity 只认私有的 `_meta.antigravity.systemPrompt`，不认 ACP 标准字段；插件不处理它，由 Coda 把指令作为单独一段放在新会话第一次非斜杠命令的用户输入前面，分量不如系统提示词 |
| 插话 | 不声明：Antigravity 的原生插话会提前结束旧一轮的回复，由 Coda 停下这一轮再发出新消息 |
| 额度的口径 | 报告按模型组给额度：同组模型共享每周与 5 小时限额，不是每个模型各算一份；报告里没有套餐名。第一次在某个目录运行 `/usage` 时，CLI 会在 `implicit/` 下留一个小文件；插件固定在系统临时目录运行，之后复用，不新增会话与项目记录 |
| 后台命令 `_coda/wait` | agy 的 `run_command` 等 `WaitMsBeforeAsync` 毫秒后把命令转后台：ACP 上那张 execute 卡一直 `in_progress`、没有内容，agy 1.5.15 的 ACP 没有任何后台提示（文字或字段）。入口在 Coda 声明 `_meta.coda.waits` 时，对有未结束 execute 调用的会话每秒只读追加读 `~/.gemini/antigravity-cli/brain/<会话>/.system_generated/logs/transcript.jsonl`（从该会话第一次出现 execute 调用时的文件末尾起，更早的不看），按下面两种记录登记与结案，其余不碰。**开始**：状态 `RUNNING` 的步骤，正文 `Tool is running as a background task with task id: <会话>/task-N` 与 `Task Description: <命令>`（任务号不是 ACP 的 `toolCallId`）；按命令对到仍未结束的 execute 调用：命令与描述完全相同；只有步骤带 `<truncated N bytes>` 标记（超长步骤的中段被 agy 换掉）时，才用命令的首尾分别对上标记前后两段；符合的调用不是恰好一个（没有，或同样的命令并发了几个）就不登记，保持纯 ACP。报 `waiting`：`waitId` 是任务号，`toolCallId` 是那次调用，标题是 agy 给的 `toolSummary`（没有就用命令首行），说明是命令，`outputFile` 是步骤里 `Task logs are available at:` 给的日志（步骤里没有就按目录布局推出 `.system_generated/tasks/task-N.log`），文件不存在就不带。**结束**：`SYSTEM` 步骤里 `Task id "…" finished with result:`（其后第一处 `Command exited with code N.` 非 0 报 `failed`，否则 `done`）或 `was canceled with result:`（`cancelled`）；那次调用的 ACP 更新先到也算，按 `rawOutput.exit_code` 判：0 或没有（`completed`）报 `done`，-1（agy 取消命令的样子）报 `cancelled`，其他非 0，或 `failed`，报 `failed`；谁先到算谁，终态只报一次，ACP 更新引起的报在那张卡自己的更新之后。命令带 `IsDaemon: true`（常驻进程）的报 `awaited: false`：显示，但不挡调用完成与会话静止；其余按要等的。原来那张 execute 卡照 agy 报的样子留着，入口不替它编结果：Coda 对带 `toolCallId` 的后台任务把那张卡显示为「已转入后台」，不收束成结果未确认，工具卡本身也不挡静止（Coda 的 docs/session-contracts.md「会话静止」）。`session/close`、或 agy 进程自己退出（不是 Coda 停它）时还没结案的报 `cancelled`。读不到文件、路径不存在、不是 JSON 或格式不认识、读失败都安静地退回纯 ACP 转发，不写 stdout、不影响会话；入口只读这个文件（和下面「子 Agent」的 JSON），不读 agy 的 SQLite。不报 `handling`（任务结束后 agy 自己唤醒模型续说，入口分不清那是哪一轮）；不声明 `stoppable`（ACP 没有停单个后台任务的方法，只能停这一轮，agy 取消命令后经 ACP 更新结案）。**会漏判**：Coda 没声明 `_meta.coda.waits`；会话记录不在 `~/.gemini/antigravity-cli/brain/` 下，或 agy 换了这两种记录的文字、字段；转后台时那次 ACP 调用的命令与记录里的描述对不上（改写过，或中段被截断后首尾太短认不出）；入口启动前已在后台的任务（`session/load` 恢复的旧任务不登记）；转后台的不是 `execute` 调用（`schedule`；子 Agent 见「子 Agent `_coda/wait`」一行）；入口先于结案通知退出的任务（报 `cancelled`，不是真实结果）。记录只有 1.5.15 的样本；agy 升级后格式变了，表现是漏判，不是出错 |
| 隐藏的失败 | agy 的上游模型请求最终失败（容量、超时、断连……）时，ACP 仍可能回 `stopReason: end_turn`，Coda 看到的是一轮正常结束、没有回复。入口在 Coda 声明 `_meta.coda.waits` 与否都生效：每个 `session/prompt` 发给 agy 前记下会话记录（同上的 `transcript.jsonl`）的末尾，agy 回 `end_turn` 时读这之后新增的步骤，**最后一步**是 `source: SYSTEM`、`type: ERROR_MESSAGE` 且 `error` 有文字的，才不转 `end_turn`，改回 -32603 错误，`message` 是 `error` 原文，并在入口的 stderr 记一行。**保守判定，拿不准就照转 `end_turn`**（改成错误会让 Coda 续跑，答案已给出后再跑一轮可能重复有副作用的事）：这一轮在 ACP 上已发过回复文字（`agent_message_chunk`，不含入口截下的重试提示）或成功的工具结果（`status: completed`）的，不改；收尾这一次读记录失败（文件没了、读不了）的，不改，不拿之前读到、缓存下来的错误顶替；错误步骤之前没出现这个 prompt 的用户输入步骤（`source: USER_EXPLICIT`、`type: USER_INPUT`）的，不改（上一轮晚写入的错误落在这个 prompt 开始之后，而新一轮什么都没写；没有用户输入步骤的轮次也不改）。依据：agy 内部重试时每次失败也会写一条 `ERROR_MESSAGE`（`API error (attempt N): …`），重试成功后模型的步骤接在后面，所以只有它是这一轮的最后一步才算最终失败；`stopReason` 不是 `end_turn`（取消等），或最后一步是别的（模型的回答；工具调用自己的 `status: ERROR` 步骤，如用户拒绝了权限，本机有一个会话就以它收尾），都不算。文字符合 `<状态> (code 5xx):`（1.5.15 的样本是 `UNAVAILABLE (code 503): No capacity available for model …`）的，错误带 `data._meta.coda.failure = {kind: "service_unavailable", input: "accepted"}`，由 Coda 按 15、30、60 秒重试；其余（超时、断连、额度……）是普通错误，不自动重试。**只认 1.5.15 的样本**：本机 115 个会话里有 34 条真实的 `ERROR_MESSAGE` 步骤（503 容量不足、流空闲 5 分钟超时、连接被重置、「The stream was interrupted」），它们后面全都接着模型的步骤（重试成功了）；「最后一步就是它」的真实记录本机没有，这条判据来自 T3 Code 读 agy 数据库的同一做法（它的最后一步类型是 `CORTEX_STEP_TYPE_ERROR_MESSAGE`）。**会漏判**：agy 回 `end_turn` 时记录还没写到那一步（入口不等）；这一轮已在 ACP 出声但随后真的失败（保守不改）；轮次没有用户输入步骤（保守不改）；agy 换了步骤类型或字段；会话记录读不到、格式不认识、读失败（都安静地照 ACP 的回答转发）。**会误判**：错误之后 agy 没再写步骤、这一轮却是它自己认为正常的结束（没见过） |
| 子 Agent `_coda/wait` | agy 的 `invoke_subagent` 起的子 Agent 在 ACP 上只有一张工具卡，卡结束了子 Agent 还在跑。入口在 Coda 声明 `_meta.coda.waits` 时，在一个 prompt 回答期间每秒、回答时、之后只要还有子 Agent 在跑每秒，只读会话目录 `.system_generated/` 下两处纯 JSON：`subagents/<子会话>.json`（`state` 为 `SUBAGENT_STATE_ALIVE` 或 `SUBAGENT_STATE_KILLED`，`subagentDescriptor.role`、`typeName`）和收件箱 `messages/*.json`。入口第一次看到这个会话的 prompt 时就已有的子 Agent 与消息不算（那是以前的）。新出现且 `ALIVE` 的报 `waiting`：`kind: subagent`，`awaited: false`（不挡会话静止：见下面「结案可能不到」），`waitId` 与 `childSessionId` 都是子会话 ID，标题是 `role`（没有就用 `typeName`），说明是子会话收件箱里 `invoke_subagent` 那条消息的正文（派给它的任务，读不到就不带）。结束只认明确的信号：系统发到本会话收件箱的 `Subagent <ID> has gone idle.` 报 `done`；子会话自己发来的消息（进展、提问、汇报）分不出是不是做完，不结案；记录里的 `state` 变成 `KILLED` 报 `cancelled`；变成没见过的值不结案（第一次看到时就不是 `ALIVE` 的，也不登记）；`session/close` 或 agy 进程自己退出时还在跑的报 `cancelled`。不带 `toolCallId`（`invoke_subagent` 在 ACP 上的 `toolCallId` 与 agy 记录里的调用号是否一致没有样本），不带 `model`，不声明 `stoppable`（ACP 没有停一个子 Agent 的方法）。`childSessionId` 让 Coda 认得这个会话：agy 不经 ACP 报子会话的过程，入口也不替它编，所以委派清单里点开没有过程。**会漏判**：没声明 `_meta.coda.waits`；agy 换了这两处文件的位置或字段；子 Agent 闲置之后又被主 Agent 叫醒继续干（入口只登记一次，不按协议第 5 条用新 `waitId` 再登记）；在 agy 自己唤醒模型的一轮（不是 Coda 发的 prompt）里起的子 Agent，要等下一个 prompt 才发现；入口启动前已在跑的子 Agent。**结案可能不到**：本机样本里五个子 Agent 都发了最终汇报，会话里只有一条 `gone idle` 通知（出在其中一个中途等指引时），记录里的 `state` 到样本时也仍是 `ALIVE`；这样的子 Agent 入口收不到结束信号，会一直报在等，直到 `session/close` 或 agy 进程结束（报 `cancelled`）；所以一律报 `awaited: false`，它在委派清单里显示，但不挡会话静止，父会话可以照常结束这一轮。字段类型不对的记录：标题只取字符串字段，处理出错的那一条跳过，不影响会话与别的子 Agent。只有 1.5.15 的样本（一次起五个 `research` 子 Agent 的会话） |
| 没做：待回复、子会话过程、数据库 | **待回复**（agy 在任务或子 Agent 完成后自己唤醒模型续说，T3 Code 靠收件箱里未读的高优先级消息、或记录末尾没有后续模型步骤的 `SYSTEM_MESSAGE` 认出）：Coda 的对应是 `handling`，要在 prompt 之外报「在处理哪一项」并在这一轮结束时放开，入口看不出 agy 的这一轮什么时候结束，也没有 agy 在 prompt 之外经 ACP 推更新的样本；报错了会让 Coda 一直占着一轮自主轮次、用户的消息排队。**子会话的过程**（子 Agent 自己的步骤作为那个会话的 `session/update`）：要把子会话的 `transcript.jsonl` 翻成 ACP 更新，子会话能否经 ACP 恢复也未验证。**`conversations/<ID>.db`**（SQLite，步骤载荷是 Protobuf；T3 Code 靠它读 `INVOKE_SUBAGENT` 步骤里的子会话与启动文字、压缩步骤等）：需要 `node:sqlite` 与手写的 Protobuf 字段号（来自 agy 私有的 `exa.cortex_pb`，没有公开定义，随版本变）；现在要的信息都能从上面的 JSON 拿到，不值得吃下这份依赖和破损风险。「压缩上下文不上报 Coda」一行同理 |
| Plan 模式 | 产出计划文件并要求审阅，审阅前不动手；plan 下只读的 shell 命令也按权限规则请求审批，这是 agy 的设计 |
| 删除会话 | 不支持：agy 1.5.9 的 ACP 没有 `session/delete`（回 -32601），`session/close` 也不删除。在 agy 历史里留下零步空会话的只有两种：不支持配置探测的旧版 Coda 每次普通探测建的会话，和插件缓存采集目录时自己建的那条，见「配置探测」。插件不自己删文件：那会绕过 agy 的取消、摘要缓存和搜索索引，agy 运行中删也不安全；等上游提供删除接口再接 |
| 附加目录 | 不交给 Antigravity：读工作副本外的附件、会话临时目录、skill 真实文件可能要审批；`.agents/skills` 的链接照旧 |
| Coda 的 MCP 工具在 auto 下也要审批 | 无人值守的子会话、流程步骤调用它们会停下；「全部放行」下不会。要在 auto 下放行，写法是在运行机的 `~/.gemini/antigravity-cli/settings.json` 里加 `{"permissions": {"allow": ["mcp(coda/*)"]}}`，出处是官方[权限文档](https://antigravity.google/docs/permissions/)；插件不替你改这个文件 |
| 压缩上下文不上报 Coda | Antigravity 会压缩上下文：`/compact` 在 `agy acp` 1.5.9 上实测会跑一次摘要，对话库里留下摘要步骤；二进制里也有按 token 阈值触发的压缩配置，自动压缩没有实测触发。但 ACP 流和 `acp-server` 日志都不报压缩（没有 `compaction_update`，也没有专门的通知或工具调用），唯一的痕迹在它私有的对话库里，入口不读它，也不从文本或用量反推。所以依赖压缩的功能（如 Ultra 压缩后重发说明）在它上面压缩后不生效 |
| 额度耗尽 | 没有真实样本，不做失败分类，Coda 只看到 Antigravity 给的错误文字（ACP 报出的，或「隐藏的失败」从会话记录里读出的） |
| 没有桌面会话的 Linux 登录 | 未实测：Linux 用 Secret Service（D-Bus），二进制里有「keyring 失败就落文件」的回退，但文件路径与触发条件没查清。资源页在 Linux 上用 `secret-tool lookup service gemini username antigravity` 查条目（属性名按 go-keyring 的写法，未在真机上试过），没有 `secret-tool`、查不到条目，或登录落在文件里时，资源页当作未登录（只是仍在「添加资源」里出现，会话不受影响）。装了 `secret-tool` 却联系不上 Secret Service（典型是没有会话 D-Bus 的无桌面机器，它带错误信息退出）时，资源页读取失败，原因是「读不了 Secret Service」，在这样的机器上要在终端里运行 `agy acp --login` 登录 |
| 第三方模型 | 账号里的 Claude、GPT-OSS 未实测 |
| 配置探测 | Coda 读模型、思考档位与模式的目录时，入口用插件状态目录里的缓存（`$CODA_PLUGIN_STATE/catalog-v1.json`）答一个只在当前连接有效的虚拟会话（`coda-probe:` 开头，不接受 prompt、不能恢复、断线即释放）：**缓存命中时不建 Antigravity 会话**。缓存不按天数过期：距上次采集或比对满 1 小时后，下一次探测先跑一次 `agy models`（不建会话，约 2～3 秒，限时 8 秒），把它列出的模型（ID 与名称）和采集时记下的清单比对，一样就只记下比对时间（`catalog-v1.check.json`），不一样才重读；`agy models` 失败（未登录、断网、超时）时照旧用缓存，5 分钟后再比对，不因此重读；旧版插件留下的没有清单的缓存，在 `agy models` 第一次答上时重读一次。此外 agy 的路径或版本、`~/.gemini/antigravity-cli/settings.json` 变化、真实会话报的配置与缓存对不上时也重读。重读用一个独立的 `agy acp` 建一条空会话逐个模型读一遍（agy 1.5.9 删不了会话，这条会留在 `~/.gemini/antigravity-cli/conversations/`，会话 ID 记在 `catalog-v1.log`）。读失败时这次探测报错、不改用普通会话，同样的 agy 与设置 5 分钟内不再重读（未登录除外）；比对发现变化而重读失败时照旧用原缓存答。要支持配置探测的新版 Coda 才生效；旧版 Coda 每次探测仍各建一条空会话 |
| 并发进程 | 不加 `--process-per-session`：Coda 交给 Agent 的 MCP 服务器都是 stdio，官方只对 HTTP MCP 要求这个参数 |

## 验收

```sh
coda plugin check plugins/antigravity                     # 默认只读静态校验：清单、贡献点、BPMN 等，不执行插件代码
coda plugin check plugins/antigravity --resources         # 执行资源记录命令，读数合格式
coda plugin check plugins/antigravity --agent             # Agent 握手：protocolVersion 1，session/new 给出会话与当前模型
coda plugin check plugins/antigravity --agent --live      # 完整对话轮次：会话指令、回复、取消、session/load
```

然后在 Coda 里：发一句话收到回复；选 plan 出计划文件并停在审阅；选 default 跑一个要审批的命令，Mac 与 iPhone 都出卡片；选 auto 跑安全命令不再询问；选「全部放行」跑 `rm -rf`、写工作区外文件、调 MCP 工具都不出卡片，再切回 default 又出卡片；
重启后端后接着聊（`session/load`）；资源页登录一遍（贴授权码）。
