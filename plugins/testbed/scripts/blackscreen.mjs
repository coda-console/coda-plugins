import { spawn } from 'node:child_process';
// As blackscreen/build.sh signs it.
const APP = 'com.leavan.blackscreen';
const own = JSON.parse(process.env.COMMANDS || '{}')[process.env.DEVICE]?.trim();
const command = own || `xcrun devicectl device process launch --terminate-existing --device "$UDID" ${APP}`;
console.log(`切黑屏：${command}`);
const child = spawn('/bin/sh', ['-c', command], { stdio: 'inherit', env: process.env });
for (const name of ['SIGTERM', 'SIGINT']) process.on(name, () => child.kill(name));
child.on('error', error => { console.error(error.message); process.exit(1); });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
