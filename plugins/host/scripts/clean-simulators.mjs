// Periodic cleanup without holding host slots. Coda supplies the run's final state through our module.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { registrations } from '../lib/simulators.mjs';
import { runFinished } from '../lib/simulator-status.mjs';
const exec = promisify(execFile);

// `set: null` is the user's default device set, where `simctl` works without --set.
const stand = process.env.HOST_SIM_SIMCTL;
const simctl = (set, ...args) => exec(stand || 'xcrun', ['simctl', ...(set ? ['--set', set] : []), ...args], { timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
async function listed(set) {
  const { stdout } = await simctl(set, 'list', 'devices', '-j');
  return Object.values(JSON.parse(stdout).devices).flat().map(({ udid, name, state }) => ({ udid, name, state, set }));
}
// Delete without forcing shutdown: simctl can refuse a device in use. Already gone is done.
export async function removeSimulator({ udid, name, set = null }) {
  const current = async () => (await listed(set)).find(device => device.udid === udid) ?? null;
  if (!await current()) return;
  // In-use errors are left for the next sweep, never forced or retried under a lock.
  await simctl(set, 'delete', udid);
  const left = await current();
  if (left) throw new Error(`模拟器 ${name ?? udid} 未能删除（${left.state}）`);
}

// The simulators this environment registered and has not deleted yet.
export function registered(state) {
  const file = join(state, 'simulators');
  return existsSync(file) ? [...new Set(readFileSync(file, 'utf8').split('\n').map(line => line.trim()).filter(Boolean))] : [];
}
// No slot is held: only confirmed terminal owners are eligible. Unknown/legacy owners stay listed.
export async function cleanSimulators(state) {
  for (const udid of registered(state)) console.log(`跳过模拟器 ${udid}：旧登记没有运行标识`);
  const udids = new Set(registrations(state).map(record => record.udid));
  let failures = 0;
  for (const udid of udids) {
    try {
      // Re-read before each device: binds made during this sweep must also be checked.
      const owners = registrations(state).filter(record => record.udid === udid);
      if (!owners.length || registered(state).includes(udid) || !(await Promise.all(owners.map(owner => runFinished(state, owner.runId)))).every(Boolean)) {
        console.log(`跳过模拟器 ${udid}：运行仍在进行、收尾中或归属无法确认`);
        continue;
      }
      await removeSimulator({ udid });
      // Remove only the exact registrations checked above; concurrent registrations are not lost.
      for (const owner of owners) {
        try { unlinkSync(owner.file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      console.log(`已删除模拟器 ${udid}`);
    } catch (error) {
      failures++;
      console.error(`跳过模拟器 ${udid}（使用中或无法清理）：${error.message}`);
    }
  }
  return failures ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const state = process.env.CODA_PLUGIN_STATE;
  if (!process.env.CODA_ARBITER) { console.log('不是这个实例自己的后端（测试或开发起的），不清点模拟器'); process.exit(0); }
  if (!state) { console.error('没有宿主资源插件的状态目录，不知道本实例登记过哪些模拟器，什么都不删'); process.exit(1); }
  process.exitCode = await cleanSimulators(state);
}
