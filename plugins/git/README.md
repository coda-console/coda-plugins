# Git 源

`@coda-console/git` 提供本机 Git 源登记和只读 Git smart HTTP。需要系统 Git（支持 protocol v2、`--path-format=absolute`）及包含 provider／流式服务接口、协议定义写在清单里、记录读写用 `coda.put`／`delete`／`get`／`list`／`watch` 的 Coda（coda#2080、#2079、#2176、#2749）。不接收机器 ID、机器列表或空间配置，不依赖 host，不改变执行／部署准入。

0.6.0（接口破坏性变更）：记录的读写换成 Coda 的新接口（`coda.put`、`delete`、`watch`），不再用 `protocols.put`、`setStatus`、`publish`、`observe`、`control`，也不再有 `revision`、`instance`。管理入口去掉 `/sources/<id>/publish`，POST 更新不再带 `revision`，GET 读到的是记录条目 `{ owner, location, id, local, spec, status, labels, version }`。源登记的固定身份改以源 ID 为键：升级后旧的状态文件（以实例为键）不再对得上，各源在第一次就绪时重新固定一次。只给预览渠道。

0.5.0 删掉工作副本快照：`git/snapshot@1`、`git/service@1` 及其 `snapshot` 操作、`snapshots.json` 账本和 `refs/coda/snapshots/` 引用的创建、回收与 HTTP 暴露，管理入口里的 `/snapshots` 路由一并去掉，这个插件只剩源登记和只读读取。只给预览渠道，正式版实例拿不到这一版。升级前已存在的 `refs/coda/snapshots/` 引用和状态目录里的 `snapshots.json` 不再被读取或清理，需要时自行删除。

## 对象与本机管理入口

协议名为 `git/source@1`，按 Coda 的协议格式写在插件清单的 `contributes.protocols` 里，并在 `contributes.protocolImplementations` 里声明实现。由插件保存本机正本；status 与 spec 一起整份写（`coda.put`），插件只对内容变了的 status 才写。代码里的协议名见 `lib/definitions.mjs`。

| 协议 | spec | status |
| --- | --- | --- |
| `git/source@1` | `path`：工作副本根目录或裸仓库的本机绝对路径 | `ready`、`url`，失败时 `reason` |

源 ID 使用 1–100 个字母、数字、`_`、`-`。源首次可用时会持久固定（以源 ID 记；源删除时撤销，同一 ID 再登记是新的源，重新固定）解析后的工作副本、Git 目录及公共目录。符号链接改指另一仓库时，源变为不可用，重启也不会自动接管新仓库；须删除源后重新登记。

只有 provider 可创建源。其他本机插件用 `coda.api` 调管理入口（JSON，64 KiB 上限）；入口只接受可信 `caller.local === true`，设备和后端身份只能读取 Git 数据，不能提交路径。不要直接用另一个插件的 `coda.put` 创建本插件对象。

```js
const base = 'plugins/git/services/repository';
await coda.api(`${base}/sources/project`, { spec: { path: '/absolute/repository' } });
const subscription = await coda.watch('git/source@1', event => {
  if (event.id === 'project' && event.entry?.status.ready) {
    // status.url 是本机服务相对路径。
  }
}, { scope: 'local' });
```

创建成功表示对象已接收；等 status.ready 再 fetch。GET `…/sources/<id>` 读记录条目。修改用同一路径 POST `{ spec }`（完整 spec）。状态失败后先修正原因再更新。

POST `…/sources/<id>/delete` 撤下源。源在空间里都看得到（记录不再有「只在本机」一说）；spec 里是本机路径，读取仍只经本机的鉴权入口。跨机引用与入口由空间 Provider 映射，调用方不往本插件传机器参数。

## 只读 smart HTTP

服务 `repository` 的 Git URL 为 `/v1/plugins/git/services/repository/repos/<source>`。由 Coda 先鉴权，再经流式通道交给插件；Coda 经 `/v1/services/space/machines/<owner>/v1/plugins/git/services/repository/` 到持有端（空间 Provider 的镜像入口），本插件只处理本机相对路径。使用已有 Coda 鉴权连接／代理入口，插件不另发 token、不开放匿名端口。

```sh
git -c protocol.version=2 fetch "$AUTHENTICATED_GIT_URL" refs/heads/main:refs/heads/main
```

仅允许 GET `info/refs?service=git-upload-pack` 和 POST `git-upload-pack`，必须带 `Git-Protocol: version=2`；映射为 CGI `HTTP_GIT_PROTOCOL`。完整读入请求（最多 32 MiB、不接受压缩请求体），再送 `git http-backend`；输入写完才转发 CGI 响应头，响应 pack 按背压流式发送。客户端断开、服务注销或宿主结束时停止子进程。

以 4xx、5xx 结束时，插件日志记一行 `[git http]`：状态码、拒绝原因（即回给对方的那句）、请求方法、路径里的源 id（路径不合规则时记原始路径），以及请求头 `content-type`、`content-encoding`、`git-protocol` 的实际值（没有写「无」）。不记鉴权头、Cookie 和请求体；成功的请求不记；检查本身不变。

每次请求创建临时裸仓库视图，只挂原仓库对象库和 `refs/heads/*`；不暴露 tags、remote refs、`refs/coda/` 等其他内部 ref、配置和磁盘文件。请求的 want 还须是分支的提交或祖先；不允许凭已知 OID 读取不相关隐藏对象。receive-pack 始终拒绝，仓库自身的 receive-pack 配置无效。浅仓库会保留 shallow 边界；客户端需用 `fetch --update-shallow` 接受该边界，无法取得源本身没有的历史。

## 检查与发布

脚本级测试在 `test/plugins/git/`，使用真实临时 Git 仓库与 Node HTTP；provider 测试使用同步的宿主 API／schema，显式送事件，不启动 Coda 后端。运行：

```sh
node --test 'test/plugins/git/*.test.mjs'
node bin/check.mjs plugins/git --manifest
node scripts/check-contract.mjs
```

真实 Coda 插件宿主、空间代理／tailnet／DERP 与运行器整合属于后续步骤，不能用脚本测试替代。新包首发依照仓库根 README「npm 发布」：维护者 `npm login` 后执行 bootstrap 配置信任，再由 main 的 `publish.yml` 发布 `0.2.0`。本步骤不修改 Coda 的版本钉选或默认安装。
