import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { writeFile, readFile, symlink, unlink } from 'node:fs/promises';
import { fixture, command, env } from './helpers.mjs';
import { GitProvider } from '../../../plugins/git/lib/provider.mjs';
import { SOURCE, SNAPSHOT, definitions } from '../../../plugins/git/lib/definitions.mjs';
import { providerDefinition } from '../../../check/coda/components/protocols/provider-definition.mjs';
import { ProtocolTypes, validate } from '../../../check/coda/components/protocols/types.mjs';
import { providerAPI } from '../../../check/coda/adapters/provider-api.mjs';

// The plugin's reconciliation runs against the synchronized host API and real Git. Storage/transport belong
// to Coda's tests; this fixture supplies events and rejects stale revisions, without starting a backend.
function host(state) {
  const types = new ProtocolTypes(), objects = new Map(), listeners = new Map(), runs = new Map();
  const failures = []; let revision = 0;
  const emit = (collection, event) => { for (const fn of listeners.get(collection) ?? []) fn(structuredClone(event)); };
  const watch = async (collection, fn, filter) => {
    const set = listeners.get(collection) ?? new Set(); listeners.set(collection, set); set.add(fn);
    const entries = collection.startsWith('provider:') ? [...objects.values()].filter(o => `provider:${o.kind}` === collection) : [...runs.values()];
    for (const object of entries) if (!filter?.run || object.id === filter.run) fn({ type: 'ADDED', id: object.id, object: structuredClone(object) });
    return { dispose: () => set.delete(fn) };
  };
  const call = async (method, args) => {
    if (method === 'define') {
      const def = providerDefinition(args[0]);
      if (!types.types.has(def.kind)) types.register({ ...def, participants: () => [] });
      return;
    }
    const [kind, id] = method === 'put' ? [args[0].kind, args[0].id] : args;
    const key = `${kind}/${id}`, old = objects.get(key), type = types.get(kind);
    if (method === 'publish') return;
    if (method === 'delete') { objects.delete(key); if (old) emit(`provider:${kind}`, { type: 'DELETED', id, object: old }); return; }
    const expected = method === 'put' ? args[0].revision : args[3];
    if (old && expected !== old.revision) throw new Error('revision conflict');
    const spec = method === 'put' ? args[0].spec : old.spec, status = method === 'setStatus' ? args[2] : old?.status ?? {};
    validate(type.spec, spec, 'spec'); validate(type.status, status, 'status');
    if (old && JSON.stringify(old.spec) === JSON.stringify(spec) && JSON.stringify(old.status) === JSON.stringify(status)) return old;
    const object = { kind, id, spec, status, instance: old?.instance ?? randomUUID(), revision: String(++revision) };
    objects.set(key, object); emit(`provider:${kind}`, { type: old ? 'MODIFIED' : 'ADDED', id, object }); return object;
  };
  const coda = { plugin: { state }, environment: async () => env, watch,
    api: async path => { const run = runs.get(path.split('/').at(-1)); if (!run) throw new Error('run not found'); return run; },
    services: { register: async (_id, handler) => { coda.handler = handler; return { dispose() {} }; } },
    protocols: providerAPI({ call, watch, report: (...error) => failures.push(error) }),
  };
  return { coda, objects, failures, run(id, state = 'running') {
    const object = { id, runId: id, state }; runs.set(id, object); emit('workflow-runs', { type: 'MODIFIED', id, object });
  } };
}
async function idle(provider) {
  for (let i = 0; i < 100; i++) {
    const queue = provider.queue; await queue; await new Promise(resolve => setImmediate(resolve));
    if (queue === provider.queue) return;
  }
  throw new Error('controller did not settle');
}
const put = (h, kind, id, spec, revision) => h.coda.protocols.put({ kind, id, spec, ...(revision ? { revision } : {}) });
const get = (h, kind, id) => h.objects.get(`${kind}/${id}`);

async function setup(t) {
  const dir = await fixture(t), h = host(join(dir, '.git', 'coda-state'));
  const provider = new GitProvider(h.coda); t.after(() => provider.stop()); await provider.start();
  h.run('run'); await put(h, SOURCE, 'source', { path: dir });
  await writeFile(join(dir, 'new'), 'captured');
  await put(h, SNAPSHOT, 'snapshot', { source: 'source', mode: 'worktree', run: 'run' });
  await idle(provider);
  return { dir, h, provider };
}

test('同步契约接受类型与 schema，拒绝拓扑字段及不完整 spec', () => {
  for (const definition of definitions) assert.doesNotThrow(() => providerDefinition(definition));
  const types = new ProtocolTypes(); for (const d of definitions) types.register({ ...d, participants: () => [] });
  assert.equal(types.get(SOURCE).spec({ path: '/tmp/repo', machine: 'remote' }), false);
  assert.equal(types.get(SNAPSHOT).spec({ source: 'source', mode: 'commit', run: 'run' }), false);
});

