// Agent 插件单测用的辅助：像 Coda 的会话宿主那样启动 Agent（`sh -c`、独立进程组、标准输入输出每行一条 JSON-RPC），
// Coda 在 `initialize` 里给出的能力、会话指令的包装、插件环境的清理，以及 ACP 的 schema 校验（来自 SDK）。
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';

const STDERR_TAIL = 4096;

// 起过的进程组随测试进程一起结束。
const groups = new Set();
process.on('exit', () => { for (const pid of groups) try { process.kill(-pid, 'SIGKILL'); } catch {} });

export class AgentProcess {
  // `onMessage(message)`：Agent 发来的每条请求和通知，按序。`onNoise(line, why)`：Coda 会丢掉的行。
  constructor({ command, cwd, env, onMessage = () => {}, onNoise = () => {} }) {
    this.generation = randomBytes(3).toString('hex'); this.next = 0; this.pending = new Map(); this.stderr = '';
    this.child = spawn('/bin/sh', ['-c', command], { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const pid = this.child.pid;
    if (pid) groups.add(pid);
    this.child.stdin.on('error', () => {});
    this.child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk).slice(-STDERR_TAIL); });
    this.exit = null;
    this.exited = new Promise(resolve => {
      this.child.on('error', error => { this.exit ??= { code: null, signal: null, error: error.message }; resolve(this.exit); });
      this.child.on('exit', (code, signal) => { this.exit ??= { code, signal }; resolve(this.exit); });
    });
    // 它退出前写的先读完：输出在它退出后关闭，留有子进程占着管道时稍后关闭。
    const drained = new Promise(resolve => this.child.on('close', resolve));
    this.exited.then(() => Promise.race([drained, new Promise(resolve => setTimeout(resolve, 200))])).then(() => {
      for (const { reject } of this.pending.values()) reject(new Exited(this.exit, this.lastWords()));
      this.pending.clear();
    });
    createInterface({ input: this.child.stdout }).on('line', line => {
      if (!line.trim()) return;
      let message;
      try { message = JSON.parse(line); } catch { onNoise(line, 'not-json'); return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) { onNoise(line, 'not-object'); return; }
      if ('id' in message && !('method' in message)) {
        const waiter = this.pending.get(message.id);
        if (waiter) { this.pending.delete(message.id); waiter.resolve(message); }
        return;
      }
      onMessage(message);
    });
  }
  get pid() { return this.child.pid; }
  write(message) { if (!this.exit && this.child.stdin.writable) this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`); }
  // Agent 的完整答复，`{ result }` 或 `{ error }`；超时或进程退出则拒绝。`onReply` 在读到答复时、读下一行前运行。
  request(method, params, { timeout, id = `${this.generation}-${this.next++}`, onReply } = {}) {
    return new Promise((resolve, reject) => {
      let timer;
      this.pending.set(id, { resolve: m => { clearTimeout(timer); onReply?.(m); resolve(m); }, reject: e => { clearTimeout(timer); reject(e); } });
      if (timeout) timer = setTimeout(() => { this.pending.delete(id); reject(new Timeout(method, timeout)); }, timeout);
      if (this.exit) { this.pending.delete(id); clearTimeout(timer); reject(new Exited(this.exit, this.lastWords())); return; }
      this.write({ id, method, params });
    });
  }
  notify(method, params) { this.write({ method, params }); }
  respond(id, result) { this.write({ id, result }); }
  respondError(id, code, message) { this.write({ id, error: { code, message } }); }
  // 从 `start` 起多久退出，超过 `limit` 为 null。
  async exitWithin(limit, start = Date.now()) {
    let timer;
    const done = await Promise.race([this.exited, new Promise(resolve => { timer = setTimeout(resolve, limit, null); })]);
    clearTimeout(timer);
    return done ? Date.now() - start : null;
  }
  // 关闭标准输入；多久退出，超过 `limit` 为 null。
  closeInput(limit) { this.child.stdin.end(); return this.exitWithin(limit); }
  // Coda 的会话宿主停它的办法：对进程组发 SIGTERM。多久退出，超过 `limit` 为 null。
  terminate(limit) { this.signal('SIGTERM'); return this.exitWithin(limit); }
  signal(name) { try { process.kill(-this.child.pid, name); } catch {} }
  // 进程组里剩下的都结束。
  kill() { this.signal('SIGKILL'); groups.delete(this.child.pid); }
  lastWords() { return this.stderr.split('\n').map(l => l.trim()).filter(Boolean).at(-1)?.slice(0, 300) ?? ''; }
}

export class Timeout extends Error {
  constructor(method, ms) { super(`${method} ${ms / 1000} 秒没有答复`); this.ms = ms; }
}
export class Exited extends Error {
  constructor(exit, words) {
    super(`进程退出了（${exit.error ?? (exit.signal ? `信号 ${exit.signal}` : `退出码 ${exit.code}`)}）${words ? `：${words}` : ''}`);
    this.exit = exit;
  }
}

// Coda 在 `initialize` 里给 Agent 的能力。
export const clientCapabilities = () => ({
  elicitation: { form: {}, url: {} },
  session: { compaction: {}, configOptions: { boolean: {} } },
  _meta: { coda: { waits: {}, remote: {}, unrecognized: {} } },
});

// 会话指令在没有 `systemPrompt` 入口时，随新会话的第一条非命令提示词发出的文本块。
export const instructionsBlock = text => ({ type: 'text', text: '<coda-session-instructions>\n'
  + 'Instructions from Coda, the client this session runs in, for the whole session. They are not part of the user\'s message.\n\n'
  + `${text}\n</coda-session-instructions>\n` });

// 插件的进程继承的环境，去掉 Coda 给某个插件的变量，以及会话和令牌的变量：它们只属于被启动的进程自己。
const OWN = ['CODA_NODE', 'CODA_ARBITER', 'CODA_PLUGIN_PATH', 'CODA_PLUGIN_STATE', 'CODA_PLUGIN_SETTINGS', 'CODA_PLUGIN_SECRETS',
  'CODA_PLUGIN_DEPENDENCIES', 'CODA_MODEL_PROVIDERS', 'CODA_USER_PATH', 'CODA_THREAD_ID', 'CODA_TOKEN'];
export const cleared = base => Object.fromEntries(Object.entries(base).filter(([name]) => !OWN.includes(name)));

// ACP 自己的解析器，来自测试用的 SDK 版本：它的 zod schema 不按名导出，从稳定 v1 的文件里读。
const sdk = import.meta.resolve('@agentclientprotocol/sdk');
export const schemas = await import(new URL('../schema/zod.gen.js', sdk));

// 一行说明一个值为什么不合 schema。联合（会话更新有多种）指明它想对的那一支：`sessionUpdate` 对上的那支。
export function explain(error, value) {
  let issue = error.issues[0], path = [];
  while (issue?.code === 'invalid_union' && issue.errors?.length) {
    path = [...path, ...issue.path];
    const matched = issue.errors.filter(branch => !branch.some(i => i.path.at(-1) === 'sessionUpdate'));
    if (!matched.length && path.at(-1) === 'update') return `update.sessionUpdate 不是 ACP 认识的类型：${JSON.stringify(value?.update?.sessionUpdate)}`;
    const best = (matched.length ? matched : issue.errors).reduce((a, b) => b.length < a.length ? b : a);
    issue = best[0];
  }
  return `${[...path, ...(issue?.path ?? [])].join('.') || '（整体）'}：${issue?.message ?? '不合 schema'}`;
}
