---
name: research-memory
description: 研究仓的研究记忆用法：开工前先召回现行结论与出处，沉淀结论前先查冲突并带上 refs，按重复佐证、明确取代、暂未定论三种情况处理冲突。在研究仓里做调研、写结论、回答研究问题时读。
---

# 研究记忆

## 定位与红线

- **只在已启用研究记忆的研究仓里用**（会话开场带有研究记忆的说明），或用户明确要求时才用；普通代码仓里绝不擅自创建 `.memory/` 目录、也不主动调用写工具。

- 研究仓用原始文档保存详尽材料；`<memoryDir>/items/<id>.md`（默认 `.memory/items/`）只沉淀原子化结论及它们之间的关系。
- 代码仓的工程规范和「维护者决定」留在代码仓文档原处，不复制进记忆库，最多放一个引用链接。

## 工具

`memory_engine_recall`、`memory_engine_search`、`memory_engine_get`、`memory_engine_remember`、`memory_engine_link`、`memory_engine_archive` 都**省略 `target`**，自动作用于本机当前项目。

## 开工先查

研究或回答之前先 `recall`（问题式）或 `search`（按 `kind`、`entity`、`tag`、`ref` 过滤）。读结果里的：

- 现行结论与 `refs`（原始出处）；
- `contradictions`（争议项）；
- `draft` 为 true 的卡片（当前分支未合并的草稿）。

要原文细节时按 `refs` 读对应文档，或读 `coda://threads/...` 会话。

## 写入

1. **写前先查**：对核心实体先 `recall`，排查与现有结论的隐性冲突。
2. **必带出处**：每次 `remember` 都带 `refs`（仓内路径或锚点、URL、`coda://threads/...`）。
3. **正文精炼**：一张卡片一个结论，不超过 8,000 UTF-8 字节；合理标注 `kind`（fact / conclusion / hypothesis / observation）、`entities`、`tags`、`importance`（1–5）。

## 冲突三分法

| 情况 | 做法 |
| --- | --- |
| 重复佐证 | `appendToId` 向已有卡片追加新 `refs`，不建重复卡 |
| 明确推翻或更新 | 建新卡并写 `supersedes` 指向旧卡：保留演变历史，旧卡自动降权 |
| 暂未定论、条件并存 | 保留双方，用 `contradicts` 关联，正文写明各自的适用前提 |

推翻 `importance >= 4` 的核心结论时，**不要在新卡上写 `supersedes`**：那会让旧卡立刻变成 `superseded`、从默认 `recall` 里消失。
先建新卡，用 `contradicts` 关联旧卡，并标 `status: "contested"`，双方都保留，等维护者裁决。裁决确认取代后依次两步：先 `link`（`relation: "supersedes"`）建立取代关系，再 `link`（`relation: "contradicts"`, `remove: true`）撤销这对卡片之间的矛盾边；新卡没有其他矛盾边时随之恢复为 `active`。
关系事后也用 `link` 建立或撤销；过时无用的卡用 `archive` 并写明原因。

## 随分支提交

写操作落在当前工作树的 `<memoryDir>/items/`，随研究文档一起提交、合并到默认分支。各台机器按主分支的变动自动增量同步进本地索引；合并前的卡片只在当前分支以草稿可见。
