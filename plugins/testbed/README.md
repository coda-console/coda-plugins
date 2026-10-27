# 测试机

长插在 Mac 上的 iPhone、iPad 测试机只经这个插件使用。每台设备是一个[并发组](https://github.com/coda-console/coda/blob/main/docs/workflows.md#并发组) `device:<设备名>`，容量 1；
排到、装 App、交给会话、复原都写在它的能力 `use-testbed`（`.coda/capabilities/use-testbed.bpmn`）里，会话借用设备的命令走它的另一个能力 `run-on-device`。
它依赖[宿主资源](../host/README.md)插件（`extensionDependencies`），接在那边的扩展点 `kinds` 上：会话里 `host-sim --kind <设备名>` 由它的 `scripts/host-sim.mjs` 处理。
从 Coda 的商店安装（npm 包 `@coda-console/testbed`），装它时一起装上宿主资源；给 Agent 的用法在 Skill `testbed`（`skills/testbed/SKILL.md`）。
组是协作的锁：项目流程也能写出同名的组，但设备的 UDID、借用和复原只在这个插件里，项目流程调用 `use-testbed`，不自己占设备的组。

**设备登记**：插件在这个后端的状态目录里的 `devices.json`（[`CODA_PLUGIN_STATE`](https://github.com/coda-console/coda/blob/main/docs/plugins.md#插件进程的环境)：默认实例是 `~/.local/state/coda/data/plugins/testbed/devices.json`，
另一个[后端实例](https://github.com/coda-console/coda/blob/main/docs/deployment.md#后端实例)是 `P/data/plugins/testbed/devices.json`）。它是一个数组，每项一台插在这台 Mac 上的设备：

```json
[{ "id": "iphone-testbed", "name": "iPhone13pm", "udid": "…", "note": "…" }]
```

`id` 是设备名（小写字母开头，字母、数字、连字符），`name` 显示名，`udid` 不重复；`note` 可省，是给拿到任务的会话的说明（这台 Mac 上怎么驱动这台设备、哪些东西不能碰），原样附在任务末尾。
登记属于这台 Mac 的这个实例，不经空间同步。增删改就是改这个文件，每次使用开始时读，不用重启；设备正被使用时不要改名或换 UDID。

**入口**：
- Agent：`workflow_run`，`workflow: "use-testbed"`，`inputs` 给 `device`（设备名，它所在 Mac 登记的 `id`）、
  `instructions`（要会话在测试机上做什么、怎么答复），可选 `app`（先装上的 `.app` 或 `.ipa` 的绝对路径）、`task`（任务名，默认「在测试机上验证」）。插件的说明告诉每个会话的 Agent 这样调用。
- 其他流程：`<callActivity calledElement="use-testbed">`，参数用 `coda:param`；项目流程先在自己的步骤构建、签名，把 App 路径传给它。

**过程**：
1. 「找测试机」：从本机的设备登记查出这个设备名的显示名、UDID 和说明；没有登记就失败，写明登记了哪些，不排队。
2. 「等测试机」：`hold-group` 为「占用测试机」这一段排进组 `device:<设备名>`（`capacity` 1、`borrow="no"`：每次使用都排队，做着上一次任务的会话再发起一次也排在后面），排到才往下走；之后到这一段结束都占着它。
3. 有 `app` 就装上（`xcrun devicectl device install app`），再把任务交给调用的会话：要求是 `instructions`，加上设备名、UDID、借用方法和登记里的说明。
   做任务期间，这个会话（含子 Agent）用 `host-sim run --kind <设备名> -- <命令>` 操作设备：`host-sim` 经 `coda-run` 把命令交给能力 `run-on-device`，
   它用 `hold-group borrow="only"` 借这个组——只借给正在做这台设备任务的会话，别的情况立刻拒绝、不排队——借到后在会话的目录里、带会话的环境执行，
   附上 `HOST_SIM_LEASE=coda-run:<设备名>`（命令里再调用 `host-sim run --kind <设备名>` 直接执行，`host-sim check` 通过），退出码交回 `host-sim`。
   任务答复、撤回或运行被取消时，还在执行的这些命令随之停下（[并发组](https://github.com/coda-console/coda/blob/main/docs/workflows.md#并发组)「借用跟着任务走」），下一步等它们停完才开始。
4. 「切黑屏」：任务答复、借用的命令停完后，在这台 Mac 上用 `xcrun devicectl device process launch --terminate-existing` 在设备上打开[黑屏 App](#黑屏-app)，限时 2 分钟；
   设置「切黑屏命令」（`testbed.blackscreen`）里有这台设备的一行时，改为用 `sh` 执行那一行，设备的 UDID 在环境变量 `UDID` 里。
   装 App 或任务出错、任务被拒绝、运行被取消（流程等着 [`workflow.cancel`](https://github.com/coda-console/coda/blob/main/docs/workflows.md#执行与恢复)）时，同样先切黑屏；切黑屏时被取消，照样切完。
5. 切不过去（命令失败或超时，如设备断开、锁屏或没装黑屏 App）：给用户一张卡片「测试机切黑屏失败」，选「重试」或「我处理好了，放锁」；处理之前设备一直占着，不交给下一位。
   卡片没有主按钮。
6. 离开「占用测试机」这一段才放开组，排在后面的随即拿到。

**结果**：做完了，`result`、`note`、`choice` 是任务的答复，调用者照常读到；没做完时以原来的原因结束（被拒绝时是拒绝的理由），被取消的记为已取消。

**设置**：`testbed.blackscreen`「切黑屏命令」是表格，默认没有行；某台设备要换掉默认的做法时加一行：左边是设备名，右边是在那台 Mac 上执行的命令。
设置在整个空间只有一份，所以各台 Mac 的设备写在同一张表里，设备名在空间里不重复。

**面板**「测试机」（`devices`）：这台 Mac 登记的每台设备一张卡片（显示名、设备名），写谁在用（`use-testbed` 的运行与会话、会话借用的命令）、
用了多久、谁在排队；没人用写「空闲」。读的是设备登记和 `CODA_GROUPS_STATE` 里的 `device:<设备名>`；本机没有登记设备就不显示。

- 装上后对这台机器的所有项目生效（[安装、停用与卸载](https://github.com/coda-console/coda/blob/main/docs/plugins.md#安装停用与卸载)），可按 Tag 限定或在项目里停用。

## 黑屏 App

插件的 `blackscreen/BlackScreen.swift`：纯黑全屏、隐藏状态栏与主屏幕指示条的 App，iPhone、iPad 通用（OLED 黑色像素不发光；LCD 的 iPad 在它前台时把亮度压到最低，离开时还原）。
Bundle ID 是 `com.leavan.blackscreen`，切黑屏默认打开的就是它。每台测试机装一次；签名用的开发描述文件到期或换设备时重装：

1. 在本仓库工作树的会话里，用持锁执行（`run-held`）运行 `sh plugins/testbed/blackscreen/build.sh <输出目录> <描述文件名>`，占一个构建名额；
   编译后用登录钥匙串里的 Apple Development 证书和这份开发描述文件签名（描述文件须是通配 App ID、包含目标设备，Team 取自描述文件），得到 `<输出目录>/BlackScreen.app`。它不碰设备。
2. 在设备所在的 Mac 上调用 `use-testbed`，`app` 给这个 `.app`：装上后任务交给会话，答复后的切黑屏打开它，切得过去就是装好了。
