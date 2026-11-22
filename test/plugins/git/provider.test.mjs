import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fixture, command, gateway, host } from './helpers.mjs';
import { GitProvider } from '../../../plugins/git/lib/provider.mjs';
import { SOURCE } from '../../../plugins/git/lib/definitions.mjs';
import { repository } from '../../../plugins/git/lib/git.mjs';
import { ProtocolTypes } from '../../../check/coda/components/protocols/types.mjs';
import { definitionProblem, ownedProtocolsProblem } from '@coda-console/protocol/protocol';
import '../../../check/coda/application/contributions.mjs';
import { readPlugin } from '../../../check/coda/components/plugins/plugin-rules.mjs';
import { usesRefusal } from '../../../check/coda/components/plugins/plugin-extensions.mjs';
import { createTestHost } from '../../../check/coda/adapters/plugin-test-host.mjs';

const manifest = JSON.parse(readFileSync(new URL('../../../plugins/git/package.json', import.meta.url), 'utf8'));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const get = (h, id) => h.objects.get(`${SOURCE}/${id}`);
// The management routes of the service, as its callers reach them.
async function request(h, url, body = {}, { caller = { local: true }, method = 'POST' } = {}) {
  const response = await h.served.serve('repository', new Request(`http://service${url}`, { method,
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) }), { caller });
  return { code: response.status, value: await response.json() };
}
const address = id => `/v1/records/git%2Fsource%401/${id}/streams/transport`;
async function register(h, name, spec) {
  const { code, value } = await request(h, `/sources/${name}`, { spec });
  assert.equal(code, 200, value.error);
  return value.id;
}
const remove = async (h, name) => assert.equal((await request(h, `/sources/${name}/delete`)).code, 200);

async function setup(t) {
  const dir = await fixture(t), h = host(t, join(dir, '.git', 'coda-state'));
  const provider = new GitProvider(h.coda); t.after(() => provider.stop()); await provider.start();
  const id = await register(h, 'source', { path: dir });
  return { dir, h, provider, id };
}

test('清单只有 git/source@1，定义合乎格式与命名空间，spec 有登记名，拒绝多余字段，流 transport 归权限组 fetch，只给预览渠道', () => {
  const dir = fileURLToPath(new URL('../../../plugins/git/', import.meta.url));
  assert.equal(ownedProtocolsProblem(manifest), null);
  const types = new ProtocolTypes();
  for (const definition of manifest.contributes.protocols) {
    assert.equal(definitionProblem(definition, { namespace: 'git', where: definition.name }), null);
    types.register({ kind: definition.name, spec: definition.spec, status: definition.status, participants: () => [] });
  }
  assert.deepEqual(manifest.contributes.protocols.map(definition => definition.name), [SOURCE]);
  assert.deepEqual(readPlugin(dir, { kind: 'git' }).protocolImplementations, [{ kind: SOURCE, commands: {} }]);
  assert.deepEqual(manifest.coda, { channels: ['preview'] });
  const [{ streams, permissions }] = manifest.contributes.protocols;
  assert.deepEqual(Object.entries(streams).map(([name, { shape, subprotocol, input }]) => ({ name, shape, subprotocol, input })),
    [{ name: 'transport', shape: 'http', subprotocol: 'git-smart-http/2', input: { type: 'object', additionalProperties: false } }]);
  assert.deepEqual(permissions, { fetch: { title: '读取 Git 源和它的代码', read: true, streams: ['transport'] } });
  assert.equal(manifest.engines.coda, 14);
  assert.equal(types.get(SOURCE).spec({ name: 'repo', path: '/tmp/repo' }), true);
  assert.equal(types.get(SOURCE).spec({ path: '/tmp/repo' }), false);
  assert.equal(types.get(SOURCE).spec({ name: 'a/b', path: '/tmp/repo' }), false);
  assert.equal(types.get(SOURCE).spec({ name: 'repo', path: '/tmp/repo', machine: 'remote' }), false);
});

