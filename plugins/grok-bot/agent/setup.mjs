const RAW = 'https://raw.githubusercontent.com/coda-console/coda-plugins/main/plugins/grok-bot/remote';
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
export function bindingGuide(sessionId, { code, expiresAt, addresses = [] }) {
  const address = addresses[0] ?? '<Coda 后端的 tailnet 地址>';
  return `请把下面这段话贴给这个 Grok Bot。绑定码有效至 <t:${expiresAt}>。${addresses.length ? `可用入口：${addresses.join('、')}` : '这台后端尚未提供远端入口地址，请先配置入口后重新发送消息获取绑定码。'}

---
请把自己连接到我的 Coda 长期会话 ${sessionId}。在你的 Debian 云电脑执行（文件必须保存在 /workspace）：

\`\`\`sh
mkdir -p /workspace/.coda-bot
curl -fL ${quote(`${RAW}/coda-bot.mjs`)} -o /workspace/.coda-bot/coda-bot.mjs
node /workspace/.coda-bot/coda-bot.mjs net
node /workspace/.coda-bot/coda-bot.mjs bind ${quote(address)} ${quote(code)}
curl -fL ${quote(`${RAW}/SKILL.md`)} -o /workspace/.coda-bot/SKILL.md
\`\`\`

net 若打印 Tailscale 登录链接，请让我完成登录，把云电脑加入能访问 Coda 后端的 tailnet；然后重新执行 bind。密钥需要时使用 Grok 的密钥卡片，不贴到聊天。

在 Bot 设置里添加命令启动的自定义 MCP 服务：\`node /workspace/.coda-bot/coda-bot.mjs mcp\`。同账号多个 Bot 共用云电脑时，每个 Bot 必须在命令末尾追加自己的会话 ID：\`${sessionId}\`，避免串用绑定。
读取并安装 /workspace/.coda-bot/SKILL.md 为此 Bot 的 Skill；bind 输出的会话指令也要遵守。
建立两个 Routine：一个 Webhook 触发，按请求 JSON 的 text 做事，保留 sessionId 与 turn，最后 coda_done；一个定时巡检，按 Skill 检查性能、稳定性与逻辑问题，没问题不说话。
把 Webhook 地址告诉我，key 经密钥卡片处理；我会把它们填到 Coda 插件 grok-bot.bots 表的同一行（行名为你的 Bot 名），并在会话「这是哪个 Bot」里选择这一行。Webhook 的 HTTP 200 只表示启动，最终答复须通过 coda_say / coda_done 送回 Coda。`;
}
