import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { fixture, command, env, host } from './helpers.mjs';
import { GitProvider } from '../../../plugins/git/lib/provider.mjs';
import { SOURCE } from '../../../plugins/git/lib/definitions.mjs';
import { repository } from '../../../plugins/git/lib/git.mjs';
import { ProtocolTypes } from '../../../check/coda/components/protocols/types.mjs';
import { definitionProblem, ownedProtocolsProblem } from '@coda-console/protocol/protocol';
import '../../../check/coda/application/contributions.mjs';
import { readPlugin } from '../../../check/coda/components/plugins/plugin-rules.mjs';

const manifest = JSON.parse(readFileSync(new URL('../../../plugins/git/package.json', import.meta.url), 'utf8'));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const get = (h, id) => h.objects.get(`${SOURCE}/${id}`);
// The management routes, as a local Coda API caller reaches them.
async function request(provider, url, body = {}, { caller = { local: true }, method = 'POST' } = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]); req.url = url; req.method = method;
  let code, value;
  await provider.manage(req, { writeHead(status) { code = status; }, end(text) { value = JSON.parse(text); } }, caller);
  return { code, value };
}
async function register(provider, name, spec) {
  const { code, value } = await request(provider, `/sources/${name}`, { spec });
  assert.equal(code, 200, value.error);
  return value.id;
}
const remove = async (provider, name) => assert.equal((await request(provider, `/sources/${name}/delete`)).code, 200);

async function setup(t) {
  const dir = await fixture(t), h = host(join(dir, '.git', 'coda-state'));
  const provider = new GitProvider(h.coda); t.after(() => provider.stop()); await provider.start();
  const id = await register(provider, 'source', { path: dir }); await h.flush();
  return { dir, h, provider, id };
}

test('清单只有 git/source@1，定义合乎格式与命名空间，spec 有登记名，拒绝多余字段，只给预览渠道', () => {
  const dir = fileURLToPath(new URL('../../../plugins/git/', import.meta.url));
  assert.equal(ownedProtocolsProblem(manifest), null);
  const types = new ProtocolTypes();
  for (const definition of manifest.contributes.protocols) {
    assert.equal(definitionProblem(definition, { namespace: 'git', where: definition.name }), null);
    types.register({ kind: definition.name, spec: definition.spec, status: definition.status, participants: () => [] });
  }
  assert.deepEqual(manifest.contributes.protocols.map(definition => definition.name), [SOURCE]);
  assert.deepEqual(readPlugin(dir, { kind: 'git' }).protocolImplementations, [SOURCE]);
  assert.deepEqual(manifest.coda, { channels: ['preview'] });
  assert.equal(types.get(SOURCE).spec({ name: 'repo', path: '/tmp/repo' }), true);
  assert.equal(types.get(SOURCE).spec({ path: '/tmp/repo' }), false);
  assert.equal(types.get(SOURCE).spec({ name: 'a/b', path: '/tmp/repo' }), false);
  assert.equal(types.get(SOURCE).spec({ name: 'repo', path: '/tmp/repo', machine: 'remote' }), false);
});

test('登记的源以生成的 UUID 为 ID，名字写进 spec，就绪并发布读取地址；删除后不再可读', async t => {
  const { dir, h, provider, id } = await setup(t);
  assert.match(id, UUID);
  assert.deepEqual(get(h, id).spec, { path: dir, name: 'source' });
  assert.deepEqual(get(h, id).status, { ready: true, url: `/v1/plugins/git/services/repository/repos/${id}` });
  const repo = await provider.lookup(id), expected = await repository(dir, env);
  assert.deepEqual([repo.path, repo.gitDir, repo.commonDir], [expected.path, expected.gitDir, expected.commonDir]);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, '.git', 'coda-state', 'sources.json'), 'utf8')),
    { source: { id, identity: { path: expected.path, gitDir: expected.gitDir, commonDir: expected.commonDir } } });
  await remove(provider, 'source'); await h.flush();
  assert.equal(get(h, id), undefined);
  assert.equal(await provider.lookup(id), null);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, '.git', 'coda-state', 'sources.json'), 'utf8')), {});
  assert.deepEqual(h.failures, []);
});

