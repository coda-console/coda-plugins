#!/usr/bin/env node
// Standalone: download this file only. stdout is exclusively MCP while serving.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { mkdir, readFile, writeFile, rename, open, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const exec = promisify(execFile);
export const HOME = '/workspace/.coda-bot';
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const string = description => ({ type: 'string', description });
const turn = string('Webhook 的 turn；主动 say 返回 turn 后沿用它。过期轮次不得省略 turn 重试。');
const anyObject = { type: 'object', additionalProperties: true };
const proxy = (name, description, properties = {}, required = []) => ({ name: `coda_${name}`, description,
  inputSchema: schema({ ...properties, turn }, required), method: 'tool', tool: name });
export const TOOLS = [
  { name: 'coda_say', description: '向这个 Coda 会话汇报。处理 Webhook 必须带 turn；巡检发现问题才首次省略 turn，开启自主轮次，记下返回的 turn。没问题不调用。',
    inputSchema: schema({ text: string('给用户看的简明正文'), turn }, ['text']), method: 'say' },
  { name: 'coda_done', description: '本轮的最后一步：所有工具与审批返回后调用，结束回复。Webhook 与自主轮次都必须收尾；轮次已结束时不要重试说话。',
    inputSchema: schema({ turn }), method: 'done' },
  proxy('machines', '读取空间各机器的在线、版本、更新和运行告警，不开启轮次。'),
  proxy('machine_diagnostics', '读取指定机器的网络/客户端性能诊断：分钟样本、事件循环和请求延迟、客户端探测结论。额外过滤参数放 options。',
    { machine: string('机器 ID'), kind: { type: 'string', enum: ['network', 'client-performance'] }, from: string('起点 ISO 时间'), to: string('终点 ISO 时间'), days: { type: 'number' }, options: anyObject }, ['machine', 'kind']),
  { name: 'coda_telemetry', description: 'GET 已配置看板的 /api/ JSON。常用 /api/overview、/api/installations/<id>、/api/hangs/<id>、/api/events、/api/tags；query 为过滤参数。',
    inputSchema: schema({ path: string('/api/ 开头的只读路径'), query: anyObject, turn }, ['path']), method: 'telemetry' },
  proxy('read_thread', '读取会话消息与工具摘要；完整工具结果用 coda_read_tool_call。', { reference: string('会话 ID 或 coda://threads/ 地址'), before: { type: 'integer' }, limit: { type: 'integer' }, historyVersion: { type: 'integer' }, tools: { type: 'boolean' } }, ['reference']),
  proxy('read_tool_call', '读取会话的一次工具调用及完整结果。', { reference: string('工具条目引用或 ID'), offset: { type: 'integer' }, maxBytes: { type: 'integer' } }, ['reference']),
  proxy('agents', '列出可派遣 Agent、模型及项目，用于选择修复任务的目录。', { project: string('项目名称或 ID') }),
  proxy('status', '读取本会话和子会话状态；副作用工具的 turn 票据由适配器内部取得，不要自行填写。', { childId: string('要读取结果的子会话') }),
  proxy('workflow_status', '查看工作流运行的状态和失败证据。', { runId: string('工作流运行 ID 或 coda://workflow-runs/ 地址'), project: string('项目名称或 ID') }),
  proxy('workflow_list', '列出项目的工作流程。', { project: string('项目名称或 ID') }),
  proxy('spawn', '在对应项目启动修复 Agent，必须等用户在 Coda 卡片批准；返回后由 Coda 把结果送回当前 Bot，不轮询。',
    { agent: string('Agent ID'), prompt: string('任务、证据、影响、重点检查项与验收条件'), title: string('任务标题'), project: string('目标项目名称或 ID'), model: string('模型'), effort: string('推理强度'), options: anyObject }, ['agent', 'prompt']),
  proxy('send', '给另一个 Coda 会话发后续任务；必须等用户在 Coda 卡片批准。', { childId: string('目标会话 ID 或引用'), prompt: string('消息正文') }, ['childId', 'prompt']),
  proxy('cancel', '请求停止子会话的任务；必须等用户在 Coda 卡片批准。', { childId: string('子会话 ID 或引用') }, ['childId']),
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
    return { sessionId: result.sessionId, instructions: result.instructions, message: '已绑定；token 已保存，未打印。' };
  } finally { await lock.close(); await rm(join(home, 'config.lock')); }
}
export async function call(method, params, { home = HOME, session, fetcher = fetch } = {}) {
  const saved = await config(home), ids = Object.keys(saved.sessions);
  const selected = session ?? (ids.length === 1 ? ids[0] : undefined);
  if (!selected || !Object.hasOwn(saved.sessions, selected)) throw new Error('请先 bind；有多个 Bot 时，mcp/call 命令须在末尾指定此 Bot 的会话 ID');
  const { address, token } = saved.sessions[selected];
  return (await jsonPost(address, '/v1/remote-agent', { method, params }, token, fetcher)).result;
}

