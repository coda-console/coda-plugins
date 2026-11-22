# Token 消耗榜

看本机的 Token 用量，并可选地和好友比一比。**分享默认关闭。**

## 权限

只申请最小权限，不申请 `manage`：

- `coda/usage@1` `read`：读本机按十分钟、Agent、模型汇总的 Token 数与回合数（不含会话、目录、正文、费用）。
- `coda/machine@1` `read`：只读本机的机器 ID，当作稳定的来源 ID（不读机器名等其他信息）。
- `coda/accord@1` `read`：读本机的 Accord 身份、好友列表，以及好友发来的 `coda/token-day`、`coda/token-today`、旧版 `coda/token-usage` 与 `profile` 记录。
- `coda/accord@1` `publish`：只在开启分享后，发布本机的 `coda/token-day` 与 `coda/token-today` 记录。

## 分享什么

设置「向好友分享用量」打开后，每 10 分钟发布两种记录（audience `public`，即你的好友），内容没变就不重发（按内容 hash）：

- **月块日归档** `kind: coda/token-day`，`id: <sourceId>/<YYYY-MM>`，记录体 `{ v: 2, days: { "YYYY-MM-DD": { [agent]: { [model]: [input, output, cacheRead, cacheWrite, turns, reportedTurns] } } } }`，按 UTC 日汇总，发布最近约 30 天所在的月份。一个月超过 60 KiB 时拆成 `<YYYY-MM>-1`（1–15 日）与 `-2`（16–31 日），再超按周 `-w1`…`-w5`，最后合并小模型。
- **48 小时滚动曲线** `kind: coda/token-today`，`id: <sourceId>`，记录体 `{ v: 2, slotMs, windowStart, windowEnd, slots: { "<槽起点毫秒>": { [agent]: { [model]: [6 个数] } } } }`，默认 30 分钟一槽（超 60 KiB 降为 60 分钟一槽），每次覆盖同一条。
- `sourceId` 优先取 `coda/machine@1` 里本机的稳定机器 ID；读不到就沿用 `source.json` 里已有的（没有才生成一次随机 UUID），不会因为一时读不到换新 ID。从随机 UUID 换成机器 ID 后，旧 UUID 记在 `source.json` 的 `legacy`：榜单里不再把它名下的旧记录当成另一台机器，开启分享同步或撤回时也会把它留下的旧记录以 `audience: []` 撤回。
- 不含机器名、会话、目录、正文和费用。0.1.0 发布的 `coda/token-usage`（`<UTC 日期>/<sourceId>`）只做过渡期兼容读取与撤回：某台机器只要有新版记录，就不再读它的旧版记录，不会双计。
- 关闭分享或点「撤回已发布的记录」，会把本机发布过的记录以 `audience: []` 重发，好友不再看得到。

统计和发布互不阻塞：没有 Accord 身份、没建根身份、没开分享或 24 小时代签证书过期（发布报 `invalid_state`）时，本机统计、多机合并和当天曲线照常显示。证书过期时发布安静停下、不记已发布的 hash，续签后下一次同步自动补发期间没发出去的月块和 48 小时曲线，页面只显示一条轻提示。

## 看什么

页面（资源页里的「Token 消耗榜」）：时间范围（今天 / 近 7 天 / 近 30 天），本机概览，和熟人消耗榜（可展开看分模型明细）。同一 Accord 身份下的多台机器合并计入「我」；模块同时算好本地「今天」按 30 分钟切的合并曲线（`board.curve`）。
好友昵称和头像取自好友插件可选发布的 `profile` 记录（`{ name?, emoji?, color? }`）；没有名片就显示密钥前 8 位。外来文字只当展示数据，去掉控制字符并截断。

用量不会推送，所以页面每分钟刷新一次，好友表或好友的新记录到达时（`coda/accord@1` 变动）也会立即刷新。
页面上切的分享开关只在设置没再改动之前有效；在设置里改了分享开关，以设置为准。
