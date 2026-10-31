# Coda 插件

Coda 的公开插件仓库，和给插件作者用的契约检查。Coda 自带的 Agent 插件（Codex、Claude、Kimi、Grok、OpenCode 与 Codex 多账号）和 PR 生命流程也在这里维护。

Coda 是一个多 Agent 客户端（Mac、iPhone 与运行在你机器上的后端）。Agent 与资源页的面板都以插件接入：
插件是一个目录，清单就是它的 `package.json`（`contributes.agents`、`contributes.panels` 等，照 VS Code 扩展的写法）；
Agent 讲 [ACP](https://agentclientprotocol.com)，外加 Coda 的 Agent 活动报告 `_coda/wait`，见 [接入协议](https://github.com/coda-console/coda-protocol/blob/main/docs/agent-protocol.md)。
插件清单的类型、它们的 schema 与接入协议都在协议包 `@coda-console/protocol`（[coda-console/coda-protocol](https://github.com/coda-console/coda-protocol)）里；本仓库文中与代码注释说的 `docs/agent-protocol.md` 指那里的那份。

```
plugins/codex/           Codex：入口在同一进程里运行锁定版本的 codex-acp（npm 依赖），面板「Codex」
plugins/claude/          Claude SDK：基于 Claude Agent SDK 的 ACP 入口（npm 依赖），面板「Claude」
plugins/kimi/            Kimi Code：在运行机的 kimi acp 与 Coda 之间转发，面板「Kimi」
plugins/grok/            Grok：转发运行机上 Grok CLI 的 ACP，并适配审批模式，面板「Grok」
plugins/grok-bot/        Grok Bot：把 xAI 云端 Bot 接成长期会话，原生主会话、Grok Routine 运行记录与用户审批；数据工具依赖 Coda 远端 Agent 入口
plugins/opencode/        OpenCode：在运行机的 opencode acp 与 Coda 之间转发，送入会话指令与所选模型服务，模型按来源分组
plugins/codex-accounts/  Codex 多账号：管理登录、自动续期与账号选择，接管 Codex 额度面板
plugins/cursor/          Cursor：在运行机的 cursor-agent acp 与 Coda 之间转发，送入会话指令
plugins/host/            宿主资源：Xcode 构建、Apple 模拟器与项目要求排队的命令共用这台机器的一组名额（组 host、持锁执行 run-held、host-sim），面板「构建与模拟器名额」
plugins/magpie/          Magpie：把本机的 Magpie 网关作为模型服务提供给 Pi 等插件，安装时装好 Magpie 并让网关常驻
plugins/network-log/     网络记录：默认关闭，按需开启建连等待与定时探测采集；关闭后仍可查看历史
plugins/review/          PR 生命流程：会话开的 PR 先跑项目的检查、再交叉评审，你批准后合并、部署与发布；也是写 PR 流程的样例
plugins/testbed/         测试机：长插在 Mac 上的 iPhone、iPad 只经 use-testbed 使用，排到后装 App、交给会话操作、用完切黑屏；依赖宿主资源
plugins/ultra/           Ultra：输入框的 Ultra 模式，主 Agent 主动把能并行的活按名单派给子会话，汇总后验证；名单与模板在模式参数和设置里
templates/agent/         最小的 Agent 插件：手写 ACP 的回声 Agent，演示会话指令、插话、Agent 活动与自主轮次
templates/panel/         最小的面板插件：一张卡片、一条进度条、一个按钮
bin/、check/             契约检查（仓库根的 package.json 就是它，@coda-console/plugin-check）；check/coda/ 是 Coda 同步来的规则副本，不要手改
test/                    检查包的测试；test/plugins/ 是各插件的测试（插件目录里只放运行要用的文件）
.coda/workflows/         本仓库自己的流程：sync-coda 等新版本发到 npm，再给 Coda 开升级依赖的 PR
```

## 商店

Coda 插件页的「商店」列出 Coda 自带的插件，以及 npm 上 `@coda-console` 下的包（Coda 的 docs/plugins.md「商店」）：
本仓库的插件合进 main 后发布为 `@coda-console/<id>`（[npm 发布](#npm-发布)），发出来就在商店里，不用另写索引。

- **分类**写在插件清单的 `categories` 里（照 VS Code，取第一个），只用这几个，Coda 的插件页按它分组：`Agent`、`模型与账号`、`工作流程`、`机器与资源`、`Skills 与工具`。
  `npm test` 里的 `test/categories.test.mjs` 核对本仓库的每个插件都写了；契约检查对没写的、写了别的给出提醒。
- **下架**：给它的最新版标 `npm deprecate`，商店就不再列它。
- 别处的插件（别的仓库、别的 npm 包）不在商店里，用户在 Coda 里填仓库地址或包名添加。

## Coda 自带的插件

`codex`、`claude`、`kimi`、`grok`、`opencode`、`codex-accounts`、`review` 是 Coda 内置的插件，源码从此在这里维护。
合进 main 后它们发布为 npm 包 `@coda-console/<id>`（[npm 发布](#npm-发布)），Coda 后端的 `package.json` 把它们写成钉住版本号的依赖，
随后端的 `npm ci` 装好，新机器首次启动就带着它们。

- **改它们先在这里提 PR、合并**，发布流程发出新版本后，再让 Coda 把依赖升到那个版本（Coda 的 docs/development.md「coda-plugins 维护的内置插件」）。
  升依赖由本仓库的部署流程 `sync-coda`（`.coda/workflows/sync-coda.bpmn`、`scripts/sync-coda.mjs`）做：合并时勾选「部署」，它在合并提交上先等
  `publish.yml` 跑完、npm 读得到这个提交的版本（发布失败就带着那次运行的地址失败），再把 Coda 用到的包升到这些版本（只升不降）、照抄插件的 `overrides`，
  推到 Coda 的分支 `sync/coda-plugins` 并开 PR（开着的就只更新），PR 由开这边 PR 的会话负责、走 Coda 的 PR 流程；Coda 已是这些版本就什么都不做。
  也可以单独发起，同步默认分支的最新提交。
- **改了哪个插件就升哪个插件的 `version`**（`plugins/<id>/` 下任何文件，含 `package-lock.json`；只改 `test/` 不用）：Coda 的插件页与遥测按版本认插件。
  CI 在 PR 上运行 `node scripts/check-versions.mjs origin/<目标分支>` 核对；Dependabot 升 CLI、SDK 的 PR 也要补一个升版本的提交。
- Coda 的「检查更新」可以从 npm 装同一个包的新版本，盖过 Coda 带的版本；只有 `@coda-console/<id>` 这个包能用这些名字。
- 测的是插件自己代码的用例在 `test/plugins/<id>/`；把 Coda 与入口合在一起测的（启动 Coda 后端、写进 Coda 的存储）留在 Coda，对它装的 npm 包跑。
  `review` 是一个流程，要 Coda 的流程引擎才跑得起来，它的用例都在 Coda。

| 插件 | npm 依赖（与 Coda 后端同版本） | 运行机上另要 |
| --- | --- | --- |
| `codex` | `@agentclientprotocol/codex-acp` 1.12.0、`@openai/codex` 0.162.1；`overrides` 让 codex-acp 用同一个 `@openai/codex` | — |
| `claude` | `@agentclientprotocol/sdk` 1.4.0、`@anthropic-ai/claude-agent-sdk` 0.3.296（平台二进制是 SDK 自己的可选依赖） | — |
| `codex-accounts` | `proper-lockfile` 4.1.2；用依赖插件 `codex` 的 Codex CLI | 无；依赖 `codex` 插件 |
| `kimi` | 无 | Kimi CLI 2.1.1 及以上（设置动作安装或升级；面板可从 Coda 安装、登录） |
| `grok` | 无 | Grok CLI 1.0.52 及以上（设置动作安装或升级；面板可从 Coda 安装、登录） |
| `opencode` | `jsonc-parser` 3.3.1 | 已登录的 OpenCode CLI 2.1.4 及以上（设置动作安装或升级，OpenCode 1 升到 2） |

带依赖的插件各有自己的 `package-lock.json`（`node_modules` 不提交）；Coda 在插件的版本目录里 `npm ci` 装它们，
这几个插件不是本仓库根的 npm workspaces（根包是契约检查，装它不该带上 Codex、Claude 的平台二进制）。

### 会话指令与设置动作

Coda 的会话指令（`systemPrompt`）各插件都声明并接受，只接受 `append` 模式的文本块，其他回 -32602、不建立会话：
Claude 追加在 `claude_code` 预设的系统提示词后面；Codex 经 `thread/start`、`thread/resume` 作为 `developerInstructions` 交给 Codex，
接在会话目录下 Codex 自己配置的 `developer_instructions`（`config/read`）后面
（codex-acp 按 ACP 的 schema 读请求会丢掉 `systemPrompt`，入口改放在请求的 `_meta` 里交给打过补丁的 codex-acp）。
Kimi、Grok、OpenCode、Cursor 的 CLI 不接受它：入口不转给 CLI，在 `session/new` 建立的原生会话第一次 `session/prompt` 时，
把指令包在 `<coda-session-instructions>` 里作为单独的一段文本放在用户输入前面，之后与 `session/load` 恢复的会话不再送；
第一条是斜杠命令时留到下一条。Codex 与 Claude 另声明插话：一轮已经结束时收到的 `_session/steering` 回 `promptRequired`，不另开一轮。
Claude 把一轮进行中的插话标上 `priority: 'next'` 交给 Claude Code，回 `injected`：Claude Code 在这一轮的下一个工具间隙把它并进去，
不打断正在跑的工具；这一轮没再调工具就结束时，Claude Code 紧接着为它另跑一轮，入口把那一轮也算进原来的 `session/prompt`，跑完才答复。
这一轮被停止或失败时，还没并进去的插话随之撤掉（`interrupt` 带 `cancelQueued`），不会在之后再跑，原来的 `session/prompt` 等撤掉了才答复。
结果最多列出 64 条它接收的消息，所以同时在途的插话最多 32 条，再多的回 `promptRequired`，由 Coda 在这一轮结束后作为下一轮发出。

Claude 的工具调用与审批卡片按原生工具名报告 ACP `kind`，读写文件带 `locations`，Read 的 `offset` 对应起始行。
执行标题取命令第一行，搜索与联网标题取模式、查询或 URL（最多 200 字符）；没有相应输入时保留工具名，`rawInput` 始终原样保留。
Edit、MultiEdit 与 Write 的输入生成标准 `diff`，工具结果更新同时保留 diff 与原有结果文本；NotebookEdit 只报告路径，不把单元格源码当成整个笔记本的 diff。
计划工具归 `think`，Task/Agent 子 Agent、MCP 与未知工具归 `other`，子 Agent 的活动卡片沿用原有报告。

Claude 的额度耗尽按[执行失败](https://github.com/coda-console/coda-protocol/blob/main/docs/agent-protocol.md#额度不足)报 `quota_exhausted`，保留上游给出的重置时间；
只认明确的额度原因，或本轮 `rate_limit` 错误配合订阅窗口的 `rejected`，不把普通 429、登录失败或额度预警算进去。
SDK 作为 `assistant` 消息发来的 API 错误不当成回复正文；由本轮 `result` 报告失败。
后台结果或定时唤醒后的自主轮次没有 `session/prompt` 可回复，失败时以自己的活动卡片报 `failed` 和原因，额度耗尽的卡片标题为「额度不足」；
唤醒它的任务保留任务自己的结果，周期定时保留下次触发。

OpenCode 遇到模型服务的 429，会照 `Retry-After` 等（OpenCode 2 每次最多 15 分钟、最多 10 次），并在 ACP 里用 `session_info_update` 的
`_meta["opencode/retry"]` 说下次什么时候重试、服务报了什么。子 Agent（OpenCode 的 `subagent`）从子会话事件报告等待，入口保留它所属的 ACP 轮次与发起调用：
只有当前轮次仍沿前台调用链等待它时，才按主轮次处理重试；后台、已返回、跨轮次或无法确定归属的子会话只转发状态，不取消主请求。
子会话事件没有发起工具的 ID，同时有多个可能的调用时，仅在它们全部仍是同一轮的前台调用时才处理，无法确定的长等待仍由 OpenCode 自己管理。
Coda 自己对服务故障只等一分钟以内，所以主请求或它仍在等待的前台子会话要等超过一分钟才重试时，入口先 `session/cancel` 停下这一轮（前台子 Agent 随之停下），
再把这一轮答成失败，原因是服务给的原文加上 OpenCode 要等多久；停下后 OpenCode 回的是什么都不转出。一分钟以内的等待照旧由 OpenCode 自己处理。
不在入口里按厂商的错误文字判断额度耗尽。
明确的 `[ttft_admission_refused] the cell is at capacity` 容量拒绝在停下原生轮次后报告为 `service_unavailable`，
带 `input: accepted` 与 OpenCode 实际安排的剩余等待 `retryAfterMs`；Coda 按该等待决定是否重试，长等待以已知失败结束。
保留服务原文（其中建议的短等待也原样保留），不把它当成 OpenCode 的实际重试时间，不把普通 429 或认证失败归为容量拒绝。

OpenCode 的原生子会话经 ACP 的 `opencode/child-session-updates` 能力接入（入口 `agent/children.mjs`，核对 OpenCode 2.1.4）：
`opencode/session/child_update` 的创建与运行状态登记成 `_coda/wait`，带原生 `childSessionId`；子会话的回复、思考与工具调用各归自己的过程，
嵌套子会话归发起它的子会话。主会话答复以后仍保留后台子会话，收到原生完成、失败、被中断事件才了结；错误原文留在卡片详情。
审批从 OpenCode 附带的 `opencode/child-session` 元数据归到子会话，审批响应的身份不变。
停止按钮走 `session/close`：OpenCode 的这个接口中断原生会话而不删除历史；`session/cancel` 只能取消 ACP 正在执行的 prompt，不能单独停止原生子会话。
上游再次报告同一子会话开始执行时，用新的 `waitId` 登记同一张卡片的下一次运行。

这条接口的边界也沿用 OpenCode 2.1.4：它只跟踪当前 ACP prompt 里新建的子会话，恢复历史或在后续 prompt 续用已有子会话时不补发它们的过程；
后台子会话结束后主 Agent 自主继续的输出也不经此接口发来，所以入口不凭子会话完成事件自造 `handling` 轮次。
原生表单提问没有子会话身份元数据，仍显示在主会话。以上需要上游补充事件；普通 Coda `spawn` 的独立会话不受这些限制。
协议公开副本记录的是同步时的插件行为，OpenCode 当前的接入以本节为准。

OpenCode 的后台 shell 命令由随插件带的原生观察器 `runtime/server.mjs` 接入（OpenCode 2.1.4 的公开插件 API）：
入口只在这个进程的 `OPENCODE_CONFIG_CONTENT.plugins` 里追加观察器，保留已有插件和配置，不写运行机的配置文件。
观察器通过私有临时目录中的 Unix socket 交回 shell 的创建、退出、结果通知的投递与原生执行结束事件；不轮询进程、日志或数据库。
后台工具返回前先确认 `_coda/wait` 已登记，带启动工具的 `toolCallId` 和原生输出文件，子会话起的命令归子会话。
工具返回 `running` 不等于命令结束；主 prompt 结束也不关闭任务。命令退出后，等原生结果通知被处理，才按退出码、超时或停止事实了结。
轮外接手结果时报告 `handling`，处理失败显示失败原因；停止这次自主处理走原生插件的 `session.interrupt`，等原生中断事件才结束，并保留 ACP 会话供下一轮继续。
观察器被 OpenCode 配置禁止加载或事件连接断开时，卡片明确显示结果未确认，不伪造成功。

这部分仍有上游边界：公开插件 API 没有独立取消 shell 的操作，因此运行中的命令不显示单独停止按钮；
原生自动续跑的正文、工具、审批和提问仍未由 ACP 转来，观察器只补足活动状态，不自行拼装另一套对话协议。
任务的结果文件可查看原始命令输出。有限的后台实验应直接用 `background: true`，不要再套 `nohup … &`：
原生生命周期对应外层 shell，不能据此断言已经脱离它的后代进程也完成。观察器在 shell 工具说明里补充了这一点。

Kimi、Grok、OpenCode、Cursor 带设置动作（`contributes.setup`，`scripts/setup.mjs`），用户安装或更新插件时 Coda 在每台机器上运行：
CLI 不在或运行不了就用它自己的安装程序安装，低于插件要求的版本就升级，较新的版本保留。要求的版本：Kimi 2.1.1（入口读得懂的会话文件布局）、
Grok 1.0.52（审批模式通知核对过的版本）、OpenCode 2.1.4（入口核对过的版本；OpenCode 1 遇到模型服务的 `Retry-After` 会一声不响地等，多久都等，见下文。用 OpenCode 2 自己的安装程序 `https://opencode.ai/v2/install`，装在同一个 `~/.opencode/bin`，OpenCode 1 的会话由它按原 ID 接过去）；Cursor 没有已知的下限，能运行就行（它自己会更新）。
Codex 与 Claude 的 CLI、SDK 是插件的 npm 依赖，不需要设置动作。

### 模型服务

Claude、Codex 与 OpenCode 各有一项设置「模型服务」（`claude.modelProviders`、`codex.modelProviders`、`opencode.modelProviders`），
勾选任意几个别的插件提供的[模型服务](https://github.com/coda-console/coda/blob/main/docs/plugins.md#模型服务)，如 Magpie、CLIProxy；
设置写的是 Coda 的「多个模型服务」（`type: array`，`items.format: coda-model-provider`，`items.modelApis` 写各自接得住的接口，客户端只列这些）。
会话的模型按来源分组上报（ACP 选择型配置项的分组，Coda 的 docs/agent-protocol.md「模型的分组」）：Agent 自己的一组，每个勾选的服务一组、组名是服务标题，组内只写模型名。
只经会话进程的启动参数与按会话的覆盖生效，不改运行机上的 `~/.claude/settings.json`、`~/.codex/config.toml`、`opencode.json`；不选、或提供它的插件卸载了，与原来一样。

- **接口**：Claude 只接 `anthropic-messages` 的服务，Codex 只接 `openai-responses` 的（Codex 0.162 已不接受 `wire_api = "chat"`）。
  OpenCode 接 `openai-completions`、`openai-responses` 与 `anthropic-messages`。
  勾了别的接口的服务（旧设置留下的），入口只在标准错误记一行，不列它的模型。
- **Claude / Codex 模型**：会话打开时从每个服务的「地址/models」列出模型（各服务同时问），问法同 Coda 的「检查可用模型」（Claude 带 `x-api-key`，Codex 带 `Authorization: Bearer`），
  按勾选的先后排在 Agent 自己的模型后面：ID 是 `<服务>/<模型>`（如 `magpie/anthropic/deepseek/deepseek-v4-pro`），名字只是模型（如 `deepseek/deepseek-v4-pro`），
  在服务那一组里，没有推理强度可选。Codex 的分组在 codex-acp 生成模型配置项的地方打补丁做。
- **列不出来时**（三个插件一样）：每个服务列出的模型记在插件状态目录（`CODA_PLUGIN_STATE`）的 `service-models/` 下（文件名是服务名，`/` 换成 `.`），
  有变化才重写；某次问不到（那台机器在重启、网络暂时不通、超时）就沿用上次列出的，在标准错误记一行，那一组照常出现，
  选它的模型时请求照常失败。从没列出过、或后端没有状态目录的，这次就没有它那一组，其他的照旧。
  这样 Coda 的模型目录（读到后保留一小时）不会因为一次没问到就整整一小时缺这一组。
- **Claude / Codex 何时换**：选模型只是记下（Coda 读模型目录时会把每个模型都选一遍，不该因此启动什么）；下一轮开始前，所选模型的服务与会话正在用的不同（换到另一个服务、或回到自己的），才把会话换过去。
- **Claude**：以 `resume` 新起一个 SDK 会话（还没说过话的会话用同一个会话 ID 新起），flag settings 的 `env` 设 `ANTHROPIC_BASE_URL`、
  `ANTHROPIC_AUTH_TOKEN`（服务的 Key，没有 Key 写 `none`）与 `ANTHROPIC_MODEL`、`ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`、
  `CLAUDE_CODE_SUBAGENT_MODEL`（子 Agent、标题等后台调用也用这个模型）。运行机自己通往 API 的办法一样都不带过去：`ANTHROPIC_API_KEY`、
  `CLAUDE_CODE_OAUTH_TOKEN`、`ANTHROPIC_CUSTOM_HEADERS`、云服务商开关等置空，`apiKeyHelper` 置空（不然 API Key、helper 给的 Key 会作为 `x-api-key` 发给服务）。
  flag settings 高于运行机与项目的 settings，它们 `env` 里的同名变量盖不过它；换回 Claude 自己的模型时新起的会话不带这些，运行机的配置照旧。
  换回 Claude 自己的模型同样新起一个，不带这些；审批模式与推理强度沿用。还有后台任务、子 Agent 或定时唤醒没结束时，换到另一边的模型被拒绝（-32602），因为它们随原来的进程结束。
  新起的那个起不来（SDK 当场报错、初始化失败或超时），这一轮失败，会话随即结束（同 SDK 会话自己结束），Coda 下次再打开它。
- **Codex**：Codex 一个线程只绑一个模型 provider，所以照 codex-acp 处理 ACP `providers/set`、`providers/disable` 的办法：重启 app-server，
  把服务作为它 OpenAI 槽位的 gateway（`model_providers.custom-gateway`，`wire_api = "responses"`，Key 放在 `Authorization` 头），再 resume 会话的线程；
  换回 Codex 自己的模型时撤掉 gateway 再 resume。resume 带着会话打开时的 Coda 会话指令与 MCP 服务器，app-server 里的后台命令按 codex-acp 原有的做法报为停止。
  换的过程中失败（重启的 app-server 起不来、resume 失败）时这一轮失败，下一轮从重启起重新换（会话在哪个 provider 上由入口自己记：
  codex-acp 在 resume 之前就记下了 gateway，新 app-server 起不来时还留着已关闭的旧客户端，都不能拿来当换成了）。
  一句话都还没说的线程 Codex 没有写下来，resume 不了：先以第一条消息（前 80 字）为名 `thread/name/set` 把它写下，这也就成了会话标题（不再由 Codex 生成）。
  Codex 没有服务的模型的元数据，它为此发的「Model metadata … not found」与恢复时的「recorded with model …」提示不进会话。
- **OpenCode**：启动 `opencode acp` 前按接口从每个服务的「地址/models」列出模型，通过子进程的 `OPENCODE_CONFIG_CONTENT` 给每个服务加一个独立 Provider，
  ID 为 `coda-<插件>.<服务>`（如 `coda-magpie.openai`），模型 ID 为 `<Provider>/<模型>`，保留模型名里的斜杠。模型列表、选择与恢复由 OpenCode 原生处理，
  切模型不用重启；服务的标题作为 Provider 名。入口把 OpenCode 报给 Coda 的模型配置项按 Provider 分组（OpenCode 写作「Provider ID/模型名」，
  组内去掉前缀）：服务的组名是它完整的标题，OpenCode 自己的 Provider 各成一组，组名是 Provider ID（OpenCode 只报这个）；模型 ID 不变。Chat 用 `@ai-sdk/openai-compatible`，Responses 用 `@ai-sdk/openai`，Anthropic 用 `@ai-sdk/anthropic`，
  都是 OpenCode 自带的 SDK。Anthropic 请求模型列表用服务给的地址，生成请求的地址若未以 `/v1` 结尾则补上。
  Key 只用服务的；无 Key 时显式传 `none`，避免 SDK 回退到机器自己的环境变量凭据。接口不支持或 Key 文件读不到，就不添加那一个；列不出模型时同上沿用上次列出的，从没列出过的才不添加。其他的与原来的模型照旧。
  已有的 inline 配置支持 JSONC（注释、尾逗号），合并时保留用户自己的变量与字符串转义；服务生成片段中的 `{` 在 JSON 字符串内编码成 `\u007b`，
  防止模型 ID、标题等服务数据触发 OpenCode 的 `{env:…}` / `{file:…}` 展开。真正无效的配置仍明确报错。机器与项目的 Provider 启停限制也仍然有效。
  用户未加引号的布尔值、数字等变量节点在解析时暂用等长占位节点，合并后原样还原，由 OpenCode 自己展开；合并器不读取它们引用的环境变量或文件。
  `"provider":{env:VAR}` 也可由环境变量提供整个 Provider 对象：合并器只读取该对象的结构，结果放进子进程独有的变量，
  仍交给 OpenCode 做一次环境变量展开，再处理文件模板。原变量及其他配置入口保持不变；对象里的相对文件引用仍以原生会话目录为基准。
  `/models` 没有上下文与输出上限时暂用 32768 / 4096 tokens，
  服务给出 `context_length` / `max_output_tokens` 时用它们；不根据模型名猜测图片与推理能力。
  真 CLI 的本地验证（不使用实际模型服务与登录）：`OPENCODE_TEST_BINARY=/absolute/path/to/opencode node --test test/plugins/opencode/native.test.mjs`，
  覆盖三种接口的请求、服务与原生模型切换、进程重启后恢复，服务模型的变量模板、用户 JSONC 和 Provider 对象模板配置，以及主会话与子 Agent 里长短两种 `Retry-After`；
  原生子会话另覆盖过程与工具、审批归属、后台完成、独立停止和嵌套父子关系。模型服务全由本地 HTTP fixture 提供。

### Claude 缓存过期前压缩

Claude 的设置「缓存过期前压缩」（`claude.idleCompaction`，默认关）：会话停下后还要接着用时，在主线程的一小时提示词缓存过期前压缩一次上下文，
同 `/compact`。摘要趁缓存还热时生成，回来接着做的那一轮只需缓存摘要，不必按原价重新缓存整段对话。判断全在插件的流程里，Agent 只报数据、只执行。

- **流程**：插件自带的生命周期流程「Claude 缓存过期前压缩」（`.coda/workflows/claude-compaction.bpmn`）以 `coda:agents="claude-sdk"`
  只跟随 Claude SDK 的会话，一个会话一条运行，平时不占内存，只在会话事实变化或自己的计时到点时被唤醒；做了什么、为什么没做，都记在运行里。
  它只读会话事实、只请 Agent 压缩，不改会话自己的状态：不登记活动、不改等待、不发布阶段。
- **条件**：设置打开；进程在、没在跑一轮；还要接着用（置顶了，或在等你、等 Coda 跑的流程与子会话、等 Agent 自己的后台命令、子 Agent 与定时：
  事实 `pinned`、`input`、`waitsForSystem`、`background`、`scheduled`）；缓存是一小时的、上下文不少于 15 万 token；最后一次请求之后没有压缩过
  （最近一件事已经是压缩就不再压，不管是谁压的），也还没为这次请求请过。照 Claude Code 2.1.296 自带的空闲压缩
  （启不启用由 Anthropic 的远程开关定，默认关，设置 `idleCompaction` 只能关不能开）：在缓存寿命的 9/10，即最后一次请求后 54 分钟，执行动作
  `compact-session`；期间事实变了就重看，最后一次请求没变时期限不变；到点已过 58 分钟（机器睡过、后端停过，缓存多半已失效）就不压。
  Claude Code 那边还看额度是否接近上限，Coda 看不到额度，这里不看。
- **Agent 报什么**：每轮结束时，入口在 `usage_update` 的 `_meta.coda` 里带上主线程缓存的情况，Coda 原样作为会话事实 `usage`：
  `lastRequestAt`（最后一次请求模型的时刻，缓存最后被用到；压缩那一轮不算）、`contextTokens`（那次请求带的上下文 token 数）、
  `cacheTtl`（`PT1H` 或 `PT5M`，从回复写缓存的明细看出）、`compactedAt`（最近一次压缩，Claude Code 自动的、`/compact` 的、Coda 请的都算）。
  `usage_update` 的 `used` 同样取主线程最近一次请求的上下文量（含缓存读取与写入），压缩后取摘要留下的 token 数；
  不累加一轮中的多次请求，也不包含子 Agent 的上下文。尚无上下文量时不显示窗口用量；`cost` 保留 SDK 报的累计费用估算。
- **压缩那一轮**：入口在 `initialize` 的 `agentCapabilities._meta.coda` 里声明 `compact: {}`，收到 `_coda/session/compact`（`{ sessionId }`，
  两轮之间也可以发）就往 SDK 的输入送一条 `/compact`。这一轮不归 Coda 的哪个 `session/prompt`，也不登记活动；Coda 只看到 `compaction_update`，
  命令输出不转成回复。期间 Coda 发来的一轮排在它后面照常回复，插话回 `promptRequired`。压完回答 `{ compacted: true, before, after }`（前后的
  上下文 token 数）；会话没在运行、正在跑一轮、压缩失败或没压成，回 `{ compacted: false, reason }`。
- 会话事实 `pinned`、`usage`，动作 `compact-session` 与流程属性 `coda:agents` 由 Coda 提供（见 Coda 仓 docs/workflows.md「生命周期流程」与
  docs/agent-protocol.md），Coda 还没有这些时，这条流程读不进来，不会运行。

### Grok 审批模式

Grok 插件通过 ACP 提供原来的「自动审批」「全部放行」两个选项；新会话未选择时沿用运行机配置。
`session/set_mode` 转为 Grok 自己的界面使用的 `_x.ai/yolo_mode_changed` 通知，在原进程中切换，
不修改运行机配置。自动审批的判断、禁止规则与 hooks 都由 Grok 执行。
该通知已核对 Grok CLI 1.0.52，升级 CLI 时需复核。

### Codex 主动等待

Codex 调用 `clock.sleep` 时，会话底部显示一个后台等待项（例如「等待 2 小时」），等待结束后留在结束时的位置。
这次等待仍属于当前一轮；发送消息并选择「立即插话」可提前继续，停止会话会同时结束等待。
Codex 没有只取消单个 sleep 的接口，因此等待项不提供单独的停止按钮。正常结束、插话唤醒、整轮取消或失败都会了结等待，
子 Agent 的等待归它自己的会话。

### Codex 自动审核

Codex 在运行一条命令或工具调用之前，可能先让自动审核判断风险、决定放不放行（codex-acp 报成一个叫「Guardian Review」的工具调用）。
插件把审核结果报成被审核那条调用的一部分（Coda 协议的「工具调用的审核」，`_meta.coda.review`），不再单独算一步：
审核期间那条调用写「审核中」，没放行写「审核未通过」，放行的不另加标记；点开调用看审核结果、风险与理由。
审核在调用出现之前就开始的，插件先报出这条调用（等待中），codex-acp 随后报的就是对它的更新。审核结果里的授权程度不转交。

### Codex 速度

Codex 用普通 ACP 选择型配置项 `service-tier`（「速度」）报告速度，Coda 按通用 `configOptions` 展示和设置。
选项包含「标准」以及当前模型的 `serviceTiers`：`priority` 显示为「加速」，`ultrafast` 显示为「超高速」，其余档位保留原名与说明。
没有加速档位的模型不显示速度选项；可用档位取决于 Codex 返回的模型和账号能力，不按模型名字硬编码。
打开或恢复会话时沿用 Codex 报的实际档位；换模型时使用新模型的默认档位，调整推理强度保留速度。
下一轮将选中的档位传给 Codex，选择「标准」明确清除加速。

### Codex 账号与额度

`codex` 与 `codex-accounts` 是两个独立插件：Codex Agent 由 Coda 默认安装；多账号插件需用户在「设置 › 插件」主动安装。
仅随 Coda 提供插件目录不代表启用。未安装多账号插件时保留 Codex 原生登录与额度看板，安装后由多账号插件接管，卸载后恢复。

`codex-accounts` 2.0.0 自己管理账号，不需要预装账号管理器或 Python。安装时 Coda 安装它的 npm 依赖和
`codex` 插件；本版接管额度、登录入口和续期通知的配套入口是 `codex` 1.1.0。已有安装升级时两个插件一起更新，
Coda 升级依赖时也一起升这两个包。

- 首次使用会把运行机 `$CODEX_HOME/auth.json`（默认 `~/.codex/auth.json`）里的 ChatGPT 登录导入插件，作为第一个
  普通受控账号并默认选用。原文件保留；之后的凭据、续期与选择都由插件维护，原登录文件后续变化不会替换受控账号。
  只有系统钥匙串里的凭据无法从文件导入，需要在插件中登录一次。
- 没有已有登录时，从「资源 › 添加资源 › Codex 多账号」完成设备码登录。已有账号后，通过面板菜单的「重新登录」
  添加其他账号；登录同一身份会更新其凭据。添加第二个账号不会改变已选账号。
- 接入后「Codex」自带的额度看板隐藏，只显示「Codex 多账号」里的账号额度。原 Codex 登录入口也委托给账号插件，
  避免建立另一套登录；面板中没有「使用本机账号」。卸载账号插件后，Codex 自带看板恢复。
- 每个账号支持选择、查看额度、使用完全重置和移除。选择在新会话和轮次交界处生效；移除已选账号后须重新选择或添加，
  会话不会回退到原登录。首次导入只发生一次，移除的账号不会再次被自动导入。

账号存放于 `CODA_PLUGIN_STATE/accounts/<身份摘要>/auth.json`，目录权限 0700、文件权限 0600。
每个账号有独立的 `CODEX_HOME`，由插件依赖中的 Codex 执行设备码授权及 refresh-token 续期。
跨进程的每账号锁覆盖续期、额度读取、重新登录和移除，避免多个会话同时使用同一个轮换凭据。
会话只通过 `codex/account-source` 的私有管道拿到 access token；refresh token 留在受控登录文件中。
登录存储与续期采用 [Codex 官方认证机制](https://learn.chatgpt.com/docs/auth#credential-storage)。

旧版的 `selection.json` 仍然识别：`native` 转为首次导入的账号；指向其他旧账号的选择保留，并提示在插件中重新登录该账号，
不会悄悄切换。新版不再读取旧外部管理器的账号库，其他账号可直接从插件添加。

`codex/account-source` 的完整进程约定在 `plugins/codex/agent/account-source.mjs`：`selected` 返回身份和名称，
`tokens` 返回该身份的 access token，`refresh: true` 要求续期；无可用选择应返回错误。来源还通过 `--login` 接受
原 Codex 登录入口的委托，并自行提供额度面板。Codex 把自己的依赖目录通过 `CODA_PLUGIN_DEPENDENCIES.codex`
交给来源，来源与面板使用同一份 Codex CLI。

### Agent 的错误

Codex 插件在 ACP 出口把 codex-acp 错误 `data.message`、`data.details` 或字符串 `data` 中的原因补进标准 `error.message`，
详情裁掉两端空白并去重，错误码、请求 ID 与原始 `data` 保留。Coda 和其他 ACP 客户端直接显示 `message` 即可；
这层适配由插件维护，客户端无需理解 codex-acp 的内部错误格式。

Codex 的原生失败统一以 ACP 错误结束，包括只有 `turn/completed.failed` 而没有单独错误通知的情况。
插件将服务端内部错误、5xx、响应流中断、模型容量不足，以及已知的 `model '…' is not enabled in rustponsesapi` 报成
`error.data._meta.coda.failure: {kind: "service_unavailable", input: "accepted"}`。新轮请求明确被拒绝、只给
`Internal error` 时按临时故障报告 `input: "not_accepted"`；这表示允许有限重试，不表示已确定历史故障根因。
明确的额度耗尽、认证、上下文限制、参数、配置或沙箱错误不带此标记。
插件不做退避或重新发送；Coda 按通用协议统一退避，客户端只支持 ACP 时仍能读到完整错误。

Kimi 2.1.1 会把五小时额度耗尽（`403 You've reached your 5-hour usage limit.`）误报为 ACP `auth_required`。
Kimi 插件在 `session/prompt` 的回执中将这条已知错误改为普通执行错误（-32603），在标准 `error.message` 中保留服务端完整原因，
同时按[执行失败协议](https://github.com/coda-console/coda-protocol/blob/main/docs/agent-protocol.md#执行失败)报告 `error.data._meta.coda.failure: {kind: "quota_exhausted"}`。
Coda 按这个通用类别显示「额度不足」，不触发服务故障重试；其他 ACP 客户端仍能读取完整原因。
插件不推算额度重置时间；其他认证失败、403、短时限流与普通错误原样保留。
`CODA_DISABLE_RUNTIME_PATCHES=kimi` 关闭这层适配。

### 升级 Agent 的 CLI 与 SDK

Codex 会话、面板与登录用的 Codex CLI 就是 `codex` 插件依赖的 `@openai/codex`；Claude 的是 `claude` 插件依赖的
`@anthropic-ai/claude-agent-sdk`。插件按包名从自己的依赖里找它们，Coda 不另给路径。升级就是改这两个版本：
Dependabot（`.github/dependabot.yml`）每周为它们各开一个 PR，连同 `package-lock.json` 一起改；合并后在 Coda「设置 › 插件」
对该插件点「检查更新」；合并时勾选「部署」，`sync-coda` 给 Coda 开升级依赖的 PR。升 `@openai/codex` 时 codex-acp 经 `overrides` 跟着用新版本，
Coda 根上的同一条 overrides 由 `sync-coda` 一起改（npm 只认根的，Coda 的测试会核对）；合并前用真实会话跑一轮。

## 在 Coda 里安装

「设置 › 插件 › 从仓库添加…」：

1. **仓库**填 `coda-console/coda-plugins`（或 `https://github.com/coda-console/coda-plugins`）；**版本**留空是默认分支，也可以填分支、标签或完整的提交号。
2. **读取**：Coda 拉取那个提交，把仓库根与两层以内 `package.json` 带 `contributes` 的目录各列成一个插件——这个仓库里是 `plugins/` 下的七个与两个模板。Coda 内置的那几个只能从 npm 上自己的包单独更新；在 Coda 里先卸载它，才能从这里装同名的。
3. 选一个，确认里逐条列出它会运行的命令（Agent 的 `command`、面板的命令与动作），确认就是批准：这些命令以你的账户在空间里每台机器上运行，Coda 不做隔离，只装你信任的来源。

**Coda 只认提交**：安装时钉在读取到的那个提交上，每台机器各自取同一个提交。「检查更新」用记下的仓库与版本再读一次，提交变了才有更新；
上一个提交留着，可以回退。清单里的 `version` 只作显示，不参与比较——改了行为就把它加一，方便人看。这个仓库不打标签、不发 npm、不发 release。

自己的插件可以放在自己的仓库里（单插件仓库让仓库根就是插件目录），在自己的 Mac 上试的时候，仓库填本机仓库的绝对路径即可：Coda 读的是**提交**，没提交的改动它看不到。

## 写一个插件

从模板开始：把 `templates/agent` 或 `templates/panel` 复制成自己的目录，改掉 `name`（插件 ID）与 Agent 的 `id`。

**清单**（`package.json`）

- `name` 是包名；另写 `id` 时以它为 Coda 插件 ID，否则以 `name` 为 ID。ID 只能用小写字母、数字和 `-`，以字母开头，至多 40 个字符。
  本仓库的包名是 `@coda-console/<id>`，设置名与 Agent ID 仍使用原来的插件 ID。可以与 Coda 内置插件同名；从其他来源替换时，须先在目标机器卸载内置插件。契约检查照刚装好的 Coda 读：与它默认装着的内置插件同名、又不是那个插件的同一来源的，判不通过。
- `displayName`、`description`、`version` 显示在安装确认与插件页。
- `contributes` 只能有 Coda 认识的贡献：`agents`、`panels`、`configuration`、`capabilities`、`instructions`、`extensionPoints`、`extensions`、`groups`、`commands`、`services`、`setup`；读不懂的键一律报错，不会被悄悄忽略。
- `setup` 是插件的设置动作：`{ "command": "…" }`，一行、不超过 4000 字（与面板命令同样的规则），没有别的键。

**从仓库安装的限制**：带 npm 依赖（`dependencies`、`optionalDependencies`）就要把 `package-lock.json` 一起提交，Coda 在插件的版本目录里
`npm ci`（较早的 Coda 不收带 npm 依赖的插件）；不能有符号链接或子模块；整个目录不超过 10 MiB（`node_modules` 不算，也不该提交）；
目录名只用字母、数字和 `._-`，在仓库根下两层以内。

**Agent**（`contributes.agents`，例子见 `templates/agent/package.json`、`plugins/cursor/package.json`）

| 字段 | 内容 |
| --- | --- |
| `id` | Agent ID：小写字母、数字和 `-`，以字母开头，至多 40 个字符；会话按它存，所有插件里不能重复（不能用 `codex`、`claude`、`claude-sdk`、`kimi`、`grok`、`opencode`） |
| `displayName` | 显示名，一行，不超过 40 字 |
| `icon` | `light`：插件目录里的 PDF，不超过 32 KiB；可选 `dark`；`template: true` 表示单色、随文字着色。画布按 256 px 出（iOS 按 96 pt 光栅化、只缩不放） |
| `command` | 启动命令，一行，`sh -c` 运行，以 `exec` 开头，进程就是 Agent 本身 |
| `modes` | 可省：`title`、`unset`、`note` 是模式选择的标题与说明；`auto`、`full` 是这个 Agent 的「自动审批」「全部放行」各是哪个 ACP 模式 |
| `skillsDir`、`configFiles`、`setupHint` | 可省：Agent 在工作副本里找 skills 的目录；它读模型列表的配置文件（变了 Coda 重读）；用不了时给用户的一句话 |

Agent 进程的环境是会话的环境再加插件进程的那组变量（面板与面板的动作、放在会话 `PATH` 上的命令也一样；继承来的同名变量先去掉，一个插件的进程拿不到别的插件的）：
`CODA_NODE`（Coda 后端自己的 Node，插件自带的入口用它运行，不在 Agent 的 `PATH` 上）、`CODA_PLUGIN_PATH`（插件目录，从仓库装的是它钉住的版本目录）、
`CODA_PLUGIN_STATE`（插件在这台机器上的状态目录，跨会话、跨版本保留）、`CODA_PLUGIN_SETTINGS`（插件设置的 JSON）、
`CODA_PLUGIN_EXTENSIONS`（别的插件接在它扩展点上的东西，没有就不设）、`CODA_PLUGIN_DEPENDENCIES`（它依赖的插件的目录，没有就不设）、
`CODA_ARBITER`（`1`：这是它所在实例自己的正式后端；动本机共享的东西前看它）。
插件自带的入口只能用插件目录里的代码、Node 自带的模块与清单里声明的 npm 依赖。

照 [接入协议](https://github.com/coda-console/coda-protocol/blob/main/docs/agent-protocol.md) 实现，另外几条容易漏的：

- 标准输出只写 JSON-RPC，一行一条；日志写标准错误（Coda 不读它）。请求 ID 是字符串。
- 必须接受会话指令：`initialize` 结果声明 `agentCapabilities.sessionCapabilities.systemPrompt: {}`，`session/new`、`session/load` 收到的
  `systemPrompt`（`append` 模式）在第一轮之前生效。没有原生系统提示词入口的，在原生会话第一次 `session/prompt` 时把指令作为单独、明确分隔的一段
  放在用户输入前面送入，之后与 `session/load` 恢复的会话不再送。
- 插话可选：在 `initialize` 结果顶层声明 `_meta.steering.supported: true`，就要处理 `_session/steering`：一轮进行中回 `injected`，
  这一轮已经结束回 `promptRequired`（`reason: "noRunningTurn"`），且不自己另开一轮。
- `session/new` 要报当前模型：`configOptions` 里 `category: "model"` 的那一项的 `currentValue`（或 `models.currentModelId`）。Coda 每轮开始前核对，没有就不发这一轮。
- 没登录时在 `initialize`、`session/new` 或 `session/load` 回 -32000，Coda 提示用户去登录。
- `session/cancel` 后 30 秒内结束这一轮（`stopReason: "cancelled"`），否则 Coda 关掉它的进程组。
- Coda 关会话是对 Agent 的进程组发 SIGTERM，0.8 秒后 SIGKILL：收到 SIGTERM 要尽快退出。
- 一轮之外的审批与提问 Coda 一律拒绝，除非正有活动在 `handling`（那是一轮自主轮次）。

**面板**（`contributes.panels`，例子见 `templates/panel`）：`command` 用 `sh -c` 运行，标准输出是 `{ "items": [...] }`：

| 项 | 字段 |
| --- | --- |
| `card` | `title`、可选 `subtitle`、`items`（至多 20 项，不能再放卡片） |
| `meter` | `label`，可选 `value`、`fraction`（0–1，**还剩多少**，不知道就不写）、`note`、`time`（ISO 8601）与 `timeLabel` |
| `stat` | `label`、`value` |
| `markdown` | `text`（不超过 4000 字） |
| `button` | `label`、`action`（须是这个面板声明的动作）、可选 `args`、`disabled`、`confirm` |
| `error` | `text` |

只在打开资源页或点「刷新」时读，30 秒没结束或输出超过 64 KiB 就停下；读不懂的键或类型算这次读取失败。`items` 为空的面板不显示。
命令的环境是后端的环境（不带会话 ID）加上插件进程的那组变量（同上），`PATH` 最前面是 Coda 后端的 `node`；`CODA_GROUPS_STATE` 是这一刻这个后端各并发组的占用与排队
（`{now, groups}`）；动作另有 `CODA_PANEL_ARGS`（按钮的 `args`）。
动作至多跑 10 分钟，成功后 Coda 立即重读面板。

## npm 发布

仓库根的 `@coda-console/plugin-check` 与 `plugins/*` 各自发布为公开 npm 包；包名带 scope，插件 ID 单独写在清单的 `id`。
`repository.directory` 指向插件所在目录。Coda 必须先支持清单的 `id`，才能从改名后的仓库或 npm 读取这些插件。
插件在仓库里的锁文件仍供 Git 来源安装与本仓库测试使用；npm 包不带 `package-lock.json`，从 npm 单独安装时按依赖声明解析，随 Coda 发的版本由 Coda 自己的锁文件固定。

`.github/workflows/publish.yml` 在合入 main 或手动发起时检查测试、清单与 npm 包内容，然后逐包发布 npm 上尚不存在的版本。
只有发布步骤有 `id-token: write`，由 GitHub 托管运行机通过 npm Trusted Publishing 鉴权并生成 provenance，不配置 npm 写令牌。
查询 registry 失败会停下，只有明确的 404 才按未发布处理；已发布的版本跳过，修复失败后可重新运行同一个工作流。

首次接入（或新增包）由组织维护者执行，要求 npm 11.15.0 以上、账号已启用 2FA，并有对应包的写权限：

```sh
npm login
node scripts/publish-npm.mjs --dry-run   # 检查所有包实际会打入哪些文件，不发布
node scripts/publish-npm.mjs --bootstrap
gh workflow run publish.yml --repo coda-console/coda-plugins --ref main
```

先让 `publish.yml` 合入 main，再运行 bootstrap。它只给 npm 上还不存在的包发布 `0.0.0` 占位版（`bootstrap` 标签），
逐包配置 GitHub 仓库 `coda-console/coda-plugins`、流程文件 `publish.yml`、允许 `npm publish`、不指定 environment。
已有可信发布配置会显示出来供维护者核对，不自动覆盖。首次 2FA 验证可选择五分钟内不再询问，包与包之间停两秒以免限流。
配置后立即发起上述 GitHub 工作流：npm 要求新配置在两天内完成第一次成功发布，由 CI 发布仓库里的实际版本并验证信任关系。
确认 OIDC 发布成功后，在 npm 包设置的 Publishing access 中选择 Require two-factor authentication and disallow tokens。

## 契约检查

扮演 Coda 去读一个插件目录：清单对 Coda 的类型 schema 校验，流程按 Coda 的流程方言读，Agent 照 Coda 的样子启动、说 Coda 说的话，面板由 Coda 的资源插件模块读一次。
插件写的合乎它用到的类型就对：清单的写法只在协议包 `@coda-console/protocol`（[coda-console/coda-protocol](https://github.com/coda-console/coda-protocol)）的 schema 里，由 Coda 自己用的同一个校验器判，
检查包不另写规则，Coda 加字段只是改 schema。`check/coda/` 是 Coda 文件的原样副本（见[契约副本](#契约副本)），检查包手写的只有怎样扮演 Coda、怎样判。
只在装到一台机器上才知道的（仓库里扫不扫得到、npm 锁文件、和那台已装插件冲突）是那台 Coda 安装时说的，不是插件类型的问题，检查不跑。

```sh
npm ci
node bin/check.mjs <插件目录> [--agent <id>] [--manifest] [--live] [--prompt "…"]

# 不克隆，直接从 GitHub 跑（钉一个提交）
npx github:coda-console/coda-plugins#<提交> <插件目录>
```

| 级 | 要不要登录 | 查什么 |
| --- | --- | --- |
| 清单（总是） | 不要 | `package.json` 对 Coda 的类型 schema 校验（`manifestProblem`），再照 Coda 读成插件（`readPlugin`：ID、设置名在 ID 之下）；写给别的插件扩展点的键，要有 Coda 自带的或旁边依赖的插件声明这个类型。面板写法按资源插件给扩展点 `panels` 带的 schema 查。`.coda/workflows/` 里的每个流程（含能力）按协议的流程方言读（`workflowProblem`）：不是 BPMN、认不出的 `coda:` 属性或元素、没有的动作或动作不接受的参数都算失败。另有只提醒的：分类、版本、图标页面太小、旧的 Agent ID `claude` |
| 握手（默认） | 不要 | `sh -c` 启动 `command`（环境是 Coda 的 `pluginEnv` 给的：`CODA_NODE`、`CODA_PLUGIN_PATH`、临时的 `CODA_PLUGIN_STATE`、设置默认值的 `CODA_PLUGIN_SETTINGS`；依赖的插件在旁边（同一个父目录里同名的目录）时 `CODA_PLUGIN_DEPENDENCIES` 给它的目录，Coda 自带的不在这里、不给），发与 Coda 相同的 `initialize`，要求 `protocolVersion` 为 1、声明会话指令（`sessionCapabilities.systemPrompt`，没声明算失败）；`session/new` 带会话指令，给出会话与当前模型，回 -32000 记为未登录、跳过后面的检查（不算失败）；像 Coda 一样对进程组发 SIGTERM，5 秒内要退出（超过 0.8 秒提醒）；另起一个进程，关掉标准输入后 5 秒内不退出只提醒。面板由 Coda 资源插件的 `Panels` 读一次（30 秒），输出合格式 |
| 一轮（`--live`） | 要 | 第一轮问会话指令里的检查词（一个随机词），回复里要有它；再发一轮提示词（默认「只回复 ok」）收到 `stopReason`；每条 `session/update` 过 ACP SDK 的 schema；`_coda/wait` 按 Coda 的 `validWait` 与协议的规则核对（子 Agent 不带 `childSessionId`、定时不带 `at` 只提醒）；审批与提问一律回拒绝，在一轮之外发来的算失败；再发一轮并 `session/cancel`，30 秒内要结束，读到取消后还在做事或拖过 5 秒才答复却不回 `cancelled` 算失败（见下）；有自主轮次的也取消一次；声明插话的，一轮结束后插话要回 `promptRequired` 且不自己另开一轮，一轮进行中插话要回 `injected` 或 `promptRequired`（`injected` 的那一轮照常回 `stopReason`）；声明 `loadSession` 的，新开进程 `session/load`（同样带会话指令）要成功，随后在新进程里再跑一轮也要收到 `stopReason` |

**取消后的 `stopReason` 怎么判**：检查发 `session/cancel` 时紧跟一个只会得到 -32601 的探测请求（`_codaCheck/barrier`）。Agent 按顺序读，
探测的答复一定写在它读到取消之后，所以本轮的答复与 `session/update` 落在探测答复的前后，就说明它们写出时读没读到取消。
本轮在读到取消后又发了干活的更新（消息、思考、工具、计划），或过了 5 秒才答复，却不回 `cancelled`，算失败——用户按的「停止」没让它停；
答复先于读到取消写出（取消送到前这一轮已经结束），或读到取消时已经做完、随即答复的（如 Codex 做完后等标题时被取消），只记一条说明。

`--manifest` 只查清单（什么也不运行）；`--agent <id>` 只查一个 Agent。退出码：0 通过，1 有失败，2 用法不对。
面板的动作与插件的设置动作（`contributes.setup`）不运行（可能改动东西、装软件）；Coda 自己的 MCP 服务器不给（`mcpServers` 为空）。
检查给的会话指令不是 Coda 的全文，是一段替身加一句检查词。

在自己插件仓库的 CI 里：

```yaml
- uses: actions/setup-node@v4
  with: { node-version: 24 }
- run: npx --yes github:coda-console/coda-plugins#<提交> . --live
```

## 契约副本

Coda 主仓库不公开。它的插件规则（读清单、读面板、插件进程的环境、ACP 与 `_coda/wait` 的约定等，按 Coda `backend/src/` 下的路径放在 `check/coda/`）、
它自带的插件（`check/coda/builtin.json`）都是 Coda 的原样副本，由 Coda 的部署流程 `sync-plugin-check`
（脚本 `scripts/plugin-contract.mjs`）同步：它在分支 `sync/coda` 上给这里开 PR。**不要手改**；规则要改先改 Coda。
`check/coda/contract.json` 记着同步自哪个提交、每个文件的 sha256 和副本用到的包的版本，CI 用它核对：

```sh
node scripts/check-contract.mjs   # 每个文件与 Coda 同步的一致，check/coda/ 没有别的文件，依赖版本与 Coda 相同
```

这里手写的只有扮演 Coda 的部分（`check/*.mjs`）：照 Coda 的样子启动 Agent、说 Coda 说的话，以及怎样判、怎样说。

## 开发

```sh
npm ci
node scripts/install-plugins.mjs          # 在每个带 package-lock.json 的插件目录里 npm ci（照 Coda 装版本目录的参数）
npm test                                   # node --test 'test/**/*.test.mjs'：检查包（两个模板跑全三级、故意讲错协议的假 Agent）与各插件的测试
node bin/check.mjs templates/agent --live --prompt "wait 看看自主轮次"
```

检查包的依赖是契约副本用到的包，版本与 Coda 后端相同（`check/coda/contract.json` 的 `packages`：`@agentclientprotocol/sdk`、`yaml`、`@0dep/piso`）；`zod` 是 SDK 的 peer 依赖。
`test/plugins/` 的测试从插件目录自己的 `node_modules` 找依赖，没装就报错提示先跑 `install-plugins.mjs`；
`test/plugins/contract.test.mjs` 用假的对端（Claude 的假 SDK、Codex 的假 app-server、充当 `kimi acp` 的假 Agent）对真实入口跑检查包的三级，不用登录。
CI 先装各插件的依赖再跑全部测试，`plugins/*` 只查清单：真实的握手与一轮要各家的 CLI 与登录，不在 CI 跑。

## 许可

MIT，见 [LICENSE](LICENSE)。各插件的品牌图形归各自权利人所有，来源写在插件的 `icons/README.md`。

`plugins/codex/agent/` 里的 `relay.mjs`、`titles.mjs`、`network.mjs`、`process-exit.mjs`、`options.mjs`、`subagents.mjs`、`instructions.mjs`、`steering.mjs`、`providers.mjs`、`sleep.mjs` 在加载时给锁定版本的
[codex-acp](https://github.com/agentclientprotocol/codex-acp)（Apache-2.0，Copyright 2025 JetBrains s.r.o.）打补丁，补丁里含 codex-acp 构建产物的原文片段。
这些片段按 [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0) 使用，许可全文也随 npm 包装在 `node_modules/@agentclientprotocol/codex-acp/LICENSE`；
codex-acp 本身作为 npm 依赖安装，不在本仓库里。
