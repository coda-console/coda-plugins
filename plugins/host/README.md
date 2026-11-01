# 宿主资源

## 运行器与执行请求

从 1.2.0 起，host 实现公共 `executor`／`execution` 协议：配置意图、能力和名额在本机持有，执行请求由发起端持有，只有绑定给本机 `executor/host` 的请求才执行。协议 schema 来自 `@coda-console/protocol/executor`，不在插件里维护副本；需要 git 插件与 Coda 的 `protocols.resolve`、`resources.acquire/release/list` 接口。`run-held` 的流程入口仍保持原路径，第 9 步再切到执行请求。

插件启动登记类型，公布一个本实例的 `executor/host`。`host.enabled` 控制是否接活，默认 true；`host.capacity` 配置名额数；`host.labels` 是逗号分隔的自定义标签。系统／CPU、Node、Xcode、可用模拟器 runtime 与图形会话由本机探测，每分钟刷新，不启动模拟器。容量和占用订阅 `concurrency-groups`，包括旧流程与 run-held，公布值不构成预留。停止接活不终止已接收的任务。

资源首版只接受 `{slots: 1}`；`exclusiveResources: ['slots']` 表示独占，默认不独占。host 将 slots 映射到本机组 host，开跑前通过同一名额账本最终准入，账本返回稳定名额序号。其他资源量不能模拟为多次申请；scheduler 只读能力、资源量并修改单值绑定，不负责本机预留。

**创建与取消**：本机插件经服务 `plugins/host/services/execution` 操作。POST `/requests/<id>` 的正文为 `{spec}`，只能创建未绑定请求（`executor` 和 `assignmentId` 都为 null），重复 ID 拒绝；GET 同路径读本机正本。scheduler 带观察到的 revision 更新完整 spec 中的绑定及 assignmentId；绑定后 host 才发布该请求。POST `/requests/<id>/cancel` 带 `{revision}`，只把 `spec.cancel` 改为 true。远端调用者不能通过这些入口创建或取消本机请求。任务、源码、需求在首次绑定后不再修改，重试创建新 ID／attempt。

**源码**：提交端先用 git 插件创建 ready 的 sourceSnapshot，或引用 gitSource 加完整 commit。跨机时须发布快照及所属源；host 经 `protocols.observe` 看对象，经 `protocols.resolve(ref, 'repository')` 获得鉴权到达，不拼机器 ID 或 `/forward`。快照的 source ID 在其持有者范围内解释。代理鉴权头只传给本次 Git 子进程，不进入对象、日志、持久记录或 `.git/config`。

固定目录为 `<插件状态>/workspaces/<来源工作副本身份及 instance 的散列>/<账本名额序号>`，不同来源工作副本、不同名额隔离；快照或提交改变不会丢掉同源缓存。fetch 后校验 commit，执行 `reset --hard` 和 `clean -fd`，保留被忽略缓存。cwd 必须在该工作根内，拒绝路径穿越和符号链接逃逸。没有源码的任务使用每次尝试的隔离目录。源码获取不改变发布／部署的准入政策。

**三段 hook 与恢复**：`prepare_job / run_script_step / cleanup_job` 使用原 JSON envelope，prepare 的 state 即使伴随失败也会收尾；命令退出码原样返回，cleanup 失败记日志。声明变量与执行器变量分开，取消先停止当前进程组、在收尾期限内 cleanup，确认完成后才释放名额。每次尝试在启动前持久记账；独立 worker 继续运行，不随插件宿主重启而重复启动。重启后跟随已有 worker；worker 不可达且无最终记录时报告 `result_unknown`，保留绑定与名额，绝不把丢失响应当作安全重试。取消通过带随机 token 的 loopback 控制通道交给原 worker，不对可能已被复用的 PID 盲发信号。

本机 `hostExecution` 是这一次执行的持久结果引用和日志入口，没有另一个任务队列。`execution.status.executionRun`／`logs[].ref` 指向它，经 `protocols.resolve(ref, 'execution')` 取得服务基址；GET `/runs/<解析后的 id>` 读结果，GET `/runs/<id>/log?offset=<字节位置>` 每次最多读 64 KiB。结果保留有界 outputs、summary 和日志末尾；产物字节传输留给 artifacts 插件。请求改派或删除后，旧 worker 的最终结果仍保存到自己的记录，不能写入新绑定。

**验证**：纯规则、Git 目录、hook、取消竞态与重启记录在 `test/plugins/host/`；公共形状直接用 host 安装的协议包和同步的 provider 校验器测试。真实 Coda 存储／节点镜像／资源账本装配留 Coda 仓库验证。包含 host-sim 的完整插件测试经会话的 `workflow_run` → `run-held` 运行，不启动真实模拟器。

## 现有持锁执行与模拟器工具

