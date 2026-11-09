# Claude

Claude SDK Agent：Coda 基于 Claude Agent SDK 写的 ACP 入口，一个进程一个 SDK 会话；资源页的「Claude」显示会话报告的额度，可从 Coda 登录。

## 认不出的东西

Claude Code 会自己长出新东西：SDK 升级带来新的消息类型，服务端让模型返回新的内容块，模型多了新的原生工具。
入口不认识时若悄悄丢掉，用户就看不到本该看到的。入口为此有三层防范：

1. **登记**（`agent/registry.mjs`）：锁定的 SDK 的每种消息（`SDKMessage` 的类型与子类型，如 `system/init`）、助手消息与用户消息里的每种内容块，
   各注明转给 Coda 还是明确不显示，附一句原因。SDK 没有声明、却照样转来的几种内部消息（`system/post_turn_summary` 等）也登记为不显示。
2. **升级检查**（`test/plugins/claude/sdk-registry.mjs`，`npm test` 里跑）：用 TypeScript 编译器的类型检查器（仓库的 devDependency `typescript`）
   读锁定 SDK 入口导出的 `SDKMessage`，展开联合取每个成员 `type`、`subtype` 的字面量，再顺着助手、用户消息 `message.content` 的元素类型
   展开内容块的联合取 `type`，有没登记的就失败并列出来。别名、交叉类型、再导出与泛型都由检查器解析；`type`、`subtype` 不全是字符串字面量的
   （比如 `string`）判失败并说出是哪个成员，不会悄悄放过。
3. **运行时报告**：Coda 在 `initialize` 的 `clientCapabilities._meta.coda.unrecognized` 里表示收，入口才发 `_coda/unrecognized`
   （协议 5.4.0，`docs/agent-protocol.md`「没适配的东西」），同一会话同一 `name` 只报一次；没表示就什么都不发，下面的后备显示照旧。
   - 没登记的消息报 `sdk:<type>/<subtype>`（没有子类型的报 `sdk:<type>`），没登记的内容块报 `block:<type>`，都是 `kind: output`。
     消息和助手消息里的内容块带文字的（`text`，字符串或文字块的 `content`，消息的 `message.content`）照常显示成 Claude 的回复，报 `lost: false`；
     没有文字的报 `lost: true` 并附一句说明。结果、助手与用户消息、流式事件、额度事件不论子类型都按类型处理，子类型没登记也报 `lost: false`。
   - 用户消息是给模型的输入（工具结果、Claude Code 补的说明等），不是 Claude 说的话：里面没登记的内容块只报不显示，`lost: true`，
     会话里留一条「没有显示」的说明。
   - 每轮开始的 `system/init` 列出模型能用的工具，和已知清单 `agent/known-tools.json` 对照，清单里没有的报 `tool:<名字>`（`kind: tool`、`lost: false`）。
     MCP 工具（`mcp__` 开头）是用户配的，不比。清单是锁定 SDK 在本入口的启动选项下 `system/init` 列出的工具，加上入口另外认识的
     （`agent/tools.mjs` 里的、旧版 Claude Code 的）。

### 升级 SDK 时

1. 升 `@anthropic-ai/claude-agent-sdk` 的 PR（Dependabot 开的，或手动改版本并更新 `package-lock.json`）先要让 `npm test` 里的升级检查通过：
   `node test/plugins/claude/sdk-registry.mjs` 列出新 SDK 有、登记表没有的消息类型与内容块。
2. 逐个看新 SDK 的 `sdk.d.ts` 与它带的 `@anthropic-ai/sdk`：要显示的在 `agent/session.mjs` 里处理，再登记为转给 Coda；不显示的登记并写明原因。
   检查读不出声明时，按报错补读法或改登记，不要跳过。
3. 用新 SDK 跑一轮真实会话，把新出现的原生工具加进 `agent/known-tools.json`（会话里没登记的工具会报成 `tool:<名字>`，遥测按 Agent 版本计数）；
   要按读写、命令等显示的，同时在 `agent/tools.mjs` 里归类。
