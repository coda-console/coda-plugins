// Find a device's name, UDID, note and personal flag for the step outputs. Registration determines its owning instance,
// whose declarations are published to the space. An id absent locally is resolved through group-owner;
// if neither has it, report the missing device and the locally available ids.
import { appendFileSync } from 'node:fs';
import { resolveDevice } from './resolve-device.mjs';

const device = process.env.DEVICE ?? '';
let found;
try { found = resolveDevice(device); } catch (error) { fail(error.message); }
console.log(`测试机 ${device}：${found.name ?? device}（${found.udid}）`);
appendFileSync(process.env.GITHUB_OUTPUT, `name=${String(found.name ?? device).replace(/\n/g, ' ')}\nudid=${found.udid}\npersonal=${found.personal}\nnote<<CODA_NOTE\n${found.note ?? ''}\nCODA_NOTE\n`);

function fail(message) { console.error(message); process.exit(1); }
