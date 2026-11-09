// What Coda 娘 does, frame by frame (60 a second), from nothing but the frame, what the user did and what Coda says (agents
// at work, sessions that wait for the user): no clock, no page. view/pet.js draws her and hands her the user's input.
// The desk is the part of her screen above the Dock: `{ x, y, width, height }` in the screens' points, y downward.

export const SIZE = 128, GRAVITY = 0.6, WALK = 0.7;
const SLEEPY = 60 * 180;                         // three minutes without anything happening
export const TUCK = 60 * 20;                     // twenty seconds without the user's hands, where she `tucks`

/** `tucks`: back into the ball once the user has left her alone a while, where she would stand over what the user uses (an
 *  iPhone's pages, not a Mac's Dock). */
export function createPet(desk, seed = 0x9e3779b9, { tucks = false } = {}) {
  return { x: desk.x + desk.width - SIZE - 40, foot: desk.y + desk.height, vx: 0, vy: 0, dir: -1, state: 'idle', since: 0, squash: 0,
           happy: 0, held: false, wake: 0, touched: 0, tucks, ball: false, side: 1, ballY: 0, tick: 0, rng: seed >>> 0 };
}

const rand = pet => ((pet.rng = (Math.imul(pet.rng, 1103515245) + 12345) >>> 0) / 4294967296);
const set = (pet, state) => { if (pet.state !== state) { pet.state = state; pet.since = pet.tick; } };
export const ground = desk => desk.y + desk.height;

/** One frame: `world` is `{ running, waiting }` (agents at work, sessions that wait for the user). */
export function step(pet, world, desk) {
  pet.tick += 1;
  if (pet.ball || pet.held) return pet;
  const left = desk.x + SIZE / 2 - 20, right = desk.x + desk.width - SIZE / 2 + 20, floor = ground(desk);
  if (pet.foot < floor - 0.5 || pet.vy < 0) {
    pet.vy += GRAVITY; pet.foot += pet.vy; pet.x = Math.max(left, Math.min(right, pet.x + pet.vx)); pet.vx *= 0.99;
    if (pet.foot < floor) return pet;
    pet.squash = Math.min(1, Math.abs(pet.vy) / 14);
  }
  // On the Dock: just landed, or let go where she stood.
  pet.foot = floor; pet.vx = 0; pet.vy = 0;
  if (pet.state === 'fall') set(pet, 'idle');
  if (pet.tucks && pet.tick - pet.touched > TUCK) { curl(pet, true, desk); return pet; }
  pet.squash *= 0.85;
  if (pet.happy > 0) pet.happy -= 1;
  const age = pet.tick - pet.since;
  if (world.waiting.length) set(pet, 'call');
  else if (world.running) set(pet, 'work');
  else if (pet.state === 'call' || pet.state === 'work') { set(pet, 'idle'); pet.wake = pet.tick; }
  switch (pet.state) {
    case 'idle':
      if (age > 180 + (pet.tick % 7) * 30) {
        const r = rand(pet);
        if (r < 0.55) { pet.dir = rand(pet) < 0.5 ? -1 : 1; set(pet, 'walk'); } else if (r < 0.75) set(pet, 'sit'); else pet.since = pet.tick;
      }
      if (pet.tick - pet.wake > SLEEPY) set(pet, 'sleep');
      break;
    case 'walk':
      pet.x += pet.dir * WALK;
      if (pet.x <= left || pet.x >= right) { pet.dir = -pet.dir; pet.x = Math.max(left, Math.min(right, pet.x)); }
      if (age > 240 + (pet.tick % 5) * 50) set(pet, 'idle');
      break;
    case 'sit':
      if (age > 420) set(pet, 'idle');
      if (pet.tick - pet.wake > SLEEPY) set(pet, 'sleep');
      break;
    case 'call': if (age % 90 === 89) pet.vy = -4.5; break;
  }
  return pet;
}

/** What she looks like now: the pose whose frames are drawn. */
export function pose(pet, desk) {
  if (pet.held) return 'held';
  if (pet.foot < ground(desk) - 1) return 'fall';
  if (pet.happy > 0) return 'happy';
  if (pet.state === 'idle' && pet.tick % 240 < 8) return 'blink';
  return pet.state;
}

// MARK: the user's hands

export function wake(pet) { pet.wake = pet.tick; if (pet.state === 'sleep') set(pet, 'idle'); }
/** The user's hands on her (as with each below): awake, and not left alone. */
export function touch(pet) { wake(pet); pet.touched = pet.tick; }
/** A tap on her: happy, with a hop when she stands. */
export function pat(pet, desk) { touch(pet); pet.happy = 70; if (pet.foot >= ground(desk) - 1) pet.vy = -5; }
/** Picked up at a point of the screens: she hangs from it. */
export function grab(pet, point) { pet.held = true; pet.since = pet.tick; touch(pet); return { dx: point.x - pet.x, dy: point.y - pet.foot }; }
export function carry(pet, hold, point, desk) { pet.x = point.x - hold.dx; pet.foot = Math.min(ground(desk), point.y - hold.dy); }
/** Let go, moving as the pointer last moved (`velocity` in points a frame): she falls from there. */
export function drop(pet, velocity) {
  pet.held = false;
  pet.vx = Math.max(-14, Math.min(14, velocity.x)); pet.vy = Math.max(-16, Math.min(6, velocity.y));
  set(pet, 'fall'); touch(pet);
}
/** Into the ball at the nearer edge of the desk, or out of it beside that edge. */
export function curl(pet, on, desk, ball = 64) {
  pet.ball = on;
  if (on) { pet.side = pet.x > desk.x + desk.width / 2 ? 1 : -1; pet.ballY = pet.foot - ball - 60; }
  else { pet.x = pet.side > 0 ? desk.x + desk.width - SIZE : desk.x + SIZE; pet.foot = pet.ballY + ball; pet.vy = -2; set(pet, 'fall'); }
  touch(pet);
}
