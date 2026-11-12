// The plugin's setup (`contributes.setup`), which Coda runs on each machine when the user installs or updates the plugin: it
// ends well once the machine can run the agent. Without an OpenCode CLI that runs, or with one older than MINIMUM, OpenCode's
// own installer (https://opencode.ai/v2/install, OpenCode 2's) puts the latest in ~/.opencode/bin, where the agent looks
// first, over an OpenCode 1 there, leaving the shell's configuration alone; a newer one is kept. Why the machine is not
// ready is said in one line on standard error.
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { opencodeBinary } from '../agent/binary.mjs';
import { CHECKED } from '../agent/shells.mjs';

// The release the entry was checked against: OpenCode 2, whose ACP says a model service's wait (retries.mjs), as OpenCode 1
// never does, sitting out a Retry-After of any length in silence. It reports the current model, loads a session in a new
// process, and takes over OpenCode 1's sessions, under their IDs.
export const MINIMUM = CHECKED;
// The first x.y.z a version command prints; whether one is older than another.
export const versionIn = text => /(\d+)\.(\d+)\.(\d+)/.exec(text ?? '')?.slice(1).join('.') ?? null;
export function older(version, than) {
  const a = version.split('.').map(Number), b = than.split('.').map(Number), i = a.findIndex((n, k) => n !== b[k]);
  return i >= 0 && a[i] < b[i];
}
const asked = binary => spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });

// What the machine needs, given the CLI found (`binary`, null for none) and how its `--version` runs (`run`):
// `install`, `upgrade` or `none`, and why.
export function needed(binary, run = asked) {
  if (!binary) return { action: 'install', reason: '这台机器上没有 OpenCode CLI' };
  const ran = run(binary);
  if (ran.status !== 0) return { action: 'install', reason: `OpenCode CLI 无法运行（${binary}）` };
  const version = versionIn(`${ran.stdout ?? ''}\n${ran.stderr ?? ''}`);
  if (!version) return { action: 'upgrade', reason: `读不出 OpenCode CLI 的版本（${binary}）` };
  if (older(version, MINIMUM)) return { action: 'upgrade', reason: `OpenCode CLI ${version} 低于所需的 ${MINIMUM}` };
  return { action: 'none', version };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const before = needed(opencodeBinary());
  if (before.action !== 'none') {
    // What the installer prints goes to standard error with the rest of its story.
    const installed = spawnSync('bash', ['-c', 'set -o pipefail; curl -fsSL https://opencode.ai/v2/install | bash -s -- --no-modify-path'], { stdio: ['ignore', 2, 2] });
    if (installed.status !== 0) { console.error(`${before.reason}，安装失败（退出码 ${installed.status ?? installed.signal}）`); process.exit(1); }
  }
  const after = needed(opencodeBinary());
  if (after.action !== 'none') { console.error(after.reason); process.exit(1); }
  console.log(`OpenCode CLI ${after.version}`);
}
