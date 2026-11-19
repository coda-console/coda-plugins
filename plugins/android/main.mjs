import { device, declaration } from './lib/android.mjs';

const GROUP = 'coda/group@1';
const handlers = [];
let changes, declaring = Promise.resolve();
export async function activate(coda, run) {
  const phone = device(coda.plugin.state, run);
  // Register before declaring: a declaration can retry an unfinished return.
  handlers.push(coda.handle(GROUP, 'lend', async () => { await phone.lend(); return {}; }));
  handlers.push(coda.handle(GROUP, 'return', async () => { await phone.return(); return {}; }));
  const source = settings => declaration(settings, run);
  // Declarations take turns, in the order the settings were told: one builds and publishes before the next starts, and one that fails does not stop the next.
  const turn = settings => {
    const done = declaring.then(() => declare(coda, settings, source));
    declaring = done.catch(() => {});
    return done;
  };
  changes = coda.settings.onChange(turn);
  await turn(await coda.settings.get());
}

// The group of the phone, replaced as this plugin's whole; `source` is where it is read from. No status: Coda keeps the lending.
export async function declare(coda, settings, source = declaration) {
  await coda.replace(GROUP, [{ key: 'device', spec: await source(settings) }]);
}

export function deactivate() {
  for (const handler of handlers.splice(0)) handler.dispose();
  changes?.dispose();
  changes = null;
}
