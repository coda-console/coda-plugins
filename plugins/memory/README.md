# 研究记忆

`memory`：研究仓的本地优先记忆。详尽材料留在研究仓的原始文档里，原子化的结论与关系沉淀成规范卡片，
随仓库提交、合并，各台机器再按主分支把卡片同步进本机的检索索引。会话通过 6 个工具读写它，用法见 Skill `research-memory`。

## 架构

- **规范卡片**：`<memoryDir>/items/<id>.md`（默认 `.memory/items/`），在 Git 里，是唯一的事实来源，走普通的分支、评审与合并。
- **检索索引**：由 [`mnemon`](https://github.com/mnemon-dev/mnemon) 从主分支的卡片派生出四类图（时间、实体、因果、语义），存在本机的插件状态目录里，随时可由卡片重建，不进仓库。
- **工具**：`memory_engine_recall`、`memory_engine_search`、`memory_engine_get`、`memory_engine_remember`、`memory_engine_link`、`memory_engine_archive`。会话里省略 `target` 就作用于本机当前项目。
  写工具只改当前工作树里的卡片；读工具能看到当前分支尚未合并的草稿（`draft: true`）。

## 启用与停用

在目录的插件设置里启用「研究记忆」的研究仓，会话开场就带有记忆指令，Agent 开工先查、沉淀前查冲突、写入必带出处。
代码仓不要启用：工程规范与「维护者决定」留在代码仓文档原处，不复制进记忆库。要停用就在该目录的插件设置里关掉，已有的卡片文件原样留在仓库里。

## 卡片格式

```markdown
---
id: "01JZ8Q3M4X5N6P7R8S9T0V1W2X"
kind: "conclusion"
status: "active"
importance: 4
refs: ["docs/research/cache-study.md#结论", "https://example.com/paper"]
entities: ["缓存", "LRU"]
tags: ["性能"]
supersedes: []
contradicts: []
related: []
created_at: "2026-11-28T08:00:00Z"
updated_at: "2026-11-28T08:00:00Z"
---

在读多写少、热点集中的负载下，LRU 的命中率比 FIFO 高约 12 个百分点（见 refs 中的基准）。
```

frontmatter 每行是 `键: JSON 值`。`kind` 为 `fact`、`conclusion`、`hypothesis`、`observation`；
`status` 为 `active`、`contested`、`superseded`、`archived`；`importance` 为 1–5；`refs` 至少一项；正文不超过 8,000 字节。

## 同步：三层增量

索引只认默认分支（主分支）上的卡片，对着它的提交读，不碰工作区；索引对应的提交没变就什么都不做，能增量就按差异更新，否则全量重建。三层触发：

1. **合并后**：PR 合并到默认分支后，流程「合并后同步研究记忆索引」立即同步；它由合并卡上的挂点「同步研究记忆索引」控制，不受 `memory.autoSync` 影响。
2. **定时**：`memory.autoSync` 开启时，流程「同步研究记忆索引」按 `memory.syncSchedule`（默认 `R/PT10M`，每 10 分钟）拉远端并同步。
3. **读取时惰性检查**：`memory.autoSync` 开启时，读工具发现距上次同步超过 `memory.lazySyncSeconds`（默认 60 秒）就先同步一次。

`memory.autoSync` 只管第 2、3 层。关闭后，已有索引不再被定时与读取触发拉取、同步；索引缺失（没建过或丢了）时，读取仍会本地初始化一次。

## Embedding（选配）

默认 `memory.embeddingProvider` 为 `none`，只做文本检索。需要语义向量时：

| 值 | 说明 |
| --- | --- |
| `none` | 不用向量（默认） |
| `ollama` | 填 `memory.embeddingBaseUrl`（如 `http://127.0.0.1:11434`）与 `memory.embeddingModel` |
| `openai-compatible` | 同上，另用 `memory.embeddingApiKeyEnv` 指向存放密钥的环境变量 |

`memory.embeddingApiKeyEnv` 只填环境变量**名**（如 `OPENAI_API_KEY`），不要填密钥本身；插件在运行时从环境里读它的值。

## mnemon 与安装

`memory.mnemonPath` 填 `mnemon` 可执行文件的路径；留空则先找插件状态目录里的 `bin/mnemon`，再找 `PATH`。
插件的安装步骤（`setup`）会在这台机器上自动下载锁定版本（v0.2.15）的官方发布包，核对 SHA-256 后装到状态目录；
设置里已填可执行的路径、或状态目录里已有这个版本时什么都不做。
