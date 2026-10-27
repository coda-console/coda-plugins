---
name: testbed
description: 测试机插件怎么用：会话或流程里用 use-testbed 排到 iPhone/iPad 测试机、按需装 App、拿到任务后用 host-sim run --kind <设备名> 操作并用 workflow_task 答复；流程里 callActivity 的写法与输出。要在真机上操作、验证或写真机验收流程时读。
---

# 测试机

测试机（`iphone-testbed`、`ipad-testbed` 这类在它所在 Mac 上登记的设备）只经能力 `use-testbed` 使用：它排进设备的并发组 `device:<设备名>`，
按需装 App，把任务交给发起的会话；答复、出错或运行被取消后，先等会话借设备还在跑的命令停下，再切黑屏、交出设备。项目流程不自己占设备的组。

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
