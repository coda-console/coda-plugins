// Coda owns the login UI (the `sign-in` operation, sign-in.mjs, runs this). Codex prints the device link/code and owns OAuth. Each attempt has a private home;
// only a completed, checked login is committed to the plugin's store.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { codexCli } from './app-server.mjs';
import { accountEnv, fileCredentials } from './codex.mjs';
import { paths, prepare, list, saveLogin } from './manager.mjs';

let home, child, cancelled = false;
const cancel = () => { cancelled = true; child?.kill('SIGTERM'); };
process.on('SIGTERM', cancel); process.on('SIGINT', cancel);
try {
  const at = paths(); prepare(at); await list(at, { recoverImport: true });
  home = await mkdtemp(join(at.state, 'login-'));
  if (cancelled) throw new Error('登录已取消');
  const env = accountEnv(home);
  const code = await new Promise((resolve, reject) => {
    child = spawn(process.execPath, [codexCli(env), 'login', '--device-auth', ...fileCredentials], { env, cwd: home, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
    child.once('error', () => reject(new Error('无法启动 Codex 登录')));
    child.once('close', resolve);
  });
  child = null;
  if (cancelled || code !== 0) throw new Error(cancelled ? '登录已取消' : '登录未完成，请重试');
  await saveLogin(home, at, { isCancelled: () => cancelled });
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally {
  if (home) await rm(home, { recursive: true, force: true });
  process.off('SIGTERM', cancel); process.off('SIGINT', cancel);
}
