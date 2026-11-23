# 好友

管理本机的 Accord 身份、个人名片与熟人好友通道（`coda/accord@1`）。

- **我的名片**：名片卡显示昵称、头像、主题色与本机公钥短码（点按复制），下方状态条给出已互认好友数（有待互认、冲突时提示）与身份、证书状态；多台机器提供这页时顶部可切换，连不上的机器置灰并注明原因。
- **编辑名片**：头像可选照片、几何纹（按公钥生成）、Emoji 或字标（昵称首字，写进 `emoji`）。照片从本机选图，在弹层里拖动、缩放裁成 512×512，优先编 WebP（不支持时用 JPEG），上传到 `coda-view://blob/content` 后把内容指针写进名片的 `avatar`；只改昵称、颜色不重新上传，换成非照片头像时写 `avatar: null` 清除。名片以公开的 `profile` / `self` 记录发布；本机绑定了代签证书、`profile` 被拒（`forbidden`）时改发可代签的社交名片 `friends/card` / `self`。
- **添加好友**：点名片上的「添加好友」，粘贴对方给的邀请（JSON、`coda-friend://` 链接或多行 `key=value`），接受后自动尝试互认。暂需由对方提供 friend 角色入网码。
- **好友列表**：实时跟随好友表变化，宽屏双列；显示好友的照片头像（读不出时退回 Emoji、几何纹或首字，点「刷新」重试）。点好友打开详情：完整公钥、节点名、本机备注、重新互认、二次确认后移除。
- **社交网关 `friends/social@1`**：业务无关，别的插件（在 `optionalUses` 里声明）经它读好友与好友分享的记录、向好友发布与撤回记录、发私信与动态、实时跟随私信与动态，不必各自处理没有身份、证书过期和重试。

## 社交网关

签名写入与记录查询全部透传 `coda/accord@1`，网关自己没有第二份目录库。本机网关记录（`friends/social@1`，key `local`）的 `status` 给出作者、证书状态（`no_identity` / `needs_cert` / `active`）、好友数、待发数与暂停的 kind。

| 操作 | 作用 |
| --- | --- |
| `friends`（读） | 互认的好友（`includePending` 带上待互认与冲突的），合并 `profile`、`friends/card`（逐字段 `profile` 优先）与本地备注；每行带 `avatar`（`content/<sha256>` 指针或 `null`） |
| `records`（读） | 按 `kind`、`author`、`id`、`cursor` 读好友分享的记录，不读 `binding` |
| `publish` | 发布 `{ kind, id, body, audience? }`；同作者同内容不重发，换作者重发 |
| `set-card` | 发布本机社交名片 `friends/card` / `self`：`{ name, emoji?, color?, avatar? }`，`avatar` 只收 `content/<sha256>` 指针（至多 5 MiB），`null` 清除；与 `publish` 同一条队 |
| `send-dm` | 发一条私信 `friends/dm`：`{ to, id?, text?, attachments?, replyTo? }`，受众只有 `to` 一人（不收 `public`、不收自己）；结果带最终用的 `id` |
| `post-feed` | 发一条动态 `friends/feed`：`{ id?, text?, media?, audience? }`，`audience` 缺省 `['public']`，写了须是 1–500 项（去重）；结果带最终用的 `id` |
| `retract` | 撤回一条，或省略 `id` 撤回本机在这个 `kind` 下的全部（含队列里还没发出去的） |
| `outbox`（读） | 待发与已同步条目的状态，从不给出 `body` |

- `publish`、`retract` 拒绝保留类型 `binding`、`profile`、`friends`、`coda/profile`、`coda/friends`；`kind` 须是 Accord 的格式，`id` 至多 200 个字符、256 字节，`body` 是对象且 JSON 至多 64 KiB，`audience` 每项是 `public` 或 `ed25519:` 加 64 位十六进制，至多 500 项。
- 没有身份、证书过期（或发布遇到 `invalid_state`）、`kind` 被暂停、发布失败时，待发的 `body` 暂存在本机 `outbox.json`；同步成功就释放 `body`，只留去重用的 `lastAuthor`、`lastSyncedHash`、`lastSyncedAt`；撤回完成就删掉条目。证书恢复后自动补发、补撤；待撤的条目记着排队时的作者（`targetAuthor`），换了作者不会替新作者撤，没有身份时的撤回只清本机未发出的待发，不排待撤。意图先落盘再签名，签名成功立即落盘确认；`outbox.json`、`policy.json` 读不出来（不是缺失或损坏）就报错，不当空表。
- 操作名照协议包的规定用小写加连字符（`set-card`、`send-dm`、`post-feed`）。
- 暂停与恢复某个 `kind` 的外发：`coda self policy.setKind '{"kind":"…","paused":true}'`，`coda self policy.get` 读现状（`policy.json`）；暂停只拦发布，不拦撤回。

