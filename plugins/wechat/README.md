# 微信

`@coda-console/wechat` 把手机上的微信群提供给 Coda：每个群一条 `coda/session@1` 记录（Coda 的 docs/plugins.md「会话 Provider」），发布到空间，别的机器也看得到。
装在空间里的安卓手机节点上；这一期只读，不登记 `post`。

## 记录

| 栏 | 内容 |
| --- | --- |
| `id` | `<账号>:<群>`，如 `wxid_me:123@chatroom` |
| `spec.title` | 群名 |
| `spec.container` | 登录的微信账号 `{ id, title }` |
| `status.participants` | 群成员；登录的账号 `kind: person`、`self: true`，其他人也 `kind: person`（这个号是用户本人在用） |
| `status.head` | 最新一条消息的游标，每来一条就推进；群里还没有消息时不写 |
| `status.state` | `active`；手机桥读不到时 `unreachable`，`reason` 写原因 |

手机桥说账号、群或成员变了（或手机丢了、接回来）就重新列一遍：改名、换成员照写，新群新建并发布，不在了的群删掉记录。

## read

游标是消息在群里的位置 `seq`（只增的整数）的十进制写法，对外不透明。消息按先后排，带发送者当时的群昵称 `senderName`；`limit` 默认 50：

- 不带游标：最新的 `limit` 条，`more` 说更早还有没有；
- `before`：这个游标之前最新的 `limit` 条，`more` 说更早还有没有；
- `after`：这个游标之后的 `limit` 条，`more` 说之后还有没有。

结果的 `cursor` 是这一页最后一条；没有消息时是 `after`，都没有就是 `null`。

## 手机桥

插件不直接碰手机，只经 `lib/bridge.mjs` 写明的三个接口拿数据：列出账号和群（含成员、`last`）、按群和位置读消息、有新消息或列表变了时通知。
读不到手机时 `accounts`、`messages` 抛出给人看的原因。

`phoneBridge()`（`lib/bridge.mjs`）是接在手机节点上的实现。插件装在手机节点的 Coda 后端里，后端在 Debian chroot 里以 root 跑、看不到安卓的 `/data`，所以它经 `nsenter -t 1 -m` 进 init 的挂载空间访问安卓那一侧。它只读：每次读把微信本地库（`EnMicroMsg.db` 和未落盘的 `-wal`）复制到本机私有临时目录，纯 JS 解开 SQLCipher（逐页 AES-256-CBC、页尾 IV、`cipher_compatibility=1`）、把 WAL 的已提交页覆盖上去，再用 `node:sqlite` 只读查询，用完即删——绝不打开或改动原库。新消息靠轮询库文件 mtime/大小变化触发，再增量读。

账号相关的值都在运行时从本机得出：uin 读自微信 `shared_prefs`，账号目录是 `md5("mm"+uin)`，库密钥是 `md5(SEED+uin)` 前 7 位十六进制（`SEED` 是微信对所有安装通用的设备号兜底，非本账号的值）。读出的数据只留在手机节点本机的内存和私有临时目录里。
