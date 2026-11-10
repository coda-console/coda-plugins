# 测试机

iPhone、iPad 与安卓测试机由这个插件登记归属。每台设备是一个[并发组](https://github.com/coda-console/coda/blob/main/docs/workflows.md#并发组) `device:<设备名>`，容量 1；
排到、装 App、交给会话、复原都写在它的能力 `use-testbed`（`.coda/capabilities/use-testbed.bpmn`）里，会话借用设备的命令走它的另一个能力 `run-on-device`。
它依赖[宿主资源](../host/README.md)插件（`extensionDependencies`），接在那边的扩展点 `kinds` 上：会话里 `host-sim --kind <设备名>` 由它的 `scripts/host-sim.mjs` 处理。
从 Coda 的商店安装（npm 包 `@coda-console/testbed`），装它时一起装上宿主资源；给 Agent 的用法在 Skill `testbed`（`skills/testbed/SKILL.md`）。
需要会话操作时调用 `use-testbed`。无需会话操作但需要独占设备的流程（如预览版直装、开发流程的设备验收），可自行用 `hold-group device:<id>`（capacity 1）占一段，测试机会话排在它后面；流程负责自己的操作与收尾。

**设备登记**：插件在这个后端的状态目录里的 `devices.json`（[`CODA_PLUGIN_STATE`](https://github.com/coda-console/coda/blob/main/docs/plugins.md#插件进程的环境)：默认实例是 `~/.local/state/coda/data/plugins/testbed/devices.json`，
另一个[后端实例](https://github.com/coda-console/coda/blob/main/docs/deployment.md#后端实例)是 `P/data/plugins/testbed/devices.json`）。它是一个数组，每项一台归本实例的设备：

```json
[{ "id": "iphone-testbed", "name": "iPhone13pm", "udid": "…", "note": "…" }]
```

`platform` 可省，缺省是 `ios`（iPhone、iPad）；安卓设备写 `"platform": "android"`，并写 `adb`：用它的每台机器连它的 adb 地址（`主机:端口`），见[安卓测试机](#安卓测试机)。

`personal` 可省；`"personal": true` 表示维护者的个人设备：拿在维护者手里、用来验收，借给会话之前先问维护者，归还时不切黑屏。缺省为常驻测试机，给 Agent 自助使用，不问，沿用切黑屏行为。空间声明的属性均为文本，`personal` 发布为 `"true"` 或 `"false"`；读取时归一为布尔值。
`id` 是设备名（小写字母开头，字母、数字、连字符），`name` 显示名，`udid` 不重复；`note` 可省，是给拿到任务的会话的说明（这台 Mac 上怎么驱动这台设备、哪些东西不能碰），原样附在任务末尾。
登记在哪个实例就归哪个实例，`devices.json` 是归属的唯一事实来源。插件启动时声明 `device:<id>`，把 `name`、`udid`、`note`、`personal`、`platform`、`adb` 发布到空间，以 `udid` 为唯一属性；文件变化时重新全量声明。空间里同一设备只能登记一次，同名或相同 UDID 的重复登记会使占用失败并报冲突。
登记读不了时日志记录错误，保留已有声明；有效的空数组 `[]` 撤销全部声明。设备正被使用时不要改名或换 UDID。

任何实例的会话都能用设备，由引擎在归属实例排队。安装、会话的 `host-sim` 命令和切黑屏在发起的机器上执行：iPhone、iPad 要这台 Mac 与设备配对，跑 XCTest 还须有本机 runner；安卓设备要这台装着 adb、连得上登记的地址，且设备授权了这台的 adb 公钥。

**入口**：
- Agent：`workflow_run`，`workflow: "use-testbed"`，`inputs` 给 `device`（设备名，归属实例登记的 `id`）、
  `instructions`（要会话在测试机上做什么、怎么答复），可选 `app`（先装上的 `.app` 或 `.ipa` 的绝对路径）、`task`（任务名，默认「在测试机上验证」）。插件的说明告诉每个会话的 Agent 这样调用。
- 其他流程：`<callActivity calledElement="use-testbed">`，参数用 `coda:param`；项目流程先在自己的步骤构建、签名，把 App 路径传给它。

**过程**：
1. 「找测试机」：先查本地登记；没有这个 id 就用 `coda-resources group-owner device:<id>` 读取归属实例声明的显示名、UDID、说明、`personal`、平台和 adb 地址（没有平台的是 iPhone、iPad）。两边都没有则报「没有这台测试机」，列出本地可用设备，不排队。
   安卓设备在这里先 `adb connect`：连不上，或设备没授权这台的公钥，就此失败并说明，不排队。
2. 「等测试机」：`hold-group` 为「占用测试机」这一段排进组 `device:<设备名>`（`capacity` 1、`borrow="no"`：每次使用都排队，做着上一次任务的会话再发起一次也排在后面），由引擎到归属实例排队，排到才往下走；之后到这一段结束都占着它。
3. 「记下设备状态」：安卓设备排到后用 `settings list system|secure|global` 记下这时的设置，存在插件状态目录的 `snapshots/<设备名>.json`；iPhone、iPad 没有要记的。
   个人设备（`personal: true`）排到后先给用户一张卡片「借用 <显示名>」，写明哪个任务、要不要先装 App 和 `instructions`：选「借给它」才往下走；
   选「现在不行」（备注可写什么时候方便）按拒绝结束，设备直接放开，调用者收到拒绝的理由。常驻测试机不出这张卡片。
   有 `app` 就装上（`xcrun devicectl device install app`，安卓设备 `adb install -r`），再把任务交给调用的会话：要求是 `instructions`，加上设备名、UDID、借用方法和登记里的说明。
   做任务期间，这个会话（含子 Agent）用 `host-sim run --kind <设备名> -- <命令>` 操作设备：`host-sim` 经 `coda-run` 把命令交给能力 `run-on-device`，
   它用 `hold-group borrow="only"` 借这个组——只借给正在做这台设备任务的会话，别的情况立刻拒绝、不排队——借到后在会话的目录里、带会话的环境执行，
   附上 `HOST_SIM_LEASE=coda-run:<设备名>`，安卓设备另附 `ANDROID_SERIAL=<adb 地址>`（命令里再调用 `host-sim run --kind <设备名>` 直接执行，`host-sim check` 通过），退出码交回 `host-sim`。
   任务答复、撤回或运行被取消时，还在执行的这些命令随之停下（[并发组](https://github.com/coda-console/coda/blob/main/docs/workflows.md#并发组)「借用跟着任务走」），下一步等它们停完才开始。
4. 个人设备在不借、任务答复、出错、拒绝或取消后，等借用命令停完就直接离开「占用测试机」，放开设备，跳过切黑屏及其失败卡片。常驻测试机「切黑屏」：任务答复、借用的命令停完后，在发起的 Mac 上用 `xcrun devicectl device process launch --terminate-existing` 在设备上打开[黑屏 App](#黑屏-app)，限时 2 分钟；
   设置「切黑屏命令」（`testbed.blackscreen`）里有这台设备的一行时，改为用 `sh` 执行那一行，设备的 UDID 在环境变量 `UDID` 里。安卓设备的「切黑屏」是复原，见[安卓测试机](#安卓测试机)。
   装 App 或任务出错、任务被拒绝、运行被取消（流程等着 [`workflow.cancel`](https://github.com/coda-console/coda/blob/main/docs/workflows.md#执行与恢复)）时，同样先切黑屏；切黑屏时被取消，照样切完。
5. 常驻测试机切不过去（命令失败或超时，如设备断开、锁屏或没装黑屏 App）：给用户一张卡片「测试机切黑屏失败」（安卓设备是「测试机复原失败」），选「重试」或「我处理好了，放锁」；处理之前设备一直占着，不交给下一位。
   卡片没有主按钮。
6. 离开「占用测试机」这一段才放开组，排在后面的随即拿到。

**结果**：做完了，`result`、`note`、`choice` 是任务的答复，调用者照常读到；没做完时以原来的原因结束（被拒绝时是拒绝的理由），被取消的记为已取消。

**设置**：`testbed.blackscreen`「切黑屏命令」是表格，默认没有行；某台设备要换掉默认的做法时加一行：左边是设备名，右边是在发起的机器上执行的命令。
设置在整个空间只有一份，所以各台 Mac 的设备写在同一张表里，设备名在空间里不重复。

**资源**「测试机」（类型 `devices`）：这台 Mac 登记的每台设备一行（显示名 · 设备名），读数写谁在用（`use-testbed` 的运行与会话、会话借用的命令）、
用了多久、谁在排队，至多 8 个；没人用写「空闲」。读的是设备登记和 `CODA_GROUPS_STATE` 里的 `device:<设备名>`；本机没有登记设备就不显示，登记读不了时这次读取失败并写明原因。

- 装上后对这台机器的所有项目生效（[安装、停用与卸载](https://github.com/coda-console/coda/blob/main/docs/plugins.md#安装停用与卸载)），可按 Tag 限定或在项目里停用。

## 安卓测试机

安卓设备经 adb 的 TCP 连接使用，不靠 USB 线：登记里的 `adb` 是用它的每台机器都连得上的地址。设备上开一次持久的 TCP 端口（已 root 时
`setprop persist.adb.tcp.port 5555`、`settings put global adb_enabled 1`），重启后照样在。登记放在一直开着、和它在同一个网络里的机器上，
如它插着的那台；手机自己不用装这个插件。

```json
[{ "id": "xiaomi", "name": "Mi 10 Pro", "udid": "3c8a506b", "platform": "android", "adb": "192.168.1.7:5555", "note": "…" }]
```

- **授权**：每台要用它的机器，设备上要有这台的 adb 公钥（`adb pubkey ~/.android/adbkey` 打出的一行；私钥在第一次运行 adb 时生成）。设备已 root 时，由能上它的机器把这一行追加进
  `/data/misc/adb/adb_keys`，不用在手机上点「允许 USB 调试」。没授权时「找测试机」就失败并说明，不排队。
- **会话里**：`host-sim run --kind <设备名> -- adb shell …`，借用的命令里 `ANDROID_SERIAL` 已是这台（会话环境里原有的值不算数；这时查不到这台设备就不执行），
  frida（经 `adb forward`）、scrcpy 照常可用。
- **复原**：常驻的安卓测试机交出前（任务答复、出错、被取消都一样），在发起的机器上经 adb 运行（设备有 `su` 时以 root 运行：MIUI 等不让 adb 的 shell 写设置）：
  先停掉 frida-server、回到桌面、熄屏，等系统把亮灭屏时自己改的设置（蓝牙扫描参数之类）改回去：没在跑的 frida-server 算已停，几秒后还在跑、或回桌面熄屏的命令失败，
  就此失败，什么都不改、快照留着；再把 `settings` 三张表照借出时记下的对比，改了的写回、新加的删掉；
  最后重读一遍，只看写过的这些项，还有没改回的就算失败，出「测试机复原失败」卡片，处理之前设备不交给下一位。
  系统自己会变的个别项（如 MIUI 的 `applock_mask_notify`）对比时也算改过，会写回借出时的值。
  `settings` 以外的改动（App 数据、装上的 App、文件）不复原：要留下或要清掉的，会话在答复里说明。设置「切黑屏命令」里有这台的一行时照旧改为执行那一行。

## 黑屏 App

插件的 `blackscreen/BlackScreen.swift`：纯黑全屏、隐藏状态栏与主屏幕指示条的 App，iPhone、iPad 通用（OLED 黑色像素不发光；LCD 的 iPad 在它前台时把亮度压到最低，离开时还原）。
Bundle ID 是 `com.leavan.blackscreen`，切黑屏默认打开的就是它。只有常驻测试机需要安装，每台装一次；个人设备无需安装。签名用的开发描述文件到期或换设备时重装：

1. 在本仓库工作树的会话里，用持锁执行（`run-held`）运行 `sh plugins/testbed/blackscreen/build.sh <输出目录> <描述文件名>`，占一个构建名额；
   编译后用登录钥匙串里的 Apple Development 证书和这份开发描述文件签名（描述文件须是通配 App ID、包含目标设备，Team 取自描述文件），得到 `<输出目录>/BlackScreen.app`。它不碰设备。
2. 在与设备配对的 Mac 上调用 `use-testbed`，`app` 给这个 `.app`：装上后任务交给会话，答复后的切黑屏打开它，切得过去就是装好了。
