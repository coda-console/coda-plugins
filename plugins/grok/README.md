# Grok

Grok Agent：适配运行机上 Grok CLI 的 ACP 与审批模式；资源页的「Grok」显示账号与额度，可从 Coda 安装和登录。

不声明 `systemPrompt`；会话指令由 Coda 后端在新会话第一次非斜杠命令的用户输入前送入单独的文本块，恢复会话不再送，插件不用处理。

压缩上下文（自动，或用户的 `/compact`）：入口把 Grok 的 `_x.ai/session_notification` 里的 `auto_compact_started`、`auto_compact_completed`、`auto_compact_failed`、`auto_compact_cancelled`（只取主会话的）原样转发后，另按 ACP `compaction_update` 报给 Coda：开始 `in_progress`，完成 `completed`，同一次压缩用同一个 `compactionId`；`/compact` 不报开始，只报完成。失败、取消两条在 Grok 1.0.77 上只在二进制里见到名字，没有实测，按 `failed` 报。

入口声明 ACP 的 `session/delete`：Grok 原生没有，入口自己拦下，改跑官方命令 `grok sessions delete <id>`（15 秒超时）。命令对不存在的会话也退出 0，所以以它的输出为准：`Deleted session` 回 `{}`，`No session found` 回 -32002，其他回 -32603 并带原因。会话还开在 Grok 里时可以直接删，之后 `session/close` 和结束进程都不会把它写回来（1.0.77 实测）。这样 Coda 探测模型和模式留下的空会话能被清掉；`sessions delete` 核对于 1.0.77，更旧的 CLI 没有它时回错误，不抬高最低版本（审批模式通知只核对过 1.0.52）。

## 资源页：账号与额度

资源页的「Grok」显示这台机器上 Grok CLI 的登录与额度，可从 Coda 安装和登录。

- **CLI**：先找安装器放的 `~/.grok/bin/grok`，再找 `PATH` 上的 `grok`（会话用的是同一个）。
- **来源**：有 `$GROK_HOME/auth.json`（默认 `~/.grok`）才算登录了；没有就输出为空，「Grok」出现在「添加资源」里。
  临时启动一个 `grok agent --no-leader stdio`，经 ACP 依次问 `_x.ai/auth/check_subscription`（顺带续期）、`_x.ai/auth/info`、`_x.ai/billing`，问完即关，20 秒没答完算失败。
  CLI 说没人登录（登录失效或被撤销而文件还在）时输出为空。这些扩展方法是 Grok CLI 的内部接口，升级 CLI 时复核。凭据由 Grok CLI 写入并续期，Coda 不读。
- **显示**：一个资源，名字是用户在 xAI 填的名字（没有就叫「Grok」，不显示邮箱与套餐）。额度与 CLI 的 `/usage` 同源：
  按当前周期画「7 天」或「月度」的剩余，剩余 = 100 减 `creditUsagePercent`（字段缺省即已用 0%：protobuf JSON 省略零值；旧格式按 `used / monthlyLimit` 算），
  重置时间取当前周期结束；设了按需上限时另一条「按需用量」（旧格式没给按需已用时取超出额度的部分）。预付余额是金额，不折算，不显示。
  CLI 起不来或不答复时整个类型读取失败，保留上次结果。`maxAge` 5 分钟。
- **身份**：`grok:<邮箱的哈希>`，邮箱本身不显示也不送出。
- **登录**：`grok login --device-auth`（设备码，可以用 X 账号确认），`BROWSER=/usr/bin/true`，运行机上不开浏览器。
- **安装**：官方安装脚本 `curl -fsSL https://x.ai/cli/install.sh | bash`，下载约 150 MB 装进 `~/.grok/bin`。运行时 `SHELL` 置空、`~/.grok/bin` 放在 `PATH` 最前，
  脚本因此不改 shell 配置、不往 `~/.local/bin` 建链接；除 `~/.grok` 外只写一个 fish 补全文件。

## 提问

Grok 的 `ask_user_question` 不走 ACP 表单，而是向客户端发私有请求 `_x.ai/ask_user_question`；会话入口把它转成问答卡片（`elicitation/create`），
答复按 Grok 的格式交回。Grok 超时（默认 30 分钟）或轮次取消时不撤回请求，只把那个工具调用标成结束，入口见到这一条就收回卡片。
