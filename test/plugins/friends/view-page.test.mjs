import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMachineBridge } from '../../../plugins/friends/lib/view-machine.mjs';
import { deferred, flush, openPage } from '../view-dom.mjs';

const A = { id: 'a', name: 'A' }, B = { id: 'b', name: 'B' };
const AUTHOR = `ed25519:${'ab'.repeat(32)}`;
const entry = { type: 'MODIFIED', entry: { spec: { author: AUTHOR }, status: { friends: [] } } };

// 严格多机的 window.coda：不指明 machine 的 postMessage 直接拒绝；记下每次发往哪台。
function strictCoda(page, { notes = { ok: true, value: {} }, silent, watch, call } = {}) {
  const log = { sent: [], calls: [], queries: [], watches: [] };
  const coda = {
    machine: A, machines: [A, B], getState: () => ({}), setState() {}, on() {}, copy: async () => {},
    toolbar: async () => {}, header: async () => {},
    async postMessage(msg, options) {
      if (!options?.machine) throw new Error('这一页有几台机器，postMessage 须指明 machine');
      log.sent.push({ msg, machine: options.machine });
      if (msg.type === 'notes.list' && options.machine !== silent) setImmediate(() => page.reply({ type: 'reply', rid: msg.rid, ...notes }, { id: options.machine }));
    },
    watch(kind, cb, selector, options) { log.watches.push({ cb, machine: options?.machine }); return watch ? watch() : Promise.resolve({ dispose() {} }); },
    async query(target, op, params, options) { log.queries.push({ params, machine: options?.machine }); return { records: [] }; },
    async call(target, op, input, options) { log.calls.push({ input, machine: options?.machine }); return call ? call(input, options) : {}; },
  };
  return { coda, log };
}
// 页面要在 coda 之前建好 reply，所以先占位再接上。
async function open(t, options) {
  const holder = {};
  const { coda, log } = strictCoda({ reply: (...args) => holder.page.reply(...args) }, options);
  holder.page = await openPage(t, 'plugins/friends/view/app.mjs', coda);
  await flush();
  return { page: holder.page, log };
}

test('a publish that began on A keeps going to A after the page switched to B, and writes nothing into B\'s page', async t => {
  const gate = deferred();
  const { page, log } = await open(t, { call: input => (input.kind === 'profile' ? gate.promise : {}) });
  page.all(n => n.tag === 'input' && n.attrs.placeholder?.startsWith('昵称'))[0].fire('input', { target: { value: '小明' } });
  page.button('发布名片').fire('click');
  await flush();
  page.button('B').fire('click');
  await flush();
  gate.reject(Object.assign(new Error('forbidden'), { code: 'forbidden' }));
  await flush();
  assert.deepEqual(log.calls.map(c => [c.input.kind, c.machine]), [['profile', 'a'], ['friends/card', 'a']], 'the fallback still goes to A');
  assert.deepEqual(log.calls.filter(c => c.machine === 'b'), [], 'nothing was published on B');
  assert.deepEqual(log.queries.filter(q => q.params.kind === 'profile' && q.params.author !== undefined), [], 'no follow-up lookup after the switch');
  assert.deepEqual(log.queries.filter(q => q.machine === 'a'), [], 'no refresh for the old machine either');
  assert.deepEqual(page.all(n => ['progress', 'ok', 'error'].includes(n.className)), [], 'no progress or result message is left on B\'s page');
  assert.equal(page.all(n => n.tag === 'button' && n.textContent === '发布名片')[0].disabled, false);
});

test('an invite accepted on A finishes its handshake on A, whatever page is showing', async t => {
  const gate = deferred();
  const { page, log } = await open(t, { call: input => (input.control ? gate.promise : {}) });
  page.all(n => n.tag === 'input' && n.attrs.placeholder === 'https://…')[0].value = 'https://control.example';
  page.all(n => n.tag === 'input' && n.attrs.type === 'password')[0].value = 'key';
  page.button('接受邀请').fire('click');
  await flush();
  page.button('B').fire('click');
  await flush();
  gate.resolve({ node: 'n1' });
  await flush();
  assert.deepEqual(log.calls.map(c => c.machine), ['a', 'a']);
  assert.deepEqual(page.all(n => ['progress', 'ok', 'error'].includes(n.className)), []);
});

test('switching A → B → A drops the first A\'s watch callback by generation', async t => {
  const { page, log } = await open(t);
  page.button('B').fire('click');
  await flush();
  page.button('A').fire('click');
  await flush();
  assert.deepEqual(log.watches.map(w => w.machine), ['a', 'b', 'a']);
  const before = log.queries.length;
  log.watches[0].cb(entry);
  await flush();
  assert.equal(log.queries.length, before, 'the stale callback reads nothing');
  assert.ok(!page.text().includes('ed25519:'), 'and shows nothing');
  log.watches[2].cb(entry);
  await flush();
  assert.ok(page.text().includes('ed25519:abababab'));
  assert.equal(log.queries.length, before + 2);
});

test('a notes.list that fails is shown at once, and a later successful profile read does not clear it', async t => {
  const gate = deferred();
  const { page, log } = await open(t, { notes: { ok: false, error: 'boom' }, watch: () => gate.promise });
  assert.ok(page.text().includes('读不到本地备注：boom'), 'visible before the watch has answered');
  gate.resolve({ dispose() {} });
  await flush();
  log.watches[0].cb(entry);
  await flush();
  assert.ok(page.text().includes('ed25519:abababab'), 'the profile read went through');
  assert.ok(page.text().includes('读不到本地备注：boom'));
});

test('a notes.list still waiting when the page switches does not turn into an error on the new machine', async t => {
  const { page, log } = await open(t, { silent: 'a' });
  page.button('B').fire('click');
  await flush();
  assert.deepEqual(log.sent.map(s => [s.msg.type, s.machine]), [['notes.list', 'a'], ['notes.list', 'b']]);
  assert.ok(!page.text().includes('读不到本地备注'), 'the old request was cancelled quietly');
  assert.equal(log.watches.length, 1, 'only the new machine is watched');
  assert.equal(log.watches[0].machine, 'b');
});

test('the bridge drops a queued write once the page has moved to another machine, even back to the same one', async () => {
  const gate = deferred(), sent = [];
  let machine = 'a', epoch = 0;
  const coda = { async postMessage(msg, options) { sent.push([msg.type, options?.machine]); await gate.promise; } };
  const bridge = createMachineBridge({ coda, getMachine: () => machine, getEpoch: () => epoch, onMessage() {}, onError: e => { throw e; }, targetWindow: new EventTarget() });
  const first = bridge.send({ type: 'notes.list' });
  await flush();
  const queued = bridge.send({ type: 'notes.set' });
  machine = 'b'; epoch++;
  const forB = bridge.send({ type: 'notes.list' });
  machine = 'a'; epoch++;
  const again = bridge.send({ type: 'notes.delete' });
  gate.resolve();
  assert.deepEqual(await Promise.all([first, queued, forB, again]), [true, false, false, true]);
  assert.deepEqual(sent, [['notes.list', 'a'], ['notes.delete', 'a']]);
});