// The fast path is one local status request, never an install/login per tool call.
// Recovery runs under flock: all Bots share the daemon and its persistent state.
const RECOVER = `set -eu
state="$1"
if ! command -v tailscale >/dev/null 2>&1; then
  curl -fL https://tailscale.com/install.sh -o "$state/install.sh"
  sh "$state/install.sh" >&2
fi
if [ ! -f "$state/tailscaled.state" ] && [ -d /var/lib/tailscale ]; then
  cp -a /var/lib/tailscale/. "$state/"
fi
if ! tailscale status --json >/dev/null 2>&1; then
  # status also returns nonzero while logged out; only start if no daemon exists.
  if ! pgrep -x tailscaled >/dev/null; then
    nohup tailscaled --state="$state/tailscaled.state" --statedir="$state" >"$state/daemon.log" 2>&1 < /dev/null &
  fi
fi
`;
export async function net({ home = HOME, run = exec, pause = delay } = {}) {
  const status = async () => {
    try { return JSON.parse((await run('sudo', ['-n', 'tailscale', 'status', '--json'], { timeout: 10_000 })).stdout); }
    catch (error) { try { return JSON.parse(error.stdout); } catch { return null; } }
  };
  let info = await status();
  if (info?.BackendState === 'Running') return { connected: true };
  const state = join(home, 'tailscale');
  await run('sudo', ['-n', 'mkdir', '-p', state]);
  await run('sudo', ['-n', 'chmod', '700', state]);
  await run('sudo', ['-n', 'flock', join(state, 'net.lock'), 'sh', '-c', RECOVER, 'coda-bot-net', state], { timeout: 180_000 });
  // Only recovery waits for the freshly spawned local daemon. Tests inject pause.
  for (let attempt = 0; attempt < 6; attempt++) {
    info = await status();
    if (info) break;
    await pause(100 * 2 ** attempt);
  }
  if (info?.BackendState === 'Running') return { connected: true };
  let login = '';
  try { await run('sudo', ['-n', 'tailscale', 'up', '--timeout=15s'], { timeout: 20_000 }); }
  catch (error) { login = `${error.stdout ?? ''}\n${error.stderr ?? ''}`.match(/https:\/\/login\.tailscale\.com\/[^\s]+/)?.[0] ?? ''; }
  info = await status();
  if (info?.BackendState === 'Running') return { connected: true };
  throw new Error(info?.AuthURL || login ? `请打开 Tailscale 登录链接：${info?.AuthURL || login}；完成后重试 net。` : 'Tailscale 未连接；检查 /workspace/.coda-bot/tailscale/daemon.log 与 sudo tailscale status。');
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
      const { turn: turnId, ...rest } = args;
      let forwarded = rest;
      if (tool.tool === 'machine_diagnostics') { const { options, ...fields } = rest; forwarded = { ...options, ...fields }; }
      const result = await invoke(tool.method, tool.tool ? { name: tool.tool, arguments: forwarded, ...(turnId === undefined ? {} : { turn: turnId }) } : args);
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
