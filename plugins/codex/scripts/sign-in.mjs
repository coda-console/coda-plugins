#!/usr/bin/env node
// The「Codex」resource type's sign-in (the `sign-in` operation of `coda/resource@1`): `codex login --device-auth` of the plugin's
// own CLI (scripts/cli.mjs: with「多账号」on, it adds or updates a managed account instead), uncoloured.
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deviceLogin } from './device-login.mjs';

await deviceLogin(() => spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'cli.mjs'), 'login', '--device-auth'],
  { env: { ...process.env, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] }));
