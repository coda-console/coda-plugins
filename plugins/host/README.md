# 宿主资源

## 名额与模拟器清点

4.0.0（接口破坏性变更）：不再发布 `coda/executor@1` 执行器记录：清单里的 `protocolImplementations`、每分钟的本机探测与容量计算一并删掉。名额（组 `host`、`run-held`、`host-sim`）与模拟器清点不变，插件模块只剩 `coda self run-finished` 的处理。需要先带 H4 之后结构减负的 Coda。只给预览渠道。

3.1.0：清理脚本改用 `coda self run-finished` 问本插件模块，模块用 `coda.self.handle` 登记，不再开本机端口、不再写状态文件。需要先带 H5（命令的绑定）的 Coda。只给预览渠道。

3.0.0（接口破坏性变更）：记录的读写换成 Coda 的新接口（`coda.put`、`coda.watch`），不再用 `protocols.observe`、`put`、`setStatus`、`publish`，也不再自己串行写。执行器记录整份写（spec 与 status 一起），只在内容变了或 status 满 55 秒时写；status 里的 `observedRevision` 改为 spec 内容的摘要（执行器协议的 status 非空时必须带这个字段，只是 `required` 里没列、写在 `anyOf` 的第二支；Coda 里没有读它的地方，所以只求合乎协议）。只给预览渠道。

2.4.0：删掉外派执行（Coda 已不再把步骤交给别台执行）：`execute` 的处理函数、源码获取与工作副本、独立 worker 与 hook，以及设置 `host.enabled`、`host.labels`；`run-held` 只在本机排队，不再收 `local`，也不再去空间里别的 Mac 跑。只给预览渠道。

**验证**：纯规则、模拟器登记与清点、run-held 脚本、超时、取消与流程形状在 `test/plugins/host/`。真实 Coda 存储／资源账本装配留 Coda 仓库验证。包含 host-sim 的完整插件测试经会话的 `workflow_run` → `run-held` 运行，不启动真实模拟器。

## 现有持锁执行与模拟器工具

