#!/usr/bin/env node
// The「Grok」resource type's sign-in (the `sign-in` operation of `coda/resource@1`): `grok login --device-auth` of the CLI
// the sessions run (the installer's, else the one on the PATH), uncoloured, opening no browser on the machine.
import { spawn } from 'node:child_process';
import { grokBinary } from './ask.mjs';
import { deviceLogin } from './device-login.mjs';

const binary = grokBinary();
if (!binary) { console.error('这台机器上找不到 Grok CLI'); process.exit(1); }
await deviceLogin(() => spawn(binary, ['login', '--device-auth'], { env: { ...process.env, BROWSER: '/usr/bin/true', NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] }), 'Grok');
