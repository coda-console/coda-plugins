// Coda 娘 on the desktop: a floating window of Coda's (docs/plugins.md「浮窗」) that she stands in, moved along the top of
// the Dock as she walks. What she does is view/rules.js's, a frame at a time (Coda's standard library loop.js); this page
// draws her, places the window and hands her the user's input. Clicks reach the page only over her, her bubble and her
// menu (`layout({ surfaces })`); elsewhere they go to the windows below. On an iPhone she floats over Coda's pages: a ball at
// the edge until tapped, and back into it once left alone a while, not to stand over what the user is doing.
import { frameLoop } from 'coda-view://lib/v1/loop.js';
import { listenGestures } from 'coda-view://lib/v1/gestures.js';
import { Bridge } from 'coda-view://lib/v1/bridge.js';
import { SIZE, createPet, step, pose, wake, touch, pat, grab, carry, drop, curl } from './rules.js';

const coda = window.coda, phone = coda.platform === 'ios';
const $ = id => document.getElementById(id);
const W = 200, H = 196, FOOT = 8, BALL = 64, EDGE = 4;   // the window, her box at its bottom (feet 8 points above it), the ball

// Frames of each pose (view/sprites/<name>.png, 256×256, facing right), each shown for PERIOD frames; until a frame's
// file is there the placeholder stands in.
const FRAMES = {
  idle: ['idle-1'], blink: ['idle-2'], walk: ['walk-1', 'walk-2', 'walk-3', 'walk-4'], work: ['work-1', 'work-2'], call: ['call-1', 'call-2'],
  sleep: ['sleep-1'], held: ['held-1', 'held-2'], fall: ['fall-1'], happy: ['happy-1', 'happy-2'], sit: ['sit-1'],
};
const PERIOD = { walk: 9, work: 10, call: 16, held: 12, happy: 14 };
const loaded = new Map();
for (const name of [...Object.values(FRAMES).flat(), 'ball']) {
  const img = new Image();
  img.onload = () => loaded.set(name, img.src);
  img.src = `sprites/${name}.png`;
}
const src = name => loaded.get(name) ?? 'sprites/placeholder.png';
const frame = (name, age) => { const f = FRAMES[name] ?? FRAMES.idle; return f[Math.floor(age / (PERIOD[name] ?? 1)) % f.length]; };

const bridge = new Bridge();
const world = { running: 0, waiting: [] };
let screens = [], pet = null, menu = false, placed = '', declared = '';

// The part above the Dock and below the menu bar of the screen she is on.
const desk = () => (screens.find(s => pet && pet.x >= s.visible.x && pet.x < s.visible.x + s.visible.width) ?? screens.find(s => s.main) ?? screens[0])?.visible
  ?? { x: 0, y: 0, width: 1440, height: 900 };
async function readScreens() { try { screens = await coda.screens(); } catch {} }

function draw() {
  const d = desk();
  $('pet').hidden = pet.ball; $('ball').style.display = pet.ball ? 'block' : 'none';
  let rect, surfaces;
  if (pet.ball) {
    pet.ballY = Math.max(d.y + 8, Math.min(d.y + d.height - BALL - 8, pet.ballY));
    rect = { x: pet.side > 0 ? d.x + d.width - BALL - EDGE : d.x + EDGE, y: pet.ballY, width: BALL, height: BALL };
    if ($('face').getAttribute('src') !== src('ball')) $('face').setAttribute('src', src('ball'));
    $('ball').querySelector('.ring').classList.toggle('spin', world.running > 0);
    const badge = $('ball').querySelector('.badge');
    badge.hidden = !world.waiting.length; badge.textContent = String(world.waiting.length);
    $('bubble').hidden = true; $('menu').hidden = true; menu = false;
    surfaces = [{ id: 'ball', x: 0, y: 0, width: BALL, height: BALL }];
  } else {
    const name = pose(pet, d), want = src(frame(name, pet.tick - pet.since));
    if ($('sprite').getAttribute('src') !== want) $('sprite').setAttribute('src', want);
    const sx = (1 + 0.14 * pet.squash) * (pet.dir < 0 ? -1 : 1), sy = 1 - 0.18 * pet.squash;
    $('pet').style.transform = `scale(${sx.toFixed(3)}, ${sy.toFixed(3)})`;
    $('zzz').style.opacity = name === 'sleep' ? String(0.5 + 0.5 * Math.sin(pet.tick / 30)) : '0';
    const asking = world.waiting.length > 0 && !pet.held && !menu;
    $('bubble').hidden = !asking;
    if (asking) {
      const text = `有 ${world.waiting.length} 件事等你`, title = world.waiting[0].title;
      if ($('bubble').dataset.text !== text + title) {
        $('bubble').dataset.text = text + title;
        $('bubble').replaceChildren(text, Object.assign(document.createElement('small'), { textContent: title }));
      }
    }
    $('menu').hidden = !menu;
    rect = { x: Math.round(pet.x - W / 2), y: Math.round(pet.foot + FOOT - H), width: W, height: H };
    // Her outline in the frames: about a fifth in from each side, a tenth down from the top to the feet.
    surfaces = [{ id: 'pet', x: (W - SIZE) / 2 + SIZE * 0.2, y: H - SIZE + SIZE * 0.08, width: SIZE * 0.6, height: SIZE * 0.87 }];
    for (const id of ['bubble', 'menu']) {
      if ($(id).hidden) continue;
      const r = $(id).getBoundingClientRect();
      surfaces.push({ id, x: Math.max(0, r.left), y: Math.max(0, r.top), width: Math.min(W, r.width), height: Math.min(H, r.height) });
    }
  }
  const where = JSON.stringify(rect);
  if (where !== placed) { placed = where; coda.place(rect).catch(() => {}); }
  const parts = JSON.stringify(surfaces);
  if (parts !== declared) { declared = parts; coda.layout({ surfaces }).catch(() => {}); }
}

