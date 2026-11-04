import { appendFileSync } from 'node:fs';
import { resolveDevice } from './resolve-device.mjs';

const device = process.env.DEVICE ?? '';
let found;
try { found = resolveDevice(device); } catch (error) { fail(error.message); }
console.log(`测试机 ${device}：${found.name ?? device}（${found.udid}）`);
appendFileSync(process.env.GITHUB_OUTPUT, `name=${String(found.name ?? device).replace(/\n/g, ' ')}\nudid=${found.udid}\nnote<<CODA_NOTE\n${found.note ?? ''}\nCODA_NOTE\n`);

function fail(message) { console.error(message); process.exit(1); }