test('登记的源经只读 smart HTTP 可 fetch 分支，快照 ref 不可取', async t => {
  const { dir, h, provider, id } = await setup(t);
  const hidden = await command(dir, ['commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'hidden']);
  const ref = `refs/coda/snapshots/${'e'.repeat(64)}`;
  await command(dir, ['update-ref', ref, hidden]);
  const server = createServer((req, res) => { void provider.http(req, res, { local: true }); });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/repos/${id}`;
  const target = join(dir, 'client'); await mkdir(target); await command(target, ['init']);
  await command(target, ['-c', 'protocol.version=2', 'fetch', url, 'refs/heads/main:refs/heads/main']);
  assert.equal(await command(target, ['rev-parse', 'main']), await command(dir, ['rev-parse', 'main']));
  assert.ok(!(await command(target, ['-c', 'protocol.version=2', 'ls-remote', url])).includes('refs/coda/'));
  await assert.rejects(command(target, ['-c', 'protocol.version=2', 'fetch', url, `${ref}:refs/heads/hidden`]));
  assert.deepEqual(h.failures, []);
});

test('管理接口按名字、仅接受本机身份，更新整份 spec 并保留 status，错误符合 coda.api 信封，不再有 /snapshots、/publish', async t => {
  const { dir, h, provider, id } = await setup(t);
  assert.equal((await request(provider, '/sources/foreign', { spec: { path: dir } }, { caller: { role: 'backend', device: 'backend:test' } })).code, 403);
  assert.equal((await request(provider, '/sources/foreign', { spec: { path: dir } }, { caller: { role: 'client', device: 'phone' } })).code, 403);
  assert.deepEqual([...h.objects.keys()], [`${SOURCE}/${id}`]);
  const old = get(h, id);
  assert.equal(await register(provider, 'source', { path: dir }), id);
  assert.deepEqual(get(h, id), old);
  const refused = await request(provider, '/sources/source', { spec: { path: join(dir, 'missing') } });
  assert.equal(refused.code, 400); assert.deepEqual(get(h, id), old);
  const second = await register(provider, 'second', { path: dir });
  await h.flush();
  assert.match(second, UUID); assert.notEqual(second, id);
  assert.deepEqual(get(h, second).spec, { path: dir, name: 'second' }); assert.equal(get(h, second).status.ready, true);
  const read = await request(provider, '/sources/second', {}, { method: 'GET' });
  assert.equal(read.code, 200); assert.equal(read.value.id, second); assert.equal(read.value.spec.name, 'second');
  await remove(provider, 'second');
  assert.equal(get(h, second), undefined);
  assert.equal((await request(provider, '/sources/second', {}, { method: 'GET' })).code, 404);
  assert.equal((await request(provider, '/sources/second/delete')).code, 404);
  assert.notEqual(await register(provider, 'second', { path: dir }), second);
  assert.equal((await request(provider, '/sources/source/publish', { enabled: true })).code, 404);
  assert.equal((await request(provider, '/snapshots/job', { spec: {} })).code, 404);
});

test('同名的两个首次登记同时到达，只生成一个 UUID、一条记录，名字表与之一致', async t => {
  const dir = await fixture(t), h = host(join(dir, '.git', 'coda-state'));
  const provider = new GitProvider(h.coda); t.after(() => provider.stop()); await provider.start();
  const [first, second] = await Promise.all([register(provider, 'source', { path: dir }), register(provider, 'source', { path: dir })]);
  await h.flush();
  assert.equal(second, first);
  assert.deepEqual([...h.objects.keys()], [`${SOURCE}/${first}`]);
  assert.equal(provider.names.get('source').id, first);
  assert.equal(get(h, first).status.ready, true);
  await remove(provider, 'source'); await h.flush();
  assert.equal(h.objects.size, 0);
  assert.deepEqual(h.failures, []);
});

test('源路径暂时失效时不可读，恢复后复用原身份重新就绪', async t => {
  const dir = await fixture(t), path = join(dir, '.git', 'source-link');
  await symlink(dir, path);
  const h = host(join(dir, '.git', 'state'));
  const provider = new GitProvider(h.coda); t.after(() => provider.stop()); await provider.start();
  const id = await register(provider, 'source', { path }); await h.flush();
  assert.equal(get(h, id).status.ready, true);
  await unlink(path); await provider.reconcile(provider.sources.get(id)); await h.flush();
  assert.equal(get(h, id).status.ready, false);
  assert.equal(await provider.lookup(id), null);
  await symlink(dir, path); await provider.reconcile(provider.sources.get(id)); await h.flush();
  assert.equal(get(h, id).status.ready, true);
  assert.ok(await provider.lookup(id));
});

test('源符号链接换仓库后拒绝读取，重启仍须重新登记', async t => {
  const a = await fixture(t), b = await fixture(t), path = join(a, '.git', 'source-link');
  await symlink(a, path);
  const h = host(join(a, '.git', 'state'));
  const provider = new GitProvider(h.coda); t.after(() => provider.stop()); await provider.start();
  const id = await register(provider, 'source', { path }); await h.flush();
  assert.equal(get(h, id).status.ready, true);
  await unlink(path); await symlink(b, path);
  assert.equal(await provider.lookup(id), null);
  await provider.reconcile(provider.sources.get(id)); await h.flush();
  assert.equal(get(h, id).status.ready, false);
  assert.match(get(h, id).status.reason, /重新登记/);
  assert.equal(await provider.lookup(id), null);
  await provider.stop();
  const restarted = new GitProvider(h.coda); t.after(() => restarted.stop()); await restarted.start(); await h.flush();
  assert.equal(get(h, id).status.ready, false);
  assert.equal(await restarted.lookup(id), null);
  await remove(restarted, 'source');
  const again = await register(restarted, 'source', { path }); await h.flush();
  assert.notEqual(again, id);
  assert.equal(get(h, again).status.ready, true);
  assert.equal((await restarted.lookup(again)).path, (await repository(b, env)).path);
  assert.deepEqual(h.failures, []);
});

test('删除后同名、同 spec 重新登记是新 ID 的新源，旧源迟到的结果不改新源', async t => {
  const { dir, h, provider, id } = await setup(t);
  const old = provider.sources.get(id), environment = h.coda.environment;
  let fail; h.coda.environment = () => new Promise((_, reject) => { fail = reject; });
  const late = provider.reconcile(old);
  h.coda.environment = environment;
  await remove(provider, 'source');
  const again = await register(provider, 'source', { path: dir }); await h.flush();
  assert.notEqual(again, id);
  assert.equal(get(h, again).status.ready, true);
  fail(new Error('late')); await late;
  assert.equal(get(h, id), undefined);
  assert.equal(get(h, again).status.ready, true);
  assert.ok(await provider.lookup(again));
  await h.flush();
});

for (const name of ['constructor', '__proto__']) test(`源名为 ${name} 也是普通名字：登记、删后重登、重启都认得`, async t => {
  const dir = await fixture(t), h = host(join(dir, '.git', 'coda-state'));
  const provider = new GitProvider(h.coda); t.after(() => provider.stop()); await provider.start();
  const id = await register(provider, name, { path: dir }); await h.flush();
  assert.equal(get(h, id).status.ready, true);
  await remove(provider, name);
  const again = await register(provider, name, { path: dir }); await h.flush();
  assert.equal(get(h, again).status.ready, true);
  await provider.stop();
  const restarted = new GitProvider(h.coda); t.after(() => restarted.stop()); await restarted.start(); await h.flush();
  assert.equal(get(h, again).status.ready, true);
  assert.equal((await restarted.lookup(again)).path, (await repository(dir, env)).path);
  assert.equal((await request(restarted, `/sources/${name}`, {}, { method: 'GET' })).value.id, again);
  assert.deepEqual(h.failures, []);
});

test('首次登记的 reconcile 还在等时再写相同 spec，不作废它，源照常就绪', async t => {
  const dir = await fixture(t), h = host(join(dir, '.git', 'coda-state'));
  const provider = new GitProvider(h.coda); t.after(() => provider.stop()); await provider.start();
  const environment = h.coda.environment; let entered, release, calls = 0;
  const waiting = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  // The first call is the registration's own check of the path; the second, the reconcile its record sets off.
  h.coda.environment = async () => { if (++calls === 1) return env; h.coda.environment = environment; entered(); await gate; return env; };
  const id = await register(provider, 'source', { path: dir }); await waiting;
  assert.equal(await register(provider, 'source', { path: dir }), id);
  release(); await h.flush();
  assert.equal(get(h, id).status.ready, true);
  assert.ok(await provider.lookup(id));
  assert.deepEqual(h.failures, []);
});

test('启动时仓库不可用的源，修好后以相同 spec 再登记即重新核对为就绪', async t => {
  const dir = await fixture(t), state = await mkdtemp(join(tmpdir(), 'coda-git-state-')), h = host(state);
  t.after(() => rm(state, { recursive: true, force: true }));
  const first = new GitProvider(h.coda); await first.start();
  const id = await register(first, 'source', { path: dir }); await h.flush();
  assert.equal(get(h, id).status.ready, true);
  await first.stop();
  await rename(join(dir, '.git'), join(dir, '.git-away'));
  const provider = new GitProvider(h.coda); t.after(() => provider.stop()); await provider.start(); await h.flush();
  assert.equal(get(h, id).status.ready, false);
  assert.equal(await provider.lookup(id), null);
  await rename(join(dir, '.git-away'), join(dir, '.git'));
  assert.equal(await register(provider, 'source', { path: dir }), id);
  await h.flush();
  assert.equal(get(h, id).status.ready, true);
  assert.ok(await provider.lookup(id));
  assert.deepEqual(h.failures, []);
});

test('收到自己写 status 的回声不再核对：只有新记录或 spec 变了才核对', async t => {
  const dir = await fixture(t), h = host(join(dir, '.git', 'coda-state'));
  const provider = new GitProvider(h.coda); t.after(() => provider.stop()); await provider.start();
  const environment = h.coda.environment; let calls = 0;
  h.coda.environment = () => { calls++; return environment(); };
  const id = await register(provider, 'source', { path: dir }); await h.flush();
  // The registration's check of the path and the reconcile of the new record; the echo of the ready status sets off none.
  assert.equal(calls, 2);
  assert.equal(get(h, id).status.ready, true);
  const status = { ready: false, reason: 'written elsewhere' };
  await h.coda.put({ kind: SOURCE, id }, { spec: get(h, id).spec, status }); await h.flush();
  assert.equal(calls, 2);
  assert.deepEqual(get(h, id).status, status);
  assert.deepEqual(h.failures, []);
});

test('启动时按现有的源裁剪名字表；表里没有的记录（旧版留下的）当作没有，同名可登记另一仓库', async t => {
  const a = await fixture(t), b = await fixture(t), state = await mkdtemp(join(tmpdir(), 'coda-git-state-')), h = host(state);
  t.after(() => rm(state, { recursive: true, force: true }));
  const file = join(state, 'sources.json'), identity = await repository(a, env);
  const gone = '0b6f3c52-8d4e-4a1f-9c27-5e8a3d1b6f40', left = '7d2e9a14-3c5b-4f86-a1d0-c94b2e6f8a37';
  await writeFile(file, JSON.stringify({ gone: { id: gone, identity: { path: identity.path, gitDir: identity.gitDir, commonDir: identity.commonDir } } }));
  await h.coda.put({ kind: SOURCE, id: left }, { spec: { name: 'left', path: a } });
  const provider = new GitProvider(h.coda); t.after(() => provider.stop()); await provider.start(); await h.flush();
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {});
  assert.deepEqual(get(h, left).status, {});
  assert.equal(await provider.lookup(left), null);
  const id = await register(provider, 'gone', { path: b }); await h.flush();
  assert.notEqual(id, gone);
  assert.equal(get(h, id).status.ready, true);
  assert.equal((await provider.lookup(id)).path, (await repository(b, env)).path);
  assert.deepEqual(h.failures, []);
});
