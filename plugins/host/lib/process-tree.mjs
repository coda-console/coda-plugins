// A command's processes, also those it started in process groups of their own. A build tool runs each compiler in a group
// of its own (swift-build, xcodebuild): a signal to the command's group never reaches it, and once the tool has gone it
// goes on under launchd, gigabytes each. So they are listed before the first signal, and each is signalled by itself too.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

// Every process in these groups and under them, each with its start (a PID can be reused). Empty when ps cannot say.
export async function processTree(groups, query = exec) {
  let stdout;
  try { ({ stdout } = await query('ps', ['-ax', '-o', 'pid=,ppid=,pgid=,lstart='], { timeout: 5000, maxBuffer: 16 * 1024 * 1024 })); }
  catch { return []; }
  const rows = stdout.split('\n').map(line => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S.*?)\s*$/.exec(line)).filter(Boolean)
    .map(([, pid, ppid, pgid, started]) => ({ pid: +pid, ppid: +ppid, pgid: +pgid, started }));
  const tree = new Set(rows.filter(row => groups.includes(row.pgid) && row.pid !== process.pid).map(row => row.pid));
  for (let size = -1; size !== tree.size;) {
    size = tree.size;
    for (const row of rows) if (tree.has(row.ppid) && row.pid !== process.pid) tree.add(row.pid);
  }
  return rows.filter(row => tree.has(row.pid)).map(({ pid, started }) => ({ pid, started }));
}
// The groups sent `signal`, and each process listed of them (`processTree`) that is still the one listed. One that cannot be
// checked is left alone.
export async function signalTree(groups, tree, signal, query = exec) {
  for (const group of groups) if (Number.isSafeInteger(group) && group > 1) try { process.kill(-group, signal); } catch {}
  if (!tree.length) return;
  let stdout;
  try { ({ stdout } = await query('ps', ['-o', 'pid=,lstart=', '-p', tree.map(p => p.pid).join(',')], { timeout: 5000 })); }
  catch (error) { stdout = error.code === 1 ? error.stdout ?? '' : ''; }
  const now = new Map(stdout.split('\n').map(line => /^\s*(\d+)\s+(\S.*?)\s*$/.exec(line)).filter(Boolean).map(([, pid, started]) => [+pid, started]));
  for (const { pid, started } of tree) if (now.get(pid) === started) try { process.kill(pid, signal); } catch {}
}
