// The plugin's setup (`contributes.setup`), which Coda runs on each machine when the user installs or updates the plugin: it
// ends well once the machine can run the agent. Without a Cursor CLI that runs, Cursor's own installer
// (https://cursor.com/install) puts the latest in ~/.local/share/cursor-agent and links it in ~/.local/bin, where the agent
// looks first. No release is known to be too old for `cursor-agent acp`, and the CLI updates itself, so one that runs is
// kept as it is. Why the machine is not ready is said in one line on standard error.
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { join } from 'node:path';

function cursorBinary(env = process.env) {
  const installed = join(homedir(), '.local/bin/cursor-agent');
  if (existsSync(installed)) return installed;
  return (env.PATH ?? '').split(':').filter(Boolean).map(dir => join(dir, 'cursor-agent')).find(path => existsSync(path)) ?? null;
}

const asked = binary => spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });

// What the machine needs, given the CLI found (`binary`, null for none) and how its `--version` runs (`run`):
// `install` or `none`, and why.
export function needed(binary, run = asked) {
  if (!binary) return { action: 'install', reason: '这台机器上没有 Cursor CLI' };
  const ran = run(binary);
  if (ran.status !== 0) return { action: 'install', reason: `Cursor CLI 无法运行（${binary}）` };
  return { action: 'none', version: `${ran.stdout ?? ''}`.trim().split('\n')[0] };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const before = needed(cursorBinary());
  if (before.action !== 'none') {
    // What the installer prints goes to standard error with the rest of its story.
    const installed = spawnSync('bash', ['-c', 'set -o pipefail; curl https://cursor.com/install -fsS | bash'], { stdio: ['ignore', 2, 2] });
    if (installed.status !== 0) { console.error(`${before.reason}，安装失败（退出码 ${installed.status ?? installed.signal}）`); process.exit(1); }
  }
  const after = needed(cursorBinary());
  if (after.action !== 'none') { console.error(after.reason); process.exit(1); }
  console.log(`Cursor CLI ${after.version}`);
}