test('办事员生成并稳定复用快照，运行结束回收 ref', async t => {
  const { dir, h, provider } = await setup(t);
  const ready = get(h, SNAPSHOT, 'snapshot'); assert.equal(ready.status.ready, true);
  assert.equal(await command(dir, ['show', `${ready.status.commit}:new`]), 'captured');
  await writeFile(join(dir, 'new'), 'changed after snapshot'); await provider.schedule(); await idle(provider);
  assert.equal(get(h, SNAPSHOT, 'snapshot').status.commit, ready.status.commit);
  h.run('run', 'succeeded'); await idle(provider);
  assert.equal(get(h, SNAPSHOT, 'snapshot').status.released, true);
  assert.equal(await command(dir, ['for-each-ref', ready.status.ref]), '');
  assert.deepEqual(h.failures, []);
});

test('删除与同 id 重建使用新实例；宿主停止期间删除的 ref 重启回收', async t => {
  const { dir, h, provider } = await setup(t);
  const first = get(h, SNAPSHOT, 'snapshot');
  await h.coda.protocols.delete(SNAPSHOT, 'snapshot');
  await put(h, SNAPSHOT, 'snapshot', { source: 'source', mode: 'worktree', run: 'run' });
  await idle(provider);
  const second = get(h, SNAPSHOT, 'snapshot');
  assert.notEqual(first.status.ref, second.status.ref);
  assert.equal(await command(dir, ['for-each-ref', first.status.ref]), '');
  await provider.stop();
  await h.coda.protocols.delete(SNAPSHOT, 'snapshot');
  const restarted = new GitProvider(h.coda); t.after(() => restarted.stop()); await restarted.start(); await idle(restarted);
  assert.equal(await command(dir, ['for-each-ref', second.status.ref]), '');
  assert.deepEqual(JSON.parse(await readFile(join(h.coda.plugin.state, 'snapshots.json'), 'utf8')), {});
});

test('删除源撤下读取和快照；运行读取失败不能伪造完成', async t => {
  const { dir, h, provider } = await setup(t);
  const ref = get(h, SNAPSHOT, 'snapshot').status.ref;
  await h.coda.protocols.delete(SOURCE, 'source'); await idle(provider);
  assert.equal(await provider.lookup('source'), null);
  assert.equal(await command(dir, ['for-each-ref', ref]), '');
  await put(h, SOURCE, 'source', { path: dir });
  await put(h, SNAPSHOT, 'missing-run', { source: 'source', mode: 'worktree', run: 'unknown' }); await idle(provider);
  assert.equal(get(h, SNAPSHOT, 'missing-run').status.ready, false);
  assert.match(get(h, SNAPSHOT, 'missing-run').status.reason, /无法确认关联运行/);
  assert.equal(get(h, SNAPSHOT, 'missing-run').status.released, undefined);
});

test('旧 revision 的结果不能覆盖修改后的请求，旧 ref 随对账回收', async t => {
  const dir = await fixture(t), h = host(join(dir, '.git', 'state'));
  const provider = new GitProvider(h.coda); t.after(() => provider.stop()); await provider.start();
  h.run('run'); await put(h, SOURCE, 'source', { path: dir });
  const head = await command(dir, ['rev-parse', 'HEAD']);
  let intercepted = false, oldRef;
  const setStatus = h.coda.protocols.setStatus;
  h.coda.protocols.setStatus = async (kind, id, status, revision) => {
    if (kind === SNAPSHOT && status.ready && !intercepted) {
      intercepted = true; oldRef = status.ref;
      await put(h, SNAPSHOT, id, { source: 'source', mode: 'commit', commit: head, run: 'run' }, revision);
    }
    return setStatus(kind, id, status, revision);
  };
  await writeFile(join(dir, 'new'), 'dirty');
  await put(h, SNAPSHOT, 'snapshot', { source: 'source', mode: 'worktree', run: 'run' }); await idle(provider);
  const current = get(h, SNAPSHOT, 'snapshot');
  assert.equal(current.spec.mode, 'commit'); assert.equal(current.status.commit, head);
  assert.notEqual(current.status.ref, oldRef); assert.equal(await command(dir, ['for-each-ref', oldRef]), '');
  assert.deepEqual(h.failures, []);
});

