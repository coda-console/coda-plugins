// The account bridge: what codex-acp runs as its Codex (`CODEX_PATH`, set by entry.mjs) when「多账号」is on (the setting
// `codex.multipleAccounts`). Between codex-acp and the real app-server, it signs the app-server in to the managed account
// chosen (scripts/manager.mjs, the source), by handing it that account's tokens; they stay on this private pipe, below ACP and
// the session's journal. A source that says nothing is chosen (`null`) leaves Codex on this machine's own login.
// The choice takes effect where nothing is under way: as a session starts and between turns (the native thread and turn
// entry points ask the source each time). A turn whose account cannot be taken fails and says why, rather than going out
// on the one before; one under way finishes on the account it began with.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppServer } from '../scripts/app-server.mjs';
import { chosen, tokens } from '../scripts/manager.mjs';
import { readLines } from './lines.mjs';

// The managed accounts, read anew each time they are asked, so a switch on the resources page reaches the session at its
// next boundary. `refresh: true` asks for a rejected access token to be renewed, even before its expiry.
const managed = { selected: () => chosen(), tokens: (account, { refresh = false } = {}) => tokens(account, undefined, { refresh }), close() {} };

class AccountError extends Error {}
const failed = (account, error) => new AccountError(`没能换到所选的 Codex 账号${account ? ` ${account.name}` : ''}：${error?.message || '凭据不可用'}。去「资源」重新选择或登录`);

