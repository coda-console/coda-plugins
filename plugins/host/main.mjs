import { runFinished } from './lib/simulator-status.mjs';

const GROUP = 'coda/group@1';
let handler, changes;
export async function activate(coda) {
  handler = await coda.self.handle('run-finished', async ({ run } = {}) => ({ finished: await runFinished(coda, run) }));
  changes = coda.settings.onChange(settings => declare(coda, settings));
  await declare(coda, await coda.settings.get());
}

// The slots of this machine's backend, replaced as this plugin's whole. No status: Coda keeps who holds them.
export async function declare(coda, settings) {
  await coda.replace(GROUP, [{ key: 'host', spec: { name: 'host', capacity: settings['host.capacity'], reach: { scope: 'machine' }, attributes: {}, unique: [] } }]);
}

export async function deactivate() { await handler?.dispose(); changes?.dispose(); handler = changes = null; }
