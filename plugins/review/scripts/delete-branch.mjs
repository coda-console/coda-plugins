// After GitHub confirms the merge, remove the source branch the user chose to delete. Read the source repository from
// the PR (it may be a fork), and lease the exact reviewed commit so later pushes cannot be deleted. An isolated bare
// repository lets the checkout-free step use Git without touching the session's local branches or worktrees.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { summary } from './step.mjs';

const say = text => { console.log(text); summary(text); };
const reason = done => (done.stderr || done.stdout || done.error?.message || `退出码 ${done.status}`).trim();

let dir;
try {
  const at = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\/?$/.exec(process.env.URL ?? '');
  const head = process.env.HEAD;
  if (!at || !/^[0-9a-f]{40,64}$/.test(head ?? '')) throw new Error('不知道要删除哪个 PR 的哪个提交的远程分支');
  const asked = spawnSync('gh', ['api', `repos/${at[1]}/pulls/${at[2]}`, '--jq',
    '{merged, head: {sha: .head.sha, ref: .head.ref, repo: .head.repo.full_name, main: .head.repo.default_branch}, base: {ref: .base.ref, repo: .base.repo.full_name}}'], { encoding: 'utf8' });
  if (asked.status !== 0) throw new Error(`读不到 PR：${reason(asked)}`);
  const pr = JSON.parse(asked.stdout);
  if (pr.merged !== true) throw new Error('PR 尚未合并');
  if (!pr.head?.ref || !/^[0-9a-f]{40,64}$/.test(pr.head.sha ?? '')) throw new Error('读不到 PR 的源分支和提交');
  if (pr.head.repo === null) {
    say('PR 的源仓库已不存在，无需删除远程分支。');
  } else if (pr.head.sha !== head) {
    say('保留远程分支：PR 的源提交已变化，不是这次批准合并的提交。');
  } else if (pr.head.ref === pr.head.main || (pr.head.repo === pr.base?.repo && pr.head.ref === pr.base.ref)) {
    say(`保留远程分支 ${pr.head.repo}:${pr.head.ref}：它是默认分支或合并目标分支。`);
  } else {
    if (!/^[\w.-]+\/[\w.-]+$/.test(pr.head.repo) || !pr.head.main) throw new Error('读不到源仓库或它的默认分支');
    const ref = `refs/heads/${pr.head.ref}`, remote = `https://github.com/${pr.head.repo}.git`, branch = `${pr.head.repo}:${pr.head.ref}`;
    const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (git('check-ref-format', ref).status !== 0) throw new Error('源分支名无效');
    dir = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'review-delete-branch-'));
    const init = git('init', '--bare', '--quiet');
    if (init.status !== 0) throw new Error(`无法准备删除分支：${reason(init)}`);
    const listed = git('ls-remote', '--exit-code', remote, ref);
    if (listed.status === 2) {
      say(`远程分支 ${branch} 已不存在，无需删除。`);
    } else if (listed.status !== 0) {
      throw new Error(`读不到远程分支 ${branch}：${reason(listed)}`);
    } else if (listed.stdout.trim().split(/\s+/)[0] !== head) {
      say(`保留远程分支 ${branch}：它已有其他提交，不再指向合并时的 ${head.slice(0, 12)}。`);
    } else {
      const deleted = git('push', '--porcelain', '--no-follow-tags', `--force-with-lease=${ref}:${head}`, remote, `:${ref}`);
      if (deleted.status !== 0) throw new Error(`无法删除远程分支 ${branch}：${reason(deleted)}`);
      say(`已删除远程分支 ${branch}（${head.slice(0, 12)}）。本地分支和工作树保留。`);
    }
  }
} catch (error) {
  const text = `删除远程分支未完成：${error.message}`;
  console.error(text); summary(text); process.exitCode = 1;
} finally {
  if (dir) rmSync(dir, { recursive: true, force: true });
}