test('别的插件只声明 fetch 就能读到记录和 status.url、也能开流；没声明的都不行', async t => {
  const { protocols } = manifest.contributes, id = '7d2e9a14-3c5b-4f86-a1d0-c94b2e6f8a37';
  const reader = declared => {
    const plugin = { id: 'reader', ...declared };
    const host = createTestHost({ plugin, protocols, records: [{ kind: SOURCE, id, plugin: 'git',
      spec: { name: 'source', path: '/repository' }, status: { ready: true, url: address(id) } }] });
    t.after(() => host.close());
    // The test host's `permit` covers reading records; a stream is judged by the same rule.
    return { coda: host.coda, stream: usesRefusal(plugin, SOURCE, { stream: 'transport' }, protocols[0]) };
  };
  for (const key of ['uses', 'optionalUses']) {
    const { coda, stream } = reader({ [key]: { [SOURCE]: ['fetch'] } }), seen = [];
    assert.equal((await coda.get({ kind: SOURCE, id })).status.url, address(id));
    await coda.watch(SOURCE, event => seen.push([event.type, event.entry.status.url]));
    assert.deepEqual(seen, [['ADDED', address(id)]]);
    assert.equal(stream, null);
  }
  const { coda, stream } = reader({});
  const refused = { code: 'forbidden', message: /权限组 fetch$/ };
  await assert.rejects(coda.get({ kind: SOURCE, id }), refused);
  await assert.rejects(coda.watch(SOURCE, () => {}), refused);
  assert.match(stream, /读 git\/source@1 的流 transport，.*权限组 fetch$/);
});

test('登记的源以名字为 key，ID 是宿主由它派生的，名字也写进 spec，就绪并发布读取地址；删除后不再可读', async t => {
  const { dir, h, provider, id } = await setup(t);
  assert.equal(id, h.id('source')); assert.match(id, UUID);
  assert.equal(get(h, id).key, 'source');
  assert.deepEqual(get(h, id).spec, { path: dir, name: 'source' });
  assert.deepEqual(get(h, id).status, { ready: true, url: address(id) });
  const repo = await provider.lookup(id), expected = await repository(dir);
  assert.deepEqual([repo.path, repo.gitDir, repo.commonDir], [expected.path, expected.gitDir, expected.commonDir]);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, '.git', 'coda-state', 'sources.json'), 'utf8')),
    { version: 2, sources: { source: { spec: { path: dir, name: 'source' }, identity: { path: expected.path, gitDir: expected.gitDir, commonDir: expected.commonDir } } } });
  await remove(h, 'source');
  assert.equal(get(h, id), undefined);
  assert.equal(await provider.lookup(id), null);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, '.git', 'coda-state', 'sources.json'), 'utf8')), { version: 2, sources: {} });
});

