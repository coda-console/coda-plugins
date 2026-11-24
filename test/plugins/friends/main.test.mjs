// 好友模块：策略的 `coda self` 处理函数与社交网关的登记。activate 里 Accord 只读本机记录、监听变化，不查询、不发布。
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { activate, deactivate } from '../../../plugins/friends/main.mjs';

async function host(t, state) {
  const dir = state === undefined ? await mkdtemp(join(tmpdir(), 'friends-main-')) : state;
  if (state === undefined) t.after(() => rm(dir, { recursive: true, force: true }));
  const self = new Map(), views = new Map(), operations = [], streams = [], disposed = [];
  const never = name => () => { throw new Error(`activate must not call coda.${name}`); };
  const coda = { plugin: { id: 'friends', path: '/x', state: dir }, query: never('query'), call: never('call'),
    get: async () => null, put: async () => ({}), watch: async () => ({ dispose: () => disposed.push('watch') }),
    handle: (kind, operation) => { operations.push(`${kind}/${operation}`); return { dispose: () => disposed.push(`${kind}/${operation}`) }; },
    stream: async (kind, name) => { streams.push(`${kind}/${name}`); return { dispose: () => disposed.push(`stream ${kind}/${name}`) }; },
    self: { handle: (name, fn) => { self.set(name, fn); return { dispose: () => disposed.push(name) }; } },
    views: { register: (id, provider) => { views.set(id, provider); return { dispose() {} }; } } };
  return { coda, dir, self, views, operations, streams, disposed };
}

test('activate registers the policy handlers and the gateway operations, with no notes, streams or view messages, and without querying or publishing', async t => {
  const h = await host(t);
  t.after(deactivate);
  await activate(h.coda);
  assert.deepEqual([...h.self.keys()].sort(), ['policy.get', 'policy.setKind']);
  assert.deepEqual(h.operations.sort(), ['friends', 'outbox', 'publish', 'records', 'retract'].map(name => `friends/social@1/${name}`));
  assert.deepEqual(h.streams, []);
  assert.deepEqual([...h.views.keys()], []);
});

test('policy is read and written through `coda self` and kept in the state directory', async t => {
  const h = await host(t);
  t.after(deactivate);
  await activate(h.coda);
  assert.deepEqual(await h.self.get('policy.get')({}), { pausedKinds: [] });
  assert.deepEqual(await h.self.get('policy.setKind')({ kind: 'x', paused: true }), { pausedKinds: ['x'] });
  assert.deepEqual(await h.self.get('policy.get')({}), { pausedKinds: ['x'] });
  await assert.rejects(Promise.resolve().then(() => h.self.get('policy.setKind')({ kind: 'x', paused: 'yes' })), /paused/);
  await assert.rejects(Promise.resolve().then(() => h.self.get('policy.setKind')({ kind: 'friends/card', paused: true })), error => error.code === 'invalid_input');
  assert.deepEqual(JSON.parse(await readFile(join(h.dir, 'policy.json'), 'utf8')).pausedKinds, ['x']);
});

test('without a state directory policy fails plainly, and deactivate disposes what activate registered', async t => {
  const h = await host(t, null);
  await activate(h.coda);
  await assert.rejects(Promise.resolve().then(() => h.self.get('policy.get')({})), /状态目录/);
  deactivate();
  assert.deepEqual(h.disposed.sort(), ['friends/social@1/friends', 'friends/social@1/outbox', 'friends/social@1/publish', 'friends/social@1/records', 'friends/social@1/retract',
    'policy.get', 'policy.setKind', 'watch']);
  deactivate();
});
