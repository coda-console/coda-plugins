// Questions to a Grok of its own over ACP, as its own clients ask them: the results of `_x.ai/...` extension methods, in
// order. One process answers them all, as starting it takes seconds; each is asked once the one before is answered, as an
// answer may change what the next one reads (a subscription check renews the login and fills in its name). `stop(results)`, given
// the answers so far (those not asked yet undefined), ends the asking at once when it says so, the rest never asked.
import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

// The installer puts the binary here whatever GROK_HOME says; the login lives in GROK_HOME. The same the agent runs.
export const grokHome = (env = process.env) => env.GROK_HOME || join(homedir(), '.grok');
// A file that can be run: a leftover that cannot is not the CLI, and does not hide the one further on the PATH.
const runnable = path => { try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; } };
export function grokBinary(env = process.env) {
  const installed = join(homedir(), '.grok/bin/grok');
  if (runnable(installed)) return installed;
  return (env.PATH ?? '').split(':').filter(Boolean).map(dir => join(dir, 'grok')).find(runnable) ?? null;
}

export function grokAsk(methods, { binary = grokBinary(), env = process.env, timeoutMs = 20000, stop } = {}) {
  if (!binary) return Promise.reject(new Error('这台机器上找不到 Grok CLI'));
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['agent', '--no-leader', 'stdio'], { cwd: tmpdir(), env, stdio: ['pipe', 'pipe', 'ignore'] });
    const results = new Map();
    let buffer = '', settled = false;
    const finish = (error, value) => {
      if (settled) return; settled = true; clearTimeout(timer); child.kill();
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('Grok 没有回答')), timeoutMs);
    const send = (id, method, params = {}) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    child.on('error', error => finish(error));
    child.on('close', () => finish(new Error('Grok 已退出')));
    child.stdout.on('data', chunk => {
      buffer += chunk;
      for (let i; (i = buffer.indexOf('\n')) >= 0;) {
        const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
        let message; try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1) send(2, methods[0]);
        else if (message.id === results.size + 2 && message.id < methods.length + 2) {
          if (message.error) return finish(new Error(String(message.error.message ?? 'Grok 返回错误')));
          results.set(message.id, message.result);
          const answers = methods.map((_, index) => results.get(index + 2));
          if (results.size === methods.length || stop?.(answers)) finish(null, answers);
          else send(results.size + 2, methods[results.size]);
        }
      }
    });
    child.stdin.on('error', () => {});
    send(1, 'initialize', { protocolVersion: 1, clientCapabilities: {} });
  });
}
