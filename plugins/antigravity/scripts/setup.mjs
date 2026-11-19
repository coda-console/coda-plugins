#!/usr/bin/env node
// The plugin's setup (`contributes.setup`), which Coda runs on each machine when the user installs or updates the plugin, and the
// `install` operation of `coda/resource@1` (「安装」 on the resource page): it ends well once the machine can run the agent.
// Without an Antigravity CLI, Google's installer puts the latest in ~/.local/bin, where the agent looks first; one older than MINIMUM (the CLI the `agy acp` entry was checked against: the
// subcommand is there from 1.5.0, Auto mode and keeping the mode from 1.5.4, context usage from 1.5.8) is brought up with its
// own `agy update`; a newer one is kept. The installer does nothing where ~/.local/bin/agy exists, so a CLI that does not run
// is never replaced: it is reported. Why the machine is not ready is said in one line on standard error; the result, when it is, is `{}`.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agyBinary, asked, older, versionOf } from './agy.mjs';

export const MINIMUM = '1.5.9';

// What the machine needs, given the CLI found (`binary`, null for none) and how its `--version` runs (`run`):
// `install`, `upgrade`, `broken` (found, but does not run) or `none`, and why.
export function needed(binary, run = asked) {
  if (!binary) return { action: 'install', reason: '这台机器上没有 Antigravity CLI' };
  const ran = run(binary);
  if (ran.status !== 0) return { action: 'broken', reason: `Antigravity CLI 无法运行（${binary}），请检查或删除后重试` };
  const version = versionOf(ran);
  if (!version) return { action: 'upgrade', reason: `读不出 Antigravity CLI 的版本（${binary}）` };
  if (older(version, MINIMUM)) return { action: 'upgrade', reason: `Antigravity CLI ${version} 低于所需的 ${MINIMUM}` };
  return { action: 'none', version };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const before = needed(agyBinary());
  if (before.action === 'broken') { console.error(before.reason); process.exit(1); }
  if (before.action !== 'none') {
    // What the installer or the update prints goes to standard error with the rest of its story. The installer ends with
    // `agy install`, which adds ~/.local/bin to the PATH of the shell profiles that exist and has no switch the installer
    // passes on (`--skip-path`): so it runs with a temporary directory as its HOME (its staging and profile edits go there,
    // and are removed) and `--dir` puts the binary in the real ~/.local/bin.
    let done;
    if (before.action === 'install') {
      const scratch = mkdtempSync(join(tmpdir(), 'coda-antigravity-'));
      try {
        done = spawnSync('bash', ['-c', 'set -o pipefail; curl -fsSL https://antigravity.google/cli/install.sh | bash -s -- --dir "$1"', 'bash', join(homedir(), '.local/bin')],
          { stdio: ['ignore', 2, 2], env: { ...process.env, HOME: scratch } });
      } finally { rmSync(scratch, { recursive: true, force: true }); }
    } else done = spawnSync(agyBinary(), ['update'], { stdio: ['ignore', 2, 2], timeout: 5 * 60_000 });
    if (done.status !== 0) { console.error(`${before.reason}，${before.action === 'install' ? '安装' : '升级'}失败（退出码 ${done.status ?? done.signal}）`); process.exit(1); }
  }
  const after = needed(agyBinary());
  if (after.action !== 'none') { console.error(after.reason); process.exit(1); }
  console.error(`Antigravity CLI ${after.version}`);
  console.log('{}');
}
