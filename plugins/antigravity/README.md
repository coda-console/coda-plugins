# Antigravity

把 [Google Antigravity](https://antigravity.google/cli) 的 Agent 接进 Coda。清单直接启动运行机上的 `agy acp`（Antigravity CLI 的 ACP 服务），
先找 `~/.local/bin/agy`，没有再用 PATH。每个会话一个进程，不登记等待项。

需要带会话指令兜底的 Coda（2026-11-13 部署版，coda#2500）或更新版本；旧版 Coda 不会给 Antigravity 送入会话指令。

要求 Antigravity CLI **1.5.9 及以上**：`agy acp` 从 1.5.0 才有，Auto 模式与模式保持的修复在 1.5.4，上下文用量在 1.5.8；
插件的核对（握手、`--live`）都跑在 1.5.9 上。

## 安装

1. **运行机装 Antigravity CLI**：插件的设置动作（`scripts/setup.mjs`）在你安装或更新插件时于每台机器上运行：没有 `agy` 就用官方安装程序装上，
   低于 1.5.9 就用 `agy update` 升级，新的不动；已有的 `agy` 跑不起来时只说明原因并失败，不替你删它。资源页「Antigravity」的「安装」也运行同一个设置动作。
   也可以自己装：

   ```sh
   curl -fsSL https://antigravity.google/cli/install.sh | bash
   ```

   装到 `~/.local/bin/agy`（`--dir` 可改位置）。官方安装程序在 `~/.local/bin/agy` 已存在时什么都不做，所以升级用 `agy update`；二进制自己也会在后台更新。
   自己用上面那行装，安装程序最后运行的 `agy install` 会把 `~/.local/bin` 写进已有的 shell 配置（`.bashrc`、`.zshrc`）的 PATH。
   设置动作不改你的 shell 配置：它在一个临时目录当 `HOME` 的环境里运行安装程序，并用 `--dir` 把二进制装进真正的 `~/.local/bin`，
   安装程序的暂存文件与 shell 配置改动都落在临时目录，装完即删；要让 `agy` 进终端的 PATH，自己加。
   启动命令先找 `~/.local/bin/agy`，找不到再用 `PATH` 上的 `agy`：Coda 后端服务的 `PATH` 不一定有 `~/.local/bin`。

2. **登录**，三选一：
   - **资源页**：「资源 › 添加资源」里选「Antigravity」，Coda 显示授权链接，在浏览器里用 Google 账号确认，把授权页给的授权码贴回 Coda。
   - **运行机的终端**（用运行 Coda 后端的那个账户）：

     ```sh
     agy acp --login      # 打印授权链接，贴回授权码（或落地页的完整网址），回车；成功打印「Logged in as <邮箱>.」
     ```

   - API key、Vertex 等其他认证方式：见 [Antigravity CLI 官方文档](https://antigravity.google/docs)，插件不处理。

   登录保存在这台机器的系统钥匙串里（macOS 钥匙串，条目服务 `gemini`、账号 `antigravity`；Linux 用 Secret Service），由 Antigravity CLI 自己续期。
   未登录时 `session/new` 回 -32000「Authentication required」，Coda 提示「Antigravity 未登录」。

3. **在 Coda 里装插件**：「设置 › 插件 › 从仓库添加…」，仓库填 `coda-console/coda-plugins`，读取后选「Antigravity」。
   确认里能看到会运行的命令原文：

   ```sh
   if [ -x "$HOME/.local/bin/agy" ]; then exec "$HOME/.local/bin/agy" acp; else exec agy acp; fi
   exec "$CODA_NODE" "$CODA_PLUGIN_PATH/scripts/setup.mjs"
   ```

   装好后新任务的 Agent 选择里出现 Antigravity。插件在空间里共享，设置动作在每台机器上各装一次；装不上的那台，会话启动失败并提示清单的 `setupHint`。

## 在 Coda 里是什么样

| 设置 | 来源 |
| --- | --- |
| 模型、思考档位 | Antigravity 给的配置项 `model`、`thought_level`：Gemini 4 系列，账号里有的 Claude、GPT-OSS 也在其中。在 Coda 里切换不写回 `~/.gemini/antigravity-cli/settings.json` |
| 工作模式 | `default`、`accept-edits`、`auto`、`plan`（「工作模式」，没选时用 Antigravity 自己的默认）；清单的 `modes.auto` 指向 `auto`，供委派子会话与流程步骤的「自动审批」使用 |
| 审批 | `default` 与 `accept-edits` 下跑命令发 `session/request_permission`，选项是 `allow`（allow_once）与 `deny`（reject_once），Mac 与 iPhone 出审批卡片；`auto` 对安全命令不再询问 |
| 恢复 | Antigravity 声明 `loadSession`，后端或托管重启后用 `session/load` 接着聊 |
| skills | 读工作副本的 `.agents/skills`（清单的 `skillsDir`） |
| 上下文占用、标题 | Antigravity 报 `usage_update` 与会话标题更新 |
| 模型列表何时重读 | `~/.gemini/antigravity-cli/settings.json` 变了时 |
| 资源页 | 登录后显示一条「Antigravity」，读数是 CLI 版本；登录状态只查钥匙串条目在不在（macOS 用 `security find-generic-password -s gemini -a antigravity`，只查条目，不读内容），不开会话，也不读邮箱；钥匙串问不出来时读数失败，不当作登出（Linux 的细节见下） |

## 已知限制

| 功能 | 情况 |
| --- | --- |
| Auto 的审批 | Auto 对不可逆操作仍会请求审批：无人值守的子会话遇到会停下等人。官方文档说明 Auto 需要终端沙箱，企业账号与沙箱不可用的机器可能没有 Auto |
| 全部放行 | 没有：Antigravity 没有原生的「全部放行」模式（`full`、`yolo` 回 -32602），清单不写 `modes.full` |
| 会话指令 | Antigravity 只认私有的 `_meta.antigravity.systemPrompt`，不认 ACP 标准字段；插件不处理它，由 Coda 把指令作为单独一段放在新会话第一次非斜杠命令的用户输入前面，分量不如系统提示词 |
| 插话 | 不声明：Antigravity 的原生插话会提前结束旧一轮的回复，由 Coda 停下这一轮再发出新消息 |
| 剩余额度 | 没有：Antigravity 没有剩余额度的接口，`session/new` 的 `_meta.antigravity.tier` 只有套餐名，资源页只显示版本 |
| 等待项登记 `_coda/wait` | 不登记，会话底部不列它在等什么 |
| Plan 模式 | 产出计划文件并要求审阅，审阅前不动手 |
| 额度耗尽 | 没有真实样本，不做失败分类，Coda 只看到 Antigravity 给的错误文字 |
| 没有桌面会话的 Linux 登录 | 未实测：Linux 用 Secret Service（D-Bus），二进制里有「keyring 失败就落文件」的回退，但文件路径与触发条件没查清。资源页在 Linux 上用 `secret-tool lookup service gemini username antigravity` 查条目（属性名按 go-keyring 的写法，未在真机上试过），没有 `secret-tool`、查不到条目，或登录落在文件里时，资源页当作未登录（只是仍在「添加资源」里出现，会话不受影响）。装了 `secret-tool` 却联系不上 Secret Service（典型是没有会话 D-Bus 的无桌面机器，它带错误信息退出）时，资源页读数失败、保留上次的显示，首次读取就没有可保留的，也就无法从资源页添加：这样的机器在终端里运行 `agy acp --login` 登录 |
| 第三方模型 | 账号里的 Claude、GPT-OSS 未实测 |
| 并发进程 | 不加 `--process-per-session`：Coda 交给 Agent 的 MCP 服务器都是 stdio，官方只对 HTTP MCP 要求这个参数 |

## 验收

```sh
node bin/check.mjs plugins/antigravity            # 握手：protocolVersion 1，session/new 给出会话与当前模型；资源读数合格式
node bin/check.mjs plugins/antigravity --live     # 一轮：会话指令、回复、取消、session/load
```

然后在 Coda 里：发一句话收到回复；选 plan 出计划文件并停在审阅；选 default 跑一个要审批的命令，Mac 与 iPhone 都出卡片；选 auto 跑安全命令不再询问；
重启后端后接着聊（`session/load`）；资源页登录一遍（贴授权码）。
