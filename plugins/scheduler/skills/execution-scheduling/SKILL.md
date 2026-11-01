---
name: execution-scheduling
description: 查询执行请求为何排队、如何选择运行器、何时允许改派与怎样取消时使用；不用于直接启动命令或手工绕过宿主名额。
---

# 执行请求调度

scheduler 只调度本机持有的 execution；本机与可见的其他运行器共用 executor 协议，不需要机器 ID 或空间设置。

- 全部需求标签必须满足，运行器须启用，status 须显示接活及有名额。有空位时本机优先，同等时选空位多的。
- 请求可不占资源、申请 `slots: 1` 或一个本机命名组的一单位；定位约束 `placement` 必须满足，不能偷偷改派。可独占申请的资源；独占须运行器支持且全部空闲。容量只是调度依据，执行方的本机账本负责最终准入。
- 严格按持有方赋予信封的 `creationSequence` 排序，不能用首次观察顺序、`createdAt` 或对象 ID 代替。需要支持 Coda #2083 创建信息接口的后端。
  `creation_order_unavailable` 表示缺少有效创建序号，暂停新绑定；取消及恢复观察继续进行，不手工补造序号。
- 未绑定时看 `status.reason.code`：`no_executor` 无运行器，`labels_unavailable` 标签不符，`not_accepting` 不接活或状态未到，
  `exclusive_unsupported` 不支持独占，`capacity` 名额不足，`admission_rejected` 等拒绝方的新状态，`unsupported_resources` 资源请求不支持；`placement_unavailable` 定位约束无候选，`execution_features_unavailable` 候选不支持所需上下文或资源语义。
- 已绑定时 status 由执行方回答。只有当前 assignment 的明确 `finished/rejected` 才可改派；旧拒绝、空状态、缺 startedAt、断线和 queued 都不是未执行证明。
  `queued/capacity` 表示继续等原执行方的名额。结果未知时恢复观察原绑定／运行引用，不手工清绑定，不新建重复尝试。
- 取消由 Coda 生产方写 `spec.cancel: true`，带当前 revision。未绑定由 scheduler 结束为 cancelled；已绑定等执行方处理取消和收尾。
  取消不是删除请求，也不是立即释放名额的证明。

不要直接用 `protocols.put` 冒充 provider 创建请求，也不要用补充机制写绑定。普通会话命令继续用既有 run-held；
本插件不代表流程与 run-held 已完成 execution 迁移，该接入是 coda#2078 后续步骤。
