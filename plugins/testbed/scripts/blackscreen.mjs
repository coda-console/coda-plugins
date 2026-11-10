// Puts a test device to its black screen before it is handed on (README.md): the black screen app
// (blackscreen/, installed on the device) launched over devicectl, or the line the plugin's setting `testbed.blackscreen`
// gives for the device instead, run by sh with its UDID in `UDID` (an Android device's adb address also in `ADB` and
// `ANDROID_SERIAL`). An Android device without a line is put back as it was lent instead (README.md「安卓测试机」): the
// settings the task changed, frida-server stopped, the home screen and the screen off. Its output is the step's log; its
// exit, the step's.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { changes, command, connect, notDone, readSettings, script, snapshotFile } from './android.mjs';

// As blackscreen/build.sh signs it.
const APP = 'com.leavan.blackscreen';
// None running is as good as stopped; one still running a few seconds after is not. The pattern does not match its own line.
const CLEAN_UP = [
  "pkill -f '[f]rida-server'",
  "for i in 1 2 3 4 5; do pgrep -f '[f]rida-server' >/dev/null || break; sleep 1; done",
  "if pgrep -f '[f]rida-server' >/dev/null; then echo 'frida-server 停不下来' >&2; exit 1; fi",
  'input keyevent KEYCODE_HOME || exit 1',
  'input keyevent KEYCODE_SLEEP || exit 1',
  'sleep 3',
];
const android = process.env.PLATFORM === 'android';
const own = JSON.parse(process.env.COMMANDS || '{}')[process.env.DEVICE]?.trim();
if (android && !own) putBack();
else {
  const command = own || `xcrun devicectl device process launch --terminate-existing --device "$UDID" ${APP}`;
  console.log(`切黑屏：${command}`);
  const env = android ? { ...process.env, ANDROID_SERIAL: process.env.ADB } : process.env;
  const child = spawn('/bin/sh', ['-c', command], { stdio: 'inherit', env });
  for (const name of ['SIGTERM', 'SIGINT']) process.on(name, () => child.kill(name));
  child.on('error', error => { console.error(error.message); process.exit(1); });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

function putBack() {
  const { DEVICE: device, ADB: address } = process.env, file = snapshotFile(process.env.CODA_PLUGIN_STATE, device);
  try {
    connect(address);
    // frida-server stopped, the home screen and the screen off first, and a moment for what the system sets as the screen
    // goes off; any of them not done fails it.
    script(address, CLEAN_UP);
    // Lent before it was noted (the run cancelled while it waited, say): nothing of its settings to put back.
    const before = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).settings : null;
    const wanted = before ? changes(before, readSettings(address)) : [];
    console.log(!before ? '没有借出时记下的设置，只回到桌面、熄屏' : wanted.length ? `改回 ${wanted.length} 项设置：\n${wanted.map(command).join('\n')}` : '设置没有变化');
    if (wanted.length) {
      script(address, wanted.map(command));
      const left = notDone(wanted, readSettings(address));
      if (left.length) throw new Error(`有 ${left.length} 项设置没能改回：\n${left.map(command).join('\n')}`);
    }
    rmSync(file, { force: true });
    console.log(`${device} 已复原并熄屏`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