这个后端实例的 Apple 模拟器、Xcode 构建和项目要求排队的命令共用一组名额，会话里的这类命令经这个插件排队与执行。名额是流程引擎的[并发组](https://github.com/coda-console/coda/blob/main/docs/workflows.md#并发组) `host`，
每个[后端实例](https://github.com/coda-console/coda/blob/main/docs/deployment.md#后端实例)各有一组，同一台 Mac 上的两个实例互不相干；插件只说它装的是什么、能同时进几个，Coda 内核不认识它。

从 Coda 的商店安装（npm 包 `@coda-console/host`，分类「机器与资源」），不随 Coda 默认装上；没装时流程步骤写 `coda:group="host"` 照样排队，容量按 1，
会话里也没有 `host-sim`。用法给 Agent 的部分在 Skill `host-slots`（`skills/host-slots/SKILL.md`）。

**范围**：插件的说明让会话的 Agent 把三类命令交给持锁执行：Xcode 构建、用 Apple 模拟器的命令、会调用 `host-sim` 的项目脚本。
别的命令（其他项目的构建、测试、静态检查）直接执行，不因为是构建就排队；项目要别的命令也排队，就在项目说明（如 `AGENTS.md`）里写明，
或让脚本经 `host-sim` 自己排队（见下文）。流程步骤占不占名额由流程自己用 `coda:group="host"` 声明。

**入口**：会话的 Agent 用 `workflow_run` 调用能力 `run-held`（持锁执行），`inputs` 给 `command`（要执行的命令，由 `$SHELL -c` 执行）、
`cwd`（在哪个目录执行，绝对路径），用模拟器时 `what` 为 `模拟器`（默认 `构建`）。能力写了 `coda:inline` 与 `coda:subagents="false"`：
结束得快就随这次调用返回结果，否则结果之后送回会话（见 [Agent 工具](https://github.com/coda-console/coda/blob/main/docs/workflows.md#agent-工具)）；原生子 Agent 发起时拒绝，
提示把这一步交回主 Agent 或用 `spawn` 派 Coda 子会话（见[流程属性](https://github.com/coda-console/coda/blob/main/docs/workflows.md#流程属性)）。从命令行（`coda-run`）发起同样拒绝：命令行说不出是会话里谁在要。

`host-sim` 是这个插件放在会话 `PATH` 上的[命令](https://github.com/coda-console/coda/blob/main/docs/plugins.md#命令)（`scripts/host-sim.mjs`），只在已占着的名额里用：持锁执行的命令里（`HOST_SIM_LEASE`），
或占着组 `host` 的流程步骤里（`CODA_GROUPS`）。在会话里不在名额中调用 `host-sim run --kind build|simulator -- <命令>` 时拒绝（退出码 2），
提示改由 Agent 用 `workflow_run` 调用 `run-held` 执行这条命令；所以经 `host-sim` 自己排队的项目脚本（`scripts/check.sh` 的编译范围、iOS 构建与测试入口）
在会话里整条交给 `run-held` 执行，脚本本身不必改写。别的 `--kind`（测试机的设备名）交给接在本插件扩展点 `kinds` 上的插件（[测试机](../testbed/README.md)）。

**总时限**：`what=模拟器` 默认 60 分钟，其他 `run-held` 默认 600 分钟；从取得名额、进入执行步骤开始计时，不含排队。
长批次在 `inputs` 显式给 `timeoutMinutes`，如 `{ "command": "bash scripts/ios-ui-test.sh", "cwd": "/path/to/project", "what": "模拟器", "timeoutMinutes": 120 }`。
`timeoutMinutes=0`（默认）按种类取值；显式值须大于 0、最多 1440 分钟。用引擎的中断计时器取消整组进程，保留 5 分钟清理宽限，之后才释放名额；不按日志增长判断卡死。

**过程**（`.coda/capabilities/run-held.bpmn`）：
1. 「等名额」：`hold-group` 为「占用名额」这一段排进 `host`，容量读设置 `host.capacity`；状态行写「排队等构建名额 · 排第 N 位」或「排队等模拟器名额 · 排第 N 位」，
   队伍一动就改，会话底部显示这项等待。
2. 「执行」：在 `cwd` 里、带项目的环境（同流程步骤，不含插件与执行器自己的变量）执行命令（`scripts/run-held.mjs`），附上 `HOST_SIM_LEASE=coda-run:<种类>`：
   命令里的项目脚本再调用 `host-sim run` 时直接执行，`host-sim check` 通过，`host-sim bind <udid>` 把它启动的模拟器登记给这一步。
   `cwd` 不是存在的目录的绝对路径时不执行，退出码记为 2。
   命令结束（含被取消）时关机并删除登记的模拟器，命令的退出码记为输出 `exit_code`；命令失败这一步也失败，Agent 收到的结果带着输出的末尾。
   被取消时整组进程收到 TERM，这一步的脚本以 `exec` 运行，执行器等它删完模拟器才结束；收尾超过取消时限被强杀而留下的模拟器，由下面的定时清点删除。
3. 离开「占用名额」这一段才放开名额，排在后面的随即进入。

**执行与中断**：命令由 Coda 的步骤执行器运行，不随 Agent 的调用结束：调用先返回了，命令照常执行，结果送回会话；
要停下它用 `workflow_cancel`。命令不经过会话 Agent 自带的沙箱。

**定时清点**（`.coda/workflows/clean-simulators.bpmn`「清点模拟器」，`scripts/clean-simulators.mjs`）：`host-sim bind <udid>` 除了登记给这一步，
还把 UDID 和登记运行 ID 写进本实例插件状态的 `simulator-registrations/`，每条登记独立保存，清理不会覆盖同时新增的登记。
持锁命令通过 `HOST_SIM_RUN_ID` 传递运行 ID；普通流程步骤读 `GITHUB_RUN_ID`。
按设置 `host.cleanSchedule` 的周期清点（整个实例只跑一次，`coda:scope="machine"`），**不申请名额、不进入 host 队列**。
逐项只读本实例 `<状态根>/product.sqlite` 中的运行和名额账本：运行须为成功、失败或已取消，且没有仍排队／运行的步骤或持有／收尾的名额，才删除。
运行中、取消收尾中、查不到运行、读不了账本的都跳过。旧版 `simulators` 纯 UDID 登记没有归属，保留并记录原因，待人工确认闲置后处理。
删除直接交给 `simctl delete`，不强制关机；使用中或删不掉的跳过、记日志并保留登记，下次再试，已经不在的算删完。不为删除与其他进程使用的罕见交错加锁。
没经 `host-sim bind` 登记的模拟器不删：用户自己建的，同一用户另一个后端实例的。
只有这个实例自己的正式后端（`CODA_ARBITER`，[插件进程的环境](https://github.com/coda-console/coda/blob/main/docs/plugins.md#插件进程的环境)）真正删除，测试或开发起的后端跑这条流程什么也不删。

**会话之外**：终端里没有这个命令；从会话以外的地方调用插件的 `host-sim` 不排队，也不执行，提示只能在 Coda 的会话或流程步骤里用；
没有占着组的流程步骤里调用同样拒绝，提示写 `coda:group="host"`。

**面板**「构建与模拟器名额」（`slots`）：从 `CODA_GROUPS_STATE` 读组 `host`，一条进度条画空闲名额（空几个、共几个，说明行写几个在排队），
下面每个占着的写运行标题、所属会话和占了多久（借用中、正在收尾、占满另外注明），每个排着的写排第几、等了多久。打开或刷新资源页时读，不在后台采集。
容量在「设置 › 插件」里改。

**设置**：`host.capacity`「名额数」，1–8，默认 1；`host.cleanSchedule`「清点模拟器的周期」，ISO 8601 重复间隔，默认 `R/P1D`（每天一次）。
插件以 `contributes.groups` 声明组 `host` 的容量就是 `host.capacity`，所以项目流程的步骤写 `coda:group="host"`
也按这个容量排；步骤里看到 `CODA_GROUPS` 含 `host` 时，`host-sim` 同样视作已占着名额（`run` 直接执行、`check` 通过，`bind` 只记进本实例的 `simulator-registrations/`，由定时清点删除）。`run` 直接执行的命令带上 `HOST_SIM_LEASE=coda-group:host`，所以只看有没有 `HOST_SIM_LEASE` 的项目脚本在步骤里多走一次就照常往下，不会反复调用自己。项目脚本判断自己在不在名额里应问 `host-sim check`（Skill `host-slots`）：测试机上执行的命令也带 `HOST_SIM_LEASE`，占的却不是构建名额。已占着名额只说构建与模拟器，测试机的设备名另由[测试机插件](../testbed/README.md)借用：在构建名额里用设备名调用，同样交给测试机插件，只借给正在做那台设备任务的会话。

**扩展点** `kinds`：`host-sim` 遇到 `build`、`simulator` 之外的 `--kind`，把整条命令交给接在这里的第一个命令（按插件 ID 排），参数原样附在后面；
那条命令以接上它的插件的 `CODA_PLUGIN_PATH`、`CODA_PLUGIN_STATE` 运行，退出码就是 `host-sim` 的。没有插件接上时拒绝，提示装测试机插件。

- 装上后对这台机器的所有项目生效（[安装、停用与卸载](https://github.com/coda-console/coda/blob/main/docs/plugins.md#安装停用与卸载)），可按 Tag 限定或在项目里停用。

