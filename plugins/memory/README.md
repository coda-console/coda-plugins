# 研究记忆

`memory`：研究仓的本地优先记忆。详尽材料留在研究仓的原始文档里，原子化的结论与关系沉淀成规范卡片，
随仓库提交、合并，各台机器再按主分支把卡片同步进本机的检索索引。会话通过 6 个工具读写它，用法见 Skill `research-memory`。

## 架构

- **规范卡片**：`<memoryDir>/items/<id>.md`（默认 `.memory/items/`），在 Git 里，是唯一的事实来源，走普通的分支、评审与合并。
- **检索索引**：由 [`mnemon`](https://github.com/mnemon-dev/mnemon) 从主分支的卡片派生出四类图（时间、实体、因果、语义），存在本机的插件状态目录里，随时可由卡片重建，不进仓库。
- **工具**：`memory_engine_recall`、`memory_engine_search`、`memory_engine_get`、`memory_engine_remember`、`memory_engine_link`、`memory_engine_archive`。会话里省略 `target` 就作用于本机当前项目。
  写工具只改当前工作树里的卡片；读工具能看到当前分支尚未合并的草稿（`draft: true`）。

## 启用与停用

**默认关闭**：装上插件不会打扰任何代码仓，没启用的目录里会话开场没有任何记忆指令，定时同步也不登记。按需开启：

1. 在要沉淀知识的研究仓的目录设置里打开 `memory.enabled`（启用研究记忆），会话开场才带有记忆指令：Agent 开工先查、沉淀前查冲突、写入必带出处。
2. 想彻底隔离非研究仓，给研究仓的目录打上插件 Tag（如 `research`），让这个插件只对带 Tag 的目录生效。
3. 定时同步还要再打开 `memory.autoSync`（默认关）；两者都开的目录才按计划同步索引。

代码仓不要启用：工程规范与「维护者决定」留在代码仓文档原处，不复制进记忆库。要停用就把该目录的 `memory.enabled` 关掉，已有的卡片文件原样留在仓库里。

### 目录级设置与本机设置的分工

- **可按目录覆盖**：`memory.enabled`、`memory.syncSchedule`，以及 `memory.autoSync` 的**定时同步**部分，控制该目录的开场说明与定时同步。
  `memory.autoSync` 有两处效果：目录层的值控制定时同步；会话读取前的惰性同步读的是本机插件层的值（`machine-settings.json`），目录覆盖对它不生效。开场说明分别汇报这两层的状态。
- **以本机插件设置层为准**（目录覆盖对它们不生效）：`memory.memoryDir`、`memory.lazySyncSeconds`、`memory.mnemonPath`、`memory.embedding*`。
  插件启动与设置变化时，把这些非密钥设置写进状态目录的 `machine-settings.json`；会话工具、合并后同步、定时同步与开场说明都读它，
  所以同一台机器上读写的是同一个卡片目录、同一份向量配置。文件缺失或损坏时回退到各自拿到的设置与默认值。

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
`status` 为 `active`、`contested`、`superseded`、`archived`；`importance` 为 1–5；`refs` 至少一项（`appendToId` 补充来源时同样必填）；正文不超过 8,000 字节；`tags` 最多 20 个、每个不超过 100 字节，`entities` 最多 50 个、每个不超过 200 字节（均按 UTF-8，与 mnemon v0.2.15 一致）。

## 同步：三层增量

索引只认默认分支（主分支）上的卡片，对着它的提交读，不碰工作区；索引对应的提交没变就什么都不做，能增量就按差异更新，否则全量重建。三层触发：

1. **合并后**：PR 合并到默认分支后，流程「合并后同步研究记忆索引」立即同步；它由合并卡上的挂点「同步研究记忆索引」控制（默认不勾选），不受 `memory.autoSync` 影响。
2. **定时**：`memory.autoSync` 开启时登记定时流程（Coda 的 `autoRun` 只收单项设置，所以没启用 `memory.enabled` 的项目由脚本一行跳过），流程「同步研究记忆索引」按 `memory.syncSchedule`（默认 `R/PT10M`，每 10 分钟）拉远端并同步。
3. **读取时惰性检查**：本机插件层的 `memory.autoSync` 开启时，读工具发现距上次同步超过 `memory.lazySyncSeconds`（默认 60 秒）就先同步一次。

`memory.autoSync` 只管第 2、3 层（第 2 层看目录层，第 3 层看本机插件层）。关闭后，已有索引不再被定时与读取触发拉取、同步；索引缺失（没建过或丢了），或记忆目录、向量配置变了与索引不一致时，读取仍会本地重建一次，不会把旧索引混进新配置。

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
