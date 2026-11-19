#!/usr/bin/env node
// The「Kimi」resource type's sign-in (the `sign-in` operation of `coda/resource@1`): `kimi login`, the device-code login of the CLI
// the agent runs. `kimi login` opens the link with `open` (`xdg-open` on Linux) whatever BROWSER says: on a machine the user is not
// at, that would be a page left open for no one, so it finds do-nothing ones first on its PATH, in this plugin's own state.
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { kimiBinary } from '../agent/binary.mjs';
import { deviceLogin } from './device-login.mjs';

const binary = kimiBinary();
if (!binary) { console.error('这台机器上找不到 Kimi CLI'); process.exit(1); }
const stubs = join(process.env.CODA_PLUGIN_STATE, 'no-browser');
mkdirSync(stubs, { recursive: true });
for (const name of ['open', 'xdg-open']) { writeFileSync(join(stubs, name), '#!/bin/sh\nexit 0\n'); chmodSync(join(stubs, name), 0o755); }
await deviceLogin(() => spawn(binary, ['login'], { env: { ...process.env, PATH: `${stubs}:${process.env.PATH}`, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] }), 'Kimi');
