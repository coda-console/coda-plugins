# 输入框模式

`@coda-console/composer` 把输入框的五种模式放在同一个插件里，插件 ID 为 `composer`。

| 模式 | 入口 | 用途 |
| --- | --- | --- |
| 交接到新会话 | `/handoff` | 新会话承接当前上下文，共享工作目录；原会话保留，可继续使用。 |
| 子会话 | `/subagent` | 从任意会话启动子会话，承接近期上下文并沿用工作目录；可选完成后回报父会话或你。 |
| 执行命令 | `!` | 在会话工作目录执行命令，命令与结果作为消息发给 Agent；也可在新任务输入框使用。 |
| Ultra | `/ultra` | 代码修改交给开发流程，主 Agent 亲自审查与验收；也可在新任务输入框使用。 |
| 循环 | `/loop` | 按周期把同一句话再发给 Agent，每轮做完才开始计时，7 天后自动结束；仅用于已有会话。 |

五个模式可同时开启，模式 ID 不变。Ultra 开启时，从这个输入框创建的新会话（包括子会话、交接和新任务）继承 Ultra 及当前子 Agent 名单，各自独立保留模式；关闭来源的 Ultra 不会关闭已创建会话的 Ultra。工具栏始终选择输入框自己的执行者；交接与子会话的参数另有可选 Agent，留空沿用输入框执行者。子会话也能创建自己的子会话。

