# Magpie

把 [Magpie](https://github.com/yetone/magpie) 的本机网关作为 Coda 的[模型服务](https://github.com/coda-console/coda/blob/main/docs/plugins.md#模型服务)提供出来，
Pi 等选用模型服务的插件直接选它，不用填地址和 Key。Magpie 自己管 provider、订阅账号和路由组，额度用完时自动换下一个账号。

## 提供的模型服务

网关在 `127.0.0.1:3425`，只在本机监听，不要 Key（随便填什么都行）。它讲三种接口，各提供一个服务：

| 服务 | 接口 | 地址 |
| --- | --- | --- |
| `magpie/openai`（Magpie · OpenAI Chat） | `openai-completions` | `http://127.0.0.1:3425/v1` |
| `magpie/responses`（Magpie · OpenAI Responses） | `openai-responses` | `http://127.0.0.1:3425/v1` |
| `magpie/anthropic`（Magpie · Anthropic） | `anthropic-messages` | `http://127.0.0.1:3425` |

模型列表来自网关的 `/models`，模型 ID 写作 `<Magpie 的 provider>/<模型>`（如 `deepseek/deepseek-v4-pro`），路由组是 `group/<id>`。
接口之间的翻译（流式、工具调用、推理）由 Magpie 做，所以选哪个服务都能用全部模型；一般选 OpenAI Chat。

在 Pi 里用：「设置 › 插件 › Pi › Provider」添加一行（行名如 `magpie`），「来源」选「Magpie · OpenAI Chat」，地址和 Key 都不用填。

## 额度

资源页的「Magpie」列出 Magpie 手里的每个订阅、套餐和余额，一个一行，名字是服务加上它是谁的（别名，没有就是用户；Coda 别的插件也有的 Codex、Grok 等也列）：
每个额度窗口一个读数，同别的插件写「剩余 N%」和重置时间（窗口名写成「5 小时」「7 天」「月度」）；有余额、可用重置次数的各一个读数，合计至多 8 个；网关答了 200、但某个订阅读不出来（`data[].error`，如 OpenCode Zen 不让 API key 查余额）时，那一行照常列出，带单行的原因，其余订阅不受影响，命令照常退出 0。
数据来自网关的 `GET /v1/magpie/quotas`，由记录命令 `scripts/quotas.mjs` 读（`coda/resource@1`，不定时，资源页打开、点「刷新」时运行）。网关没有应答、答复不对或 20 秒内没读完时，命令以非零退出，原因写在标准错误的最后一行：Coda 保留上一份记录，资源页显示「更新失败：原因」，不会用一条只有错误的记录顶掉原来的额度。
它在跑 Magpie 的那台机器上；空间里别的机器用的是同一个 Magpie，看那台的就行。

## 同型号映射

经 Magpie 走的请求，用量里只有请求的模型 ID（如 `group/ds-flash`、`opencode-go/deepseek-v4.1-flash`），拿不到实际型号。
插件定义协议 `magpie/models@1`，本机一条记录，一个只读的安全查询 `names`（权限组 `read`），返回 `{ names: { "<请求的模型 ID>": "<底层型号名>" }, services: ["coda://<接口>/<UUID>"] }`，
别的插件（目前是 Token 消耗榜，写在它的 `optionalUses`）按它把同一个底层型号的请求并成一行。规则是确定的，不猜：

| 请求的模型 ID | 底层型号名 |
| --- | --- |
| `provider/model` | 你在 Magpie 里为它声明的同型号名（设置里的 `modelSameAs`，键是 `provider/model`）；没声明就是去掉第一段 provider 后剩下的全部，如 `opencode-go/deepseek-v4.1-flash` 是 `deepseek-v4.1-flash`；对端 Magpie 也是一个 provider，`rig/opencode-go/deepseek-v4.1-flash` 是 `opencode-go/deepseek-v4.1-flash`，要把它也当作 `deepseek-v4.1-flash`，须在 Magpie 里为它声明 |
| `auto/<名字>` | `<名字>`（Magpie 自己按同名或同型号声明建的组） |
| `group/<名字>`（你手建的组） | **所有成员的底层型号名都相同时**才归到那个名字；成员可以是普通成员，也可以是别的组（展开到底）。成员有任何不同、有展开不了的（不认识的组、`provider/*` 这样的通配、空组）或组里套了自己（有环），这个组不归并，保持自己的名字单独一行 |
| 其余 | 原样，不在结果里 |

手建组的成员可以带路由修饰，它们不是型号的一部分：`:fast`、推理强度（`:high`、`:low+high`）和账号（`#<账号>`）都先去掉再算（网关把它原样列为模型的 ID 除外，如模型自己带冒号）。
手建组里有一个「匹配不到任何模型」的模式（`provider/*` 之类），或 `magpie group show` 的输出不是 Magpie 打印的样子（读不懂就不猜），这个组不归并。
结果只含按规则能确定、且名字与请求的模型 ID 不同的项；不建全局型号表，不用厂商、目录或价格信息。

`services` 是**这台机器上**本机 Magpie 插件提供的那几个模型服务的资源引用（用量行里的 `service`）：映射只对走这些服务的请求有效。
空间里别台的 Magpie 有它自己的组和声明，A 机的 Agent 用 B 机的 Magpie 服务时，那些行的 `asked` 是 B 机 Magpie 里的名字，不能拿本机的映射去套。
引用向 Coda 问（`coda resources list <接口>`，再 `coda resources explain <引用>`，取 `ref` 是本插件的 `magpie/<id>`、来源是本机的），不自己推算资源 ID。

**怎样在 Magpie 里声明同型号**：在 Magpie 里为一个模型声明它「同于」哪个型号名，Magpie 把它存在 `settings.json` 的 `modelSameAs`（键是 `provider/model`，值是型号名）；
声明过的模型，不管在 `auto/` 组还是你手建的组里，都按这个名字算。手建组要归并，就让它的每个成员归到同一个名字：名字本来不同的成员（如带 `-free` 的、对端 Magpie 的 `rig/…`）声明成同一个即可。

数据来源（只读，不要 Magpie 的图形界面开着）：网关的 `GET /v1/models`（有哪些模型 ID）、`~/.config/magpie/settings.json` 的 `modelSameAs`、
`magpie group show group/<id>`（每个手建组的成员，运行时带 `MAGPIE_NO_ACCOUNTS=1`，让它不读 Agent 的登录）。
插件自己不打开存着 Key 的 `providers.json`，不读取也不输出任何 Key；读手建组成员是调用 Magpie 命令行完成的，命令行读它自己的配置、启动时做它自己的设置迁移，是 Magpie 本身的行为，和你平时运行它一样。
没装 Magpie、没启动、读不到，或整次读取（含读设置、运行命令）8 秒内没读完，返回空映射（不返回读到的一部分），不报错；`modelSameAs` 的格式读不懂就当没声明。
记录命令是 `scripts/models.mjs`，操作命令是 `scripts/names.mjs`，规则在 `scripts/same.mjs`。

## 安装

在「设置 › 插件」的商店里选「Magpie」安装。插件的设置动作（`scripts/setup.mjs`）在你安装、更新插件或改了它的设置时于每台机器上运行：

1. 网关已经在应答（开着 Magpie 的 App，或已有它的常驻服务），只按[设置](#设置)告诉 Magpie 读不读 Agent 的登录，别的不动。
2. 没有能运行的 `magpie`，用官方安装程序装上（`curl -fsSL https://usemagpie.ai/install.sh | sh`）：Mac 上把 magpie.app 放进 `/Applications`
   （不可写时 `~/Applications`），命令链接到 `~/.local/bin/magpie`；Linux 上只装命令。已有的不动，Magpie 自己会更新。
3. 按设置告诉 Magpie 读不读 Agent 的登录，再运行 `magpie daemon install`，把网关装成你自己的常驻服务（Mac 是 launchd 的 `com.yetone.magpie.serve`，Linux 是 `systemctl --user` 的 `magpie`），
   登录时启动、出错后重启；然后等网关应答。服务记住的 PATH 是 Coda 给 Coda 以外的程序的那份（`CODA_USER_PATH`，不含 Coda 自己的目录）：
   Magpie 会读 PATH 上每个目录找各家 CLI，由 launchd 启动的它去读 Coda 的目录时可能被 macOS 一直挂着，之后的请求就都卡住。

设置动作只认模型服务指向的 `127.0.0.1:3425`：后端的环境里设了指向别处的 `MAGPIE_ADDR`（magpie 和它装的服务都照它监听）时，设置动作直接报错，不安装。

provider 和账号在 Magpie 里加：Mac 打开 magpie.app，或在终端里 `magpie provider add …`、`magpie tui`。

## 设置

| 设置 | 默认 | 内容 |
| --- | --- | --- |
| `magpie.accountDiscovery`（读取 Agent 自己的登录） | 开 | 开着时 Magpie 读这台机器上 Codex（`~/.codex/auth.json` 与钥匙串）、Claude Code、Gemini、Copilot、Cursor 等自己的登录，把它们的订阅作为模型提供。关掉后一个都不读，只用在 Magpie 里以 API Key 添加的服务；它存下的登录副本留着，再打开就回来。Magpie 只有这一个总开关，不能只关某一家 |

它就是 Magpie 的「Settings › Privacy › Subscription accounts」（`magpie accounts discovery on|off`）。设置动作每次运行都按这里写进 Magpie，
所以以这里为准：在 Magpie 里改了，下次安装、更新或改这个设置时会被改回来。运行中的网关立即照新的来，不用重启。

卸载插件不会卸掉 Magpie 和它的服务；要去掉就 `magpie daemon uninstall`，再删 App 与 `~/.local/bin/magpie`。
