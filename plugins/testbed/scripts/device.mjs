// Find the device's group, platform and connection details for the step outputs. iOS uses its registration or the owning
// instance's group; Android is a group with an adb link this machine reaches. Connect before queueing so unreachable or
// unauthorized devices fail here, before the caller waits for them.
import { appendFileSync } from 'node:fs';
import { connect } from './android.mjs';
import { resolveDevice } from './resolve-device.mjs';

// A device asked for by a pool is named by the group it was held as, which must be a device's: `device:<设备名>`.
const held = process.env.HELD ?? '';
if (held && !held.startsWith('device:')) fail(`排到的组 ${held} 不是测试机：组名须以 device: 开头`);
const device = held ? held.slice('device:'.length) : process.env.DEVICE ?? '';
let found;
try {
  found = resolveDevice(device);
  if (found.platform === 'android') connect(found.adb);
} catch (error) { fail(error.message); }
console.log(`测试机 ${device}：${found.name ?? device}（${found.platform === 'android' ? `adb ${found.adb}` : found.udid}）`);
appendFileSync(process.env.GITHUB_OUTPUT, `id=${found.id}\ngroup=${found.group}\nname=${String(found.name ?? device).replace(/\n/g, ' ')}\nudid=${found.udid}\npersonal=${found.personal}\nplatform=${found.platform}\nadb=${found.adb}\nnote<<CODA_NOTE\n${found.note ?? ''}\nCODA_NOTE\n`);

function fail(message) { console.error(message); process.exit(1); }
