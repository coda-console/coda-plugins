import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMachineBridge, pickMachine, reachableMachines } from '../../../plugins/friends/lib/view-machine.mjs';

const A = { id: 'a', name: 'A' }, B = { id: 'b', name: 'B' }, C = { id: 'c', name: 'C', unreachable: true };

test('reachableMachines keeps reachable, de-duplicated machines with an id', () => {
  assert.deepEqual(reachableMachines({ machines: [A, C, B, { ...A }, { name: 'x' }, { id: '' }, null] }).map(m => m.id), ['a', 'b']);
  assert.deepEqual(reachableMachines({ machine: A }).map(m => m.id), ['a'], 'falls back to coda.machine');
  assert.deepEqual(reachableMachines({}), []);
});

test('pickMachine prefers the saved choice, then this machine, then the first reachable one', () => {
  const coda = { machine: B, machines: [A, B, C] };
  assert.equal(pickMachine(coda, 'a'), 'a', 'saved choice restored');
  assert.equal(pickMachine(coda, 'c'), 'b', 'an unreachable saved choice is skipped');
  assert.equal(pickMachine(coda, 'gone'), 'b');
  assert.equal(pickMachine(coda, undefined), 'b');
  assert.equal(pickMachine({ machine: C, machines: [C, A, B] }, undefined), 'a', 'unreachable own machine falls back to the first reachable');
  assert.equal(pickMachine({ machine: A }, undefined), 'a', 'single machine');
  assert.equal(pickMachine({ machine: C }, undefined), 'c', 'nothing reachable: still this machine');
  assert.equal(pickMachine({}, undefined), null);
});

// 严格多机页面：不指明 machine 的 postMessage 直接拒绝，指明了才送达。
function strictPage(machines) {
  const win = new EventTarget(), delivered = [];
  const coda = {
    machine: machines[0], machines,
    async postMessage(msg, options) {
      if (machines.length > 1 && !options?.machine) throw new Error('这一页有几台机器，postMessage 须指明 machine');
      delivered.push({ msg, machine: options?.machine });
    },
  };
  const reply = (data, machine) => win.dispatchEvent(Object.assign(new Event('message'), { data, machine }));
  return { win, coda, delivered, reply };
}

test('the bridge always sends to the chosen machine, drops other machines\' replies, and follows a switch', async () => {
  const page = strictPage([A, B]);
  let machine = 'a';
  const got = [], failed = [];
  const bridge = createMachineBridge({ coda: page.coda, getMachine: () => machine, onMessage: d => got.push(d), onError: (e, msg, m) => failed.push({ e, msg, m }), targetWindow: page.win });
  await bridge.send({ type: 'hello' });
  assert.deepEqual(page.delivered, [{ msg: { type: 'hello' }, machine: 'a' }]);
  assert.deepEqual(failed, []);

  page.reply({ type: 'status', n: 1 }, { id: 'a' });
  page.reply({ type: 'status', n: 2 }, { id: 'b' });
  page.reply({ type: 'status', n: 3 });
  page.reply('nope', { id: 'a' });
  page.reply({ n: 4 }, { id: 'a' });
  assert.deepEqual(got.map(d => d.n), [1, 3]);

  machine = 'b';
  await bridge.send({ type: 'board' });
  assert.equal(page.delivered.at(-1).machine, 'b');
  page.reply({ type: 'board', n: 5 }, { id: 'a' });
  page.reply({ type: 'board', n: 6 }, { id: 'b' });
  assert.deepEqual(got.map(d => d.n), [1, 3, 6], 'a late reply from the old machine is ignored');

  bridge.dispose();
  page.reply({ type: 'board', n: 7 }, { id: 'b' });
  assert.equal(got.length, 3);
});

test('a rejected send reaches onError with the target machine instead of being swallowed', async () => {
  const page = strictPage([A, B]);
  const failed = [];
  const bridge = createMachineBridge({ coda: page.coda, getMachine: () => null, onMessage() {}, onError: (e, msg, m) => failed.push({ message: e.message, msg, m }), targetWindow: page.win });
  await bridge.send({ type: 'hello', rid: 'n1' });
  assert.deepEqual(failed, [{ message: '这一页有几台机器，postMessage 须指明 machine', msg: { type: 'hello', rid: 'n1' }, m: null }]);
  await bridge.send({ type: 'again' });
  assert.equal(failed.length, 2, 'later sends still go through the queue');
  bridge.dispose();
});

test('a single machine page sends without an option', async () => {
  const page = strictPage([A]);
  const bridge = createMachineBridge({ coda: page.coda, getMachine: () => null, onMessage() {}, onError: e => { throw e; }, targetWindow: page.win });
  await bridge.send({ type: 'hello' });
  assert.deepEqual(page.delivered, [{ msg: { type: 'hello' }, machine: undefined }]);
  bridge.dispose();
});