test('管理接口仅接受本机身份，更新须携带版本，错误符合 coda.api 信封', async t => {
  const { Readable } = await import('node:stream');
  const { dir, h, provider } = await setup(t);
  const request = async (caller, url, body) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]); req.url = url; req.method = 'POST';
    let code, value;
    await provider.manage(req, { writeHead(status) { code = status; }, end(text) { value = JSON.parse(text); } }, caller);
    return { code, value };
  };
  assert.equal((await request({ role: 'backend', device: 'backend:test' }, '/sources/foreign', { spec: { path: dir } })).code, 403);
  assert.equal((await request({ role: 'client', device: 'phone' }, '/sources/foreign', { spec: { path: dir } })).code, 403);
  assert.equal(get(h, SOURCE, 'foreign'), undefined);
  const old = get(h, SOURCE, 'source');
  const result = await request({ local: true }, '/sources/source', { spec: { path: dir }, revision: 'outdated' });
  assert.equal(result.code, 400); assert.match(result.value.error.message, /revision conflict/);
  assert.equal(get(h, SOURCE, 'source').revision, old.revision);
});

test('源暂时不可用保留活跃快照，重启恢复复用原提交，运行结束仍回收', async t => {
  const dir = await fixture(t), path = join(dir, '.git', 'source-link');
  await symlink(dir, path);
  const h = host(join(dir, '.git', 'state'));
  const provider = new GitProvider(h.coda); t.after(() => provider.stop()); await provider.start();
  h.run('run'); await put(h, SOURCE, 'source', { path });
  await writeFile(join(dir, 'new'), 'captured');
  await put(h, SNAPSHOT, 'snapshot', { source: 'source', mode: 'worktree', run: 'run' }); await idle(provider);
  const first = get(h, SNAPSHOT, 'snapshot').status;
  assert.equal(first.ready, true);
  const ledger = await readFile(join(h.coda.plugin.state, 'snapshots.json'), 'utf8');
  await unlink(path); await provider.schedule(); await idle(provider);
  assert.equal(get(h, SOURCE, 'source').status.ready, false);
  assert.equal(get(h, SNAPSHOT, 'snapshot').status.ready, false);
  assert.equal(await provider.lookup('source'), null);
  assert.equal(await command(dir, ['rev-parse', '--verify', first.ref]), first.commit);
  assert.equal(await readFile(join(h.coda.plugin.state, 'snapshots.json'), 'utf8'), ledger);
  await writeFile(join(dir, 'new'), 'changed while unavailable');
  await provider.stop();
  const restarted = new GitProvider(h.coda); t.after(() => restarted.stop()); await restarted.start(); await idle(restarted);
  assert.equal(await restarted.lookup('source'), null);
  assert.equal(await command(dir, ['rev-parse', '--verify', first.ref]), first.commit);
  await symlink(dir, path); await restarted.schedule(); await idle(restarted);
  assert.deepEqual(get(h, SNAPSHOT, 'snapshot').status, first);
  assert.equal(await command(dir, ['show', `${first.ref}:new`]), 'captured');
  assert.equal((await restarted.lookup('source')).refs.has(first.ref), true);
  await unlink(path); await restarted.schedule(); await idle(restarted);
  h.run('run', 'succeeded'); await idle(restarted);
  assert.equal(get(h, SNAPSHOT, 'snapshot').status.released, true);
  assert.equal(await command(dir, ['for-each-ref', first.ref]), '');
  assert.deepEqual(JSON.parse(await readFile(join(h.coda.plugin.state, 'snapshots.json'), 'utf8')), {});
  assert.deepEqual(h.failures, []);
});

test('源符号链接换仓库后拒绝访问和快照，重启仍须重新登记，两个仓库均无遗留 ref', async t => {
  const a = await fixture(t), b = await fixture(t), path = join(a, '.git', 'source-link');
  await symlink(a, path);
  const h = host(join(a, '.git', 'state'));
  const provider = new GitProvider(h.coda); t.after(() => provider.stop()); await provider.start();
  h.run('run'); await put(h, SOURCE, 'source', { path });
  await put(h, SNAPSHOT, 'snapshot', { source: 'source', mode: 'worktree', run: 'run' }); await idle(provider);
  assert.equal(get(h, SNAPSHOT, 'snapshot').status.ready, true);
  await unlink(path); await symlink(b, path);
  assert.equal(await provider.lookup('source'), null);
  await provider.schedule(); await idle(provider);
  assert.equal(get(h, SOURCE, 'source').status.ready, false);
  assert.match(get(h, SOURCE, 'source').status.reason, /重新登记/);
  assert.equal(await provider.lookup('source'), null);
  assert.equal(await command(b, ['for-each-ref', 'refs/coda/snapshots/']), '');
  await h.coda.protocols.delete(SNAPSHOT, 'snapshot'); await idle(provider);
  assert.equal(await command(a, ['for-each-ref', 'refs/coda/snapshots/']), '');
  assert.equal(await command(b, ['for-each-ref', 'refs/coda/snapshots/']), '');
  assert.deepEqual(JSON.parse(await readFile(join(h.coda.plugin.state, 'snapshots.json'), 'utf8')), {});
  await provider.stop();
  const restarted = new GitProvider(h.coda); t.after(() => restarted.stop()); await restarted.start(); await idle(restarted);
  assert.equal(get(h, SOURCE, 'source').status.ready, false);
  assert.equal(await restarted.lookup('source'), null);
  await h.coda.protocols.delete(SOURCE, 'source'); await put(h, SOURCE, 'source', { path });
  await put(h, SNAPSHOT, 'snapshot', { source: 'source', mode: 'worktree', run: 'run' }); await idle(restarted);
  assert.equal(get(h, SNAPSHOT, 'snapshot').status.ready, true);
  await h.coda.protocols.delete(SNAPSHOT, 'snapshot'); await idle(restarted);
  assert.equal(await command(b, ['for-each-ref', 'refs/coda/snapshots/']), '');
});

