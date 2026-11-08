// Coda 娘's rules (plugins/desktop-pet/view/rules.js) a frame at a time, as the page runs them: what she does follows from
// the frames, the user's input and what Coda says, the same every time.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SIZE, createPet, step, pose, pat, grab, carry, drop, curl, ground } from '../../../plugins/desktop-pet/view/rules.js';

const desk = { x: 0, y: 25, width: 1440, height: 800 };
const idle = { running: 0, waiting: [] };
const run = (pet, frames, world = idle) => { for (let i = 0; i < frames; i++) step(pet, world, desk); return pet; };

test('left alone she stands on the Dock, wanders within the desk, and falls asleep after three minutes', () => {
  const pet = createPet(desk), seen = new Set();
  for (let i = 0; i < 60 * 170; i++) {
    step(pet, idle, desk); seen.add(pet.state);
    assert.equal(pet.foot, ground(desk));
    assert.ok(pet.x >= desk.x + SIZE / 2 - 20 && pet.x <= desk.x + desk.width - SIZE / 2 + 20);
  }
  assert.ok(seen.has('walk') && seen.has('idle'), [...seen].join());
  run(pet, 60 * 20);
  assert.equal(pet.state, 'sleep');
  pat(pet, desk);
  assert.notEqual(pet.state, 'sleep');
  assert.equal(pose(pet, desk), 'happy');
});

test('agents at work set her typing; a session that waits makes her call, and both end when Coda says so', () => {
  const pet = run(createPet(desk), 60);
  assert.equal(run(pet, 2, { running: 2, waiting: [] }).state, 'work');
  assert.equal(run(pet, 2, { running: 2, waiting: [{ id: 't', title: 'x' }] }).state, 'call');
  // Calling, she hops now and then, and lands back on the Dock.
  let hopped = false;
  for (let i = 0; i < 200; i++) { step(pet, { running: 0, waiting: [{ id: 't', title: 'x' }] }, desk); hopped ||= pet.foot < ground(desk); }
  assert.ok(hopped);
  run(pet, 120, idle);
  assert.equal(pet.state, 'idle');
  assert.equal(pet.foot, ground(desk));
});

test('picked up she hangs from the pointer; let go she falls with its speed and lands squashed', () => {
  const pet = run(createPet(desk), 10), at = { x: pet.x + 5, y: pet.foot - 60 };
  const hold = grab(pet, at);
  carry(pet, hold, { x: 400, y: 300 }, desk);
  assert.deepEqual([pet.x, pet.foot, pose(pet, desk)], [395, 360, 'held']);
  run(pet, 30);
  assert.equal(pet.foot, 360, 'held, nothing moves her');
  drop(pet, { x: 6, y: -3 });
  assert.equal(pose(pet, desk), 'fall');
  run(pet, 5);
  assert.ok(pet.x > 395 && pet.foot < ground(desk));
  let frames = 0;
  while (pet.foot < ground(desk) && frames++ < 300) step(pet, idle, desk);
  assert.equal(pet.state, 'idle');
  assert.ok(pet.squash > 0.2, `landing squashes her: ${pet.squash}`);
  run(pet, 60);
  assert.ok(pet.squash < 0.01, 'and she comes back to shape');
});

test('curled into a ball she keeps to the nearer edge and stays still; out of it she drops beside that edge', () => {
  const pet = run(createPet(desk), 10);
  curl(pet, true, desk);
  assert.equal(pet.side, 1);
  const { x, foot } = run(pet, 600, { running: 1, waiting: [{ id: 't', title: 'x' }] });
  assert.deepEqual([pet.x, pet.foot], [x, foot]);
  curl(pet, false, desk);
  assert.equal(pet.x, desk.x + desk.width - SIZE);
  run(pet, 200);
  assert.equal(pet.foot, ground(desk));
});

test('the same frames and input give the same pet', () => {
  const a = run(createPet(desk, 7), 60 * 60), b = run(createPet(desk, 7), 60 * 60);
  assert.deepEqual(a, b);
});
