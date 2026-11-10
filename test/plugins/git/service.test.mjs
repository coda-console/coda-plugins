import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { fixture, command, env, host, idle } from './helpers.mjs';
import { GitProvider } from '../../../plugins/git/lib/provider.mjs';
import { SOURCE, SNAPSHOT, SERVICE } from '../../../plugins/git/lib/definitions.mjs';
import { repository } from '../../../plugins/git/lib/git.mjs';

const put = (h, kind, id, spec) => h.coda.protocols.put({ kind, id, spec });
const get = (h, kind, id) => h.objects.get(`${kind}/${id}`);
const snapshot = (h, input, context) => h.operations.get(JSON.stringify([SERVICE, 'snapshot']))(input, context);
const parent = { kind: 'workflow-runs', id: 'run' };

async function linkedWorktree(dir) {
  const linked = `${dir}-linked`;
  await command(dir, ['worktree', 'add', '-b', 'linked', linked]);
  return linked;
}

async function setup(t) {
  const dir = await fixture(t), linked = await linkedWorktree(dir);
  await mkdir(join(linked, 'sub'), { recursive: true });
  await writeFile(join(linked, 'tracked'), 'changed\n');
  await writeFile(join(linked, 'untracked'), 'new\n');
  await writeFile(join(linked, 'ignored'), 'secret\n');
  const h = host(join(dir, '.git', 'service-state'));
  const provider = new GitProvider(h.coda);
  t.after(async () => { await provider.stop(); await rm(linked, { recursive: true, force: true }); });
  await provider.start();
  h.run('run');
  return { dir, linked, h, provider };
}

test('工作树里的子目录拍快照：含改动与未跟踪文件，不含忽略文件，真实 index 与工作区不变', async t => {
  const { linked, h, provider } = await setup(t), repo = await repository(linked, env);
  const index = await readFile(join(repo.gitDir, 'index'));
  const before = await command(linked, ['status', '--porcelain=v1', '-uall']);
  const result = await snapshot(h, { path: join(linked, 'sub') }, { parent, requestId: 'request-1' });
  assert.equal(result.workingDirectory, 'sub');
  assert.equal(await command(linked, ['show', `${result.commit}:tracked`]), 'changed');
  assert.equal(await command(linked, ['show', `${result.commit}:untracked`]), 'new');
  assert.equal(await command(linked, ['ls-tree', result.commit, 'ignored']), '');
  assert.deepEqual(await readFile(join(repo.gitDir, 'index')), index);
  assert.equal(await command(linked, ['status', '--porcelain=v1', '-uall']), before);
  const item = get(h, SNAPSHOT, result.snapshot.id);
  assert.equal(item.status.ready, true);
  assert.equal(item.status.commit, result.commit);
  assert.equal(get(h, SOURCE, item.spec.source).status.ready, true);
  assert.ok(h.published.has(`${SOURCE}/${item.spec.source}`));
  assert.ok(h.published.has(`${SNAPSHOT}/${result.snapshot.id}`));
  assert.ok(get(h, SERVICE, 'git'));
  assert.ok(!h.published.has(`${SERVICE}/git`));
  assert.deepEqual(h.failures, []);
  await provider.stop();
});

test('同一个 requestId 再调一次得到同一个快照，不另建', async t => {
  const { linked, h, provider } = await setup(t);
  const first = await snapshot(h, { path: linked }, { parent, requestId: 'request-2' });
  await writeFile(join(linked, 'tracked'), 'after first call\n');
  const second = await snapshot(h, { path: linked }, { parent, requestId: 'request-2' });
  assert.equal(second.snapshot.id, first.snapshot.id);
  assert.equal(second.commit, first.commit);
  assert.equal([...h.objects.values()].filter(object => object.kind === SNAPSHOT).length, 1);
  await provider.stop();
});

test('运行结束后回收快照 ref、删除按需源，手动登记的源保留', async t => {
  const dir = await fixture(t), other = await fixture(t), h = host(join(dir, '.git', 'state'));
  const provider = new GitProvider(h.coda); t.after(() => provider.stop()); await provider.start();
  const linked = await linkedWorktree(dir); t.after(() => rm(linked, { recursive: true, force: true }));
  h.run('run');
  await put(h, SOURCE, 'manual', { path: other }); await idle(provider);
  const result = await snapshot(h, { path: linked }, { parent, requestId: 'request-3' });
  const item = get(h, SNAPSHOT, result.snapshot.id), ref = item.status.ref, sourceId = item.spec.source;
  h.run('run', 'succeeded'); await idle(provider);
  assert.equal(get(h, SNAPSHOT, result.snapshot.id).status.released, true);
  assert.equal(await command(linked, ['for-each-ref', ref]), '');
  assert.equal(get(h, SOURCE, sourceId), undefined);
  assert.ok(!h.published.has(`${SOURCE}/${sourceId}`));
  assert.equal(get(h, SOURCE, 'manual').status.ready, true);
  assert.deepEqual(h.failures, []);
  await provider.stop();
});

test('path 不在工作副本里、parent 不是流程运行时拒绝并说明原因', async t => {
  const dir = await fixture(t), h = host(join(dir, '.git', 'state'));
  const provider = new GitProvider(h.coda); t.after(() => provider.stop()); await provider.start();
  h.run('run');
  const notGit = await mkdtemp(join(tmpdir(), 'coda-not-git-')); t.after(() => rm(notGit, { recursive: true, force: true }));
  await assert.rejects(snapshot(h, { path: notGit }, { parent, requestId: 'request-4' }), /工作副本/);
  await assert.rejects(snapshot(h, { path: dir }, { parent: { kind: 'threads', id: 'thread' }, requestId: 'request-5' }),
    /workflow-runs|流程运行/);
  assert.equal([...h.objects.values()].filter(object => object.kind === SNAPSHOT).length, 0);
  assert.equal([...h.objects.values()].filter(object => object.kind === SOURCE).length, 0);
  await provider.stop();
});

test('回答里的快照可经只读 smart HTTP fetch', async t => {
  const { dir, linked, h, provider } = await setup(t);
  const result = await snapshot(h, { path: join(linked, 'sub') }, { parent, requestId: 'request-6' });
  const item = get(h, SNAPSHOT, result.snapshot.id);
  const server = createServer((req, res) => { void provider.http(req, res, { local: true }); });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const target = join(dir, 'client'); await mkdir(target); await command(target, ['init']);
  await command(target, ['-c', 'protocol.version=2', 'fetch', `${base}/repos/${item.spec.source}`,
    `${item.status.ref}:refs/heads/snapshot`]);
  assert.equal(await command(target, ['rev-parse', 'refs/heads/snapshot^{tree}']),
    await command(linked, ['rev-parse', `${result.commit}^{tree}`]));
  await provider.stop();
});
