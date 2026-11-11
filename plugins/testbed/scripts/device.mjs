// Find the device's group, platform, entity and connection details for the step outputs. iOS uses its registration;
// Android uses the shared alias and the custodian's reachable adb link. Connect before queueing so unreachable or
// unauthorized devices fail here, before the caller waits for them.
import { appendFileSync } from 'node:fs';
import { connect } from './android.mjs';
import { resolveDevice } from './resolve-device.mjs';

const device = process.env.DEVICE ?? '';
let found;
try {
  found = resolveDevice(device);
  if (found.platform === 'android') connect(found.adb);
} catch (error) { fail(error.message); }
console.log(`测试机 ${device}：${found.name ?? device}（${found.platform === 'android' ? `adb ${found.adb}` : found.udid}）`);
appendFileSync(process.env.GITHUB_OUTPUT, `group=${found.group}\nentity=${found.entity}\nname=${String(found.name ?? device).replace(/\n/g, ' ')}\nudid=${found.udid}\npersonal=${found.personal}\nplatform=${found.platform}\nadb=${found.adb}\nnote<<CODA_NOTE\n${found.note ?? ''}\nCODA_NOTE\n`);

function fail(message) { console.error(message); process.exit(1); }