test('旧运行查询暂时失败后，新增关联快照触发重查并恢复，无需订阅事件', async t => {
  const dir = await fixture(t), h = host(join(dir, '.git', 'state'));
  h.coda.api = async () => { throw new Error('temporarily unavailable'); };
  const provider = new GitProvider(h.coda); t.after(() => provider.stop()); await provider.start();
  await put(h, SOURCE, 'source', { path: dir });
  await writeFile(join(dir, 'new'), 'captured');
  await put(h, SNAPSHOT, 'first', { source: 'source', mode: 'worktree', run: 'old-run' }); await idle(provider);
  assert.equal(get(h, SNAPSHOT, 'first').status.ready, false);
  assert.match(get(h, SNAPSHOT, 'first').status.reason, /temporarily unavailable/);
  assert.equal(await command(dir, ['for-each-ref', 'refs/coda/snapshots/']), '');
  h.coda.api = async () => ({ id: 'old-run', state: 'running' });
  await put(h, SNAPSHOT, 'second', { source: 'source', mode: 'worktree', run: 'old-run' }); await idle(provider);
  for (const id of ['first', 'second']) {
    const { status } = get(h, SNAPSHOT, id);
    assert.equal(status.ready, true);
    assert.equal(await command(dir, ['show', `${status.ref}:new`]), 'captured');
  }
  assert.deepEqual(h.failures, []);
});

for (const result of ['running', 'error']) test(`运行查询失败后的重查 ${result} 不覆盖等待期间的订阅终态`, async t => {
  // Exercise the query/event interleaving in memory; reconciliation and Git are covered above.
  const h = host('unused'), provider = new GitProvider(h.coda); t.after(() => provider.stop());
  provider.snapshots.set('snapshot', { spec: { run: 'run' } });
  h.coda.api = async () => { throw new Error('temporarily unavailable'); };
  await provider.followRuns();
  assert.match(provider.runs.get('run').error, /temporarily unavailable/);
  const response = Promise.withResolvers();
  let retried = false;
  h.coda.api = () => { retried = true; return response.promise; };
  const pending = provider.followRuns();
  assert.equal(retried, true);
  h.run('run', 'succeeded');
  if (result === 'error') response.reject(new Error('old lookup failed'));
  else response.resolve({ id: 'run', state: 'running' });
  await pending;
  assert.equal(provider.runs.get('run').state, 'succeeded');
});

for (const result of ['running', 'error']) test(`运行订阅终态先于旧查询 ${result} 返回时不回退、不创建快照`, async t => {
  const dir = await fixture(t), h = host(join(dir, '.git', 'state'));
  const entered = Promise.withResolvers(), response = Promise.withResolvers();
  h.coda.api = async () => { entered.resolve(); return response.promise; };
  const provider = new GitProvider(h.coda); t.after(() => provider.stop()); await provider.start();
  await put(h, SOURCE, 'source', { path: dir });
  await put(h, SNAPSHOT, 'snapshot', { source: 'source', mode: 'worktree', run: 'run' });
  await entered.promise;
  h.run('run', 'succeeded');
  if (result === 'error') response.reject(new Error('old lookup failed'));
  else response.resolve({ id: 'run', state: 'running' });
  await idle(provider);
  assert.equal(provider.runs.get('run').state, 'succeeded');
  assert.equal(get(h, SNAPSHOT, 'snapshot').status.released, true);
  assert.equal(await command(dir, ['for-each-ref', 'refs/coda/snapshots/']), '');
});
