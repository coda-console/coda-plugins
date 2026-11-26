// 受限执行（exec 的 `restrict` 参数）：经 macOS 的 /usr/bin/sandbox-exec 以 deny-default 的 profile 起命令，文件内容只在允许的目录里读写。
//
// 启动链（`ctx.spawn` 起的第一个进程仍是 `/usr/bin/env`，和不受限时一样，只有它拿到后端注入的环境与插件令牌）：
//   /usr/bin/env -i <白名单环境，TMPDIR 换成本次的临时目录> /usr/bin/sandbox-exec -D … -p <profile> /bin/sh -c <命令>
//   env 清空环境后 exec 成 sandbox-exec，sandbox-exec 加载 profile 后 exec 成 sh；三者是同一个进程（pid、进程组都不变）。
//   所以 sandbox-exec 与用户命令拿到的都是清过的环境，不比不受限时暴露得更多。
//
// 路径不拼进 profile 文本：以 `-D 名=值` 传给 sandbox-exec，profile 里用 `(param "名")` 引用，含引号、反斜杠、换行的路径照样安全。
// profile 以系统的 system.sb 为底（更窄的自写 profile 会让进程 SIGABRT）。它自带的例外里，对「目录外文件可读」有影响的写在 README。
//
// 建不起来就拒绝，绝不退回不受限执行：本模块只有「回计划」或「抛错」两种结局，调用方（exec.mjs）拿到计划才起进程，
// 没有计划时不受限的分支是另一条路，带了 `restrict` 的调用走不到它。
import { accessSync, constants } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { cleanEnv } from './environ.mjs';
import { terminate } from './kill.mjs';
import { fsError } from './operation.mjs';

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
export const MAX_DIRS = 50;
// 每次受限调用的临时目录都建在插件状态目录的这个子目录下：状态根整个是受保护的，别的受限调用够不着。
export const TMP_DIR = 'sandbox-tmp';

// 这台能不能做受限执行：macOS 且 sandbox-exec 可执行。`platform`、`executable` 供测试替换。
export function sandboxSupported({ platform = process.platform, executable = path => accessSync(path, constants.X_OK) } = {}) {
  if (platform !== 'darwin') return false;
  try { executable(SANDBOX_EXEC); return true; } catch { return false; }
}

const none = { effects: 'none' };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// 参数的形状：{ dirs: [{ path, access: 'rw' | 'ro' }] }，1 到 MAX_DIRS 项，path 是绝对路径，至少一项 rw。
export function checkRestrict(coda, restrict) {
  const bad = what => coda.error('invalid_input', `restrict ${what}`, none);
  if (!plain(restrict) || Object.keys(restrict).some(key => key !== 'dirs')) throw bad('只能是 { dirs }');
  const { dirs } = restrict;
  if (!Array.isArray(dirs) || dirs.length < 1 || dirs.length > MAX_DIRS) throw bad(`.dirs 须是 1 到 ${MAX_DIRS} 项的数组`);
  for (const one of dirs) {
    if (!plain(one) || Object.keys(one).some(key => key !== 'path' && key !== 'access')) throw bad('.dirs 的每一项只能是 { path, access }');
    if (typeof one.path !== 'string' || !isAbsolute(one.path) || one.path.includes('\0')) throw bad(`.dirs 的 path 须是绝对路径：${one.path}`);
    if (one.access !== 'rw' && one.access !== 'ro') throw bad(`.dirs 的 access 须是 rw 或 ro：${one.access}`);
  }
  if (!dirs.some(one => one.access === 'rw')) throw bad('.dirs 至少要有一项 rw');
}

// 真实路径，且必须是目录。`missing`、`notDirectory` 是不存在与不是目录的错误码。
async function directory(coda, path, { missing, notDirectory }) {
  let real, info;
  try { real = await realpath(path); info = await stat(real); } catch (error) {
    if (error.code === 'ENOENT') throw coda.error(missing, `${path}：不存在`, none);
    if (error.code === 'ENOTDIR') throw coda.error(notDirectory, `${path}：路径中有不是目录的部分`, none);
    throw fsError(coda, error, path);
  }
  if (!info.isDirectory()) throw coda.error(notDirectory, `${path}：不是目录`, none);
  return real;
}

const inside = (path, parent) => path === parent || path.startsWith(parent === '/' ? '/' : `${parent}/`);

// 路径等价（macOS 的卷默认不分大小写、不分 Unicode 规范化形式）的处理：判断重叠与归属前，两边都先过 `realpath`。
// `fs/promises` 的 `realpath` 是 libc 的 realpath(3)，回的是文件系统记着的写法，不是调用方的拼写（只有 `fs.realpathSync` 的 JS 实现才保留拼写），
// 所以 `/USERS/LEAVAN`、`~/.SSH` 这样的拼写与真写法比较、写进 profile 的都是同一个字符串；区分大小写的卷上两种拼写本来就是两个路径，不会被合并。
// 不存在的路径（如还没建的 ~/.ssh）取最长的已有祖先的真实路径再接上剩下的名字。
async function canonical(path) {
  try { return await realpath(path); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return join(await canonical(dirname(path)), basename(path));
  }
}

// 不许授出的位置（真实路径）：Coda 的状态根（含本插件和别的插件的状态目录）、家目录的 .ssh。
const protectedPaths = stateRoot => Promise.all([stateRoot, join(homedir(), '.ssh')].filter(Boolean).map(canonical));

