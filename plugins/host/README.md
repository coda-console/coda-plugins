# 宿主资源

这个后端实例的 Apple 模拟器、Xcode 构建和项目要求排队的命令共用一组名额，会话里的这类命令经这个插件排队与执行。名额是流程引擎的[并发组](https://github.com/coda-console/coda/blob/main/docs/workflows.md#并发组) `host`，
每个[后端实例](https://github.com/coda-console/coda/blob/main/docs/deployment.md#后端实例)各有一组，同一台 Mac 上的两个实例互不相干；插件只说它装的是什么、能同时进几个，Coda 内核不认识它。

从 Coda 的商店安装（npm 包 `@coda-console/host`，分类「机器与资源」），不随 Coda 默认装上；没装时流程步骤写 `coda:group="host"` 照样排队，容量按 1，
会话里也没有 `host-sim`。用法给 Agent 的部分在 Skill `host-slots`（`skills/host-slots/SKILL.md`）。

**范围**：插件的说明让会话的 Agent 把三类命令交给持锁执行：Xcode 构建、用 Apple 模拟器的命令、会调用 `host-sim` 的项目脚本。
别的命令（其他项目的构建、测试、静态检查）直接执行，不因为是构建就排队；项目要别的命令也排队，就在项目说明（如 `AGENTS.md`）里写明，
或让脚本经 `host-sim` 自己排队（见下文）。流程步骤占不占名额由流程自己用 `coda:group="host"` 声明。

**入口**：会话的 Agent 用 `workflow_run` 调用能力 `run-held`（持锁执行），`inputs` 给 `command`（要执行的命令，由 `$SHELL -c` 执行）、
`cwd`（在哪个目录执行，绝对路径），用模拟器时 `what` 为 `模拟器`（默认 `构建`，只写进状态行）。能力写了 `coda:inline` 与 `coda:subagents="false"`：
结束得快就随这次调用返回结果，否则结果之后送回会话（见 [Agent 工具](https://github.com/coda-console/coda/blob/main/docs/workflows.md#agent-工具)）；原生子 Agent 发起时拒绝，
提示把这一步交回主 Agent 或用 `spawn` 派 Coda 子会话（见[流程属性](https://github.com/coda-console/coda/blob/main/docs/workflows.md#流程属性)）。从命令行（`coda-run`）发起同样拒绝：命令行说不出是会话里谁在要。

`host-sim` 是这个插件放在会话 `PATH` 上的[命令](https://github.com/coda-console/coda/blob/main/docs/plugins.md#命令)（`scripts/host-sim.mjs`），只在已占着的名额里用：持锁执行的命令里（`HOST_SIM_LEASE`），
或占着组 `host` 的流程步骤里（`CODA_GROUPS`）。在会话里不在名额中调用 `host-sim run --kind build|simulator -- <命令>` 时拒绝（退出码 2），
提示改由 Agent 用 `workflow_run` 调用 `run-held` 执行这条命令；所以经 `host-sim` 自己排队的项目脚本（`scripts/check.sh` 的编译范围、iOS 构建与测试入口）
在会话里整条交给 `run-held` 执行，脚本本身不必改写。别的 `--kind`（测试机的设备名）交给接在本插件扩展点 `kinds` 上的插件（[测试机](../testbed/README.md)）。

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
还把模拟器记进本实例插件状态里的 `simulators`（`<状态根>/plugins/host/simulators`）。按设置 `host.cleanSchedule` 的周期（[定时开始](https://github.com/coda-console/coda/blob/main/docs/workflows.md#定时开始)，整个实例只跑一次，`coda:scope="machine"`），
「等名额全部空出」以 `hold-group exclusive="true"` 占满组 `host`：排到时没有别人占着，占着时也不放别人进来；然后删掉表里记着的模拟器，再放开。
用模拟器的命令都在组 `host` 里（持锁执行的命令、写 `coda:group="host"` 的步骤），占满时没人在用，所以都是没人要的：步骤用过的，命令被强杀前没来得及删的。
删不掉的留在表里，下次再删，已经不在的算删完。没经 `host-sim bind` 登记的模拟器不删：用户自己建的，同一用户另一个后端实例的。
只有这个实例自己的正式后端（`CODA_ARBITER`，[插件进程的环境](https://github.com/coda-console/coda/blob/main/docs/plugins.md#插件进程的环境)）真正删除，测试或开发起的后端跑这条流程什么也不删。

**会话之外**：终端里没有这个命令；从会话以外的地方调用插件的 `host-sim` 不排队，也不执行，提示只能在 Coda 的会话或流程步骤里用；
没有占着组的流程步骤里调用同样拒绝，提示写 `coda:group="host"`。

**面板**「构建与模拟器名额」（`slots`）：从 `CODA_GROUPS_STATE` 读组 `host`，一条进度条画空闲名额（空几个、共几个，说明行写几个在排队；清点占满时空 0 个），
下面每个占着的写运行标题、所属会话和占了多久（借用中、正在收尾、占满另外注明），每个排着的写排第几、等了多久。打开或刷新资源页时读，不在后台采集。
容量在「设置 › 插件」里改。

**设置**：`host.capacity`「名额数」，1–8，默认 1；`host.cleanSchedule`「清点模拟器的周期」，ISO 8601 重复间隔，默认 `R/P1D`（每天一次）。
插件以 `contributes.groups` 声明组 `host` 的容量就是 `host.capacity`，所以项目流程的步骤写 `coda:group="host"`
也按这个容量排；步骤里看到 `CODA_GROUPS` 含 `host` 时，`host-sim` 同样视作已占着名额（`run` 直接执行、`check` 通过，`bind` 只记进本实例的 `simulators`，由定时清点删除）。`run` 直接执行的命令带上 `HOST_SIM_LEASE=coda-group:host`，所以只看有没有 `HOST_SIM_LEASE` 的项目脚本在步骤里多走一次就照常往下，不会反复调用自己。项目脚本判断自己在不在名额里应问 `host-sim check`（Skill `host-slots`）：测试机上执行的命令也带 `HOST_SIM_LEASE`，占的却不是构建名额。已占着名额只说构建与模拟器，测试机的设备名另由[测试机插件](../testbed/README.md)借用：在构建名额里用设备名调用，同样交给测试机插件，只借给正在做那台设备任务的会话。

**扩展点** `kinds`：`host-sim` 遇到 `build`、`simulator` 之外的 `--kind`，把整条命令交给接在这里的第一个命令（按插件 ID 排），参数原样附在后面；
那条命令以接上它的插件的 `CODA_PLUGIN_PATH`、`CODA_PLUGIN_STATE` 运行，退出码就是 `host-sim` 的。没有插件接上时拒绝，提示装测试机插件。

- 装上后对这台机器的所有项目生效（[安装、停用与卸载](https://github.com/coda-console/coda/blob/main/docs/plugins.md#安装停用与卸载)），可按 Tag 限定或在项目里停用。

