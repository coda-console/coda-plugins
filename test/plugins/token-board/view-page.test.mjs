import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { createMachineBridge } from '../../../plugins/token-board/lib/view-machine.mjs';
import { deferred, flush, openPage } from '../view-dom.mjs';

const A = { id: 'a', name: 'A' }, B = { id: 'b', name: 'B' };

// 严格多机的 window.coda：不指明 machine 的 postMessage 直接拒绝；gate 放开前，所有发送都停在途中。
function strictCoda(gate = Promise.resolve()) {
  const log = { sent: [], watches: [] };
  const coda = {
    machine: A, machines: [A, B], getState: () => ({}), setState() {}, on() {}, toolbar: async () => {}, header: async () => {},
    async postMessage(msg, options) {
      if (!options?.machine) throw new Error('这一页有几台机器，postMessage 须指明 machine');
      log.sent.push([msg.type, options.machine]);
      await gate;
    },
    watch(kind, cb, selector, options) { log.watches.push({ cb, machine: options?.machine }); return Promise.resolve({ dispose() {} }); },
  };
  return { coda, log };
}

test('a share toggle queued behind a slow send is dropped when the page moves to B, and never reaches B', async t => {
  const gate = deferred();
  const { coda, log } = strictCoda(gate.promise);
  const page = await openPage(t, 'plugins/token-board/view/app.mjs', coda);
  await flush();
  page.reply({ type: 'status', share: false, range: '7d' }, { id: 'a' });
  page.button('开启分享').fire('click');
  page.button('B').fire('click');
  gate.resolve();
  await flush();
  assert.deepEqual(log.sent, [['hello', 'a'], ['hello', 'b'], ['board', 'b']], 'the in-flight hello finishes; A\'s queued board and set-share are dropped');
  assert.equal(page.button('B').attrs['aria-pressed'], 'true');
  assert.deepEqual(page.all(n => n.tag === 'button' && n.textContent === '开启分享').map(n => n.disabled), [false], 'the page is not left waiting for the dropped write');
});

test('switching A → B → A drops the first A\'s watch callback by generation', async t => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  const { coda, log } = strictCoda();
  const page = await openPage(t, 'plugins/token-board/view/app.mjs', coda);
  page.reply({ type: 'status', share: false, range: '7d' }, { id: 'a' });
  page.button('B').fire('click');
  await flush();
  page.button('A').fire('click');
  await flush();
  assert.deepEqual(log.watches.map(w => w.machine), ['a', 'b', 'a']);
  log.sent.length = 0;
  log.watches[0].cb({ type: 'MODIFIED' });
  mock.timers.tick(1000);
  await flush();
  assert.deepEqual(log.sent, [], 'the stale callback refreshes nothing');
  log.watches[2].cb({ type: 'MODIFIED' });
  mock.timers.tick(1000);
  await flush();
  assert.deepEqual(log.sent, [['hello', 'a'], ['board', 'a']]);
});

test('a send that fails on the current machine shows its error at once; one that fails after a switch does not', async t => {
  const gate = deferred();
  const { coda } = strictCoda();
  coda.postMessage = async (msg, options) => { await gate.promise; throw new Error(`no route to ${options.machine}`); };
  const page = await openPage(t, 'plugins/token-board/view/app.mjs', coda);
  await flush();
  page.reply({ type: 'status', share: false, range: '7d' }, { id: 'a' });
  page.button('B').fire('click');
  gate.resolve();
  await flush();
  assert.ok(page.text().includes('发送失败：no route to b'));
  assert.ok(!page.text().includes('no route to a'), 'the failure of the old machine\'s hello is not shown');
});

test('the bridge drops a queued write once the epoch moved on, even when the machine is the same again', async () => {
  const gate = deferred(), sent = [];
  let machine = 'a', epoch = 0;
  const coda = { async postMessage(msg, options) { sent.push([msg.type, options?.machine]); await gate.promise; } };
  const bridge = createMachineBridge({ coda, getMachine: () => machine, getEpoch: () => epoch, onMessage() {}, onError: e => { throw e; }, targetWindow: new EventTarget() });
  const first = bridge.send({ type: 'hello' });
  await flush();
  const queued = bridge.send({ type: 'set-share', on: true });
  machine = 'b'; epoch++;
  machine = 'a'; epoch++;
  const again = bridge.send({ type: 'sync' });
  gate.resolve();
  assert.deepEqual(await Promise.all([first, queued, again]), [true, false, true]);
  assert.deepEqual(sent, [['hello', 'a'], ['sync', 'a']]);
});
