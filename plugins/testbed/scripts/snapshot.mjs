// The step of use-testbed that notes what an Android test device is like when it is lent (README.md「安卓测试机」): its
// settings, for the device's handing back (blackscreen.mjs) to put back what the task changed. An iPhone or iPad has
// nothing to note: its handing back is the black screen.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { connect, readSettings, snapshotFile } from './android.mjs';

if (process.env.PLATFORM !== 'android') process.exit(0);
const { DEVICE: device, ADB: address } = process.env;
try {
  connect(address);
  const file = snapshotFile(process.env.CODA_PLUGIN_STATE, device);
  mkdirSync(dirname(file), { recursive: true });
  const settings = readSettings(address);
  writeFileSync(file, JSON.stringify({ address, settings }));
  console.log(`记下 ${device} 的设置：${Object.entries(settings).map(([name, table]) => `${name} ${Object.keys(table).length} 项`).join('，')}`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
