# 微信

`@coda-console/wechat` 把手机上的微信群提供给 Coda：每个群一条 `coda/session@1` 记录（Coda 的 docs/plugins.md「会话 Provider」），发布到空间，别的机器也看得到。
装在空间里的安卓手机节点上；这一期只读，不登记 `post`。

## 记录

| 栏 | 内容 |
| --- | --- |
| `id` | `<账号>:<群>`，如 `wxid_me:123@chatroom` |
| `spec.title` | 群名 |
| `spec.container` | 登录的微信账号 `{ id, title }` |
| `status.participants` | 群成员；登录的账号 `kind: bot`、`self: true`，其他人 `kind: person` |
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
读不到手机时 `accounts`、`messages` 抛出给人看的原因。真实的手机桥还没接上，现在用的 `unconnected` 什么都读不到。
