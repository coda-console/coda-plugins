---
name: host-slots
description: 宿主资源插件的名额怎么用：会话里用 run-held 执行 Xcode 构建、用模拟器的命令和调用 host-sim 的项目脚本；流程步骤写 coda:group="host"；项目脚本怎样经 host-sim 自己排队。写占名额的流程步骤、项目脚本，或 host-sim 报错时读。
---

# 宿主资源的名额

这台机器的 Coda 后端实例有一组名额（并发组 `host`，容量是插件设置「名额数」），Xcode 构建、Apple 模拟器和项目要求排队的命令共用。

## 会话里

- Xcode 构建、用 Apple 模拟器的命令、会调用 `host-sim` 的项目脚本，不直接跑：用 `workflow_run` 调用能力 `run-held`，
  `inputs` 给 `command`（整条命令，由 `$SHELL -c` 执行）与 `cwd`（绝对路径，一般是你的工作目录），用模拟器另给 `what` 为 `模拟器`。
- 排队与执行由 Coda 管：结束得快就随这次调用返回结果，否则结果之后送回会话；调用先返回了，命令照常执行，要停用 `workflow_cancel`。
  命令失败这次调用也失败，结果带着输出的末尾，`exit_code` 是命令的退出码。
- 原生子 Agent 不能调用 `run-held`：把这一步交回主 Agent，或由主 Agent 用 `spawn` 派一个 Coda 子会话。
- 别的命令（其他项目的构建、测试、静态检查）直接执行，除非项目说明（如 `AGENTS.md`）要求排队。

## 流程步骤里

- 要占名额的步骤（Xcode 构建、模拟器、调用 `host-sim` 的脚本，以及项目要和它们一起排队的重活）写 `coda:group="host"`，只在需要的那一步写：

  ```xml
  <scriptTask id="build" name="构建" scriptFormat="bash" coda:group="host" coda:timeout="60">
    <script>bash scripts/build-ios.sh</script>
  </scriptTask>
  ```

- 步骤里再调 `host-sim` 会沿用这份名额；没占着组 `host` 的步骤调用 `host-sim` 会被拒绝。

## 项目脚本经 host-sim 排队

- `host-sim run --kind build|simulator -- <命令> [参数…]`：已在名额里（持锁执行的命令带 `HOST_SIM_LEASE`，占着组 `host` 的步骤带 `CODA_GROUPS`）就直接执行，
  执行的命令带上 `HOST_SIM_LEASE`；在会话里不在名额中调用时拒绝（退出码 2），提示改用 `run-held`。
- 常见写法：脚本开头用 `host-sim check` 看是否已在名额里，不在就经 `host-sim run` 重新执行自己，这样在会话里整条交给 `run-held`、在步骤里写 `coda:group="host"` 都能跑：

  ```sh
  host-sim check --kind build 2>/dev/null || exec host-sim run --kind build -- bash "$0" "$@"
  ```

  不要只看 `HOST_SIM_LEASE` 是否为空：测试机上执行的命令也带它（`coda-run:<设备名>`），那占的是测试机，不是构建名额。

- `host-sim check --kind build|simulator`：在名额里退出码 0。
- `host-sim bind <udid>`：登记命令建的模拟器；持锁执行在命令结束时删掉它，被强杀留下的由定时「清点模拟器」删除。
- `--kind <设备名>`（如 `iphone-testbed`）交给测试机插件，见那个插件的 Skill `testbed`。
