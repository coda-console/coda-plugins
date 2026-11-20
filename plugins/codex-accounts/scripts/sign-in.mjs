#!/usr/bin/env node
// The「Codex」resource type's sign-in (the `sign-in` operation of `coda/resource@1`) of the managed accounts: login.mjs, which
// has Codex print the device link and code and keeps the login once it is confirmed, uncoloured. The device login itself is
// device-login.mjs, the same file as the codex plugin's: the codex installed beside this one may be older and have none.
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deviceLogin } from './device-login.mjs';

await deviceLogin(() => spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'login.mjs')],
  { env: { ...process.env, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] }));
