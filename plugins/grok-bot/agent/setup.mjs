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
读取并安装 /workspace/.coda-bot/SKILL.md 为此 Bot 的 Skill。
正常消息与回复走原生主会话，定时任务仍由 Grok Routine 执行。
升级旧 Bot：不再需要 Coda 消息（coda）Webhook Routine。保留 Coda 巡检（coda-2）定时 Routine；请先让我确认，再将旧指令中的 coda_input、coda_say、coda_done 改成「有发现就在对话里告诉用户」。更新脚本和 Skill 后重启 MCP。
这些工具只提供 Coda 数据和经卡片授权的操作，Bot 的正常回复会自动镜像到 Coda。`;
}
