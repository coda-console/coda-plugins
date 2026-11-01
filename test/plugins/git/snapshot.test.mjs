import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, chmod, symlink, lstat, readlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, command, env } from './helpers.mjs';
import { repository, createSnapshot, removeSnapshot, snapshotRef } from '../../../plugins/git/lib/git.mjs';

// Real plumbing is the lowest layer that can prove index, file modes and symlink preservation.
test('工作树快照含脏文件/未跟踪/执行位/符号链接，忽略文件除外；真实 index 与工作区不变', async t => {
  const dir = await fixture(t), repo = await repository(dir, env);
  await writeFile(join(dir, 'tracked'), 'staged\n'); await command(dir, ['add', 'tracked']);
  await writeFile(join(dir, 'tracked'), 'unstaged\n');
  await writeFile(join(dir, 'new'), 'untracked\n');
  await writeFile(join(dir, 'exec'), '#!/bin/sh\nexit 0\n'); await chmod(join(dir, 'exec'), 0o755);
  await symlink('tracked', join(dir, 'link')); await writeFile(join(dir, 'ignored'), 'secret\n');
  const index = await readFile(join(repo.gitDir, 'index')), before = await command(dir, ['status', '--porcelain=v1', '-uall']);
  const parent = await command(dir, ['rev-parse', 'HEAD']), ref = snapshotRef('a'.repeat(64));
  const commit = await createSnapshot(repo, { mode: 'worktree' }, ref, env);
  assert.equal(await command(dir, ['show', `${commit}:tracked`]), 'unstaged');
  assert.equal(await command(dir, ['show', `${commit}:new`]), 'untracked');
  assert.match(await command(dir, ['ls-tree', commit, 'exec']), /^100755 blob/);
  assert.match(await command(dir, ['ls-tree', commit, 'link']), /^120000 blob/);
  assert.equal(await command(dir, ['show', `${commit}:link`]), 'tracked');
  assert.equal(await command(dir, ['ls-tree', commit, 'ignored']), '');
  assert.equal(await command(dir, ['rev-parse', `${commit}^`]), parent);
  assert.equal(await command(dir, ['rev-parse', 'HEAD']), parent);
  assert.deepEqual(await readFile(join(repo.gitDir, 'index')), index);
  assert.equal(await command(dir, ['status', '--porcelain=v1', '-uall']), before);
  assert.equal(await readFile(join(dir, 'tracked'), 'utf8'), 'unstaged\n');
  assert.equal(await readlink(join(dir, 'link')), 'tracked'); assert.ok((await lstat(join(dir, 'exec'))).mode & 0o111);
  await removeSnapshot(repo, ref, env); assert.equal(await command(dir, ['for-each-ref', ref]), '');
});

test('提交快照固定所选提交，linked worktree 的真实 index 不变', async t => {
  const dir = await fixture(t), linked = `${dir}-linked`;
  t.after(() => rm(linked, { recursive: true, force: true }));
  await command(dir, ['worktree', 'add', '-b', 'linked', linked]);
  const repo = await repository(linked, env), index = await readFile(join(repo.gitDir, 'index'));
  await writeFile(join(linked, 'new'), 'local');
  const head = await command(dir, ['rev-parse', 'HEAD']);
  const ref = snapshotRef('b'.repeat(64));
  assert.equal(await createSnapshot(repo, { mode: 'commit', commit: head }, ref, env), head);
  const dirty = await createSnapshot(repo, { mode: 'worktree' }, snapshotRef('c'.repeat(64)), env);
  assert.equal(await command(dir, ['show', `${dirty}:new`]), 'local');
  assert.deepEqual(await readFile(join(repo.gitDir, 'index')), index);
});
