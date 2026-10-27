// The step of 清点模拟器 (README.md, .coda/workflows/clean-simulators.bpmn), run while it holds the
// group `host` whole: the simulators this environment registered (`host-sim bind`, in CODA_PLUGIN_STATE/simulators) are
// deleted. Only commands holding the group use them, and none holds it now, nor is let in until this is over, so none of
// them is anyone's: one a step left behind, one a command killed before it could delete its own. Another environment of this
// user (Coda's docs/deployment.md「后端实例」) has its own group and its own list; its simulators are never touched here. One that
// cannot be deleted stays listed for the next time. Only the environment's own backend (CODA_ARBITER) deletes any: one
// started for tests or development leaves them. `HOST_SIM_SIMCTL` stands in for `xcrun` (a test's).
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
const exec = promisify(execFile);

// `set: null` is the user's default device set, where `simctl` works without --set.
const stand = process.env.HOST_SIM_SIMCTL;
const simctl = (set, ...args) => exec(stand || 'xcrun', ['simctl', ...(set ? ['--set', set] : []), ...args], { timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
async function listed(set) {
  const { stdout } = await simctl(set, 'list', 'devices', '-j');
  return Object.values(JSON.parse(stdout).devices).flat().map(({ udid, name, state }) => ({ udid, name, state, set }));
}
// Shut down and delete; a device that is already gone is done.
export async function removeSimulator({ udid, name, set = null }) {
  const current = async () => (await listed(set)).find(device => device.udid === udid) ?? null;
  if (!await current()) return;
  await simctl(set, 'shutdown', udid).catch(() => {});
  await simctl(set, 'delete', udid).catch(() => {});
  const left = await current();
  if (left) throw new Error(`模拟器 ${name ?? udid} 未能删除（${left.state}）`);
}

// The simulators this environment registered and has not deleted yet.
export function registered(state) {
  const file = join(state, 'simulators');
  return existsSync(file) ? [...new Set(readFileSync(file, 'utf8').split('\n').map(line => line.trim()).filter(Boolean))] : [];
}
function keep(state, udids) {
  const file = join(state, 'simulators'), temporary = `${file}.next`;
  writeFileSync(temporary, udids.map(udid => `${udid}\n`).join(''), { mode: 0o600 }); renameSync(temporary, file);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const state = process.env.CODA_PLUGIN_STATE;
  if (!process.env.CODA_ARBITER) { console.log('不是这个实例自己的后端（测试或开发起的），不清点模拟器'); process.exit(0); }
  if (!state) { console.error('没有宿主资源插件的状态目录，不知道本实例登记过哪些模拟器，什么都不删'); process.exit(1); }
  const left = [];
  for (const udid of registered(state)) {
    try { await removeSimulator({ udid }); console.log(`已删除模拟器 ${udid}`); }
    catch (error) { left.push(udid); console.error(`删除模拟器 ${udid} 失败：${error.message}`); }
  }
  // What was registered meanwhile is not lost: nobody holds the group while this runs, so nothing registers either.
  keep(state, left);
  process.exitCode = left.length ? 1 : 0;
}