这个后端实例的 Apple 模拟器、Xcode 构建和项目要求排队的命令共用一组名额，会话里的这类命令经这个插件排队与执行。名额是流程引擎的[并发组](https://github.com/coda-console/coda/blob/main/docs/workflows.md#并发组) `host`，
每个[后端实例](https://github.com/coda-console/coda/blob/main/docs/deployment.md#后端实例)各有一组，同一台 Mac 上的两个实例互不相干；插件只声明名额，也就是组 `host` 的容量，Coda 内核不认识它。

从 Coda 的商店安装（npm 包 `@coda-console/host`，分类「机器与资源」），不随 Coda 默认装上；没装时流程步骤写 `coda:group="host"` 照样排队，容量按 1，
会话里也没有 `host-sim`。用法给 Agent 的部分在 Skill `host-slots`（`skills/host-slots/SKILL.md`）。

**范围**：插件的说明让会话的 Agent 把三类命令交给持锁执行：Xcode 构建、用 Apple 模拟器的命令、会调用 `host-sim` 的项目脚本。
别的命令（其他项目的构建、测试、静态检查）直接执行，不因为是构建就排队；项目要别的命令也排队，就在项目说明（如 `AGENTS.md`）里写明，
或让脚本经 `host-sim` 自己排队（见下文）。流程步骤占不占名额由流程自己用 `coda:group="host"` 声明。

**入口**：会话的 Agent 用 `workflow_run` 调用能力 `run-held`（持锁执行），`inputs` 给 `command`（要执行的命令，由 `$SHELL -c` 执行）、
`cwd`（在哪个目录执行，绝对路径），用模拟器时 `what` 为 `模拟器`（默认 `构建`）。命令一律在这台排队、在这台跑。
能力写了 `coda:inline` 与 `coda:subagents="false"`：
结束得快就随这次调用返回结果，否则结果之后送回会话（见 [Agent 工具](https://github.com/coda-console/coda/blob/main/docs/workflows.md#agent-工具)）；原生子 Agent 发起时拒绝，
提示把这一步交回主 Agent 或用 `spawn` 派 Coda 子会话（见[流程属性](https://github.com/coda-console/coda/blob/main/docs/workflows.md#流程属性)）。从命令行（`coda run`）发起同样拒绝：命令行说不出是会话里谁在要。

`host-sim` 是这个插件放在会话 `PATH` 上的[命令](https://github.com/coda-console/coda/blob/main/docs/plugins.md#命令)（`scripts/host-sim.mjs`），只在已占着的名额里用：持锁执行的命令里（`HOST_SIM_LEASE`），
或占着组 `host` 的流程步骤里（`CODA_GROUPS`）。在会话里不在名额中调用 `host-sim run --kind build|simulator -- <命令>` 时拒绝（退出码 2），
提示改由 Agent 用 `workflow_run` 调用 `run-held` 执行这条命令；所以经 `host-sim` 自己排队的项目脚本（`scripts/check.sh` 的编译范围、iOS 构建与测试入口）
在会话里整条交给 `run-held` 执行，脚本本身不必改写。别的 `--kind`（测试机的设备名）交给接在本插件扩展点 `kinds` 上的插件（[测试机](../testbed/README.md)）。

**总时限**：`what=模拟器` 默认 60 分钟，其他 `run-held` 默认 30 分钟；从命令启动开始计时，不含排队。
长批次在 `inputs` 显式给 `timeoutMinutes`，如 `{ "command": "bash scripts/ios-ui-test.sh", "cwd": "/path/to/project", "what": "模拟器", "timeoutMinutes": 120 }`。
`timeoutMinutes=0`（默认）按种类取值；显式值须大于 0、最多 1440 分钟。由 `scripts/run-held.mjs` 计时，到限先向整组进程发送 TERM（连同另起进程组的子进程），最多留 5 分钟收尾，之后才释放名额。

**无输出上限**：`idleMinutes` 默认 10 分钟，从命令启动起，stdout 或 stderr 每次有新输出就重新计时；连续到限无输出即失败，先向整组进程发送 TERM（连同命令另起进程组的子进程，如 `swift build` 的编译器），最多留 5 分钟收尾。可在 `inputs` 设 `idleMinutes: 30` 调高，或 `idleMinutes: 0` 关闭（总时限仍生效）。失败结果与会话通知区分「执行超过总时限」「N 分钟无输出」「命令非零退出（退出码 N）」；输出 `failure_reason` 记录原因。run-held 因无输出或总时限失败、执行器超时时，若 macOS 上检测到 `SecurityAgent` 进程，失败原因会追加钥匙串授权框提示，见 [host-slots](skills/host-slots/SKILL.md#无人值守构建)。

**过程**（`.coda/capabilities/run-held.bpmn`）：「占用名额」这一段，三步：

1. 「等名额」：`hold-group` 为「占用名额」这一段排进 `host`，容量读设置 `host.capacity`；状态行写「排队等构建名额 · 排第 N 位」或「排队等模拟器名额 · 排第 N 位」，
   队伍一动就改，会话底部显示这项等待。
2. 「执行」：在 `coda:source`（即 `cwd`）里、带项目的环境（同流程步骤，不含插件与执行器自己的变量）执行命令（`scripts/run-held.mjs`），附上 `HOST_SIM_LEASE=coda-run:<种类>`：
   命令里的项目脚本再调用 `host-sim run` 时直接执行，`host-sim check` 通过，`host-sim bind <udid>` 把它启动的模拟器登记给这一步。
   `cwd` 由 Coda 作为 `coda:source` 求值，须是本机存在的绝对目录，否则这一步失败并说明。
   命令结束（含被取消）时关机并删除登记的模拟器，命令的退出码记为输出 `exit_code`；命令失败这一步也失败，Agent 收到的结果带着输出的末尾。
   被取消时整组进程收到 TERM，这一步的脚本以 `exec` 运行，执行器等它删完模拟器才结束；收尾超过取消时限被强杀而留下的模拟器，由下面的定时清点删除。
   命令启动前，日志第一行写「在 <主机名> 上执行」，用来分辨这次在哪台机器上跑；主机名取系统主机名（步骤环境里没有 Coda 给的机器名），这一行不算命令的输出，不影响无输出计时、退出码和 `failure_reason`。
3. 离开「占用名额」这一段才放开名额，排在后面的随即进入。

**执行与中断**：命令由 Coda 的步骤执行器运行，不随 Agent 的调用结束：调用先返回了，命令照常执行，结果送回会话；
要停下它用 `workflow_cancel`。命令不经过会话 Agent 自带的沙箱。

**定时清点**（`.coda/workflows/clean-simulators.bpmn`「清点模拟器」，`scripts/clean-simulators.mjs`）：`host-sim bind <udid>` 除了登记给这一步，
还把 UDID 和登记运行 ID 写进本实例插件状态的 `simulator-registrations/`，每条登记独立保存，清理不会覆盖同时新增的登记。
持锁命令通过 `HOST_SIM_RUN_ID` 传递运行 ID；普通流程步骤读 `GITHUB_RUN_ID`。
按设置 `host.cleanSchedule` 的周期清点（整个实例只跑一次，`coda:scope="machine"`），**不申请名额、不进入 host 队列**。
清理脚本用 `coda self run-finished` 问本插件模块（宿主按令牌认出是这个插件）；模块每次经公开 `coda.api("workflow-runs/<id>")` 读取运行终态，不缓存清理资格。
运行须为成功、失败或已取消才删除；运行与子运行是否收尾完成、何时发布终态，由 Coda 运行模块判断。插件不读取宿主数据库或复刻名额收尾逻辑。
运行中、取消收尾中、查不到运行、宿主接口不可用的都跳过。旧版 `simulators` 纯 UDID 登记没有归属，保留并记录原因，待人工确认闲置后处理。
删除直接交给 `simctl delete`，不强制关机；使用中或删不掉的跳过、记日志并保留登记，下次再试，已经不在的算删完。不为删除与其他进程使用的罕见交错加锁。
没经 `host-sim bind` 登记的模拟器不删：用户自己建的，同一用户另一个后端实例的。
只有这个实例自己的正式后端（`CODA_ARBITER`，[插件进程的环境](https://github.com/coda-console/coda/blob/main/docs/plugins.md#插件进程的环境)）真正删除，测试或开发起的后端跑这条流程什么也不删。

**会话之外**：终端里没有这个命令；从会话以外的地方调用插件的 `host-sim` 不排队，也不执行，提示只能在 Coda 的会话或流程步骤里用；
没有占着组的流程步骤里调用同样拒绝，提示写 `coda:group="host"`。

**资源**「构建名额」（类型 `slots`）：从 `CODA_GROUPS_STATE` 读组 `host`，一行：读数「空闲」画空闲名额（空几个、共几个），
接着每个占着的写运行标题、所属会话和占了多久（借用中、正在收尾、占满另外注明），每个排着的写排第几、等了多久，合计至多 8 个读数。打开或刷新资源页时读，不在后台采集。
容量在「设置 › 插件」里改。

**设置**：`host.capacity`「名额数」，1–8，默认 1；`host.cleanSchedule`「清点模拟器的周期」，ISO 8601 重复间隔，默认 `R/P1D`（每天一次）。
插件以 `contributes.groups` 声明组 `host` 的容量就是 `host.capacity`，所以项目流程的步骤写 `coda:group="host"`
也按这个容量排；步骤里看到 `CODA_GROUPS` 含 `host` 时，`host-sim` 同样视作已占着名额（`run` 直接执行、`check` 通过，`bind` 只记进本实例的 `simulator-registrations/`，由定时清点删除）。`run` 直接执行的命令带上 `HOST_SIM_LEASE=coda-group:host`，所以只看有没有 `HOST_SIM_LEASE` 的项目脚本在步骤里多走一次就照常往下，不会反复调用自己。项目脚本判断自己在不在名额里应问 `host-sim check`（Skill `host-slots`）：测试机上执行的命令也带 `HOST_SIM_LEASE`，占的却不是构建名额。已占着名额只说构建与模拟器，测试机的设备名另由[测试机插件](../testbed/README.md)借用：在构建名额里用设备名调用，同样交给测试机插件，只借给正在做那台设备任务的会话。

**扩展点** `kinds`：`host-sim` 遇到 `build`、`simulator` 之外的 `--kind`，把整条命令交给接在这里的第一个命令（按插件 ID 排），参数原样附在后面；
那条命令以接上它的插件的 `CODA_PLUGIN_PATH`、`CODA_PLUGIN_STATE` 运行，退出码就是 `host-sim` 的。没有插件接上时拒绝，提示装测试机插件。

- 装上后对这台机器的所有项目生效（[安装、停用与卸载](https://github.com/coda-console/coda/blob/main/docs/plugins.md#安装停用与卸载)），可按 Tag 限定或在项目里停用。


## 守护文件事件服务（fseventsd）

2.2.0 起带一个定时流程「文件事件服务守护」（`.coda/workflows/fseventsd-guard.bpmn`，`scripts/fseventsd-guard.mjs`）。
macOS 27 的 `fseventsd` 清理游标用完后就再也不回收路径记录，常编译、开 worktree 的机器两三周会撞上：内存涨到几 GB、通知线程占满一个核（[coda#2448](https://github.com/coda-console/coda/issues/2448)）。
只能重启它来恢复，根治要等 Apple；Apple 修好后在新版本里删掉这个流程。

按 `host.fseventsdSchedule` 的周期（整个实例只跑一次，`coda:scope="machine"`，不申请名额），用 `top -l 1 -pid <pgrep -x fseventsd> -stats mem` 读它的占用，
没超过 `host.fseventsdThresholdMB` 就只记下，超过了执行 `sudo -n killall fseventsd`，并在插件状态的 `fseventsd-guard.json` 里累计重启次数。
运行的状态行写「fseventsd 占用 N MB · 累计重启 K 次」，重启的那次写「fseventsd 占用 N MB，超过 T MB，已重启 · 累计重启 K 次」；占用和阈值也写进步骤摘要。
读不出占用、或重启失败（多半是没有免密 sudo）时这次运行失败，写明原因和要手动执行的命令 `sudo killall fseventsd`；不重试，下一个周期再看。
只在 macOS 上、只在这个实例自己的正式后端（`CODA_ARBITER`）上做，测试或开发起的后端什么也不做。

**设置**：`host.fseventsdGuard`「守护文件事件服务」，默认开，关掉后到点不再启动（流程的 `coda:autoRun`）；`host.fseventsdSchedule`「守护文件事件服务的周期」，ISO 8601 重复间隔，默认 `R/PT10M`（每 10 分钟）；`host.fseventsdThresholdMB`「fseventsd 占用阈值（MB）」，最小 64，默认 512。

**免密规则**由人加，插件不改 sudoers。用 `sudo visudo -f /etc/sudoers.d/fseventsd` 写一行，只放行这一条命令（`<用户名>` 换成运行 Coda 的用户）：

```
<用户名> ALL=(root) NOPASSWD: /usr/bin/killall fseventsd
```