test('登记的源经只读 smart HTTP 可 fetch 分支，快照 ref 不可取', async t => {
  const { dir, h, provider, id } = await setup(t);
  const hidden = await command(dir, ['commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'hidden']);
  const ref = `refs/coda/snapshots/${'e'.repeat(64)}`;
  await command(dir, ['update-ref', ref, hidden]);
  const { base } = await gateway(t, h.served), url = base + get(h, id).status.url;
  const target = join(dir, 'client'); await mkdir(target); await command(target, ['init']);
  await command(target, ['-c', 'protocol.version=2', 'fetch', url, 'refs/heads/main:refs/heads/main']);
  assert.equal(await command(target, ['rev-parse', 'main']), await command(dir, ['rev-parse', 'main']));
  assert.ok(!(await command(target, ['-c', 'protocol.version=2', 'ls-remote', url])).includes('refs/coda/'));
  await assert.rejects(command(target, ['-c', 'protocol.version=2', 'fetch', url, `${ref}:refs/heads/hidden`]));
});

test('管理接口按名字、仅接受本机身份，更新整份 spec 并保留 status，错误都是 { error: { message } }，不再有 /snapshots、/publish、/repos', async t => {
  const { dir, h, id } = await setup(t);
  assert.equal((await request(h, '/sources/foreign', { spec: { path: dir } }, { caller: { role: 'backend', device: 'backend:test' } })).code, 403);
  assert.equal((await request(h, '/sources/foreign', { spec: { path: dir } }, { caller: { role: 'client', device: 'phone' } })).code, 403);
  assert.deepEqual([...h.objects.keys()], [`${SOURCE}/${id}`]);
  const old = get(h, id);
  assert.equal(await register(h, 'source', { path: dir }), id);
  assert.deepEqual(get(h, id), old);
  const refused = await request(h, '/sources/source', { spec: { path: join(dir, 'missing') } });
  assert.equal(refused.code, 400); assert.deepEqual(get(h, id), old);
  const second = await register(h, 'second', { path: dir });

  assert.match(second, UUID); assert.notEqual(second, id);
  assert.deepEqual(get(h, second).spec, { path: dir, name: 'second' }); assert.equal(get(h, second).status.ready, true);
  const read = await request(h, '/sources/second', {}, { method: 'GET' });
  assert.equal(read.code, 200); assert.equal(read.value.id, second); assert.equal(read.value.spec.name, 'second');
  await remove(h, 'second');
  assert.equal(get(h, second), undefined);
  assert.equal((await request(h, '/sources/second', {}, { method: 'GET' })).code, 404);
  assert.equal((await request(h, '/sources/second/delete')).code, 404);
  // Registered again, the name gives the same ID.
  assert.equal(await register(h, 'second', { path: dir }), second);
  assert.equal((await request(h, '/sources/source/publish', { enabled: true })).code, 404);
  assert.equal((await request(h, '/snapshots/job', { spec: {} })).code, 404);
  assert.deepEqual(await request(h, `/repos/${id}/info/refs?service=git-upload-pack`, {}, { method: 'GET' }), { code: 404, value: { error: { message: '未知管理路径' } } });
  assert.deepEqual(await request(h, '/sources/source', {}, { method: 'PUT' }), { code: 405, value: { error: { message: '需要 GET 或 POST' } } });
  assert.deepEqual(await request(h, '/sources/source', { spec: { path: 'x'.repeat(65536) } }), { code: 413, value: { error: { message: '请求体过大' } } });
});

test('同名的两个首次登记同时到达，只有一条记录', async t => {
  const dir = await fixture(t), h = host(t, join(dir, '.git', 'coda-state'));
  const provider = new GitProvider(h.coda); t.after(() => provider.stop()); await provider.start();
  const [first, second] = await Promise.all([register(h, 'source', { path: dir }), register(h, 'source', { path: dir })]);

  assert.equal(second, first);
  assert.deepEqual([...h.objects.keys()], [`${SOURCE}/${first}`]);
  assert.equal(get(h, first).status.ready, true);
  await remove(h, 'source');
  assert.equal(h.objects.size, 0);
});

test('源路径暂时失效时不可读，恢复后复用原身份重新就绪', async t => {
  const dir = await fixture(t), path = join(dir, '.git', 'source-link');
  await symlink(dir, path);
  const h = host(t, join(dir, '.git', 'state'));
  const provider = new GitProvider(h.coda); t.after(() => provider.stop()); await provider.start();
  const id = await register(h, 'source', { path });
  assert.equal(get(h, id).status.ready, true);
  await unlink(path); await provider.reconcile('source');
  assert.equal(get(h, id).status.ready, false);
  assert.equal(await provider.lookup(id), null);
  await symlink(dir, path); await provider.reconcile('source');
  assert.equal(get(h, id).status.ready, true);
  assert.ok(await provider.lookup(id));
});

test('源符号链接换仓库后拒绝读取，重启仍须重新登记', async t => {
  const a = await fixture(t), b = await fixture(t), path = join(a, '.git', 'source-link');
  await symlink(a, path);
  const h = host(t, join(a, '.git', 'state'));
  const provider = new GitProvider(h.coda); t.after(() => provider.stop()); await provider.start();
  const id = await register(h, 'source', { path });
  assert.equal(get(h, id).status.ready, true);
  await unlink(path); await symlink(b, path);
  assert.equal(await provider.lookup(id), null);
  await provider.reconcile('source');
  assert.equal(get(h, id).status.ready, false);
  assert.match(get(h, id).status.reason, /重新登记/);
  assert.equal(await provider.lookup(id), null);
  await provider.stop();
  const restarted = new GitProvider(h.coda); t.after(() => restarted.stop()); await restarted.start();
  assert.equal(get(h, id).status.ready, false);
  assert.equal(await restarted.lookup(id), null);
  await remove(h, 'source');
  const again = await register(h, 'source', { path });
  assert.equal(again, id);
  assert.equal(get(h, again).status.ready, true);
  assert.equal((await restarted.lookup(again)).path, (await repository(b)).path);
});

for (const name of ['constructor', '__proto__']) test(`源名为 ${name} 也是普通名字：登记、删后重登、重启都认得`, async t => {
  const dir = await fixture(t), h = host(t, join(dir, '.git', 'coda-state'));
  const provider = new GitProvider(h.coda); t.after(() => provider.stop()); await provider.start();
  const id = await register(h, name, { path: dir });
  assert.equal(get(h, id).status.ready, true);
  await remove(h, name);
  const again = await register(h, name, { path: dir });
  assert.equal(get(h, again).status.ready, true);
  await provider.stop();
  const restarted = new GitProvider(h.coda); t.after(() => restarted.stop()); await restarted.start();
  assert.equal(get(h, again).status.ready, true);
  assert.equal((await restarted.lookup(again)).path, (await repository(dir)).path);
  assert.equal((await request(h, `/sources/${name}`, {}, { method: 'GET' })).value.id, again);
});

test('启动时仓库不可用的源，修好后以相同 spec 再登记即重新核对为就绪', async t => {
  const dir = await fixture(t), state = await mkdtemp(join(tmpdir(), 'coda-git-state-')), h = host(t, state);
  t.after(() => rm(state, { recursive: true, force: true }));
  const first = new GitProvider(h.coda); await first.start();
  const id = await register(h, 'source', { path: dir });
  assert.equal(get(h, id).status.ready, true);
  await first.stop();
  await rename(join(dir, '.git'), join(dir, '.git-away'));
  const provider = new GitProvider(h.coda); t.after(() => provider.stop()); await provider.start();
  assert.equal(get(h, id).status.ready, false);
  assert.equal(await provider.lookup(id), null);
  await rename(join(dir, '.git-away'), join(dir, '.git'));
  assert.equal(await register(h, 'source', { path: dir }), id);

  assert.equal(get(h, id).status.ready, true);
  assert.ok(await provider.lookup(id));
});

test('启动时按 sources.json 整份给出登记的源：旧版留下、不带 key 的记录被删；旧格式的文件当作没有源', async t => {
  const a = await fixture(t), state = await mkdtemp(join(tmpdir(), 'coda-git-state-')), h = host(t, state);
  t.after(() => rm(state, { recursive: true, force: true }));
  const file = join(state, 'sources.json'), identity = await repository(a);
  const left = '7d2e9a14-3c5b-4f86-a1d0-c94b2e6f8a37';
  await writeFile(file, JSON.stringify({ gone: { path: identity.path, gitDir: identity.gitDir, commonDir: identity.commonDir } }));
  h.seed(SOURCE, left, { spec: { name: 'left', path: a }, status: { ready: true, url: `/v1/plugins/git/services/repository/repos/${left}` } });
  const first = new GitProvider(h.coda); await first.start();
  assert.equal(get(h, left), undefined);
  assert.equal(h.objects.size, 0);
  const id = await register(h, 'gone', { path: a });
  assert.equal(get(h, id).status.ready, true);
  await first.stop();
  // Replaced from the file alone: what the host holds is not read.
  h.objects.clear();
  const provider = new GitProvider(h.coda); t.after(() => provider.stop()); await provider.start();
  assert.equal(get(h, id).status.ready, true);
  assert.equal((await provider.lookup(id)).path, identity.path);
});

test('旧格式的文件按空处理，登记名恰好叫 sources 的也是：不崩，不迁移', async t => {
  const a = await fixture(t), state = await mkdtemp(join(tmpdir(), 'coda-git-state-')), h = host(t, state);
  t.after(() => rm(state, { recursive: true, force: true }));
  const identity = await repository(a);
  await writeFile(join(state, 'sources.json'), JSON.stringify({ sources: { path: identity.path, gitDir: identity.gitDir, commonDir: identity.commonDir } }));
  const provider = new GitProvider(h.coda); t.after(() => provider.stop()); await provider.start();
  assert.equal(provider.sources.size, 0); assert.equal(h.objects.size, 0);
});

test('写文件失败时登记、删除都报错，内存、文件、宿主记录不变；之后别的登记不带上失败的改动', async t => {
  const { dir, h, provider, id } = await setup(t);
  const file = join(dir, '.git', 'coda-state', 'sources.json'), before = readFileSync(file, 'utf8'), records = structuredClone([...h.objects]);
  await mkdir(`${file}.tmp`);
  assert.equal((await request(h, '/sources/source/delete')).code, 400);
  assert.equal((await request(h, '/sources/second', { spec: { path: dir } })).code, 400);
  assert.deepEqual([...provider.sources.keys()], ['source']); assert.ok(await provider.lookup(id));
  assert.equal(readFileSync(file, 'utf8'), before); assert.deepEqual([...h.objects], records);
  await rm(`${file}.tmp`, { recursive: true });
  const second = await register(h, 'second', { path: dir });
  assert.deepEqual([...provider.sources.keys()], ['source', 'second']);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, 'utf8')).sources), ['source', 'second']);
  assert.deepEqual([...h.objects.keys()].sort(), [`${SOURCE}/${id}`, `${SOURCE}/${second}`].sort());
});

