// The desktop pet's module in Coda's plugin host (Coda's docs/plugins.md「插件宿主」). It watches this machine's sessions
// (`threads`: the turn each has under way, whether it needs the user) and tells every open pet how many agents are at work
// and which sessions wait for the user (at most 20). The home page puts the pet on the desktop itself (a floating window, Coda's
// docs/plugins.md「浮窗」) and asks the module to put it away, which tells the pets to close.

const rows = new Map();
const pets = new Set(), homes = new Set();
let state = { running: 0, waiting: [] }, watching = null, timer = null;

export function activate(coda) {
  coda.views.register('pet', {
    open(view) {
      pets.add(view);
      view.onMessage(message => { if (message?.type === 'hello') view.postMessage({ type: 'coda', ...state }); });
      view.onClose(() => { pets.delete(view); tellHomes(); });
      tellHomes();
    },
  });
  coda.views.register('home', {
    open(view) {
      homes.add(view);
      view.onMessage(message => {
        if (message?.type === 'hello') view.postMessage(status());
        else if (message?.type === 'put-away') for (const pet of pets) pet.postMessage({ type: 'close' });
      });
      view.onClose(() => homes.delete(view));
    },
  });
  watching = coda.watch('threads', ({ type, id, object }) => {
    if (type === 'DELETED') rows.delete(id); else rows.set(id, object);
    clearTimeout(timer);
    timer = setTimeout(update, 150);
  });
  return watching.then(update);
}

export async function deactivate() {
  clearTimeout(timer);
  (await watching?.catch(() => null))?.dispose();
  rows.clear(); pets.clear(); homes.clear();
}

// What the pets show: agents at work (sessions with a turn under way) and the sessions that need the user.
function update() {
  let running = 0;
  const waiting = [];
  for (const row of rows.values()) {
    if (row.turn) running += 1;
    if (row.needsAction) waiting.push({ id: row.id, title: row.title || '一个会话' });
  }
  const next = { running, waiting: waiting.slice(0, 20) };
  if (JSON.stringify(next) === JSON.stringify(state)) return;
  state = next;
  for (const pet of pets) pet.postMessage({ type: 'coda', ...state });
  tellHomes();
}

function status() { return { type: 'status', onDesk: pets.size > 0, ...state }; }
function tellHomes() { for (const home of homes) home.postMessage(status()); }
