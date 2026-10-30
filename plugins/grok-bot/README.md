# Grok Bot

让运行在 xAI 云电脑上的 Grok Bot 成为 Coda 中长期保留的会话。插件与 Agent ID 都是 `grok-bot`，与已有的 Grok CLI 插件 `grok` 分开。

## 前提与安装

依赖 Coda 仓库的[远端 Agent 入口 #2006](https://github.com/coda-console/coda/pull/2006)：远端能力协商、绑定码、HTTP 入口与 `_coda/remote` 转发；[遥测 JSON 接口 #2004](https://github.com/coda-console/coda/pull/2004) 与[机器诊断工具 #2003](https://github.com/coda-console/coda/pull/2003) 配套提供观测数据，诊断工具由不默认安装的 Coda 内置插件「机器诊断」提供，MCP 服务器名为 `diagnostics`；需要在 Coda 里安装并为 Bot 所在目录启用。本插件可独立通过握手检查，旧版 Coda 发消息时会提示升级。

在 Coda 从仓库 `https://github.com/coda-console/coda-plugins.git` 安装 `plugins/grok-bot`；发布后也可安装 `@coda-console/grok-bot`。
创建一个名为「Bot」的空目录，添加到 Coda，每个 Bot 在其中建立一个 Grok Bot 会话。Coda 运行机需要 Node 24（使用 Coda 自带 Node）；云电脑脚本需要 Node 22 或以上。

1. 给会话发消息，取得十分钟有效的绑定码和可直接贴给 Grok Bot 的安装说明。入口地址为空时先在 Coda 配好远端入口，再取新码。
2. Bot 下载 `remote/coda-bot.mjs` 到 `/workspace/.coda-bot/coda-bot.mjs`，运行 `node coda-bot.mjs net`，按需完成 Tailscale 登录，然后 `node coda-bot.mjs bind <address> <code>`。后端入口需在云电脑可达的 tailnet 中。
3. 在 Bot 设置中添加自定义 MCP 服务，命令 `node /workspace/.coda-bot/coda-bot.mjs mcp`；读取并安装同目录的 `remote/SKILL.md`。
4. 可选：在 Grok Bot 的应用里连接 GitHub。巡检定位问题时，Skill 会用它读 coda、coda-state、coda-plugins 的代码并在汇报里写明文件与行号；Skill 只让它读，改代码仍经 Coda 卡片批准后由 Coda 的 Agent 做。
5. 建两个 Routine：Webhook 触发处理 Coda 消息；定时巡检按 Skill 调只读工具，没发现问题不说话。
6. 把 Webhook 地址与 Bearer key 填到插件设置 `grok-bot.bots` 的同一行，行名为 Bot 名，key 是 writeOnly 密文。会话选择「这是哪个 Bot」。key 需要传递时使用 Grok 密钥卡片，不贴聊天。设置变更后重开会话，让进程读到新的设置环境。

同账号的 Bot 共用电脑。`config.json` 保存多会话绑定；多个绑定时每个 MCP 命令必须追加自己的 `sessionId`，例如 `node /workspace/.coda-bot/coda-bot.mjs mcp <sessionId>`；不指定时明确报错，绝不任选一个。重新 bind 同一会话会撤销旧 token，并原子更新对应记录。文件权限 0600，目录 0700。切换到另一个已命名 Bot 后需重新绑定。
已绑定会话可发送 `/bind` 获取新绑定码，例如云端配置丢失后重新接入。

脚本与 Skill 的默认下载地址是本仓库 main 的 GitHub raw URL；草稿 PR 验证时改成这个 PR 的提交 SHA，合并前 main 没有这些文件。新 npm 包首次发布须按仓库 README 的 bootstrap/Trusted Publishing 步骤配置，由维护者执行。

升级到 0.1.3 时，已绑定 Bot 也须更新云电脑上的 `coda-bot.mjs` 与 Skill，并重启 MCP 服务以提供 `coda_input`。仅更新 Coda 插件不足以处理新的 Webhook 正文格式。

## 设置与生命周期

会话的「派出的 Agent」默认「要你批准」，可切到「自动」，也可切回人工。想让派出的 Agent 不再要求用户逐次点审批，就把这个选项设为「自动」；Coda 会为子 Agent 选择它自己的自动档位（如 Codex 的 agent 档位，由自动审核按风险判断越权操作）。这个设置只影响派出的 Agent，Bot 自己开 Agent、给别的会话发消息仍由 Coda 授权卡片批准。适配器通过 ACP modes / session/set_mode 报告和切换档位；选择由 Coda 保存并在恢复后重新应用，不写入插件绑定文件。

| 设置 | 作用 |
| --- | --- |
| `grok-bot.bots` | Bot 名到 `{webhook, key}` 的表格；key 经 `CODA_PLUGIN_SECRETS` 中的文件路径读取 |
| `grok-bot.telemetry` | 看板 HTTP(S) 基地址，无默认值；只允许 GET `/api/` 路径，不跟随重定向 |
| `grok-bot.turnTimeout` | 默认 `PT30M`；从消息开始或自主轮次开始计时，包含 Webhook、审批与工具等待 |

仅在绑定或选择、切换 Bot 时，将 Bot 选择与绑定状态写入 `CODA_PLUGIN_STATE`；创建和恢复会话不写文件，读取模型和配置项的探测不会留下状态文件。恢复没有状态文件的会话时按未绑定处理。会话指令只保留在内存，由 Coda 在 session/new、session/load 时提供，不落盘。初始化声明 `loadSession`、`sessionCapabilities.systemPrompt`、`_meta.coda.waits` 和 `_meta.coda.remote`。
会话指令只经 `hello`（绑定时）返回，可重复获取；响应丢失、重新绑定或切换 Bot 都不会清空指令，不再随 Webhook 发送。
消息以 `{source:"coda", sessionId, turn, kind, preview}` POST 到 Routine。preview 只含正文前 500 个 Unicode 字符，截断时追加「……（完整内容用 coda_input 取）」；kind 根据可识别的 Coda 前缀区分 result、notification，其余为 message。Bot 每次必须先用 `coda_input(turn)` 取完整正文，再做事。完整输入只在内存中保留，轮次结束后仍可读，下一轮（包括自主轮次）开始即替换；进程重启后不可恢复。Bearer key 只送到配置的地址，禁止重定向。HTTP 200 只确认触发，`say` 输出、`done` 完成本轮。失败不自动重发，避免重复操作。
取消会立即回 `cancelled`；超时说明原因后结束本轮。两者都不保证云端停止。旧 turn 的输出被拒绝；Coda 发起的轮次必须带 turn，省略它不会混入新一轮。

会话加载时登记 recurring timer。Bot 主动 say 先报 handling，再输出；done 回 waiting。只读调用若没有轮次只写标准错误审计，不开启空轮次；轮内通过 `tool_call` / `tool_call_update` 留下输入与结果。
副作用调用由适配器向 coda MCP 的 status 取 turn 票据并生成 requestId，授权与通知复用 Coda 会话机制。`spawn` 必须指定目标 `project`，缺失直接拒绝（Bot 的空目录没有代码）；开 Agent、给别的会话发消息由 Coda 的授权卡片批准。给自己开出的子会话补充是已批准任务的延续，不另问；`cancel` 只能停自己开出的子会话，由 Coda 校验归属，不另问。适配器不另发审批卡片，工具范围之外全部拒绝。

`spawn`、`send`、`cancel` 的 requestId 由本轮 ID、工具名和规范化参数的 SHA-256 生成 UUID；对象键递归排序，数组顺序保留，参数顶层的 turn/requestId 不参与计算。同一轮内参数等价的重试复用同一 ID，由 Coda 恢复原调用；改参数或换轮次会得到新 ID。
`spawn`、`send` 提交给 Coda 后，超过 20 秒仍未返回就先回复「已提交，正在等用户在 Coda 卡片上批准；结果会作为新消息送来；不要重试或轮询」。阈值为适配器的 `SUBMISSION_WAIT_MS` 常量。原调用在后台继续，真实结果才完成工具记录；原轮次结束后的结果只记日志。收到回执后可 coda_done，等待批准的子会话不在 status.children 中不代表失败，不要改写同一任务重复派出。

## 远端协议与调试

绑定：`POST /v1/remote-agent/bind {code}` 得到 token；脚本再经带 Bearer token 的 `POST /v1/remote-agent {method:"hello",params:{}}` 确认绑定、取 sessionId 和初始会话指令。token 不进终端输出。
Coda 将 HTTP 调用包装成 `_coda/remote {sessionId,method,params}`；插件结果和 JSON-RPC 错误原样交回。脚本不重试 401、409、502、504 或其他失败。

| 方法 | 参数与返回 |
| --- | --- |
| `hello` | `{}` → `{sessionId, bot, instructions}`，bind 完成时调用；幂等读取指令 |
| `input` | `{turn}` → `{turn, kind, text}`，读取本轮完整正文，不开启轮次 |
| `say` | `{text, turn?}` → `{turn}`，首次主动汇报可省略 turn |
| `done` | `{turn?}` → `{}`，等待工具全部返回后调用 |
| `tool` | `{name, arguments, turn?}` → Coda MCP 工具结果 |
| `telemetry` | `{path, query?, turn?}` → 看板 JSON 原样返回 |

会话建立与恢复时，仅为 mcpServers 中收到的 `coda` 和 `diagnostics` 启动 stdio MCP 客户端，用各自 `tools/list` 建立路由，只保留白名单。`machines`、`machine_diagnostics` 由「机器诊断」插件的 `diagnostics` 提供；未收到该服务器时不启动额外进程，调用这两个工具会提示「这两个工具需要在 Coda 里安装并为这个目录启用『机器诊断』插件」。服务没列出工具时明确报不可用，不转给 coda。其余只读工具：read_thread、read_tool_call、agents、status、workflow_status、workflow_list；副作用工具：spawn、send、cancel。工具名冲突拒绝调用。Bot MCP 以 `coda_` 前缀暴露这些工具，加 coda_input、coda_say、coda_done、coda_telemetry。
调试：`node coda-bot.mjs call <method> '<JSON>' [sessionId]`。本轮 ID 与 status 的 Coda turn 票据不同，Bot 只传前者，适配器取得后者。

`coda_machine_diagnostics` 的参数直接传入：`machine` 为 ID 或唯一名字，`kind` 为 network / client-performance；`from`、`to` 为 Unix 毫秒数，`days` 为 1–30 的整数，另有 `limit`（1–500）、`client`、`verdict`。client-performance 只支持 days；network 的 from/to 选择分钟样本，其余参数筛选探测报告。

`net` 只通过 `/workspace/.coda-bot/tailscale/tailscaled.sock` 检查持久守护进程；未安装时运行[官方安装脚本](https://tailscale.com/install.sh)。首次接入会停止系统 tailscaled 服务与原进程，等状态写完后从 `/var/lib/tailscale` 迁移到 `/workspace/.coda-bot/tailscale/`，按 [tailscaled 参数](https://tailscale.com/docs/reference/tailscaled) 从该目录启动；后续登录也写入这里。已有的持久登录状态在系统目录丢失后仍可恢复。需要 Debian 自带的 start-stop-daemon 和免密 sudo；状态恢复使用 flock 协调同账号多个 Bot。登录链接写给用户，MCP 标准输出只有 JSON-RPC。每个 MCP 工具调用前做检查。Running 快速路径额外检查一次持久状态文件；若副本缺失且系统状态文件存在，在同一 flock 锁内重新检查并复制，已有副本不覆盖。

## 验证范围

`test/plugins/grok-bot/` 使用假的 ACP Coda 对端、独立的 coda/diagnostics stdio MCP 服务、HTTP Webhook/远端入口和注入时钟；不需要账号或真实业务等待。仓库契约测试包含新插件握手。回归覆盖 hello 响应丢失后重新绑定、切换 Bot、遥测控制字符与路径越界；Tailscale 恢复脚本在假的系统命令下实际运行，验证已登录状态迁移、迁移后登录、系统目录丢失后的恢复和停止失败，不启动真实守护进程。
0.1.3 的回归还覆盖：等价副作用调用复用 requestId、假时钟推进后的提前回执与后台收尾、长正文经 coda_input 完整读取、输入保留和失效边界，以及自动／人工档位切换后仍由 Coda 授权 Bot 的派活与发消息。本次修复尚未在真 Grok Bot 上复测；真实 Routine 投递、云端工具超时和子 Agent 的审批档位继承仍需真机验证。
