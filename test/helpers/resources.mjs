// 资源记录命令的测试辅助：像宿主那样运行插件清单里 `coda/resource@1` 的记录命令（cwd 为插件目录、标准输入 `{}`、
// `CODA_RECORD_KIND`、30 秒），再用协议包的 `resourceRecordsProblem` 校验它打印的记录。
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { RESOURCE_PROTOCOL } from '@coda-console/protocol/protocol';
import { resourceRecordsProblem } from '@coda-console/protocol/validate';

const RESOURCE = RESOURCE_PROTOCOL.name;
const TIMEOUT = 30_000, GRACE = 10_000, DRAIN = 2_000, MAX_BYTES = 1024 * 1024;
const lastLine = text => text.split('\n').map(line => line.trim()).filter(Boolean).at(-1)?.slice(0, 200) ?? '';

// 命令打印的失败：`{ "error": { "message" } }`，否则 null。
function said(stdout) {
  try {
    const message = JSON.parse(stdout)?.error?.message;
    return typeof message === 'string' ? message : null;
  } catch { return null; }
}

// 在 `dir` 里运行记录命令文件 `command`：`{ result }`（它打印的数组）或 `{ error }`（没给出的原因）。
export function runResourceCommand(dir, command, env) {
  return new Promise(resolve => {
    const file = `./'${command.replaceAll("'", "'\\''")}'`;
    const child = spawn('/bin/sh', ['-c', file], { cwd: dir, env: { ...env, CODA_RECORD_KIND: RESOURCE }, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const signal = name => { try { process.kill(-child.pid, name); } catch {} };
    const out = [], err = [];
    let size = 0, overflow = false, timedOut = false, finished = false, drain = null, hard = null;
    const stop = () => { signal('SIGTERM'); hard ??= setTimeout(() => signal('SIGKILL'), GRACE); };
    const due = setTimeout(() => { timedOut = true; stop(); }, TIMEOUT);
    const finish = (code, failed) => {
      if (finished) return;
      finished = true; clearTimeout(due); clearTimeout(drain); clearTimeout(hard); signal('SIGKILL');
      const stdout = Buffer.concat(out).toString('utf8'), stderr = Buffer.concat(err).toString('utf8');
      if (failed) return resolve({ error: `记录命令没有开始：${failed}` });
      if (overflow) return resolve({ error: '记录命令的输出超过 1 MiB' });
      if (timedOut) return resolve({ error: '记录命令超时' });
      if (code !== 0) return resolve({ error: said(stdout) ?? (lastLine(stderr) || lastLine(stdout) || `记录命令没有完成（退出码 ${code ?? '无'}）`) });
      try { resolve({ result: JSON.parse(stdout) }); } catch { resolve({ error: '记录命令的输出不是 JSON' }); }
    };
    child.stdin.on('error', () => {});
    child.stdin.end('{}');
    child.stdout.on('data', chunk => {
      if (size + chunk.length > MAX_BYTES) { if (!overflow) { overflow = true; stop(); } return; }
      size += chunk.length; out.push(chunk);
    });
    child.stderr.on('data', chunk => err.push(chunk));
    child.on('error', error => finish(null, error.message));
    // 它自己退出后，留在组里的进程结束；仍占着管道的不再等。
    child.on('exit', code => { signal('SIGKILL'); drain = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); finish(code); }, DRAIN); });
    child.on('close', code => finish(code));
  });
}

// 插件 `dir` 的 `coda/resource@1` 记录：清单里该类的记录命令运行一次（`env` 默认为本进程的，`CODA_PLUGIN_PATH` 为插件目录、
// 本 Node 在 PATH 最前），输出须过 `resourceRecordsProblem`。失败时抛出原因。
export async function resourceRecords(dir, { env = { ...process.env, CODA_PLUGIN_PATH: dir, PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(':') } } = {}) {
  const { contributes } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')), found = contributes?.records?.find(one => one.kind === RESOURCE);
  if (!found) throw new Error(`清单的 contributes.records 里没有 ${RESOURCE}`);
  const { error, result } = await runResourceCommand(dir, found.command, env);
  if (error) throw new Error(error);
  const problem = resourceRecordsProblem(result);
  if (problem) throw new Error(problem);
  return result;
}
