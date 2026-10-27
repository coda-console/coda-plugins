// Puts a test device to its black screen before it is handed on (README.md): the black screen app
// (blackscreen/, installed on the device) launched over devicectl, or the line the plugin's setting `testbed.blackscreen`
// gives for the device instead, run by sh with its UDID in `UDID`. Its output is the step's log; its exit, the step's.
import { spawn } from 'node:child_process';

// As blackscreen/build.sh signs it.
const APP = 'com.leavan.blackscreen';
const command = JSON.parse(process.env.COMMANDS || '{}')[process.env.DEVICE]?.trim()
  || `xcrun devicectl device process launch --terminate-existing --device "$UDID" ${APP}`;
console.log(`切黑屏：${command}`);
const child = spawn('/bin/sh', ['-c', command], { stdio: 'inherit' });
for (const name of ['SIGTERM', 'SIGINT']) process.on(name, () => child.kill(name));
child.on('error', error => { console.error(error.message); process.exit(1); });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
