# 测试机

4.0.0（接口破坏性变更）：删清单里的 `extensions`，改写 `host/kind@1` 记录（命令 `scripts/kind.mjs`，key `devices`，spec 是 `{ "command": "testbed-sim" }`），并带命令 `testbed-sim`（就是原来的 `scripts/host-sim.mjs`）；宿主资源插件的 `host-sim` 遇到设备名，从 `PATH` 上找 `testbed-sim` 转交。`engines.coda` 仍是 6，只给预览渠道。

3.1.0：资源「测试机」改由记录命令 `scripts/resource.mjs` 写 `coda/resource@1` 记录（类型 `devices`），不再是清单里的 `contributes.resources`。设备登记读不了时，命令以非零退出，原因写在标准错误的最后一行：Coda 保留上一份记录，资源页显示「更新失败：原因」。需要先带 `coda/resource@1` 的 Coda（API Level 6）。只给预览渠道。

3.0.1：点名借设备（`device`）时，按 `coda resources group-owner` 的三种结果处理：只有「没有这台」（没有这个名字的记录，报「没有这台测试机」）和「本机够不着」（`reachable: false`，报设备在哪台机器（`location`）上、到那台上借，并附够得着它的机器 ID（`reachedBy`），安卓说「没有本机可达的 adb 链路」，iOS 说「本机够不着」）在排队前就结束；够得着的照常排队借。按池子借（`select`）不变。需要先带这种组主人回答的 Coda。只给预览渠道。

3.0.0（接口破坏性变更）：删设置 `testbed.entities`「安卓本体」，安卓不再按别名找本体：安卓设备由保管方（android 插件）写成一条 `device:<设备名>` 的组记录，带 adb 链路，点名用设备名，与 iOS 一样。`use-testbed` 加可选输入 `select`（与 `device` 恰写一个），按池子借；`use-testbed`、`resolve-testbed` 不再输出 `entity`。写给 Coda 的 iOS 组记录补上 `capacity: 1`。需要先带 `hold-group` 有 `select` 的协议（`@coda-console/protocol` 6.11.0）和合一后组记录的 Coda。只给预览渠道。

2.1.0：写 `coda/group@1` 记录时，`spec` 里不再带 `plugin`（持有插件由 Coda 记在条目上）。需要先带 H4 之后结构减负的 Coda。只给预览渠道。

2.0.1：脚本、README、Skill 改用 `coda` 一个命令的子命令（`coda run`、`coda resources`），不再用 `coda-run`、`coda-resources`。需要先带 H5 的 Coda。只给预览渠道。

2.0.0（接口破坏性变更）：设备归属改用 Coda 的新接口 `coda.replace('coda/group@1', …)`，不再用 `resources.declareGroups`，也不再自己串行声明（宿主按插件依次写）；清单声明实现 `coda/group@1`。每台设备一条记录：插件给的 key 是 udid，记录 ID 由宿主按后端、插件、种类和 key 派生；`spec.name` 是 `device:<设备名>`，`spec` 另有 `plugin`（本插件）、`attributes`、`unique`，内容与原来的声明一致。需要先带这套接口的 Coda（coda#2749）。只给预览渠道。

