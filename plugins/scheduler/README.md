# 执行调度

`scheduler` 通过 `startScheduler(coda)` 在请求持有后端进程内装配；插件宿主入口复用同一实现。依赖 Coda 登记的 `executor` / `execution` 公共协议，不依赖安装 host。
只对 `execution` 的 `local` 集合登记办事员；读取 `executor` 的 `available` 集合，并用 `local` 集合识别本机候选。
引用是 `{kind,id}`，插件不解析引用中的机器归属，也不读取空间配置。它不提供另一套运行队列、名额账本或执行进程。

## 选择政策

- 依序处理请求；没有满足条件的候选时保持未绑定，写 `queued` 和原因。不满足某个请求的运行器仍可处理其他请求。
- executor 必须启用、满足全部需求标签（配置标签与探测标签的并集），且 status 报告 `accepting: true` 与所申请资源的足够可用量。
- `placement.locality: local` 和 `placement.executor` 是硬约束，没有候选就排队，不隐式放宽；符合约束且有空位时本机优先；同属本机或同属其他后端时，选空位最多的，再以不透明引用 ID 稳定排序。
- 资源可为 `{}`、`{slots: 1}` 或一个 `group:<name>: 1`；无资源请求不扣名额，命名组只选择本机。运行器须明确声明支持无资源、命名组及运行上下文。独占须报告支持独占，且无占用、所有名额空闲。未完成的本机绑定会保守扣减调度估计，避免同一旧状态被这一持有端反复填满。
- 容量状态不是预留，scheduler 不获取名额；执行方开跑前仍经本机账本最终准入。没有基于时钟的在线推断。

严格 FIFO 只采用持有方赋予对象信封的只读 `creationSequence`，不使用首次观察顺序、对象 ID、revision 或插件计数器替代。
依赖 Coda #2083 的通用创建信息接口（plugin-check 0.5.29、同步自 88ade66）；`createdAt` 仅供展示，相同时间或时钟回退不影响排序。
序号只在同一持有方内可比较，所以请求只读取 local 集合。更新及重启不改变顺序，删除同名重建后以新序号重新排队。
任何待分配请求缺少有效序号时，所有待分配请求保持排队并报告 `creation_order_unavailable`，避免已知序号的请求越过顺序未知的请求。
取消及明确拒绝的处理不依赖排序，继续进行；已绑定请求仍由执行方处理并恢复观察。插件持久状态只保存拒绝记录，不保存排序正本。

## 绑定、拒绝与恢复

通过 `protocols.update` 携观察到的 revision 同次替换 `executor` 和新的 `assignmentId`；不登记补充者，不改变任务、源码、资源、attempt 或取消意图。
只有与当前 assignment 对齐的 `finished/rejected` 才释放旧绑定，再选择新候选。协议首版没有另一种单独的“已确认撤销且从未启动”凭证，
所以不从 `queued`、缺 `startedAt`、空 status、节点消失或超时推断它。已开始或是否开始不明的请求保留绑定、运行引用与执行方结果，继续订阅观察，不重跑。

拒绝时先将被拒 executor 的观察 revision 写入插件持久状态，再解除绑定；同一请求不会立即选回同一份被拒状态。
其他合格候选可立即接手，原候选更新 status 后可再次参与。重启保留这项抑制，删除或终结请求后回收记录。
host 当前可能在最终准入冲突时报告已绑定的 `queued/capacity`；这种回答会继续等待原执行方，并不触发改派。

拒绝后解除绑定再排队时，queued 的 `status.assignmentId` 保留上次拒绝的值，不能清空或替换，防止重新绑定复用旧 token。新 assignment 仍由绑定 CAS 生成。

未绑定时收到 `spec.cancel: true`，直接写 `finished/cancelled`；已绑定时保留取消意图，由执行方处理进程、收尾及结果。
生产方由 Coda 在请求正本写取消意图，host 不提供创建／取消入口。
scheduler 不伪造绑定后的 status，包括绑给本机的请求。CAS 冲突重新观察，不拿新 revision 重交旧决定。

## 排队原因

未绑定请求的 `status.reason` 可直接观察：

| code | 含义 |
| --- | --- |
| `creation_order_unavailable` | 等待持有方提供完整创建序号，暂停新绑定以保持 FIFO |
| `no_executor` | 没有可见运行器 |
| `labels_unavailable` | 没有候选满足全部标签 |
| `not_accepting` | 满足标签的候选未报告接活或已停止接活 |
| `exclusive_unsupported` | 没有候选支持所需独占 |
| `capacity` | 合格候选没有空闲名额，或未完全空闲以供独占 |
| `admission_rejected` | 合格候选的当前状态已经被拒，等待新状态 |
| `unsupported_resources` | 请求不在无资源／单资源一单位的范围内 |
| `placement_unavailable` | 硬定位约束下没有候选 |
| `named_resource_local_only` | 命名资源没有本机候选 |
| `execution_features_unavailable` | 候选未声明支持请求需要的资源或上下文 |

状态变化触发重新调度；不设置空转定时器。启动订阅失败明确报错，控制写入失败报告错误、在下次观察变化时重试。写入相同排队原因不会推进 revision。

## 验证边界

`test/plugins/scheduler/policy.test.mjs` 表驱动验证纯政策；`controller.test.mjs` 使用 plugin-check 同步的 `providerAPI`、
`providerDefinition`、`ProtocolTypes`、`creationOf` 及 host 锁定的协议包，验证控制接线、scope、CAS、初始快照、取消与恢复，
以及乱序快照／增量事件、时钟回退、重启和同名重建后的创建顺序。
夹具不代替真实后端、名额账本或联邦端到端验收。流程创建 execution 的接入及真实跨机端到端留给 coda#2078 第 7 步以后。
