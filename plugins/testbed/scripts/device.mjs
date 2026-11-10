// Find a device's name, UDID, note, personal flag, platform and adb address for the step outputs. Registration determines
// its owning instance, whose declarations are published to the space. An id absent locally is resolved through
// group-owner; if neither has it, report the missing device and the locally available ids. An Android device is connected
// here first: one this machine cannot reach, or whose key it has not authorized, fails here, before waiting for it.
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
appendFileSync(process.env.GITHUB_OUTPUT, `name=${String(found.name ?? device).replace(/\n/g, ' ')}\nudid=${found.udid}\npersonal=${found.personal}\nplatform=${found.platform}\nadb=${found.adb}\nnote<<CODA_NOTE\n${found.note ?? ''}\nCODA_NOTE\n`);

function fail(message) { console.error(message); process.exit(1); }
