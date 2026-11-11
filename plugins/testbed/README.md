# 测试机

iPhone、iPad 由 testbed 登记和收尾；安卓只引用保管方已登记的 `coda/entity@1` 本体，借出记录与归还由核心调用保管方钩子执行。`use-testbed` 排队、按需装 App 并交给会话；`run-on-device` 让任务中的会话借用同一组。
插件依赖 [host](../host/README.md)，通过 `host/kinds` 接入 `host-sim run --kind <设备名>`。扩展调用会话 PATH 上的 `testbed-host-sim` 命令，由 Coda 注入 testbed 的共享设置环境。

## 登记与设置

iOS 登记在保管实例的插件状态目录 `devices.json`（`$CODA_PLUGIN_STATE/devices.json`）：

```json
[{ "id": "iphone-testbed", "name": "iPhone13pm", "udid": "…", "note": "…" }]
```

只支持 iOS，`platform` 可省或为 `ios`。`personal: true` 是个人设备：借出前询问维护者，归还不切黑屏；缺省为常驻测试机。`id`、`udid` 不重复；`note` 附在任务末尾。
插件启动及文件变化时全量声明 `device:<id>`，发布 name、udid、note、personal、platform 属性，以 udid 为唯一属性。登记无法读取时保留原声明，空数组撤销声明。设备使用中不要改名或换 UDID。

iOS 组仍是 `device:<设备名>`。安卓别名放在空间共享设置表 **安卓本体**（`testbed.entities`），每行是名字和本体 UUID：

```json
[{ "name": "xiaomi", "entity": "03acc3f8-6a6c-4f65-a90e-48f3af5aa3e5" }]
```

安卓排 `entity:<UUID>`，不声明另一条设备队列。解析先查 `group-owner entity:<UUID>` 确认本体存在，再从 `coda-resources links <UUID>` 返回的本机可达链路里选第一条 protocol 为 adb 的链路；保留 Coda 的链路优先顺序。缺失时排队前明确报错，并预先验证 adb 连接。排到后再连接 endpoint，命令的 `ANDROID_SERIAL` 使用该 endpoint。APK 安装、截图和 host-sim 命令都使用调用机器的 adb。
只支持已有保管方的安卓本体，普通 adb 设备须先由保管方登记。借还、settings 复原、停 frida、回桌面与熄屏由保管方负责；归还失败由核心把本体标成 failed 并停队，保管方重新声明时重试。安卓不出 testbed 的重试或放锁卡片。App 数据、安装的 App 和文件等改动在任务答复里说明。

## 使用

会话调用 `workflow_run`，workflow 为 `use-testbed`，传 device、instructions，可选 task 和 app（.app、.ipa 或 .apk 绝对路径）。也可从流程的 `callActivity` 调用。
解析成功后占组（capacity 1、borrow=no），个人 iOS 先询问维护者；按需安装，再交给发起会话。任务中用 `host-sim run --kind <设备名> -- <命令>`，只有正在做该设备任务的会话及子会话能借到（borrow=only），否则立即拒绝、不排队。借用命令随任务结束而停止。

无需会话任务、只需独占设备的流程先调用 `resolve-testbed`，传 device；返回 group、platform、entity（iOS 为空）、adb。再以返回的 group 调用 `hold-group`（capacity 1），不要自行拼组名。composer 的 develop/deliver 与 review 的 simple 只在填写设备名并进入设备验收时调用该能力，无新增插件硬依赖；此时须安装 testbed。

任务答复、拒绝、错误或取消后，常驻 iOS 在发起 Mac 上打开黑屏 App；个人 iOS 直接归还。共享设置 **切黑屏命令**（`testbed.blackscreen`）可按 iOS 设备名指定 sh 命令，设备 UDID 在 `$UDID`。iOS 切黑屏失败仍出人工重试或放锁卡片，处理前继续占组。
离开占用段才释放；成功返回任务的 result、note、choice，失败或取消照原原因结束。

资源读数列出本机登记的 iOS 与共享表里的安卓，通过同一解析函数读实际组的持有者与队列；无可达链路的安卓会使读数明确失败。安装 iOS 需要本机配对和 runner；安卓需要本机 adb 与已授权的公钥。

## 合并后迁移

各台升级 testbed；rig 的 devices.json 去掉 xiaomi，撤除旧的 device:xiaomi 声明；共享 testbed.entities 表填 xiaomi 和上述 UUID。旧登记不提供兼容队列。

## 黑屏 App

插件的 `blackscreen/BlackScreen.swift`：纯黑全屏、隐藏状态栏与主屏幕指示条的 App，iPhone、iPad 通用（OLED 黑色像素不发光；LCD 的 iPad 在它前台时把亮度压到最低，离开时还原）。
Bundle ID 是 `com.leavan.blackscreen`，切黑屏默认打开的就是它。只有常驻测试机需要安装，每台装一次；个人设备无需安装。签名用的开发描述文件到期或换设备时重装：

1. 在本仓库工作树的会话里，用持锁执行（`run-held`）运行 `sh plugins/testbed/blackscreen/build.sh <输出目录> <描述文件名>`，占一个构建名额；
   编译后用登录钥匙串里的 Apple Development 证书和这份开发描述文件签名（描述文件须是通配 App ID、包含目标设备，Team 取自描述文件），得到 `<输出目录>/BlackScreen.app`。它不碰设备。
2. 在与设备配对的 Mac 上调用 `use-testbed`，`app` 给这个 `.app`：装上后任务交给会话，答复后的切黑屏打开它，切得过去就是装好了。
