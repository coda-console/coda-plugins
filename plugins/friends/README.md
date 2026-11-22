# 好友

管理本机的 Accord 身份、个人名片与熟人好友通道（`coda/accord@1`）。

- **我的身份与名片**：显示本机公钥短码，可复制公钥；昵称、头像 Emoji、主题色以公开的 `profile` / `self` 记录发布。
- **添加好友**：粘贴对方给的邀请（JSON、`coda-friend://` 链接或多行 `key=value`），接受后自动尝试互认。暂需由对方提供 friend 角色入网码。
- **好友列表**：实时跟随好友表变化；可备注、重新互认、移除。
- **社交网关 `friends/social@1`**：业务无关，别的插件（在 `optionalUses` 里声明）经它读好友与好友分享的记录、向好友发布与撤回记录，不必各自处理没有身份、证书过期和重试。

## 社交网关

签名写入与记录查询全部透传 `coda/accord@1`，网关自己没有第二份目录库。本机网关记录（`friends/social@1`，key `local`）的 `status` 给出作者、证书状态（`no_identity` / `needs_cert` / `active`）、好友数、待发数与暂停的 kind。

| 操作 | 作用 |
| --- | --- |
| `friends`（读） | 互认的好友（`includePending` 带上待互认与冲突的），合并名片与本地备注 |
| `records`（读） | 按 `kind`、`author`、`id`、`cursor` 读好友分享的记录，不读 `binding` |
| `publish` | 发布 `{ kind, id, body, audience? }`；同作者同内容不重发，换作者重发 |
| `retract` | 撤回一条，或省略 `id` 撤回本机在这个 `kind` 下的全部（含队列里还没发出去的） |
| `outbox`（读） | 待发与已同步条目的状态，从不给出 `body` |

- `publish`、`retract` 拒绝保留类型 `binding`、`profile`、`friends`、`coda/profile`、`coda/friends`；`kind` 须是 Accord 的格式，`id` 至多 200 个字符、256 字节，`body` 是对象且 JSON 至多 64 KiB，`audience` 每项是 `public` 或 `ed25519:` 加 64 位十六进制，至多 500 项。
- 没有身份、证书过期（或发布遇到 `invalid_state`）、`kind` 被暂停、发布失败时，待发的 `body` 暂存在本机 `outbox.json`；同步成功就释放 `body`，只留去重用的 `lastAuthor`、`lastSyncedHash`、`lastSyncedAt`；撤回完成就删掉条目。证书恢复后自动补发、补撤；待撤的条目记着排队时的作者（`targetAuthor`），换了作者不会替新作者撤，没有身份时的撤回只清本机未发出的待发，不排待撤。意图先落盘再签名，签名成功立即落盘确认；`outbox.json`、`policy.json` 读不出来（不是缺失或损坏）就报错，不当空表。
- 暂停与恢复某个 `kind` 的外发：`coda self policy.setKind '{"kind":"…","paused":true}'`，`coda self policy.get` 读现状（`policy.json`）；暂停只拦发布，不拦撤回。

## 权限与数据边界

- `uses`：`coda/accord@1` 的 `read`（读好友表与名片）、`publish`（发布名片）、`manage`（接受邀请、互认、移除）。
- 入网码（`authKey`）是凭据：只在提交时用一次，提交后立即清空输入框，不写入任何文件、日志或页面状态。
- 本地备注只存在插件自己的持久目录 `notes.json`（卸载后保留），不发给好友，也不进 Accord 目录。
- 好友发来的昵称、Emoji、颜色按同一套规则清洗，只当文本渲染（`textContent`），不当指令或 HTML。
- 好友页的 Accord 读写在页面交互时发起；模块只在 `activate` 时监听本机 Accord 记录（证书、好友表），用来刷新网关记录、证书恢复后冲洗待发队列。
- `uses` 的 `publish` 也供网关代别的插件向好友发布；待发的 `body` 只在本机 `outbox.json`，不经别处。
