#!/usr/bin/env node
// Grok's own installer (the `install` operation of `coda/resource@1`; setup.mjs runs it too): the CLI goes to ~/.grok/bin, where
// the sessions look first. Without SHELL it leaves the shell's configuration alone, and with ~/.grok/bin first on the PATH it
// has nothing to link into ~/.local/bin. What it prints goes to standard error with the rest of its story. An installer that
// ends well is not enough: the install, the setup and the record's `installed` all ask `needed`, so it is done only once the
// CLI found runs, says its version, and that is no older than MINIMUM (the CLI whose `agent --no-leader stdio` and
// `_x.ai/yolo_mode_changed` the agent entry was checked against: 1.0.52).
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { grokBinary } from './ask.mjs';

export const MINIMUM = '1.0.52';
// The first x.y.z a version command prints; whether one is older than another.
export const versionIn = text => /(\d+)\.(\d+)\.(\d+)/.exec(text ?? '')?.slice(1).join('.') ?? null;
export function older(version, than) {
  const a = version.split('.').map(Number), b = than.split('.').map(Number), i = a.findIndex((n, k) => n !== b[k]);
  return i >= 0 && a[i] < b[i];
}
const asked = binary => spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });

// What the machine needs, given the CLI found (`binary`, null for none) and how its `--version` runs (`run`):
// `install`, `upgrade` or `none`, and why.
export function needed(binary = grokBinary(), run = asked) {
  if (!binary) return { action: 'install', reason: '这台机器上没有 Grok CLI' };
  const ran = run(binary);
  if (ran.status !== 0) return { action: 'install', reason: `Grok CLI 无法运行（${binary}）` };
  const version = versionIn(`${ran.stdout ?? ''}\n${ran.stderr ?? ''}`);
  if (!version) return { action: 'upgrade', reason: `读不出 Grok CLI 的版本（${binary}）` };
  if (older(version, MINIMUM)) return { action: 'upgrade', reason: `Grok CLI ${version} 低于所需的 ${MINIMUM}` };
  return { action: 'none', version };
}

export const install = () => spawnSync('bash', ['-c', 'set -o pipefail; curl -fsSL https://x.ai/cli/install.sh | bash'], { stdio: ['ignore', 2, 2],
  env: { ...process.env, SHELL: '', PATH: `${join(homedir(), '.grok/bin')}:${process.env.PATH ?? ''}` } });

// Installs, then asks `needed` of the CLI found: what it says, or why the installer failed.
export function installChecked() {
  const installed = install();
  if (installed.status !== 0) return { action: 'install', reason: `安装失败（退出码 ${installed.status ?? installed.signal}）` };
  const after = needed();
  return after.action === 'none' ? after : { ...after, reason: `安装后${after.reason}` };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const ready = installChecked();
  if (ready.action !== 'none') { console.error(ready.reason); process.exit(1); }
  console.log('{}');
}
