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

## 额度面板

资源页的「Magpie 额度」列出 Magpie 手里的每个订阅、套餐和余额，一个一张卡片（Coda 自己面板里也有的 Codex、Grok 等也列）：
每个额度窗口一条剩余进度条，写厂商自己的计数（如 `500 / 2000`）或已用百分比和重置时间；有余额、可用重置次数的各一行；读不出来的写原因。
数据来自网关的 `GET /v1/magpie/quotas`，打开资源页时读，一分钟内再打开沿用上次的。网关没有应答时这块面板显示读取失败。
面板在跑 Magpie 的那台机器上；空间里别的机器用的是同一个 Magpie，看那台的就行。

## 安装

「设置 › 插件」的市场里选「Magpie」安装。插件的设置动作（`scripts/setup.mjs`）在你安装、更新插件或改了它的设置时于每台机器上运行：

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