// profile 文本：系统的 system.sb 为底，再加执行要读的系统路径、允许的目录（D0…）与本次的临时目录（TMP）。路径都在 `-D` 参数里，文本里没有。
export function profileText(dirs) {
  return [
    '(version 1)',
    '(deny default)',
    '(import "system.sb")',
    '(allow process-fork)',
    '(allow process-exec* (subpath "/usr") (subpath "/bin") (subpath "/sbin"))',
    '(allow file-read* (subpath "/usr") (subpath "/bin") (subpath "/sbin") (subpath "/private/etc") (subpath "/private/var/select"))',
    ...dirs.map(({ access }, i) => `(allow file-read* ${access === 'rw' ? 'file-write* ' : ''}process-exec* file-map-executable (subpath (param "D${i}")))`),
    '(allow file-read* file-write* process-exec* file-map-executable (subpath (param "TMP")))',
  ].join('\n');
}

// 交给 sandbox-exec 的参数（不含要执行的命令）。
export function sandboxArgs(dirs, tmp) {
  return [...dirs.flatMap(({ path }, i) => ['-D', `D${i}=${path}`]), '-D', `TMP=${tmp}`, '-p', profileText(dirs)];
}

// 准备一次受限执行，回计划 { cwd, tmp, argv(command, env), cleanup() }，或抛带码的错误（`effects: 'none'`，什么都没起）。
//   env：exec 的环境（coda、state 插件状态目录、stateRoot 状态根，`sandboxSupported` 供测试替换）
//   cwd：调用给的 cwd，没给回第一条 rw 目录
// 码：invalid_input（参数不合法）、sandbox_unsupported、restrict_dir_not_found、restrict_dir_not_a_directory、restrict_protected、
//   cwd_not_allowed，cwd 自己的 not_found、not_a_directory；临时目录建不出是 sandbox_failed。
export async function prepareSandbox(env, restrict, cwd) {
  const { coda } = env;
  checkRestrict(coda, restrict);
  if (!(env.sandboxSupported ?? sandboxSupported)()) throw coda.error('sandbox_unsupported', '这台机器不支持受限执行（只支持有 /usr/bin/sandbox-exec 的 macOS）', none);
  const dirs = [];
  for (const { path, access } of restrict.dirs) {
    dirs.push({ path: await directory(coda, path, { missing: 'restrict_dir_not_found', notDirectory: 'restrict_dir_not_a_directory' }), access, given: path });
  }
  const guarded = await protectedPaths(env.stateRoot);
  for (const { path, given } of dirs) {
    const hit = guarded.find(one => inside(path, one) || inside(one, path));
    if (hit) throw coda.error('restrict_protected', `${given}${given === path ? '' : `（真实路径 ${path}）`} 与受保护的 ${hit} 重叠，不能授出`, none);
  }
  if (cwd !== undefined && !isAbsolute(cwd)) throw coda.error('invalid_input', `cwd 必须是绝对路径：${cwd}`, none);
  const real = cwd === undefined ? dirs.find(one => one.access === 'rw').path
    : await directory(coda, cwd, { missing: 'not_found', notDirectory: 'not_a_directory' });
  if (!dirs.some(one => inside(real, one.path))) throw coda.error('cwd_not_allowed', `cwd ${cwd}（真实路径 ${real}）不在允许的目录里`, none);

  let tmp;
  try {
    const root = join(await realpath(env.state), TMP_DIR);
    await mkdir(root, { recursive: true, mode: 0o700 });
    tmp = await mkdtemp(join(root, 'c-'));
  } catch (error) { throw coda.error('sandbox_failed', `建不出这次调用的临时目录：${error.message}`, none); }
  const args = sandboxArgs(dirs, tmp);
  return {
    cwd: real, tmp,
    // 交给 `ctx.spawn` 的命令与参数；TMPDIR 换成本次的临时目录。
    argv: (command, clean) => ['/usr/bin/env', ['-i', ...Object.entries({ ...clean, TMPDIR: tmp }).map(([key, value]) => `${key}=${value}`), SANDBOX_EXEC, ...args, '/bin/sh', '-c', command]],
    cleanup: () => rm(tmp, { recursive: true, force: true }),
  };
}

export const PROBE_MS = 10_000;

// 起真命令前先用同一份 profile、同一条启动链空跑一条 `:`：sandbox-exec 自己的失败（profile 不合、sandbox_apply 失败，退出码 65、71 之类）
// 与用户命令自己的非零退出码在数字上分不开，所以不靠真命令的退出码判断，空跑过了才起真命令。空跑不过抛 `sandbox_failed`（什么都没执行）。
export async function probe(coda, plan, spawn) {
  const [command, args] = plan.argv(':', cleanEnv());
  const child = await spawn(command, args, { cwd: plan.cwd });
  const settled = child.exited.then(() => {}, () => {});
  const timer = setTimeout(() => { terminate(child.pid, settled); }, PROBE_MS);
  let said = '';
  const read = async stream => { for await (const chunk of stream) said = (said + chunk).slice(-300); };
  child.stdin.on('error', () => {});
  child.stdin.end();
  let status;
  try { [status] = await Promise.all([child.exited, read(child.stdout), read(child.stderr)]); } finally { clearTimeout(timer); }
  if (status.code !== 0) throw coda.error('sandbox_failed', `沙箱没能启动，没有执行（${status.code === null ? status.signal : `退出码 ${status.code}`}）：${said.trim()}`, none);
}
