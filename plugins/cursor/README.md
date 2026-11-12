# Cursor

把 [Cursor](https://cursor.com) 的 Agent 接进 Coda。清单直接启动运行机上的 `cursor-agent acp`，先找 `~/.local/bin/cursor-agent`，没有再用 PATH。
每个会话一个进程，不登记等待项。

需要带会话指令兜底的 Coda（2026-11-13 部署版，coda#2500）或更新版本；旧版 Coda 不会给 Cursor 送入会话指令。

> 状态：清单已过契约检查（清单级）与 Coda 的「读取来源」；**还没有和真实的 Cursor 账号跑过**握手与一轮，等有付费账号后按文末的验收步骤补。

## 安装

1. **运行机装 Cursor CLI**：插件的设置动作（`scripts/setup.mjs`）在你安装或更新插件时于每台机器上运行，没有能运行的 Cursor CLI 就用官方安装程序装上；
   已有的不动（没有已知的版本下限，它自己会更新）。也可以自己装：

   ```sh
   curl https://cursor.com/install -fsS | bash
   ```

   只支持 macOS 与 Linux 的 x64、arm64。装到 `~/.local/share/cursor-agent/versions/<版本>`，并在 `~/.local/bin` 建 `agent` 与 `cursor-agent` 两个链接；默认自动更新。
   启动命令先找 `~/.local/bin/cursor-agent`，找不到再用 `PATH` 上的 `cursor-agent`：Coda 后端服务的 `PATH` 不一定有 `~/.local/bin`；
   不用 `agent` 这个名字，它太通用，安装脚本也会无条件覆盖它。

2. **登录**（在运行机的终端里，用运行 Coda 后端的那个账户）：

   ```sh
   ~/.local/bin/cursor-agent login      # 打开浏览器；NO_OPEN_BROWSER=1 时只打印链接，链接可以在别的设备上打开
   ~/.local/bin/cursor-agent status     # 确认已登录
   ```

   也可以给后端的环境设 `CURSOR_API_KEY`（Cursor 控制台 › API Keys）。需要 Cursor 账号；Cursor 的 JetBrains 文档把付费套餐写成 ACP 的前提，
   免费账号能不能用 `cursor-agent acp`，官方没有明说。

3. **在 Coda 里装插件**：「设置 › 插件 › 从仓库添加…」，仓库填 `coda-console/coda-plugins`，读取后选「Cursor」。
   确认里能看到会运行的命令原文：

   ```sh
   if [ -x "$HOME/.local/bin/cursor-agent" ]; then exec "$HOME/.local/bin/cursor-agent" acp; else exec cursor-agent acp; fi
   exec "$CODA_NODE" "$CODA_PLUGIN_PATH/scripts/setup.mjs"
   ```

   装好后新任务的 Agent 选择里出现 Cursor。插件在空间里共享，设置动作在每台机器上各装一次 Cursor CLI；装不上的那台，
   会话启动失败并提示清单的 `setupHint`。

## 在 Coda 里是什么样

| 设置 | 来源 |
| --- | --- |
| 模型 | Cursor 给的列表（每个模型一个默认变体，如 `composer-2.5[fast=false]`），经配置项 `model` |
| 工作模式 | `agent`、`plan`、`ask`（「工作模式」，没选时用 Cursor 自己的默认）；这是工作方式，不是审批档 |
| 审批 | Cursor 发 `session/request_permission`，选项是它给的 `allow-once`、`allow-always`、`reject-once`，Mac 与 iPhone 出审批卡片 |
| 恢复 | Cursor 声明 `loadSession`，后端或托管重启后用 `session/load` 接着聊 |
| skills | Cursor 原生读工作副本的 `.agents/skills`（清单的 `skillsDir`） |
| 模型列表何时重读 | `~/.cursor/cli-config.json`、`acp-config.json` 变了时（`CURSOR_CONFIG_DIR` 可改目录） |

## 已知限制

Cursor 不可用或打折的 Coda 功能：

| 功能 | 情况 |
| --- | --- |
| 等待项登记 `_coda/wait` | 不登记。Cursor 的后台 shell 与子 Agent 都在同一个 prompt 里等，Coda 看到的是一轮还没结束，静止判断不会错；但没有后台任务卡片与委派清单，会话底部不列它在等什么 |
| 推理强度 | 没有：Cursor 只在客户端声明它私有的 `_meta.parameterizedModelPicker` 时才给思考档位，Coda 不为某个 Agent 加私有字段 |
| 委派子会话、流程步骤的「自动审批」 | 清单没有 `modes.auto`：Cursor 的子会话与流程步骤遇到审批会停下等人。要无人值守，在运行机的 Cursor 配置里放行（`approvalMode`、权限 allow 表） |
| 附件目录免审批 | Cursor 不支持 `additionalDirectories`，读工作副本外的附件要审批 |
| 用量、上下文占用 | Cursor 不报 |
| 未登录 | 第一次没登录时 Coda 照 ACP 的 -32000 提示「Cursor 未登录」，但资源页没有 Cursor 面板可以「添加」：按上面在运行机终端登录。登录过期后 Cursor 不报错，只回一句「Please sign in」，Coda 认不出 |
| 问答卡片 | Cursor 不用 ACP 的 elicitation，Coda 收不到它的提问；`cursor/create_plan` 等 Cursor 私有请求，Coda 回 -32601，Cursor 会降级 |
| 给 Agent 的说明 | Cursor 的 ACP 不接受 `systemPrompt`：Coda 后端把会话指令作为单独一段放在新会话第一次非斜杠命令的用户输入前面，插件不用处理，分量不如系统提示词 |
| 选模型的副作用 | 每个会话一个进程，互不影响；但 Cursor 会把选择写回 `~/.cursor/cli-config.json`，改了运行机上终端 Cursor 的默认模型 |
| 启动 | 进程启动约 12 秒、新建会话约 2.5 秒（社区测量） |
| 断线 | Cursor 在 ACP 下遇到传输错误不重试，长轮次中途断线就结束 |

登录面板（`signIn`）没做：Cursor 打印的链接不带 `user_code`，也不要粘贴授权码，对不上 Coda 面板登录的两种约定；要接得改 Coda，不在只写清单的范围里。

## 验收（有账号后补）

```sh
node bin/check.mjs plugins/cursor            # 握手：protocolVersion 1，session/new 给出会话与当前模型
node bin/check.mjs plugins/cursor --live     # 一轮：回复、取消、session/load
```

然后在 Coda 里：发一句话收到回复；选「工作模式」plan 出计划，确认不卡住；跑一个要审批的命令，Mac 与 iPhone 都出卡片；重启后端后接着聊（`session/load`）。
