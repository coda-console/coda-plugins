// The 网络记录 plugin's module in Coda's plugin host (Coda's docs/plugins.md「插件宿主」). Loaded as the backend starts
// (`activationEvents: ["onStartupFinished"]`), it records with no page open. A page opened is given what the summary has
// as collections — `hangs`, `targets` and `status` — and each change as the recorder finds more.
import { join } from 'node:path';
import { Recorder } from './lib/recorder.mjs';
import { Log } from './lib/store.mjs';

let recorder = null;
const pages = new Set();

export function activate(coda) {
  recorder = new Recorder({ log: new Log(join(coda.plugin.state, 'log')), settings: () => settingsOf(coda), listen: change => { for (const page of pages) put(page, change); } });
  coda.views.register('log', {
    open(view) {
      const page = { hangs: view.collection('hangs'), targets: view.collection('targets'), status: view.collection('status') };
      pages.add(page);
      fill(page);
      view.onClose(() => pages.delete(page));
    },
  });
  const started = recorder;
  // What it read of the log before it records: given whole to the pages opened meanwhile.
  recorder.start().then(() => { if (recorder === started) for (const page of pages) fill(page); }, e => console.error('网络记录没有启动：', e?.message ?? e));
}

export function deactivate() {
  recorder?.stop();
  recorder = null;
  pages.clear();
}

function fill(page) {
  for (const hang of recorder.summary.hangList()) page.hangs.set(hang.id, hang);
  for (const target of recorder.summary.targets.values()) page.targets.set(target.target, target);
  page.status.set('recorder', recorder.status);
}
function put(page, { collection, id, object }) {
  if (object) page[collection].set(id, object); else page[collection].delete(id);
}

// The settings as they are now.
async function settingsOf(coda) {
  const settings = JSON.parse((await coda.environment()).CODA_PLUGIN_SETTINGS || '{}');
  return { targets: settings['network-log.targets'] ?? {}, hangSeconds: settings['network-log.hangSeconds'] ?? 3, mihomo: settings['network-log.mihomo'] ?? '' };
}
