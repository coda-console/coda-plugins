# Token 消耗榜

看本机的 Token 用量，并可选地和好友比一比。**分享默认关闭。**

## 权限

只申请最小权限，不申请 `manage`：

- `coda/usage@1` `read`：读本机按十分钟、Agent、模型汇总的 Token 数与回合数（不含会话、目录、正文、费用）。
- `coda/accord@1` `read`：读本机的 Accord 身份、好友列表，以及好友发来的 `coda/token-usage` 与 `profile` 记录。
- `coda/accord@1` `publish`：只在开启分享后，发布本机的 `coda/token-usage` 记录。

## 分享什么

设置「向好友分享用量」打开后，每 10 分钟发布最近 7 天的每日记录（audience `public`，即你的好友）：

- 记录 `kind: coda/token-usage`，`id: <UTC 日期>/<sourceId>`，`sourceId` 是这台机器的随机 UUID（存在插件状态目录 `source.json`），不含机器名。
- 记录体 `{ blocks: { "HH:MM": { [agent]: { [model]: { input, output, cacheRead, cacheWrite, turns, reportedTurns } } } } }`，只写有用量的十分钟块。
- 内容没变就不重发（按内容 hash）。关闭分享或点「撤回已发布的记录」，会把本机发布过的记录以 `audience: []` 重发，好友不再看得到。

## 看什么

页面（资源页里的「Token 消耗榜」）：时间范围（今天 / 近 7 天 / 近 30 天），本机概览，和熟人消耗榜（可展开看分模型明细）。
好友昵称和头像取自好友插件可选发布的 `profile` 记录（`{ name?, emoji?, color? }`）；没有名片就显示密钥前 8 位。外来文字只当展示数据，去掉控制字符并截断。

用量不会推送，所以页面每分钟刷新一次，好友表或好友的新记录到达时（`coda/accord@1` 变动）也会立即刷新。
页面上切的分享开关只在设置没再改动之前有效；在设置里改了分享开关，以设置为准。
