// The desktop pet's module as Coda's plugin host loads it (Coda's docs/plugins.md「插件宿主」): from the sessions it watches
// (`threads`) it tells each open pet how many agents are at work and which sessions wait for the user; the home page hears
// whether she is on the desktop, and putting her away tells the pets to close.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { activate, deactivate } from '../../../plugins/desktop-pet/main.mjs';

function host() {
  const views = new Map();
  let changes = null;
  const coda = {
    views: { register: (id, provider) => views.set(id, provider) },
    watch: async (name, fn) => {
      assert.equal(name, 'threads');
      changes = fn;
      fn({ type: 'ADDED', id: 'a', object: { id: 'a', turn: 't1', needsAction: false, title: 'A' } });
      fn({ type: 'ADDED', id: 'b', object: { id: 'b', turn: null, needsAction: true, title: 'B' } });
      return { dispose() {} };
    },
  };
  const open = id => {
    const page = { got: [], closed: [], tell: null };
    views.get(id).open({ postMessage: m => page.got.push(m), onMessage: fn => { page.tell = fn; }, onClose: fn => page.closed.push(fn) });
    return page;
  };
  return { coda, open, change: (...c) => changes(...c) };
}

test('a pet hears agents at work and sessions that wait, as they change', async t => {
  const { coda, open, change } = host();
  t.after(deactivate);
  await activate(coda);
  const pet = open('pet');
  pet.tell({ type: 'hello' });
  assert.deepEqual(pet.got.at(-1), { type: 'coda', running: 1, waiting: [{ id: 'b', title: 'B' }] });
  change({ type: 'MODIFIED', id: 'b', object: { id: 'b', turn: 't2', needsAction: false, title: 'B' } });
  change({ type: 'ADDED', id: 'c', object: { id: 'c', turn: null, needsAction: true, title: '' } });
  await sleep(250);
  assert.deepEqual(pet.got.at(-1), { type: 'coda', running: 2, waiting: [{ id: 'c', title: '一个会话' }] });
  change({ type: 'DELETED', id: 'c', object: null });
  await sleep(250);
  assert.deepEqual(pet.got.at(-1).waiting, []);
  const told = pet.got.length;
  change({ type: 'MODIFIED', id: 'a', object: { id: 'a', turn: 't1', needsAction: false, title: 'A again' } });
  await sleep(250);
  assert.equal(pet.got.length, told, 'nothing the pet shows changed: nothing told');
});

test('the home page knows whether she is on the desktop, and putting her away closes the pets', async t => {
  const { coda, open } = host();
  t.after(deactivate);
  await activate(coda);
  const home = open('home');
  home.tell({ type: 'hello' });
  assert.equal(home.got.at(-1).onDesk, false);
  const pet = open('pet');
  assert.equal(home.got.at(-1).onDesk, true);
  home.tell({ type: 'put-away' });
  assert.deepEqual(pet.got.at(-1), { type: 'close' });
  pet.closed.forEach(fn => fn());
  assert.equal(home.got.at(-1).onDesk, false);
});
