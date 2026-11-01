import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export const digest = value => createHash('sha256').update(value).digest('hex');
export const git = async (cwd, args, signal, transport = {}) => {
  const headers = Object.entries(transport.headers ?? {}), config = {};
  for (const [i, [key, value]] of headers.entries()) {
    if (!/^[a-zA-Z0-9-]+$/.test(key) || /[\r\n]/.test(value)) throw new Error('鉴权代理返回了无效 HTTP header');
    config[`GIT_CONFIG_KEY_${i}`] = `http.${transport.url}.extraHeader`;
    config[`GIT_CONFIG_VALUE_${i}`] = `${key}: ${value}`;
  }
  return (await exec('git', ['-C', cwd, ...args], {
  signal, encoding: 'utf8', maxBuffer: 2 ** 20, env: { PATH: process.env.PATH, HOME: process.env.HOME,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: String(headers.length), ...config },
})).stdout.trim();
};

export async function inside(root, path = '.') {
  if (typeof path !== 'string' || isAbsolute(path) || path.includes('\0') || path.split(/[\\/]/).includes('..')) throw new Error('workingDirectory 须在工作副本内');
  const base = await realpath(root), cwd = await realpath(resolve(base, path)), part = relative(base, cwd);
  if (part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part) || !(await stat(cwd)).isDirectory()) throw new Error('workingDirectory 逃出工作副本或不是目录');
  return cwd;
}

// sourceKey includes the source work-copy instance, NOT its origin URL, snapshot or commit.
// The slot comes from the host ledger. No local counter or scheduler guess can allocate it.
export async function prepareWorkspace({ root, source, slot, attempt, signal, runGit = git, prepared = async () => {} }) {
  if (!Number.isSafeInteger(slot) || slot < 0) throw new Error('账本未提供有效名额序号');
  const key = source ? source.key : `empty:${attempt}`;
  if (typeof key !== 'string' || !key) throw new Error('源码缺少工作副本身份');
  const workspace = join(root, 'workspaces', digest(key), String(slot));
  await mkdir(workspace, { recursive: true });
  // Check the cache root itself before running destructive git operations (a previous task can leave links).
  const safeRoot = await realpath(root), safePath = await realpath(workspace);
  if (safePath !== join(safeRoot, 'workspaces', digest(key), String(slot))) throw new Error('缓存目录不能由符号链接重定向');
  await prepared(workspace);
  if (!source) return workspace;
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(source.commit)) throw new Error('源码须为完整提交号');
  if ((!/^refs\/[a-zA-Z0-9_./-]+$/.test(source.ref) || source.ref.includes('..')) && source.ref !== source.commit) throw new Error('源码 ref 无效');
  const url = new URL(source.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('源码须由鉴权 HTTP 代理提供');
  const metadata = join(workspace, '.git');
  const info = await lstat(metadata).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error('缓存 Git 元数据不是独立目录');
  const sha256 = source.commit.length === 64;
  if (!info) await runGit(workspace, ['init', '--quiet', `--object-format=${sha256 ? 'sha256' : 'sha1'}`], signal);
  await writeFile(join(metadata, 'config.host'), `[core]\nrepositoryformatversion = ${sha256 ? 1 : 0}\nfilemode = true\nbare = false\nlogallrefupdates = true\nhooksPath = /dev/null\n${sha256 ? '[extensions]\nobjectformat = sha256\n' : ''}`);
  await rename(join(metadata, 'config.host'), join(metadata, 'config'));
  // Never read a previous task's repository configuration when fetching. Rewrite all local config from known data.
  // The transport is supplied by the backend adapter; no machine IDs, tokens or remote paths belong here.
  await runGit(workspace, ['-c', 'protocol.version=2', '-c', 'http.followRedirects=false', '-c', 'core.hooksPath=/dev/null', 'fetch', '--no-tags', '--update-shallow', '--', source.url, `+${source.ref}:refs/coda/input`], signal, source);
  const actual = await runGit(workspace, ['rev-parse', 'refs/coda/input^{commit}'], signal);
  if (actual !== source.commit) throw new Error('源码 ref 与声明 commit 不一致');
  await runGit(workspace, ['-c', 'core.hooksPath=/dev/null', 'reset', '--hard', source.commit], signal);
  await runGit(workspace, ['clean', '-fd'], signal);
  return workspace;
}
