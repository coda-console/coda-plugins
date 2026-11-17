import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { mkdir, symlink, unlink } from 'node:fs/promises';
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
const put = (h, id, spec) => h.coda.put({ kind: SOURCE, id }, { spec });
const get = (h, id) => h.objects.get(`${SOURCE}/${id}`);

async function setup(t) {
  const dir = await fixture(t), h = host(join(dir, '.git', 'coda-state'));
  const provider = new GitProvider(h.coda); t.after(() => provider.stop()); await provider.start();
  await put(h, 'source', { path: dir }); await h.flush();
  return { dir, h, provider };
}

test('清单只有 git/source@1，定义合乎格式与命名空间，拒绝多余字段，只给预览渠道', () => {
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
  assert.equal(types.get(SOURCE).spec({ path: '/tmp/repo' }), true);
  assert.equal(types.get(SOURCE).spec({ path: '/tmp/repo', machine: 'remote' }), false);
});

test('登记的源就绪并发布读取地址；删除后不再可读', async t => {
  const { dir, h, provider } = await setup(t);
  assert.deepEqual(get(h, 'source').status, { ready: true, url: '/v1/plugins/git/services/repository/repos/source' });
  const repo = await provider.lookup('source'), expected = await repository(dir, env);
  assert.deepEqual([repo.path, repo.gitDir, repo.commonDir], [expected.path, expected.gitDir, expected.commonDir]);
  await h.coda.delete({ kind: SOURCE, id: 'source' }); await h.flush();
  assert.equal(await provider.lookup('source'), null);
  assert.deepEqual(h.failures, []);
});

test('登记的源经只读 smart HTTP 可 fetch 分支，快照 ref 不可取', async t => {
  const { dir, h, provider } = await setup(t);
  const hidden = await command(dir, ['commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'hidden']);
  const ref = `refs/coda/snapshots/${'e'.repeat(64)}`;
  await command(dir, ['update-ref', ref, hidden]);
  const server = createServer((req, res) => { void provider.http(req, res, { local: true }); });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/repos/source`;
  const target = join(dir, 'client'); await mkdir(target); await command(target, ['init']);
  await command(target, ['-c', 'protocol.version=2', 'fetch', url, 'refs/heads/main:refs/heads/main']);
  assert.equal(await command(target, ['rev-parse', 'main']), await command(dir, ['rev-parse', 'main']));
  assert.ok(!(await command(target, ['-c', 'protocol.version=2', 'ls-remote', url])).includes('refs/coda/'));
  await assert.rejects(command(target, ['-c', 'protocol.version=2', 'fetch', url, `${ref}:refs/heads/hidden`]));
  assert.deepEqual(h.failures, []);
});

test('管理接口仅接受本机身份，更新整份 spec 并保留 status，错误符合 coda.api 信封，不再有 /snapshots、/publish', async t => {
  const { dir, h, provider } = await setup(t);
  const request = async (caller, url, body, method = 'POST') => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]); req.url = url; req.method = method;
    let code, value;
    await provider.manage(req, { writeHead(status) { code = status; }, end(text) { value = JSON.parse(text); } }, caller);
    return { code, value };
  };
  assert.equal((await request({ role: 'backend', device: 'backend:test' }, '/sources/foreign', { spec: { path: dir } })).code, 403);
  assert.equal((await request({ role: 'client', device: 'phone' }, '/sources/foreign', { spec: { path: dir } })).code, 403);
  assert.equal(get(h, 'foreign'), undefined);
  const old = get(h, 'source');
  assert.equal((await request({ local: true }, '/sources/source', { spec: { path: dir } })).code, 200);
  assert.deepEqual(get(h, 'source'), old);
  const refused = await request({ local: true }, '/sources/source', { spec: { path: join(dir, 'missing') } });
  assert.equal(refused.code, 400); assert.deepEqual(get(h, 'source'), old);
  assert.equal((await request({ local: true }, '/sources/second', { spec: { path: dir } })).code, 200);
  await h.flush();
  assert.equal(get(h, 'second').spec.path, dir); assert.equal(get(h, 'second').status.ready, true);
  assert.equal((await request({ local: true }, '/sources/second/delete', {})).code, 200);
  assert.equal(get(h, 'second'), undefined);
  assert.equal((await request({ local: true }, '/sources/source/publish', { enabled: true })).code, 404);
  assert.equal((await request({ local: true }, '/snapshots/job', { spec: {} })).code, 404);
});

test('源路径暂时失效时不可读，恢复后复用原身份重新就绪', async t => {
  const dir = await fixture(t), path = join(dir, '.git', 'source-link');
  await symlink(dir, path);
  const h = host(join(dir, '.git', 'state'));
  const provider = new GitProvider(h.coda); t.after(() => provider.stop()); await provider.start();
  await put(h, 'source', { path }); await h.flush();
  assert.equal(get(h, 'source').status.ready, true);
  await unlink(path); await provider.reconcile(provider.sources.get('source')); await h.flush();
  assert.equal(get(h, 'source').status.ready, false);
  assert.equal(await provider.lookup('source'), null);
  await symlink(dir, path); await provider.reconcile(provider.sources.get('source')); await h.flush();
  assert.equal(get(h, 'source').status.ready, true);
  assert.ok(await provider.lookup('source'));
});

test('源符号链接换仓库后拒绝读取，重启仍须重新登记', async t => {
  const a = await fixture(t), b = await fixture(t), path = join(a, '.git', 'source-link');
  await symlink(a, path);
  const h = host(join(a, '.git', 'state'));
  const provider = new GitProvider(h.coda); t.after(() => provider.stop()); await provider.start();
  await put(h, 'source', { path }); await h.flush();
  assert.equal(get(h, 'source').status.ready, true);
  await unlink(path); await symlink(b, path);
  assert.equal(await provider.lookup('source'), null);
  await provider.reconcile(provider.sources.get('source')); await h.flush();
  assert.equal(get(h, 'source').status.ready, false);
  assert.match(get(h, 'source').status.reason, /重新登记/);
  assert.equal(await provider.lookup('source'), null);
  await provider.stop();
  const restarted = new GitProvider(h.coda); t.after(() => restarted.stop()); await restarted.start(); await h.flush();
  assert.equal(get(h, 'source').status.ready, false);
  assert.equal(await restarted.lookup('source'), null);
  await h.coda.delete({ kind: SOURCE, id: 'source' }); await put(h, 'source', { path }); await h.flush();
  assert.equal(get(h, 'source').status.ready, true);
  assert.equal((await restarted.lookup('source')).path, (await repository(b, env)).path);
  assert.deepEqual(h.failures, []);
});

test('删除后以同 ID、同 spec 重建，旧源迟到的结果不改新源', async t => {
  const { dir, h, provider } = await setup(t);
  const old = provider.sources.get('source'), environment = h.coda.environment;
  let fail; h.coda.environment = () => new Promise((_, reject) => { fail = reject; });
  const late = provider.reconcile(old);
  h.coda.environment = environment;
  await h.coda.delete({ kind: SOURCE, id: 'source' }); await put(h, 'source', { path: dir }); await h.flush();
  assert.equal(get(h, 'source').status.ready, true);
  fail(new Error('late')); await late;
  assert.equal(get(h, 'source').status.ready, true);
  assert.ok(await provider.lookup('source'));
  await h.flush();
});
