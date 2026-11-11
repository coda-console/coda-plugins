---
name: testbed
description: 测试机插件怎么用：会话或流程里用 use-testbed 排到 iPhone/iPad 或安卓测试机、按需装 App、拿到任务后用 host-sim run --kind <设备名> 操作并用 workflow_task 答复；流程里 callActivity 的写法与输出。要在真机上操作、验证或写真机验收流程时读。
---

# 测试机

iPhone、iPad 排 `device:<设备名>`；安卓设备名从空间共享设置 `testbed.entities`（行含 name、entity UUID）解析到 `entity:<UUID>`。不要自行拼组名或绕开 use-testbed 占用设备。
iOS 登记在保管实例的 devices.json，个人设备 personal=true 借出前先询问维护者，归还不切黑屏；常驻 iOS 归还切黑屏，失败出人工处理卡片。
安卓只引用保管方已登记的本体，排队前确认本体存在且本机有可达 adb 链路、连接已授权。排到后用链路 endpoint 连接；借出和归还由保管方负责，包括记录 settings、复原、停 frida、回桌面及熄屏。归还失败由核心标 failed、停队，等保管方重新声明重试；testbed 不出安卓放锁卡片。
安装与 host-sim 命令在调用机器运行：iOS 须配对、有 runner；安卓须装 adb。settings 以外的改动在答复里说明。

## 会话里

1. 调用 `workflow_run`，`workflow` 为 `use-testbed`，`inputs` 给 `device`（设备名）和 `instructions`（要做什么、怎么答复）；
   先装 App 就再给 `app`（`.app`、`.ipa` 或安卓的 `.apk` 的绝对路径），`task` 是任务名（默认「在测试机上验证」）。
2. 排到后你会收到任务：用 `host-sim run --kind <设备名> -- <命令>` 操作设备（如 `xcrun devicectl …`；安卓设备如 `adb shell …`，
   命令里 `ANDROID_SERIAL` 已是这台，frida、scrcpy 也照常用）。
   只有正在做这台设备任务的会话（含子会话）借得到，别的时候立刻拒绝、不排队。
3. 做完用 `workflow_task` 答复；答复后还在跑的借用命令随之停下。

## 流程里

先在自己的步骤构建、签名，把产物放进 `$CODA_ARTIFACTS`，再调用它：

```xml
<callActivity id="verify" name="真机验证" calledElement="use-testbed">
  <extensionElements>
    <coda:param name="device" value="iphone-testbed" />
    <coda:param name="app" value="=sign.app" />
    <coda:param name="instructions" value="打开 App，走一遍登录，截图确认没有报错。" />
  </extensionElements>
</callActivity>
```

任务的答复是这一步的输出：`=verify.result`、`.note`、`.choice`。被拒绝、出错或被取消时这一步抛出 `CALL_FAILED`，用出错边界事件接住做自己的收尾。

无需会话操作但要独占设备时，先 `callActivity calledElement="resolve-testbed"`，传 device，读返回的 group、platform、entity、adb，再用 `hold-group` 占返回的 group（capacity 1）。组名由 testbed 统一定义；使用设备验收时须安装 testbed。
