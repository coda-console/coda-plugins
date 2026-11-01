# Git 源与快照

`@coda-console/git` 提供本机仓库、运行关联快照和只读 Git smart HTTP。需要系统 Git（支持 protocol v2、`--path-format=absolute`）及包含 provider／流式服务接口的 Coda（coda#2080、#2079）。不接收机器 ID、机器列表或空间配置，不依赖 host，不改变执行／部署准入。

## 对象与本机管理入口

概念名为 GitSource、SourceSnapshot；Coda 类型名要求小写开头，实际 kind 为 `gitSource`、`sourceSnapshot`。由插件登记 schema 并保存本机正本，`control` 办事员写 status 时带执行时观察到的 revision。类型定义见 `lib/definitions.mjs`。

| kind | spec | status |
| --- | --- | --- |
| `gitSource` | `path`：工作副本根目录或裸仓库的本机绝对路径 | `ready`、`url`，失败时 `reason` |
| `sourceSnapshot` | `source`：本机源 ID；`mode`：`commit` 或 `worktree`；`commit`：仅提交模式必填；`run`：已有本机运行 ID | `ready`、`commit`、`ref`、`url`；失败时 `reason`；回收后 `released: true` |

源和快照 ID 使用 1–100 个字母、数字、`_`、`-`。源实例首次可用时会持久固定解析后的工作副本、Git 目录及公共目录。符号链接改指另一仓库时，源变为不可用，重启也不会自动接管新仓库；须删除源后重新登记。未创建 HEAD 的仓库无法制作快照；裸仓库仅支持提交模式。工作树快照记录 Git 自身的文件语义：含未提交和未跟踪文件，不含忽略文件；子模块记录 gitlink，不递归打包子模块工作树。

只有 provider 可创建这些对象。其他本机插件用 `coda.api` 调管理入口（JSON，64 KiB 上限）；入口只接受可信 `caller.local === true`，设备和后端身份只能读取 Git 数据，不能提交路径。不要直接用另一个插件的 `protocols.put` 创建本插件对象。

```js
const base = 'plugins/git/services/repository';
await coda.api(`${base}/sources/project`, { spec: { path: '/absolute/repository' } });
await coda.api(`${base}/snapshots/job-input`, {
  spec: { source: 'project', mode: 'worktree', run: runId },
});
// 提交模式：spec: { source: 'project', mode: 'commit', commit: sha, run: runId }
const subscription = await coda.protocols.observe('sourceSnapshot', event => {
  if (event.id === 'job-input' && event.object.status.ready) {
    // status.url 是本机服务相对路径；status.ref 是 fetch 的完整引用。
  }
}, 'local');
```

创建成功表示对象已接收；等 status.ready 再 fetch。GET `…/sources/<id>`／`…/snapshots/<id>` 读信封。修改用同一路径 POST `{ spec, revision }`（完整 spec），revision 原样取观察结果；过期版本由 Coda 拒绝。状态失败后先修正原因，再更新对象或创建新快照，不把旧结果换上新 revision 重交。

POST `…/snapshots/<id>/delete` 删除快照；POST `…/sources/<id>/delete` 撤下源并回收其快照 ref。POST `…/<sources|snapshots>/<id>/publish` `{ enabled: true|false }` 显式发布／撤下协议镜像；默认仅本机，不自动广播本地路径。跨机引用与入口由空间 Provider 映射，调用方不往本插件传机器参数。

## 快照与回收

工作树路径依次执行临时 `GIT_INDEX_FILE` → `read-tree HEAD` → `add -A` → `write-tree` → `commit-tree -p HEAD` → `update-ref`。保留执行位、符号链接，真实 index 与工作区均不修改；提交身份沿用父提交，不设置 Git 用户配置。制作过程中用户仍可编辑文件，因此它是 Git 逐文件读取的结果，不保证跨文件事务一致性。

临时引用为 `refs/coda/snapshots/<sha256>`，标识包含快照实例、spec 与源实例，避免删除重建或修改请求复用旧结果。相同请求只生成一次；后续工作树变化需新快照 ID。源暂时不可用时撤下读取并报告失败，但保留活跃请求的账本与 ref；源恢复并再次对账时复用原提交，宿主重启也不重新捕获工作树。插件状态目录 `snapshots.json` 在写 ref 前记账，宿主重启保留活跃运行快照；对象删除、源删除或关联运行结束后回收 ref。按运行 ID 订阅 `workflow-runs`，不会把掉出最近运行列表当作完成；旧运行可单独读取，读取失败报告失败，并在后续对账时重新查询，无需等待新的运行订阅事件；查询期间若订阅收到新事件，丢弃该查询的旧响应（含错误），保留订阅状态。启动时对账并回收停机期间产生的孤立 ref；清理失败保留账本并报日志，下次对象变化或宿主重启再次尝试。Git 的不可达对象由正常 Git GC 回收。

## 只读 smart HTTP

服务 `repository` 的 Git URL 为 `/v1/plugins/git/services/repository/repos/<source>`。由 Coda 先鉴权，再经流式通道交给插件；空间 Provider 可经 `/forward/<owner>/…` 到持有端，本插件只处理本机相对路径。使用已有 Coda 鉴权连接／代理入口，插件不另发 token、不开放匿名端口。

```sh
git -c protocol.version=2 fetch "$AUTHENTICATED_GIT_URL" \
  refs/coda/snapshots/<snapshot-token>:refs/coda/input
```

仅允许 GET `info/refs?service=git-upload-pack` 和 POST `git-upload-pack`，必须带 `Git-Protocol: version=2`；映射为 CGI `HTTP_GIT_PROTOCOL`。完整读入请求（最多 32 MiB、不接受压缩请求体），再送 `git http-backend`；输入写完才转发 CGI 响应头，响应 pack 按背压流式发送。客户端断开、服务注销或宿主结束时停止子进程。

每次请求创建临时裸仓库视图，只挂原仓库对象库和 `refs/heads/*`、本插件仍存活快照的 ref；不暴露 tags、remote refs、其他内部 ref、配置和磁盘文件。请求的 want 还须是允许 ref 的提交或祖先；不允许凭已知 OID 读取不相关隐藏对象。允许分支的历史本来就是可读内容，删除快照 ref 不会撤回已有分支可达的提交。receive-pack 始终拒绝，仓库自身的 receive-pack 配置无效。浅仓库会保留 shallow 边界；客户端需用 `fetch --update-shallow` 接受该边界，无法取得源本身没有的历史。

## 检查与发布

脚本级测试在 `test/plugins/git/`，使用真实临时 Git 仓库与 Node HTTP；provider 测试使用同步的宿主 API／schema，显式送事件，不启动 Coda 后端。运行：

```sh
node --test 'test/plugins/git/*.test.mjs'
node bin/check.mjs plugins/git --manifest
node scripts/check-contract.mjs
```

真实 Coda 插件宿主、空间代理／tailnet／DERP 与运行器整合属于后续步骤，不能用脚本测试替代。新包首发依照仓库根 README「npm 发布」：维护者 `npm login` 后执行 bootstrap 配置信任，再由 main 的 `publish.yml` 发布 `0.1.3`。本步骤不修改 Coda 的版本钉选或默认安装。
