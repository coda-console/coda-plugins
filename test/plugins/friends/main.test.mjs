// 好友模块：策略的 `coda self` 处理函数、社交网关与签名网关调用方的登记，以及好友页「共享」一节的视图消息。activate 里 Accord 只读本机记录、监听变化，不查询、不发布。
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

test('activate registers the policy and sharing handlers, the gateway operations, the caller\'s proxy protocol and the view, with no notes or social streams, and without querying or publishing', async t => {
  const h = await host(t);
  t.after(deactivate);
  await activate(h.coda);
  assert.deepEqual([...h.self.keys()].sort(), ['grants.grant', 'grants.list', 'grants.revoke', 'grants.targets', 'ledger.list', 'policy.get', 'policy.setKind', 'proxies.list']);
  assert.deepEqual(h.operations.sort(), [...['friends', 'outbox', 'publish', 'records', 'retract'].map(name => `friends/social@1/${name}`), 'remote-exec/machine@1/exec']);
  // 调用方的代理记录：exec 转给好友，pull、push 报不支持。
  assert.deepEqual(h.streams, ['remote-exec/machine@1/pull', 'remote-exec/machine@1/push']);
  assert.deepEqual([...h.views.keys()], ['friends']);
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

test('a page reads the sharing state by messages too: grants, ledger, the proxies friends granted, and the remote-exec records it can grant, this machine\'s first, then the space\'s, no proxies', async t => {
  const h = await host(t);
  t.after(deactivate);
  const rows = [{ id: 'rx-1', local: true, plugin: 'remote-exec', spec: { name: '书房的 Mac mini', os: 'macOS 15.2', user: 'leavan' }, status: { available: true } },
    { id: 'rx-2', local: true, plugin: 'remote-exec', spec: { name: '关着的' }, status: { available: false } },
    { id: 'px-1', local: true, plugin: 'friends', spec: { name: '代理记录' }, status: { available: true } },
    { id: 'rx-3', local: false, plugin: 'remote-exec', spec: { name: '别的电脑' }, status: { available: true } },
    { id: 'px-2', local: false, plugin: 'friends', spec: { name: '别的电脑上的代理记录' }, status: { available: true } },
    { id: 'ot-1', local: false, plugin: 'other', spec: { name: '别的插件的' }, status: { available: true } }];
  h.coda.error = (code, message, options) => Object.assign(new Error(message), { code, ...options });
  h.coda.list = async (kind, filter) => { assert.equal(kind, 'remote-exec/machine@1'); return filter?.scope === 'local' ? rows.filter(row => row.local) : rows; };
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
  assert.deepEqual(page.got[3].value, [{ id: 'rx-1', name: '书房的 Mac mini', os: 'macOS 15.2', user: 'leavan', available: true, local: true },
    { id: 'rx-2', name: '关着的', os: '', user: '', available: false, local: true }, { id: 'rx-3', name: '别的电脑', os: '', user: '', available: true, local: false }]);
  assert.match(page.got[4].error, /没有授权/);
  assert.equal(page.got[4].effects, 'none', 'a refusal says nothing was written');
  // 已下线的备注与别的类型、没带 id 的消息不答。
  for (const message of [{ type: 'notes.list', rid: 'f' }, { type: 'notes.set', rid: 'g', node: 'n1', note: 'x' }, { type: 'other', rid: 'h' }, { type: 'grants.list' }, null]) page.tell(message);
  await settled();
  assert.equal(page.got.length, 5, 'unknown or id-less messages are ignored');
});

test('without a state directory policy and sharing fail plainly, and deactivate disposes what activate registered', async t => {
  const h = await host(t, null);
  await activate(h.coda);
  await assert.rejects(Promise.resolve().then(() => h.self.get('policy.get')({})), /状态目录/);
  await assert.rejects(Promise.resolve().then(() => h.self.get('grants.list')({})), /状态目录/);
  deactivate();
  assert.deepEqual(h.disposed.sort(), ['friends/social@1/friends', 'friends/social@1/outbox', 'friends/social@1/publish', 'friends/social@1/records', 'friends/social@1/retract',
    'grants.grant', 'grants.list', 'grants.revoke', 'grants.targets', 'ledger.list', 'policy.get', 'policy.setKind', 'proxies.list', 'watch']);
  deactivate();
});

test('without the remote-exec protocol the caller still finishes starting: proxies.list answers at once, saying remote execution is unavailable, and the rest keeps working', async t => {
  const h = await host(t);
  t.after(deactivate);
  const handle = h.coda.handle;
  h.coda.handle = (kind, operation, ...rest) => {
    if (kind === 'remote-exec/machine@1') throw new Error('没有这个协议');
    return handle(kind, operation, ...rest);
  };
  h.coda.list = async kind => { throw Object.assign(new Error(`没有协议：${kind}`), { code: 'not_found' }); };
  await activate(h.coda);
  const page = h.open();
  page.tell({ type: 'proxies.list', rid: 'p', friend: `ed25519:${'1'.repeat(64)}` });
  page.tell({ type: 'grants.list', rid: 'g' });
  await settled();
  const reply = rid => page.got.find(m => m.rid === rid);
  assert.equal(reply('p')?.ok, false);
  assert.match(reply('p').error, /这台没装远程执行插件/);
  assert.equal(reply('g')?.ok, true);
  assert.deepEqual(await h.self.get('policy.get')({}), { pausedKinds: [] });
  assert.equal((await h.self.get('grants.list')({})).corrupt, null, 'the holder is not affected');
});

test('a caller that fails to start with the protocol present is reported by its own reason, never as the plugin not being installed', async t => {
  const h = await host(t);
  t.after(deactivate);
  const handle = h.coda.handle;
  h.coda.handle = (kind, operation, ...rest) => {
    if (kind === 'remote-exec/machine@1') throw new Error('磁盘满了');
    return handle(kind, operation, ...rest);
  };
  await activate(h.coda);
  const page = h.open();
  page.tell({ type: 'proxies.list', rid: 'p', friend: `ed25519:${'1'.repeat(64)}` });
  await settled();
  assert.equal(page.got[0].ok, false);
  assert.match(page.got[0].error, /磁盘满了/);
  assert.doesNotMatch(page.got[0].error, /没装/);
});