test('删除时 replace 被拒：报错，文件和内存里源还在；重试删除成功，宿主记录撤下', async t => {
  const { dir, h, provider, id } = await setup(t);
  const file = join(dir, '.git', 'coda-state', 'sources.json'), before = readFileSync(file, 'utf8'), replace = h.coda.replace;
  h.coda.replace = async () => { h.coda.replace = replace; throw new Error('宿主拒绝写入'); };
  const refused = await request(h, '/sources/source/delete');
  assert.equal(refused.code, 400); assert.equal(refused.value.error.message, '宿主拒绝写入');
  assert.equal(readFileSync(file, 'utf8'), before); assert.deepEqual([...provider.sources.keys()], ['source']);
  assert.ok(await provider.lookup(id)); assert.equal(get(h, id).status.ready, true);
  await remove(h, 'source');
  assert.equal(get(h, id), undefined); assert.equal(h.objects.size, 0);
  assert.equal(await provider.lookup(id), null);
});

test('登记时 put 被拒：报错，宿主记录没有 status；重试同一个登记后补上', async t => {
  const dir = await fixture(t), h = host(t, join(dir, '.git', 'coda-state'));
  const provider = new GitProvider(h.coda); t.after(() => provider.stop()); await provider.start();
  const put = h.coda.put;
  h.coda.put = async () => { h.coda.put = put; throw new Error('宿主拒绝写入'); };
  const refused = await request(h, '/sources/first', { spec: { path: dir } }), first = h.id('first');
  assert.equal(refused.code, 400);
  assert.deepEqual(get(h, first).status, {});
  assert.equal(await register(h, 'first', { path: dir }), first);
  assert.equal(get(h, first).status.ready, true);
  assert.ok(await provider.lookup(first));
});