export function startAccountBridge({ source = managed, makeServer = options => new AppServer(options), input = process.stdin,
  output = value => process.stdout.write(`${JSON.stringify(value)}\n`) } = {}) {
  let initialized = false, initializeId, applied = null, accountId = null, problem = null, queue = Promise.resolve(), closing = false;
  const active = new Map(), starting = new Map();
  const schedule = work => { const next = queue.then(work); queue = next.catch(() => {}); return next; };
  async function login(tokens) {
    await server.request('account/login/start', { type: 'chatgptAuthTokens', ...tokens });
    const { account, workspaceRouting } = await server.request('account/read', { refreshToken: false });
    if (account?.type !== 'chatgpt' || workspaceRouting?.chatgptAccountId !== tokens.chatgptAccountId) throw new Error('Codex 登录后的账号与所选的不符');
  }
  // Signs in to the chosen account when nothing is under way; with a turn under way, the next boundary does.
  async function synchronize() {
    if (!initialized || closing) return null;
    let selected;
    try { selected = await source.selected(); } catch (error) { problem = failed(null, error); throw problem; }
    if (!selected || selected.id === applied?.id) { problem = null; return selected; }
    if (active.size || starting.size) return selected;
    try {
      const tokens = await source.tokens(selected.id);
      // Closed while they were read, the server is gone: a request made of it now would wait out its timeout for nobody.
      if (closing) return selected;
      // Once login begins a failed one means the actual account is unknown.
      applied = null; accountId = null;
      await login(tokens);
      applied = selected; accountId = tokens.chatgptAccountId; problem = null;
      return selected;
    } catch (error) { problem = failed(selected, error); throw problem; }
  }
  const server = makeServer({ onMessage: message => {
    // codex-acp 1.12 does not send an initialized notification. The successful
    // initialize response is the boundary, before its first account/read.
    if (!message.method && message.id === initializeId && !message.error) {
      initialized = true; server.send({ method: 'initialized' });
      void schedule(synchronize).catch(() => {});
    }
    if (message.method === 'account/chatgptAuthTokens/refresh' && message.id != null) {
      // The source may have renewed the tokens since login. Never answer a request of account A with account B's.
      const account = applied;
      void (async () => {
        try {
          if (!account || (message.params?.previousAccountId && message.params.previousAccountId !== accountId)) throw new Error('当前没有 Coda 交给 Codex 的账号');
          const tokens = await source.tokens(account.id, { refresh: true });
          if (closing) return;
          if (tokens.chatgptAccountId !== accountId) throw new Error('账号来源给的凭据属于另一个账号');
          server.send({ id: message.id, result: tokens });
        } catch (error) { if (!closing) server.send({ id: message.id, error: { code: -32000, message: failed(account, error).message } }); }
      })(); return;
    }
    if (starting.has(message.id) && !message.method) {
      const start = starting.get(message.id), turnId = message.result?.turn?.id;
      starting.delete(message.id);
      // Completion may overtake the request's response. Remember it only for
      // outstanding starts, so late responses neither revive work nor grow a history.
      if (!message.error && typeof turnId === 'string' && !start.completed.has(turnId)) {
        if (!active.has(start.threadId)) active.set(start.threadId, turnId);
      } else void schedule(synchronize).catch(() => {});
    }
    if (message.method === 'turn/started') active.set(message.params.threadId, message.params.turn.id);
    if (message.method === 'turn/completed') {
      const { threadId, turn } = message.params;
      for (const start of starting.values()) if (start.threadId === threadId) start.completed.add(turn.id);
      if (active.get(threadId) === turn.id) active.delete(threadId);
      void schedule(synchronize).catch(() => {});
    }
    output(message);
  } });
  const reader = readLines(input);
  reader.on('line', line => {
    let message; try { message = JSON.parse(line); } catch { return; }
    void schedule(async () => {
      // A request that finds the bridge closed, or that it closes on, is neither sent on nor answered: its client is gone.
      if (closing) return;
      if (message.method === 'initialize') {
        initializeId = message.id;
        message.params.capabilities = { ...message.params.capabilities, experimentalApi: true };
      }
      if (message.method === 'initialized') return;
      // Account reads during ACP startup and all native thread and turn entry points take the chosen account;
      // one that could not be taken never sends on the one before.
      if (['account/read', 'thread/start', 'thread/resume', 'thread/fork', 'turn/start'].includes(message.method)) {
        const selected = await synchronize();
        if (closing) return;
        if (message.method === 'turn/start') {
          if (selected && (problem || !applied || (applied.id !== selected.id && !active.size && !starting.size))) throw problem ?? failed(selected);
          starting.set(message.id, { threadId: message.params.threadId, completed: new Set() });
        }
      }
      // ACP's own login and logout would overwrite what the source gave, or this machine's login under it.
      if (applied && ['account/login/start', 'account/logout'].includes(message.method)) throw new AccountError('Coda 正在为 Codex 选用账号，在「资源」里切换');
      server.send(message);
    }).catch(error => {
      if (message.id != null) output({ id: message.id, error: { code: -32000, message: error instanceof AccountError ? error.message : failed(null, error).message } });
    });
  });
  async function close() { if (closing) return; closing = true; reader.close(); source.close(); await server.close(); }
  reader.on('close', () => void close());
  // `exit` is how the app-server ended, `{ code, signal, error? }`, when nothing here closed it: its process died. When the
  // bridge was closed first (its client went away, or it was told to stop), the server ending is the close, and it is null.
  let settleExit;
  const exit = new Promise(resolve => { settleExit = resolve; });
  void server.exited.then(result => { settleExit(closing ? null : result ?? { code: 0, signal: null }); void close(); });
  return { close, server, settled: () => queue, exit };
}

// The bridge as a process: it ends as the app-server under it ended, by the same signal or with the same exit code, so what
// runs it (codex-acp, and Coda's exit patch there) sees how the Codex died rather than a clean exit.
export function runAccountBridge(options) {
  const bridge = startAccountBridge(options);
  const signals = ['SIGTERM', 'SIGINT'], stop = () => void bridge.close();
  for (const signal of signals) process.on(signal, stop);
  void bridge.exit.then(async result => {
    if (!result) return;
    await bridge.close();
    if (result.error) process.stderr.write(`Codex 无法启动：${result.error.code || result.error.message}\n`);
    if (result.signal) {
      for (const signal of signals) process.off(signal, stop);
      // The managed accounts' locks (proper-lockfile, through signal-exit) listen for it too and would end the process with
      // the exit code instead; a lock left behind is taken over once stale.
      process.removeAllListeners(result.signal);
      process.exitCode = 1;
      process.kill(process.pid, result.signal);
    } else process.exit(result.code ?? 1);
  });
  return bridge;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runAccountBridge();
