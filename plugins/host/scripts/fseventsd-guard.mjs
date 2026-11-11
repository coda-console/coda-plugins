// macOS 27's fseventsd stops reclaiming path records once its cleanup cursor runs out (coda#2448): read its memory as a user
// can, and restart it past the threshold. Remove once Apple fixes it.
import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
const exec = promisify(execFile);

// Stand-ins for the tests, as HOST_SIM_SIMCTL in clean-simulators.mjs.
const tool = (name, fallback) => process.env[`HOST_FSEVENTSD_${name}`] || fallback;
const UNITS = { B: 1 / 1024 / 1024, K: 1 / 1024, M: 1, G: 1024, T: 1024 * 1024 };

// The last line of `top`'s MEM column, such as `7872K` or `3.6G+`, in MB.
async function memoryMB() {
  const { stdout: pids } = await exec(tool('PGREP', 'pgrep'), ['-x', 'fseventsd']);
  const pid = pids.trim().split('\n')[0];
  const { stdout } = await exec(tool('TOP', 'top'), ['-l', '1', '-pid', pid, '-stats', 'mem']);
  const last = stdout.trim().split('\n').at(-1).trim();
  const match = /^([\d.]+)([BKMGT])[+-]?$/.exec(last);
  if (!match) throw new Error(`top 的 MEM 列读不懂：${last}`);
  return Math.round(Number(match[1]) * UNITS[match[2]]);
}

// The run's status line is its step output `line`; the summary keeps the numbers.
function report(line, summary) {
  appendFileSync(process.env.GITHUB_OUTPUT, `line=${line}\n`);
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
}

if (process.platform !== 'darwin') { console.log('不是 macOS，不守护 fseventsd'); process.exit(0); }
if (!process.env.CODA_ARBITER) { console.log('不是这个实例自己的后端（测试或开发起的），不守护 fseventsd'); process.exit(0); }

const threshold = Number(process.env.THRESHOLD_MB);
let used;
try { used = await memoryMB(); }
catch (error) {
  const line = `读不出 fseventsd 的占用：${error.message.trim().split('\n').at(-1)}`;
  report(line, line);
  console.error(line);
  process.exit(1);
}

const file = join(process.env.CODA_PLUGIN_STATE, 'fseventsd-guard.json');
let restarts = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).restarts : 0;
if (used <= threshold) {
  const line = `fseventsd 占用 ${used} MB · 累计重启 ${restarts} 次`;
  report(line, `fseventsd 占用 ${used} MB，阈值 ${threshold} MB，没有重启；累计重启 ${restarts} 次。`);
  console.log(line);
  process.exit(0);
}

try { await exec(tool('SUDO', 'sudo'), ['-n', 'killall', 'fseventsd']); }
catch (error) {
  const reason = (error.stderr || error.message).trim().split('\n').at(-1);
  const line = `fseventsd 占用 ${used} MB，超过 ${threshold} MB，重启失败：${reason}`;
  report(line, `${line}\n\n手动执行 \`sudo killall fseventsd\`。`);
  console.error(`${line}
请手动执行：sudo killall fseventsd
要让守护自己重启，用 sudo visudo -f /etc/sudoers.d/fseventsd 加一条只放行这条命令的免密规则：
${userInfo().username} ALL=(root) NOPASSWD: /usr/bin/killall fseventsd`);
  process.exit(1);
}
writeFileSync(file, JSON.stringify({ restarts: ++restarts }));
const line = `fseventsd 占用 ${used} MB，超过 ${threshold} MB，已重启 · 累计重启 ${restarts} 次`;
report(line, `fseventsd 占用 ${used} MB，阈值 ${threshold} MB，已重启；累计重启 ${restarts} 次。`);
console.log(line);