iPhone、iPad 测试机由这个插件登记归属；安卓由保管方（android 插件）登记。每台设备是一个[并发组](https://github.com/coda-console/coda/blob/main/docs/workflows.md#并发组)，组名都是 `device:<设备名>`，容量 1；
排到、装 App、交给会话写在它的能力 `use-testbed`（`.coda/capabilities/use-testbed.bpmn`）里，会话借用设备的命令走它的另一个能力 `run-on-device`。
它依赖[宿主资源](../host/README.md)插件（`extensionDependencies`），写那边定义的记录 `host/kind@1`、带命令 `testbed-sim`：会话里 `host-sim --kind <设备名>` 由它的 `scripts/host-sim.mjs` 处理。
从 Coda 的商店安装（npm 包 `@coda-console/testbed`），装它时一起装上宿主资源；给 Agent 的用法在 Skill `testbed`（`skills/testbed/SKILL.md`）。
需要会话操作时调用 `use-testbed`。无需会话操作但需要独占设备的流程（如预览版直装、开发流程的设备验收），先调用 `resolve-testbed`（参数 device），读返回的 group、platform、adb（iOS 为空），再用 `hold-group` 占返回的 group（capacity 1）这一段，不自行拼组名，测试机会话排在它后面；流程负责自己的操作与收尾。

**设备登记**：插件在这个后端的状态目录里的 `devices.json`（[`CODA_PLUGIN_STATE`](https://github.com/coda-console/coda/blob/main/docs/plugins.md#插件进程的环境)：默认实例是 `~/.local/state/coda/data/plugins/testbed/devices.json`，
另一个[后端实例](https://github.com/coda-console/coda/blob/main/docs/deployment.md#后端实例)是 `P/data/plugins/testbed/devices.json`）。它是一个数组，每项一台归本实例的 iOS 设备：

```json
[{ "id": "iphone-testbed", "name": "iPhone13pm", "udid": "…", "note": "…" }]
```

`platform` 可省，缺省是 `ios`（iPhone、iPad）；devices.json 只放 iOS 设备。安卓由保管方登记，见[安卓测试机](#安卓测试机)。

`personal` 可省；`"personal": true` 表示维护者的个人设备：拿在维护者手里、用来验收，借给会话之前先问维护者，归还时不切黑屏。缺省为常驻测试机，给 Agent 自助使用，不问，沿用切黑屏行为。空间声明的属性均为文本，`personal` 发布为 `"true"` 或 `"false"`；读取时归一为布尔值。
`id` 是设备名（小写字母开头，字母、数字、连字符），`name` 显示名，`udid` 不重复；`note` 可省，是给拿到任务的会话的说明（这台 Mac 上怎么驱动这台设备、哪些东西不能碰），原样附在任务末尾。
登记在哪个实例就归哪个实例，`devices.json` 是归属的唯一事实来源。插件启动时声明 `device:<id>`，把 `name`、`udid`、`note`、`personal`、`platform` 发布到空间，以 `udid` 为唯一属性；文件变化时重新全量声明。空间里同一设备只能登记一次，同名或相同 UDID 的重复登记会使占用失败并报冲突。
登记读不了时日志记录错误，保留已有声明；有效的空数组 `[]` 撤销全部声明。设备正被使用时不要改名或换 UDID。

任何实例的会话都能用设备，由引擎在归属实例排队。安装、会话的 `host-sim` 命令和切黑屏在发起的机器上执行：iPhone、iPad 要这台 Mac 与设备配对，跑 XCTest 还须有本机 runner；安卓设备要这台装着 adb、连得上本机可达 adb 链路的 endpoint，且设备授权了这台的 adb 公钥。

**入口**：
- Agent：`workflow_run`，`workflow: "use-testbed"`，`inputs` 给 `device`（设备名，iOS 登记的 `id` 或安卓的 `android.name`）或 `select`（两个恰写一个，见下）、
  `instructions`（要会话在测试机上做什么、怎么答复），可选 `app`（先装上的 `.app`、`.ipa` 或 `.apk` 的绝对路径）、`task`（任务名，默认「在测试机上验证」）。插件的说明告诉每个会话的 Agent 这样调用。
- 其他流程：`<callActivity calledElement="use-testbed">`，参数用 `coda:param`；项目流程先在自己的步骤构建、签名，把 App 路径传给它。

**过程**：
1. 「找测试机」：写 `device` 时，按设备名解析，不排队就失败的都在这里。本地登记里有这个 id 就是 iOS；没有就用 `coda resources group-owner device:<设备名>` 读归属方声明的组：
   带着本机可达的 adb 链路（Coda 已按可达范围过滤，取第一条 adb 链路的 endpoint，保留 Coda 的优先顺序）就是安卓；否则是别的实例登记的 iOS 设备，读显示名、UDID、说明、`personal` 与平台。
   安卓组本机没有可达的 adb 链路就报「没有本机可达的 adb 链路」；两处都没有就报「没有这台测试机」，列出本地可用设备。
   安卓设备在这里先 `adb connect`：连不上，或设备没授权这台的公钥，就此失败并说明，不排队。
   写 `select` 时先排再找，见下面的[按池子借](#按池子借)。`device`、`select` 两个都写或都不写，这一次调用在排队前就失败。
2. 「等测试机」：`hold-group` 为「占用测试机」这一段排进解析得到的组 `device:<设备名>`（`capacity` 1、`borrow="no"`：每次使用都排队，做着上一次任务的会话再发起一次也排在后面），由引擎到归属实例排队，排到才往下走；之后到这一段结束都占着它。
3. 「连接测试机」：安卓设备排到后由核心调用保管方借出，调用机器再用链路 endpoint 做 `adb connect`；iPhone、iPad 没有要连的。
   个人设备（`personal: true`）排到后先给用户一张卡片「借用 <显示名>」，写明哪个任务、要不要先装 App 和 `instructions`：选「借给它」才往下走；
   选「现在不行」（备注可写什么时候方便）按拒绝结束，设备直接放开，调用者收到拒绝的理由。常驻测试机不出这张卡片。
   有 `app` 就装上（`xcrun devicectl device install app`，安卓设备 `adb install -r`），再把任务交给调用的会话：要求是 `instructions`，加上设备名、UDID、借用方法和登记里的说明。
   做任务期间，这个会话（含子 Agent）用 `host-sim run --kind <设备名> -- <命令>` 操作设备：`host-sim` 经 `coda run` 把命令交给能力 `run-on-device`，
   它用 `hold-group borrow="only"` 借这个组——只借给正在做这台设备任务的会话，别的情况立刻拒绝、不排队——借到后在会话的目录里、带会话的环境执行，
   附上 `HOST_SIM_LEASE=coda-run:<设备名>`，安卓设备另附 `ANDROID_SERIAL=<adb 地址>`（命令里再调用 `host-sim run --kind <设备名>` 直接执行，`host-sim check` 通过），退出码交回 `host-sim`。
   任务答复、撤回或运行被取消时，还在执行的这些命令随之停下（[并发组](https://github.com/coda-console/coda/blob/main/docs/workflows.md#并发组)「借用跟着任务走」），下一步等它们停完才开始。
4. 个人 iOS 设备在不借、任务答复、出错、拒绝或取消后，等借用命令停完就直接离开「占用测试机」，放开设备，跳过切黑屏及其失败卡片。常驻 iOS 测试机「切黑屏」：任务答复、借用的命令停完后，在发起的 Mac 上用 `xcrun devicectl device process launch --terminate-existing` 在设备上打开[黑屏 App](#黑屏-app)，限时 2 分钟；
   设置「切黑屏命令」（`testbed.blackscreen`）里有这台设备的一行时，改为用 `sh` 执行那一行，设备的 UDID 在环境变量 `UDID` 里。安卓跳过切黑屏与人工卡片，由保管方归还，见[安卓测试机](#安卓测试机)。
   装 App 或任务出错、任务被拒绝、运行被取消（流程等着 [`workflow.cancel`](https://github.com/coda-console/coda/blob/main/docs/workflows.md#执行与恢复)）时，常驻 iOS 同样先切黑屏；切黑屏时被取消，照样切完。
5. 常驻 iOS 测试机切不过去（命令失败或超时，如设备断开、锁屏或没装黑屏 App）：给用户一张卡片「测试机切黑屏失败」，选「重试」或「我处理好了，放锁」；处理之前设备一直占着，不交给下一位。
   卡片没有主按钮。
6. 离开「占用测试机」这一段才放开组，排在后面的随即拿到。

**结果**：做完了，`result`、`note`、`choice` 是任务的答复，调用者照常读到；没做完时以原来的原因结束（被拒绝时是拒绝的理由），被取消的记为已取消。

**设置**：`testbed.blackscreen`「切黑屏命令」是表格，默认没有行；某台 iOS 设备要换掉默认的做法时加一行：左边是设备名，右边是在发起的机器上执行的命令。
设置在整个空间只有一份，所以各台 Mac 的设备写在同一张表里，设备名在空间里不重复。`testbed.entities` 已删：安卓设备名由保管方的设置 `android.name` 决定，不在这里填。

**资源**「测试机」（类型 `devices`）：这台 Mac 的 devices.json 登记的每台 iOS 设备一行（显示名 · 设备名），读数写谁在用（`use-testbed` 的运行与会话、会话借用的命令）、
用了多久、谁在排队，至多 8 个；没人用写「空闲」。读的是设备登记和 `CODA_GROUPS_STATE` 里的 `device:<设备名>`；本机没有登记设备就不显示，登记读不了时命令失败，Coda 保留上一份记录。安卓设备由保管方的资源显示，testbed 不重复列出，也不为资源读数查询远端的组。

- 装上后对这台机器的所有项目生效（[安装、停用与卸载](https://github.com/coda-console/coda/blob/main/docs/plugins.md#安装停用与卸载)），可按 Tag 限定或在项目里停用。

## 安卓测试机

安卓设备经 adb 的 TCP 连接使用，不靠 USB 线。testbed 不登记安卓设备，也没有设备名对照表：保管方（android 插件）把手机写成一条 `coda/group@1` 记录，组名 `device:<android.name>`、`attributes.platform` 为 `android`，
内嵌的 `links` 里有 adb 的 endpoint，`reach` 照它的设置 `android.machines`，`lends: true` 让 Coda 在排到后调保管方借出、放开后归还。设备名就是 `android.name`，如 `xiaomi`，`use-testbed device=xiaomi` 与 iOS 点名一样。
`group-owner` 只带回调用机器够得着的链路：这台机器不在 `android.machines` 里时，点名在「找测试机」就失败，说「没有本机可达的 adb 链路」，不排队。

### 按池子借

`use-testbed select=platform=android` 不点名：`select` 是逗号分隔的 `键=值`，全部与组记录的 `attributes` 相等才算匹配（`platform=ios`、`platform=android,model=Mi 10 Pro`），`device`、`select` 恰写一个。
流程先用 `hold-group select=…` 排到一台匹配、本机够得着的设备，排到后把得到的组名（`device:<设备名>`）按点名同样的办法解析，再连接（安卓 `adb connect`）；
之后与点名一样：任务里说明排到的设备名，会话用 `host-sim run --kind <设备名>` 操作。没有匹配、够得着的设备时当场失败，不排队。

- **授权**：每台要用它的机器，设备上要有这台的 adb 公钥（`adb pubkey ~/.android/adbkey` 打出的一行；私钥在第一次运行 adb 时生成）。设备已 root 时，由能上它的机器把这一行追加进
  `/data/misc/adb/adb_keys`，不用在手机上点「允许 USB 调试」。没授权时「找测试机」就失败并说明，不排队。
- **会话里**：`host-sim run --kind <设备名> -- adb shell …`，借用的命令里 `ANDROID_SERIAL` 已是这台（会话环境里原有的值不算数；这时查不到这台设备就不执行），
  frida（经 `adb forward`）、scrcpy 照常可用。
- **复原**：安卓设备的借出、归还由核心调用保管方记录上的 `lend`、`return` 操作执行；借出时记录 settings，归还时改回、停掉 frida-server、回到桌面并熄屏。
  testbed 不再拍安卓快照或执行复原，也不使用「切黑屏命令」或出重试、放锁卡片。归还失败由核心把这个组的 `status.state` 标成 failed、队列停住，等保管方重新给出记录时再试。
  `settings` 以外的改动（App 数据、装上的 App、文件）不复原：要留下或要清掉的，会话在答复里说明。

## 黑屏 App

插件的 `blackscreen/BlackScreen.swift`：纯黑全屏、隐藏状态栏与主屏幕指示条的 App，iPhone、iPad 通用（OLED 黑色像素不发光；LCD 的 iPad 在它前台时把亮度压到最低，离开时还原）。
Bundle ID 是 `com.leavan.blackscreen`，切黑屏默认打开的就是它。只有常驻测试机需要安装，每台装一次；个人设备无需安装。签名用的开发描述文件到期或换设备时重装：

1. 在本仓库工作树的会话里，用持锁执行（`run-held`）运行 `sh plugins/testbed/blackscreen/build.sh <输出目录> <描述文件名>`，占一个构建名额；
   编译后用登录钥匙串里的 Apple Development 证书和这份开发描述文件签名（描述文件须是通配 App ID、包含目标设备，Team 取自描述文件），得到 `<输出目录>/BlackScreen.app`。它不碰设备。
2. 在与设备配对的 Mac 上调用 `use-testbed`，`app` 给这个 `.app`：装上后任务交给会话，答复后的切黑屏打开它，切得过去就是装好了。
