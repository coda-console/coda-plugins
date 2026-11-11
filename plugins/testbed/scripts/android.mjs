import { spawnSync } from 'node:child_process';

// adb with this device as its own; its output, or why it could not say.
export function adb(address, args, { timeout = 20_000, input } = {}) {
  const ran = spawnSync('adb', ['-s', address, ...args], { encoding: 'utf8', timeout, maxBuffer: 16 << 20, input });
  if (ran.error) throw new Error(ran.error.code === 'ENOENT' ? '这台机器没有 adb：先装上 Android SDK Platform Tools' : `adb ${args[0]}：${ran.error.message}`);
  if (ran.status !== 0) throw new Error(`adb ${args.join(' ').slice(0, 80)} 失败：${(ran.stderr || ran.stdout).trim().split('\n').at(-1)}`);
  return ran.stdout;
}

// Connected and lent to this machine's key, or why not: unreachable, or the key not authorized on the device.
export function connect(address) {
  const connected = spawnSync('adb', ['connect', address], { encoding: 'utf8', timeout: 20_000 });
  if (connected.error) throw new Error(connected.error.code === 'ENOENT' ? '这台机器没有 adb：先装上 Android SDK Platform Tools' : `adb connect ${address}：${connected.error.message}`);
  const state = spawnSync('adb', ['-s', address, 'get-state'], { encoding: 'utf8', timeout: 10_000 });
  if (state.stdout?.trim() === 'device') return;
  const said = `${connected.stdout ?? ''}${state.stderr ?? ''}`.trim();
  if (/unauthorized/.test(said))
    throw new Error(`${address} 没有授权这台机器的 adb 公钥：把这台 adb pubkey ~/.android/adbkey 打出的一行追加进设备的 /data/misc/adb/adb_keys（设备已 root 时由能上它的机器写入），不用在手机上点`);
  throw new Error(`连不上 ${address}：${said.split('\n').at(-1) || '没有应答'}`);
}
