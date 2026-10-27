// Which test device a device name is: as this Mac registers it (scripts/registry.mjs, README.md).
// Its display name, UDID and note for the session are the step's outputs `name`, `udid` and `note`; a name not registered
// there fails the step, saying which are.
import { appendFileSync } from 'node:fs';
import { devices, file } from './registry.mjs';

const device = process.env.DEVICE ?? '';
let list;
try { list = devices(); } catch (error) { fail(error.message); }
const found = list.find(d => d?.id === device);
if (!found || typeof found.udid !== 'string' || !found.udid) {
  const known = list.map(d => d?.id).filter(Boolean);
  fail(`本机没有登记设备 ${device}（${file}）${known.length ? `；登记了：${known.join('、')}` : '；一台也没有登记'}`);
}
console.log(`测试机 ${device}：${found.name ?? device}（${found.udid}）`);
appendFileSync(process.env.GITHUB_OUTPUT, `name=${String(found.name ?? device).replace(/\n/g, ' ')}\nudid=${found.udid}\nnote<<CODA_NOTE\n${found.note ?? ''}\nCODA_NOTE\n`);

function fail(message) { console.error(message); process.exit(1); }
