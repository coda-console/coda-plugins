---
name: git-source
description: 使用 Coda git 插件登记本机 Git 源，并通过只读 smart HTTP 取源码；不用于 GitHub PR、普通提交推送或机器选择。
---

# Git 源

插件只认识本机路径与对象 ID。完整接口与示例见 [插件说明](../../README.md)。需要 API Level 14 的 Coda；本机管理通过 Coda API 发起，不能从别的插件直接 `coda.put` 创建本插件的对象。

- 在本机 `/v1/plugins/git/services/repository/sources/<名字>` POST `{ spec: { path } }`；path 是工作副本根目录或裸仓库的绝对路径。名字仅用字母、数字、`_`、`-`，至多 100 字符。回的 `id` 是宿主由名字派生的记录 ID（名字是记录的 key，也在 `spec.name`），同名再登记 ID 不变。源固定解析后的仓库身份；路径改指另一仓库时须删除源后重新登记。
- 观察本机 `git/source@1`（`coda.watch(kind, fn, { scope: 'local' })`，事件是 `{ type, id, entry }`，`id` 是记录 ID），收到 `entry.status.ready` 才使用 `status.url`（每次现读，不要记下来拼）。失败读 `reason`；修改时 POST 完整 spec。
- 取源码：`git -c protocol.version=2 fetch "<本机 Coda 后端地址><status.url>" refs/heads/main:refs/heads/main`，带已有的 Coda 鉴权。只读，只暴露 `refs/heads/*`。源在空间里别的机器上也用本机后端的这个地址，不用换；不向 git 插件传机器 ID 或空间设置。
- 撤下源可 POST `…/sources/<名字>/delete`。不要自行改真实 index、reset/clean 工作区或删除别的 ref。

源在空间里都看得到，spec 含本机路径，登记时按这个来。取到源码不代表已推送或允许部署，部署准入由相应流程决定。
