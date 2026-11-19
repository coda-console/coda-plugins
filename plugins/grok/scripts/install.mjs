#!/usr/bin/env node
// Grok's own installer (the `install` operation of `coda/resource@1`; setup.mjs runs it too): the CLI goes to ~/.grok/bin, where
// the sessions look first. Without SHELL it leaves the shell's configuration alone, and with ~/.grok/bin first on the PATH it
// has nothing to link into ~/.local/bin. What it prints goes to standard error with the rest of its story.
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const install = () => spawnSync('bash', ['-c', 'set -o pipefail; curl -fsSL https://x.ai/cli/install.sh | bash'], { stdio: ['ignore', 2, 2],
  env: { ...process.env, SHELL: '', PATH: `${join(homedir(), '.grok/bin')}:${process.env.PATH ?? ''}` } });

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const installed = install();
  if (installed.status !== 0) { console.error(`安装失败（退出码 ${installed.status ?? installed.signal}）`); process.exit(1); }
  console.log('{}');
}
