# Grok Bot

0.9.3：去掉空的 `draft` 处理函数：Coda 已不再调用这个操作（草稿改走流，本插件不实现）。

0.9.2：记录命令读取到期时，已经发出的续期不随读取放弃：等它把新凭据（含轮换后的 refresh token）写完再退出，续期最晚在命令开始后 28 秒结束（宿主给 30 秒）。续期只有被明确拒绝（HTTP 400 / 401 / 403 或 `shouldLogout`）才算登录失效、记录写一行「请重新登录」；服务端出错（如 503，带它自己的状态码）或响应读不懂时命令以非零退出，Coda 保留上一份记录，本机凭据不变。

0.9.1：读 401 响应体时调用已取消（如移除 Bot），不再当作 401 去续期；共用的续期失败时，即使所有等待方都已放弃也有处理，不再让插件进程退出。记录命令等标准输出写完再退出，宿主一时读不完也不会拿到半截 JSON。

0.9.0：资源页的类型改成 `coda/resource@1`：记录命令 `scripts/resource.mjs`（登录文件读不了或被拒时写一行说明原因，登录入口照常在；别的读不到命令以非零退出，原因写在标准错误的最后一行，Coda 保留上一份记录），登录是操作 `sign-in`（`scripts/sign-in.mjs`，原 `login.mjs`），用 `coda progress` 报官方链接，报成功后才开始轮询、写凭据，报失败登录就失败、本机凭据不变。记录命令一次读取（账号、Bot 名单、等续期和续期后的重试）共用 20 秒的时间（宿主给 30 秒），超时命令以非零退出，标准错误的最后一行是「读取超时」。续期是各个调用共用的一次：某个调用取消（或这次读取超时）只放弃它自己的等待，不中止续期，别的 Bot 照常拿到新令牌。需要 API Level 6 的 Coda。

0.8.0（接口破坏性变更）：记录的读写换成 Coda 的新接口（`coda.replace`、`coda.put`），不再用 `protocols.observe`、`put`、`update`、`setStatus`、`delete`、`publish`，也不再有 `revision` 条件写和插件自己的串行队列（宿主按插件依次写）。插件不再读回自己的记录：本机的 `coda/session@1` 里混着 Coda 自己和别的插件的会话，条目上也没有提供者，所以持有哪些由插件自己知道（登录账号与 Bot 名单），只对这些写和删。需要先带这套接口的 Coda（coda#2749）。只给预览渠道。

0.7.0 `read`、`draft`、`post` 改用 `coda.handle` 登记，对应 Coda 宿主代管「做事的操作」（coda#2749）：`post` 发完才返回，不再写 `coda/run@1`，清单不再声明它，启动时也不再改写遗留运行。需要 Coda 先合并该改动；本版不再兼容旧写法。

0.6.0 删掉远端入口、绑定和工单回传（`remote/`、绑定页与资源页「绑定」按钮、`remoteCode` 调用）；会话收发照旧。Coda 已删除对应的外部会话绑定与 `coda:reportTo`，旧绑定不再可用。

0.5.0 把每个 Bot 的原生主会话提供为 `coda/session@1` 记录，不再声明 ACP Agent。只供预览版安装。协议依照 5.7.0。

## 登录与记录

在资源页添加 Grok Bot，打开 `cursor.com/loginDeepControl` 官方链接确认（手机可能需要再点 Continue）。沿用 0.4.0 的 PKCE 链接、`/auth/poll` 轮询及 `/oauth/token` refresh_token 续期；不是 Grok CLI 的设备码登录，不读取桌面凭据。凭据写在插件数据目录的 `native-auth.json`，权限 0600。续期被拒时资源页提示重新登录；续期时服务端出错或响应读不懂不算登录失效。

Provider 每 30 秒重新读取登录及 Bot 名单；每个 Bot 自动建立一条记录，无选择下拉或会话命令。容器是登录账号，账号本人为 `self: true, kind: person`，Bot 为 `kind: agent`。

