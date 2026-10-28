<!--
  副本：由 Coda 的 scripts/plugin-contract.mjs 从 Coda 主仓库的 docs/agent-protocol.md 同步（部署流程 sync-plugin-check），不要直接改；改协议先改 Coda 的正文。
-->

# Agent 接入协议

Coda 用 [ACP](https://agentclientprotocol.com)（Agent Client Protocol）接 Agent，要求 Agent 接受[会话指令](#会话指令)（ACP 的 `systemPrompt`），
可选支持[插话](#插话)（`_session/steering`），另收 Agent 活动报告（`_coda/wait`）和[执行失败事实](#执行失败)（ACP 错误数据里的 `_meta.coda.failure`）。本文是这份协议的唯一正文，写给要让一个 Agent（比如 Cursor 的）接入 Coda 的人：照它实现，
Coda 就知道这个 Agent 在一轮之外还在做什么，如实显示、不回收它的进程，把它处理这些东西时的输出、审批和提问放进正确的一轮，
并把它之后说的作为补交交回正确的调用。产品上这些规则的来由见[会话行为契约](session-contracts.md)与[完成唤醒契约](subagent-design.md#完成唤醒契约)。

**改协议**：公开仓库 `coda-console/coda-plugins` 的契约检查包照本文扮演 Coda 去检查插件的 Agent。本文与协议本身的实现
（`backend/src/domain/agent-protocol.mjs` 里的 `validWait`、`clientCapabilities` 这类，属于[插件契约](development.md#coda-plugins-维护的内置插件)）
合并后由部署流程 `sync-plugin-check` 原样同步到那边；检查要换判定方式时（新的请求怎么发、怎样算合格），另给 coda-plugins 开 PR 改检查本身，两个 PR 的描述互相链接。

## ACP 部分

Coda 是 ACP 的客户端。每个会话的 Agent 进程由一个[会话托管进程](session-host.md)持有，经标准输入输出说 JSON-RPC；
后端重启只断开连接，进程照跑，后端不在期间 Agent 发来的消息记在托管日志里，新后端按顺序续读，每条只处理一次。

| 方法 | 方向 | Coda 怎么用 |
| --- | --- | --- |
| `initialize` | Coda → Agent | 握手。`clientCapabilities` 带 `elicitation.form`、`elicitation.url`、`session.compaction`、`session.configOptions.boolean` 与 `_meta.coda.waits`（见[能力协商](#能力协商)） |
| `session/new`、`session/load` | Coda → Agent | 新建或恢复原生会话，会话 ID 由 Agent 给；Agent 声明 `loadSession` 才会被要求恢复。带 `systemPrompt`（[会话指令](#会话指令)）。结果里要报出当前模型（见下）。恢复期间重放的历史 Coda 不收（它有自己的），只收命令与标题 |
| `session/prompt` | Coda → Agent | 一轮：Coda 送出用户的消息或它自己合成的输入（子会话结果等），Agent 回复 `stopReason` 即本轮结束 |
| `_session/steering` | Coda → Agent | [插话](#插话)：把用户的消息加进正在进行的一轮；只对声明支持的 Agent 发 |
| `session/cancel` | Coda → Agent | 停止：本轮在进行时取消本轮；Agent 在一轮之外处理活动（`handling`）时，停止处理 |
| `_coda/session/compact` | Coda → Agent | [压缩上下文](#压缩上下文)：请 Agent 压缩这个会话的上下文；只对声明支持的 Agent 发，两轮之间也发 |
| `session/set_config_option`、`session/set_mode`、`session/set_model` | Coda → Agent | 模型、推理强度与模式 |
| `session/update` | Agent → Coda | 回复、思考、工具调用、计划、用量（可带给流程的[数据](#用量里的数据)）、可用命令、会话信息；只收本会话与它的子会话的 |
| `session/request_permission`、`elicitation/create`（`mode: form` 或 `mode: url`） | Agent → Coda | 审批与提问，作为卡片交给用户；只在一轮里受理（见[规则](#规则)第 3 条） |
| `$/cancel_request` | Agent → Coda | 撤回它发出、还没得到回答的审批或提问：卡片失效，Coda 回 `cancelled`（表单回 `cancel`），之后用户的回答不再转交 |

ACP 只允许在一轮（`session/prompt`）进行时交互。Agent 在两轮之间发来的审批或提问，Coda 拒绝（审批回 `cancelled`，表单回 `cancel`）
并在会话里记一条说明；它正在处理某项活动时例外，那时请求属于处理它的那一轮。两轮之间的 `session/update` 照收。

- **审批**：选项由 Agent 列出，Coda 原样展示，用户选哪个回哪个；授权的范围、对象与期限写在选项名里，Coda 不另分栏、不自行扩展授权。
- **表单**：`requestedSchema` 是标准 JSON Schema，Coda 按它展示并校验回答；单选、多选用
  `enum` 或 `oneOf`/`anyOf` 的 `{const, title}`，不认私有键。
- **链接**（`mode: url`）：带 `url` 与 `elicitationId`，没有要填的字段；Coda 展示链接，用户打开、办完后确认，回 `{action}`（`accept`、`decline` 或 `cancel`）。
- **模型的分组**：`category: model` 的配置项可以按来源分组，用 ACP 选择型配置项的分组写法：`options` 是一组 `{ group, name, options }`，
  如 Agent 自己的模型一组、它接的每个模型服务一组（[模型服务](plugins.md#模型服务)）。Coda 记下每个模型所在组的 `name`，两端选模型时按组分段、
  以组名为段标题，组内与输入框上只写模型的 `name`；不分组的照旧列成一串。模型 ID 在各组之间不重复，设模型照旧按 ID。
- **当前模型**：`session/new`、`session/load` 的结果要报出会话当前用的模型：配置项里 `category: model` 那一项的 `currentValue`，或 `models.currentModelId`；
  之后 `config_option_update` 与 `session/set_config_option`、`session/set_model` 的结果改了它，以改后的为准。Coda 每轮开始前把会话设置设给 Agent，
  再读当前模型记作这一轮的实际模型；读不到就拒绝这一轮（「适配器未报告实际模型」），不发 `session/prompt`。
- **设置**：会话设置里选了的模型、推理强度与模式，每轮开始前设给 Agent；没选的保持会话现状。当前模式是空字符串表示还没有选模式（Agent 按它自己的配置），按没有设置显示。模型或推理强度的选择型配置项里，
  可以有一项带 `_meta.coda.default: true`，表示交给 Agent 自己的默认：会话设置里没选时，Coda 把配置项切回这一项。这一项不进模型或强度的列表，
  当前值是它时按没有设置显示。
- **其他配置项**：模型、推理强度与模式之外的配置项，Coda 原样列给用户：选择型是一组选项，开关型（`type: boolean`）是一个开关；Coda 在 `initialize` 的
  `clientCapabilities.session.configOptions.boolean` 里声明接受开关型。会话设置里按配置项 ID 给的值，每轮开始前设给 Agent；当前模型没有这一项就不设。
  Coda 设过、会话设置里又去掉的（用户选回「Agent 默认」），切回 Agent 标了 `_meta.coda.default` 的那一项，没标就切回 Coda 第一次设它之前、
  同一模型下 Agent 报的值，两样都不知道就不改。Agent 自己改的 Coda 不去改回；用户在会话里用命令改的（如 Codex 的 `/fast`）记进会话设置。名字与说明照 Agent 给的显示。
- **未登录**：Agent 在 `initialize`、`session/new` 或 `session/load` 回错误 -32000（ACP 的 `auth_required`）时，Coda 告诉用户这个 Agent 未登录，
  到「资源」里添加（[面板的登录](plugins.md#面板的登录)）；Coda 不调用 `authenticate`，也不按错误文字猜。
- **Agent 版本**：`initialize` 结果的 `agentInfo`（ACP 的 `name`、`version`）填**实际运行的那个 Agent**：包装了别家 CLI 或 SDK 的插件，
  报那个 CLI 或 SDK 的名字与版本（如 `codex`、`0.130.0`），不报插件自己的版本（插件版本 Coda 已从清单知道）。
  Coda 记下每个 Agent 最近一次握手报的值，随后端遥测上报（[Coda 遥测服务](../telemetry/README.md#后端上报)），用于复盘 Agent 版本带来的兼容问题；
  只取版本号式的字符（字母、数字与 `.+()-_` 空格，至多 64 个），其他写法不记。不报不影响会话。

## 会话指令

Coda 给每个会话一份指令：回复怎样在 Mac 与 iPhone 上显示、默认回复语言，再接项目启用的插件说明（[插件](plugins.md)的 `contributes.instructions`），
正文在 `backend/src/components/session-config/client-instructions.mjs`。它走 ACP 的 [`systemPrompt`](https://agentclientprotocol.com/protocol/draft/session-setup#system-prompt-unstable)（unstable），
**接入 Coda 的 Agent 必须支持**：

- **声明**：`initialize` 结果的 `agentCapabilities.sessionCapabilities.systemPrompt: {}`。Coda 只用 `append` 模式，不需要声明 `mode.override`。
- **传入**：`session/new` 与 `session/load` 都带同一份 `{"mode": "append", "content": [{"type": "text", "text": …}]}`，只有一个文本块。
  每次打开时按项目当时启用的插件生成，插件说明变了，下次打开会话时带的就是新的。
- **生效**：在会话的第一轮执行之前进入上下文。Agent 有原生的系统提示词或 developer instructions 入口就放在那里（Claude 追加到系统提示词，Codex 是 `developerInstructions`）；
  没有原生入口的，由插件在这个原生会话**第一次** `session/prompt` 时把指令作为单独、明确分隔的一段放在用户输入前面一起送入，之后不再送（第一轮是斜杠命令时顺延到下一轮，免得命令不再被认出）；
  `session/load` 恢复的会话已经送过，不再送。Coda 显示与保存的用户原文不变。首条消息里的指令分量不如系统提示词，这是没有原生入口时的近似。
- **失败**：应用不了（不认识的模式、内容超出上限）时 `session/new`、`session/load` 回错误，不建立会话（ACP 建议 -32602）。
- 没声明的 Agent，Coda 照 ACP 的规矩不发 `systemPrompt`，会话照常打开，只是没有 Coda 的指令；契约检查判它不合格。

Coda 的 MCP 服务器只提供工具，不带 `instructions`。

```json
{"jsonrpc":"2.0","id":1,"method":"session/new","params":{"cwd":"/work/app","mcpServers":[],"systemPrompt":{"mode":"append","content":[{"type":"text","text":"# Coda client\n\nYour replies are shown in Coda…"}]}}}
```

## 插话

用户在一轮进行中「立即插话」时，支持插话的 Agent 把这条消息加进正在进行的一轮，不打断它；不支持的，Coda 停止这一轮，
在它结束后把消息作为下一轮送出（[会话行为契约](session-contracts.md#发送行为)）。父会话给正为它跑一轮的子会话发消息（`send`）时同样插话；
不支持的 Agent，这条消息只排到这一轮结束，Coda 不为它停止（[工具面](subagent-design.md#工具面)）。插话用生态里已有的 `_session/steering` 扩展：

- **声明**：`initialize` 结果顶层的 `_meta.steering.supported: true`（与 `agentCapabilities` 并列，沿用上游的写法）。声明了就要支持下面的 `promptRequired`。
- **请求**：`_session/steering`，参数 `{sessionId, prompt, _meta: {steering: {idleBehavior: "promptRequired"}}}`。`prompt` 与 `session/prompt` 的一样（Coda 只发一个文本块，附件写成路径）。
  Coda 只在自己发起的一轮（`session/prompt`）进行中、Agent 已开始执行时发，斜杠命令那一轮不发。
- **回复**：
  - `{"outcome": "injected"}`：消息加进了正在进行的一轮。之后的输出、审批与结束都属于原来那次 `session/prompt`，Coda 把这条消息记进那一轮。
  - `{"outcome": "promptRequired", "reason": "noRunningTurn"}`：那一轮已经结束，消息**没有**被接收。Agent 不得自己另开一轮；Coda 在那一轮结束后把它作为下一轮送出。
  - 其他（`startedNewTurn`、`failed`）或错误：Coda 不知道这条消息有没有进到原生会话，记为结果未知，不自动重发，用户可以自己再发。
- 同一会话同时只有一条插话在途：Coda 等上一条的回复再发下一条。

```json
{"jsonrpc":"2.0","id":"steer-1","method":"_session/steering","params":{"sessionId":"s1","prompt":[{"type":"text","text":"先别改测试，只看实现"}],"_meta":{"steering":{"idleBehavior":"promptRequired"}}}}
{"jsonrpc":"2.0","id":"steer-1","result":{"outcome":"injected"}}
```

## 执行失败

插件负责将上游错误归为通用类别，Coda 负责显示与重试策略；Coda 不依赖 Agent 名字、错误文字或私有上游错误码。
`session/prompt` 的 JSON-RPC 错误通过 `error.data._meta.coda.failure` 报告类别。标准 `error.message` 保留可读的失败原因；
其他 ACP 客户端可以忽略扩展。未标记、未知或不合格式的类别按普通错误处理，不自动重试。

### 额度不足

`kind: quota_exhausted` 表示可用额度已耗尽，例如订阅用量窗口已满或余额不足。插件须有明确的上游原因，不能仅凭 HTTP 403、
HTTP 429 或上游的认证错误分类判断。真正的认证失败仍沿用 ACP `auth_required`，不得报为额度不足。

```json
{"jsonrpc":"2.0","id":"prompt-1","error":{"code":-32603,"message":"当前用量窗口的额度已耗尽，<t:2026-10-24T18:10:00.000Z> 重置","data":{"_meta":{"coda":{"failure":{"kind":"quota_exhausted"}}}}}}
```

Coda 按该类别显示「额度不足」，保留完整原因，不安排自动重试；这个类别不要求 `input`，即使带了也不进入服务故障重试。
插件以普通执行错误返回（例如 -32603），不得把额度耗尽伪装成要求重新登录的 -32000。
恢复条件（等待窗口重置、补充额度等）由插件放在原因中，重置时刻按[文字里的时刻](#文字里的时刻)写；上游没有给出确切恢复时间时，不推算时间。

### 服务暂不可用

插件负责识别服务端临时故障；**重试策略归 Coda**，不依赖 Agent 名字、错误文字或私有上游错误码。
`session/prompt` 的 JSON-RPC 错误可以在 `error.data._meta.coda.failure` 中报告：

```json
{"jsonrpc":"2.0","id":"prompt-1","error":{"code":-32603,"message":"服务暂不可用","data":{"_meta":{"coda":{"failure":{"kind":"service_unavailable","input":"accepted"}}}}}}
```

- `kind: service_unavailable`：服务端暂时无法处理；额度耗尽、未登录、配置或参数错误不得这样报告。
- `input: accepted`：输入已经进入原生会话；故障回执确认本次原生执行已结束。Coda 在同一会话发送从已有进度继续的指令。
- `input: not_accepted`：明确拒绝，输入尚未进入原生会话，也没有执行它的操作。仅当原输入从未被接收时重投相同内容与附件；已有接收证据（包括已保存的 `delivered`）时只续跑。

输入是否被接收或执行是否已结束无法确定时，不带此标记。错误文字始终放在标准 `error.message`；其他 ACP 客户端可以忽略扩展。
Agent 自己仍在重连或重试时，不得提前返回本次 `session/prompt` 的失败；Coda 只在失败回执后安排重试。
Agent 自己的重试要等一分钟以上（比 Coda 的退避更久，例如服务的 `Retry-After` 指向用量窗口重置）时，不得一直等而不报告：
停下原生执行后以失败结束本轮，在原因中写明服务给出的恢复条件；不带 `service_unavailable`，因为 Coda 的退避等不到恢复；
上游明确说明额度耗尽时，按[额度不足](#额度不足)报告。

Coda 统一按 15、30、60 秒退避，每次执行最多重试三次，沿用原生会话、执行设置、原输入与轮次身份，
每次 ACP 请求使用新 ID。等待中保持执行状态，可随时停止；斜杠命令不自动重试。次数耗尽或遇到未标记错误时结束并保留最后原因。
退避只在当前执行期间保留，后端重启或连接中断即结束等待；已发出的请求、整机中断沿用现有会话接管和恢复规则。

## 用量里的数据

Agent 在 `session/update` 的 `usage_update` 里可以带 `_meta.coda`：一个 JSON 对象，放生命周期流程用得着的数据。Coda 不解释里面的字段，
原样作为会话事实 `usage` 交给[生命周期流程](workflows.md#生命周期流程)，由流程（通常是同一个插件带的）读、判断。

```json
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"usage_update","used":53000,"size":200000,"_meta":{"coda":{"lastRequestAt":"2026-10-28T01:06:12.418Z","contextTokens":53000,"cacheTtl":"PT1H","compactedAt":"2026-10-27T22:40:03.120Z"}}}}}
```

- Coda 只收会话本身（不是子 Agent 的会话）报来的，按会话记下最新的一个，后端重启后还在；之后的 `usage_update` 不带 `_meta.coda` 的，记下的不变。
- 不是对象的丢弃；序列化后超过 4 KiB 的丢弃，并在后端日志里记一行。内容变了，Coda 重新发布会话事实。没报过时事实 `usage` 为 `null`。
- 时刻写 ISO 8601，Coda 原样转交、不换算，流程可以直接拿来当计时起点（`{{facts.usage.lastRequestAt}}/PT54M`）或比较。
- Claude 插件（Agent `claude-sdk`）每轮结束发 `usage_update` 时都带上，自主轮次也带：
  `lastRequestAt`（主线程最后一次请求模型的时刻，提示词缓存从这一刻起算；比一轮结束早一段输出的时间）、`contextTokens`（那次请求带的上下文 token 数）、
  `cacheTtl`（缓存时长，`PT1H` 或 `PT5M`）、`compactedAt`（最近一次压缩的时刻）。

## 压缩上下文

Coda 可以请 Agent 压缩会话的上下文（同 Claude Code 的 `/compact`），由生命周期流程的 [`compact-session`](workflows.md#coda-的动作) 发起；
什么时候压、值不值得压由流程按[用量里的数据](#用量里的数据)判断，Agent 只执行。

- **声明**：Agent 在 `initialize` 结果的 `agentCapabilities` 里带 `_meta.coda.compact: {}`，Coda 才发；没声明的，这一步不发请求，结果是没压缩。
- **请求** `_coda/session/compact`，Coda → Agent，参数 `{ "sessionId": … }`。它是 Agent 与 Coda 之间的一来一回，不是一轮：Coda 不开轮次、不改会话显示，
  两轮之间也发（与 [`_coda/wait/stop`](#_codawaitstop) 一样，不受「只在一轮里交互」的限制）；压缩期间 Agent 发来的 `session/update`（如 `compaction_update`）照收。
  压缩期间 Coda 发来 `session/prompt` 的，Agent 排在压缩之后处理。
- **回答**：会话没在运行、正在跑一轮，或压缩失败时回 `compacted: false` 和原因；其余情况都压缩，回 `compacted: true`：

  | 字段 | 必有 | 含义 |
  | --- | --- | --- |
  | `compacted` | 是 | 这次压缩了没有 |
  | `reason` | 否 | 没压的原因，给人看；时刻按[文字里的时刻](#文字里的时刻)写 |
  | `before`、`after` | 否 | 压缩前后的上下文 token 数 |

  别的字段 Coda 不收。Coda 最多等 10 分钟；超时、出错、等待期间进程结束，都当作没压缩，原因由 Coda 写。

## 文字里的时刻

Agent 交给 Coda、给人看的文字里，具体的时刻写成 `<t:ISO 8601>`，如 `<t:2026-10-24T18:10:00.000Z>`：日期、时分秒与时区（`Z` 或 `+08:00`）都要有，
JavaScript 的 `toISOString()` 就是这个写法。不要自己写成本地时间：Agent 所在机器的时区与看的人未必相同。
Coda 存的就是这段文字，两端客户端显示时按看的那台设备的时区写出（如 `2026/10/25 02:10`）；文字被拼进交回父会话的结果时标记跟着走，
父会话的 Agent 读到的是 ISO 时间。读不出时间的标记原样显示。

用于失败原因（`error.message`）与[活动报告](#_codawait)的 `title`、`detail`；面板里的文字同样这样写（[插件：面板](plugins.md#面板)）。
不确切的时间（「一小时左右」）照常写字，不加标记。

## Agent 活动

`session/prompt` 的回复结束一轮，也就是 Agent 说眼下的信息它处理完了：Coda 据此宣告完成，把子会话这次调用的结果交回父会话。
一轮之后 Agent 还可能有东西在进行：放到后台的命令、派出去的子 Agent、到点会叫醒它的定时。ACP 不说这些，Coda 看不见就会把会话
显示成空闲、回收它的进程，也不知道它们之后叫醒 Agent 的那一轮属于哪次调用。Agent 活动报告让 Agent 把这些告诉 Coda，
每一样一项，从开始到结束；它们不挡完成（[规则](#规则)第 2 条）。

### 能力协商

- Coda 在 `initialize` 的 `clientCapabilities` 里总是带 `_meta.coda.waits: {}`。没看到它的客户端不认识这条扩展，Agent 不应对它发 `_coda/wait`。
- Agent 在 `initialize` 结果的 `agentCapabilities` 里带 `_meta.coda.waits: {}`，表示它会登记。这只是声明：Coda 把它记在托管握手里，
  健康检查（`GET /v1/health` 的会话项 `waits`）报出来；不声明的 Agent 发来的 `_coda/wait` 也照收。

```json
{"jsonrpc":"2.0","id":0,"result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true,"_meta":{"coda":{"waits":{}}}}}}
```

### `_coda/wait`

Agent 发给 Coda 的通知（没有 `id`，不回复），和 `session/update` 走同一个顺序：说在前面的先处理。

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `sessionId` | 是 | 它属于哪个会话：本会话，或 Coda 已经认得的子会话（之前某项活动的 `childSessionId`）。子 Agent 自己起的活动从子 Agent 的会话报，起因记为那个子 Agent（[规则](#规则)第 1 条）。别的会话的一律丢弃 |
| `waitId` | 是 | Agent 自己取的身份，同一会话内不重复，至多 200 字 |
| `state` | 是 | `waiting`、`handling`、`done`、`failed`、`cancelled`，见下 |
| `kind` | 否 | `task`（默认）、`subagent`、`timer`，或别的词（按 `task` 算）；第一次报告时定下，之后可以省略，改了也按第一次的算 |
| `title` | 否 | 给人看的名字，至多 500 字 |
| `detail` | 否 | 说明：任务在做什么，定时按什么计划触发；至多 4000 字。其中的时刻按[文字里的时刻](#文字里的时刻)写 |
| `stoppable` | 否 | Coda 能不能经 [`_coda/wait/stop`](#_codawaitstop) 停它，默认不能 |
| `childSessionId` | `subagent` 知道时带 | 子 Agent 自己的会话。从此这个会话的 `session/update`、审批与提问也收，记为这个子 Agent 的。不带时子 Agent 照样登记，但 Coda 不认得它的会话：那个会话发来的 `session/update`、`_coda/wait` 丢弃，审批与提问拒绝，委派清单里这一项点开没有过程，也不能照[规则](#规则)第 5 条继续同一个子 Agent |
| `model` | 否 | 子 Agent 的实际模型 |
| `outputFile` | 否 | 任务输出所在的文件，任务详情里显示 |
| `toolCallId` | 否 | 启动它的那次工具调用，同一会话里的 `toolCallId`：任务详情据此显示启动命令；它没结束时，那次调用缺结果也不被收束为结果未确认 |
| `at` | `timer` 知道时带 | 下次触发的时刻，ISO 8601。不带时会话底部的定时一行只写 `detail`（没有就是标题），不显示下次时间；定时照样登记，到点仍由 Agent 报 `handling` |
| `recurring` | 否 | 定时是否反复触发 |

缺必填字段、`state` 不在上表、字段过长或 `at` 读不出时间的，整条丢弃，不报错。之后的报告只需带变了的字段，没带的保持原样。

| `state` | 含义 |
| --- | --- |
| `waiting` | 在等，Agent 没在处理它 |
| `handling` | Agent 正在处理它：后台命令结束了、子 Agent 交回了、定时到点了，Agent 据此干活。见[规则](#规则)第 3 条 |
| `done`、`failed`、`cancelled` | 结束了：做完、失败、被停止。终态是最终的，同一个 `waitId` 之后再说什么都不算；第一次报告就是终态的不登记 |

`kind` 决定 Coda 把它当成什么，不只是怎么显示：

| `kind` | Coda 当它是 | 显示 | 会话的[事实](session-contracts.md#事件) |
| --- | --- | --- | --- |
| `task` 与其他词 | 后台命令 | 发起记录留在原位，任务等待时沉底、结束时留在自己的结束位置；`stoppable` 时有停止按钮；圆环「后台任务运行中」 | `background` |
| `subagent` | 委派 | [委派清单](subagent-design.md#委派清单)里的一项（`kind: task`），点开是它的过程视图，子会话的输出都归它；圆环「等待后续结果」，同子会话 | `background` |
| `timer` | 定时唤醒 | 会话底部的定时一行（计划、是否反复）；不进历史 | `scheduled`，不算 `background` |

```json
{"jsonrpc":"2.0","method":"_coda/wait","params":{"sessionId":"s1","waitId":"build-1","kind":"task","state":"waiting","title":"构建","detail":"npm run build","stoppable":true,"outputFile":"/tmp/build-1.log"}}
{"jsonrpc":"2.0","method":"_coda/wait","params":{"sessionId":"s1","waitId":"build-1","state":"handling"}}
{"jsonrpc":"2.0","method":"_coda/wait","params":{"sessionId":"s1","waitId":"build-1","state":"done"}}
{"jsonrpc":"2.0","method":"_coda/wait","params":{"sessionId":"s1","waitId":"review","kind":"subagent","state":"waiting","title":"评审改动","childSessionId":"s1/review","stoppable":true}}
{"jsonrpc":"2.0","method":"_coda/wait","params":{"sessionId":"s1","waitId":"hourly","kind":"timer","state":"waiting","title":"每小时看一次 CI","at":"2026-10-12T10:00:00Z","recurring":true}}
```

### `_coda/wait/stop`

Coda 发给 Agent 的请求，参数 `{ "sessionId": …, "waitId": … }`，Agent 回 `{}`。只对声明了 `stoppable` 的活动发：
用户点了任务或子 Agent 的停止、父会话取消这次调用（含已经交回、还在为补交跟进的）时它树下的项。
回复只表示收到；Coda 不当它已经停了，直到 Agent 随后用 `_coda/wait` 报它结束（通常是 `cancelled`）。

### 规则

1. **起因**：一项活动的起因是登记它时正在进行的那一轮；从子 Agent 的会话报来的（子 Agent 自己起的后台命令、再派的子 Agent），
   起因是那个子 Agent 的这次运行，不论报来时有没有轮次在进行。没有轮次在进行、又不是子 Agent 起的，起因未知（见[起因](session-contracts.md#起因)）：
   Agent 在一轮之外自己开始干活，就要在这一轮里报 `handling` 说明是为哪一项（第 3 条）；说不出来时自造的那一项起因未知。
   它归起因沿链走得到的那次调用：父会话派来的那一轮里登记的，归那次调用；用户直接发的消息那一轮里登记的，不归父会话的调用；
   起因未知的算每次调用的。
2. **不挡完成**：活动在进行时会话照样静止（[会话静止](session-contracts.md#会话静止)）：这一轮结束就宣告完成、交回调用，
   交回的结果写明这次调用还有哪些活动在进行；它们之后叫醒 Agent 的那一轮结束时，那一轮说的作为这次调用的补交交回，
   都结束时再说一次（[补交](subagent-design.md#补交)）。活动在进行时进程不被空闲回收，`!` 命令不执行，会话照实显示。
3. **处理（`handling`）**：Agent 在一轮之外处理活动时，Coda 为它开一轮自主轮次。这一轮的起因是最先进入 `handling` 的那一项，
   所以这一轮属于那一项的调用，说的话作为它的补交交回。这一轮进行中别的项进入 `handling`，并入这一轮，起因不变。所有项都离开 `handling`
   （回到 `waiting`，或结束）时这一轮结束。这一轮里 Agent 的输出、审批与提问都归它，子会话发来的也一样；用户这时发的消息排队，等这一轮结束再送。
   在 Coda 发起的一轮（`session/prompt`）进行中进入 `handling` 的，算在那一轮里；那一轮结束时还有项在 `handling`，接着开一轮自主轮次。
   用户停止这一轮时，Coda 对本会话发 `session/cancel`：Agent 应停止处理，把这些项改回 `waiting` 或报结束；这一轮随之结束，
   因为分不清停止和做完谁先到，结果记为未知。30 秒内这一轮还没结束，Coda 关掉托管连接与它的进程组，结果未知，不自动重跑。
4. **定时**：`kind: timer` 带 `recurring`，知道下次触发的时刻就带 `at`。到点时报 `handling`，处理完反复的回到 `waiting`（可以带新的 `at`），
   一次性的报 `done`。`at` 是触发时刻，不是期限：到点没报不算过期。父会话取消这次调用时，它树下 `stoppable` 的定时经 `_coda/wait/stop` 停掉，
   其余的 Coda 不删除，这次调用不再为它们补交，并如实告诉父会话留下了哪几个（要删得请 Agent 自己删）。
5. **子会话与继续**：`childSessionId` 让 Coda 认得那个会话。子 Agent 结束后，Agent 以新的 `waitId`、同一个 `childSessionId` 再登记一次，
   就是继续同一个子 Agent：委派清单里还是那一项，多一次运行，这一次的起因是再登记时进行的那一轮。
6. **进程结束**：Agent 进程结束（崩溃、停止超时被关、空闲回收、机器重启），它所有没结束的活动以 `disconnected` 结束，结果未知，
   Coda 不重放；为它们跟进的调用随之补交一次，写明结果未知。后端重启而托管还在时一切照旧：活动、`handling` 的那一轮都接回，
   后端不在期间的 `_coda/wait` 从托管日志续读，各只算一次。
7. **会话加载中**：`session/new`、`session/load` 期间发来的 `_coda/wait` 先存着，会话身份确定后按原顺序处理，只收本会话与这些登记里公告的子会话。
   所以 Agent 恢复会话时可以把还在等的东西重报一遍：同一个 `waitId` 再报 `waiting` 不会多登记一项。

## 内置 Agent 的入口进程

Coda 自带的 Agent 都是内置插件（清单见[插件：Agent](plugins.md#agent)），照本协议接入。源码与入口自己的测试在公开仓库
coda-console/coda-plugins 的 `plugins/<插件>/`、`test/plugins/<插件>/`，发布为 npm 包 `@coda-console/<插件>`，Coda 以钉住版本的依赖装在 `backend/node_modules/` 里
（[开发与验证：coda-plugins 维护的内置插件](development.md#coda-plugins-维护的内置插件)）。各家要做的特殊处理在它自己的入口进程里（插件的 `agent/`），
入口只用插件目录里的代码、它 `package.json` 声明的 npm 依赖与 Node 自带的模块，不引用 Coda 后端的模块。怎么启动写在清单的 `command` 里：
插件自带的入口由 Coda 的 Node（`CODA_NODE`）从运行时副本里的插件目录运行，其余是运行机上的命令。
[从仓库安装](plugins.md#从仓库安装)的插件，入口从它的版本目录运行，只能用插件目录里的代码、它自己的 [npm 依赖](plugins.md#npm-依赖)与 Node 自带的模块。
直接运行运行机命令的插件（上游 ACP 不接受 `systemPrompt`）也带一个薄入口：转发 ACP，声明会话指令，并在原生会话第一轮把指令放在用户输入前面送入（[会话指令](#会话指令)）。

| Agent | 入口 | 它在协议之外替 Agent 做的 |
| --- | --- | --- |
| Codex（插件 `codex`） | `agent/entry.mjs`：在同一进程里运行锁定版本的 codex-acp，加载 Coda 的源码补丁（适配器一变就启动失败） | 向 codex-acp 声明 JetBrains AIR 的 `nativeSubagentSessions` 与 `asyncTasks`，把 AIR 报的子 Agent 与转入后台的命令翻成 `_coda/wait`：命令带 `toolCallId`，codex-acp 说能停的经 AIR 的停止（发给根会话）停；子 Agent 在 codex-acp 说能取消时经取消它的会话停。codex-acp 把继续的子 Agent 叫 `X:generation:N`，对 Coda 一律是 `X`，每次运行一个新的 `waitId`。会话默认以只读模式开始（`INITIAL_AGENT_MODE`，运行机设了就用它的）；Coda 选的账号经账号桥接上。Codex 没有自主轮次，不报 `handling`。会话指令经 codex-acp 的 `thread/start`、`thread/resume` 作为 `developerInstructions` 交给 Codex，接在运行机配置自己的 `developer_instructions` 后面；声明插话，一轮已经结束时收到的插话回 `promptRequired`（Coda 的补丁，codex-acp 原本会自己另开一轮） |
| Claude（插件 `claude`，Agent `claude-sdk`） | `agent/entry.mjs`：Coda 基于 Claude Agent SDK 写的 ACP Agent，一个进程一个 SDK 会话；SDK 是插件依赖的 `@anthropic-ai/claude-agent-sdk` | 会话 ID 由入口生成；模型一律是具体 ID（SDK 列出的 `resolvedModel` 加上下文变体，不接受别名）。后台任务、子 Agent 与 Stop hook 列出的定时唤醒报成 `_coda/wait`（定时的计划不是五段 cron、算不出下次时间时不带 `at`）：子 Agent 的会话是启动它的工具调用 ID，SendMessage 续聊是同一会话的新一次运行；子 Agent 起的后台任务与子 Agent 在它自己的会话里报；没有轮次时结束的任务，等一轮接手或会话空闲才了结。Claude 自己开始的一轮，先看开场消息指名的：到点的定时、结束通知所属的任务、交回报告的子 Agent（它已结束时才算；还在跑的子 Agent 发来进展不算）。指名的已处理过（Claude Code 为子 Agent 的结束通知另开的、不调模型的一轮）或还在跑，这一轮不处理任何一项；开场什么都没指名，才依次找已结束的任务、唯一到点的定时。认定的项在任何输出与请求之前报 `handling`；什么都没认定的，等这一轮第一次说话、调用工具、审批或提问时才报自造的「Claude 自主继续」，什么都不说的一轮不报。审批的选项是仅允许本次、每条建议规则一个 `allow_always`、拒绝；SDK 不再等回答时发 `$/cancel_request`。MCP 服务器的表单原样转来，链接用 `mode: url`。额度写进插件状态目录的 `limits.json`（[内置插件：Claude](plugins.md#内置插件claude)），标题经 `session_info_update` 报。会话指令追加在 `claude_code` 预设的系统提示词后面 |
| Kimi（插件 `kimi`） | `agent/entry.mjs`：把 `kimi acp` 作为子进程，在两者之间逐条转发 | 读 Kimi 的会话文件，把入口启动之后开始的后台命令与子 Agent 报成 `_coda/wait`（子 Agent 的会话是它的 agentId，过程报成那个会话的 `session/update`；按运行先后交付登记、过程与了结，同一子 Agent 的下一次运行等上一次了结才报，从而接着用同一张卡片）；在 Coda 发起的一轮里结束的任务直接了结，因为主 Agent 已在该轮处理结果；轮外结束且结果要交给主 Agent 的才从结束起报 `handling`，主 Agent 在那之后结束一轮时了结。不能停，不带 `toolCallId`。只认 Kimi CLI 2.1.1 的文件布局，见[会话行为契约](session-contracts.md#停止恢复与进程回收)。会话指令放在原生会话第一轮的输入前面 |
| Grok、OpenCode（插件 `grok`、`opencode`） | `agent/entry.mjs`：把运行机上的 `grok agent --no-leader stdio`（先找 `~/.grok/bin/grok`）、`opencode acp` 作为子进程逐条转发 | 只做会话指令：声明它，并放在原生会话第一轮的输入前面；不报告活动 |

Claude 的提问（AskUserQuestion）是这样一张表单：第 i 个问题是必填字段 `q{i}`，`title` 是问题、`description` 是它的标题；单选为
`type: string` 加 `oneOf: [{const, title}]`，多选为 `type: array`、`items.anyOf`、`minItems: 1`。每个问题的选项最后多一个
`{"const": "coda:other", "title": "其他（写在下面）"}`，另有可选字段 `q{i}_other`（`type: string`）写其他的内容：表单说不出「两个字段至少填一个」，
所以用这个选项表示答案在旁边。

```json
{"type":"object","required":["q0"],"properties":{
  "q0":{"type":"string","title":"用哪种方案？","description":"方案","oneOf":[{"const":"小改","title":"小改 — 只动接口"},{"const":"coda:other","title":"其他（写在下面）"}]},
  "q0_other":{"type":"string","title":"其他"}}}
```
