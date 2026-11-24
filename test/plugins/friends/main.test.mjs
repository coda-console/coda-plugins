// 好友模块：备注的视图消息与 `coda self`、社交网关与签名网关调用方的登记；备注存在插件状态目录。activate 里 Accord 只读本机记录、监听变化，不查询、不发布。
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { activate, deactivate } from '../../../plugins/friends/main.mjs';

async function host(t, state, listed = []) {
  const dir = state === undefined ? await mkdtemp(join(tmpdir(), 'friends-main-')) : state;
  if (state === undefined) t.after(() => rm(dir, { recursive: true, force: true }));
  const self = new Map(), views = new Map(), operations = [], streams = [], disposed = [];
  const never = name => () => { throw new Error(`activate must not call coda.${name}`); };
  const coda = { plugin: { id: 'friends', path: '/x', state: dir }, query: never('query'), call: never('call'),
    get: async () => null, list: async (kind, filter) => { listed.push([kind, filter]); return []; }, put: async () => ({}), watch: async () => ({ dispose: () => disposed.push('watch') }),
    handle: (kind, operation) => { operations.push(`${kind}/${operation}`); return { dispose: () => disposed.push(`${kind}/${operation}`) }; },
    stream: async (kind, name) => { streams.push(`${kind}/${name}`); return { dispose: () => disposed.push(`stream ${kind}/${name}`) }; },
    self: { handle: (name, fn) => { self.set(name, fn); return { dispose: () => disposed.push(name) }; } },
    views: { register: (id, provider) => { views.set(id, provider); return { dispose() {} }; } } };
  const open = () => {
    const page = { got: [], tell: null };
    views.get('friends').open({ postMessage: m => { page.got.push(m); return true; }, onMessage: fn => { page.tell = fn; }, onClose() {} });
    return page;
  };
  return { coda, dir, self, views, operations, streams, disposed, open };
}
const settled = () => new Promise(resolve => setTimeout(resolve, 30));

test('activate registers the notes and policy handlers, the gateway operations and streams and the view, without querying or publishing', async t => {
  const h = await host(t);
  t.after(deactivate);
  await activate(h.coda);
  assert.deepEqual([...h.self.keys()].sort(), ['grants.grant', 'grants.list', 'grants.revoke', 'grants.targets', 'ledger.list', 'notes.delete', 'notes.list', 'notes.set', 'policy.get', 'policy.setKind', 'proxies.list']);
  assert.deepEqual(h.operations.sort(), [...['friends', 'outbox', 'post-feed', 'publish', 'records', 'retract', 'send-dm', 'set-card'].map(name => `friends/social@1/${name}`),
    'remote-exec/machine@1/exec']);
  // 调用方的代理记录：exec 转给好友，pull、push 报不支持。
  assert.deepEqual(h.streams, ['friends/social@1/dm', 'friends/social@1/feed', 'remote-exec/machine@1/pull', 'remote-exec/machine@1/push']);
  assert.deepEqual([...h.views.keys()], ['friends']);
});

test('notes are read and written through `coda self` and kept in the state directory', async t => {
  const h = await host(t);
  t.after(deactivate);
  await activate(h.coda);
  assert.deepEqual(await h.self.get('notes.list')({}), {});
  assert.deepEqual(await h.self.get('notes.set')({ node: 'n1', note: '老王' }), { n1: '老王' });
  assert.deepEqual(JSON.parse(await readFile(join(h.dir, 'notes.json'), 'utf8')), { n1: '老王' });
  assert.deepEqual(await h.self.get('notes.delete')({ node: 'n1' }), {});
  await assert.rejects(h.self.get('notes.set')({ node: '', note: 'x' }), /不合法/);
});

