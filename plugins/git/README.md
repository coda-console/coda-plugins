# Git 源

`@coda-console/git` 提供本机 Git 源登记和只读 Git smart HTTP。需要系统 Git（支持 protocol v2、`--path-format=absolute`）及 API Level 14 的 Coda。不接收机器 ID、机器列表或空间配置，不依赖 host，不改变执行／部署准入。

0.9.0（接口破坏性变更）：取源码改走记录的流。`git/source@1` 加流 `transport`（`http` 形状，子协议 `git-smart-http/2`）和权限组 `fetch`（「读取 Git 源和它的代码」）；`status.url` 换成 `/v1/records/git%2Fsource%401/<记录 ID>/streams/transport`，在哪台都用本机 Coda 后端的这个相对地址，跨机由记录的流按目录找到持有端。服务 `repository` 只留本机的管理入口（地址不变），不再有 `/repos/<记录 ID>`。谁能读由 Coda 判，插件不再另判。已登记的源不用重新登记：启动时逐个重新核对，`status.url` 随之换新。需要 API Level 14 的 Coda（coda#2966）。

0.7.0（接口破坏性变更）：`sources.json` 改为登记的源的正本，插件是它的唯一写者，不再用 `coda.watch` 读回自己写的记录，也就没有了防回声的那一套（记录 ID 表、同 spec 比较、过时核对、写被拒后的补救）。启动时读文件，直接 `coda.replace` 整份给出；登记、删除都先写文件，再 `coda.replace`；核对出的 status 用 `coda.put` 写。管理入口的 GET 读到的是 `{ id, key, spec, status }`。**升级到 0.7.0 后要重新登记源**：已登记的源原先只在 Coda 的记录里，文件里没有，新版第一次启动是空的，启动时的 `replace` 会把它们全部删掉；文件带 `"version": 2` 才认；不带的（旧格式，名字 → 仓库身份，包括登记名恰好叫 `sources` 的）一律当作没有源，不迁移。须先装带「H4 之后的结构减负」的新 Coda，旧 Coda 不行。只给预览渠道。

`sources.json` 的格式（状态目录里，0600，整份原子写）：

```json
{ "version": 2, "sources": { "<名字>": { "spec": { "name": "<名字>", "path": "<登记的绝对路径>" }, "identity": { "path": "…", "gitDir": "…", "commonDir": "…" } } } }
```

`spec` 即记录的 spec；`identity` 是源首次可用时固定的解析后的工作副本、Git 目录及公共目录，还没就绪过的源没有这一项。记录 ID、status 不存文件：ID 由 `replace` 回给插件，status 由每次核对写。

0.6.0（接口破坏性变更）：记录的读写换成 Coda 的新接口（`coda.put`、`delete`、`watch`），不再用 `protocols.put`、`setStatus`、`publish`、`observe`、`control`，也不再有 `revision`、`instance`。管理入口去掉 `/sources/<名字>/publish`，POST 更新不再带 `revision`，GET 读到的是记录条目 `{ owner, location, id, local, spec, status, labels, version }`。插件写记录只给 key（源的名字），记录 ID 由宿主按后端、插件、种类和 key 派生；名字也写进 `spec.name`，读取地址变成 `/repos/<记录 ID>`；状态目录的 `sources.json` 改记「名字 → 固定的仓库身份」。启动时用 `coda.replace` 把现有带 key 的源整份给一次，旧版留下、不带 key 的源记录随之删掉；旧的 `sources.json` 当作没有，不迁移：已登记的源须重新登记。启动时先把现有的源都核对完，再开服务。插件只在新记录或 spec 变了时核对，自己写 status 的回声不再触发核对。只给预览渠道。

0.5.0 删掉工作副本快照：`git/snapshot@1`、`git/service@1` 及其 `snapshot` 操作、`snapshots.json` 账本和 `refs/coda/snapshots/` 引用的创建、回收与 HTTP 暴露，管理入口里的 `/snapshots` 路由一并去掉，这个插件只剩源登记和只读读取。只给预览渠道，正式版实例拿不到这一版。升级前已存在的 `refs/coda/snapshots/` 引用和状态目录里的 `snapshots.json` 不再被读取或清理，需要时自行删除。

## 对象与本机管理入口

协议名为 `git/source@1`，按 Coda 的协议格式写在插件清单的 `contributes.protocols` 里，并在 `contributes.protocolImplementations` 里声明实现。由插件保存本机正本（`sources.json`）；核对出的 status 与 spec 一起整份写（`coda.put`）。代码里的协议名见 `lib/definitions.mjs`。

| 协议 | spec | status |
| --- | --- | --- |
| `git/source@1` | `name`：登记名；`path`：工作副本根目录或裸仓库的本机绝对路径 | `ready`、`url`，失败时 `reason` |

