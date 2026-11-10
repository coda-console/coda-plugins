# Grok Bot

0.5.0 把每个 Bot 的原生主会话提供为 `coda/session@1` 记录，不再声明 ACP Agent。只供预览版安装。协议依照 5.7.0。

## 登录与记录

在资源页添加 Grok Bot，打开 `cursor.com/loginDeepControl` 官方链接确认（手机可能需要再点 Continue）。沿用 0.4.0 的 PKCE 链接、`/auth/poll` 轮询及 `/oauth/token` refresh_token 续期；不是 Grok CLI 的设备码登录，不读取桌面凭据。凭据写在插件数据目录的 `native-auth.json`，权限 0600。续期失败时资源页提示重新登录。

Provider 每 30 秒重新读取登录及 Bot 名单；每个 Bot 自动建立一条记录，无选择下拉或会话命令。容器是登录账号，账号本人为 `self: true, kind: person`，Bot 为 `kind: agent`。

账号 ID 是 `GetMe.userId`（没有时用 `authId`）的 SHA-256；记录 ID 为 `grok-bot:<账号摘要>:<URI 编码的 agentId>`。不含本机 ID、插件目录或随机数，重装不变。服务端删除 Bot 或切换账号后撤下旧记录。

## 读取与发送

- `read` 从内存中的原生主会话 transcript 镜像分页读取，支持最新页、`after` 和 `before`；游标是 `<generation>:<updatedSeq>`，BigInt 比较，不丢 uint64 精度。历史重置后旧游标报错，需重新读取。
- 启动、重连及 `cleared` / `cursorTooOld` 时全量读取一次历史，重建每个 Bot 的条目镜像；之后只按 Watch 的 `rows` 增量更新。`read`、head 和发送回显确认不再拉历史。generation 不变时保留本进程已交付的消息版本；generation 改变则清空旧消息。
- 变化的会话条目各自等待 1 秒无新正文变化才交付，不扫描或重拉完整历史；发布 head 不越过仍未稳定的较早条目。只持久化已暴露正文的摘要、序号及修订标记，不持久化正文镜像。
- 一个条目首次稳定暴露时就是普通消息，ID 为 `<generation>:<entryId>`，cursor 取首次暴露时的 updatedSeq，即使它与原生 seq 不同。只有索引记录的已暴露正文再变化，才追加 `<base>:edit:<updatedSeq>`、带 `about: { message: <base>, change: "edit" }` 的修订。原生历史只保留当前版本，进程重启后不伪造已被覆盖的旧正文。
- `post` 使用 Coda 已创建的 `coda/run@1`，handler 收下立即返回，后台发送并等待流事件更新镜像、确认回显后写终态。messageId 是按调用方、记录 ID、requestId 派生的 UUID；同请求只交给 handler 一次由 Coda 保证，插件不再保存 `posts.json` 或重复去重。完成返回 `{ message: { id, cursor } }`；断线、接受后无回显等不确定结果为 `failed` / `unknown`。重启遗留运行也标为 `unknown`，不重发。
- 只收文字。草稿为无操作；未提供停止或取消。
- widget 是列出选项的消息。回复该消息、正文填选项标签或值时调用 `RespondGrokBotWidget`；原生条目的 `respondedValue` 作为一条 self 回复读出，指向原 widget 并 mentions Bot。确认这条回复后完成 post。
- Routine 记录、活动、结算、思考均不造消息；Routine 的结论若由 Bot 发在主会话则正常读取。

## 正在做的事

同一 Watch 流的主 Bot `agentState.live` 保存在内存镜像，不增加原生请求。沿用 0.4.0 的 `live.activity.kind`：`tool` 优先显示 `detail`，其次 `tool`；`thinking` 显示 `detail`，未提供正文时显示「Grok 正在思考」。取首个可读行，按 Unicode 字符截到 200 字，`participant` 为 Bot 的参与者 ID。

沿用 0.4.0 的忙碌判定：`isRunning`、`isComposingMessage`、`isRetrying`、`activity` 或 `awaiting` 任一存在时，不让附带的旧 `lastTurnSettlement` 清除当前活动。无这些忙碌信号且有 `lastTurnSettlement` 时删除整个 activity；独立子 Agent 运行不阻止清除。不以消息静默或超时判定停止。重连和游标重置时连同 transcript 重建 live 状态，等待 Watch 的新快照。activity 只写 status，不造消息、不进 read、不推进 head。

## 正文变化的依据与验证边界

**未经真实历史核实。** 本次不读取真实凭据、不连接真实 xAI。依据是 0.4.0：

1. `agent/watch.mjs` 的 `rows()` 按 `entryId` 保存 `updatedSeq` 和正文 SHA-256；同 ID 的更高序号且正文摘要变化会再次交给适配器。
2. `agent/session.mjs` 的 `nativeEvent()` 对 `send-message` 保存旧文本；新文本以前文开头时追加后缀，否则输出「Grok 修订消息」。旧测试 `updatedSeq changes and process reload do not redisplay an already delivered body` 覆盖正文未变时去重；`transcript batches commit once, bound seen/hashes, and an evicted entry revision appears as new` 覆盖旧条目改写。

这些代码证明旧实现允许正文再次变化，不能证明线上总以完整消息到达，也不能证明每次变化都是人工修订。当前 1 秒稳定窗口只是对订阅条目的静默等待，不是上游完结信号；停顿后再次修改仍会以新修订交付。真实历史及稳定窗口是否合适留到预览空间真实环境验证。

测试使用假原生服务端，覆盖登录后记录、增量/向前翻页、修订、稳定 head、启动前已完成的流式消息、断线/游标重置重建、无额外历史读取、post 的请求派生 ID、流回显与未知结果、widget 回复以及 Routine 不镜像；记录及 read 输出按仓库协议契约校验。

## 后续范围

远端入口、绑定码和新工单工具等待 Coda 后端；`remote/coda-bot.mjs`、`remote/SKILL.md` 原样保留，本版不提供 `/bind` 或旧 ACP 转发。未改线上 Routine，未部署。停止第一版不做。
