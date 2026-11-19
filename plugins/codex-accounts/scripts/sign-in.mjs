#!/usr/bin/env node
// The「Codex」resource type's sign-in (the `sign-in` operation of `coda/resource@1`) of the managed accounts: login.mjs, which
// has Codex print the device link and code and keeps the login once it is confirmed, uncoloured. The device login itself is
// the codex plugin's, which this plugin depends on (its directory is in `CODA_PLUGIN_DEPENDENCIES`).
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const shared = pathToFileURL(join(JSON.parse(process.env.CODA_PLUGIN_DEPENDENCIES).codex, 'scripts', 'device-login.mjs')).href;
const { deviceLogin } = await import(shared);
await deviceLogin(() => spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'login.mjs')],
  { env: { ...process.env, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] }));
