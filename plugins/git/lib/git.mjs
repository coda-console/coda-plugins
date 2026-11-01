import { spawn } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';

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

export async function repository(path, env) {
  if (!isAbsolute(path) || path.includes('\0')) throw new Error('仓库路径须为本机绝对路径');
  const root = await realpath(path);
  const bare = await git(root, ['rev-parse', '--is-bare-repository'], { env }) === 'true';
  if (!bare && await realpath(await git(root, ['rev-parse', '--show-toplevel'], { env })) !== root)
    throw new Error('请登记工作副本根目录');
  const gitDir = await realpath(await git(root, ['rev-parse', '--absolute-git-dir'], { env }));
  const commonDir = await realpath(await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'], { env }));
  return { path: root, gitDir, commonDir, bare };
}

export function snapshotRef(token) {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('无效快照标识');
  return `refs/coda/snapshots/${token}`;
}

export async function createSnapshot(repo, spec, ref, env) {
  if (!/^refs\/coda\/snapshots\/[a-f0-9]{64}$/.test(ref)) throw new Error('无效快照引用');
  const parent = await git(repo.path, ['rev-parse', '--verify', '--end-of-options', `${spec.mode === 'commit' ? spec.commit : 'HEAD'}^{commit}`], { env });
  let commit = parent;
  if (spec.mode === 'worktree') {
    if (repo.bare) throw new Error('裸仓库没有工作树');
    const dir = await mkdtemp(join(tmpdir(), 'coda-git-index-'));
    try {
      const extra = { GIT_INDEX_FILE: join(dir, 'index') };
      await git(repo.path, ['read-tree', parent], { env, extra });
      await git(repo.path, ['-c', 'core.splitIndex=false', '-c', 'core.fileMode=true', '-c', 'core.symlinks=true', 'add', '-A', '--', '.'], { env, extra });
      const tree = await git(repo.path, ['write-tree'], { env, extra });
      // Use the parent identity, without changing repository/global user configuration.
      const [name, email] = (await git(repo.path, ['show', '-s', '--format=%an%n%ae', parent], { env })).split('\n');
      commit = await git(repo.path, ['commit-tree', tree, '-p', parent], { env,
        extra: { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email },
        input: 'Coda worktree snapshot\n' });
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
  await git(repo.path, ['update-ref', ref, commit], { env });
  return commit;
}

export async function removeSnapshot(repo, ref, env) {
  if (!/^refs\/coda\/snapshots\/[a-f0-9]{64}$/.test(ref)) throw new Error('无效快照引用');
  await git(repo.path, ['update-ref', '-d', ref], { env });
}
