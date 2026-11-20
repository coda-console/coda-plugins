#!/usr/bin/env node
// The `host/kind@1` record of this plugin (README.md), printed once: the host plugin's host-sim hands every kind it does not
// hold (a test device's name) to the command `testbed-sim` (contributes.commands), which is scripts/host-sim.mjs.
console.log(JSON.stringify([{ key: 'devices', spec: { command: 'testbed-sim' } }]));