3.0.0 按 [Coda #2063 的接口约定](https://github.com/coda-console/coda/issues/2063) 改为 `submissions` 协议参与者，依赖该 issue 第 2 步的后端支持，以及 [Coda #2085](https://github.com/coda-console/coda/pull/2085) 的新会话模式继承与实际投递计数，不能用于旧版回调宿主。交接、子会话和循环声明 `once: true`，发出的一条被收下后退出该模式；Ultra 保持开启，执行命令的触发词仍是 `!`。

插件只返回补充，不改正文、附件、引用或输入框的执行者。多个模式的补充由 Coda 合并，`tell` 是字符串数组，按列表追加后随这条发送到每个收到它的会话；只要有一项 `divert: true` 就不发给默认去向，各模式追加的去向仍分别执行。

| 模式 | 发出的一条的补充 |
| --- | --- |
| 交接 | `divert: true`，追加 `thread` 去向，带 `handoffSource`、可选 `agent`、`open: true` |
| 子会话 | `divert: true`，追加 `thread` 去向，带 `handoffSource`、`parentThreadId`、`replyTo`、可选 `agent`、`open: true` |
| Ultra | 首条、参数变化后的首条，以及创建新会话时返回完整开启说明；此后 `sent > 0 && sent % 10 === 0` 时返回仍在说明，其余返回 `null` |
| 循环 | `divert: true`，追加 `loop` 去向，带 `thread`、`every` |
| `!` | `divert: true`，会话中追加 `message` 去向，带 `thread`、`run: true`；新任务中追加 `thread` 去向，带 `run: true`、`open: true` |

新会话去向明确跳转，客户端按每项 `open` 执行。Coda 将非一次性、非触发式且适用于会话的模式和参数写入新会话输入框；各会话只为自己实际收到的模式消息计数，转发到新会话不增加来源的 `sent`。空 Agent 不写入目标，交由 Coda 沿用 `spec.agent`（包括 settings）。

## 循环用法

在已有会话的输入框里打 `/loop`，填写每轮要做的事，选择周期后点「开始循环」。周期默认 30 分钟，可选 5 分钟、10 分钟、15 分钟、30 分钟、1 小时、2 小时、3 小时、6 小时、12 小时或 1 天。

这条消息就是第 1 轮；Coda 收下后创建循环，输入框随即退出循环模式。每轮做完才开始计算下一个周期，不叠着跑；7 天后自动结束，也可提前停止，归档会话同样结束循环。计时与重发由 Coda 后端负责，会话进程被回收后仍会按时恢复。

循环的计时行为沿用 [Coda #2051](https://github.com/coda-console/coda/pull/2051)，3.0.0 通过上述 `loop` 去向提交。

## Ultra 模板设置改名

Ultra 的模板设置由 `ultra.templates` 改为 **`composer.templates`**，模板的数据结构不变。清单的预设只引用新设置名，由 Coda 按输入框所在目录读取。
旧 Ultra 包暂时保留，旧设置迁移和卸载旧插件由 [Coda issue #2050](https://github.com/coda-console/coda/issues/2050) 的第 4 步处理，本插件不自行迁移。

## Ultra 用法

在会话或新任务输入框打 `/ultra`，点模式条选择执行者名单；点 × 退出。单独开启时消息照常发给当前会话，与其他模式一起开启时按各模式的去向发送。
主 Agent 定义任务、处理困难决策并亲自审查架构和实现方式。所有代码修改通过 `workflow_run` 发起 `develop`，每个能独立交付的功能一个运行，可以同时进行；同一运行内按顺序派任务。
`spawn` 只用于不改代码的调研、排查和核实。主 Agent 可以为定任务和审查读代码，不自己实现或替执行者修复。

`composer.templates` 是执行者模板，一行「模板名、Agent、什么时候派给它」。同一模板名的行是一组，进入时填第一组；默认没有模板。
Ultra 参数仍保存为 `subagents`，预设引用 `{ "from": "composer.templates", "by": "template" }`，选择预设只填入名单一次，之后可修改。
从名单选执行者，把 `agent`、`model`、`effort`、`mode` 传给 develop；名单为空或没有对应任务时用当前会话的 Agent 和模型。
名单中的 `options` 只用于只读 `spawn`，develop v1 不接受它。

`ultra.mjs` 在首条、改参数后的首条、创建新会话时给完整说明，之后每收下 10 条再提醒一次。
主 Agent 每次必须亲自读 diff，检查架构是否得当、改动是否最小、是否有防御性或冗余代码及无关改动；检查通过和执行者汇报不能替代审查。
退回时给具体意见，由同一个执行会话修复；通过后可派下一项，或进入验收。执行者自己完成任务，不继承协调职责、不再转派。
并发已满就等名额；流程或 spawn 不可用就报告阻塞，不改用直接实现或原生子 Agent。用户的明确指令优先。

插件声明 `activationEvents: ["onStartupFinished"]`，重启后通过 `coda.watch('composers', …)` 恢复观察。
Ultra 消失且此前 `sent > 0` 时用 `coda.tell` 告知关闭一次，恢复通常的执行与委派规则；一条都没发过就不说。
名单连同说明超过 Coda 单次告诉 Agent 的 4000 字上限时，缩短名单再发。这些分工是提示词约束，不在运行时禁用工具。

## 开发流程

`workflow_run` 的 `workflow` 传 `develop`。它是手动流程，不订阅 PR 事件，也不依赖 review 插件；使用时停用旧的 PR 生命周期，避免同一个 PR 被两条流程处理。

| 输入 | 用途 |
| --- | --- |
| `title`、`task` | 必填的功能名和第一项自足任务，包含背景、范围与验收要求 |
| `agent` | 留空使用发起会话的 Agent |
| `model`、`effort`、`mode` | 可选，空值不传给 coda-agent，使用执行者默认值 |
| `base` | 留空从 GitHub 读取仓库默认分支 |

1. 从远端 base 最新提交创建 `lane/<功能名>-<运行 ID>` 并推送，不同功能运行各有自己的泳道。
2. 执行步骤用 `coda-agent --commit <泳道 head> --json` 开执行会话。固定说明要求遵守 AGENTS.md，只做本项、在当前分支提交、不推送、不写防御性或冗余代码、不顺手重构，并报告实际验证。
3. 主 Agent 人工任务给出执行者回答、会话、分支、head 和 `git diff <泳道>...<head>`。退回意见或下一项任务写备注，必填；缺少时返回审查卡。「退回修改」用 `--continue <会话>`；通过后 `git merge --ff-only` 合入泳道并推送，不能快进就失败。「再派一项」从最新泳道提交开新会话。
4. 主 Agent 用 `workflow_run` 带泳道的精确 `commit` 安装 `mac-preview-install`、`ios-preview-install`，安装成功后答复；没有客户端改动可跳过安装。随后用户答复「设备验收」，「不行」须附意见并回主 Agent 审查，修好后重新安装与验收。
5. 设备验收通过后开泳道到 base 的 PR，正文汇总各次审查通过的任务、回答和提交。`run-workflows kind=check` 在泳道最新提交上执行；失败交回主 Agent，材料给出失败阶段、提交和运行链接，由主 Agent 用 `workflow_status` 读取失败详情，再退回最近的执行会话。修好后更新同一个 PR 并重跑检查。
6. 用户批准卡仅在项目有 `kind=deploy` 时显示「部署」，默认不勾；与现有 PR 批准卡一样，选中后运行这一类的全部流程。v1 不提供预览发布或正式发布。批准后在同一 head 跑 `kind=premerge`，失败同样回审查，修好后重新检查与批准。
7. 用 `gh pr merge --squash --match-head-commit` 合并，成功后读取合并提交、删除远端泳道分支，再在合并提交上按勾选运行一次部署。

每步独立工作区，进度与已通过的改动暂存于 `$CODA_ARTIFACTS/develop.json`；长期结果在泳道提交与 PR 中。执行者的分支/head 必须在本机仓库可读；`coda-agent --json` 标准输出是一行 `{session, branch, head, answer}`，`--continue` 保留同一会话并遵守首次的退出码约定。需要支持这两个接口的 Coda 版本。

测试在 `test/plugins/composer/`，用临时 Git 仓库及假的 coda-agent、gh 验证，不发真实 PR 或部署。
委派文案的基础采用 [oh-my-claudecode 的委派规则](https://github.com/Yeachan-Heo/oh-my-claudecode/blob/82602887b71a3984e040fac2839ec8d27a7c67b6/docs/CLAUDE.md#L16)，适配 Coda 开发流程与只读 spawn。版权与 MIT 许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