## 私信与动态

两类记录都由 Accord 签名与保存，网关只清洗与投影，没有第二套目录库；没有身份或证书过期时在 `outbox.json` 排队、恢复后补发，撤回统一走 `retract({ kind: 'friends/dm' | 'friends/feed', id })`。

- **正文**：`text` 按原样（含首尾空白）至多 8000 个字（码点，与 schema 的 `maxLength` 一致），发布时去首尾空白；图片指针（`attachments` / `media`）1–4 个，只收 `content/<sha256>`；两者不能都空。`id` 省略时网关生成 UUID，给了须是至多 200 个字符、且 UTF-8 至多 256 字节（与 Accord 一致；schema 表达不了字节数，超了由网关以 `invalid_input` 拒绝）、不含控制字符，去首尾空白后不能为空；`replyTo` 同。
- **只发给别人**：私信的 `to` 不能是本人。排队时还没有身份、后来绑定的身份正好是收件人的，补发时按实际签名的作者再判一次，标成被拒（`error`），不签。
- **幂等重试**：`body.createdAt` 先沿用同一 `id` 已有的：`outbox.json` 里待发条目的，或已同步条目留下的 `lastCreatedAt`；队列里没有才查本机在 Accord 里的那条，查明没有才取当前时间，查询失败报可重试的 `unavailable`，不拿新时间戳重签。所以同一 `id`、同样内容的重试按 `publish` 的去重返回 `skipped: true`，不会重签。
- **投影**：每个 `(author, id)` 只取 `version` 最大的一条，它若是撤回（空 `body`）或畸形，整条就没了，不回落旧版本。私信只收本机发出（本人签、发给别人）或发给本机（别人签、`to` 是本人）的，`peer` 是对面那个人；串线、伪造的丢掉。私信按 `(createdAt, version, author, id)` 升序，动态降序。

### 实时流 `dm`、`feed`

两条都是 `read` 形状的帧流（`application/x-ndjson`，30 秒没东西写一个空行心跳），参数走查询串：`dm` 收 `peer`（只看与这位好友的），`feed` 收 `author`（只看这一位的），都收 `after`（上次拿到的游标）。

- 快照分片发出：每帧 `{ type: 'snapshot', cursor, items, more }`，单帧 JSON 至多 256 KiB（远低于 `readFrames` 默认的一行 1 MiB）；后面还有分片的 `more` 为 `true`，最后一片（空快照也有这一片，`items: []`）为 `false`。客户端把各片的 `items` 依次拼起来，收到 `more: false` 才落定整份快照与游标。
- 之后每次变化一帧 `{ type: 'upsert', cursor, item }` 或 `{ type: 'retract', cursor, author, id, peer? }`。同一条私信改投新收件人时，旧会话先收到 `retract`（`peer` 是旧收件人），新会话再收到 `upsert`。
- 游标是 `<epoch>:<seq>`：`epoch` 每次网关启动重新生成，`seq` 单调递增。网关在内存里留最近 500 次变化；`after` 有效时只补它之后的增量（含撤回，不重复）。`after` 缺失、不合法、来自上一次启动、比现在还新或已被挤出这 500 条的，回到全量快照。
- 只在有订阅者或新流连入时才翻页读 Accord，随本机 Accord 记录的变化和本机的发布、撤回刷新；刷新排成一条队，不会交错。每次都翻页读到底，读不全（翻页截断、查询失败）就不动内存里上一份完整的投影，不推虚假的快照或撤回；还从没读全过时新连入的流在第一个字节之前以 `unavailable` 失败。
- 调用方中止请求、取消应答体，或插件停用时，流当场收尾，订阅与监听随之释放（不等下一帧、也不管调用方读没读）。

## 权限与数据边界

- `friends/social@1` 的权限组：`read` 管 `friends`、`records` 和 `dm`、`feed` 两条流；`publish` 管 `publish`、`set-card`、`send-dm`、`post-feed`、`retract`、`outbox`。
- `uses`：`coda/accord@1` 的 `read`（读好友表与名片）、`publish`（发布名片）、`manage`（接受邀请、互认、移除）。
- 入网码（`authKey`）是凭据：只在提交时用一次，提交后立即清空输入框，不写入任何文件、日志或页面状态。
- 本地备注只存在插件自己的持久目录 `notes.json`（卸载后保留），不发给好友，也不进 Accord 目录。
- 好友发来的昵称、Emoji、颜色按同一套规则清洗，只当文本渲染（`textContent`），不当指令或 HTML。
- 好友页的 Accord 读写在页面交互时发起；模块只在 `activate` 时监听本机 Accord 记录（证书、好友表），用来刷新网关记录、证书恢复后冲洗待发队列。
- `uses` 的 `publish` 也供网关代别的插件向好友发布；待发的 `body` 只在本机 `outbox.json`，不经别处。
