---
name: git-source
description: 使用 Coda git 插件登记本机 Git 源，并通过只读 smart HTTP 取源码；不用于 GitHub PR、普通提交推送或机器选择。
---

# Git 源

插件只认识本机路径与对象 ID。完整接口与示例见 [插件说明](../../README.md)。需要 Coda 的 provider 和流式服务接口；本机管理通过 Coda API 发起，不能从别的插件直接 `protocols.put` 创建本插件的对象。

- 在本机 `plugins/git/services/repository/sources/<id>` POST `{ spec: { path } }`；path 是工作副本根目录或裸仓库的绝对路径。ID 仅用字母、数字、`_`、`-`，至多 100 字符。源实例固定解析后的仓库身份；路径改指另一仓库时须删除源后重新登记。
- 观察本机 `git/source@1`，收到 `status.ready` 才使用 `status.url`。失败读 `reason`；修改完整 spec 时原样带观察到的 revision。
- 用 protocol v2 经已有 Coda 鉴权代理 fetch 分支。只读，只暴露 `refs/heads/*`。空间 Provider 负责把服务入口映射到持有端，不向 git 插件传机器 ID 或空间设置。
- 撤下源可 POST `…/sources/<id>/delete`。不要自行改真实 index、reset/clean 工作区或删除别的 ref。

管理入口创建的源默认只在本机。确需发布时调用 `/publish`，`{ enabled: true }`。源 spec 含本机路径，按实际共享需求发布。取到源码不代表已推送或允许部署，部署准入由相应流程决定。