账号 ID 是 `GetMe.userId`（没有时用 `authId`）的 SHA-256；插件给记录的 key 是 `<账号摘要>:<agentId>`，记录 ID 由宿主按后端、插件、种类和 key 派生，插件不生成。不含本机 ID、插件目录或随机数，重装不变。处理函数从 `ctx.record.key` 认出账号和 Bot；资源列表的 identity 也是这个 key。`transcript-index.json` 以 key 为键（`head:<key>`、`<key>:<generation>:<entryId>`）；旧版以记录 ID 为键的索引作废，不迁移，已暴露的条目重新按首次暴露处理。启动后第一次成功读到 Bot 名单时，用 `coda.replace` 把全集一次给出，宿主删掉本插件上次留下、现在已经没有的记录（旧版留下、不带 key 的也删），不碰别的插件和 Coda 自己的会话；之后名单有变（新增、删除、换账号）再整份给一次，状态变化逐条 `coda.put`；某次 `put` 失败后，下一次同步不论名单变没变都整份给一次。还没登录或名单读不到时不写记录，上次留下的原样留在宿主里，直到第一次成功。

## 读取与发送

- `read` 从内存中的原生主会话 transcript 镜像分页读取，支持最新页、`after` 和 `before`；游标是 `<generation>:<updatedSeq>`，BigInt 比较，不丢 uint64 精度。历史重置后旧游标报错，需重新读取。
- 启动、重连及 `cleared` / `cursorTooOld` 时全量读取一次历史，重建每个 Bot 的条目镜像；之后只按 Watch 的 `rows` 增量更新。`read`、head 和发送回显确认不再拉历史。generation 不变时保留本进程已交付的消息版本；generation 改变则清空旧消息。
- 变化的会话条目各自等待 1 秒无新正文变化才交付，不扫描或重拉完整历史；发布 head 不越过仍未稳定的较早条目。只持久化已暴露正文的摘要、序号及修订标记，不持久化正文镜像。
- 一个条目首次稳定暴露时就是普通消息，ID 为 `<generation>:<entryId>`，cursor 取首次暴露时的 updatedSeq，即使它与原生 seq 不同。只有索引记录的已暴露正文再变化，才追加 `<base>:edit:<updatedSeq>`、带 `about: { message: <base>, change: "edit" }` 的修订。原生历史只保留当前版本，进程重启后不伪造已被覆盖的旧正文。
- `post` 是 `coda.handle('coda/session@1', 'post', …)` 登记的处理函数，发完才返回，返回值 `{ message: { id, cursor } }` 就是结果；运行记录由宿主维护，插件不写。messageId 是按宿主给这次调用的 `ctx.id` 与记录 ID 派生的 UUID；同一次调用只交给处理函数一次由 Coda 保证，插件不再保存 `posts.json` 或重复去重。发送前 `ctx.progress('正在发送')`；发送、等待流事件更新镜像并确认回显后才返回。
- 失败分两类：
  - `effects: 'none'`：用户看到「发送失败」，可以重发。包括发出之前就确定的（会话不可用、会话正在连接、只收文字、回复的消息不存在、选项无效），Grok 明确拒绝认证（HTTP 401 / 403，含无刷新凭据时的 401，401 提示到资源页重新登录；发送被 401 拒收后，登录续期这一步失败也算，不论是被拒、断网还是超时，此时重发还没开始），以及 Grok 明确拒收（`RespondGrokBotWidget` 返回 `accepted === false`、`SendGrokBotUserMessage` 返回 `dispatched === false`）。
  - `coda.error('unknown', …, { effects: 'unknown' })`：用户看到「结果未知」，不重发。指开始发送之后结局说不清的：断线、`accepted` / `dispatched` 字段缺失、接受后没有回显；续期成功后重发的那次请求断线或超时同样未知（再被 401 / 403 拒收则仍是 `none`）。其他 HTTP 状态码（400、429、5xx 等）也记结果未知：只有认证被拒（401 / 403）和明确拒收（`accepted` / `dispatched` 为 `false`）才算确定没发。
- 取消：开始发送之前 `ctx.signal` 已触发，以 `ctx.signal.reason` 抛出，运行记为取消；已经开始发送的不再中断，照常等回显后返回（或失败）。
- 不写 `resume`：插件重启时没有可核验的落盘记录，由宿主默认收尾，记 `interrupted`、`unknown`，用户看到「结果未知」，不会重发。
- 只收文字。
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

测试使用假原生服务端，覆盖登录后记录、增量/向前翻页、修订、稳定 head、启动前已完成的流式消息、断线/游标重置重建、无额外历史读取、post 的调用派生 ID、进度、流回显、失败带 effects、发送前与发送后取消、widget 回复以及 Routine 不镜像；记录及 read 输出按仓库协议契约校验。
