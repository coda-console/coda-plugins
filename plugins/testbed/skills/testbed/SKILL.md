---
name: testbed
description: 测试机插件怎么用：会话或流程里用 use-testbed 排到 iPhone/iPad 测试机、按需装 App、拿到任务后用 host-sim run --kind <设备名> 操作并用 workflow_task 答复；流程里 callActivity 的写法与输出。要在真机上操作、验证或写真机验收流程时读。
---

# 测试机

测试机（`iphone-testbed`、`ipad-testbed` 这类设备）需要会话操作时经能力 `use-testbed` 使用：它排进设备的并发组 `device:<设备名>`，
按需装 App，把任务交给发起的会话；答复、出错、拒绝或运行被取消后，先等会话借设备还在跑的命令停下，常驻测试机再切黑屏、交出设备；个人设备直接交出，不切黑屏，也不出切黑屏失败卡片。

设备登记每项可加 `"personal": true` 标记维护者的个人设备；缺省为常驻测试机。该字段随 `name`、`udid`、`note` 发布到空间，其他 Mac 经 `coda-resources group-owner` 也能读到。只有常驻测试机需要安装黑屏 App。
常驻测试机给 Agent 自助使用；个人设备在维护者手里，排到后先出卡片问维护者借不借。选「现在不行」时这次调用以拒绝结束（理由在备注里），别反复重试，改用常驻测试机或按备注约的时间再借。

登记在哪个实例就归哪个实例，`devices.json` 是归属的唯一事实来源。空间里同一设备只能登记一次，同名或相同 UDID 的重复登记会使占用失败并报冲突。任何实例的会话都能用，在归属实例排队。
安装、会话的 host-sim 命令和切黑屏在发起的 Mac 上跑；这台 Mac 须与设备配对，跑 XCTest 还须有本机 runner。

## 会话里

1. 调用 `workflow_run`，`workflow` 为 `use-testbed`，`inputs` 给 `device`（设备名）和 `instructions`（要做什么、怎么答复）；
   先装 App 就再给 `app`（`.app` 或 `.ipa` 的绝对路径），`task` 是任务名（默认「在测试机上验证」）。
2. 排到后你会收到任务：用 `host-sim run --kind <设备名> -- <命令>` 操作设备（如 `xcrun devicectl …`）。
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

无需会话操作但需要独占设备的流程（如预览版直装、开发流程的设备验收），可自行用 `hold-group device:<id>`（capacity 1）占一段，由引擎到归属实例排队，测试机会话排在它后面；流程负责自己的操作与收尾。
