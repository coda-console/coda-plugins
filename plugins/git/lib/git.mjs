import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

// Never inherit a caller's alternate index, repository, namespace or injected Git config.
export function gitEnvironment(environment = process.env, extra = {}) {
  return { ...Object.fromEntries(Object.entries(environment).filter(([key]) => !key.startsWith('GIT_'))),
    GIT_TERMINAL_PROMPT: '0', ...extra };
}

export function git(cwd, args, { env = process.env, extra = {}, input, accept = [0] } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['--no-optional-locks', '-C', cwd, ...args], { env: gitEnvironment(env, extra) });
    const out = [], err = [];
    child.stdout.on('data', chunk => out.push(chunk));
    child.stderr.on('data', chunk => err.push(chunk));
    child.on('error', reject);
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
    child.on('close', code => {
      const stdout = Buffer.concat(out).toString('utf8').trimEnd();
      if (accept.includes(code)) resolve(stdout);
      else reject(new Error(`git ${args[0]}: ${Buffer.concat(err).toString('utf8').trim() || `exit ${code}`}`));
    });
    child.stdin.end(input);
  });
}

export async function repository(path) {
  if (!isAbsolute(path) || path.includes('\0')) throw new Error('仓库路径须为本机绝对路径');
  const root = await realpath(path);
  const bare = await git(root, ['rev-parse', '--is-bare-repository']) === 'true';
  if (!bare && await realpath(await git(root, ['rev-parse', '--show-toplevel'])) !== root)
    throw new Error('请登记工作副本根目录');
  const gitDir = await realpath(await git(root, ['rev-parse', '--absolute-git-dir']));
  const commonDir = await realpath(await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  return { path: root, gitDir, commonDir, bare };
}
