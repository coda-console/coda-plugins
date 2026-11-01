---
name: git-source
description: 使用 Coda git 插件登记本机 Git 源、创建运行关联的提交或工作树快照，并通过只读 smart HTTP 取源码；不用于 GitHub PR、普通提交推送或机器选择。
---

# Git 源与快照

插件只认识本机路径与对象 ID。完整接口与示例见 [插件说明](../../README.md)。需要 Coda 的 provider 和流式服务接口；本机管理通过 Coda API 发起，不能从别的插件直接 `protocols.put` 创建本插件的对象。

- 在本机 `plugins/git/services/repository/sources/<id>` POST `{ spec: { path } }`；path 是工作副本根目录或裸仓库的绝对路径。源实例固定解析后的仓库身份；路径改指另一仓库时须删除源后重新登记。
- 在 `…/snapshots/<id>` POST `{ spec: { source, mode: 'worktree', run } }`，或 `mode: 'commit'` 加 `commit`。run 必须是已有本机运行 ID。ID 仅用字母、数字、`_`、`-`，至多 100 字符。
- 观察本机 `sourceSnapshot`，收到 `status.ready` 才使用 `status.url` 与 `status.ref`。失败读 `reason`；修改完整 spec 时原样带观察到的 revision。每次需要新的工作树内容时创建新快照 ID。
- 用 protocol v2 经已有 Coda 鉴权代理 fetch 完整 ref。空间 Provider 负责把服务入口映射到持有端，不向 git 插件传机器 ID、空间设置或 `/forward` 路径。
- 运行结束自动回收 ref；提前释放可 POST `…/snapshots/<id>/delete`。不要自行改真实 index、reset/clean 工作区或删除别的 ref。

默认对象只在本机；确需发布时调用对象的 `/publish`，`{ enabled: true }`。源 spec 含本机路径，按实际共享需求发布。

工作树快照包含未提交和未跟踪文件、执行位与符号链接，排除忽略文件；子模块不递归快照。没有 HEAD 或裸仓库不能做工作树快照。快照不代表源码已推送或允许部署，部署准入由相应流程决定。
