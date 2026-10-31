#!/usr/bin/env node
// Standalone: download this file only. stdout is exclusively MCP while serving.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { mkdir, readFile, writeFile, rename, open, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const exec = promisify(execFile);
export const HOME = '/workspace/.coda-bot';
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const string = description => ({ type: 'string', description });
const anyObject = { type: 'object', additionalProperties: true };
const proxy = (name, description, properties = {}, required = []) => ({ name: `coda_${name}`, description,
  inputSchema: schema(properties, required), method: 'tool', tool: name });
export const TOOLS = [
  proxy('machines', '读取空间各机器的在线、版本、更新和运行告警，不开启轮次。'),
  proxy('machine_diagnostics', '读取指定机器的网络/客户端性能诊断。network 的 from/to 选择 Unix 毫秒时间范围的分钟样本（最多一天），否则 days/limit/client/verdict 筛选客户端探测；client-performance 只支持 days。',
    { machine: string('机器 ID 或唯一名字（来自 coda_machines）'), kind: { type: 'string', enum: ['network', 'client-performance'] },
      from: { type: 'number', minimum: 0, description: '网络分钟样本起点，Unix 毫秒数' },
      to: { type: 'number', minimum: 0, description: '网络分钟样本终点，Unix 毫秒数；默认当前时间' },
      days: { type: 'integer', minimum: 1, maximum: 30, description: '报告窗口；network 默认 3 天，client-performance 默认 7 天' },
      limit: { type: 'integer', minimum: 1, maximum: 500, default: 50, description: '网络探测报告条数' },
      client: string('网络客户端 ID：ios:<ID> 或 macos:<ID>'),
      verdict: { type: 'string', enum: ['ok', 'offline', 'internet_unreachable', 'server_unreachable', 'service_unavailable', 'ssh_failed', 'slow_network', 'slow_server'] } }, ['machine', 'kind']),
  { name: 'coda_telemetry', description: 'GET 已配置看板的 /api/ JSON。常用 /api/overview、/api/installations/<id>、/api/hangs/<id>、/api/events、/api/tags；query 为过滤参数。',
    inputSchema: schema({ path: string('/api/ 开头的只读路径'), query: anyObject }, ['path']), method: 'telemetry' },
  proxy('read_thread', '读取会话消息与工具摘要；完整工具结果用 coda_read_tool_call。', { reference: string('会话 ID 或 coda://threads/ 地址'), before: { type: 'integer' }, limit: { type: 'integer' }, historyVersion: { type: 'integer' }, tools: { type: 'boolean' } }, ['reference']),
  proxy('read_tool_call', '读取会话的一次工具调用及完整结果。', { reference: string('工具条目引用或 ID'), offset: { type: 'integer' }, maxBytes: { type: 'integer' } }, ['reference']),
  proxy('agents', '列出可用 Agent、模型及目录，用于创建独立会话。', { project: string('项目名称或 ID') }),
  proxy('status', '读取 Bot 当前会话状态；独立会话不会出现在 children 中，不能据此判断创建失败。要跟进独立会话请用 coda_read_thread，不要重复 new_session 或轮询。副作用工具的 turn 票据由适配器取得。'),
  proxy('workflow_status', '查看工作流运行的状态和失败证据。', { runId: string('工作流运行 ID 或 coda://workflow-runs/ 地址'), project: string('项目名称或 ID') }),
  proxy('workflow_list', '列出项目的工作流程。', { project: string('项目名称或 ID') }),
  proxy('new_session', '像用户一样在目标目录开一个独立会话，每次要用户在 Coda 卡片上批准；不是你的子会话。立即返回请用户批准的回执，只会收到已开出/被拒绝/未能开出通知，工作结果不会推给你；记下会话引用，之后用 coda_read_thread 跟进，不要重复开同一任务。任务写清证据、重点代码路径、验收方式、按仓库惯例开 PR 并走完 PR 流程直到评审通过（含检查、交叉评审和自动评审评论）。GitHub 只读限制仅约束 Bot 自己，不要转述进任务或限制会话走 PR 流程。用户给了 Agent 链接（coda://agents/…）就原样填进 agent，不要拆成参数。',
    { project: string('目标目录名字或 ID；别的机器上的目录按 ID。agent 填的链接已带目录时可省'),
      agent: string('Agent ID（coda_agents 列出的），或用户给的 Agent 链接 coda://agents/…，原样照填：Coda 从链接取 Agent、机器、模型、强度、审批档位、目录与工作位置，链接写了的不要另写成不同的值'),
      prompt: string('证据、重点代码路径、验收方式；按仓库惯例提交、开 PR 并走 PR 流程直到评审通过'), title: string('会话标题'), model: string('模型'), effort: string('推理强度'),
      mode: string('独立会话的审批档位，codex 默认选择 agent；用户在卡片上批准'), options: anyObject,
      checkout: { type: 'string', enum: ['shared', 'worktree'], description: 'shared（默认）在目录本身工作；worktree 从默认分支新建工作树' } }, ['agent', 'prompt']),
  proxy('send', '给已有会话发消息，由 Coda 授权。明确回传委派结果时带 replyTo，直接唤醒原请求方，不建立反向等待。可能先返回「已提交」；不要轮询。', {
    childId: string('目标会话 ID 或引用（沿用 Coda 参数名，不表示子会话）；回传时用原委派附带的地址'), prompt: string('消息或回传正文'),
    replyTo: string('原委派附带的请求编号，只能回传给该请求的发起方'),
    final: { type: 'boolean', description: '仅回传时使用，默认 true 表示委派完成；约定的进展或需要对方处理的问题用 false' },
  }, ['childId', 'prompt']),
];