test('已就绪的源改路径时 replace 被拒：文件、内存不变，宿主上仍是旧 spec 和旧 status', async t => {
  const { dir, h, provider, id } = await setup(t);
  const other = await fixture(t), file = join(dir, '.git', 'coda-state', 'sources.json'), before = readFileSync(file, 'utf8');
  const status = get(h, id).status, replace = h.coda.replace;
  h.coda.replace = async () => { h.coda.replace = replace; throw new Error('宿主拒绝写入'); };
  assert.equal((await request(h, '/sources/source', { spec: { path: other } })).code, 400);
  assert.equal(readFileSync(file, 'utf8'), before); assert.equal(provider.sources.get('source').spec.path, dir);
  assert.deepEqual(get(h, id).spec, { name: 'source', path: dir });
  assert.equal(get(h, id).status.ready, true); assert.equal(get(h, id).status.url, status.url);
  assert.equal((await provider.lookup(id)).path, (await repository(dir)).path);
});

test('start 完就能取上次留下的源：首次核对都做完才开服务', async t => {
  const dir = await fixture(t), state = await mkdtemp(join(tmpdir(), 'coda-git-state-')), h = host(t, state);
  t.after(() => rm(state, { recursive: true, force: true }));
  const first = new GitProvider(h.coda); await first.start();
  const id = await register(h, 'source', { path: dir });
  await first.stop();
  const provider = new GitProvider(h.coda); t.after(() => provider.stop());
  await provider.start();
  assert.ok(await provider.lookup(id));
  const { base } = await gateway(t, h.served);
  const target = join(dir, 'client'); await mkdir(target); await command(target, ['init']);
  await command(target, ['-c', 'protocol.version=2', 'fetch', base + get(h, id).status.url, 'refs/heads/main:refs/heads/main']);
  assert.equal(await command(target, ['rev-parse', 'main']), await command(dir, ['rev-parse', 'main']));

});


test('旧版写的 status.url 在启动后换成流的地址', async t => {
  const dir = await fixture(t), state = await mkdtemp(join(tmpdir(), 'coda-git-state-')), h = host(t, state);
  t.after(() => rm(state, { recursive: true, force: true }));
  const first = new GitProvider(h.coda); await first.start();
  const id = await register(h, 'source', { path: dir });
  await first.stop();
  await h.coda.put({ kind: SOURCE, key: 'source' }, { spec: { name: 'source', path: dir },
    status: { ready: true, url: `/v1/plugins/git/services/repository/repos/${id}` } });
  const provider = new GitProvider(h.coda); t.after(() => provider.stop()); await provider.start();
  assert.deepEqual(get(h, id).status, { ready: true, url: address(id) });
});
