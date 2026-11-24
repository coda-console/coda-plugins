import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const scripts = fileURLToPath(new URL('../../../plugins/review/scripts/', import.meta.url));

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'review-delete-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin'), remote = join(root, 'remote.git'), fork = join(root, 'fork.git'), local = join(root, 'local'), summary = join(root, 'summary');
  const state = join(root, 'pr.json'), calls = join(root, 'gh.log'), config = join(root, 'gitconfig'), output = join(root, 'output');
  mkdirSync(bin); mkdirSync(local);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: config, GIT_CONFIG_COUNT: '0', GIT_CONFIG_PARAMETERS: '',
    URL: 'https://github.com/owner/repo/pull/5', RUNNER_TEMP: root, GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: output };
  writeFileSync(config, `[url "${remote}"]\n\tinsteadOf = https://github.com/owner/repo.git\n[url "${fork}"]\n\tinsteadOf = https://github.com/author/fork.git\n`);
  const git = (...args) => {
    const done = spawnSync('git', args, { cwd: local, env, encoding: 'utf8' });
    assert.equal(done.status, 0, done.stderr); return done.stdout.trim();
  };
  git('init', '--bare', '--quiet', remote);
  git('init', '--bare', '--quiet', fork);
  git('init', '--quiet', '-b', 'feature');
  const tree = git('mktree');
  const commit = message => {
    const done = spawnSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], { cwd: local, env, encoding: 'utf8',
      input: `tree ${tree}\nauthor Test <test@example.com> 1700000000 +0000\ncommitter Test <test@example.com> 1700000000 +0000\n\n${message}\n` });
    assert.equal(done.status, 0, done.stderr); return done.stdout.trim();
  };
  const head = commit('merged'), next = commit('new work');
  git('update-ref', 'refs/heads/feature', head);
  git('push', '--quiet', remote, 'feature', `${next}:refs/heads/next`, `${head}:refs/heads/main`);
  git('push', '--quiet', fork, 'feature', `${head}:refs/heads/main`);
  writeFileSync(join(local, 'unfinished.txt'), 'keep this work');
  env.HEAD = head;
  const pr = { merged: true, head: { sha: head, ref: 'feature', repo: 'owner/repo', main: 'main' }, base: { ref: 'main', repo: 'owner/repo' } };
  // Git is real, with HTTPS rewritten only for these two fixture repositories. gh supplies the PR's current state.
  writeFileSync(join(bin, 'gh'), `#!${process.execPath}\nimport { appendFileSync, readFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.env.GH_FAIL) { console.error(process.env.GH_FAIL); process.exit(1); }
console.log(process.argv[2] === 'api' ? readFileSync(${JSON.stringify(state)}, 'utf8') : 'merged');\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  const run = (script = 'delete-branch', extra = {}) => {
    writeFileSync(state, JSON.stringify(pr)); writeFileSync(summary, ''); writeFileSync(output, '');
    const done = spawnSync(process.execPath, [join(scripts, `${script}.mjs`)], { cwd: local, env: { ...env, ...extra }, encoding: 'utf8' });
    return { ...done, summary: readFileSync(summary, 'utf8'), outputs: readFileSync(output, 'utf8') };
  };
  const ref = (branch = 'feature', repo = remote) => git('ls-remote', repo, `refs/heads/${branch}`).split(/\s+/)[0];
  return { root, bin, remote, fork, local, head, next, pr, git, ref, run, calls };
}

test('deletes the merged remote branch, keeps local work, and can run again after deletion', t => {
  const c = setup(t);
  const done = c.run();
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.summary, /已删除远程分支 owner\/repo:feature/);
  assert.equal(c.ref(), '');
  assert.equal(c.git('rev-parse', 'HEAD'), c.head);
  assert.equal(readFileSync(join(c.local, 'unfinished.txt'), 'utf8'), 'keep this work');
  const again = c.run();
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.summary, /已不存在，无需删除/);
});

test('keeps a branch with later work, a default branch, and a merge target', t => {
  const c = setup(t);
  c.git('--git-dir', c.remote, 'update-ref', 'refs/heads/feature', c.next);
  assert.match(c.run().summary, /已有其他提交/);
  assert.equal(c.ref(), c.next);
  c.pr.head.ref = 'main';
  assert.match(c.run().summary, /默认分支或合并目标分支/);
  assert.equal(c.ref('main'), c.head);
  c.pr.head.ref = 'feature'; c.pr.base.ref = 'feature';
  assert.match(c.run().summary, /默认分支或合并目标分支/);
  assert.equal(c.ref(), c.next);
});

test('takes the source repository from a fork PR and tolerates a removed source repository', t => {
  const c = setup(t);
  c.pr.head.repo = 'author/fork';
  const done = c.run();
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.summary, /已删除远程分支 author\/fork:feature/);
  assert.equal(c.ref('feature', c.fork), '');
  assert.equal(c.ref(), c.head, 'the same branch name in the base repository is untouched');
  c.pr.head.repo = null;
  assert.match(c.run().summary, /源仓库已不存在/);
});

test('does not delete before merge, on a changed PR head, or when GitHub cannot be read', t => {
  const c = setup(t);
  c.pr.merged = false;
  assert.equal(c.run().status, 1);
  assert.equal(c.ref(), c.head);
  c.pr.merged = true; c.pr.head.sha = c.next;
  assert.match(c.run().summary, /源提交已变化/);
  assert.equal(c.ref(), c.head);
  c.pr.head.sha = c.head;
  const failed = c.run('delete-branch', { GH_FAIL: 'permission denied' });
  assert.equal(failed.status, 1);
  assert.match(failed.summary, /读不到 PR：permission denied/);
  assert.equal(c.ref(), c.head);
  delete c.pr.head;
  const incomplete = c.run();
  assert.equal(incomplete.status, 1);
  assert.match(incomplete.summary, /读不到 PR 的源分支和提交/);
  assert.equal(c.ref(), c.head);
});

test('a rejected deletion fails visibly, retaining the branch', t => {
  const c = setup(t), hook = join(c.remote, 'hooks/pre-receive');
  writeFileSync(hook, '#!/bin/sh\necho "branch protection" >&2\nexit 1\n'); chmodSync(hook, 0o755);
  const done = c.run();
  assert.equal(done.status, 1);
  assert.match(done.summary, /无法删除远程分支[\s\S]*branch protection/);
  assert.equal(c.ref(), c.head);
});

test('a push after the branch was read cannot have its new commit deleted', t => {
  const c = setup(t), realGit = join(c.git('--exec-path'), 'git');
  assert.ok(existsSync(realGit));
  // Move the remote just before the real push sees it: without the explicit lease this would delete the new work.
  const wrapper = join(c.bin, 'git');
  writeFileSync(wrapper, `#!${process.execPath}\nimport { spawnSync } from 'node:child_process';
if (process.argv[2] === 'push') {
  const moved = spawnSync(${JSON.stringify(realGit)}, ['--git-dir', ${JSON.stringify(c.remote)}, 'update-ref', 'refs/heads/feature', ${JSON.stringify(c.next)}], { stdio: 'inherit' });
  if (moved.status !== 0) process.exit(2);
}
const done = spawnSync(${JSON.stringify(realGit)}, process.argv.slice(2), { stdio: 'inherit' });
process.exit(done.status ?? 1);\n`);
  chmodSync(wrapper, 0o755);
  const done = c.run();
  assert.equal(done.status, 1);
  assert.match(done.summary, /无法删除远程分支/);
  assert.equal(c.ref(), c.next);
});

test('the approval keeps the selected cleanup for the workflow, and merging deletes nothing before confirmation', t => {
  const c = setup(t);
  // baseOf asks gh for these two fields; the same fixture can supply them alongside the PR fields.
  c.pr.base = 'main'; c.pr.main = 'main';
  for (const options of [{}, { deleteBranch: false }, { deleteBranch: true, notify: true }]) {
    const approved = c.run('approval', { APPROVED: JSON.stringify({ options }) });
    assert.equal(approved.status, 0, approved.stderr);
    assert.match(approved.outputs, new RegExp(`deleteBranch<<EOF_deleteBranch\n${options.deleteBranch === true}\nEOF_deleteBranch`));
    const done = c.run('merge', { WHAT: '合并' });
    assert.equal(done.status, 0, done.stderr);
    assert.equal(c.ref(), c.head);
  }
  const calls = readFileSync(c.calls, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(calls.filter(args => args[1] === 'merge').every(args => !args.includes('--delete-branch')));
  assert.equal(existsSync(join(c.local, 'unfinished.txt')), true);
});

test('the branch is removed from the PR\'s own host: the same owner/repo on another host is another repository', t => {
  const c = setup(t), config = join(c.root, 'gitconfig'), enterprise = join(c.root, 'enterprise.git'), third = join(c.root, 'third.git');
  c.git('init', '--bare', '--quiet', enterprise); c.git('init', '--bare', '--quiet', third);
  writeFileSync(config, `${readFileSync(config, 'utf8')}[url "${enterprise}"]\n\tinsteadOf = https://ghe.corp.internal/owner/repo.git\n[url "${third}"]\n\tinsteadOf = https://git.example.org/author/fork.git\n`);
  c.git('push', '--quiet', enterprise, 'feature');
  c.git('push', '--quiet', third, 'feature');
  const asked = () => readFileSync(c.calls, 'utf8').trim().split('\n').map(JSON.parse).at(-1);
  const done = c.run('delete-branch', { URL: 'https://ghe.corp.internal/owner/repo/pull/5' });
  assert.equal(done.status, 0, done.stderr);
  assert.deepEqual(asked().slice(0, 4), ['api', '--hostname', 'ghe.corp.internal', 'repos/owner/repo/pulls/5']);
  assert.equal(c.ref('feature', enterprise), '');
  assert.equal(c.ref(), c.head, 'github.com\'s owner/repo is untouched');
  // A fork on an Enterprise host: the host of the PR, not github.com's author/fork.
  c.pr.head.repo = 'author/fork';
  const fork = c.run('delete-branch', { URL: 'https://git.example.org/owner/repo/pull/5' });
  assert.equal(fork.status, 0, fork.stderr);
  assert.deepEqual(asked().slice(0, 3), ['api', '--hostname', 'git.example.org']);
  assert.equal(c.ref('feature', third), '');
  assert.equal(c.ref('feature', c.fork), c.head, 'github.com\'s author/fork is untouched');
  const github = c.run();
  assert.equal(github.status, 0, github.stderr);
  assert.deepEqual(asked().slice(0, 3), ['api', '--hostname', 'github.com']);
  assert.equal(c.ref('feature', c.fork), '');
});

test('nothing is asked or deleted for an address that is not a pull request, or a source repository that is a path', t => {
  const c = setup(t);
  for (const url of ['https://github.com/owner/repo/pull/5/', 'http://github.com/owner/repo/pull/5', 'https://github/owner/repo/pull/5',
    'https://github.com/owner/repo/pull/5?x=1', 'https://github.com/owner/repo/pull/0', 'https://github.com/../repo/pull/5']) {
    const done = c.run('delete-branch', { URL: url });
    assert.equal(done.status, 1, url);
    assert.match(done.summary, /不知道要删除哪个 PR/, url);
    assert.equal(existsSync(c.calls), false, url);
    assert.equal(c.ref(), c.head);
  }
  for (const repo of ['../repo', 'owner/..', './repo']) {
    c.pr.head.repo = repo;
    const done = c.run();
    assert.equal(done.status, 1, repo);
    assert.match(done.summary, /读不到源仓库或它的默认分支/, repo);
    assert.equal(c.ref(), c.head);
  }
});