async function jsonPost(address, path, body, token, fetcher = fetch) {
  const base = new URL(address);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('入口必须是 HTTP(S) 基地址');
  const response = await fetcher(new URL(path, base), { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body), signal: AbortSignal.timeout(35 * 60_000) });
  const data = await response.json();
  if (data.error) throw Object.assign(new Error(data.error.message), { code: data.error.code });
  if (!response.ok) throw new Error(`Coda HTTP ${response.status}`);
  return data;
}
async function config(home) {
  try { return JSON.parse(await readFile(join(home, 'config.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { sessions: {} }; throw error; }
}
// Bind/config writes are serialized across Bots on the same cloud computer. A failed
// lock is actionable (never steal a possibly live writer's lock or lose another Bot).
export async function bind(address, code, { home = HOME, fetcher = fetch } = {}) {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const lock = await open(join(home, 'config.lock'), 'wx', 0o600).catch(error => { throw new Error(`绑定配置正在写入；请稍后重试。异常退出留下的 config.lock 须确认无 bind 进程后删除：${error.code}`); });
  try {
    const answer = await jsonPost(address, '/v1/remote-agent/bind', { code }, undefined, fetcher);
    if (typeof answer.token !== 'string' || !answer.token) throw new Error('绑定响应缺少 token');
    // hello confirms possession through the authenticated route; Coda's session
    // representation is deliberately opaque to this standalone client.
    const { result } = await jsonPost(address, '/v1/remote-agent', { method: 'hello', params: {} }, answer.token, fetcher);
    if (typeof result?.sessionId !== 'string') throw new Error('hello 缺少 sessionId');
    const saved = await config(home);
    saved.sessions[result.sessionId] = { address, token: answer.token, session: answer.session };
    const temporary = join(home, `config.${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, join(home, 'config.json'));
    return { sessionId: result.sessionId, message: '已绑定；token 已保存，未打印。' };
  } finally { await lock.close(); await rm(join(home, 'config.lock')); }
}
export async function call(method, params, { home = HOME, session, fetcher = fetch } = {}) {
  const saved = await config(home), ids = Object.keys(saved.sessions);
  const selected = session ?? (ids.length === 1 ? ids[0] : undefined);
  if (!selected || !Object.hasOwn(saved.sessions, selected)) throw new Error('请先 bind；有多个 Bot 时，mcp/call 命令须在末尾指定此 Bot 的会话 ID');
  const { address, token } = saved.sessions[selected];
  return (await jsonPost(address, '/v1/remote-agent', { method, params }, token, fetcher)).result;
}

// Backfill a missing snapshot without replacing an existing workspace identity.
// Recheck under the same lock as recovery: another Bot may have copied first.
const BACKUP = `set -eu
state="$1"
system_state="$2"
if [ ! -f "$state/tailscaled.state" ] && [ -f "$system_state/tailscaled.state" ]; then
  cp -p "$system_state/tailscaled.state" "$state/tailscaled.state.tmp"
  mv "$state/tailscaled.state.tmp" "$state/tailscaled.state"
fi
`;

// Only our private socket qualifies for the fast path: a system daemon may
// still be writing its identity to /var/lib, which disappears on cloud updates.
const RECOVER = `set -eu
state="$1"
system_state="$2"
socket="$state/tailscaled.sock"
if ! command -v tailscale >/dev/null 2>&1; then
  curl -fL https://tailscale.com/install.sh -o "$state/install.sh"
  sh "$state/install.sh" >&2
fi
ready() {
  info="$(tailscale --socket="$socket" status --json 2>/dev/null || true)"
  printf '%s' "$info" | grep -q '"BackendState"'
}
# Recheck under the lock, including a live daemon that still needs login.
if ready; then exit 0; fi
default_info="$(tailscale status --json 2>/dev/null || true)"
# Stop the service first so its restart policy cannot race the migration.
if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1 && systemctl cat tailscaled >/dev/null 2>&1; then
  systemctl stop tailscaled
fi
if pgrep -x tailscaled >/dev/null; then pkill -TERM -x tailscaled; fi
remaining=30
while pgrep -x tailscaled >/dev/null; do
  remaining=$((remaining - 1))
  if [ "$remaining" -eq 0 ]; then echo 'tailscaled did not stop; state not migrated' >&2; exit 1; fi
  sleep 1
done
# Copy after shutdown flushes state. Replace an old pre-login snapshot when
# the default daemon has since logged in, but preserve workspace identity after
# an OS update starts a fresh, logged-out system daemon.
if [ ! -f "$state/tailscaled.state" ] || printf '%s' "$default_info" | grep -q '"BackendState"[[:space:]]*:[[:space:]]*"Running"'; then
  if [ -d "$system_state" ]; then cp -a "$system_state/." "$state/"; fi
fi
chmod 700 "$state"
start-stop-daemon --start --background --exec "$(command -v tailscaled)" -- \
  --state="$state/tailscaled.state" --statedir="$state" --socket="$socket"
# Keep the lock until the new daemon answers; another Bot must not restart it.
remaining=30
until ready; do
  remaining=$((remaining - 1))
  if [ "$remaining" -eq 0 ]; then echo 'persistent tailscaled did not start' >&2; exit 1; fi
  sleep 1
done
`;
export async function net({ home = HOME, run = exec } = {}) {
  const state = join(home, 'tailscale'), socket = join(state, 'tailscaled.sock');
  const cli = ['-n', 'tailscale', `--socket=${socket}`];
  const connected = async () => {
    try { await run('sudo', ['-n', 'test', '-f', join(state, 'tailscaled.state')]); }
    catch (error) {
      if (error.code !== 1) throw error;
      await run('sudo', ['-n', 'mkdir', '-p', state]);
      await run('sudo', ['-n', 'chmod', '700', state]);
      await run('sudo', ['-n', 'flock', '--close', join(state, 'net.lock'), 'sh', '-c', BACKUP, 'coda-bot-backup', state, '/var/lib/tailscale'], { timeout: 10_000 });
    }
    return { connected: true };
  };
  const status = async () => {
    try { return JSON.parse((await run('sudo', [...cli, 'status', '--json'], { timeout: 10_000 })).stdout); }
    catch (error) { try { return JSON.parse(error.stdout); } catch { return null; } }
  };
  let info = await status();
  if (!info) {
    await run('sudo', ['-n', 'mkdir', '-p', state]);
    await run('sudo', ['-n', 'chmod', '700', state]);
    // --close prevents the daemon inheriting the recovery lock indefinitely.
    await run('sudo', ['-n', 'flock', '--close', join(state, 'net.lock'), 'sh', '-c', RECOVER, 'coda-bot-net', state, '/var/lib/tailscale'], { timeout: 180_000 });
    info = await status();
  }
  if (info?.BackendState === 'Running') return connected();
  let login = '';
  try { await run('sudo', [...cli, 'up', '--timeout=15s'], { timeout: 20_000 }); }
  catch (error) { login = `${error.stdout ?? ''}\n${error.stderr ?? ''}`.match(/https:\/\/login\.tailscale\.com\/[^\s]+/)?.[0] ?? ''; }
  info = await status();
  if (info?.BackendState === 'Running') return connected();
  throw new Error(info?.AuthURL || login ? `请打开 Tailscale 登录链接：${info?.AuthURL || login}；完成后重试 net。` : `Tailscale 未连接；检查 sudo tailscale --socket=${socket} status。`);
}

export function serveMcp({ input = process.stdin, output = process.stdout, ensureNet = () => net(), invoke = (method, params) => call(method, params) } = {}) {
  const send = message => output.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  // Serializing tools also serializes daemon recovery within this MCP process.
  let queue = Promise.resolve();
  const lines = createInterface({ input });
  const handle = async ({ method, params = {} }) => {
    if (method === 'initialize') return { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'coda-bot', version: '0.1.0' } };
    if (method === 'ping') return {};
    if (method === 'tools/list') return { tools: TOOLS.map(({ method: _method, tool: _tool, ...definition }) => definition) };
    if (method !== 'tools/call') throw Object.assign(new Error('Method not found'), { code: -32601 });
    const tool = TOOLS.find(tool => tool.name === params.name);
    if (!tool) throw Object.assign(new Error('Unknown tool'), { code: -32602 });
    try {
      await ensureNet();
      const args = params.arguments ?? {};
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('arguments 必须是对象');
      for (const key of tool.inputSchema.required) if (!(key in args)) throw new Error(`缺少参数 ${key}`);
      const result = await invoke(tool.method, tool.tool ? { name: tool.tool, arguments: args } : args);
      // MCP tool results from Coda retain their content and isError flag.
      return tool.tool && Array.isArray(result?.content) ? result : { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
  };
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { send({ id: null, error: { code: -32700, message: 'Parse error' } }); return; }
    if (!message || message.id === undefined) return;
    const reply = async () => {
      try { send({ id: message.id, result: await handle(message) }); }
      catch (error) { send({ id: message.id, error: { code: error.code ?? -32603, message: error.message } }); }
    };
    if (message.method === 'tools/call') queue = queue.then(reply);
    else void reply();
  });
  return lines;
}

export async function main(args) {
  const [command, ...rest] = args;
  if (command === 'net') return console.log(JSON.stringify(await net()));
  if (command === 'bind' && rest.length === 2) return console.log(JSON.stringify(await bind(...rest)));
  if (command === 'call' && rest.length >= 2) return console.log(JSON.stringify(await call(rest[0], JSON.parse(rest[1]), { session: rest[2] })));
  if (command === 'mcp') {
    serveMcp({ invoke: (method, params) => call(method, params, { session: rest[0] }) });
    process.stdin.on('end', () => process.exit(0));
    return;
  }
  throw new Error('用法：coda-bot.mjs net | bind <address> <code> | mcp [sessionId] | call <method> <json> [sessionId]');
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