// MARK: the user's hands

// Where the pointer is on the screens: WebKit's own screen coordinates, or else the window's place and the page's point.
const screenPoint = p => {
  const at = placed ? JSON.parse(placed) : { x: 0, y: 0 }, own = { x: at.x + p.x, y: at.y + p.y };
  return Math.abs(p.screenX - own.x) + Math.abs(p.screenY - own.y) < 80 ? { x: p.screenX, y: p.screenY } : own;
};
const openWaiting = () => { const first = world.waiting[0]; if (first) coda.open(`coda://threads/${first.id}`).catch(e => console.warn(e.message)); };
let lastTap = 0, hold = null, trail = [];

listenGestures({
  tap() {
    if (menu) { menu = false; return; }
    const now = performance.now(), double = now - lastTap < 320;
    lastTap = double ? 0 : now;
    if (pet.ball) {
      if (double) return curl(pet, false, desk());
      // A single tap waits to be no double one: then it goes to what waits, or out of the ball.
      return setTimeout(() => { if (lastTap === now) { if (world.waiting.length) openWaiting(); else curl(pet, false, desk()); } }, 330);
    }
    if (double) { menu = false; return curl(pet, true, desk()); }
    pat(pet, desk());
  },
  // The menu: a right click or two fingers, or (with no right click on a phone) a long press.
  two() { if (!pet.ball) { menu = !menu; touch(pet); } },
  long() { if (!pet.ball) { menu = !menu; touch(pet); } },
  drag: {
    start(p) {
      const s = screenPoint(p);
      menu = false;
      hold = pet.ball ? { dy: s.y - pet.ballY } : grab(pet, s);
      trail = [[s.x, s.y, performance.now()]];
    },
    move(p) {
      const s = screenPoint(p), d = desk();
      if (pet.ball) { pet.ballY = s.y - hold.dy; pet.side = s.x > d.x + d.width / 2 ? 1 : -1; return; }
      carry(pet, hold, s, d);
      trail.push([s.x, s.y, performance.now()]); if (trail.length > 6) trail.shift();
    },
    end() {
      if (pet.ball || !pet.held) return;
      const a = trail[0], b = trail[trail.length - 1], frames = Math.max(1, (b[2] - a[2]) / (1000 / 60));
      drop(pet, { x: (b[0] - a[0]) / frames, y: (b[1] - a[1]) / frames });
    },
  },
});
$('bubble').addEventListener('click', openWaiting);
$('to-ball').addEventListener('click', () => { menu = false; curl(pet, true, desk()); });
$('put-away').addEventListener('click', () => coda.close());

// MARK: start

bridge.on('coda', d => { world.running = d.running ?? 0; world.waiting = d.waiting ?? []; if (pet) wake(pet); });
bridge.on('close', () => coda.close());
await readScreens();
setInterval(readScreens, 3000);
pet = createPet(desk(), undefined, { tucks: phone });
if (phone) curl(pet, true, desk());
bridge.send({ type: 'hello' });
frameLoop(() => { step(pet, world, desk()); draw(); });
