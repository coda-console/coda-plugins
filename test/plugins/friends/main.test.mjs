// 好友模块：activate 里不碰 Accord，只登记备注的视图消息与 `coda self`；备注存在插件状态目录。
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { activate, deactivate } from '../../../plugins/friends/main.mjs';

async function host(t, state) {
  const dir = state === undefined ? await mkdtemp(join(tmpdir(), 'friends-main-')) : state;
  if (state === undefined) t.after(() => rm(dir, { recursive: true, force: true }));
  const self = new Map(), views = new Map(), disposed = [];
  const never = name => () => { throw new Error(`activate must not call coda.${name}`); };
  const coda = { plugin: { id: 'friends', path: '/x', state: dir }, query: never('query'), call: never('call'), watch: never('watch'),
    self: { handle: (name, fn) => { self.set(name, fn); return { dispose: () => disposed.push(name) }; } },
    views: { register: (id, provider) => { views.set(id, provider); return { dispose() {} }; } } };
  const open = () => {
    const page = { got: [], tell: null };
    views.get('friends').open({ postMessage: m => { page.got.push(m); return true; }, onMessage: fn => { page.tell = fn; }, onClose() {} });
    return page;
  };
  return { coda, dir, self, views, disposed, open };
}
const settled = () => new Promise(resolve => setTimeout(resolve, 30));

test('activate registers the notes handlers and the view without touching Accord', async t => {
  const h = await host(t);
  t.after(deactivate);
  await activate(h.coda);
  assert.deepEqual([...h.self.keys()].sort(), ['notes.delete', 'notes.list', 'notes.set']);
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

test('without a state directory notes fail plainly, and deactivate disposes what activate registered', async t => {
  const h = await host(t, null);
  await activate(h.coda);
  await assert.rejects(Promise.resolve().then(() => h.self.get('notes.list')({})), /状态目录/);
  deactivate();
  assert.deepEqual(h.disposed.sort(), ['notes.delete', 'notes.list', 'notes.set']);
  deactivate();
});