test('a page reads and writes notes by messages, each answer carrying its request id', async t => {
  const h = await host(t);
  t.after(deactivate);
  await activate(h.coda);
  const page = h.open();
  page.tell({ type: 'notes.set', rid: 'a', node: 'n1', note: '备注' });
  await settled();
  page.tell({ type: 'notes.list', rid: 'b' });
  await settled();
  page.tell({ type: 'notes.set', rid: 'c', node: '', note: 'x' });
  await settled();
  page.tell({ type: 'other', rid: 'd' });
  page.tell({ type: 'notes.list' });
  page.tell(null);
  await settled();
  assert.deepEqual(page.got[0], { type: 'reply', rid: 'a', ok: true, value: { n1: '备注' } });
  assert.deepEqual(page.got[1], { type: 'reply', rid: 'b', ok: true, value: { n1: '备注' } });
  assert.equal(page.got[2].ok, false);
  assert.equal(page.got[2].rid, 'c');
  assert.match(page.got[2].error, /不合法/);
  assert.equal(page.got.length, 3, 'unknown or id-less messages are ignored');
});

test('a page reads the sharing state by messages too: grants, ledger, the proxies friends granted, and the local remote-exec records it can grant', async t => {
  const h = await host(t);
  t.after(deactivate);
  const rows = [{ id: 'rx-1', local: true, plugin: 'remote-exec', spec: { name: '书房的 Mac mini', os: 'macOS 15.2', user: 'leavan' }, status: { available: true } },
    { id: 'rx-2', local: true, plugin: 'remote-exec', spec: { name: '关着的' }, status: { available: false } },
    { id: 'px-1', local: true, plugin: 'friends', spec: { name: '代理记录' }, status: { available: true } },
    { id: 'rx-3', local: false, plugin: 'remote-exec', spec: { name: '别的电脑' }, status: { available: true } }];
  h.coda.error = (code, message, options) => Object.assign(new Error(message), { code, ...options });
  h.coda.list = async (kind, filter) => { assert.deepEqual([kind, filter], ['remote-exec/machine@1', { scope: 'local' }]); return rows; };
  await activate(h.coda);
  const page = h.open();
  for (const [rid, type, more] of [['a', 'grants.list'], ['b', 'ledger.list', { friend: `ed25519:${'1'.repeat(64)}`, limit: 20 }], ['c', 'proxies.list', { friend: `ed25519:${'1'.repeat(64)}` }], ['d', 'grants.targets'], ['e', 'grants.revoke', { grant: 'nope' }]]) {
    page.tell({ type, rid, ...more });
    await settled();
  }
  assert.deepEqual(page.got.map(m => [m.rid, m.ok]), [['a', true], ['b', true], ['c', true], ['d', true], ['e', false]]);
  assert.deepEqual(page.got[0].value, { certState: 'no_identity', admitting: true, corrupt: null, grants: [] });
  assert.deepEqual(page.got[1].value, []);
  assert.deepEqual(page.got[2].value, []);
  assert.deepEqual(page.got[3].value, [{ id: 'rx-1', name: '书房的 Mac mini', os: 'macOS 15.2', user: 'leavan', available: true }, { id: 'rx-2', name: '关着的', os: '', user: '', available: false }]);
  assert.match(page.got[4].error, /没有授权/);
  assert.equal(page.got[4].effects, 'none', 'a refusal says nothing was written');
});

test('without a state directory notes fail plainly, and deactivate disposes what activate registered', async t => {
  const h = await host(t, null);
  await activate(h.coda);
  await assert.rejects(Promise.resolve().then(() => h.self.get('notes.list')({})), /状态目录/);
  await assert.rejects(Promise.resolve().then(() => h.self.get('grants.list')({})), /状态目录/);
  deactivate();
  assert.deepEqual(h.disposed.sort(), ['friends/social@1/friends', 'friends/social@1/outbox', 'friends/social@1/post-feed', 'friends/social@1/publish', 'friends/social@1/records',
    'friends/social@1/retract', 'friends/social@1/send-dm', 'friends/social@1/set-card', 'grants.grant', 'grants.list', 'grants.revoke', 'grants.targets', 'ledger.list', 'notes.delete', 'notes.list', 'notes.set', 'policy.get', 'policy.setKind',
    'proxies.list', 'stream friends/social@1/dm', 'stream friends/social@1/feed', 'watch']);
  deactivate();
});
