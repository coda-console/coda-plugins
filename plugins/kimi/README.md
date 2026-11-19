# Kimi Code

Kimi Code Agent：Coda 的入口在运行机的 kimi acp 与 Coda 之间转发，读 Kimi 的会话文件报出后台命令与子 Agent；资源页的「Kimi」显示账号与额度，可从 Coda 安装和登录。

不声明 `systemPrompt`；会话指令由 Coda 后端在新会话第一次非斜杠命令的用户输入前送入单独的文本块，恢复会话不再送，插件不用处理。

压缩上下文（自动，或用户的 `/compact`）：Kimi 的 ACP 只用一段文字说，所以读主 Agent 的 wire（`agents/main/wire.jsonl`）里的 `full_compaction.begin`、`full_compaction.complete`、`full_compaction.cancel`，按 ACP `compaction_update` 报给 Coda：开始 `in_progress`，完成 `completed`，取消 `failed`，同一次压缩用同一个 `compactionId`。和其余会话文件观察一样，只认核对过的 Kimi 版本；本进程启动前就开始的压缩只报结束。子 Agent 的压缩不报。

## 资源页：账号与额度

资源页的「Kimi」显示这台机器上 Kimi CLI 的登录与额度，可从 Coda 安装和登录。

- **CLI**：先找安装器放的 `~/.kimi-code/bin/kimi`，再找 `PATH` 上的 `kimi`（入口跑会话用的是同一个）。
- **来源**：有 `$KIMI_CODE_HOME/credentials/kimi-code.json`（默认 `~/.kimi-code`）才算登录了；没有就输出为空，「Kimi」出现在「添加资源」里。
  账号与额度都问 CLI 自己的本地服务：临时启动 `kimi web --no-open --host 127.0.0.1 --port 0`（临时工作目录，只听回环地址，不开浏览器），
  从启动输出取本次的地址和令牌，账号问 `GET /api/v1/oauth/userinfo`（只取昵称 `nickname` 与会员等级 `userLevelName`，不取手机号、邮箱），
  额度问 `GET /api/v1/oauth/usage`（与终端 `/status` 同用 Kimi 的 `getManagedUsage`），同一次启动问完即关；20 秒没问完算失败，退出宽限 4 秒。
  令牌续期是 CLI 自己的事，Coda 不读 OAuth 令牌，也不发起模型对话。依赖 Kimi Code CLI 2.1.1 的本地接口（实验接口），升级时复核。
- **账号**：按登录文件的修改时间问一次（CLI 登录、续期都会重写它），记在插件状态目录的 `account.json`。问不到时（CLI 向上游取资料 8 秒超时）
  沿用上次看到的，从没看到过就叫「Kimi」，下次再问；Kimi 拒绝这个登录（401）时输出为空。
- **显示**：一个资源，名字是昵称（会员等级不显示）；5 小时、7 天、月度窗口按套餐有的各一个读数，再加「Extra Usage 余额」。读不到额度时那一行写原因。
  CLI 起不来或不答复时整个类型读取失败，保留上次结果。找不到 CLI 时那一行写明，用「重新登录」安装。`maxAge` 5 分钟。
- **身份**：`kimi:<用户 ID>`。登录文件变了而这次没问到是谁时，沿用上次的昵称与等级，但不带身份。
- **登录**：`scripts/login.sh` 运行 `kimi login`（设备码）。它不看 `BROWSER`，在 macOS 上直接调 `open`、Linux 上调 `xdg-open`：
  脚本把只含空操作 `open`、`xdg-open` 的目录（插件状态目录里的 `no-browser/`）放在 `PATH` 最前，运行机上不弹出没人看的浏览器页面。
- **安装**：`scripts/install.sh` 运行官方安装脚本 `curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash`，装进 `~/.kimi-code/bin`（CLI 约 180 MB）。
  运行时设 `KIMI_NO_MODIFY_PATH=1`、`PATH` 里去掉 `~/.kimi-code/bin`，脚本因此不改 shell 配置，也不改名 `PATH` 上旧版 Python 的 `kimi`。
