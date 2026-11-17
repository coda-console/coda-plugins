import { device, declarations, record } from './lib/android.mjs';

const handlers = [];
export async function activate(coda) {
  const phone = device(coda.plugin.state);
  // Register before declaring: a declaration can retry an unfinished return.
  handlers.push(coda.resources.handle('lend', () => phone.lend()));
  handlers.push(coda.resources.handle('return', () => phone.return()));
  const settings = JSON.parse((await coda.environment()).CODA_PLUGIN_SETTINGS || '{}');
  await declare(coda, settings);
}

// The entity and the links of the phone, replaced as this plugin's whole; `source` is where they are read from.
// The entity first: a link names it by the ID the host gave it.
export async function declare(coda, settings, source = declarations) {
  const declared = await source(settings);
  const [entity] = await coda.replace('coda/entity@1', declared.entities.map(item => record(coda.plugin.id, item)));
  await coda.replace('coda/link@1', declared.links.map(item => record(coda.plugin.id, { ...item, entity: entity.id })));
}

export function deactivate() {
  for (const handler of handlers.splice(0)) handler.dispose();
}
