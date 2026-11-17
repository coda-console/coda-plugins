import { entityId, device, declarations, record } from './lib/android.mjs';

const handlers = [];
export async function activate(coda) {
  const id = entityId(coda.plugin.state);
  const phone = device(coda.plugin.state);
  // Register before declaring: a declaration can retry an unfinished return.
  handlers.push(coda.resources.handle('lend', () => phone.lend()));
  handlers.push(coda.resources.handle('return', () => phone.return()));
  const settings = JSON.parse((await coda.environment()).CODA_PLUGIN_SETTINGS || '{}');
  const declared = await declarations(id, settings);
  await coda.replace('coda/entity@1', declared.entities.map(item => record(coda.plugin.id, item)));
  await coda.replace('coda/link@1', declared.links.map(item => record(coda.plugin.id, item)));
}

export function deactivate() {
  for (const handler of handlers.splice(0)) handler.dispose();
}