源的名字使用 1–100 个字母、数字、`_`、`-`，管理入口按名字；名字就是记录的 key。插件只按 `sources.json` 里的名字认源；记录 ID 由宿主从名字派生，插件从 `replace` 的返回取回，只留在内存，不写进文件。源首次可用时会在 `sources.json` 里持久固定（随源记；源删除时一并撤销，同名再登记是新的源，ID 不变，重新固定）解析后的工作副本、Git 目录及公共目录。符号链接改指另一仓库时，源变为不可用，重启也不会自动接管新仓库；须删除源后重新登记。

只有 provider 可创建源。本机调用方用 HTTP 调服务 `repository` 的管理入口（JSON，64 KiB 上限）；入口只接受可信 `caller.local === true`，设备和后端身份不能提交路径。不要直接用另一个插件的 `coda.put` 创建本插件对象。

```http
POST /v1/plugins/git/services/repository/sources/project
Content-Type: application/json

{ "spec": { "path": "/absolute/repository" } }
```

创建成功回的是 `{ kind, id }`，`id` 是宿主给的记录 ID，此时已核对过一次，等 status.ready 再 fetch。GET `…/sources/<名字>` 读 `{ id, key, spec, status }`（`key` 即名字）。修改用同一路径 POST `{ spec }`，spec 只取 `path`；每次登记都重新核对，状态失败后先修正原因再登记同一路径即可。登记只核对这一个源，别的源不顺带重核。核对出的 status 写进宿主时被拒（`put` 失败），登记报错；首次登记的记录这时还没有 status，更新已有的源时宿主上留着旧的 status；重试同一个登记，或插件重启（启动时全部源重新核对）后补上。

POST `…/sources/<名字>/delete` 撤下源。源在空间里都看得到（记录不再有「只在本机」一说）；spec 里是本机路径。调用方不往本插件传机器参数。

## 只读 smart HTTP

源的代码在它的记录的流 `transport` 上（`coda.stream`，契约见 Coda 的 `docs/plugins.md`「记录的流」）。Git 地址是本机 Coda 后端地址加 `status.url`，即 `/v1/records/git%2Fsource%401/<记录 ID>/streams/transport`：

```sh
git -c protocol.version=2 fetch "<本机 Coda 后端地址><status.url>" refs/heads/main:refs/heads/main
```

- **鉴权**：带调用方已有的 Coda 鉴权，由 Coda 判谁能读；插件不另发 token、不开放匿名端口。别的插件要读，在清单的 `uses`（或 `optionalUses`）里写 `"git/source@1": ["fetch"]`，一次声明两样都有：读记录（`coda.get`、`list`、`watch`，从中现读 `status.url`）和取流；没声明的两样都不行。
- **跨机不用换地址**：源在空间里别的机器上，照样向本机后端的这个地址取，由 Coda 按目录送到持有端。

流的地址后面仅允许 GET `info/refs?service=git-upload-pack` 和 POST `git-upload-pack`，必须带 `Git-Protocol: version=2`；映射为 CGI `HTTP_GIT_PROTOCOL`。完整读入请求（最多 32 MiB、不接受压缩请求体），再送 `git http-backend`；输入写完才转发 CGI 响应头，响应 pack 按背压流式发送。客户端断开、插件停用时停止子进程（连同它起的）并删掉临时目录。

以 4xx、5xx 结束时，插件日志记一行 `[git http]`：状态码、拒绝原因（即回给对方的那句）、请求方法、源的记录 ID（路径不合规则时另记流后面的路径），以及请求头 `content-type`、`content-encoding`、`git-protocol` 的实际值（没有写「无」）。不记鉴权头、Cookie 和请求体；成功的请求不记；检查本身不变。

每次请求创建临时裸仓库视图，只挂原仓库对象库和 `refs/heads/*`；不暴露 tags、remote refs、`refs/coda/` 等其他内部 ref、配置和磁盘文件。请求的 want 还须是分支的提交或祖先；不允许凭已知 OID 读取不相关隐藏对象。receive-pack 始终拒绝，仓库自身的 receive-pack 配置无效。浅仓库会保留 shallow 边界；客户端需用 `fetch --update-shallow` 接受该边界，无法取得源本身没有的历史。

## 检查与发布

脚本级测试在 `test/plugins/git/`，使用真实 Git 与临时仓库、检查包的测试宿主（`host.serve`、`host.stream`）；`git fetch` 经一个本机 HTTP 替身，它把 `/v1/records/…/streams/transport/…` 的请求交给 `host.stream`。provider 测试的记录用同步的替身，登记、删除、启动都在调用返回时完成，不启动 Coda 后端。运行：

```sh
node --test 'test/plugins/git/*.test.mjs'
node bin/check.mjs plugins/git --manifest
node scripts/check-contract.mjs
```

真实 Coda 插件宿主与跨机取源码不能用脚本测试替代，装上后在真机验。新包首发依照仓库根 README「npm 发布」：维护者 `npm login` 后执行 bootstrap 配置信任，再由 main 的 `publish.yml` 发布 `0.2.0`。本步骤不修改 Coda 的版本钉选或默认安装。
